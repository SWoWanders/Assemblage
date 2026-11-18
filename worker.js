// Assemblage — companion Cloudflare Worker
// Endpoints:
//   POST /plan    {prompt}                             -> {plan}             (Workers AI text model)
//   POST /render  {prompt, guide?, image?, seed, w, h} -> image/jpeg         (FLUX.2 klein: text, layout-guided, or edit)
//   POST /vision  {image: dataURL, questions: []}       -> {answers: [bool]}  (Workers AI vision model)
//   GET  /status                                        -> {ok, used, cap}
//
// Bindings (wrangler.toml / dashboard):
//   AI      — Workers AI binding (required)
//   LIMITS  — KV namespace (optional, enables the daily spend cap)
// Vars:
//   DAILY_CAP        — max AI calls per day across all visitors (default 300)
//   ALLOWED_ORIGINS  — comma list, e.g. "https://swowanders.github.io" (default "*")

const MODELS = {
  // Tried in order; if one is retired or errors, the next is used.
  plan: [
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/zai-org/glm-4.7-flash',
    '@cf/meta/llama-3.1-8b-instruct-fast',
  ],
  // Strictest first: the checker must not pass a chart as a bicycle.
  vision: [
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/meta/llama-3.2-11b-vision-instruct',
  ],
  // FLUX.2 [klein]: fast distilled generator; multipart input, input images must be < 512x512
  render: ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b'],
};

const PLAN_SYSTEM = `You turn an image prompt into a JSON scene plan for a photo-collage engine.
The engine can only paste REAL photographs of real things, then recolour them, change their material, and arrange them.
So for imaginary things, break them into a real searchable object plus a material/colour.
Examples: "glass whale" -> name "whale", search "whale", material "glass". "robot cat" -> search "cat", material "metal".
Return ONLY JSON, no prose, in exactly this shape:
{"setting":{"query":"short photo search phrase for the background place, or empty","kind":"outdoor|indoor|space|underwater","time":"day|sunrise|sunset|night|overcast","weather":"clear|fog|rain|snow|haze","tags":["2-5 single words describing the place for an HDRI library, e.g. forest, urban, beach, indoor, skies"]},
 "objects":[{"name":"umbrella","search":"umbrella","count":2,"color":"red or null","material":"glass|gold|silver|metal|wood|stone|marble|ice|neon|paper|bronze|null","state":"ground|flying|sky","size_m":1.0}],
 "relations":[{"a":0,"b":1,"type":"left_of|right_of|behind|in_front_of|on|under|above|next_to"}],
 "main":0}
Rules: max 6 objects. "search" must be one or two plain English nouns a stock photo site would have. size_m is the real-world height in metres of ONE such object at the size the prompt implies (a giant cat is still searched as "cat" but size_m 6). state "sky" is for sun, moon, planets, clouds; "flying" for anything airborne or floating. Relations use object indexes. Use null, never invent colours the prompt did not ask for.`;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    try {
      if (url.pathname === '/status') {
        const used = await getUsed(env);
        return json({ ok: true, used, cap: cap(env), ai: !!env.AI });
      }
      if (!env.AI) return json({ error: 'Workers AI binding "AI" is missing on this Worker.' }, 500);
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

      // Daily spend cap (only if KV bound)
      if (!(await takeQuota(env))) return json({ error: 'Daily AI allowance used up — the app will fall back to its offline modes.', capped: true }, 429);

      const body = await request.json();
      if (url.pathname === '/plan') return json(await plan(env, String(body.prompt || '').slice(0, 600)));
      if (url.pathname === '/vision') return json(await vision(env, body.image, (body.questions || []).slice(0, 16)));
      if (url.pathname === '/render') {
        const out = await render(env, body);
        return new Response(out.bytes, { headers: { ...cors, 'Content-Type': out.type, 'X-Model': out.model } });
      }
      return json({ error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

function cap(env) { return parseInt(env.DAILY_CAP || '300', 10); }
function dayKey() { return 'calls-' + new Date().toISOString().slice(0, 10); }
async function getUsed(env) { if (!env.LIMITS) return null; return parseInt((await env.LIMITS.get(dayKey())) || '0', 10); }
async function takeQuota(env) {
  if (!env.LIMITS) return true;
  const used = await getUsed(env);
  if (used >= cap(env)) return false;
  await env.LIMITS.put(dayKey(), String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

function textOf(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  if (r.choices && r.choices[0]) return r.choices[0].message?.content || r.choices[0].text || '';
  return JSON.stringify(r);
}
function extractJSON(s) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model reply');
  return JSON.parse(s.slice(a, b + 1));
}

async function plan(env, prompt) {
  let lastErr;
  for (const model of MODELS.plan) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: prompt }],
        max_tokens: 900, temperature: 0.2,
      });
      return { plan: extractJSON(textOf(r)), model };
    } catch (e) { lastErr = e; }
  }
  throw new Error('All planner models failed: ' + (lastErr && lastErr.message));
}

async function vision(env, image, questions) {
  if (!image || !questions.length) throw new Error('image and questions required');
  const q = questions.map((x, i) => `${i + 1}. ${x}`).join('\n');
  const text = `Look carefully at this photo and answer each question with yes or no. Be strict.\n${q}\nReply ONLY as JSON: {"answers":["yes","no",...]} with exactly ${questions.length} entries.`;
  const r = await visionAsk(env, image, text, 200);
  return { answers: parseAnswers(r.text, questions.length), model: r.model };
}
function parseAnswers(s, n) {
  try {
    const j = extractJSON(s);
    if (Array.isArray(j.answers)) return j.answers.slice(0, n).map(v => v === true || /^y/i.test(String(v)));
  } catch {}
  const toks = (s.toLowerCase().match(/\b(yes|no)\b/g) || []).slice(0, n);
  return toks.map(t => t === 'yes');
}

function dataURLtoBytes(d) {
  const b64 = String(d).split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function visionAsk(env, image, text, maxTokens) {
  let lastErr;
  for (const model of MODELS.vision) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] }],
        max_tokens: maxTokens, temperature: 0,
      });
      return { text: textOf(r), model };
    } catch (e) {
      lastErr = e;
      if (/agree/i.test(String(e.message)) && model.includes('3.2')) { try { await env.AI.run(model, { prompt: 'agree' }); } catch {} }
    }
  }
  throw new Error('All vision models failed: ' + (lastErr && lastErr.message));
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function render(env, body) {
  const prompt = String(body.prompt || '').slice(0, 1800);
  if (!prompt) throw new Error('prompt required');
  const w = Math.min(1280, Math.max(256, (parseInt(body.w, 10) || 1024) & ~15));
  const h = Math.min(1280, Math.max(256, (parseInt(body.h, 10) || 688) & ~15));
  const img = body.image || body.guide; // edit source or layout guide (< 512x512 JPEG data URL)
  let lastErr;
  for (const model of MODELS.render) {
    for (const withSeed of [true, false]) {
      try {
        const form = new FormData();
        form.append('prompt', prompt);
        form.append('width', String(w));
        form.append('height', String(h));
        if (withSeed && body.seed != null) form.append('seed', String(parseInt(body.seed, 10) >>> 0));
        if (img) form.append('input_image_0', new Blob([dataURLtoBytes(img)], { type: 'image/jpeg' }), 'input.jpg');
        const fr = new Response(form);
        const r = await env.AI.run(model, { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } });
        const b64 = r && (r.image || (r.result && r.result.image));
        if (!b64) throw new Error('no image in reply');
        return { bytes: b64ToBytes(String(b64).replace(/^data:[^,]+,/, '')), type: 'image/jpeg', model };
      } catch (e) { lastErr = e; if (!/seed/i.test(String(e.message))) break; }
    }
  }
  throw new Error('Render failed: ' + (lastErr && lastErr.message));
}

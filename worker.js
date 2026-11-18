// Assemblage — companion Cloudflare Worker
// Endpoints:
//   POST /plan    {prompt}                             -> {plan}             (Workers AI text model)
//   POST /render  {prompt, guide?, image?, seed, w, h} -> image/jpeg         (FLUX.2 klein: text, layout-guided, or edit)
//   POST /vision  {image: dataURL, questions: []}       -> {answers: [bool]}  (Workers AI vision model)
//   GET  /status                                        -> {ok, used, cap}
//
// Bindings (wrangler.toml / dashboard):
//   AI      — Workers AI binding (required)
//   LIMITS  — KV namespace (strongly recommended: makes the daily neuron cap exact and persistent)
// Vars:
//   NEURON_BUDGET    — neurons this Worker may spend per day (default 9000 of the free 10,000, leaving headroom
//                      for estimate error and your other Workers AI apps). Resets 00:00 UTC.
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
  // Image models the app can choose from. multipart = Cloudflare-hosted FLUX.2 (input images < 512x512).
  render: {
    'klein-4b': { id: '@cf/black-forest-labs/flux-2-klein-4b', kind: 'multipart', neurons: 110 },  // 4 tiles x 26.05
    'schnell':  { id: '@cf/black-forest-labs/flux-1-schnell',  kind: 'schnell', neurons: 60 },     // 4 tiles x 4.8 + 4 steps x 9.6
    'klein-9b': { id: '@cf/black-forest-labs/flux-2-klein-9b', kind: 'multipart', neurons: 1400 }, // 1363.64 per first MP
    'dev':      { id: '@cf/black-forest-labs/flux-2-dev',      kind: 'multipart', neurons: 4000, steps: 25 }, // 4 tiles x 37.5 x 25 steps
    // Only Cloudflare-hosted models: they draw from the free daily Neuron allowance.
    // Content filters: none of these four exposes a moderation setting. If a model with one is added,
    // give it safetySetting: { name: 'safety_tolerance', leastRestrictive: 5 } and it is applied automatically.
    // "Third-party" models (e.g. FLUX.2 [max]) are billed in dollars and are deliberately not listed.
  },
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
        const used = await getUsed(env), budget = budgetOf(env), left = Math.max(0, budget - used);
        const rendersLeft = {};
        for (const [k, m] of Object.entries(MODELS.render)) rendersLeft[k] = Math.floor(left / m.neurons);
        return json({ ok: true, ai: !!env.AI, neuronsUsed: Math.round(used), neuronBudget: budget, rendersLeft, persistentCap: !!env.LIMITS, resetsAtUTC: '00:00' });
      }
      if (!env.AI) return json({ error: 'Workers AI binding "AI" is missing on this Worker.' }, 500);
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

      const body = await request.json();
      // Estimate this call's cost and refuse it if it would pass today's budget.
      let cost = 0, label = '';
      if (url.pathname === '/plan') { cost = COST.plan; label = 'planning'; }
      else if (url.pathname === '/vision') { cost = COST.vision; label = 'vision check'; }
      else if (url.pathname === '/render') {
        const m = MODELS.render[body.model] || MODELS.render['klein-4b'];
        cost = m.neurons + ((body.image || body.guide) ? COST.inputImage : 0); label = 'render';
      }
      if (cost) {
        const used = await getUsed(env), budget = budgetOf(env);
        if (used + cost > budget) {
          return json({ error: `Not enough of today's free AI allowance left for this ${label} (${Math.round(used)} of ${budget} neurons used; it needs about ${cost}). It resets at 00:00 UTC (7 pm Toronto).`, capped: true, neuronsUsed: Math.round(used), neuronBudget: budget }, 429);
        }
      }

      let res;
      if (url.pathname === '/plan') res = json(await plan(env, String(body.prompt || '').slice(0, 600)));
      else if (url.pathname === '/vision') res = json(await vision(env, body.image, (body.questions || []).slice(0, 16)));
      else if (url.pathname === '/render') {
        const out = await render(env, body);
        res = new Response(out.bytes, { headers: { ...cors, 'Content-Type': out.type, 'X-Model': out.model } });
      }
      if (res) { ctx.waitUntil(addUsed(env, cost)); return res; }
      return json({ error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

// ---- Daily neuron budget ----
// Estimates from Cloudflare's published per-model rates for a 1024x688 image (4 output tiles).
// They are deliberately rounded UP so the real spend stays under the budget.
const COST = { plan: 60, vision: 120, inputImage: 10 };
function budgetOf(env) { return parseInt(env.NEURON_BUDGET || '9000', 10); }
function dayKey() { return 'neurons-' + new Date().toISOString().slice(0, 10); }
const memUsed = {}; // fallback when no KV is bound (per Worker instance only, so not exact)
async function getUsed(env) {
  if (!env.LIMITS) return memUsed[dayKey()] || 0;
  return parseFloat((await env.LIMITS.get(dayKey())) || '0');
}
async function addUsed(env, n) {
  if (!n) return;
  const k = dayKey();
  if (!env.LIMITS) { memUsed[k] = (memUsed[k] || 0) + n; return; }
  const used = await getUsed(env);
  await env.LIMITS.put(k, String(used + n), { expirationTtl: 60 * 60 * 48 });
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
  const n = questions.length;
  const q = questions.map((x, i) => `${i + 1}. ${x}`).join('\n');
  const text = `Look carefully at this photo and answer each question with yes or no. Be strict: answer yes only if it is clearly true.\n${q}\nReply ONLY with JSON, no explanation: {"answers":["yes","no",...]} with exactly ${n} entries.`;
  const errs = [];
  for (const model of MODELS.vision) {
    try {
      // generous token budget: some newer models think before answering
      const r = await env.AI.run(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] }],
        max_tokens: 1200, temperature: 0,
      });
      const raw = textOf(r);
      const answers = parseAnswers(raw, n);
      if (answers.length === n) return { answers, model };
      errs.push(`${model.split('/').pop()}: got ${answers.length}/${n} answers (${raw.slice(0, 80).replace(/\s+/g, ' ')})`);
    } catch (e) {
      errs.push(`${model.split('/').pop()}: ${String(e.message).slice(0, 120)}`);
      if (/agree/i.test(String(e.message)) && model.includes('3.2')) { try { await env.AI.run(model, { prompt: 'agree' }); } catch {} }
    }
  }
  throw new Error('No vision model answered: ' + errs.join(' | '));
}
function parseAnswers(s, n) {
  s = String(s).replace(/<think>[\s\S]*?<\/think>/gi, '');
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

async function bytesFrom(r) {
  if (r instanceof ReadableStream) return new Uint8Array(await new Response(r).arrayBuffer());
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r instanceof Uint8Array) return r;
  const v = r && (r.image || (r.result && r.result.image) || (Array.isArray(r.images) && r.images[0]) || r.output || r.url);
  if (!v) throw new Error('no image in reply: ' + JSON.stringify(r).slice(0, 120));
  const str = String(v);
  if (/^https?:\/\//.test(str)) { const f = await fetch(str); if (!f.ok) throw new Error('image download ' + f.status); return new Uint8Array(await f.arrayBuffer()); }
  return b64ToBytes(str.replace(/^data:[^,]+,/, ''));
}

async function render(env, body) {
  const prompt = String(body.prompt || '').slice(0, 1800);
  if (!prompt) throw new Error('prompt required');
  const key = MODELS.render[body.model] ? body.model : 'klein-4b';
  const m = MODELS.render[key];
  const w = Math.min(1280, Math.max(256, (parseInt(body.w, 10) || 1024) & ~15));
  const h = Math.min(1280, Math.max(256, (parseInt(body.h, 10) || 688) & ~15));
  const img = body.image || body.guide; // edit source or layout guide (< 512x512 JPEG data URL)
  const seed = body.seed != null ? (parseInt(body.seed, 10) >>> 0) : undefined;
  let lastErr;
  for (const withSeed of [true, false]) {
    try {
      let r;
      if (m.kind === 'multipart') {
        const form = new FormData();
        form.append('prompt', prompt);
        form.append('width', String(w));
        form.append('height', String(h));
        if (withSeed && seed != null) form.append('seed', String(seed));
        if (withSeed && m.steps) form.append('steps', String(m.steps));
        if (img) form.append('input_image_0', new Blob([dataURLtoBytes(img)], { type: 'image/jpeg' }), 'input.jpg');
        const fr = new Response(form);
        r = await env.AI.run(m.id, { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } });
      } else if (m.kind === 'schnell') {
        // FLUX.1 [schnell]: text only, fixed square output, 4 steps (cheapest)
        const input = { prompt: prompt.slice(0, 2000), steps: 4 };
        if (withSeed && seed != null) input.seed = seed;
        r = await env.AI.run(m.id, input);
      } else {
        const input = { prompt, width: w, height: h, output_format: 'jpeg' };
        if (m.safetySetting) input[m.safetySetting.name] = m.safetySetting.leastRestrictive;
        if (withSeed && seed != null) input.seed = seed;
        if (img) input.image = img;
        r = await env.AI.run(m.id, input);
      }
      return { bytes: await bytesFrom(r), type: 'image/jpeg', model: m.id };
    } catch (e) { lastErr = e; if (!/seed|steps/i.test(String(e.message))) break; }
  }
  throw new Error(`${key} failed: ` + (lastErr && lastErr.message));
}

# Assemblage — setup

## 1. The app
`index.html` is served by GitHub Pages. It needs the Worker: all rendering, planning and checking run there.

## 2. The Worker (free tier)

1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste `worker.js`.
2. Settings → Bindings → add **Workers AI**, name it `AI`.
3. Daily cap (recommended): create a KV namespace and bind it as `LIMITS`. The Worker estimates each call's cost in neurons and refuses calls once `NEURON_BUDGET` (default 9000 of the free 10,000 per day) would be passed. Without KV the cap still works, but only roughly.
4. Optional: add the variable `ALLOWED_ORIGINS` = `https://swowanders.github.io`.
5. In the app, open ⚙︎, paste the Worker URL, and tap **Test Worker**.

Or use the command line with `wrangler.toml`: `npx wrangler deploy`.

## Model names
They're at the top of `worker.js` (`MODELS`). Each list is tried in order, so if Cloudflare retires a model the next one takes over. If you use Llama 3.2 Vision, the Worker accepts its licence automatically the first time.

## Cost
Each picture is about 1 plan + 3 renders + 3 vision checks + up to 2 repairs. On FLUX.2 [klein] 4B that's roughly 1,200 neurons (estimates rounded up), so about 7 pictures a day inside the 9,000-neuron budget; fewer repairs or variations stretch it further. **Test Worker** in ⚙︎ shows what's left.

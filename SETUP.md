# Assemblage — setup

## 1. The app
`index.html` is served by GitHub Pages. It needs the Worker: all rendering, planning and checking run there.

## 2. The Worker (free tier)

1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste `worker.js`.
2. Settings → Bindings → add **Workers AI**, name it `AI`.
3. Optional daily cap: create a KV namespace, bind it as `LIMITS`, and add the variable `DAILY_CAP` (default 300 calls a day).
4. Optional: add the variable `ALLOWED_ORIGINS` = `https://swowanders.github.io`.
5. In the app, open ⚙︎, paste the Worker URL, and tap **Test Worker**.

Or use the command line with `wrangler.toml`: `npx wrangler deploy`.

## Model names
They're at the top of `worker.js` (`MODELS`). Each list is tried in order, so if Cloudflare retires a model the next one takes over. If you use Llama 3.2 Vision, the Worker accepts its licence automatically the first time.

## Cost
Each picture takes about 1 planning call, 3 renders, 3 vision checks and up to 2 repair renders plus checks (around 8–11 calls). Set `DAILY_CAP` to stay inside the Workers AI free allowance.

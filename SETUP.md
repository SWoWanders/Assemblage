# Assemblage — setup

## 1. The app (works on its own)
Put `index.html` on GitHub Pages. With no Worker it uses the built-in prompt parser and the layout self-check, and loads photos straight from Wikimedia Commons, Openverse and Poly Haven.

## 2. The Worker (optional, free tier)
It adds the AI planner, the vision checks and the polish pass, and proxies images so every source works in the browser.

1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste `worker.js`.
2. Settings → Bindings → add **Workers AI**, name it `AI`.
3. Optional daily cap: create a KV namespace, bind it as `LIMITS`, and add the variable `DAILY_CAP` (default 300 calls a day).
4. Optional: add the variable `ALLOWED_ORIGINS` = `https://swowanders.github.io`.
5. In the app, open ⚙︎, paste the Worker URL, and tap **Test Worker**.

Or use the command line with `wrangler.toml`: `npx wrangler deploy`.

## Model names
They're at the top of `worker.js` (`MODELS`). Each list is tried in order, so if Cloudflare retires a model the next one takes over. If you use Llama 3.2 Vision, the Worker accepts its licence automatically the first time.

## Credits
Photos keep their own licences, and they're listed under each picture. Poly Haven's API asks for a "Powered by Poly Haven" credit, which the app shows.

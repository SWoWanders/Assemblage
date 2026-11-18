# Assemblage

Layout-true text-to-image. The app plans the scene, lays it out with real camera geometry, renders it with a small fast model, then checks the result against the prompt and repairs what's wrong.

**Live app:** https://swowanders.github.io/assemblage/

How it works:
1. **Plan:** a Workers AI model, or the built-in parser as a fallback, turns the prompt into objects, counts, colours, materials, positions and setting.
2. **Lay out:** a pinhole-camera and ground-plane solver places every object at real-world scale. "Left of", "on", "behind" and the counts are followed exactly.
3. **Render:** FLUX.2 [klein] on Workers AI makes several variations. Most are guided by a layout sketch and a prompt that spells out each object's position; one is text-only as a safety net.
4. **Check:** each prompt claim becomes a yes/no question for a vision model, and the best-scoring variation wins.
5. **Repair:** failed items get a targeted edit ("make the umbrellas red, keep everything else"), which is kept only if the score goes up.

- `index.html` — the whole app.
- `worker.js` — the Cloudflare Worker it needs, with Workers AI and an optional daily cap. See `SETUP.md`.

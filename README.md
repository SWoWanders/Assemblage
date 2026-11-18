# Assemblage

Text-to-image built from real photographs instead of generated pixels.

**Live app:** https://swowanders.github.io/assemblage/

Your prompt is turned into a scene plan and a checklist. The app then finds real public-domain and Creative Commons photos (Wikimedia Commons, Openverse, Poly Haven 360° HDRIs) and cuts out the objects. It places them with a simple camera-and-ground model, relights them to match the sun, adds shadows, haze and a camera finish, and keeps the variation that best matches the checklist.

- `index.html` — the whole app. It works on its own with no keys.
- `worker.js` — optional Cloudflare Worker that adds Workers AI planning, vision checks and an image-to-image polish, with a daily cap. See `SETUP.md`.

# Weekend Projects

One small, fun portfolio project per week. Startup mode: ship something that works, don't polish forever.

## Structure
- Each project is a folder at the root named `NN-short-name` (e.g. `01-sound-garden`).
- Start a project by copying `_template/` and filling in its README.
- After adding a project, add a row to the table in the root `README.md`.

## Deploy rules
- Everything deploys to GitHub Pages on push to `main` (see `.github/workflows/pages.yml`).
- A project is either:
  - plain static files (an `index.html` in the folder), or
  - a Node app with a `build` script that outputs to `dist/`. Set the base path to `/weekend-projects/NN-name/` (for Vite: `base` in `vite.config`).
- No backend servers. If a project needs secrets or an API, keep it client side or use a free serverless option and note it in the project README.

## Each project README needs
A one line hook, live demo link, a demo GIF or screenshot, and short "what / why / how" sections.

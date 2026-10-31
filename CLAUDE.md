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

## How we work with Spiro
- Spiro is not technical. **Never ask him to review code, run commands, merge PRs or edit files.** Claude does all of that.
- Claude reviews, tests, merges, installs and builds. Work on his Mac goes through Remote Control (his `Documents/weekend-projects` folder).
- Only ask Spiro for: physical actions (wearing AirPods, mouthing sentences, clicking macOS permission popups, typing his Mac password), accounts or money, and anything that reaches real people (real texts, public posts). Sending a real message to a real person always needs his OK first.
- Updates are short, plain English, 7th grade, no jargon: what changed, what he can see, and the one thing he needs to do (if any).
- He is fine with Claude merging its own PRs to main, **only** after the ship checklist passes.

## Ship checklist (every PR, before merge)
1. Author agent passes its own gate (typecheck, unit, e2e, build).
2. A fresh reviewer agent that did not write the code reviews the diff against its brief and `PROTOCOL.md` (high effort). Fix findings, re-review until clean.
3. GitHub CI (`.github/workflows/ci.yml`) green: web job, Mac compile job, Python job.
4. Claude checks it for real: headless browser screenshots and click through; on his Mac when connected.
5. Merge with the GitHub REST API (`gh api repos/Spiro-12/weekend-projects/pulls/N/merge -X PUT`). After the Pages deploy, load the live URL and confirm.
6. Plain English update to Spiro.

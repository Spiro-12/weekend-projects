# Spike c: assets (SimReady pipeline, code-built robots, people), branch `p0-c-asset-spike`, port 5192

## Why
The app has to look like the SimReady reference demos, but load the full look in ≤ 5 s (first tier ≤ 4 MB gz) and run on phones. The SimReady GLB set has no people, no humanoid and no AMR, and many models are far too heavy as shipped. Prove we can get a consistent, realistic asset set within budget, with clean licenses.

Read PLAN.md §3b and §9 (budgets) and RESEARCH.md Part B (the full asset survey, the shortlist with file names, the license and credit text).

## You own
- `scripts/assets/**`: the pipeline. **Kept**; Track D maintains it in Phase 1.
- `public/assets/**`: optimized GLBs + `manifest.json`. **Kept.**
- `src/render/models/**`: code-built models. **Kept**; Track E maintains it in Phase 1.
- `CREDITS.md`: kept.
- `spikes/c-assets/**`: throwaway preview page and contact sheet.
- The raw download cache is `.cache/simready/` (already gitignored). **Never commit raw downloads.**

## Build
1. **Pipeline** `scripts/assets/build-assets.ts` (`npx tsx scripts/assets/build-assets.ts`). It uses `@gltf-transform/core|extensions|functions`, `meshoptimizer` and `sharp` (installed).
   - Downloads the shortlist from `https://huggingface.co/datasets/codepawl/simready-glb/resolve/3be2abd90406285b34f868907290aa4992dece7b/<path>`. **Pinned revision**, nothing else.
   - Per asset: dedup, weld, simplify to its triangle budget, flatten/join to 1 to 3 materials, resize textures (1024 high, 256 to 512 low) as WebP, meshopt compression.
   - Puts the origin on the floor at the footprint center, in metres, Y up.
   - Writes `public/assets/<name>.glb` and, where useful, `<name>-lo.glb` for the low tier.
   - Writes `public/assets/manifest.json`, model key → `{ url, urlLo?, scale, offset, tris, bytes, gzBytes, license, credit, source, firstTier }`.
   - The script is idempotent and prints a size table.
2. **Needed for the first tier:**
   - pallet; loaded pallet (near and in-rack); shrink-wrapped pallet
   - 2 to 3 cartons; tote
   - conveyor section; pack table
   - counterbalance forklift (human-driven); walk-behind stacker `blue_a01` (base for the autonomous forklift)
   - dock safety gate; guard rail; overhead light; column

   Racks taller than 3 m, dock doors, trailers and floor paint are built in code later (Track D). Skip them.
3. **Code-built models** in `src/render/models/` (three.js builders returning a `THREE.Group`, pure geometry and materials, no downloads):
   - `amr.ts`: a generic cart robot, Locus-like proportions but no branding. Low base with bumper light strip, mast, 2 to 3 tote shelves, a small screen. Named parts: `body`, `totes`, `light`, so Track E can instance and animate them.
   - `humanoid.ts`: a generic warehouse humanoid. Clean industrial look, about 1.75 m, a head with a sensor visor, named limb groups for a procedural walk.
   - `autonomous-forklift.ts`: dresses the stacker GLB with a sensor mast (lidar puck), a blue safety light and a warning-light strip.
   - Respect triangle budgets: AMR ≤ 8k, humanoid ≤ 10k.
4. **Human worker:**
   - Try Quaternius Universal Base Characters + Universal Animation Library (quaternius.com, CC0). **Check the LICENSE inside each zip**, since newer packs may use "QAL".
   - Extract one character with walk and idle clips, add a hi-vis vest (a texture or material edit), decimate to ≤ 15k triangles, and output `public/assets/worker.glb`.
   - If downloading needs an account or the license isn't CC0/CC BY, **stop that part** and report it. The lead will ask Spiro for a Sketchfab sign-in and the photoreal Renderpeople option.
5. **Licenses:**
   - Read each model's NVIDIA license file in the dataset (the survey found per-model license files). Only CC BY 4.0 or CC0 ships.
   - Look at the forklift decal textures (save them as PNG and view them) and remove or replace any real brand logos.
   - Write `CREDITS.md` with the exact credit text from RESEARCH.md Part B: NVIDIA SimReady via codepawl, the license link, "modified" notes, and the worker's credit.
6. **Preview and contact sheet:** a small Vite page `spikes/c-assets/index.html` (port 5192) that shows every asset on a dark glossy floor under RoomEnvironment lighting.
   - Take screenshots: each model, plus a small scene with a rack bay of pallets and cartons, a forklift, the AMR, the humanoid and the worker together.
   - Build `spikes/c-assets/out/contact-sheet.png`, placing your scene shots next to the reference frames in `02-fleet-planner/.refs/` in the main checkout (`git worktree list` shows it first; gitignored, never commit) (read-only, never commit them).
   - Commit a small (≤ 500 KB) `spikes/c-assets/scene.png` of your own render only.

## Measure (`spikes/c-assets/RESULTS.md`)
- **Per asset:** triangles, draw calls, bytes, gzipped bytes, texture sizes.
- **Totals, gzipped:** first tier ≤ 4 MB (including the meshopt decoder), all ≤ 15 MB, phone low tier ≤ 2 MB. Gzip with level 6, the same as `scripts/serve-gz.ts`.
- **Triangle budgets:** forklift ≤ 15k, humanoid ≤ 10k, worker ≤ 15k, rack-bay props ≤ 2k, carton ≤ 50 at the far LOD, pallet ≤ 300.
- **Your honest judgment, from the contact sheet:** does the set look consistent and realistic next to the references? Which items look off?

## Done when
- `public/assets/` + `manifest.json` within budget.
- Code-built models render in the preview.
- `CREDITS.md` complete.
- `RESULTS.md` written.
- `npm run typecheck` passes.
- Everything committed on your branch (optimized assets included, raw cache excluded).

Time box: about 2.5 hours.

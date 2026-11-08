# Track D: world, assets, credits, branch `p1-d-world`, port 5201

## Goal
Make the building look like the reference demos: a bright industrial hall with a dark glossy floor, yellow lane lines, tall blue racks full of cartons on pallets, docks, conveyors and pack stations, chargers. It must stay inside the draw-call and triangle budgets with **two copies in split screen**, show a useful picture before any model downloads, and swap in the real SimReady models after.

## Read first
- PLAN.md §3b, §4 and §9 (budgets).
- PROTOCOL.md §3, §9 and §12 (spike a + c decisions).
- `src/render/core/layers.ts` (**the `WorldLayer` interface you implement**), `renderer.ts`, `tiers.ts`, `geom.ts`.
- `src/render/world/procedural.ts` (the lead's Phase 0 world: yours to rework).
- `public/assets/manifest.json`, `scripts/assets/**`, `CREDITS.md`, `spikes/c-assets-RESULTS.md`.
- `spikes/a-render/src/static-world.ts`, `textures.ts` and `RESULTS.md` (instancing patterns and measured costs).

**Reference frames (look at them):** `/private/tmp/claude-501/-Users-spirokhoury-weekend-projects/3fe59ab2-4325-4547-9aab-1108c13934b6/scratchpad/refs/*.png`. Read-only; never commit them.

## You own
- `src/render/world/**`
- `scripts/assets/**` (the pipeline from spike c)
- `public/assets/**`
- `CREDITS.md`
- `src/ui/panels/about.tsx`
- `tests/e2e/world-*.spec.ts`

Don't edit `render/core/*`, `main.ts`, the layouts or the agents (Track E).

## Build
1. **`createWorldLayer(opts): WorldLayer`** in `src/render/world/index.ts`:
   - **First view:** procedural only, a few KB, no downloads.
   - **Then:** load the first-tier GLBs from the manifest (GLTFLoader + MeshoptDecoder from `three/addons`; `urlLo` on the low tier), swap them in, and resolve `fullLook`.
   - `setTier`: switch LODs, far boxes and detail without a rebuild where possible.
2. **The building shell and lighting are the biggest gap** (spike c). The references have light walls, high windows or skylight strips, steel roof trusses and rows of LED panels. Ours is a dark void.
   - Build in code: walls with a lighter band and window strips, instanced roof trusses, instanced SimReady `light_panel` rows with emissive glow, and SimReady `column`s on a grid where they don't block aisles.
   - Keep the **floor dark and glossy** (spike a: it reads grey now). Tune the material and environment so lane paint pops.
   - Keep the camera's overview able to see inside: a low or cut-away front wall, and roof trusses only (no solid roof).
3. **Racks:**
   - Procedural instanced uprights and beams (the far field must stay procedural: a SimReady rack GLB would add about 1.1M triangles per view).
   - **Loads from the manifest:** pallet + carton composites, with `pallet_wrapped` mixed in.
   - LOD: the near and mid field use the GLB loads; the far field (> about 40 m from the camera) uses procedural boxes or drops upper levels on the low tier.
   - **Stock levels may change in Phase 2** (picked faces emptier), so keep a per-face instance index.
4. **Docks:**
   - SimReady `dock_gate` per door, plus code-built roll-up doors and trailers outside the wall (visible through open doors).
   - Staging pallets on `S` cells.
5. **Pack area:**
   - SimReady `pack_table` at each station.
   - SimReady `conveyor` sections instanced along the conveyor zone, with a few cartons riding it (animate in `update()`; cheap).
   - `guard_rail`s at rack ends and along the conveyor.
6. **Chargers:** code-built charger posts with a glow strip (green when free).
7. **Floor paint:** keep and improve the lane lines, zone words ("PICK AND PACK", "SHIPPING & RECEIVING", "CHARGING", "PARKING"), aisle numbers, staging squares and chevrons. Paint in a canvas texture at a resolution capped by tier.
8. **Baked contact shadows** under racks and props (one-time render-to-texture or painted into the floor canvas).
9. **In-app credits:** `src/ui/panels/about.tsx` (slot `overlay`, a small "i" / "About & credits" button in a corner).
   - It opens a card with a short "what this is", the **NVIDIA SimReady credit** (exact text from `CREDITS.md`) and every asset's credit from the manifest, the Quaternius credit, and a link to the license.
   - CC BY 4.0 requires this wherever the assets ship.

## Budgets (single view, medium tier unless noted)

| Item | Budget |
|---|---|
| Draw calls (world) | ≤ 35 per view, so split screen stays ≤ 150 with agents |
| Triangles (world) | ≤ 600k per view |
| First useful view (procedural) | ≤ 2 s |
| Full first tier | ≤ 4 MB gz, done ≤ 5 s at 20 Mbps / 40 ms |
| Phone (low) | ≤ 2 MB |

Use `npx tsx scripts/perf.ts --url http://localhost:5201/weekend-projects/02-fleet-planner/?tier=medium --out tests/perf/out/d.json --sync --runs 1` for a rough check. Other tracks are running, so the lead re-measures at the gate.

## Tests (`tests/e2e/world-*.spec.ts`, `E2E_WEB_PORT=5201 npm run gate`)
- The world loads with no errors.
- `fullLook` resolves, and the manifest models are in the scene (check `render.info().triangles` grows after `fullLook`).
- Draw calls ≤ 35 for the world alone at the overview (hide `roots.agents` in the test).
- **The About panel opens and lists every manifest asset's credit, plus the NVIDIA line.**
- Low tier loads only `urlLo` models (check network requests).

**Visual check (required):**
1. Take screenshots: overview, an aisle at robot height, the pack area, the docks, and the phone overview (`npx tsx scripts/shots.ts --url http://localhost:5201/weekend-projects/02-fleet-planner/`, or your own).
2. Put them next to the reference frames and look hard. Is it the same league: bright hall, dark glossy floor, crisp yellow lanes, full racks?
3. Iterate until yes.
4. Save the final shots to `test-results/world/` (not committed) and list them in your report.

## Done when
- `E2E_WEB_PORT=5201 npm run gate` is green.
- The budgets are met: report your numbers.
- Screenshots reviewed.
- `CREDITS.md` and the About panel are complete.
- Committed on your branch.

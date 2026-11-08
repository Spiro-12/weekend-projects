# Spike a: render budget and perf harness, branch `p0-a-render-spike`, port 5191

## Why
The app must look as good as the reference demos and run about 60 fps on a laptop, including a split screen with two copies of the warehouse. Before contracts freeze, prove that the rendering approach in PLAN.md §4 meets the budget, and build the measurement harness every later gate uses.

Read PLAN.md §4, §9 (budgets) and RESEARCH.md Part C §1 (rendering) and §6 (testing and measurement).

## Read-only inputs
`src/sim/world.ts`, `data/layouts/default.json`, `src/sim/rng.ts`, `vite.config.ts`, `playwright.config.ts`, `scripts/serve-gz.ts`.

## You own
- `spikes/a-render/**`: a throwaway test page and its code.
- `scripts/perf.ts`, `tests/perf/**`: the reusable harness. **This part is kept**, so make it clean.

## Build (spike page)
A Vite page (`spikes/a-render/index.html`, own entry; run it with `npx vite spikes/a-render --port 5191` or a small vite config inside your folder) using three r187 `WebGLRenderer`, vanilla, no React. It shows the default layout from `buildWorld()`:
- **Static world:**
  - one merged floor with dark gloss and yellow lane lines
  - procedural instanced racks: uprights + beams, 5 levels, built from `#` cells
  - instanced boxes on every rack level: about 5,000 to 10,000 boxes, a few color variants
  - instanced pallets
  - walls
  - PMREM RoomEnvironment lighting, fog, AgX tone mapping
  - a baked contact-shadow texture under the racks
- **Agents:** up to **150 robots per side**, moving cell to cell on the grid with interpolation. Random walks are fine; no traffic logic needed.
  - Robots are instanced rigid parts (body, mast or lift, wheels).
  - **40 people** two ways, so we can choose:
    - (i) skinned: three's RobotExpressive GLB (CC0) as a stand-in, cloned with SkeletonUtils
    - (ii) instanced rigid parts with a procedural limb swing
- **Route ribbons:** instanced quads with a soft additive shader (glowing lines on the floor).
- **Bloom:** UnrealBloomPass on the high tier only.
- **Split screen:** one renderer, two scissor viewports, each side with its own agent instances.
- **Tiers:**

  | Tier | DPR | Effects |
  |---|---|---|
  | high | 2 | bloom, one shadow map for agents |
  | medium | 1.5 | no bloom, blob shadows |
  | low | 1 | far racks without boxes |

  Selected by `?tier=`.
- **Report `renderer.info`** (draw calls and triangles) per view.

## Build (harness, reusable)
`scripts/perf.ts`, run as `npx tsx scripts/perf.ts --url <url> --out tests/perf/out/<name>.json [--tour <name>] [--seconds 20]`:
- **Launch:** Chromium through Playwright. Try new headless first (`channel: 'chromium'`). If the WebGL renderer string (`WEBGL_debug_renderer_info`) does not show an Apple/Metal GPU, fall back to headed with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`.
- **Refuse to report numbers** if the GPU string contains SwiftShader or llvmpipe.
- **Assert and log:** `document.visibilityState === 'visible'` and the refresh rate (median rAF interval while idle).
- **Per frame:** CPU ms (time inside the page's render callback, via a hook the page exposes: `window.__fp.perf`) and GPU ms (`EXT_disjoint_timer_query_webgl2`, when available).
- **Camera tour:** the page exposes `window.__fp.tour(name)` and the harness drives it.
- **Output JSON:** p50, p95, max for CPU, GPU and frame time; draw calls, triangles, GPU name, refresh rate, tier, agent counts, run timestamp.
- **3 runs in a row** must agree within 5%, otherwise the harness says "noisy".
- Wrap runs in `caffeinate -d` (macOS) so the Mac doesn't sleep.
- A `--phone` flag runs a smoke check: 390×844, 4× CPU slowdown via CDP, low tier.

## Measure (write `spikes/a-render/RESULTS.md`)
Spikes b and c run at the same time on this Mac, so mark numbers as preliminary. The lead re-runs your harness when nothing else runs.
1. Single view, default fleet (about 60 robots + 16 people), each tier: CPU+GPU p95, draw calls, triangles.
2. Split screen with 150 robots per side, high and medium tiers. **Budget: p95 ≤ 16.7 ms and ≤ 150 draw calls** (both views together).
3. 40 people: skinned vs instanced-part cost. Pick one and say why.
4. Phone smoke check: low tier ≥ 30 fps for 2 min (emulated; only a smoke test).
5. **JS bundle size** (gz) of the spike page, for the three r187 imports you used. Budget ≤ 300 KB gz initial.
6. Recommend budgets for `budgets.json` and the tier thresholds (demote when p95 > 20 ms over 2 s, promote when < 12 ms over 5 s; confirm or adjust).
7. Save 3 screenshots (overview, aisle close-up, split screen) to `spikes/a-render/out/` and the high tier overview to `spikes/a-render/overview.png` (committed, ≤ 500 KB).

## Done when
The harness runs end to end and refuses SwiftShader. `RESULTS.md` answers 1 to 7. `npm run typecheck` passes (add your spike folder to nothing shared; type-check it with your own `tsconfig` inside the folder if needed). Everything is committed on your branch. Time box: about 2 hours.

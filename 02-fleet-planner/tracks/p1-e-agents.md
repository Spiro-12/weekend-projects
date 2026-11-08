# Track E: agents, camera, effects, branch `p1-e-agents`, port 5202

## Goal
The moving parts people watch:
- cart robots with glowing vendor lights and totes
- autonomous forklifts with a sensor mast, forks that lift
- people in hi-vis vests pushing carts
- humanoids that look like real industrial robots

Plus glowing route lines on the floor, visible jams and deadlocks, click-to-follow, all smooth at 150 robots + 40 people per side.

## Read first
- PLAN.md §4 and §9.
- PROTOCOL.md §5 (snapshot fields: `route`, `waitOn`, `state`, `cargo`, `deadlocks`), §9 and §12 (spike a + c decisions).
- `src/render/core/layers.ts` (**the `AgentLayer` interface you implement**), `camera.ts` (the rig API: `follow`, `overview`, `flyTo`), `geom.ts`, `tiers.ts`.
- `src/render/agents/basic.ts` (the lead's Phase 0 layer: yours to replace), `src/render/models/*` (code-built AMR, humanoid, autonomous forklift dressing from spike c).
- `public/assets/manifest.json` (`forklift`, `stacker`, `worker` with clips).
- `spikes/a-render/src/{robots,people-parts,people-skinned,fx}.ts` + `RESULTS.md` (measured: instanced-part people 23 draw calls vs skinned 779).
- `fixtures/snapshots-default.json`.

## You own
`src/render/agents/**`, `src/render/models/**`, `src/render/camera/**` (new, for camera behaviours built on the rig), `src/render/fx/**`, `tests/e2e/agents-*.spec.ts`. Don't edit `render/core/*`, `main.ts`, the world (Track D) or the panels (Track F).

## Build
1. **`createAgentLayer(opts): AgentLayer`** in `src/render/agents/index.ts` (replaces the basic layer). Load GLBs only through the shared loader `src/render/core/assets.ts`. Implement `debug()` (instance counts per type, ribbon count, deadlock markers) and `inject(snapshot | null)` (render a crafted snapshot in tests). Both are reachable as `__fp.render.layers.agents`.
   - Interpolate from `cell`, `to`, `moveStart`, `moveEnd` at `renderTick`, with smooth yaw.
   - Must work for any snapshot: FakeSim now, the real core later.
2. **Models** (instanced rigid parts everywhere; spike a measured why):
   - **Cart robot:** the code model, vendor-colored light band (A cyan, D violet, B orange, C mint). Totes visible when `cargo` is tote; a soft blink while `wait`ing for a picker.
   - **Autonomous forklift:** the `stacker` GLB + the code dressing (lidar puck, blue safety spot projected ahead, warning light). Forks raise during `work` at a face; a pallet on the forks when `cargo` is pallet.
   - **Manual forklift + driver:** the `forklift` GLB with a seated driver (instanced part person).
   - **Humanoid:** spike c's model looks toy-like (box head, capsule limbs, flat white); **redesign it**.
     - Aim for a believable industrial humanoid (think Agility Digit or Apptronik Apollo silhouettes, no branding): a rounded torso shell, a dark glossy face visor with a thin light line, visible joint caps, a two-tone grey/white with dark joints.
     - ≤ 10k triangles, instanced parts, procedural walk.
     - A tote carried in front when `cargo` is tote.
   - **People:**
     - Instanced rigid parts with a procedural walk (legs and arms swing with speed): hi-vis vest, dark trousers, a cart in front for pickers with cart cargo.
     - **One skinned "hero"**: the manifest `worker` (Quaternius, walk/idle/push clips) replaces the followed person only.
3. **Effects** (`src/render/fx/`):
   - **Route ribbons:** instanced floor quads with a soft additive shader along `route`, colored by vendor, fading with distance. Brighter for the selected agent.
   - **Blocked:** an amber ring when `blockedTicks > 4`.
   - **Deadlock:** for each `snapshot.deadlocks` entry:
     - pulsing red rings on the members
     - red arrows along the `waitOn` cycle
     - a "DEADLOCK 0:42" label (CSS2DRenderer or a sprite, ≤ 20 labels on screen)
   - **Selection:** a yellow ring, and a "waiting for" arrow from the selected agent to its `waitOn`.
   - **Hover:** a small label (name · type · state) on the agent under the pointer (desktop only).
   - **Bloom:** only on the high tier, and only on emissive things (use a layer or threshold so the floor doesn't bloom). Fix the seam bleed spike a saw in split screen.
4. **Camera** (`src/render/camera/`): build on the rig. When following, the camera eases behind the agent (exists). Add a gentle "pull out" when the followed agent stops for a long dwell, so it doesn't stare at a rack: return a larger `distance` / `height` from your `followTarget()` (the rig reads them). Keep Escape / click-empty-floor → `overview()`.
5. **Picking:** reliable click and tap on instanced parts (raycast `instanceId` → agent), plus a generous screen-space fallback for small far agents.
6. **Tiers:** low drops ribbons to every other robot and uses simple people. Lite drops ribbons.

## Budgets
- Agents + effects ≤ 20 draw calls per view.
- 150 robots + 40 people per side within the split budget: the lead measures, and the whole split frame needs `work` p95 ≤ 16.7 ms at medium.
- Rough check: `npx tsx scripts/perf.ts --url "http://localhost:5202/weekend-projects/02-fleet-planner/?tier=medium&agents=150" --out tests/perf/out/e.json --sync --runs 1`.

## Tests (`tests/e2e/agents-*.spec.ts`, `E2E_WEB_PORT=5202 npm run gate`)
- Clicking an agent (via `__fp.render.project`) follows it; Escape returns to the overview.
- **Every agent type renders:** count instances via `__fp.render.layers.agents.debug()`.
- **Ribbons:** the count equals the robots with routes.
- **Deadlock markers:** `__fp.freeze(true)`, then `__fp.render.layers.agents.inject(snapshotWithA2AgentDeadlock)` → rings, arrows and the label exist (`debug()`).
- Draw calls for agents ≤ 20 at the overview with 150 robots.
- No console errors.

**Visual check (required):** screenshots of a followed AMR in an aisle, a forklift at a face, people and a humanoid near the pack area, and a deadlock. Compare them with the reference frames in `.refs/` in the main checkout (`git worktree list` shows it first; gitignored, never commit) (read-only). Iterate until they look in league.

## Done when
`E2E_WEB_PORT=5202 npm run gate` is green, the budgets are met (report the numbers), the screenshots are reviewed, and the work is committed on your branch.

## Gate 0 visual review notes (address these)
1. **Forklifts:**
   - Chunky red/orange (≈ #D9452B) with a black mast, like the references, not the glossy royal-blue SimReady paint (recolor it).
   - The autonomous stacker is spindly and tiny: make it about 1.5× more solid.
2. **Agent visibility at overview:**
   - A soft 0.9 m type-colored glow disc under every agent (it also grounds them; today people seem to float).
   - A screen-space minimum size (about 14 px desktop, 10 px phone) at overview zoom.
   - Delete the capsule-and-ball people.
3. **Route ribbons:**
   - 10 to 15 cm flat ribbons 1 cm above the floor, additive, emissive above the bloom threshold.
   - Colors: AMRs cyan #22D3EE, forklifts orange #FF8A3D, humanoids violet #A78BFA (vendor shade within the type).
   - Dashes flow toward the goal at about 1.5 m/s, with the tail fading.
   - Full route only for the selected agent; others show only the next ~10 m (no spaghetti).
4. **Follow camera:**
   - Today it's too close, too high and too wide, so rack faces fill the frame. Target: 3 to 3.5 m behind, 1.8 to 2.2 m up, looking 2 m ahead at 0.6 m height, FOV 40 to 45°, spring damping about 0.25 s.
   - The subject should fill 25 to 30% of frame height, in the lower third.
   - Replace the thick yellow decal ring with a thin (6 cm) glowing cyan ring.
   - Fade racks between camera and subject if cheap.

   **The lead already applied the chase distances and FOV 38° in the Phase 0 rig.** You own the ring, the rack fading and any extra camera behaviour in `src/render/camera/`; report any further rig changes as requests.
5. **Overview framing:** the lead applied about 30° yaw and 38° pitch in Phase 0. Check it with your agents in it.
6. **Materials:** match one style across SimReady, code models and the worker (matte PBR, hi-vis #C8F031 vests). The AMR (white base, cyan glow, orange totes) is the best match today.

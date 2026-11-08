# Spike a: render budget and perf harness — results

**PRELIMINARY.** Measured 8 Nov 2026 on Spiro's MacBook Air (Apple M2, fanless) while spikes b and c ran on the same Mac. The lead must re-run `measure.sh` with nothing else running.

GPU check: every run reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)` in **new headless** (`channel: 'chromium'`). Headed was never needed. Page visible, idle refresh 60 Hz, `EXT_disjoint_timer_query_webgl2` available.

Setup:
- Viewport 1440×900 CSS px at deviceScaleFactor 2. The tier caps the DPR, so canvases are 2880×1800 (high), 2160×1350 (medium) and 1440×900 (low).
- Production build, served gzipped by `scripts/serve-gz.ts`.
- `default` tour, 20 s: overview orbit, dive into an aisle, drive it, pull out.
- 3 runs, fresh page load each.
- Raw JSON in `tests/perf/out/spike-a-*.json` (gitignored).

## Short answers

| # | Question | Answer |
|---|---|---|
| 1 | Single view, default fleet, per tier | Low and medium hold 60 fps with room to spare. **High (DPR 2 + bloom) does not** on the M2 Air: it drops about 1% of frames (28 of 3,569), and its serial CPU+GPU p95 is 19.4 ms. |
| 2 | Split, 150 robots per side | **Medium passes:** 0 dropped frames in 3×20 s, 46 draw calls, but little headroom. **High fails:** 4% dropped frames, serial CPU+GPU p95 about 21 ms. Draw calls pass in every config (max 78 ≤ 150). |
| 3 | 40 people: skinned vs instanced parts | **Instanced parts.** 4 draw calls per side vs 779. CPU p95 1.4 ms vs 12.4 ms. |
| 4 | Phone smoke (emulated) | Pass: 59.9 fps, 0 long frames in 120 s, 21 calls, 345k tris. CPU throttling only; the GPU is still the M2. |
| 5 | JS bundle | **164 KB gz initial** (budget 300). Bloom chain 5.6 KB and skinned path 13.3 KB are lazy chunks. |
| 6 | Budgets and tiers | Draw-call and triangle budgets hold. Make **medium the default desktop tier**, cap high at DPR 1.5 with half-size bloom, and replace the p95-based promote rule (below). |
| 7 | Screenshots | `out/overview.png`, `out/aisle.png`, `out/split.png` (+ `skinned`, `overview-medium`, `overview-low`). `overview.png` is committed (221 KB). |

## How to read the GPU numbers (important for every later gate)

Three different measures, because the obvious one misleads on this Mac.

1. **GPU timer, free-running** (`EXT_disjoint_timer_query_webgl2`, normal vsync loop).
   - On ANGLE/Metal the query spans the frame's first to last GPU command, so it also counts queueing and the gaps between passes.
   - Its p95 snaps toward 16.7 ms whenever frames queue. Medium single view shows p50 6.1 ms but p95 16.9 ms, at a perfect 60 fps.
   - Trust its **p50**, not its p95.
2. **Sync mode** (`perf.ts --sync`). The page reads back 1 pixel after each frame, so the GPU must finish the frame before the next one starts.
   - `work` = frame start to GPU done. It is an honest **upper bound** on serial CPU+GPU: about 2 to 3 ms of readback cost, and no CPU/GPU overlap.
   - In this mode the timer is clean for single-pass tiers (medium single: timer p95 10.4 ms). Bloom's many passes still inflate it.
   - Chrome's `gl.finish()` does **not** wait for the GPU (it measured 0.3 ms), hence the readback.
3. **Long frames, free-running.** Count of rAF intervals above 25 ms (1.5 × refresh). This is the ground truth for "does it hold 60".

**Thermal:** the M2 Air has no fan. Heavy configs got slower over the session: single-high GPU p50 went from 16.6 to 21.1 ms an hour later. `split60-high` ran after the heavy split runs and came out worse than `split150-high`. Let the Mac cool between configs.

## 1. Single view, default fleet (60 robots: 53 AMR + 7 forklifts, 16 people)

| Tier | Canvas | CPU p95 | GPU timer p50 (free) | Sync: GPU timer p95 / CPU+GPU p95 / work p95 | Long frames (3×20 s) | Draw calls max | Triangles max |
|---|---|---|---|---|---|---|---|
| high (DPR 2, bloom, agent shadow map) | 2880×1800 | 2.3 ms | 16.6 ms | 26.0 / 27.3 / **19.4 ms** | 28 / 3569 | 46 | 405k |
| medium (DPR 1.5, MSAA, blob shadows) | 2160×1350 | 1.4 ms | 6.1 ms | 10.4 / 11.6 / **14.5 ms** | 0 / 3597 | 23 | 373k |
| low (DPR 1, MSAA, no boxes past 30 m) | 1440×900 | 1.2 ms | 4.6 ms | 5.7 / 6.8 / **9.1 ms** | 0 / 3597 | 23 (17 in overview) | 373k |

Draw calls per view at medium = 23:
- static 10: floor, walls+props, racking (uprights, ties and beams in one InstancedMesh), pallets, 6 box chunks
- robots 7: AMR body, AMR top, forklift body, mast, forks, wheels, lights
- people 4
- blob shadows 1
- ribbons 1

High adds 11 shadow-map draws and 14 bloom/output passes, drops the blobs, and lands at 46.

Scene:
- 7,341 boxes, 2,627 pallets, 7,420 rack parts, 560 rack cells × 5 levels
- one merged floor with a canvas-painted lane texture and the baked contact shadow (also used as aoMap)
- PMREM RoomEnvironment, Fog, AgX tone mapping

Where the high tier's GPU time goes (static overview, single view, A/B against the high tier):

| Change from high | GPU timer p50 |
|---|---|
| none (high as specified) | 16.8 ms |
| bloom off | 9.0 ms |
| shadow map off | 14.9 ms |
| DPR 1.5 | 12.7 ms |
| DPR 1.5 + bloom mips at half size | 11.0 ms |

So UnrealBloomPass at 2880×1800 costs about 8 ms. The full-size HalfFloat target, bright pass, final blend and OutputPass are bandwidth-bound on the M2. The agent shadow map costs about 2 ms. MSAA at DPR 1.5 costs about 2.3 ms (medium with `aa=0`: 5.5 vs 7.8 ms).

## 2. Split screen, 150 robots per side (+ 40 people per side), one renderer, two scissor viewports

| Config | Canvas | CPU p95 | GPU timer p50 (free) | Long frames (free, 3×20 s) | Sync: CPU+GPU p95 / work p95 | Calls | Triangles |
|---|---|---|---|---|---|---|---|
| high as specified (DPR 2, bloom, shadows) | 2880×1800 | 3.6 ms | 22.0 ms | **138 / 3453 (4%)** | 28.6 / 21.2 ms | 78 | 1.01M |
| **medium** | 2160×1350 | 2.7 ms | 9.2 ms | **0 / 3597** | 16.7 / 19.6 ms | 46 | 848k |
| high at DPR 1.5 + half-size bloom | 2160×1350 | 1.0 ms | 13.7 ms | 0 / 3597 | 21.9 / 17.4 ms | 78 | 1.01M |
| low | 1440×900 | 0.8 ms | 7.1 ms | 0 / 3597 | 11.4 / 13.7 ms | 42 | 791k |
| high as specified, 60 per side (default fleet) | 2880×1800 | 2.7 ms | 39 ms (thermal) | 238 / 3356 | n/a | 78 | 810k |

**Verdicts against the brief's budget (p95 ≤ 16.7 ms, ≤ 150 draw calls):**
- Medium: holds 60 fps with 0 dropped frames; CPU+GPU p95 is right at the line (16.7 ms by the sync timer, 19.6 ms by the readback upper bound). **Pass, thin headroom.**
- High as specified: **fail.**
- High at DPR 1.5 with half-size bloom: borderline (0 dropped frames free-running, 17.4 ms work).
- Draw calls: pass everywhere. Shadows and bloom are counted.

Why split costs more: each view re-draws all instanced geometry, so triangles about double. The shadow map renders once per view, because the two sides' agents share world coordinates.

Notes:
- Bloom runs once over both viewports (SplitRenderPass → UnrealBloomPass → OutputPass). It bleeds a few pixels across the seam; a 2 px divider would hide it.
- On portrait screens the views stack top and bottom.

## 3. 40 people: skinned vs instanced parts (medium, single view, 60 robots)

| | CPU p95 | GPU timer p50 | Draw calls | Triangles |
|---|---|---|---|---|
| (ii) instanced parts (torso, head+hat, legs ×2, arms ×2; procedural swing) | 1.4 ms | 6.8 ms | 23 | 396k |
| (i) skinned RobotExpressive, SkeletonUtils clones, one AnimationMixer each | 12.4 ms (p50 4.5 to 5.9) | 9.4 ms | 779 | 488k |

**Pick (ii) instanced parts.** Why:
- RobotExpressive has 19 primitives, so 40 clones cost 760 draw calls per view, and as many again in the shadow pass on high (1,557 measured).
- Even a production worker with 1 skinned mesh would cost 40 draws per side, 80 in split. That is half the 150 budget for people alone.
- 40 mixers plus skeleton updates cost about 4 to 12 ms of CPU.
- Parts cost 4 draws per side for any crowd size.
- If the follow cam needs a nicer person close up, use one skinned "hero" for the followed or hovered person only.

## 4. Phone smoke check

`perf.ts --phone`: 390×844, DPR 3 emulated, touch, 4× CPU slowdown via CDP, `?tier=low` (DPR capped to 1), default fleet, one 120 s run.
- Result: **59.9 fps, 0 long frames out of 7,199.**
- CPU p95 1.2 ms, GPU timer p50 2.1 ms, 21 draw calls (≤ 60), 345k triangles (≤ 500k).
- Smoke only: the GPU is still the M2. The real check is Spiro's iPhone with `?perf=1` (HUD). iOS Safari has no timer query, so the HUD will show GPU as NaN there.

## 5. JS bundle (Vite production build, gzip level 6 like `serve-gz.ts`)

| Chunk | Min | Gz |
|---|---|---|
| three.core (shared core) | 236 KB | 61.5 KB |
| entry: WebGLRenderer + OrbitControls + RoomEnvironment + spike code | 406 KB | 101.3 KB |
| BufferGeometryUtils | 5 KB | 1.4 KB |
| **Initial total** | | **164.3 KB** (budget 300) |
| lazy: EffectComposer + UnrealBloomPass + OutputPass + Pass + CopyShader (high tier only) | 18 KB | 5.6 KB |
| lazy: GLTFLoader + SkeletonUtils + skinned module | 45 KB | 13.3 KB |

Three r187 imports used:
- core: WebGLRenderer, InstancedMesh, InstancedBufferGeometry, ShaderMaterial, MeshStandardMaterial, MeshBasicMaterial, PMREMGenerator, CanvasTexture, Fog, DirectionalLight, AnimationMixer, geometries
- examples: OrbitControls, RoomEnvironment, BufferGeometryUtils, EffectComposer, UnrealBloomPass, OutputPass, Pass, GLTFLoader, SkeletonUtils

Re-measure: `npx vite build --config spikes/a-render/vite.config.ts && npx tsx spikes/a-render/bundle-size.ts`.

## 6. Recommended budgets and tiers

**budgets.json:**
- **Draw calls:**
  - Laptop, both views: keep ≤ 150. Measured max 78 (high split, shadows and bloom included).
  - Per-view allowance for the Phase 1 tracks: static world ≤ 16 (D adds BatchedMesh props), agents + fx ≤ 16 per side (E), post ≤ 15.
  - Phone: keep ≤ 60 (measured 21).
- **Triangles:**
  - Laptop, both views: tighten to ≤ 1.5M (measured 1.01M split).
  - Watch the rack GLB swap: a SimReady rack bay at 2k tris × 560 bays is 1.1M per view, 2.2M in split. Keep the procedural instanced racking (89k tris) for the far field, and GLB bays near the camera only.
  - Phone: keep ≤ 500k (measured 345k).
- **Initial JS:** tighten to ≤ 250 KB gz. The spike is 164 KB; the app adds about 7 KB of Preact/signals plus its own code. uPlot and bloom stay lazy.
- **Frame time:**
  - At the gate, measure each config twice: free-running for long frames, `--sync` for cost.
  - **Pass** = long frames ≤ 0.5% of frames and sync `work` p95 ≤ 16.7 ms (default fleet, single and split, at the default tier).
  - Max fleet (150 per side): `work` p95 ≤ 25 ms (as PLAN), and no more than 1% long frames.
  - Do not gate on the free-running timer p95 (see "How to read").

**Tiers:**

| Tier | DPR | Effects | Change |
|---|---|---|---|
| high | **≤ 1.5** (was 2) | bloom with **half-size mips** (`bloomScale 0.5`), agent shadow map, no MSAA | DPR 2 + full bloom drops frames on the M2 Air even in single view |
| medium | 1.5 | MSAA, blob shadows, ribbons | **default on desktop** (Spiro's laptop class) |
| low | 1 | MSAA, blobs, no boxes past 30 m | start here on touch and small screens (as planned) |
| Lite | 0.75 | as planned | not measured |

**Thresholds** (PLAN: demote when p95 > 20 ms over 2 s; promote when p95 < 12 ms over 5 s):
- **Demote: keep**, but measure it on rAF intervals. At vsync, a rAF p95 above 20 ms means more than 5% of frames were dropped in 2 s (6 of 120). That works on every browser, iOS Safari included.
- **Promote: replace.** Under vsync, rAF intervals never go below 16.7 ms, and the free-running GPU timer p95 snaps toward 16.7 ms on ANGLE/Metal, so "p95 < 12 ms" would almost never fire.
  - Instead, promote when **CPU p95 + GPU timer p50 × (next tier's cost ratio) < 14 ms over 5 s.**
  - Measured ratios: high/medium about 2.7×, medium/low about 1.3×. For example, medium at 6.1 ms × 2.7 = 16.5 ms would rightly not promote to high.
  - No timer query (iOS Safari): never promote. Phones start low and only demote.
- **Hysteresis:** no promotion for 60 s after any demotion, and at most one promotion per minute. Thermal drift on fanless Macs makes ping-pong likely otherwise.

## 7. Screenshots

`spikes/a-render/out/` (gitignored; regenerate with `npx tsx spikes/a-render/shots.ts`):
- `overview.png`, `aisle.png`, `split.png` (150 per side + 40 people per side)
- `skinned.png`, `overview-medium.png`, `overview-low.png`

`spikes/a-render/overview.png` (committed, 1440 px palette PNG, 221 KB) is the high-tier overview.

Notes for track D (look):
- The floor reads mid-grey at grazing angles (env specular on gloss); it should be darker.
- Ribbons read well in aisles and on bloom, but are thin from the overview.
- The low tier's far-box culling empties every rack in the overview (chunks are 3 × 2 over the storage area). Finer chunks, or per-instance distance culling, would look better.

## Harness (kept): `scripts/perf.ts` + `tests/perf/`

```
npx tsx scripts/perf.ts --url <url> --out tests/perf/out/<name>.json [--tour default] [--seconds 20] [--runs 3]
     [--sync] [--phone] [--headed] [--uncapped] [--raw] [--strict] [--viewport 1440x900] [--dpr 2]
```

What it does:
- New headless first, headed with Metal flags if the GPU is not Apple/Metal. Exits 2 with no output on SwiftShader or llvmpipe; check with `--selftest-software` (verified: exit 2, no file).
- Asserts the page is visible and logs the idle refresh rate. Runs under `caffeinate -d -i -w <pid>`.
- Output: p50/p95/max of CPU, GPU, CPU+GPU, work and frame time; fps, long frames, draw calls, triangles, GPU name, refresh, tier, agents, per-view info, timestamp.
- 3-run agreement on the budget metric within 5% (with a 0.2 ms floor), else `"verdict": "noisy"`.

Page contract: `tests/perf/hook.ts`.
- Required: PLAN §10's `perf.cpuMs()`, `perf.gpuMs()`, `perf.tier` and `render.info()`, plus `tour(name, seconds)`.
- Optional: `perf.drain()` for exact per-frame pairing, and `perf.sync(on)`.

Self-tests: `npx vitest run --config tests/perf/vitest.config.ts` (11 tests).

Agreement in this session:
- Most configs came out "noisy" (8 to 60% spread), because spikes b and c were running and the M2 Air throttles.
- Those that agreed within 5%: split150-high15, phone, and split150-medium/low/high15 in sync mode.
- Expect the quiet re-run to agree; if not, add a cool-down between configs.

## Spike page

URL params:
- `?tier=high|medium|low`, `?view=split`, `?robots=N` (per side), `?people=N` (per side), `?peopleMode=parts|skinned`
- `?freeze=S` (fixed sim time), `?pose=overview|aisle|far|high`, `?perf=1` (HUD)
- overrides: `?bloom= ?shadows= ?aa= ?dpr= ?bloomScale= ?boxFar=`

Run:
- dev server: `npx vite --config spikes/a-render/vite.config.ts` (port 5191)
- build: `npx vite build --config spikes/a-render/vite.config.ts`, then serve it with `npx tsx scripts/serve-gz.ts spikes/a-render/out/dist 5191`
- skinned mode needs `bash spikes/a-render/fetch-model.sh` (three r187's RobotExpressive.glb, CC0, not committed)

Full matrix: `bash spikes/a-render/measure.sh`, plus `PERF_FLAGS="--sync --seconds 12" PREFIX=spike-a-sync- bash spikes/a-render/measure.sh <names>`.

Agents are random walks on BFS routes from `world.ts` (`DistanceCache`), one cell per 2 to 3 ticks, interpolated, with no traffic logic.

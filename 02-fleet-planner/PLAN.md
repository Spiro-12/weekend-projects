# Fleet Planner (weekend project 02): Build Plan

> A 3D warehouse simulator in the browser that tells a warehouse owner which robots to buy, how many, and when they pay for themselves.

Numbers marked ⟨spike⟩ are confirmed or adjusted by the Phase 0 spikes before contracts freeze. Every research claim has a source in `02-fleet-planner/RESEARCH.md`. This plan was checked by an independent reviewer agent; its 25 findings are folded in.

---

## 1. Context and goal

Spiro is building a career on the business side of robotics. Project 02 has to show he understands the money (payback, labor, robots-as-a-service) and what actually happens on the floor (traffic, jams, charging, vendors that don't talk to each other).

The reference demos (An Xuan, Airsup) prove SimReady warehouses look great and get attention: 164K views and 2.4K bookmarks on a 1.8K-follower account. But they answer no business question, and they are heavy. Airsup's live page pulls **34 MB**: the models arrive after about 13 s, the whole page after about 19 s.

Ours must look as good, show a first useful view within 2 s and the full look within 5 s, and answer:
- **"Which robots, how many, and when do they pay back?"**
- **"Many brains vs one brain"** (the hero shot): the same building, robots and orders. One side runs each vendor's own traffic control, the other runs one orchestrator.

**Why now (verified, see RESEARCH.md):**
- Buyers use 3.4 robot brands on average, and 80% want payback within 3 years. 45% name integration as the top barrier, ahead of cost at 41% (Interact Analysis).
- Mixed fleets today mostly run in separate zones or take turns at shared spots.
- VDA 5050 v3.0 (Apr 2026) added RELEASE zones. ISO 21423 (2 Nov 2026) standardizes multi-vendor interoperability.
- NVIDIA launched SimReady Central (21 Oct 2026) with 2,000+ free assets for testing "before real-world deployment." We quote NVIDIA's words, not "before buying."

**Correction to the brief:** buyers use several brands, but no public number says how many single buildings run several vendors on one floor. The README says exactly that.

## 2. Who does what
| Claude (lead and agents) | Spiro |
|---|---|
| Research, plan, code, review, test, CI, merge, deploy, README, GIF, clip | A real-life test after each phase: open a link on his Mac and phone, follow a 5 to 10 minute script, send a screenshot or a yes/no |
| Perf and visual checks on Spiro's Mac (this session runs there) | Approve money for the AI consultant (P2) and create the accounts it needs |
| A plain-English update after every merge | Approve the social clip and post it himself (it reaches real people) |

**GitHub access (found while planning):** the Mac's active `gh` account `spiria1021` has **read-only** access to `Spiro-12/weekend-projects`. The `Spiro-12` account is also logged in.
- Every `gh` and `git push` call (lead and track briefs) runs with `GH_TOKEN=$(gh auth token -u Spiro-12)`, with no global account switch.
- Phase 0 step 1 proves a push, a merge-capable token and live-URL access (curl to `spiro-12.github.io`) before anything else.

## 3. Research summary (full write-up with sources: RESEARCH.md)
Four research agents ran in parallel, each citing 60 to 80+ sources.

**a) Default specs and prices** (go into `data/agents.json`; "est" = estimate, labeled in the UI with its reasoning and a range):

| | Cart robot (AMR, Locus-type) | Autonomous forklift | Humanoid (Digit-type) | Picker (person) | Forklift driver (person) |
|---|---|---|---|---|---|
| Speed in shared aisles | 1.0 m/s est (top 1.8) | 1.0 m/s est (top 1.5) | 0.8 m/s est (top 1.2) | 1.0 m/s with cart (1.3 free) | 1.34 m/s (3 mph rule) |
| Payload | 36 kg | 1,500 kg | 16 kg | 23 kg per lift (NIOSH) | 2,268 kg est |
| Battery | 10 h est, 1 h charge | 6 h est, 1 h charge | 2 h run per 1 h charge (67% uptime) | 8 h shift | 8 h shift |
| Buy | $35k est | $150k est | $200k + $20k setup | n/a | truck $35k est |
| Rent (RaaS) | $1,500/mo est (Brightpick list $2,190/mo, minimum 15, 3 years) | $5,000/mo est | $8,500/mo + $25k setup (analysts reading Agility's SEC filing) | n/a | n/a |
| Wage → fully loaded | n/a | n/a | n/a | $17.95 → $26.20/h (BLS May 2025, × 1.46 ECEC) | $22.32 → $32.60/h |
| Productivity | picker uplift 1.8x (75 → 135 units/h, Locus case studies) | 12 pallets/h est | 0.5x a person est | 75 units/h | 20 pallets/h |

What this means for the product:
- **"2 to 3x" AMR claims come only from vendors.** Case studies work out to 1.8 to 2.2x, and the independent field study is lower. In our sim, uplift is an **output**, not an input. It comes from walk speed, pick seconds per line and zone size, and is calibrated so the default lands near 75 → 135 units/h. The hover shows our number next to vendor claims.
- **Humanoids don't pay back yet.** About $49/h on one shift ($26/h on two) for about half a person's output, and GXO's CEO reports no ROI after 45 pilots. The app shows this honestly; it's a business insight, not a bug.
- **Warehouse turnover is about 48% a year** (BLS). It goes in the money panel as context, not in the payback math.
- **Weakest numbers:** autonomous forklift prices, humanoid work rate, AMR buy price and software fees, aisle speeds, maintenance %. All are estimates with ranges and editable.
- Zebra is exiting Fetch, and 6 River's Chuck is legacy. Neither is a "based on" reference.

**b) Assets** (codepawl/simready-glb: 2,595 GLBs, meshopt, metres, Y up):
- **License: OK.** NVIDIA's per-model license says CC BY 4.0 for all 38 shortlisted models.
  - Credit NVIDIA and the uploader codepawl, link the license, say we modified the files.
  - "NVIDIA SimReady" is a credit only, never branding.
  - Pin the dataset revision (it changed several times in 10 days) and self-host on Pages, which also gzips `.glb` (25 to 60% smaller).
- **No people, no humanoid robot, no AMR in the set, and nothing rigged.**
  - Cart robots (AMR): **built in code** (generic, about 0 KB).
  - Workers: Quaternius Universal Base Characters + Animation Library (CC0, no account) with a hi-vis vest. If they look too stylized next to SimReady, use Renderpeople "Nathan Animated 003" (CC BY 4.0, photoreal), which needs Spiro's free Sketchfab sign-in (section 13).
  - Humanoid robot: **built in code** with a procedural walk, or Ralph 1.0 / NORA (CC BY, Sketchfab) if the visual check prefers them. RobotExpressive (CC0, 134 KB) is the dev placeholder.
  - NVIDIA Isaac Sim people and robots can't be redistributed, so they're not used.
- **Forklifts:** three generic NVIDIA designs.
  - The walk-behind stacker `blue_a01` plus a sensor mast and lights becomes the autonomous forklift.
  - The counterbalance `blue_c01` is the human-driven one.
  - Decal textures get checked for real brand logos.
- **Heavy models:** the full counterbalance forklift is 1M triangles and 208 draw calls, and totes are 38k to 108k triangles. Only the lod2 and lod3 versions plus our decimation fit.
- **Built in code** (instanced, cheap): racks taller than SimReady's 3 m, dock doors, trailers, floor markings, cones, bollards and signs.
- **Sizes:**
  - First-tier set measured at **3.1 MB gz**: about 3.3 to 3.8 MB after re-compression, with worker and decoders.
  - Full high-detail set: about 12 to 15 MB.
  - Phone low tier: about 1.5 to 2 MB.
- **First view is procedural** (JS only, under 0.4 MB), and SimReady models stream in behind it.

**c) Tech:** decisions in section 4. The research's throwaway tests on Spiro's Mac:
- PIBT one brain: 0.03 ms/tick at 150 agents, about 1 s per 8 h shift.
- Naive many brains gridlocks (96 to 98% idle). With a recovery ladder it ran 35 to 54% below one brain, which is probably too large, so spike b tunes it.

**d) Market:** see section 1. Concrete "many brains" mechanisms to simulate, each sourced:
1. Separate vendor zones with handoff points.
2. First-come zone locks at crossings, narrow aisles, docks and chargers, and the classic deadlock they cause.
3. Fixed-timer traffic lights.
4. Single-file door and lift queues.
5. Status sharing only (MassRobotics / ISO 21423).
6. People breaking ties: help calls and supervisor minutes.
7. Separate job queues and chargers per vendor.

The one-brain side follows the VDA 5050 central controller: it books shared spots ahead, assigns jobs globally and staggers charging.

## 4. Architecture

```
                 ┌──────────────────── browser (static, GitHub Pages) ────────────────────┐
 data/ (JSON)    │  UI (Preact + signals): KPI tiles · money · fleet · follow card ·      │
 agents.json  ───┤   compare bar · sweep chart (uPlot) · stress · demo · report · about   │
 sources.json    │        ▲ signals                              │ commands / settings    │
 layouts/*       │  ┌─────┴───────────────── HOST ───────────────▼─────────────────┐      │
 scenarios/*     │  │ live clock (0.5 s ticks, 1x–100x) · command log · bus         │      │
                 │  │ RUNNER: evaluate(settings) → RunResult, in Web Workers,       │      │
                 │  │   cached by settings hash (money, tiles, baseline, compare,   │      │
                 │  │   sweep all use it)                                           │      │
                 │  └─────┬───────────────────────▲─────────────────────────────────┘      │
                 │        │ step(n)               │ snapshot + events (plain data)         │
                 │  ┌─────▼───────────────────────┴───────────────┐  ┌──────────────────┐  │
                 │  │ SIM CORE: pure TS, integers only, no DOM     │  │ KPI + ECON        │  │
                 │  │ world · detect · orders · tasks · agents     │  │ pure TS           │  │
                 │  │ traffic: central PIBT | siloed vendors       │  │ → Explained<T>    │  │
                 │  │ battery · faults · events · state hash       │  └──────────────────┘  │
                 │  └──────────────────────────────────────────────┘                        │
                 │        │ snapshots (prev, next) + fractional tick                         │
                 │  RENDER  three.js WebGL2: world (instanced) · agents (interpolated) ·     │
                 │          route ribbons · follow camera · split viewports · tiers          │
                 └──────────────────────────────────────────────────────────────────────────┘
 Node (Vitest, scripts) runs the same SIM CORE and RUNNER: unit · golden · hashes · CLI sweep
```

**Two clocks, one truth.**
- The **live view** plays the current settings visually, for watching, following robots and stress moments.
- The **numbers** (KPI tiles, money panel, compare bar, sweep) come from the **runner**: a headless `evaluate(settings)` of the same scenario and seed. It does 30 min of warm-up and 2 h measured, with seeded battery levels so charging shows up. That takes about 1 to 2 s in a worker and is cached by a settings hash.
- After any change, tiles show "recalculating…" for a moment, then stable numbers that are identical to the golden tests.
- A small live strip shows live counters (shipped, open orders, active jams), so the view and the numbers visibly agree.

**Key decisions (and why):**

| Decision | Why |
|---|---|
| **three.js r187, WebGL2 renderer, vanilla** (no react-three-fiber) | About 207 KB gz for our imports (the WebGPU build is 318 KB). three's own manual still calls WebGPU experimental, and its split-viewport bug would hit the hero feature. Proven in project 01. |
| **Instancing everywhere** (racks, boxes, pallets, robot parts, ribbons); BatchedMesh for props | About 40 draw calls per view, so split screen fits 150. |
| **meshopt + WebP**; no Draco; KTX2 only if phones need it | meshopt decoder 7.7 KB gz vs KTX2 260 KB. |
| **Procedural first view, then stream GLBs** | First useful view under 2 s instead of the reference's 13 to 19 s. |
| **Preact 11 + @preact/signals** (5 to 7 KB gz) | Many live numbers with hover explanations. Signals keep that simple; React is 46 KB. Project 01's plain DOM got verbose for reactive panels. |
| **uPlot**, lazy-loaded with the sweep (22 KB gz) | Fast line and band charts; Chart.js is 70 KB. |
| **Grid sim: 1.5 m cells, 0.5 s integer ticks; speed as mm per tick with carried remainder** (Bresenham style) | Deterministic and testable, and average speeds are exact (within 1%), not rounded to whole ticks per cell. |
| **PIBT for robot traffic** (hand-written, about 200 lines) | 0.03 ms/tick at 150 agents. Windowed A*/RHCR are too slow in JS, CBS doesn't scale, and no JS MAPF library is mature. |
| **People are cell agents on their own routes, not in the robot planner** | Matches reality: robots yield to people. The planner treats people's cells as fixed obstacles each tick. A person waiting 4 ticks steps aside. Picking aisles are 2 cells wide, so people and robots can pass. |
| **Runner as the single source of numbers** | Stable, reproducible tiles and payback that match golden tests. The live view is for seeing why. |
| **Common random numbers** | The order stream depends only on seed and scenario, so both split-screen sides and every sweep point see the same orders. The UI says so. |
| **Baseline = today's all-human operation, auto-sized** to the smallest crew that keeps up, on the same orders (user can override) | Payback compares two simulated runs, not a guess, and never compares against a baseline that can't keep up. |
| **Generic vendors** ("Vendor A cart robots"), each spec citing the real products it's based on | No trademark issues or false claims; numbers stay traceable. |
| **Simple payback, no discounting**, stated in every hover | How ops directors talk. Taxes, depreciation, interest listed as not modeled. |
| **Dark theme**, frosted panels | Glowing routes read best on dark (An Xuan reference); cards like Airsup. |
| **Optimized assets self-hosted in the repo** (pinned HF revision) | No runtime dependency, CORS or drift; Pages gzips them. |

## 5. Folder layout and ownership

```
02-fleet-planner/
  README.md RESEARCH.md PLAN.md PROTOCOL.md CREDITS.md RESULTS.md
  package.json package-lock.json vite.config.ts (root web/, publicDir ../public, outDir ../dist,
    base /weekend-projects/02-fleet-planner/) tsconfig.json tsconfig.sim.json
  vitest.config.ts playwright.config.ts budgets.json
  web/index.html
  data/        agents.json sources.json layouts/*.json scenarios/*.json demo/*.json   # lead
  fixtures/    snapshots-*.json events-*.json runresult.json econ.json sweep.json    # lead
  src/contracts/   types.ts validate.ts explain.ts                                   # lead
  src/sim/         rng.ts world.ts detect.ts fake.ts traffic/naive.ts index.ts (lead)
                   core: orders, tasks, assign, agents, humans, battery, faults/ (A; faults/ → I in Phase 2)
                   traffic/central/ (B) · traffic/siloed/ (G)
  src/kpi/  src/econ/                                                                # C
  src/host/        clock, commands, bus, runner/ (lead) · sweep/ (J)
  src/render/core/ renderer, roots, views, camera rig API, tiers, asset loader, perf overlay,
                   Lite mode, context-lost card (lead)
  src/render/world/ (D) · render/agents/ camera/ fx/ (E) · render/split/ (H)
  src/ui/          shell, slots, auto-mount, URL params (lead) · ui/panels/<name>.tsx (one owner each)
  src/demo/ (K) · src/report/ (M) · src/app/main.ts (lead)
  public/assets/   optimized GLB + manifest.json (D; seeded by spike c)
  scripts/         layout-gen.ts golden.ts perf.ts shots.ts serve-gz.ts gate.sh (lead)
                   assets/ (D) · sweep-cli.ts (J) · capture-clip.ts (N)
  tests/           unit/ golden/ e2e/ perf/ visual/
  proxy/           AI consultant worker (L, only if Spiro approves)
  tracks/          one brief per track
  media/           demo.gif, clip-*.mp4, screenshots (N)
```

**Rules:**
- **Ownership (from project 01):** only the lead touches `contracts/`, `data/`, `fixtures/`, `sim/{rng,world,detect,fake,index}.ts`, `host/` (except `sweep/`), `render/core/`, the `ui/` shell, `main.ts`, `package.json`, the lockfile and configs. A track that needs a change stops and asks in its final report.
- Panels auto-mount via `import.meta.glob`, each declaring a `slot` (section 6 §9), so UI tracks only add their own files.

## 6. Contracts (frozen in Phase 0, written in full to PROTOCOL.md)
Types live in `src/contracts/types.ts`, validators in `validate.ts`, examples in `fixtures/`. Only the lead changes contracts, in one commit that updates PROTOCOL.md, the types and the fixtures together. Planned bump: **Phase 2a**.

**§1 Units, time, state:**
- tick = 0.5 s (`TICK_MS = 500`), cell = 1.5 m (`CELL_MM = 1500`) ⟨spike b⟩
- Speed = mm per tick. Each agent carries leftover distance, so move durations alternate and the average speed is exact.
- Money in cents. Battery as `batteryTicksLeft` (per-mille only in the snapshot).
- `hash()` asserts every number in the canonical state is an integer.

**§2 Agent specs** (`data/agents.json`, `fp-agents v1`):
- Types: `amr | forklift | humanoid | picker | driver` (driver = person on a manual forklift).
- Per type:
  - `kind`, `model` (render key), `basedOn[]`
  - `speedMps`, `payloadKg`, `safetyCells` (forklift 1 ahead), `aisleMinCells` (forklift 2)
  - `can[]`, `pickSecPerLine`
  - `battery {runtimeH, chargeH, chargeAtPct}`
  - `cost {buyUsd, raasUsdPerMonth, maintPctPerYear, softwareUsdPerYear, integrationUsd, wageUsdPerHour, laborLoad}`
- Plus `labor.supervisor {wageUsdPerHour, minPerReset}`.
- Every number is `Sourced = {value, unit, src: <sources.json id>|'estimate', note?, range?}`.
- `data/sources.json`: `{id, title, publisher, url, date, accessed}`.
- A test fails on any number without `src`, any estimate without `note`, or an unknown `src`.

**§3 Layout** (`data/layouts/*.json`, `fp-layout v1`, made by `scripts/layout-gen.ts`):
- An ASCII grid with one character per 1.5 m cell:

  | Char | Meaning | Char | Meaning |
  |---|---|---|---|
  | `#` | rack (blocked; pick faces on aisle sides) | `P` | pick/pack station |
  | `.` | aisle (robots and people) | `C` | charger pocket |
  | `=` | wide aisle (forklifts allowed) | `K` | parking |
  | `D` | dock door | `X` | wall or column |
  | `S` | staging | `> < ^ v` | one-way hints (one-brain guidance only) |

- **Picking aisles are 2 cells wide; main aisles 3.**
- Also: `racks {levels, heightM}`, `zones[] {id, rect, vendor?}`, `crossings[]`, `name`, `areaM2`.
- Presets: `small` (8 aisles), `default` (14), `large` (22).
- The validator checks:
  - every pick face is reachable by AMRs and people
  - forklifts reach the docks and reserve racks
  - at least one charger per vendor

**§4 Scenario** (`data/scenarios/*.json`, `fp-scenario v1`):
```jsonc
{ "format":"fp-scenario","v":1,"id":"default","name":"Mid-size e-commerce DC","layout":"default","seed":42,
  "run":{"warmupMin":30,"measureMin":120,"batterySpread":true},
  "shift":{"hoursPerShift":8,"shiftsPerDay":2,"daysPerYear":300},
  "orders":{"mode":"demand","perHour":600,"linesPerOrder":{"mean":2.0,"max":8},"skuSkew":0.8},
  "pallets":{"replenishPerLines":40,"inboundPerHour":12},
  "pack":{"stations":6,"secPerOrder":45},
  "fleet":{"amr":24,"forklift":4,"humanoid":2,"picker":14,"driver":2},
  "vendors":{"amr":[{"id":"A","share":0.6},{"id":"D","share":0.4}],"forklift":[{"id":"B","share":1}],"humanoid":[{"id":"C","share":1}]},
  "traffic":{"mode":"central","silo":{"sensorCells":3,"waitTicks":5,"resetMin":5}},
  "economics":{"financing":"buy","baseline":"auto"},
  "events":[] }
```
- `orders.mode: "saturate"` keeps the queue always full and measures **capacity**.
- `traffic.mode` is `central`, `siloed` or (Phase 2) `shared-status`: the ISO 21423 level, where vendors see each other's next moves but don't plan jointly.
- The default scenario has **no events**. Events live only in stress scenarios: `breakdown` (Phase 1), plus `personInAisle`, `chargers`, `orderSurge` (Phase 2, Track I).
- Golden files add `"expect": {...}`.

**§5 Sim API** (`src/sim/index.ts`):
- `createSim(scenario, {agents, layout}) → Sim` with:
  - `tick`, `step(n)`
  - `command(c)`, applied at the next tick and logged with it
  - `snapshot()`, `drainEvents()`, `hash()`
- Commands:
  - `setFleet {type, vendor?, count}`: robots added at parking; removed ones finish their task first
  - `setOrderRate`, `setTraffic`, `inject {event}`
- Snapshot:
  - `agents[]`: `id, type, vendor, model, cell, to, moveStart, moveEnd, heading, state, goal, route (≤ 12 cells along the distance gradient), taskId, carrying, batteryPct, blockedTicks`
  - `tasks[] {id, kind, lines, stage, createdTick}`
  - `stats.ticksByState[type][state]`
  - `openOrders`, `shippedOrders`, `chargers[]`, `deadlocks[] {ids, sinceTick}`, `heat` (blocked ticks per cell)
- Events (all carry `tick`):
  - orders: `orderArrived`, `orderPacked`, `orderShipped`
  - work: `taskAssigned`, `pickDone`, `toteDelivered`
  - traffic: `jamStart/End`, `deadlockStart/End`, `manualReset`
  - power and faults: `chargeStart/End`, `breakdown/repair`, `personInAisle`
- **Lead-owned shared modules (Phase 0):**
  - `world.ts`: layout → graph, per-type passable cells, cached BFS distance maps
  - `detect.ts`: wait-for graph cycles = deadlocks; jams
- `TrafficController.plan(world, robotsAtBoundary, blockedCells, tick) → {moves, waitFor}`, implemented by `traffic/naive.ts` (lead stub), `central/` (B), `siloed/` (G).

**§6 Runner and KPIs:**
- `evaluate(settings, opts?) → RunResult`, with the RunResult carrying:
  - `kpis`, `capacityOph?`, `backlogTrend`, `keepsUp`
  - `byType {utilization, idle, blocked, charging}`
  - `upliftAchieved`, `resets`, `hash`, `simMs`
- Runs in a worker pool and in Node. `fp-sweep v1 = RunResult[]` plus axes.
- KPIs are measured over the measure window:

| KPI | Formula |
|---|---|
| Orders per hour (OPH) | shipped orders in window ÷ window hours (capped by demand by definition) |
| **Capacity OPH** | OPH with `orders.mode:"saturate"`. Used for the many-vs-one band, picker uplift, the sweep knee and overload tests. |
| Robot utilization | Σ productive robot ticks ÷ Σ robot ticks not broken. Productive = moving to or with a task, or task work. The tooltip breaks the rest into blocked, charging and idle (from `ticksByState`). |
| Jams per hour | jam starts ÷ hours. A jam = ≥ 3 agents stopped ≥ 20 ticks (10 s) within 5 cells. |
| Deadlocks per shift | wait-for cycles lasting ≥ 10 ticks (5 s) |
| Average order time | mean(ship tick − arrive tick) × 0.5 s; p90 in the tooltip |
| Backlog trend | slope of open orders. **Keeps up** = capacity ≥ demand and trend ≤ +5% of demand per hour (changed from +2% at Phase 1 integration; see PROTOCOL §6). |
| Cost per order | annual cost ÷ (OPH × hours per year) |
| Picker uplift | (units/h per picker with this fleet) ÷ (units/h per picker without picking robots: cart robots and humanoids 0, forklifts unchanged), both at capacity |

**§7 Cost model** (pure functions in `src/econ`, each returning `Explained = {value, unit, formula, inputs:[{label, value, unit, from:'source:<id>'|'estimate'|'sim'|'user'}]}`):
- `H` = hoursPerShift × shiftsPerDay × daysPerYear.
- **Labor/yr** = Σ people count × H × wage × (1 + laborLoad), plus resets (resets per hour × H × minPerReset ÷ 60 × supervisor wage).
- **Buy:** capex = Σ count × (buyUsd + integrationUsd). Robot opex/yr = Σ count × (buyUsd × maintPct + softwareUsdPerYear).
- **Rent (RaaS):** capex = Σ count × integrationUsd. Opex/yr = Σ count × raasUsdPerMonth × 12.
- **Annual cost** = labor + robot opex. **Savings/yr** S = annual cost(baseline) − annual cost(candidate).
- **Payback (months)** = capex ÷ (S ÷ 12).
  - "Never" if S ≤ 0.
  - **"Doesn't keep up"** instead of a number if the candidate doesn't keep up.
- **3-year net savings** = 3 × S − capex.
- **"Best mix" ranks by 3-year net savings** among fleets that keep up. Payback is not used for ranking, because rent always "pays back" instantly.
- Not modeled, listed in every money hover: taxes, depreciation, discounting, interest, residual value, building changes.

**§8 Seed rules:**
- A master `seed` (uint32) feeds SplitMix32, which derives named sfc32 streams: `arrivals`, `humans`, `faults`, `battery`, `tiebreak:<vendor>`, `physical`.
- **Arrivals:** exactly 4 draws from `arrivals` per tick, each compared to a rate threshold. This supports up to 28,800 orders/h, and rate changes never shift later draws.
- **Order contents** come from a counter-based function `orderLines(seed, n)`, so order #n is identical at any rate and any fleet (common random numbers).
- Same scenario + seed + command log ⇒ identical `hash()` in Node, Chromium, Firefox and WebKit.
- **Banned in `src/sim`, `src/kpi`, `src/econ`** (test-enforced):
  - `Math.random`, `Date`, `performance.now`
  - `Math.sin/cos/tan/exp/log/pow/atan2/hypot/sqrt`
  - non-integer state
  - unsorted `Set`/`Map` iteration in planning (sorts end with an agent-id tie-break)
- `tsconfig.sim.json` compiles those folders with `lib: ["ES2022"]` and no DOM, so a DOM or three import fails typecheck.

**§9 Render and UI interfaces** (lead, `render/core`, `ui/`):
- `createRenderer(canvas) → { roots{world,agents,fx}, addView(id, rect, camera), setTier(t), onFrame(cb), info() }`.
- Agent layer: `AgentLayer.update(prev, next, alpha, view)`.
- Camera rig: `overview()`, `follow(id)`, `flyTo(pose, ms)`, `pose()`.
- Bus events: `select {side, agentId|null}`, `tier`, `firstUsefulView`, `fullLook`.
- Asset manifest `public/assets/manifest.json`: model key → `{url, scale, offset, tris, bytes, license, credit, firstTier}`.
- Panel contract: `{id, slot: 'kpi'|'left'|'right'|'bottom'|'overlay'|'sheet', order, title, mount}`. On phones the shell turns the side slots into a bottom sheet with tabs.
- Quality tiers:

  | Tier | DPR | Effects |
  |---|---|---|
  | high | ≤ 2 | bloom, agent shadow map |
  | medium | 1.5 | ribbons, blob shadows |
  | low | 1 | far racks drop boxes, simple people |
  | Lite | 0.75 | no boxes beyond 20 m, live speed capped, badge shown |

  - Start low on touch and small screens.
  - Demote when p95 frame time > 20 ms over 2 s; promote when p95 < 12 ms over 5 s.
  - Frozen in tests.

**§10 Test hooks and URL params:**
- `window.__fp = { host, sims, runner, render:{info(), project(id)→{x,y}, pick(x,y)}, perf:{firstUsefulViewMs, fullLookMs, cpuMs(), gpuMs(), tier}, ready }`.
- `data-testid` on every tile and control.
- URL params: `?scenario=`, `?view=split`, `?demo=1`, `?perf=1` (overlay: fps, CPU and GPU ms, tier, GPU name), `?tier=`, `?seed=`, `?capture=1` (Phase 2a: `__fp.capture.step(frame)`).

**§11 Fixtures and fakes (so every track starts on day one):**
- `src/sim/fake.ts`: FakeSim with the same interface. Agents wander collision-free by construction and emit plausible events; routes and tasks are filled.
- `fixtures/snapshots-default.json`: 60 s of FakeSim.
- `fixtures/events-default.json`, `runresult.json`, `econ.json` (Explained samples), `sweep.json`.
- `src/sim/traffic/naive.ts`: a shortest-path stub that ignores collisions.
- `src/host/runner/fake.ts`: returns fixture RunResults instantly.

## 7. Phases

### Phase 0: Prove the risky parts, freeze contracts, ship a live skeleton (about 8 h)
**Goal:** every assumption the build rests on is measured, contracts are frozen, and a skeleton page is live.

**Lead steps**, each with its check:
1. **Access and setup:**
   - Push a test branch with the Spiro-12 token; the API shows push permission; `curl` reaches `spiro-12.github.io`.
   - Create `02-fleet-planner/` from `_template/`.
   - Save `PLAN.md`; write `RESEARCH.md` from the four reports. Check: every claim has a numbered source.
   - Add the **root README row** "02 Fleet Planner (building)".
   - Branch `p0`.
2. **Spike prerequisites** (about 30 min):
   - `layout-gen.ts`, default layout and scenario
   - `rng.ts`, `world.ts`
   - package.json and configs
3. **Launch the 3 spikes in one message** (worktrees, branches `p0-<letter>-<name>` off `p0`).
4. **While they run:**
   - contracts, validators
   - `agents.json` + `sources.json`, the other layouts and golden scenarios
   - `detect.ts`, FakeSim, naive traffic, fake runner, the real runner skeleton (worker pool + Node)
   - `render/core` (procedural floor, racks and boxes), perf overlay, Lite mode, context-lost card
   - app shell with slots, KPI tiles on fake data marked "demo data"
   - `window.__fp`
   - test infra: `npm run gate`, golden runner, `serve-gz.ts` (gzips like Pages), perf and shots scripts
   - `budgets.json`
5. **Measure with spike a's harness** after spike c finishes, with nothing else running. Fold the numbers into PROTOCOL.md and budgets.json, then freeze.
6. **CI and deploy:**
   - `fleet` CI job
   - `update-snapshots` workflow
   - Pages smoke test for 02, including a `curl --compressed` byte check
   - CLAUDE.md ship checklist names the fleet job
7. **Write the Phase 1 track briefs.**

**Spikes** (time-boxed about 2 h each; throwaway code; the output is numbers plus reusable bits):

| Spike | Proves | Pass |
|---|---|---|
| a `p0-a-render-spike` (5191) | Instanced world; 150 agents per side in split screen; ribbons; bloom; **40 people** (skinned vs instanced-part walk, pick the cheaper). Builds the perf harness. | The harness reports the GPU as Apple/Metal (not SwiftShader), the page visible, the refresh rate, CPU ms per frame, and GPU ms via timer query. Mac split screen: CPU+GPU p95 ≤ 16.7 ms, ≤ 150 draw calls. 3 runs agree within 5%. Phone emulation is a smoke check only. |
| b `p0-b-traffic-spike` (5193) | PIBT central + per-vendor siloed with the recovery ladder on the **real default layout and vendor mix** (2 AMR vendors + forklifts + humanoids + people as cell agents). Times greedy and capped Hungarian assignment. | One brain ≤ 0.1 ms/tick and many brains ≤ 0.2 ms/tick at 150 agents. 8 h shift ≤ 10 s in Node. **Capacity OPH** for many brains 10 to 40% below one brain. Deadlocks clear ≤ 2 min, no permanent gridlock in 8 h. People and robots pass in 2-cell aisles. Node hash equals the Chromium, Firefox and WebKit hashes. |
| c `p0-c-asset-spike` (5192) | Pin the dataset revision; download, decimate and compress the shortlist with gltf-transform. Build the code-made AMR, the autonomous forklift dressing and the humanoid. Try the Quaternius worker. | Every asset within its triangle budget: forklift ≤ 15k, humanoid ≤ 10k, worker ≤ 15k, rack bay ≤ 2k, box ≤ 50 at far LOD, pallet ≤ 300. Sizes gzipped: first tier ≤ 4 MB, all ≤ 15 MB, phone ≤ 2 MB. CC BY 4.0 or CC0 only, forklift decals clean. A visual reviewer passes a contact sheet against the reference frames and judges whether the worker and humanoid match the SimReady look (if not, the Sketchfab option in section 13). |

**If a spike fails twice:**
- a: lower agent caps; medium tier by default.
- b: tune the ladder or narrow the mechanisms; report the real gap honestly.
- c: procedural look plus a few hero models.

The **10 to 40% band is our judgment, not a sourced number**: no public data measures mixed-fleet throughput loss. The UI labels it so.

**What Spiro will see:** a link that opens a dark warehouse floor with yellow lanes, gray racks of boxes, glowing dots moving down the aisles, and KPI tiles marked "demo data". It works on his phone.

**Gate 0** (section 9, scaled to what exists): typecheck (both configs), unit, FakeSim determinism, e2e (loads, canvas draws, agents move, no console errors), build base path, budgets (JS, first-view bytes, draw calls), reviewer, CI, local click-through, merge, live recheck, then Spiro's test. **PR #1.**

**Spiro test 0** (5 min):
1. On the Mac in Chrome, open the link and count to two: is the warehouse there? (yes/no)
2. On the iPhone, open the link with `?perf=1` and screenshot it after 30 s (it shows fps and detail level).
3. Drag around: smooth? (yes/no)

### Phase 1: P0 core, the warehouse that answers the question (about 16 h)
**Goal:** all P0 features live on the real sim. **Monday cut line:** central traffic, manual and AMR-assisted picking, humanoids picking at their own rate, greedy assignment, breakdown as the only fault, scripted forklift pallet moves (replenishment and inbound), packing with dwell, shipping. Hungarian assignment and the other faults move to Phase 2.

| Track | Owns | Builds | Done when |
|---|---|---|---|
| **A Sim core** | `src/sim/**` except the lead files, `traffic/`, `faults/` (beyond breakdown); `tests/unit/sim/**` | Order stream; task model (lines → tote → pack → ship; replenish and inbound pallets); manual cart picking and AMR-assisted zone picking (humanoids are pickers at their spec rate); greedy assignment; agent and human state machines with dwell times; people as cell agents with step-aside; battery (seeded spread) and charging; breakdown; live `setFleet`/`setOrderRate`; snapshot (routes, tasks, stats); events; `hash()` | Same seed twice ⇒ same hash, with integer state asserted. Little's law ±10%. 0 robots runs. Every event type tested. **Numeric checks on the naive stub; the lead re-runs them after B merges**: picker uplift 1.5 to 2.2x at default inputs; 8 h ≤ 10 s in Node. |
| **B Traffic (one brain)** | `src/sim/traffic/central/**`, `tests/unit/traffic/**` | PIBT with committed multi-tick moves, per-type passability, forklift safety cell, charger pockets, one-way guidance, people's cells as obstacles. Returns `{moves, waitFor}`. | Property tests over 50 seeds × 10k ticks: never two agents in a cell, no swaps, no forklift in a narrow aisle, never into a person's cell. ≤ 0.1 ms/tick at 150. 0 deadlocks in an 8 h default shift. |
| **C KPI + economics** | `src/kpi/**`, `src/econ/**`, tests | KPI calculator (events + `ticksByState` → §6); cost model §7 returning `Explained`; baseline auto-size search on the runner interface (against the fake runner); keeps-up flag; best-mix ranking | Sanity tests: People only ⇒ robot cost exactly $0; RaaS capex = integration only; S ≤ 0 ⇒ "never"; not keeping up ⇒ "doesn't keep up"; more robots never lowers robot cost; higher wage ⇒ larger savings; every `Explained` input has a `from`. |
| **D World + assets + credits** | `src/render/world/**`, `scripts/assets/**`, `public/assets/**`, `CREDITS.md`, `ui/panels/about.tsx`; port 5201 | Floor (dark gloss, yellow lanes, painted "PICK AND PACK", "SHIPPING", "CHARGING"); instanced racks with boxes and pallets; dock doors and trailers; pack stations; static conveyors; chargers; walls, trusses, lights; baked contact shadows; procedural then GLB swap; tiers; **in-app About and credits** read from the manifest | Draw calls and triangles within budget at fixed cameras. Every shipped asset appears in About and CREDITS.md. Overview and aisle screenshots pass visual review. |
| **E Agents + camera** | `src/render/agents/**`, `camera/**`, `fx/**`; port 5202 | Models per type and vendor (instanced rigid parts; people per spike a's choice); interpolation; visible cargo; glowing route ribbons from `route`; blocked rings; red deadlock arrows with a timer; click or tap → smooth follow → pull out; hover tooltip | e2e: click an agent ⇒ follow + `select`. Draw calls within budget with 150 agents. |
| **F UI panels** | `src/ui/panels/{kpi,money,fleet,follow,time,scenario}*`, `src/ui/explain/**`, `tests/e2e/ui-*`; port 5203 | KPI tiles from RunResult with "recalculating"; live strip; money panel (buy/rent, wage, shifts, fleet cost, labor cost, payback, 3-year savings, baseline crew) where **every number hovers to formula + inputs + sources + "estimate" badges**; fleet controls (count per type, order volume, **"People only" button**); follow card (type, vendor, task, battery, task timeline); time controls (pause, 1x/10x/60x); scenario picker (small/default/large); phone bottom sheet | e2e on FakeSim + fake runner: each control sends the right command or settings; hover shows formula and sources; phone layout screenshot reviewed. |

Tracks report draw calls, triangles and correctness only. **All fps, load-time and sweep-time numbers are measured by the lead at the gate**, with nothing else running.

**Lead integration:**
- Merge order: C → B → A → D → E → F.
- Re-run A's numeric checks on real traffic.
- Wire runner + live sim + panels. Calibrate the default scenario so the uplift and capacity are realistic. Set the golden ranges.
- Write the P0 e2e flows on the real sim, then run Gate 1. **PR #2.**

**What Spiro will see:**
- A realistic warehouse where robots, forklifts, humanoids and people pick, pack and ship orders.
- KPI tiles, and a money panel that says when the robots pay back, with every number explaining itself on hover.
- Robot counts change live; clicking a robot follows it.

**Spiro test 1** (10 min, Mac then phone):
1. Press "People only". The money panel's robot cost shows $0. Send a screenshot.
2. Set Cart robots to 30 and hover the payback number. Does the explanation make sense to you as a business person? (yes/no plus one sentence)
3. Click a forklift: the camera follows it. (yes/no)
4. On the phone, tap a robot: its card shows. Send a screenshot.

### Phase 2: P1, many brains vs one brain, plus the business tools (about 16 h)
**Phase 2a (lead, about 1 h) bumps the contracts first:**
- `host.sims[]` (two live sims), compare API
- `fp-sweep v1` axes
- `fp-demo v1` (steps: camera pose, caption, host command, duration)
- stub host commands `showSplit` / `runStress` / `runSweep`
- the capture hook
- the `shared-status` traffic level, the stress scenario list
- ownership of `src/sim/faults/**` moves to Track I

| Track | Owns | Builds | Done when |
|---|---|---|---|
| **G Many brains** | `src/sim/traffic/siloed/**`, tests | Per-vendor PIBT; physical conflict layer; recovery ladder (detour, step aside, manual reset with supervisor minutes); first-come zone locks at crossings, docks and chargers (VDA 5050 RELEASE style); per-vendor job queues and chargers; `shared-status` level. Also capped Hungarian (64×64) for one brain. Mechanisms cite RESEARCH.md. | Default fleet: many-brains capacity 10 to 40% below one brain, `shared-status` in between. Deadlocks recover. ≤ 0.2 ms/tick. Node and browser hashes equal. |
| **H Split screen + compare** | `src/render/split/**`, `ui/panels/compare*`; port 5211 | Two sims on the same seed; one renderer, two scissor viewports (stacked on phones); synced cameras (follow the same robot id on both sides); labels; delta bar from two RunResults (capacity, OPH, jams, idle, payback); wait heatmap; "why the difference" explainer | e2e: both views render; delta values equal the two RunResults. Draw calls within budget. |
| **I Stress tests** | `src/sim/faults/**`, `data/scenarios/stress-*.json`, `ui/panels/stress*`, `tests/golden/stress-*`; port 5212 | Faults: person in aisle, chargers, order surge. One-click Black Friday (3x orders), robot breakdown, too few chargers, person walks into an aisle; each with an on-screen story and its expected outcome. | Each stress golden passes. e2e: one click runs each one and its caption shows. |
| **J Fleet sweep** | `src/host/sweep/**`, `ui/panels/sweep*`, `scripts/sweep-cli.ts`; port 5213 | Grid over 1 to 2 types on the runner pool; results stream into a uPlot chart (capacity and 3-year savings vs fleet size, one brain and many brains curves); knee (marginal capacity gain < 2% per added robot); best mix (§7); CLI table | Knee found on a synthetic curve. Past saturation, capacity stays flat ±3%. Same seed ⇒ same table. |
| **K Sales demo** | `src/demo/**`, `data/demo/*.json`; port 5214 | A 2 minute story via the stub host commands: people only today → add robots → payback → Black Friday → many brains vs one brain → "show me my building". Camera moves, sound-off captions, play/pause/skip, `?demo=1` | e2e plays every beat in ≤ 125 s at 1x with no errors, on stubs, then again after H and I merge. A screenshot per beat passes review. |

**Lead integration:**
- Merge order: G → I → J → H → K.
- Write `RESULTS.md`: honest one-vs-many numbers, every assumption, the sweep knee.
- Measure the sweep: 20 runs ≤ 60 s.
- Update the golden files, run Gate 2. **PR #3.**

**What Spiro will see:** the split screen, a one-click stress menu, a "find the best mix" chart, and a 2 minute sales demo.

**Spiro test 2** (10 min):
1. On the Mac, open `?demo=1` with the sound off. Would a customer say "show me that for my building"? (yes/no, plus the second where it got slow)
2. Open the split screen on the phone and send a screenshot.
3. Run Black Friday. Is the backlog story clear? (yes/no)

### Phase 3: P2 and ship (about 10 h)
L, M and N start together; N finishes last.

| Track | Owns | Builds | Done when |
|---|---|---|---|
| **L AI consultant** (only if Spiro approves the cost and accounts; else skipped) | `proxy/**`, `ui/panels/consultant*`; port 5221 | A Cloudflare Worker that holds the API key as a secret, locks CORS to `spiro-12.github.io`, rate-limits per IP and caps tokens. Plain words → Claude returns a scenario (checked by our validator) → sweep → Claude writes a one-page recommendation from the results. Hidden when no proxy is configured. | e2e passes against a mock proxy. A live call works. The app passes every other gate with the proxy off. |
| **M Owner report** | `src/report/**`; port 5222 | One printable page (US Letter and A4): building, recommended fleet, payback, 3-year savings, KPIs, one vs many brains, assumptions and sources, floor snapshot | e2e: print-to-PDF gives exactly 1 page, and every number equals the on-screen RunResult. |
| **N Docs + media** | 02 `README.md`, final root README row, `CREDITS.md` review, `media/**`, `scripts/capture-clip.ts`; port 5223 | README from the template (hook, live link, GIF, what/why/how, why-now with footnotes, NVIDIA credit). Demo GIF ≤ 8 MB. A 30 s side-by-side clip, 1920×1080 plus a 1080×1920 stacked version, captured frame by frame via the capture hook (WebCodecs + Mediabunny; ffmpeg polish; installed Chrome if bundled Chromium lacks H.264). | Clip is exactly 1,800 frames at a constant 60 fps. All README links and the GIF load. Credits complete. |

**What Spiro will see:** the finished README and project page, a demo GIF, a 30 s clip ready to post, a printable owner report, and (if approved) "describe your warehouse" consulting.

**Spiro test 3:**
1. Print the owner report to PDF and send it.
2. Watch the 30 s clip: reply "post it" or what to change. He posts it himself.
3. If L ships: type one sentence about a real warehouse he knows and send a screenshot of the recommendation.

## 8. Tracks: rules, worktrees, ports
- **One agent per track**, spawned with `isolation: "worktree"`, branch `p<phase>-<letter>-<name>` off `p<phase>`, owning only its files.
- **Independent tracks launch together in one message:** 3 spikes, 6 Phase 1 tracks, 5 Phase 2 tracks, 3 Phase 3 tracks.
- **Every brief** (`02-fleet-planner/tracks/`) is self-contained:
  - goal, owned files, read-only interfaces, what to build, which fakes to build against
  - its gate command, the budgets it must meet
  - the push command with the `GH_TOKEN=$(gh auth token -u Spiro-12)` prefix
  - the final report format: what was built, numbers vs budgets, what the lead must check, contract change requests
- **One command per track:** `E2E_WEB_PORT=<port> npm run gate` runs both typechecks, unit, golden, e2e on that port (served gzipped by `serve-gz.ts`) and build. Visual diffs are report-only in track gates.
- **Ports** (never project 01's 4173, 42xx, 43xx, 8765 or 18xxx):

  | Who | E2E_WEB_PORT |
  |---|---|
  | lead | 5180 |
  | spikes a / c / b | 5191 / 5192 / 5193 |
  | D / E / F | 5201 / 5202 / 5203 |
  | H / I / J / K | 5211 / 5212 / 5213 / 5214 |
  | L / M / N | 5221 / 5222 / 5223 |

  Unit-only tracks (A, B, C, G) use no port.
- Track agents never push to `main`, never open PRs and never merge. The lead does.

## 9. The test gate (after every phase; nothing moves on until it's all green)
1. **Author gate:** `npm run gate`:
   - typecheck (app + sim purity)
   - unit (sim core, traffic properties, cost math, KPIs, validators, banned-API test, source check)
   - Playwright e2e:
     - page loads
     - controls change KPIs
     - People only ⇒ $0 robot cost
     - follow camera
     - split screen, sweep, demo, report (once they exist)
   - build with base `/weekend-projects/02-fleet-planner/` (grep `dist/index.html`)
2. **Golden scenarios** (`tests/golden/*.json`, fixed seeds, checked in, all via `evaluate()`):

   | Golden | Expected |
   |---|---|
   | `default-central` | OPH = demand (keeps up); capacity in its calibrated band ±8%; 0 deadlocks; uplift 1.5 to 2.2x |
   | `zero-robots` | the auto-sized baseline crew: robot cost exactly $0; keeps up |
   | `overload` | orders = 3 × measured capacity ⇒ backlog grows every hour; "doesn't keep up" |
   | `saturation` | AMRs 4 → 60, capacity rises then stays flat ±3% past the knee; cost per order rises past the knee |
   | `silo-vs-central` (Phase 2+) | many-brains capacity 10 to 40% lower; more jams |
   | `stress-*` (Phase 2+) | each in its own range |

   **Determinism:** CI checks that Chromium, Firefox and WebKit hashes equal the Node hash for the same 1 h run. A hash is pinned only at the end of a phase, so parallel sim tracks don't fight over it.
3. **Performance** (`npm run perf`, lead only, nothing else running, `caffeinate -d`):
   - **On Spiro's Mac:**
     - Harness asserts: GPU is Apple/Metal, the page is visible, the refresh rate is logged.
     - CPU ms per frame + GPU timer-query ms over a scripted camera tour.
     - Default fleet, then max fleet, then split screen.
   - **Load timing:** against `serve-gz.ts` with CDP throttling (20 Mbps, 40 ms RTT).
   - **Phone:** emulation is a smoke check only; the real phone gate is Spiro's iPhone `?perf=1` screenshot.
   - **In CI (no GPU):** draw calls, triangles, gzipped bytes, sim ms/tick (×3 slack), a memory-leak check.
   - **After deploy:** `curl --compressed` byte check on the live first-view files.
4. **Visual check** (`npm run shots`):
   - Six views at a frozen tick, fixed cameras and tier: overview, follow cam in an aisle, pick/pack, split screen, money hover, phone.
   - CI compares against Linux baselines at 1% tolerance. Baselines are refreshed once per phase after integration: the `update-snapshots` workflow runs, the lead `gh run download`s them and commits.
   - A fresh **visual-reviewer agent** compares a contact sheet against reference frames, with a checklist: dark floor, yellow lanes, boxes on racks, glowing routes, KPI tiles, readable text, consistent materials.
   - Reference frames stay local, never committed (other people's videos).
5. **Code review:** a **fresh reviewer agent** that wrote none of the code reviews each track branch and then the integrated phase diff, at **high effort**. It gets only the brief, PROTOCOL.md and the diff (not the author's summary). Fix and re-review until it says SHIP.
6. **GitHub CI green:** the repo's `site` job plus the new `fleet` job. (Silent Speech moved to its own repo on 8 Nov, so the old web, Mac and Python jobs are gone.)
7. **Claude checks it for real:**
   - Before merge: click through every P0/P1 flow on the local gzipped `dist/` under the base path, with screenshots.
   - After deploy: the same on the live URL.
8. **Spiro's real-life test** (script per phase). A reported problem gets fixed, and the gate reruns, before the next phase.

**Budgets** (`budgets.json`; spikes may tighten them, never loosen them without saying why in RESULTS.md):

| Budget | Value | Checked |
|---|---|---|
| Initial JS | ≤ 300 KB gz | CI |
| First useful view (procedural floor and racks, agents moving, KPI numbers) | ≤ 0.4 MB, on screen ≤ 2 s at 20 Mbps / 40 ms RTT | Mac + live |
| Full first-tier look (SimReady models, workers) | ≤ 4 MB gz, done ≤ 5 s throttled | Mac + live |
| All assets, high tier / phone low tier | ≤ 15 MB / ≤ 2 MB gz | CI |
| Frame time, default fleet (single view and split) | CPU+GPU p95 ≤ 16.7 ms | Mac |
| Frame time, max fleet (150 per side) | p95 ≤ 25 ms | Mac |
| Phone | ≥ 30 fps low tier on Spiro's iPhone (`?perf=1`) | Spiro |
| Draw calls / triangles | ≤ 150 / 2.5M laptop (both views); ≤ 60 / 500k phone | CI |
| Sim speed | one brain ≤ 0.1 ms/tick, many brains ≤ 0.2 ms/tick at 150 agents; 8 h ≤ 10 s in Node | CI (×3) + Mac |
| Runner | one evaluate (2.5 sim-h) ≤ 2 s in a browser worker | Mac |
| Sweep | 20 runs ≤ 60 s in the browser | Mac |

**Agent counts:** the default is about 60 robots + people per side on a laptop, 150 max. Phone default is ≤ 40; above 60, phones switch to simple meshes with a "lighter view" note. Below the low tier, Lite mode. A lost WebGL context shows a friendly reload card.

## 10. CI and deploy changes
- **`ci.yml`:** new job `fleet`, "Fleet Planner (typecheck, unit, golden, e2e, build)": `working-directory: 02-fleet-planner`, Node 22, npm cache on the 02 lockfile. Steps:
  1. `npm ci`
  2. Playwright chromium + firefox + webkit
  3. both typechecks, unit, golden
  4. hash equality across the 4 engines
  5. e2e (Chromium)
  6. budgets (bytes, draw calls, sim bench)
  7. visual compare
  8. `./scripts/build-site.sh && test -f _site/02-fleet-planner/index.html` plus a base-path grep

  Screenshots and diffs upload as an artifact on failure.
- **`update-snapshots.yml`** (`workflow_dispatch`): renders the visual baselines on Linux and uploads them.
- **The existing `site` job stays as it is.** It already builds every project, so it now builds 02 too. CI runs on pull requests (and by hand), not on branch pushes.
- `scripts/build-site.sh` needs no change (02 builds into `dist/` via `outDir: '../dist'`).
- **`pages.yml`:** the smoke test (which still checks 01's forwarding page) also checks that `/weekend-projects/02-fleet-planner/` serves this build's hashed entry, and does a `curl --compressed` size check on the first-view files.
- **Root `CLAUDE.md`:** checklist item 3 names the `fleet` job.
- **Root README:** row added in Phase 0 marked "(building)", finalized in Phase 3.

## 11. Shipping (every phase)
- One PR per phase, `p<N>` → `main`, through the CLAUDE.md ship checklist (section 9).
- Merge: `GH_TOKEN=$(gh auth token -u Spiro-12) gh api repos/Spiro-12/weekend-projects/pulls/N/merge -X PUT`.
- After the Pages deploy, rerun the click-through and byte check on the live URL.
- Then send Spiro a plain-English update (7th grade, no jargon): what changed, what he can see, the one thing he needs to do (his test script).

## 12. Risks and fallbacks
| Risk | Fallback |
|---|---|
| SimReady GLBs are huge (up to 5.57M triangles, 321 draw calls per asset) | Decimate to per-asset budgets; else procedural, with SimReady only for hero items |
| No people, humanoid or AMR in SimReady; outside models may not match its look | AMR and humanoid built in code. Quaternius CC0 worker first; Renderpeople (Spiro's Sketchfab sign-in) if needed; last resort clean capsule people. The visual reviewer judges. |
| Tall racks, docks, trailers, floor paint missing from the set | Built in code, styled to match under the same environment lighting |
| Hugging Face dataset changes under us | Pinned revision; self-hosted copies |
| Many brains gridlocks (naive: 96 to 98% idle) or the gap looks fake | Recovery ladder required; tuned into the band; "how smart are vendors' robots" settings; mechanisms cited; band labeled as judgment |
| Many-brains detour search slow (0.3 to 1.2 ms/tick) | Bounded local A* or cached detours; else cap live speed in split screen |
| One-vs-many gap invisible because OPH is capped by demand | Compare **capacity** (saturate mode), not demand-capped OPH |
| Grid rounding distorts speeds and labor vs robot comparison | mm-per-tick carried remainder; 1% speed test |
| People vs robots head-on in 1-cell aisles | 2-cell picking aisles; people step aside after 4 ticks |
| Phase 1 too big for the weekend | Monday cut line (section 7); Hungarian and extra faults moved to Phase 2 |
| Real fps can't be measured in CI; ProMotion or a sleeping Mac skews the numbers | CPU+GPU timer measurement on the Mac with GPU, visibility and refresh checks and `caffeinate`; CI checks draw calls, triangles and bytes |
| `vite preview` doesn't gzip like Pages | `serve-gz.ts` for local tests; live `curl --compressed` check after deploy |
| WebGL screenshots differ by machine; baselines churn | Linux-only diffs, frozen tick, camera and tier; baselines refreshed once per phase via workflow |
| Results differ across browsers | Integer-only sim, integer assert in `hash()`, banned-API test, 4-engine hash equality in CI |
| Specs or prices not public (humanoids especially) | Estimates with reasoning and ranges, editable; RESEARCH.md lists the weakest |
| Phones too slow, or iOS drops the WebGL context | Low tier on touch devices, Lite mode, reload card |
| Bundled Chromium can't encode H.264 for the clip | Installed Chrome, or VP9 + ffmpeg |
| Repo grows with assets | Optimized assets only (≤ 15 MB); pipeline reproduces them from the pinned revision |
| Asset license doubt | Checked per asset; only CC BY 4.0 / CC0 ships; credits in the app, README and CREDITS.md |
| Active `gh` account is read-only | Spiro-12 token per command; proven in Phase 0 step 1 |
| Scope creep | P2 only after P0/P1 ship; AI consultant optional |

## 13. Decisions made (so Spiro doesn't have to), and what only Spiro can answer
**Decided:**
- Stack, sim model, numbers pipeline, payback method and theme: section 4.
- Generic vendors (A to D), with real products only as "based on".
- **US units and dollars on screen, metric inside.**
- **Default building:** a mid-size e-commerce DC with 14 aisles. Small and large presets.
- The 10 to 40% believability band is our judgment, labeled in the UI.
- No analytics or cookies.

**Only Spiro can answer:**
1. **AI consultant (P2): OK to spend money on the Claude API?**
   - Estimate: a few cents per consult; a $10/month cap covers a few hundred.
   - He creates an Anthropic API key with a spend limit and a free Cloudflare account.
   - He pastes the key into the Cloudflare dashboard himself, following a click script, so the key never goes through chat, the repo or the browser.
   - Claude deploys the worker after he clicks "Allow" on `wrangler login`.
   - Asked at the start of Phase 3. If no, the app ships without it.
2. **Posting the clip:** he approves it and posts it himself. We prepare captions.
3. **Sketchfab sign-in (only if needed):** if the free no-account worker model looks off next to SimReady, Spiro signs in to (or creates) a free Sketchfab account once in the Claude app's browser pane. That gets the photoreal CC BY worker. Not blocking.

## 14. Timeline (agent wall-clock time; tracks run in parallel)
- **Weekend version, P0 core live by Tue 10 Nov:**
  - Phase 0: about 8 h (Sun 8 Nov), then Spiro test 0 (5 min).
  - Phase 1: about 16 h (Mon 9 to Tue 10 Nov), then Spiro test 1 (10 min).
- **Full week:**
  - Phase 2: about 16 h (Wed 11 to Thu 12 Nov), then Spiro test 2.
  - Phase 3: about 10 h (Fri 13 Nov), then Spiro test 3.
  - The clip is ready for him to post Sat 14 Nov.
- Execution only stops between phases if a gate fails twice, something only Spiro can give is needed, or a decision would change scope.

## 15. Done means
- [ ] README from the template: hook, live link, demo GIF, what/why/how, why-now with sources, NVIDIA SimReady credit
- [ ] Root README row final (added in Phase 0)
- [ ] NVIDIA and per-asset credits in the app's About panel, README and CREDITS.md
- [ ] `media/demo.gif` and a 30 s side-by-side "many brains vs one brain" clip (landscape + vertical)
- [ ] All P0 and P1 features live and passing the gate; P2 report shipped; AI consultant shipped or explicitly skipped by Spiro
- [ ] RESULTS.md with honest numbers and every assumption

## 16. Improvements over project 01's process
1. **Spikes before contracts freeze.** In 01, the real AirPods rate showed up after the freeze and forced contract changes.
2. **Sim purity enforced by tooling** (no-DOM tsconfig, banned-API test, integer assert in `hash()`), not by review.
3. **FakeSim, fake runner and recorded fixtures**, so render and UI tracks never wait.
4. **One runner for all numbers**, so tiles, money, compare, sweep and golden tests can't disagree.
5. **Budgets in `budgets.json`, checked by scripts.** Perf is measured only by the lead, with nothing else running.
6. **Golden scenarios plus 4-engine hash equality from Phase 0.** Hashes pinned only at phase end.
7. **One `npm run gate` per track**, gzip-served like Pages.
8. **Unanchored reviewers:** brief, PROTOCOL and diff only.
9. **Planned "phase a" contract bump** (01 did this ad hoc).
10. **Spiro's first real test at the end of Phase 0**, including the phone.

## 17. First steps after approval
1. Copy this plan to `02-fleet-planner/PLAN.md`.
2. Build `02-fleet-planner/RESEARCH.md` from the four research reports. Plan mode blocked writing them into the repo; they're saved with full source lists at `~/.claude/plans/glimmering-swinging-beacon-agent-{a5f2b2b41fb071e91 (specs), a0ec879cf7f6fa0e6 (assets), ae8bf95cbb44f6795 (tech), a408dd5ad76062c3f (market)}.md`.
3. Then run Phase 0 from step 1.

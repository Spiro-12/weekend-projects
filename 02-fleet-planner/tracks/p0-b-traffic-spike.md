# Spike b: traffic (one brain vs many brains), branch `p0-b-traffic-spike`, port 5193

## Why
The hero feature is "many brains vs one brain": the same warehouse, robots and orders. On one side each robot vendor runs its own traffic control; on the other one orchestrator plans everything. Before contracts freeze, we must prove three things:
1. Real multi-agent traffic is fast enough in JS.
2. The gap between the two modes is believable.
3. Results are bit-identical across JS engines.

Research found the algorithm and the trap: PLAN.md §3c and RESEARCH.md Part C §2 and §3 (read both).

## Read-only inputs
- `src/sim/rng.ts` (seeded streams)
- `src/sim/world.ts` (graph, pass classes, pockets, faces, stations, `DistanceCache`)
- `data/layouts/default.json`, `data/scenarios/default.json`
- `src/contracts/types.ts` (draft contracts)

## You own
`spikes/b-traffic/**` only. Throwaway prototype quality is fine; clear code helps Track B reuse it.

## Model to prototype
- **Time and space:** tick = 0.5 s, cell = 1.5 m.
- **Speed:** mm per tick with a carried remainder. Each agent accumulates `speedMmPerTick` per tick and moves one cell each time it has ≥ 1500 mm. Average speed is exact; while moving it holds both cells. Speeds in shared aisles:

  | Agent | Speed | mm/tick |
  |---|---|---|
  | AMR | 1.0 m/s | 500 |
  | Forklift | 1.0 m/s | 500 |
  | Humanoid | 0.8 m/s | 400 |
  | Picker | 1.0 m/s | 500 |
  | Driver | 1.34 m/s | 670 |

  Add a turn cost: AMR +1 tick per 90°, forklift +2.
- **Agents:** the default scenario fleet:
  - 24 AMRs: vendor A 60%, vendor D 40%
  - 4 forklifts (vendor B), 2 humanoids (vendor C)
  - 14 pickers, 2 drivers

  Also scaled fleets of about 60, 100 and 150 robots (same vendor mix), with people scaled too.
- **Pass classes from `world.passable`:** small (AMR, humanoid), forklift (forklift-rated `=`/`S` cells only), human. Charger and parking pockets are entered only as a goal. Forklifts keep one safety cell ahead clear while moving.
- **People are cell agents, not in the robot planner.**
  - Each person follows the `DistanceCache` 'human' gradient.
  - Robots treat people's cells (and the cell a person is moving into) as fixed obstacles each tick.
  - A person blocked 4 ticks steps aside to a free neighbour cell.
  - People never enter a cell a robot holds.
- **Work (simplified):**
  - Robots and people loop: go to a random pick face (`world.faces`, 80% of picks on the closest 20% of faces), dwell 10 ticks, go to a random pack station service cell, dwell 4 ticks.
  - Forklifts loop between dock staging cells and random faces.
  - Robots below a battery threshold go to a charger pocket of their class (vendor-owned in many brains, shared in one brain).
  - Measure **capacity**: tasks completed per hour with an always-full queue.
- **One brain:**
  - one PIBT (Okumura et al.) over all robots of every vendor, with committed multi-tick moves; only agents at a cell boundary are planned
  - priority = ticks since last goal + seeded tie-break
  - greedy nearest-idle assignment
- **Many brains:** one PIBT per vendor over its own robots only.
  - **Foreign robots** are obstacles seen within `sensorCells` (3). Their intentions are unknown, and they can't be pushed.
  - **Physical layer:** when two vendors claim the same free cell, one seeded-random winner moves and the others safety-stop.
  - **Recovery ladder** (required; without it the research saw 96 to 98% idle):
    1. every `waitTicks` (5) blocked: a bounded local detour that treats foreign robots within 3 cells as walls
    2. every 4 × `waitTicks`: a seeded random step aside
    3. stuck ≥ `resetMin` (5 min): a "manual reset" event that moves the robot to the nearest free cell (counted; it costs supervisor time later)
  - Per-vendor job queues and chargers.
  - Optionally, first-come zone locks at aisle ends (one robot per lock).
- **Deadlock detection:** wait-for graph (`a → b` if a is stopped and its preferred next cell is held by b). A cycle that persists ≥ 10 ticks is a deadlock; record count and max duration.

## Measure (write `spikes/b-traffic/RESULTS.md` with a table)
1. **Speed:** ms per tick (mean and p95) at about 60, 100 and 150 robots for both modes, in Node on this Mac. Simulated 8 h shift wall time. Budget: one brain ≤ 0.1 ms/tick, many brains ≤ 0.2 ms/tick at 150; 8 h ≤ 10 s.
2. **The gap:** capacity (tasks/h) one brain vs many brains at the default fleet and at 60/100/150, plus idle %, blocked %, jams, deadlocks (count, max duration), manual resets per hour. **Target: many brains 10 to 40% below one brain at the default fleet** with sensible ladder settings. Report which knobs move the gap and suggest defaults. If you can't get into the band honestly, say so and why.
3. **No permanent gridlock** in an 8 h run in either mode, and deadlocks clear in ≤ 2 min.
4. **People:** in 2-cell aisles people and robots pass. Count person step-asides; assert no robot ever enters a person's cell, and never two agents in one cell, in either mode (check every tick).
5. **Assignment cost:** greedy vs Hungarian/Jonker-Volgenant at 16×16, 64×64 and 150×150, called every 10 ticks over 8 h. Recommend the default and a cap.
6. **Cross-engine determinism:** bundle the prototype for the browser (esbuild via `npx vite build` of a small entry in `spikes/b-traffic/`, or `tsx`-free ESM). Run the same 1 h one-brain and many-brains scenario in Node, and through Playwright in Chromium, Firefox and WebKit (`page.evaluate`, browsers already installed). Hash the final integer state (FNV-1a). **All four hashes must be equal per mode.** Assert every state number is an integer.
7. **Recommendation for the contracts:**
   - Is 0.5 s / 1.5 m right?
   - The `TrafficController` interface shape: what the planner needs from the sim core, and what it returns (moves, waitFor, anything else).
   - Default `silo` knob values.
   - Anything in `src/contracts/types.ts` that should change.

## Done when
`RESULTS.md` has every number above, the tests in `spikes/b-traffic/` (vitest or a tsx script) pass, the work is committed on your branch, and your final report summarizes the results table and the contract recommendations. Time box: about 2 hours of work; report what you have if you hit it.

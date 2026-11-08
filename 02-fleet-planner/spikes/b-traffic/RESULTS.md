# Spike b results: traffic, one brain vs many brains

Measured 2026-11-08 on Spiro's M2 MacBook Air, Node 26.7, while spikes a and c (and some of my own background runs)
used the same Mac, so timings are noisy and the lead should re-measure at the gate. Setup: the default layout
(62 × 34 cells, 14 aisles, 6 pack stations) and the default scenario fleet (24 AMRs, vendor A 60% / D 40%;
4 forklifts B; 2 humanoids C; 14 pickers; 2 drivers). Always-full queue, 8 h shifts with a 30 min warm-up, seeds 42 and
up. "One / many" means one brain / many brains.

## TL;DR

| Question | Answer |
|---|---|
| Fast enough in JS? | **The planner is.** At 150 robots plus 80 people the traffic controller costs **0.04 to 0.09 ms/tick** in both modes, and every 8 h shift runs in **≤ 8 s**. The whole tick at 150 is 0.13 to 0.14 ms (p95 0.16 to 0.18), which is over the one-brain 0.1 budget. That is because my naive O(n²) jam clustering takes up to 0.12 ms once the warehouse gridlocks (§1). |
| Believable gap at the default fleet? | **11.6%** pick-robot capacity (692 → 612 tasks/h, 6 seeds × 8 h) with the recommended knobs. That's inside the 10 to 40% band, but at its bottom edge. **One knob drives it**: the vendors' job timeout `retaskMin` (1 min → 8%, 1.5 → 12%, 2 → 21%, off → 29%), then `waitTicks`. Above about 15%, the extra loss is real gridlock (deadlocks over 2 min, a manual reset every few minutes), not slower driving. |
| Permanent gridlock? Deadlocks clear in ≤ 2 min? | **Default fleet: no permanent gridlock** in any 8 h run, either mode. One brain: 0.5 deadlocks/h, one over 2 min in 6 shifts (149 s, cause not traced). Many brains: 62 deadlocks/h, mean 12 s; **2 over 2 min in 45 h** (max 180 s); 0.1 manual resets/h, about 1 per shift. |
| People and robots pass in 2-cell aisles? | **Yes**: tests with 1 robot + 1 person head-on, and 3 + 3 crossing. About 2,000 to 2,400 person step-asides/h at the default fleet. **0 invariant violations** in every run reported here, checked every tick: no two agents in a cell, no robot into a person's cell, no person into a robot's cell. |
| Bit-identical across engines? | **Yes.** Node, Chromium 158, Firefox 159 and WebKit 27.2 give the same hash per mode for a 1 h run, and every state number is an integer. |
| Scaled fleets (60/100/150)? | **Not meaningful as specified.** The brief's loop has pickers carry totes to the six one-cell pack stations too, so the default layout saturates at about 30 robots in **both** modes: one brain falls from 687 to 316 pick tasks/h going from 30 to 60 robots. The large layout with pickers kept in pick zones saturates at about 60 robots. Past saturation the gap is 35 to 65% and it measures overload (§2c). |
| Keep 0.5 s / 1.5 m? | **Yes** (§7). |

## What I built, and what I had to add to the brief's model

Code is in `spikes/b-traffic/` (about 2,100 lines in `src/`). **`src/traffic.ts` is the part Tracks B and G can lift.**
- `src/traffic.ts`: causal PIBT, `CentralController` (one brain) and `SiloedController` (many brains: one PIBT per
  vendor, foreign robots as unpushable walls, a seeded physical layer for cross-vendor claims, the recovery ladder).
- `src/sim.ts`: the tick loop. People as cell agents, work loops, battery and chargers, deadlock and jam detection,
  per-tick invariant checks, an FNV-1a state hash.
- `src/detect.ts` (wait-for cycles, jams), `src/assign.ts` (greedy and optimal assignment), `src/config.ts` (specs,
  knobs, fleet scaling), `src/agent.ts`, `src/index.ts` (options from the scenario, `runShift`).
- `bench/`: `speed`, `gap`, `ladder` (knob sweep), `scale`, `diag`, `assign`, `cross-engine`. `browser/entry.ts` is
  the IIFE entry. `tests/traffic.test.ts` has 9 tests. Two tsconfigs: everything, and `src/` under the sim-purity
  rules (ES2022 only, no DOM, no Node).

**Built as briefed:**
- Time and space: tick 0.5 s, cell 1.5 m. Speeds in mm per tick with a carried remainder: AMR, forklift and picker
  500; humanoid 400; driver 670.
- Turn cost: AMR +1 tick per 90°, forklift +2. Moving agents hold both cells; forklifts also hold one safety cell
  ahead.
- Cells: pass classes from `world.passable`; pockets are entered only as a goal.
- People follow the `DistanceCache` 'human' gradient and step aside after 4 blocked ticks. Robots treat people's
  cells and move targets as fixed obstacles.
- Work loops: face dwell 10 ticks, pack dwell 4 ticks, 80% of picks on the closest 20% of faces; forklifts loop
  dock ↔ face (my assumption: 10-tick dwell at each end).
- Battery and chargers: vendor-owned in many brains, shared in one brain.
- One brain: PIBT priority = ticks since last goal plus a seeded tie-break; greedy nearest assignment.
- Many brains: per-vendor queues, the physical layer, the three ladder rungs.
- Detection: deadlock = wait-for cycle lasting ≥ 10 ticks; jam = ≥ 3 agents stopped ≥ 20 ticks within 5 cells.

**Model additions I needed.** Each fixes a failure I saw in the first runs. All apply to **both** modes unless noted,
so they don't bias the gap.

| # | Addition | What broke without it |
|---|---|---|
| 1 | **Causal PIBT.** An agent may only start a move into a cell nobody holds. Pushing still works, but the pusher waits for the cell to clear (Okumura's time-independent / causal PIBT). | Needed for "a moving agent holds both cells". As a side effect, followers keep one empty cell (1.5 m) of spacing. |
| 2 | **Local obstacle detours for every robot.** A robot blocked for `waitTicks` by something it can't negotiate with (a person or a parked robot) plans a bounded detour around it. Many brains also counts foreign robots as walls. | PIBT never picks a worse cell than staying put, so robots waited behind people and parked robots for ever. **One brain was 85% blocked.** |
| 3 | **Robots yield to people.** A person blocked by a robot pushes it through PIBT, with the person as the parent. | Person-robot standoffs at pack stations never ended. |
| 4 | People: step to the side, not back; two people head-on squeeze past each other (swap); wait for an agent that is already leaving the cell; don't crowd a busy goal (wait 2 cells back). | People-only gridlocks at stations, and a "sidewalk dance" where a robot and a person kept dodging to the same side. |
| 5 | **Robot cell claim.** A robot that has waited 3+ ticks claims the cell it wants, and people let it go first. | People plan first each tick, so a stream of people starved a waiting robot. This was the main source of one-brain resets. |
| 6 | Tie-break: stay out of the 1-wide pack lane (row 29) unless it is the goal, then prefer fewer turns. | On equal-distance ties, robots drove straight down an aisle into the pack lane and met everyone head-on there. |
| 7 | PIBT also pushes a robot out of a forklift's needed safety cell. | Two forklifts one cell apart, each blocked by the other's safety field, for ever. |
| 8 | **WMS pack-station balancing**: send each tote to the least-loaded station. The WMS is shared by both modes, so this isn't a traffic perk. | With random stations, a knot formed at one station and absorbed robots: many brains −73%, one brain −11%. |
| 9 | **Re-task rung (fleet-manager job timeout).** A robot with no progress for `retaskMin` gets another station or job. | Without it, many brains needs a manual reset every 2 minutes (29/h) and has 89 deadlocks over 2 min in 45 h. The gap is 29%, but that is mostly gridlock. This is the main gap knob. |

Not done: the brief's optional first-come zone locks at aisle ends.

## 1. Speed

Whole tick (people, traffic controller, deadlock and jam detection, bookkeeping), invariant checks off, default
layout, 3 runs × 8 h (57,600 ticks) per row. Mean and p95 are averaged over the runs (min to max in brackets).

| Mode | Robots (agents) | Mean ms/tick | p95 ms/tick | 8 h wall time | Budget |
|---|---|---|---|---|---|
| one brain | 30 (46) | 0.0095 (0.0087-0.0104) | 0.018 (0.015-0.020) | 0.55 s | ≤ 0.1 |
| many brains | 30 (46) | 0.0125 (0.0099-0.0168) | 0.025 (0.016-0.041) | 0.73 s | ≤ 0.2 |
| one brain | 60 (92) | 0.051 (0.048-0.054) | 0.077 (0.071-0.082) | 2.9 s | ≤ 0.1 |
| many brains | 60 (92) | 0.050 (0.049-0.051) | 0.070 (0.067-0.073) | 2.9 s | ≤ 0.2 |
| one brain | 100 (154) | 0.112 (0.108-0.117) | 0.158 (0.151-0.167) | 6.5 s | ≤ 0.1 |
| many brains | 100 (154) | 0.096 (0.081-0.117) | 0.136 (0.117-0.160) | 5.5 s | ≤ 0.2 |
| one brain | **150 (230)** | **0.138** (0.130-0.148) | **0.179** (0.162-0.197) | **8.0 s** | ≤ 0.1 ✗ |
| many brains | **150 (230)** | **0.134** (0.132-0.135) | **0.159** (0.158-0.162) | **7.7 s** | ≤ 0.2 ✓ |

Where the time goes at 150 robots (`bench/profile.ts`: 2 h sample after 4 h, one run each, noisy):

| Mode, layout | Whole tick | Traffic controller | Jam detection | Deadlock detection | People, motion, bookkeeping |
|---|---|---|---|---|---|
| one brain, default | 0.129 | **0.053** | 0.053 | 0.005 | 0.018 |
| many brains, default | 0.219 | **0.061** | 0.121 | 0.010 | 0.028 |
| one brain, large | 0.220 | **0.085** | 0.103 | 0.007 | 0.026 |
| many brains, large | 0.141 | **0.039** | 0.076 | 0.007 | 0.020 |

- **The planner meets both budgets at 150.**
- The overrun is my jam clustering, which is O(stopped²) and explodes in gridlock. The real `detect.ts` should bucket
  stopped agents by cell, which makes it O(n).
- The 150-robot runs are gridlocked warehouses (§2c), the worst case for planning: every blocked robot replans every
  tick and runs detour searches.
- The 8 h ≤ 10 s budget holds everywhere (max 8.0 s).

## 2. The gap

Capacity = tasks completed per hour with an always-full queue, after a 30 min warm-up.
- **Pick robots** (AMRs + humanoids, the robots that make OPH) is the headline.
- "All robots" adds forklift pallet moves; "all tasks" adds people.
- Idle % is about 0 everywhere because the queue never empties. Lost time shows up as **blocked %**: at a cell
  boundary, wanting to move, not moving.

### 2a. Default fleet (30 robots + 16 people), 8 h × 6 seeds, re-task setting the same on both sides

| `retaskMin` | Pick tasks/h one / many | **Gap (pick)** | Gap (all robots) | Gap (all tasks) | Blocked % | Jams/h | Deadlocks/h | Max deadlock s | Deadlocks > 2 min (in 45 h) | Manual resets/h | Re-tasks/h | Person step-asides/h | Safety stops/h (many) | Violations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1.5 (recommended)** | 692 / 612 | **11.6%** | 10.2% | 8.6% | 18.1 / 22.6 | 13.1 / 39.7 | 0.5 / 61.8 | 149 / 180 | 1 / 2 | 0.1 / 0.1 | 20 / 60 | 2,022 / 2,420 | 907 | 0 |
| 1 | 700 / 642 | 8.3% | 7.2% | 6.3% | 17.5 / 20.9 | 9.3 / 32.0 | 0.3 / 52.4 | 10 / 86 | 0 / 0 | 0.0 / 0.0 | 50 / 90 | 2,004 / 2,307 | 835 | 0 |
| 2 | 678 / 537 | 20.9% | 19.7% | 17.3% | 18.5 / 28.2 | 14.4 / 43.0 | 0.3 / 74.2 | 11 / 261 | 0 / 33 | 0.0 / 7.2 | 8 / 82 | 2,051 / 2,625 | 939 | 0 |
| off | 683 / 488 | 28.5% | 26.4% | 23.2% | 18.5 / 31.3 | 14.9 / 38.7 | 0.3 / 82.0 | 18 / 299 | 0 / 89 | 0.0 / 28.9 | 0 / 0 | 2,044 / 2,759 | 941 | 0 |

Mean deadlock duration (3 seeds × 8 h): one brain 6 to 44 s (only a few per shift), many brains 12 s. Largest cycle:
4 robots (one brain), 6 (many brains).

### 2b. Which knobs move the gap (many-brains knobs only, one brain fixed at defaults: 708 pick tasks/h; 4 h × 6 seeds)

| Variant | Many pick/h | **Gap** | Blocked % | Deadlocks/h | Max deadlock s | > 2 min | Resets/h |
|---|---|---|---|---|---|---|---|
| defaults (sensor 3, wait 5, reset 5, re-task 1.5, radius 6, backoff 3, jitter) | 628 | **11.3%** | 23.3 | 65 | 125 | 1 | 0.1 |
| re-task 1 / 2 / off | 658 / 522 / 480 | **7.1 / 26.3 / 32.2%** | 21 / 31 / 34 | 53 / 79 / 85 | 86 / 258 / 299 | 0 / 19 / 50 | 0.1 / 9.7 / 37 |
| waitTicks 3 / 8 / 12 | 644 / 588 / 438 | **9.1 / 16.9 / 38.1%** | 19 / 29 / 42 | 26 / 156 / 228 | 82 / 201 / 293 | 0 / 4 / 28 | 0.0 / 1.1 / 14.8 |
| sensorCells 1 / 2 / 5 | 601 / 633 / 580 | 15.2 / 10.7 / 18.2% | 23 / 22 / 28 | 32 / 37 / 104 | 84 / 117 / 165 | 0 / 0 / 3 | 0.2 / 0.0 / 1.2 |
| detourRadius 3 / 10 | 558 / 617 | 21.2 / 12.9% | 31 / 24 | 140 / 62 | 165 / 116 | 2 / 0 | 1.3 / 0.6 |
| backoffMax 1 / 6 / 10 | 624 / 613 / 610 | 12.0 / 13.5 / 13.9% | 23 / 25 / 25 | 65 / 73 / 67 | 90 / 166 / 210 | 0 / 4 / 3 | 0.4 / 0.7 / 1.1 |
| no jitter | 629 | 11.2% | 21.8 | 51 | 145 | 3 | 0.1 |
| resetMin 2 / 10 | 634 / 640 | 10.4 / 9.6% | 23 / 23 | 61 / 59 | 91 / 125 | 0 / 1 | 7.6 / 0.0 |
| one shared job pool (vendor queues off) | 623 | 12.1% | 24.4 | 69 | 112 | 0 | 0.3 |
| shared chargers | 618 | 12.8% | 23.8 | 67 | 90 | 0 | 0.1 |

What moves the gap:
- **`retaskMin` and `waitTicks`** are the real "how smart are the vendors' robots" knobs.
- `detourRadius` and `sensorCells` matter at the extremes.
- Backoff, jitter, resetMin, per-vendor queues and per-vendor chargers each move it by ~1 to 2 points at the default
  fleet. There are enough chargers (12) that vendor ownership barely matters.
- An earlier sweep (before people manners and re-tasking existed) showed turning off station balancing collapses many
  brains (−73%), and vendor-dedicated pack stations (segregation) added 11 points of gap (26.8% → 37.9%). Neither is
  re-measured on the final code.

### 2c. Scaled fleets (re-task 1.5, 8 h × 3 seeds; "brief loop" = pickers also walk to pack stations)

| Layout, loop | Robots | Pick tasks/h one / many | **Gap (pick)** | Blocked % | Deadlocks > 2 min | Resets/h | Note |
|---|---|---|---|---|---|---|---|
| default, brief loop | 30 | 687 / 607 | 11.7% | 18 / 23 | 1 / 1 | 0.3 / 0.2 | the default fleet |
| default, brief loop | 60 | 316 / 141 | 55.3% | 53 / 69 | 25 / 224 | 39 / 129 | both modes saturated |
| default, brief loop | 100 | 192 / 100 | 47.9% | 68 / 79 | 149 / 454 | 145 / 288 | overload |
| default, brief loop | 150 | 88 / 43 | 51.0% | 76 / 82 | 244 / 641 | 330 / 483 | overload; one brain had a 10,360 s cycle |
| default, pickers in zones | 30 | 797 / 529 | 33.6% | 17 / 32 | 3 / 38 | 4.0 / 16.9 | people in the aisles hurt many brains more |
| large, pickers in zones | 30 | 743 / 693 | 6.7% | 7 / 8 | 0 / 0 | 0.0 / 0.0 | low density |
| large, pickers in zones | 60 | 887 / 315 | 64.5% | 27 / 55 | 20 / 127 | 16 / 84 | many brains gridlocks, one brain still +19% |
| large, pickers in zones | 100 | 171 / 111 | 35.3% | 67 / 76 | 45 / 265 | 181 / 295 | both saturated; one brain had a 25,090 s cycle, probably people only (robots in a cycle are reset after 5 min) |
| large, pickers in zones | 150 | 162 / 149 | 8.1% | 71 / 78 | 27 / 704 | 293 / 436 | both gridlocked |

Why scaling stalls (one brain, large layout, 3 h; `bench/diag.ts`):

| Robots | As in the brief | No people | No people, pack dwell 1 tick |
|---|---|---|---|
| 30 | 645 pick tasks/h, 11% blocked | 811, 6% blocked | 834 |
| 60 | 654, 33% blocked | 1,317, 14% blocked | 1,321 |
| 150 | 276, 70% blocked, 184 resets/h | 1,245, 42% blocked, 0 resets | 1,249 |

- **People are the biggest drag at scale.** In this model they are fixed obstacles that plan first and share the
  pick aisles and the pack lane.
- **Next is the pack area**: one-cell stations on a 1-wide lane. Station dwell barely matters; approach and exit
  congestion does.
- **The ceiling for robots alone** is about 1,300 pick tasks/h on the large layout, reached at around 60 robots.
- **The hero sweep chart** ("many brains flattens, one brain keeps climbing") is visible between 30 and 60 robots on
  the large layout. Beyond that, both modes stall in this work model.

## 3. Gridlock and deadlocks

- **Default fleet: no permanent gridlock** in any 8 h run (6 seeds per mode × 4 re-task settings). The longest cycle
  still active at the end of a run is under 2 min.
- One brain: 0.3 to 0.7 deadlocks/h. These are short cycles that clear in seconds; one cycle (149 s) in
  6 shifts. **It's not 0 deadlocks over 10 s** (the research's pass line), most likely because people aren't in the planner (not traced).
- Many brains (recommended knobs): 62 deadlocks/h (≥ 5 s each, mean 12 s), 2 over 2 min in 45 h (max 180 s), about 1
  manual reset per shift. This matches the research pass line (≥ 1 visible self-recovering deadlock per hour, ≤ 2
  resets per shift), except that "every deadlock ≤ 2 min" holds for 99.9% of them, not all.
- **Overloaded fleets do gridlock**, including one brain. At 100 to 150 robots I saw cycles lasting hours. The longest
  were most likely people cycles: three or more people in a ring can't swap, and people have no reset. Manual resets peel robots
  off knots but don't stop new ones forming.
- The test suite asserts the default-fleet behaviour: one brain all deadlocks ≤ 2 min; many brains ≤ 3 over 2 min per
  shift and all ≤ 6 min; nothing active at the end.

## 4. People

- Tests: one robot and one person head-on in the same lane of a 2-cell aisle both arrive in about 60 ticks (18 cells;
  test bound 120), in both modes. The robot yields into the other lane and the person walks past. Three robots and three people
  crossing in one aisle all get through.
- Default fleet: about 2,000 (one brain) / 2,400 (many brains) person step-asides per hour across 16 people (one
  every ~28 s per person), plus about 450 head-on person swaps per hour.
- Checked **every tick of every run reported here**: no two agents hold one cell, no robot starts a move into a
  person's cell, no person into a robot's, and `occ` matches every agent. **All zero.**

## 5. Assignment cost (every 10 ticks over 8 h = 5,760 calls; real BFS distances × 3 ticks/cell + an age term)

| Size | Greedy ms/call (mean, p95) | Optimal ms/call (mean, p95) | Greedy per 8 h | Optimal per 8 h | Optimal saves |
|---|---|---|---|---|---|
| 16 × 16 | 0.0021, 0.0023 | 0.022, 0.027 | 0.01 s | 0.12 s | 12.4% of total cost |
| 64 × 64 | 0.023, 0.028 | 0.61, 0.91 | 0.13 s | 3.5 s | 13.4% |
| 150 × 150 | 0.10, 0.13 | 4.9, 6.5 | 0.6 s | 28 s | 12.9% |

Optimal = Kuhn-Munkres with potentials (shortest augmenting path, O(n²m), integer costs), checked against brute force
in the tests.

**Recommendation:**
- **Greedy is the default, and the only option for many brains.**
- For one brain, batch optimal over (robots freed this window × open tasks), **capped at 32 rows** (fall back to
  greedy above the cap). 32 rows is an estimate from the 16 and 64 rows: about 0.1 to 0.2 ms per call, so at most
  about 1 s per shift even if every call hit the cap. At the default fleet about 1 robot frees up per 10 ticks, and about 5 at 150, so real calls
  are tiny rectangles.
- **Never run 150 × 150 optimal** every 10 ticks: it takes 28 s per shift, three times the whole sim budget.
- The ~13% shorter assignment travel is a fair, sourced one-brain perk to turn on in Phase 2 (I did not turn it on
  for the gap numbers above).

## 6. Cross-engine determinism (1 h, default fleet, invariant checks on)

| Engine | One brain hash | Many brains hash | State words | All integers | Run ms (one / many) |
|---|---|---|---|---|---|
| Node 26.7 | 41834afc | a17f4d3a | 1,756 / 1,755 | yes | 140 / 144 |
| Chromium 158 | 41834afc | a17f4d3a | 1,756 / 1,755 | yes | 136 / 124 |
| Firefox 159 | 41834afc | a17f4d3a | 1,756 / 1,755 | yes | 276 / 237 |
| WebKit 27.2 | 41834afc | a17f4d3a | 1,756 / 1,755 | yes | 163 / 187 |

- **All four hashes are equal per mode.**
- How: the bundle is built with esbuild to an IIFE (78 KB), loaded into `about:blank` with
  `page.addScriptTag`, and run with `page.evaluate`. No server, so no port.
- The state covers every agent field, pools, chargers, station loads, cell claims, priority order, all RNG states and
  every counter. It throws on any non-integer.
- A test greps `src/` for banned APIs (`Math.random`, `Date`, `performance.now`, transcendental `Math`, `**`).

## 7. Recommendations for the contracts

**Units: keep tick = 0.5 s and cell = 1.5 m.**
- Speeds come out exact on average: AMR 3 ticks/cell, humanoid 3.75 (4,4,4,3), driver 2.24 (3,2,2,2,3…). Turns land
  on whole ticks.
- 2-cell aisles (3 m) let a robot and a person pass (tested). Cost is not the problem (§1).
- A 0.75 m grid would mean 4× the cells, and "2 cells" would become a 1.5 m aisle where passing stops making sense.
- Add to PROTOCOL §1:
  - The remainder carries only while moving continuously; a stop or a turn resets it to 0.
  - Mid-move agents hold both cells and nobody may enter a cell that is being left (causal PIBT), so following
    spacing is one empty cell.
  - mm per tick = round(speedMps × 500).

**`TrafficController` shape** (what worked in `src/traffic.ts`, tidied so the controller never mutates sim state):

```ts
export interface TrafficInput {
  tick: number;
  /** Robots, highest priority first. The sim owns priority: oldest goalTick, then seeded tb (redrawn at each goal), then id. */
  order: readonly number[];
  /** ready[id] === tick: at a cell boundary with a travel goal (not moving, dwelling, charging or broken). */
  ready: Int32Array;
  /** occ[cell] = holder id (robots and people, incl. move targets and forklift safety cells), -1 free. Read-only. */
  occ: Int32Array;
  /** [robotId, personCell, ...]: a blocked person asks this robot to make way (robots yield to people). */
  yields: readonly number[];
}
/** Per robot the controller reads: id, vendor, pass class, cell, heading, goal + DistanceCache map, safetyCells,
 *  turnTicks, and two progress counters the sim keeps (ticks since progress, blocked ticks since progress). */
export interface TrafficPlan {
  /** Per agent id: cell to start moving into this tick or -1 (stay); safety cell or -1; direction. Conflict-free. */
  moveTo: Int32Array; safety: Int32Array; dir: Int8Array;
  /** Per agent id: preferred next cell (wait-for graph, "waiting for" arrows, route ribbons). */
  want: Int32Array;
  events: { t: 'detour' | 'stepAside' | 'safetyStop' | 'yield'; agent: number; cell: number }[];
}
export interface TrafficController {
  readonly mode: TrafficMode;
  /** Phase 1 of the tick: ladder decisions the sim applies before planning (so every brain sees them). */
  recover(input: TrafficInput): { resets: { agent: number; cell: number }[]; retasks: number[] };
  /** Phase 2: plan moves. */
  plan(input: TrafficInput, out: TrafficPlan): void;
  /** Controller-private state (detour paths, ladder marks, backoff) for hash() and snapshots. */
  stateWords(): number[];
}
```

- People are not planned by the controller. The sim moves them first, then hands over `occ` and `yields`.
- Many brains is a different controller class with the same interface. A `shared-status` mode (Phase 2) can be a
  `SiloedController` whose walls exclude foreign robots that publish their next cell.

**Default `silo` knobs:** `{ sensorCells: 3, waitTicks: 5, resetMin: 5, retaskMin: 1.5 }`, plus internal defaults
`detourRadius 6`, `backoffMax 3`, `jitter on`. That gives about 12% at the default fleet, about 1 manual reset per
shift, and 99.9% of deadlocks under 2 min. For a "how smart are the vendors' robots" slider:

| Setting | Knobs | Gap at default fleet |
|---|---|---|
| smart | `retaskMin 1`, `waitTicks 3` | 7 to 9% |
| typical | `retaskMin 1.5`, `waitTicks 5` | 11 to 12% |
| poor | `retaskMin 2`, `waitTicks 8` | 17 to 26%, with real resets (7 to 10/h) |

The 10 to 40% band is judgment (PLAN §7). This model says the honest gap at the default fleet is near its bottom
edge, unless vendors are poor at recovery.

**`src/contracts/types.ts` change requests:**
1. `Scenario.traffic.silo`: add `retaskMin: number` (the vendor job timeout, the main gap knob). Optionally
   `detourRadius`, `backoffMax`.
2. `AgentSpec`: add `turnTicks` (per 90°: AMR 1, forklift 2, others 0). It's in the brief but missing from the type.
3. `AgentView`: add `waitOn: number` (agent it waits for, -1), so the renderer can draw wait-for arrows and the
   deadlock ring without recomputing.
4. `SimEvent`: add `{ t: 'retask'; tick; agent; goal }` and `{ t: 'safetyStop'; tick; agent; cell }` (both visible
   many-brains moments). Optionally `{ t: 'yield'; tick; agent; person }`.
5. `Kpis`: add `retasksPerHour` and `deadlocksOver2MinPerShift`. Resets alone hide the difference between 1 and 1.5
   min re-tasking.
6. `STREAMS`: add `ladder:<vendor>` and `spawn` (initial placement). `tiebreak:<vendor>` and `physical` are used as
   planned.
7. PROTOCOL rules the sim core must keep (all in this spike):
   - robots yield to people
   - a waiting robot's cell claim
   - people's manners (side step, swap, wait for a leaving agent, don't crowd a busy goal)
   - the pack-lane tie-break
   - safety-cell pushes
   - WMS least-loaded pack station, always on in both modes

**For Phase 1's work model and layout (lead):**
- **Pickers should stay in pick zones** and meet AMRs at faces (the real Locus model). Only AMRs and humanoids
  should visit pack stations.
- **Pack stations need queue room**: a 2-wide pack lane, or an in-cell and an out-cell per station. Today the 1-wide
  row 29 with one-cell stations is the hotspot in both modes.
- **Re-measure 60/100/150 after those changes.** Today's scaled numbers measure overload, not traffic.

## Open risks

1. **The gap is small at the default fleet and very sensitive** to `retaskMin`, `waitTicks` and density: 7% to 64%
   across reasonable settings and fleets. The sweep chart will swing a lot. The UI should label high gaps that come
   from gridlock (resets, deadlocks over 2 min) as such.
2. **Scaling stalls in both modes** past about 30 (default layout) or 60 (large) robots under the brief's work loop.
   People are the biggest cause. Phase 1 must fix the work model and stations before the hero sweep is believable.
3. **People-only cycles of 3+ can be permanent** when the warehouse is overloaded (people have no reset). It needs a
   rule, for example people in a cycle for over 20 ticks rotate, or the supervisor nudge applies to people too.
4. **Detection cost**: jam clustering must be O(n) in `detect.ts`, or gridlocked runs blow the tick budget.
5. **Judgment calls**: the people manners, claims, yields and re-tasking are unsourced choices. They apply to both
   modes, but they shape absolute throughput.
6. **Not measured here**: worker vs main thread (expected identical, same code), and timings on a quiet Mac.

## How to rerun (from `02-fleet-planner/`)

```
npx vitest run -c spikes/b-traffic/vitest.config.ts                      # 9 tests, about 4 s
npx tsc --noEmit -p spikes/b-traffic/tsconfig.json && npx tsc --noEmit -p spikes/b-traffic/tsconfig.src.json
npx tsx spikes/b-traffic/bench/speed.ts 3 default                        # §1
npx tsx spikes/b-traffic/bench/profile.ts central default                # §1 time split (also siloed, large)
npx tsx spikes/b-traffic/bench/gap.ts 6 3                                # §2a and §2c (default layout)
npx tsx spikes/b-traffic/bench/gap.ts 6 3 large                          # §2c (large layout, pickers in zones)
npx tsx spikes/b-traffic/bench/ladder.ts 4 6                             # §2b
npx tsx spikes/b-traffic/bench/diag.ts large                             # §2c "why scaling stalls"
npx tsx spikes/b-traffic/bench/assign.ts 3                               # §5
npx tsx spikes/b-traffic/bench/cross-engine.ts 1                         # §6 (Playwright chromium, firefox, webkit)
```

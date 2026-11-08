# Track A: sim core, branch `p1-a-sim-core` (unit tests only, no port)

## Goal
The real simulator behind every number: orders arrive, robots and people pick them, totes reach pack stations, orders ship. Forklifts keep pick faces stocked, robots charge, things break. It must be deterministic, integer-only and headless, and fast: an 8 h shift in ≤ 10 s in Node.

## Read first
- PLAN.md §4 and §6.
- **PROTOCOL.md §1, §3, §4, §5 and §8** (the rules you implement, including the shared people/robot rules and the work model).
- `src/contracts/types.ts` (`Sim`, `SimStats`, `Snapshot`, `AgentView`, `TaskView`, `SimEvent`, `Command`, `Scenario`, `AgentSpec`).
- `src/sim/world.ts`, `motion.ts`, `detect.ts`, `rng.ts`, `fake.ts` (the same interface, simple behaviour), `traffic/types.ts` and `traffic/naive.ts`.
- **`spikes/b-traffic/`**: a working prototype of the tick loop, people manners, cell claims, battery, invariants and hash (`src/sim.ts`, `src/agent.ts`, `src/config.ts`), plus `RESULTS.md`. **Lift from it freely**; it already handles the traps the spike found.

## You own
`src/sim/core/**`, `src/sim/faults/**`, `tests/unit/sim/**`.
- Do not edit the lead's `src/sim/{index,world,motion,detect,rng,fake,layout-gen}.ts`, `src/sim/traffic/types.ts` or `naive.ts`, `src/contracts/*` or `data/*`.
- Track B owns `src/sim/traffic/central/`. You only use the `TrafficController` interface; test with `NaiveController` and inject any controller through options.

## Build: `createCoreSim(scenario, {agents, layout}, { traffic?: (mode) => TrafficController }) → Sim` in `src/sim/core/index.ts`
The default traffic factory returns `NaiveController`; the lead switches it to B's controller at integration.

1. **Tick order** (one tick = 0.5 s):
   1. apply queued commands
   2. order arrivals (4 draws from `arrivals`, PROTOCOL §8) and inbound pallets
   3. faults
   4. people move (the PROTOCOL §5 rules, people first)
   5. `traffic.recover()` → apply resets/re-tasks
   6. `traffic.plan()` → start robot moves (`motion.moveTicks` with the turn and stop rules)
   7. arrivals at cells, dwells, task progress
   8. battery
   9. detection (`DeadlockTracker`, `JamTracker` from `detect.ts`, fed with `want` / `waitOn`)
   10. stats, then `tick++`

   Every agent is processed in id order, and every tie ends with an id tie-break.
2. **Orders:**
   - Order #n's line count comes from `linesWeights`, and its faces from `hash32(seed, n, k)` with ABC skew over `world.faces` ranks (`sku.aPct`/`aPicksPct`).
   - 1 unit per line, so units/h = lines/h. Say so in a code comment; the UI states it.
   - **An order is never split:** its lines travel in one tote.
3. **Picking:**
   - **With cart robots (AMR-assisted, Locus model):**
     - Pickers (and humanoids, at their own `pickSecPerLine`) are assigned to **zones**: contiguous aisles split evenly, deterministic.
     - An AMR takes a batch of up to 3 orders (`TOTES_PER_AMR = 3`, an estimate with a comment) and visits their faces in nearest-next order.
     - At each face it waits (`wait` state) for the zone's nearest free picker, who walks over and picks (dwell `pickSecPerLine` per line).
     - Then the AMR goes to the **least-loaded pack station** and dwells `handoffSec`.
   - **People only (no AMRs):**
     - Each picker pushes a cart with up to 6 orders (`ORDERS_PER_CART = 6`, an estimate with a comment).
     - Walks the faces in nearest-next order, picks, and walks to the least-loaded pack station.
     - Humanoids without AMRs do the same at their rate.
   - Pick time is real, walking is real; **picker uplift is an output**.
4. **Pack and ship:**
   - Each station packs one order at a time (`pack.secPerOrder`).
   - Packed orders ship after a fixed conveyor delay of 60 ticks (`orderPacked` → `orderShipped` with `arrivedTick`).
   - Packers are not agents (fixed labor in the money model).
5. **Pallets:**
   - Each face holds `2 × linesPerReplenish` lines of stock. When it falls to `linesPerReplenish`, a replenish task is created (one open per face).
   - Inbound: one pallet every `floor(7200 / inboundPerHour)` ticks (no randomness).
   - A forklift or driver goes to a dock staging cell (dwell `palletSecPerMove`, `cargo: 'pallet'`), then to the face (dwell), and emits `palletMoved`.
   - **A pick at an empty face waits** until it is replenished. That's how forklift shortages throttle throughput.
6. **Assignment:** greedy nearest-idle by BFS distance, deterministic. Build it as **pools keyed by vendor and type**, so Track G can split pools per vendor in Phase 2. In `central` mode, all vendors of a type share one pool.
7. **Battery and charging:**
   - `batteryTicksLeft`, initial level spread with the `battery` stream when `run.batterySpread`.
   - A robot below `chargeAtPct` goes to the nearest free charger pocket of its class after its current task (immediately below 10%).
   - It charges at `runtime ÷ charge` per tick and queues when chargers are busy.
   - Chargers are shared in central mode (vendor-owned in Phase 2).
8. **People:**
   - Cell agents, moved by the core, never planned (PROTOCOL §5 rules 1 to 4 and the cell claim).
   - **Drivers** are people who drive a manual forklift: moved by the core like people, but with pass class `forklift` and a safety cell. Robots treat them like people.
9. **Faults (Phase 1: breakdown only):**
   - `breakdown {atMin, agent: 'amr:3', forMin}` → the agent is `broken`, holds its cell, and its batch goes back to the queue.
   - `repair` when it ends.
10. **Commands:**
    - `setFleet`: new agents spawn at free parking or charger pockets, else at free cells from the `spawn` stream. Removed agents finish their task, then leave.
    - `setOrderRate`, and `setTraffic` (swap the controller via the factory).
    - All logged with their tick.
11. **Outputs:**
    - `snapshot()` (every `AgentView` field including `route` from `DistanceCache.route`, `waitOn`, `tasks`, `stats`, `deadlocks`, `heat`)
    - `stats()` (cheap)
    - `drainEvents()` (every `SimEvent` type that applies)
    - `hash()`: FNV-1a over every integer of agent state, queues, stocks, RNG states and `traffic.stateWords()`. Throw on any non-integer.
12. **Performance:** no allocation in the per-tick hot path where you can avoid it; typed arrays for occupancy.

## Tests (`tests/unit/sim/`), all must pass
- **Determinism:** same scenario + seed + command log ⇒ the same hash after 1 h (twice). A different seed ⇒ a different hash.
- **Invariants checked every tick for 2 h** on the default scenario with `NaiveController` and with a test controller:
  - never two agents in one cell (counting move targets)
  - no forklift or driver on a `.` cell
  - no robot enters a person's cell
  - pockets entered only as a goal
  - battery never negative
- **Order flow:** every arrived order ships exactly once. Little's law within ±10% over a 2 h window at a demand the fleet can handle.
- **People only** (all robot counts 0): orders still flow (manual carts), and robots never appear.
- **Forklift starvation:** 0 forklifts and 0 drivers ⇒ faces run dry and throughput falls; 2 drivers ⇒ it recovers.
- **Live commands:** `setFleet` up and down mid-run; `setOrderRate` changes arrivals from the next tick; both appear in `commandLog`.
- **Breakdown:** the agent stays put for `forMin`, its orders are re-assigned, and `breakdown`/`repair` events fire.
- **Every `SimEvent` type you emit has a test.**
- **Speed** (report it): 8 h default shift in Node with `NaiveController`.

**Numeric targets the lead re-checks after Track B's planner merges** (report what you see with naive traffic):
- picker uplift 1.5 to 2.2× at the default inputs
- 8 h ≤ 10 s
- whole tick ≤ 0.2 ms at 150 robots + people

## Done when
- `npm run typecheck` (both configs) and `npm test` are green, with the purity test passing for your files.
- Committed on your branch.
- Report:
  - what you built
  - the measured speed
  - the uplift and capacity you saw on naive traffic
  - the constants you chose (`TOTES_PER_AMR`, `ORDERS_PER_CART`, conveyor delay), each with its reasoning
  - any contract change requests

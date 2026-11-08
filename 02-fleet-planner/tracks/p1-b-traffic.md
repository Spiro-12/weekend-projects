# Track B: one-brain traffic (PIBT), branch `p1-b-traffic` (unit tests only, no port)

## Goal
The orchestrator. One planner moves every robot from every vendor so that nothing ever collides, robots yield to people, forklifts keep their safety field, and jams clear on their own. It has to be fast enough for 150 robots, deterministic, and integer-only.

## Read first
- PROTOCOL.md §1, §5 (the `TrafficController` interface and the shared rules) and §8.
- `src/sim/traffic/types.ts` (**the frozen interface you implement**), `src/sim/traffic/naive.ts` (the stub), `src/sim/world.ts` (`DistanceCache`, `passable`, pockets), `src/sim/motion.ts`.
- **`spikes/b-traffic/src/traffic.ts`**: `CentralController` is a working causal PIBT with local detours, people yields and safety-cell pushes. **Port it to the frozen interface**, clean it up, and keep what the spike found necessary (`spikes/b-traffic/RESULTS.md` § "Model additions").

## You own
`src/sim/traffic/central/**`, `tests/unit/traffic/**`. Don't touch the interface file, the stub or the sim core (Track A, in parallel). Your tests drive the controller with your own small test harness (as the spike did): random goals for robots on the real layouts, people as moving obstacles in `occ`, and the `yields` input.

## Build: `CentralController implements TrafficController` (`mode: 'central'`)
1. **Causal PIBT** over robots at a cell boundary (`ready[id] === tick`), in the sim's priority order (`input.order`).
   - Never move into a held cell, including one being vacated.
   - Pushing is allowed; the pusher waits for the cell to clear.
2. **Per pass class:** forklifts use forklift cells only and reserve `safetyCells` ahead (`out.safety`). A robot standing in a forklift's needed safety cell is pushed out.
3. **Pockets** (chargers, parking) are entered only by the robot whose goal they are.
4. **Robots yield to people:** for each pair in `yields`, push that robot out of the person's way.
5. **Local detour:** a robot blocked `waitTicks` (5) by something it can't push (a person, a parked or broken robot) plans a bounded detour (radius 6) and follows it. Report it as a `detour` `TrafficEvent` (internal; the core counts it but it is not a `SimEvent`). The core maps `safetyStop` → `SimEvent safetyStop` and `yield` (cell = the person's cell) → `SimEvent yield` with that person's id.
6. **Guidance:** tie-break toward fewer turns. Respect one-way hints (`> < ^ v`) as a soft cost if the layout has them.
7. **`want[id]`** = preferred next cell, even when staying. The sim builds the wait-for graph from it.
8. **`recover()`:** central mode needs no ladder. Return empty resets and re-tasks unless a robot has made no progress for 5 minutes. Then return a reset (a person helps), the same rule many brains will use, so one brain isn't given a free pass.
9. **`stateWords()`:** detour paths and counters, integers only.

## Tests (`tests/unit/traffic/`, all must pass)
- **Property tests:** 50 seeds × 10,000 ticks on the default layout with 60 robots (mixed classes) + 16 moving people. Never:
  - two agents in one cell, counting move targets and safety cells
  - a swap through each other
  - a forklift on a `.` cell
  - a robot entering a person's cell
  - a move into a cell being vacated
- **Head-on:** robot vs person in a 2-cell aisle pass. 3 robots + 3 people crossing all get through within 150 ticks (lead sign-off: two robots abreast must back out of the aisle; the spike took 175).
- **Forklift safety:** two forklifts facing each other one cell apart resolve.
- **No permanent gridlock:** an 8 h run at 150 robots on the default layout. Every robot reaches at least one goal per simulated hour; count deadlocks via `detect.ts` and report them.
- **Determinism:** the same input sequence gives the same `stateWords()` and outputs.
- **Speed:** planner time at 30 / 60 / 100 / 150 robots. **Budget: ≤ 0.1 ms per tick at 150.** Report mean and p95.

## Done when
- `npm run typecheck` and `npm test` are green, with the purity test passing for your files.
- Committed on your branch.
- Report: the speed table, the property-test counts, the deadlock counts at each fleet size, and what you changed from the spike's controller and why.
- **Also:** as a port note for Track G in Phase 2, list what in the spike's `SiloedController` depends on central internals.

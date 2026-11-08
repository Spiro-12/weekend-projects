// People are cell agents moved by the core, first each tick, never planned (PROTOCOL §5). Lifted from spike b's
// planPeople, which found each rule necessary:
//  1. robots treat people's cells as fixed obstacles (the planner sees them in occ);
//  2. a person blocked by a robot asks it to make way (the core turns `want` into TrafficInput.yields);
//  3. robot cell claim: a robot blocked 3+ ticks claims the cell it wants; people don't step into it, and an idle person
//     standing on it steps off ("people let it go first");
//  4. manners: step to the side (not back) after 4 blocked ticks; two people head-on swap; wait for an agent that is
//     already leaving the cell; don't crowd a busy goal (wait 2 cells back).
// Drivers (people on manual forklifts) move the same way on forklift cells, keep a safety cell ahead while moving, and
// never swap. Deterministic: id order, fixed E, S, W, N tie-break, side-step ties drawn from the `humans` stream.
import { Cell, UNREACHABLE } from '../world.ts';
import { J_NONE, J_PICK, J_REST, J_SERVE, PK_AT_STOP, PK_HOLD, PK_ZONE_HOLD, SV_WAIT_AMR, SV_WAIT_STOCK, T_PICKER, type CoreAgent } from './agent.ts';
import { PEOPLE_PATIENCE_TICKS, STEP_ASIDE_AFTER } from './constants.ts';
import type { CoreSim } from './sim.ts';

export function movePeople(s: CoreSim, t: number): void {
  const w = s.world;
  const occ = s.occ;
  const claim = s.claim;
  const people = s.people;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    p.want = -1;
    p.waitOn = -1;
    if (p.to >= 0 || p.brokenUntil > 0 || p.dwellUntil > 0 || p.swappedAt === t) continue;
    if (p.goal < 0) {
      // Rule 3: a person standing still (idle, or waiting at a face for a robot or for stock) where a waiting robot
      // or vehicle wants to go steps off.
      if (claim[p.cell] === t && standingStill(p) && stepOff(s, p, t)) s.steppedOff(p, t);
      continue;
    }
    if (s.atGoal(p)) continue;
    const D = s.dist.to(p.distCls, p.goal);
    const v = p.cell;
    const dv = D[v];
    if (dv === UNREACHABLE) {
      p.blockedAt = t;
      continue;
    }
    // Rule 4: don't crowd a busy goal (station, home): wait 2 cells back while it is taken.
    const hold = p.goalHold === 1 && dv >= 2 && occ[p.goal] >= 0 && occ[p.goal] !== p.id;
    let first = -1;
    let firstKey = 1 << 30;
    let free = -1;
    let freeDir = 0;
    let freeKey = 1 << 30;
    let freeSafety = -1;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[v * 4 + d];
      if (j < 0 || !p.pass[j] || w.isPocket[j] || D[j] >= dv || (hold && D[j] === 1)) continue;
      // ties: a zone worker meeting a cart robot keeps to the robot's lane (the other lane stays free), then out of
      // the narrow pack lane unless it is the goal, then straight on (fewer turns), then E, S, W, N
      const lane = p.laneX >= 0 && j % w.width !== p.laneX ? 64 : 0;
      const narrow = w.code[j] === Cell.Narrow && j !== p.goal ? 16 : 0;
      const key = lane + narrow + (d === p.prefHeading ? 0 : 4) + d;
      if (key < firstKey) {
        first = j;
        firstKey = key;
      }
      if (occ[j] < 0 && (claim[j] !== t || patient(p)) && key < freeKey) {
        const sc = safetyCell(s, p, j, d, t);
        if (sc === -2) continue;
        free = j;
        freeDir = d;
        freeKey = key;
        freeSafety = sc;
      }
    }
    p.want = first;
    if (free >= 0) {
      s.doMove(p, free, freeSafety, freeDir, t);
      p.prefHeading = freeDir;
      p.pBlocked = 0;
      continue;
    }
    const h = first >= 0 ? occ[first] : -1;
    p.waitOn = h >= 0 ? h : first >= 0 ? blockerOfSafety(s, p, first) : -1;
    // Rule 4: two people head-on squeeze past each other (people can share a 1.5 m cell for a moment; robots can't).
    if (h >= 0 && trySwap(s, p, s.byId[h]!, v, first, t)) continue;
    p.blockedAt = t;
    // Rule 4: the agent in the way (in the cell, or in a driver's safety cell) is already moving out: wait for it,
    // don't dodge.
    const blocker = p.waitOn >= 0 ? s.byId[p.waitOn] : null;
    if (blocker && blocker.to >= 0 && (blocker.cell === first || (h < 0 && blocker.to !== first))) continue;
    if (++p.pBlocked < STEP_ASIDE_AFTER) continue;
    stepAside(s, p, D, t);
  }
}

/** Safety cell a driver needs when entering j in direction d: -1 none needed, -2 not clear, else the cell. */
function safetyCell(s: CoreSim, p: CoreAgent, j: number, d: number, t: number): number {
  if (p.safetyCells === 0 || s.stopsAt(p, j)) return -1; // no safety field needed for the final stop
  const c = s.world.nbr[j * 4 + d];
  if (c < 0 || !s.open[c]) return -1;
  return s.occ[c] < 0 && (s.claim[c] !== t || patient(p)) ? c : -2;
}

/** Who holds the safety cell beyond `first` (for the wait-for graph and robot yields), or -1. */
function blockerOfSafety(s: CoreSim, p: CoreAgent, first: number): number {
  if (p.safetyCells === 0) return -1;
  const v = p.cell;
  for (let d = 0; d < 4; d++)
    if (s.world.nbr[v * 4 + d] === first) {
      const c = s.world.nbr[first * 4 + d];
      return c >= 0 ? s.occ[c] : -1;
    }
  return -1;
}

/** Two pickers squeeze past each other: q walks toward p's cell (head-on), or q is just standing there (idle, or
 *  waiting for a robot or stock), in which case it shuffles one cell. Drivers (on forklifts) never swap. */
function trySwap(s: CoreSim, p: CoreAgent, q: CoreAgent, v: number, first: number, t: number): boolean {
  if (p.type !== T_PICKER || q.type !== T_PICKER) return false;
  if (q.to >= 0 || q.dwellUntil > 0 || q.brokenUntil > 0 || q.swappedAt === t) return false;
  const still = q.goal < 0;
  if (still) {
    if (!standingStill(q)) return false;
  } else {
    if (s.atGoal(q)) return false;
    const Dq = s.dist.to(q.distCls, q.goal);
    if (!(Dq[v] < Dq[first])) return false;
  }
  s.swap(p, q, t);
  if (still) s.steppedOff(q, t);
  return true;
}

/** A person blocked this long no longer gives way to robot claims (a claim is a courtesy, not a wall): without this a
 *  driver could wait for ever on a cell a stuck robot keeps claiming. */
function patient(p: CoreAgent): boolean {
  return p.blockedTicks >= PEOPLE_PATIENCE_TICKS;
}

/** Blocked STEP_ASIDE_AFTER ticks: step to a free neighbour, to the side of the route first (not back), then closest to
 *  the goal; equal choices are drawn from the `humans` stream. */
function stepAside(s: CoreSim, p: CoreAgent, D: Uint16Array, t: number): void {
  const w = s.world;
  const v = p.cell;
  let bestKey = 1 << 30;
  let pick = -1;
  let pickDir = 0;
  let pickSafety = -1;
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const j = w.nbr[v * 4 + d];
    if (j < 0 || !p.pass[j] || w.isPocket[j] || s.occ[j] >= 0 || (s.claim[j] === t && !patient(p)) || D[j] === UNREACHABLE) continue;
    const sc = safetyCell(s, p, j, d, t);
    if (sc === -2) continue;
    const side = ((d - p.prefHeading + 4) & 1) === 1 ? 0 : 0x10000;
    const key = side + D[j];
    if (key < bestKey) {
      bestKey = key;
      pick = j;
      pickDir = d;
      pickSafety = sc;
      n = 1;
    } else if (key === bestKey) {
      n++;
      if (s.rngHumans.int(n) === 0) {
        pick = j;
        pickDir = d;
        pickSafety = sc;
      }
    }
  }
  if (pick < 0) return;
  s.doMove(p, pick, pickSafety, pickDir, t);
  p.pBlocked = 0;
  s.counters.stepAsides++;
}

function standingStill(p: CoreAgent): boolean {
  if (p.job === J_NONE || p.job === J_REST) return true;
  if (p.job === J_SERVE) return p.stage === SV_WAIT_AMR || p.stage === SV_WAIT_STOCK;
  // waiting at a face for stock, or holding a full cart for a pack slot / room in a zone
  return p.job === J_PICK && (p.stage === PK_AT_STOP || p.stage === PK_HOLD || p.stage === PK_ZONE_HOLD) && p.waiting === 1;
}

/** Rule 3 for a person standing still: step off a cell a robot has claimed (any free, unclaimed neighbour, E, S, W, N).
 *  Returns true if it moved. */
function stepOff(s: CoreSim, p: CoreAgent, t: number): boolean {
  const w = s.world;
  for (let d = 0; d < 4; d++) {
    const j = w.nbr[p.cell * 4 + d];
    if (j < 0 || !p.pass[j] || w.isPocket[j] || s.occ[j] >= 0 || s.claim[j] === t) continue;
    const sc = safetyCell(s, p, j, d, t);
    if (sc === -2) continue;
    s.doMove(p, j, sc, d, t);
    s.counters.stepOffs++;
    return true;
  }
  return false;
}

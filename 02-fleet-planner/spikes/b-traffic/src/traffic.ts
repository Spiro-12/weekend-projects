// Traffic controllers: one brain (one PIBT over every robot) and many brains (one PIBT per vendor, foreign robots
// as unpushable obstacles, a physical layer for cross-vendor claims, and the recovery ladder).
//
// PIBT here is the "causal" variant for committed multi-tick moves (Okumura et al., time-independent planning):
// an agent may only start a move into a cell nobody holds. Pushing a lower-priority agent out of the way still works
// (priority inheritance), but the pusher waits until the pushed agent has left. Only agents at a cell boundary plan.
//
// Every robot (any vendor, either mode) has local obstacle avoidance: blocked waitTicks by something it cannot
// negotiate with (a person, a parked robot) it plans a bounded detour around it. Many brains adds foreign robots to
// that list, plus rung 2 (random step aside) and a manual reset; one brain keeps the reset only as a safety net.
// Integers only, no Math.random, fixed iteration orders.
import { Cell, UNREACHABLE, type World } from '../../../src/sim/world.ts';

const CELL_NARROW = Cell.Narrow;
import type { Rng } from '../../../src/sim/rng.ts';
import { Agent } from './agent.ts';
import type { Mode, SiloKnobs } from './config.ts';

export const P_STAY = 0;
export const P_MOVE = 1;
export const P_WAIT = 2;

/** What the sim core hands the traffic controller each tick. */
export interface TrafficInput {
  tick: number;
  /** Robots in PIBT priority order, highest first (oldest goalTick, then higher tb, then lower id). */
  order: readonly number[];
  /** ready[id] === tick: robot is at a cell boundary with a travel goal and may start a move this tick. */
  ready: Int32Array;
  /** occ[cell] = id of the agent holding it (robots and people, including move targets and safety cells), or -1. */
  occ: Int32Array;
  /** Robots yield to people: flattened [robotId, personCell, ...] for ready robots a blocked person wants to pass. */
  yields: readonly number[];
}

/** Decisions are written on the agents: planTo / planSafety / planDir (planTo -1 = stay), want, waitOn. */
export interface TrafficHost {
  world: World;
  agents: readonly Agent[];
  /** Manual reset: move a stuck robot to `cell` (counted, costs supervisor time). */
  teleport(a: Agent, cell: number): void;
  /** Fleet-manager job timeout: give a robot that made no progress another target (another station or job). */
  retask(a: Agent): void;
}

export interface TrafficCounters {
  detours: number;
  detourFails: number;
  randomSteps: number;
  safetyStops: number;
  resets: number;
  /** Ticks with at least one cross-vendor claim conflict. */
  conflicts: number;
  /** Times a robot was asked to make way for a person. */
  yields: number;
  retasks: number;
}

export interface TrafficController {
  readonly mode: Mode;
  readonly counters: TrafficCounters;
  goalHold: boolean;
  plan(input: TrafficInput): void;
}

function manhattan(w: World, a: number, b: number): number {
  const ax = a % w.width;
  const bx = b % w.width;
  const ay = (a - ax) / w.width;
  const by = (b - bx) / w.width;
  return (ax > bx ? ax - bx : bx - ax) + (ay > by ? ay - by : by - ay);
}

abstract class PibtBase implements TrafficController {
  abstract readonly mode: Mode;
  readonly counters: TrafficCounters = { detours: 0, detourFails: 0, randomSteps: 0, safetyStops: 0, resets: 0, conflicts: 0, yields: 0, retasks: 0 };
  protected readonly w: World;
  protected readonly agents: readonly Agent[];
  /** resv[g][cell] === tick: planner group g reserved the cell this tick (each brain only sees its own). */
  protected readonly resv: Int32Array[];
  protected readonly decided: Int32Array;
  /** Cell any agent could ever stand on (for forklift safety cells). */
  protected readonly open: Uint8Array;
  private readonly candCell: Int32Array;
  private readonly candKey: Int32Array;
  private readonly candDir: Int32Array;
  private readonly bfsStamp: Int32Array;
  private readonly q: Int32Array;
  private readonly gd: Int32Array;
  private readonly parent: Int32Array;
  private stamp = 0;
  private readonly path = new Int32Array(64);
  private readonly stepDirs = new Int32Array(4);
  protected tick = 0;
  protected occ!: Int32Array;
  protected ready!: Int32Array;
  protected readonly resetTicks: number;
  protected readonly retaskTicks: number;
  /** Station protocol: while the goal is taken, don't step next to it (wait 2 back, keep the exit free). */
  goalHold = false;

  constructor(protected readonly host: TrafficHost, groups: number, protected readonly knobs: SiloKnobs,
    protected readonly ladderRng: Rng[]) {
    this.w = host.world;
    this.agents = host.agents;
    const n = this.w.n;
    this.resv = [];
    for (let g = 0; g < groups; g++) this.resv.push(new Int32Array(n).fill(-1));
    this.decided = new Int32Array(this.agents.length).fill(-1);
    this.open = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.open[i] = this.w.passable[0][i] | this.w.passable[1][i] | this.w.passable[2][i];
    const depth = this.agents.length + 2;
    this.candCell = new Int32Array(depth * 5);
    this.candKey = new Int32Array(depth * 5);
    this.candDir = new Int32Array(depth * 5);
    this.bfsStamp = new Int32Array(n).fill(-1);
    this.q = new Int32Array(n);
    this.gd = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.resetTicks = knobs.resetMin * 120;
    this.retaskTicks = Math.round(knobs.retaskMin * 120);
  }

  abstract plan(input: TrafficInput): void;

  /** Planner group of an agent (index into resv). */
  protected abstract groupOf(a: Agent): number;

  /** For a's obstacle avoidance: is b (holding a cell within sensor range) something a must go around? */
  protected abstract isWall(a: Agent, b: Agent): boolean;

  protected begin(input: TrafficInput): void {
    this.tick = input.tick;
    this.occ = input.occ;
    this.ready = input.ready;
  }

  protected isReady(a: Agent): boolean {
    return this.ready[a.id] === this.tick;
  }

  /** A robot that is parked (dwelling, charging): holds its cell, not planning. */
  protected isParked(b: Agent): boolean {
    return b.to < 0 && this.ready[b.id] !== this.tick;
  }

  /** Clear an expired or broken detour. */
  protected checkDetour(a: Agent): void {
    if (a.detourLen === 0) return;
    if (a.detourPos >= a.detourLen || this.tick > a.detourUntil) {
      a.detourLen = 0;
      return;
    }
    const nxt = a.detour[a.detourPos];
    const nbr = this.w.nbr;
    const v = a.cell * 4;
    if (nbr[v] !== nxt && nbr[v + 1] !== nxt && nbr[v + 2] !== nxt && nbr[v + 3] !== nxt) a.detourLen = 0;
  }

  /** Safety cell ahead of `c` when entering it in direction d: -1 none needed, -2 not clear. */
  protected safetyCell(a: Agent, c: number, d: number, g: number): number {
    if (a.safetyCells === 0) return -1;
    const s = this.w.nbr[c * 4 + d];
    if (s < 0 || !this.open[s]) return -1;
    if ((this.occ[s] >= 0 && this.occ[s] !== a.id) || this.resv[g][s] === this.tick) return -2;
    return s;
  }

  protected reservedByAnyone(c: number): boolean {
    for (let g = 0; g < this.resv.length; g++) if (this.resv[g][c] === this.tick) return true;
    return false;
  }

  /**
   * PIBT step for agent a. parentCell >= 0 when a is being pushed by the agent standing there (a must not stay
   * and must not swap into the parent's cell). Returns P_MOVE, P_WAIT (pushed someone, waits for the cell) or P_STAY.
   */
  protected decide(a: Agent, parentCell: number, depth: number): number {
    const tick = this.tick;
    const g = this.groupOf(a);
    const resv = this.resv[g];
    const occ = this.occ;
    const w = this.w;
    const D = a.dist!;
    const v = a.cell;
    this.decided[a.id] = tick;
    a.waitOn = -1;
    a.planTo = -1;
    a.planSafety = -1;

    const base = depth * 5;
    const cc = this.candCell;
    const ck = this.candKey;
    const cd = this.candDir;
    let n = 0;
    const dnext = a.detourLen > 0 ? a.detour[a.detourPos] : -1;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[v * 4 + d];
      if (j < 0 || !a.pass[j] || j === parentCell) continue;
      if (w.isPocket[j] && j !== a.goal) continue;
      const dj = D[j];
      if (dj === UNREACHABLE) continue;
      const diff = (d - a.heading + 4) & 3;
      const turn = diff === 0 ? 0 : diff === 2 ? 2 : 1;
      // ties: keep out of the 1-wide pack lane unless it is the goal, then fewer turns, then E, S, W, N
      const narrow = w.code[j] === CELL_NARROW && j !== a.goal ? 16 : 0;
      const key = j === dnext ? -1 : dj * 32 + narrow + turn * 4 + d;
      let k = n++;
      while (k > 0 && ck[base + k - 1] > key) {
        cc[base + k] = cc[base + k - 1];
        ck[base + k] = ck[base + k - 1];
        cd[base + k] = cd[base + k - 1];
        k--;
      }
      cc[base + k] = j;
      ck[base + k] = key;
      cd[base + k] = d;
    }
    a.want = n > 0 ? cc[base] : -1;
    const canStay = parentCell < 0;
    if (canStay && a.backoff > 0) {
      resv[v] = tick;
      return P_STAY;
    }
    const stayKey = D[v] * 32 + 31;
    const hold = this.goalHold && canStay && D[v] >= 2 && occ[a.goal] >= 0;
    for (let k = 0; k < n; k++) {
      if (canStay && ck[base + k] > stayKey) break; // staying beats this and every later candidate
      const c = cc[base + k];
      if (resv[c] === tick) continue;
      if (hold && D[c] === 1) continue;
      const h = occ[c];
      if (h >= 0) {
        const b = this.agents[h];
        if (!b.robot || this.ready[h] !== tick || this.decided[h] === tick || this.groupOf(b) !== g) continue;
        if (this.decide(b, v, depth + 1) === P_MOVE) {
          a.waitOn = h;
          resv[v] = tick;
          return P_WAIT;
        }
        continue;
      }
      const s = this.safetyCell(a, c, cd[base + k], g);
      if (s === -2) {
        // Safety cell taken: push a negotiable robot out of it (holding c so it can't step into our path), then wait.
        const hs = occ[this.w.nbr[c * 4 + cd[base + k]]];
        if (hs < 0) continue;
        const bs = this.agents[hs];
        if (!bs.robot || this.ready[hs] !== tick || this.decided[hs] === tick || this.groupOf(bs) !== g) continue;
        resv[c] = tick;
        if (this.decide(bs, v, depth + 1) === P_MOVE) {
          a.waitOn = hs;
          resv[v] = tick;
          return P_WAIT;
        }
        resv[c] = -1;
        continue;
      }
      resv[c] = tick;
      if (s >= 0) resv[s] = tick;
      a.planTo = c;
      a.planSafety = s;
      a.planDir = cd[base + k];
      return P_MOVE;
    }
    resv[v] = tick;
    if (a.want >= 0 && occ[a.want] >= 0) a.waitOn = occ[a.want];
    return P_STAY;
  }

  /** Nearest free cell at BFS distance >= 2 (a person pushes the robot clear of the knot), or -1. */
  private resetTarget(a: Agent): number {
    const w = this.w;
    const stamp = ++this.stamp;
    const bs = this.bfsStamp;
    const gd = this.gd;
    const q = this.q;
    let head = 0;
    let tail = 0;
    q[tail++] = a.cell;
    bs[a.cell] = stamp;
    gd[a.cell] = 0;
    while (head < tail) {
      const u = q[head++];
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[u * 4 + d];
        if (j < 0 || !a.pass[j] || w.isPocket[j] || bs[j] === stamp) continue;
        bs[j] = stamp;
        gd[j] = gd[u] + 1;
        if (gd[j] >= 2 && this.occ[j] < 0 && a.dist![j] !== UNREACHABLE && !this.reservedByAnyone(j)) return j;
        q[tail++] = j;
      }
    }
    return -1;
  }

  /**
   * The ladder, run before any planning (priority order, deterministic):
   *  rung 3: no progress for resetMin -> manual reset;  rung 2 (many brains only): every 4 x waitTicks blocked ->
   *  random step aside;  rung 1: every waitTicks blocked (+ jitter) -> bounded local detour around walls.
   */
  protected ladder(order: readonly number[], randomSteps: boolean): void {
    const wt = this.knobs.waitTicks;
    const jitter = this.knobs.jitter;
    for (let i = 0; i < order.length; i++) {
      const a = this.agents[order[i]];
      if (!this.isReady(a)) continue;
      this.checkDetour(a);
      if (a.stuckTicks >= this.resetTicks) {
        const cell = this.resetTarget(a);
        if (cell >= 0) {
          this.host.teleport(a, cell);
          this.counters.resets++;
          this.decided[a.id] = this.tick;
          a.planTo = -1;
          continue;
        }
      }
      if (this.retaskTicks > 0 && a.sinceProgress >= this.retaskTicks) {
        this.host.retask(a);
        this.counters.retasks++;
      }
      if (a.mark1 < 0) {
        if (a.blockedSinceProgress === 0) continue;
        // arm the ladder for this blocked episode (progress disarms it)
        const rng = this.ladderRng[a.vendor];
        a.mark1 = wt + (jitter ? rng.int(wt) : 0);
        a.mark2 = 4 * wt;
      }
      if (randomSteps && a.blockedSinceProgress >= a.mark2) {
        const rng = this.ladderRng[a.vendor];
        a.mark2 = a.blockedSinceProgress + 4 * wt;
        a.mark1 = a.blockedSinceProgress + wt + (jitter ? rng.int(wt) : 0);
        this.randomStep(a);
      } else if (a.blockedSinceProgress >= a.mark1) {
        const rng = this.ladderRng[a.vendor];
        a.mark1 = a.blockedSinceProgress + wt + (jitter ? rng.int(wt) : 0);
        this.computeDetour(a);
      }
    }
  }

  /** Robots yield to people first (every vendor's safety logic does this): pushed with the person as parent. */
  protected yieldToPeople(yields: readonly number[]): void {
    for (let i = 0; i < yields.length; i += 2) {
      const a = this.agents[yields[i]];
      if (!this.isReady(a) || this.decided[a.id] === this.tick) continue;
      this.counters.yields++;
      this.decide(a, yields[i + 1], 0);
    }
  }

  protected pibt(order: readonly number[]): void {
    for (let i = 0; i < order.length; i++) {
      const a = this.agents[order[i]];
      if (this.isReady(a) && this.decided[a.id] !== this.tick) this.decide(a, -1, 0);
    }
  }

  /** Rung 2: a seeded random step to any free neighbour (staying not allowed), then a short backoff. */
  private randomStep(a: Agent): void {
    const w = this.w;
    const g = this.groupOf(a);
    const resv = this.resv[g];
    let n = 0;
    const cells = this.path;
    const dirs = this.stepDirs;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[a.cell * 4 + d];
      if (j < 0 || !a.pass[j] || (w.isPocket[j] && j !== a.goal) || a.dist![j] === UNREACHABLE) continue;
      if (this.occ[j] >= 0 || resv[j] === this.tick) continue;
      if (this.safetyCell(a, j, d, g) === -2) continue;
      cells[n] = j;
      dirs[n] = d;
      n++;
    }
    if (n === 0) return;
    const rng = this.ladderRng[a.vendor];
    const pick = rng.int(n);
    const c = cells[pick];
    const d = dirs[pick];
    const s = this.safetyCell(a, c, d, g);
    this.decided[a.id] = this.tick;
    resv[c] = this.tick;
    if (s >= 0) resv[s] = this.tick;
    a.planTo = c;
    a.planSafety = s;
    a.planDir = d;
    a.want = c;
    a.waitOn = -1;
    a.detourLen = 0;
    a.backoffNext = 1 + rng.int(this.knobs.backoffMax);
    this.counters.randomSteps++;
  }

  /** Rung 1: bounded local detour. Walls (isWall) within sensorCells; beyond that the robot can't see. */
  private computeDetour(a: Agent): void {
    const w = this.w;
    const R = this.knobs.detourRadius;
    const S = this.knobs.sensorCells;
    const D = a.dist!;
    const v = a.cell;
    const stamp = ++this.stamp;
    const bs = this.bfsStamp;
    const gd = this.gd;
    const par = this.parent;
    const q = this.q;
    let head = 0;
    let tail = 0;
    bs[v] = stamp;
    gd[v] = 0;
    par[v] = -1;
    q[tail++] = v;
    const hStart = D[v];
    let best = -1;
    let bestF = 0x7fffffff;
    let bestH = 0x7fffffff;
    let walls = 0;
    while (head < tail) {
      const u = q[head++];
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[u * 4 + d];
        if (j < 0 || !a.pass[j] || bs[j] === stamp) continue;
        if (w.isPocket[j] && j !== a.goal) continue;
        const md = manhattan(w, j, v);
        if (md > R) continue;
        const h = this.occ[j];
        if (h >= 0 && h !== a.id && md <= S && this.isWall(a, this.agents[h])) {
          walls++;
          continue;
        }
        bs[j] = stamp;
        gd[j] = gd[u] + 1;
        par[j] = u;
        q[tail++] = j;
        const hj = D[j];
        if (hj < hStart) {
          const f = gd[j] + hj;
          if (f < bestF || (f === bestF && (hj < bestH || (hj === bestH && j < best)))) {
            best = j;
            bestF = f;
            bestH = hj;
          }
        }
      }
    }
    // No walls in sight: nothing to go around (the blocker is negotiable, PIBT handles it).
    if (walls === 0) return;
    if (best < 0) {
      a.detourLen = 0;
      this.counters.detourFails++;
      return;
    }
    let len = 0;
    for (let c = best; c !== v && c >= 0; c = par[c]) this.path[len++] = c;
    const keep = len < a.detour.length ? len : a.detour.length;
    for (let i = 0; i < keep; i++) a.detour[i] = this.path[len - 1 - i];
    a.detourLen = keep;
    a.detourPos = 0;
    a.detourUntil = this.tick + keep * 4 + this.knobs.waitTicks;
    this.counters.detours++;
  }
}

/** One brain: one PIBT over all robots of every vendor. */
export class CentralController extends PibtBase {
  readonly mode = 'central' as const;

  constructor(host: TrafficHost, knobs: SiloKnobs, ladderRng: Rng[]) {
    super(host, 1, knobs, ladderRng);
  }

  protected groupOf(): number {
    return 0;
  }

  /** People and parked robots; every moving robot is coordinated by the one planner. */
  protected isWall(_a: Agent, b: Agent): boolean {
    return !b.robot || this.isParked(b);
  }

  plan(input: TrafficInput): void {
    this.begin(input);
    this.yieldToPeople(input.yields);
    this.ladder(input.order, false);
    this.pibt(input.order);
  }
}

/** Many brains: one PIBT per vendor, foreign robots are obstacles, a physical layer, and the recovery ladder. */
export class SiloedController extends PibtBase {
  readonly mode = 'siloed' as const;
  private claimStamp: Int32Array;
  private claimBy: Int32Array;
  private acceptStamp: Int32Array;
  private conflictTick: Int32Array;
  private claims: number[] = [];
  private conflicted: number[] = [];

  constructor(host: TrafficHost, knobs: SiloKnobs, vendors: number, ladderRng: Rng[], private readonly physical: Rng) {
    super(host, vendors, knobs, ladderRng);
    const n = host.world.n;
    this.claimStamp = new Int32Array(n).fill(-1);
    this.claimBy = new Int32Array(n);
    this.acceptStamp = new Int32Array(n).fill(-1);
    this.conflictTick = new Int32Array(host.agents.length).fill(-1);
  }

  protected groupOf(a: Agent): number {
    return a.vendor;
  }

  /** People, parked robots, and every robot of another vendor (intentions unknown, can't be pushed). */
  protected isWall(a: Agent, b: Agent): boolean {
    return !b.robot || b.vendor !== a.vendor || this.isParked(b);
  }

  plan(input: TrafficInput): void {
    this.begin(input);
    this.yieldToPeople(input.yields);
    this.ladder(input.order, true);
    // Each vendor's PIBT. Brains are independent (own reservations, push only own robots), so one pass in the
    // global priority order equals running each vendor's PIBT separately.
    this.pibt(input.order);
    this.resolveClaims(input.order);
  }

  /** Physical layer: claims from different vendors on the same cell -> one seeded-random winner, others stop. */
  private resolveClaims(order: readonly number[]): void {
    const tick = this.tick;
    const claims = this.claims;
    claims.length = 0;
    for (let i = 0; i < order.length; i++) {
      const a = this.agents[order[i]];
      if (this.isReady(a) && a.planTo >= 0) claims.push(a.id);
    }
    claims.sort((x, y) => x - y);
    let any = false;
    const cs = this.claimStamp;
    const cb = this.claimBy;
    const ct = this.conflictTick;
    for (let i = 0; i < claims.length; i++) {
      const a = this.agents[claims[i]];
      for (let k = 0; k < 2; k++) {
        const c = k === 0 ? a.planTo : a.planSafety;
        if (c < 0) continue;
        if (cs[c] === tick) {
          ct[a.id] = tick;
          ct[cb[c]] = tick;
          any = true;
        } else {
          cs[c] = tick;
          cb[c] = a.id;
        }
      }
    }
    if (!any) return;
    const acc = this.acceptStamp;
    const conflicted = this.conflicted;
    conflicted.length = 0;
    for (let i = 0; i < claims.length; i++) {
      const a = this.agents[claims[i]];
      if (ct[a.id] === tick) conflicted.push(a.id);
      else {
        acc[a.planTo] = tick;
        if (a.planSafety >= 0) acc[a.planSafety] = tick;
      }
    }
    this.counters.conflicts++;
    this.physical.shuffle(conflicted);
    for (let i = 0; i < conflicted.length; i++) {
      const a = this.agents[conflicted[i]];
      const free = acc[a.planTo] !== tick && (a.planSafety < 0 || acc[a.planSafety] !== tick);
      if (free) {
        acc[a.planTo] = tick;
        if (a.planSafety >= 0) acc[a.planSafety] = tick;
      } else {
        // safety stop: another vendor's robot got there first
        a.want = a.planTo;
        a.planTo = -1;
        a.planSafety = -1;
        a.backoffNext = 0;
        this.counters.safetyStops++;
      }
    }
  }
}

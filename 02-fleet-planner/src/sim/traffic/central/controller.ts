// One brain (Track B): one causal PIBT over every robot of every vendor (PROTOCOL §5). Ported from spike b's
// CentralController (spikes/b-traffic/src/traffic.ts); spikes/b-traffic/RESULTS.md § "Model additions" says why
// each piece exists.
//
// Causal PIBT (Okumura et al., time-independent planning for committed multi-tick moves): a robot may only start a
// move into a cell nobody holds, including one that is being left. Pushing a lower-priority robot out of the way still
// works (priority inheritance), but the pusher waits for the cell to clear, so followers keep one empty cell of
// spacing. Only robots at a cell boundary (ready) plan.
//
// On top of PIBT, for every robot: robots yield to people (a person blocked by a robot pushes it, the person's cell
// as the parent), forklifts keep a safety cell ahead clear (a robot standing in it is pushed out), pockets are entered
// only as a goal, and a robot blocked waitTicks by something it can't push (a person, a parked or broken robot) plans
// a bounded local detour around it. No recovery ladder: recover() only returns a manual reset for a robot with no
// progress for 5 minutes (the same rule many brains uses).
//
// Integers only, fixed iteration orders (priority order, then E, S, W, N), never mutates sim state, and no
// allocation in the per-tick path except the returned events and recovery lists.
import { TICKS_PER_MIN } from '../../../contracts/types.ts';
import { Cell, classIndex, UNREACHABLE, type DistanceCache, type World } from '../../world.ts';
import type { Recovery, TrafficAgent, TrafficController, TrafficInput, TrafficPlan } from '../types.ts';

export interface CentralOptions {
  /** Blocked ticks before a robot tries a local detour, and between tries (PROTOCOL §5 rule 5). */
  waitTicks: number;
  /** Detour search window: Manhattan cells around the robot. */
  detourRadius: number;
  /** People and parked robots within this Manhattan range are walls for the detour (what its sensors see). */
  sensorCells: number;
  /** A ready robot with no progress for this many ticks gets a manual reset (a person moves it). 0 = never. */
  resetTicks: number;
}

/** Spike b defaults (the same numbers as the many-brains "typical vendor" knobs, so neither mode gets a perk). */
export const CENTRAL_DEFAULTS: CentralOptions = { waitTicks: 5, detourRadius: 6, sensorCells: 3, resetTicks: 5 * TICKS_PER_MIN };

/** A manual reset moves the robot at most this many steps to open floor (else to the nearest free cell). */
export const RESET_REACH = 10;

/** Longest stored detour, in cells. */
export const DETOUR_MAX = 24;

/** Internal counters (part of stateWords). */
export interface CentralCounters {
  /** Detours planned. */
  detours: number;
  /** Detour searches that found walls but no way round. */
  detourFails: number;
  /** Detour tries skipped: no wall in sight, or the same search as the robot's current detour. */
  detourSkips: number;
  /** Robots that made way for a person. */
  yields: number;
  /** PIBT pushes that moved the pushed robot (priority inheritance). */
  pushes: number;
  /** Robots pushed out of a forklift's safety cell. */
  safetyPushes: number;
  /** Manual resets returned by recover(). */
  resets: number;
}

/** Returned when there is nothing to recover (no per-tick allocation). Frozen: the sim must not modify it. */
const NO_RECOVERY: Recovery = Object.freeze({
  resets: Object.freeze([]) as unknown as Recovery['resets'],
  retasks: Object.freeze([]) as unknown as number[],
});

/** Parked robots are pushed after the chain waited this many x waitTicks; off the pusher's own goal, OWN_GOAL_WAIT. */
export const PARKED_WAIT = 2;
export const OWN_GOAL_WAIT = 6;
/** `waited` for a push chain started by a person's yield: people may always move a parked robot. */
const PUSH_ALWAYS = 0x3fffffff;

const P_STAY = 0;
const P_MOVE = 1;
const P_WAIT = 2;

// Candidate sort key, lowest first: cost (distance to goal, +1 against a one-way hint), then against-the-hint, then
// "leave forklift aisles to forklifts" (a robot that may use '.' cells prefers them), then fewer turns, then E, S, W, N.
// Staying ranks after every candidate of the same cost; the next cell of an active detour ranks first (-1).
// Spike b's rule was the opposite ("stay out of the 1-wide pack lane"). With the 2-wide pack lane and pickers kept in
// their zones, keeping small robots off the forklift-rated cross aisle on ties gave about 10% more goals per hour at
// 100 and 150 robots in the Track B harness, and dropping the rule altogether was worse than either.
const K_COST = 128;
const K_AGAINST = 64;
const K_LANE = 16;
const K_TURN = 4;
const K_STAY = 127;

export class CentralController implements TrafficController {
  readonly mode = 'central' as const;
  readonly opts: CentralOptions;
  readonly counters: CentralCounters = { detours: 0, detourFails: 0, detourSkips: 0, yields: 0, pushes: 0, safetyPushes: 0, resets: 0 };

  // ── world scratch (rebuilt when the world changes) ──
  private world: World | null = null;
  private dcache: DistanceCache | null = null;
  /** A cell some class may stand on (forklift safety cells can cover any of them). */
  private open = new Uint8Array(0);
  /** One-way hint per cell: 0 E, 1 S, 2 W, 3 N ('>' 'v' '<' '^'), or -1. */
  private oneWay = new Int8Array(0);
  /** resv[cell] === pass: reserved this planning pass (move target, safety cell, or a robot staying put). */
  private resv = new Int32Array(0);
  /** claimed[cell] === pass: a reset target chosen this recover() pass. */
  private claimed = new Int32Array(0);
  private bfsStamp = new Int32Array(0);
  private q = new Int32Array(0);
  private gd = new Int32Array(0);
  private par = new Int32Array(0);
  private path = new Int32Array(0);
  private cellX = new Int32Array(0);
  private cellY = new Int32Array(0);
  /** Stamp for resv / decided / prepared / claimed; bumped every call so a repeated tick can't collide. */
  private pass = 0;
  /** Stamp for BFS visited marks; bumped every search. */
  private bfsGen = 0;

  // ── per-agent scratch (capacity grows with the largest agent id) ──
  private cap = 0;
  private decided = new Int32Array(0);
  private prepared = new Int32Array(0);
  private distKey = new Int32Array(0);
  private distOf: (Uint16Array | null)[] = [];
  private passOf: (Uint8Array | null)[] = [];
  private candCell = new Int32Array(0);
  private candKey = new Int32Array(0);
  private candDir = new Int32Array(0);

  // ── per-robot controller state (stateWords) ──
  /** Goal seen at the last plan, -1 none. A new goal drops the detour and re-arms the detour timer. */
  private seenGoal = new Int32Array(0);
  /** blockedSinceProgress value at which the next detour try fires. */
  private nextDetourAt = new Int32Array(0);
  /** blockedSinceProgress at the last plan (a drop means progress: re-arm). */
  private lastBlocked = new Int32Array(0);
  /** Tick of the last manual reset, -1 none (at most one per resetTicks even if the sim's counter lags). */
  private lastReset = new Int32Array(0);
  private detour = new Int32Array(0);
  private detourLen = new Int32Array(0);
  private detourPos = new Int32Array(0);
  private detourUntil = new Int32Array(0);
  /** Cell the robot searched from, and who blocked it, at its last detour search (-1 none). */
  private detourFrom = new Int32Array(0);
  private detourBlocker = new Int32Array(0);

  // ── the call being served ──
  private tick = 0;
  private occ: Int32Array = new Int32Array(0);
  private ready: Int32Array = new Int32Array(0);
  private agents: readonly (TrafficAgent | null)[] = [];
  private out: TrafficPlan | null = null;

  constructor(opts: Partial<CentralOptions> = {}) {
    this.opts = { ...CENTRAL_DEFAULTS, ...opts };
  }

  // ───────────── TrafficController ─────────────

  recover(input: TrafficInput): Recovery {
    this.begin(input);
    const rt = this.opts.resetTicks;
    if (rt <= 0) return NO_RECOVERY;
    let resets: Recovery['resets'] | null = null;
    const { order, agents, ready, tick } = input;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const a = agents[id];
      // a robot parked at its goal (ready only so it can be pushed) is never reset
      if (!a || ready[id] !== tick || a.goal < 0 || a.cell === a.goal || a.sinceProgress < rt) continue;
      const last = this.lastReset[id];
      if (last >= 0 && tick - last < rt) continue;
      this.ensureDist(a);
      const cell = this.resetTarget(a);
      if (cell < 0) continue;
      this.claimed[cell] = this.pass;
      this.lastReset[id] = tick;
      this.counters.resets++;
      (resets ??= []).push({ agent: id, cell });
    }
    return resets ? { resets, retasks: [] } : NO_RECOVERY;
  }

  plan(input: TrafficInput, out: TrafficPlan): void {
    this.begin(input);
    this.out = out;
    const { order, agents, ready, tick, yields } = input;
    const pass = this.pass;

    // 1. Every ready robot: distance map, detour bookkeeping, and a detour try when blocked long enough.
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const a = agents[id];
      if (a && ready[id] === tick && a.goal >= 0) this.prepare(a);
    }

    // 2. Robots yield to people: a blocked person pushes the robot in its way (the person's cell is the parent).
    for (let i = 0; i + 1 < yields.length; i += 2) {
      const id = yields[i];
      const a = agents[id];
      if (!a || this.prepared[id] !== pass || this.decided[id] === pass) continue;
      if (this.decide(a, yields[i + 1], 0, PUSH_ALWAYS) === P_MOVE) {
        this.counters.yields++;
        out.events.push({ t: 'yield', agent: id, cell: yields[i + 1] });
      }
    }

    // 3. PIBT in the sim's priority order. Robots parked at their goal (the sim marks them ready so they can be pushed
    //    out of the way) have the lowest priority, as in standard PIBT: they decide last, after everyone who wants to
    //    move has had the chance to push them.
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const a = agents[id];
      if (a && a.cell !== a.goal && this.prepared[id] === pass && this.decided[id] !== pass) this.decide(a, -1, 0, 0);
    }
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const a = agents[id];
      if (a && a.cell === a.goal && this.prepared[id] === pass && this.decided[id] !== pass) this.decide(a, -1, 0, 0);
    }
    this.out = null;
  }

  stateWords(): number[] {
    const c = this.counters;
    const out = [c.detours, c.detourFails, c.detourSkips, c.yields, c.pushes, c.safetyPushes, c.resets];
    const wt = this.opts.waitTicks;
    for (let id = 0; id < this.cap; id++) {
      const len = this.detourLen[id];
      const goal = this.seenGoal[id];
      const next = this.nextDetourAt[id];
      const lastB = this.lastBlocked[id];
      const lastR = this.lastReset[id];
      const from = this.detourFrom[id];
      const blocker = this.detourBlocker[id];
      if (goal === -1 && len === 0 && next === wt && lastB === 0 && lastR === -1 && from === -1 && blocker === -1) continue;
      out.push(id, goal, next, lastB, lastR, from, blocker, len);
      if (len > 0) {
        out.push(this.detourPos[id], this.detourUntil[id]);
        for (let k = 0; k < len; k++) out.push(this.detour[id * DETOUR_MAX + k]);
      }
    }
    return out;
  }

  // ───────────── setup ─────────────

  private begin(input: TrafficInput): void {
    this.pass++;
    if (input.world !== this.world) this.attach(input.world);
    if (input.dist !== this.dcache) {
      this.dcache = input.dist;
      this.distKey.fill(-1);
    }
    if (input.agents.length > this.cap) this.grow(input.agents.length);
    this.tick = input.tick;
    this.occ = input.occ;
    this.ready = input.ready;
    this.agents = input.agents;
  }

  /** A new world (or a layout switch): rebuild the cell scratch and forget every robot's cell-based state. */
  private attach(w: World): void {
    const n = w.n;
    this.world = w;
    this.open = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let o = 0;
      for (let k = 0; k < w.passable.length; k++) o |= w.passable[k][i];
      this.open[i] = o;
    }
    this.oneWay = new Int8Array(n).fill(-1);
    const hint: Record<string, number> = { '>': 0, v: 1, '<': 2, '^': 3 };
    for (let y = 0; y < w.height; y++) {
      const row = w.layout.grid[y];
      for (let x = 0; x < w.width; x++) {
        const h = hint[row[x]];
        if (h !== undefined) this.oneWay[y * w.width + x] = h;
      }
    }
    this.resv = new Int32Array(n);
    this.claimed = new Int32Array(n);
    this.bfsStamp = new Int32Array(n);
    this.q = new Int32Array(n);
    this.gd = new Int32Array(n);
    this.par = new Int32Array(n);
    this.path = new Int32Array(n);
    this.cellX = new Int32Array(n);
    this.cellY = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.cellX[i] = i % w.width;
      this.cellY[i] = (i - this.cellX[i]) / w.width;
    }
    this.dcache = null;
    this.distKey.fill(-1);
    this.seenGoal.fill(-1);
    this.nextDetourAt.fill(this.opts.waitTicks);
    this.lastBlocked.fill(0);
    this.lastReset.fill(-1);
    this.detourLen.fill(0);
    this.detourPos.fill(0);
    this.detourUntil.fill(0);
    this.detourFrom.fill(-1);
    this.detourBlocker.fill(-1);
  }

  private grow(need: number): void {
    const cap = Math.max(need, this.cap * 2, 16);
    const g = (old: Int32Array, fill: number) => {
      const a = new Int32Array(cap).fill(fill);
      a.set(old);
      return a;
    };
    this.decided = g(this.decided, 0);
    this.prepared = g(this.prepared, 0);
    this.distKey = g(this.distKey, -1);
    this.seenGoal = g(this.seenGoal, -1);
    this.nextDetourAt = g(this.nextDetourAt, this.opts.waitTicks);
    this.lastBlocked = g(this.lastBlocked, 0);
    this.lastReset = g(this.lastReset, -1);
    this.detourLen = g(this.detourLen, 0);
    this.detourPos = g(this.detourPos, 0);
    this.detourUntil = g(this.detourUntil, 0);
    this.detourFrom = g(this.detourFrom, -1);
    this.detourBlocker = g(this.detourBlocker, -1);
    const det = new Int32Array(cap * DETOUR_MAX);
    det.set(this.detour);
    this.detour = det;
    for (let i = this.cap; i < cap; i++) {
      this.distOf.push(null);
      this.passOf.push(null);
    }
    // PIBT recursion: each robot is decided at most once per pass, so depth <= robots; 4 candidates per level.
    this.candCell = new Int32Array((cap + 2) * 4);
    this.candKey = new Int32Array((cap + 2) * 4);
    this.candDir = new Int32Array((cap + 2) * 4);
    this.cap = cap;
  }

  private ensureDist(a: TrafficAgent): Uint16Array {
    const id = a.id;
    const w = this.world!;
    const ci = classIndex(a.passClass);
    const key = ci * w.n + a.goal;
    let d = this.distOf[id];
    if (this.distKey[id] !== key || !d) {
      d = this.dcache!.to(a.passClass, a.goal);
      this.distOf[id] = d;
      this.distKey[id] = key;
    }
    this.passOf[id] = w.passable[ci];
    return d;
  }

  /** Per ready robot, before any decision: distance map, detour progress and expiry, and the detour timer. */
  private prepare(a: TrafficAgent): void {
    const id = a.id;
    const wt = this.opts.waitTicks;
    this.ensureDist(a);
    this.prepared[id] = this.pass;
    if (this.seenGoal[id] !== a.goal) {
      this.seenGoal[id] = a.goal;
      this.detourLen[id] = 0;
      this.nextDetourAt[id] = wt;
      this.detourFrom[id] = -1;
      this.detourBlocker[id] = -1;
    }
    // Follow the detour: skip past the robot's cell; drop it when done, expired, or the robot was pushed off it.
    let len = this.detourLen[id];
    if (len > 0) {
      const base = id * DETOUR_MAX;
      let pos = this.detourPos[id];
      for (let k = pos; k < len; k++)
        if (this.detour[base + k] === a.cell) {
          pos = k + 1;
          break;
        }
      this.detourPos[id] = pos;
      if (pos >= len || this.tick > this.detourUntil[id] || !this.adjacent(a.cell, this.detour[base + pos])) {
        this.detourLen[id] = 0;
        len = 0;
      }
    }
    if (a.cell === a.goal) return; // parked: nothing to go round
    // Detour timer: a drop in blocked ticks means progress (or a new goal), so re-arm; then a try every waitTicks.
    const b = a.blockedSinceProgress;
    if (b < this.lastBlocked[id]) this.nextDetourAt[id] = wt;
    this.lastBlocked[id] = b;
    if (b >= this.nextDetourAt[id]) {
      this.nextDetourAt[id] = b + wt;
      // Still on the cell it planned its current detour from, with the same blocker: the search would find the same
      // way round, so keep the detour it has. (Delaying retries after failed searches was tried: they are rare, under
      // 1% of searches, and a boxed-in robot then missed the brief gaps people open; the 3+3 crossing stalled.)
      const blocker = this.blockerOf(a);
      if (len > 0 && this.detourFrom[id] === a.cell && this.detourBlocker[id] === blocker) {
        this.counters.detourSkips++;
        return;
      }
      this.detourFrom[id] = a.cell;
      this.detourBlocker[id] = blocker;
      this.computeDetour(a);
    }
  }

  /** Who holds the robot's preferred next cell (or, for a forklift, the safety cell beyond it): -1 nobody. */
  private blockerOf(a: TrafficAgent): number {
    const w = this.world!;
    const nbr = w.nbr;
    const D = this.distOf[a.id]!;
    const passable = this.passOf[a.id]!;
    let best = -1;
    let bestDir = 0;
    let bestKey = 0x7fffffff;
    for (let d = 0; d < 4; d++) {
      const j = nbr[a.cell * 4 + d];
      if (j < 0 || !passable[j] || (w.isPocket[j] && j !== a.goal) || D[j] === UNREACHABLE) continue;
      const key = this.keyOf(a, j, d, D[j]);
      if (key < bestKey) {
        best = j;
        bestDir = d;
        bestKey = key;
      }
    }
    if (best < 0) return -1;
    if (this.occ[best] >= 0 || a.safetyCells <= 0) return this.occ[best];
    const s = nbr[best * 4 + bestDir];
    return s >= 0 && this.open[s] ? this.occ[s] : -1;
  }

  /** Candidate sort key for moving robot a into neighbour j heading d (see K_COST). */
  private keyOf(a: TrafficAgent, j: number, d: number, dj: number): number {
    const back = (d + 2) & 3;
    const against = this.oneWay[j] === back || this.oneWay[a.cell] === back ? 1 : 0;
    const diff = (d - a.heading + 4) & 3;
    const turn = diff === 0 ? 0 : diff === 2 ? 2 : 1;
    const lane = this.world!.code[j] === Cell.Narrow ? 0 : 1;
    return (dj + against) * K_COST + against * K_AGAINST + lane * K_LANE + turn * K_TURN + d;
  }

  // ───────────── planning ─────────────

  private adjacent(c: number, j: number): boolean {
    const nbr = this.world!.nbr;
    const v = c * 4;
    return nbr[v] === j || nbr[v + 1] === j || nbr[v + 2] === j || nbr[v + 3] === j;
  }

  /**
   * Robot h can be pushed by robot `by` this pass: a ready robot that has not decided yet. A robot parked at its goal
   * (working there, ready only so it can be moved) is pushed only once the push chain has waited: `waited` is the
   * largest blockedSinceProgress along the chain (PUSH_ALWAYS for a person's yield).
   * - 2 x waitTicks: after the detour had the chance to take the robot round.
   * - If the cell is also the pusher's own goal (a station both want), 6 x waitTicks: it waits its turn first, else the
   *   two push each other off in turn and neither finishes; but a robot resting on someone's exact goal (no work to
   *   finish there) can't hold it for ever.
   */
  private pushable(h: number, by: TrafficAgent, waited: number): boolean {
    const b = this.agents[h];
    if (!b || this.prepared[h] !== this.pass || this.decided[h] === this.pass) return false;
    if (b.cell !== b.goal) return true;
    const wt = this.opts.waitTicks;
    return waited >= (by.goal === b.cell ? OWN_GOAL_WAIT : PARKED_WAIT) * wt;
  }

  /** For the detour search: something a robot must go around (a person, or a robot that is parked or broken). */
  private isWall(h: number, cell: number): boolean {
    const b = this.agents[h];
    if (!b) return true; // a person (people are never planned; their views are null)
    if (this.ready[h] === this.tick) return b.cell === b.goal; // ready: the planner can push it, unless it is parked
    if (b.cell !== cell) return false; // cell is its move target or safety cell: it is moving
    const nbr = this.world!.nbr;
    const occ = this.occ;
    for (let d = 0; d < 4; d++) {
      const j = nbr[cell * 4 + d];
      if (j >= 0 && occ[j] === h) return false; // holding a neighbour: moving out
    }
    return true; // dwelling, charging, idle or broken
  }

  /** Safety cell needed ahead of `c` when entering it heading `d`: -1 none needed, -2 needed but not clear. */
  private safetyCell(a: TrafficAgent, c: number, d: number): number {
    if (a.safetyCells <= 0) return -1;
    const s = this.world!.nbr[c * 4 + d];
    if (s < 0 || !this.open[s]) return -1;
    const h = this.occ[s];
    if ((h >= 0 && h !== a.id) || this.resv[s] === this.pass) return -2;
    return s;
  }

  /**
   * PIBT step for robot a. parentCell >= 0 when a is being pushed by whoever stands there (a person or a robot): a
   * must not stay and must not move into the parent's cell. Returns P_MOVE, P_WAIT (pushed someone and waits for the
   * cell to clear) or P_STAY. Writes a's moveTo / safety / dir / want.
   */
  private decide(a: TrafficAgent, parentCell: number, depth: number, chainWaited: number): number {
    const id = a.id;
    const pass = this.pass;
    const w = this.world!;
    const nbr = w.nbr;
    const isPocket = w.isPocket;
    const occ = this.occ;
    const resv = this.resv;
    const out = this.out!;
    const D = this.distOf[id]!;
    const passable = this.passOf[id]!;
    const v = a.cell;
    const goal = a.goal;
    this.decided[id] = pass;
    const waited = a.blockedSinceProgress > chainWaited ? a.blockedSinceProgress : chainWaited;

    // Candidates, sorted by key (insertion sort over at most 4).
    const base = depth * 4;
    const cc = this.candCell;
    const ck = this.candKey;
    const cd = this.candDir;
    let n = 0;
    const dnext = this.detourLen[id] > 0 ? this.detour[id * DETOUR_MAX + this.detourPos[id]] : -1;
    for (let d = 0; d < 4; d++) {
      const j = nbr[v * 4 + d];
      if (j < 0 || !passable[j] || j === parentCell) continue;
      if (isPocket[j] && j !== goal) continue; // pockets only as a goal
      const dj = D[j];
      if (dj === UNREACHABLE) continue;
      const key = j === dnext ? -1 : this.keyOf(a, j, d, dj);
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
    out.want[id] = n > 0 ? cc[base] : -1;

    const canStay = parentCell < 0;
    const stayKey = D[v] * K_COST + K_STAY;
    // A forklift waiting to start its preferred move keeps the free cells of that move (the cell, and the safety cell
    // beyond it) claimed, so robots it outranks can't take them first (without this, a crowd starved forklifts for
    // tens of minutes).
    let hold = -1;
    let holdS = -1;
    for (let k = 0; k < n; k++) {
      if (canStay && ck[base + k] > stayKey) break; // staying beats this and every later candidate
      const c = cc[base + k];
      if (resv[c] === pass) continue;
      const dir = cd[base + k];
      const h = occ[c];
      if (h >= 0 && h !== id) {
        // Held: a person, a moving robot, or a robot that already decided can't be pushed. Never enter a held cell.
        if (!this.pushable(h, a, waited)) {
          if (k === 0 && canStay && a.safetyCells > 0) {
            const sc = nbr[c * 4 + dir];
            if (sc >= 0 && this.open[sc] && occ[sc] < 0 && resv[sc] !== pass) holdS = sc;
          }
          continue;
        }
        if (this.decide(this.agents[h]!, v, depth + 1, waited) === P_MOVE) {
          this.counters.pushes++;
          resv[v] = pass;
          return P_WAIT;
        }
        continue;
      }
      const s = this.safetyCell(a, c, dir);
      if (s === -2) {
        // Safety cell taken: push a robot out of it (holding c so it can't step into our path), then wait.
        const sc = nbr[c * 4 + dir];
        const hs = occ[sc];
        if (k === 0 && canStay) {
          hold = c;
          holdS = hs < 0 ? sc : -1;
        }
        if (hs < 0 || hs === id || !this.pushable(hs, a, waited)) continue;
        resv[c] = pass;
        if (this.decide(this.agents[hs]!, v, depth + 1, waited) === P_MOVE) {
          this.counters.safetyPushes++;
          resv[v] = pass;
          return P_WAIT;
        }
        resv[c] = 0;
        continue;
      }
      resv[c] = pass;
      if (s >= 0) resv[s] = pass;
      out.moveTo[id] = c;
      out.safety[id] = s;
      out.dir[id] = dir;
      out.want[id] = c;
      return P_MOVE;
    }
    resv[v] = pass;
    if (hold >= 0) resv[hold] = pass;
    if (holdS >= 0) resv[holdS] = pass;
    return P_STAY;
  }

  // ───────────── detours and resets ─────────────

  /**
   * Bounded local detour (PROTOCOL §5 rule 5). BFS within detourRadius over the robot's cells, treating people and
   * parked robots within sensorCells as walls (beyond that it can't see them); a forklift also can't take a step whose
   * safety cell holds a wall it can see (spike b's search ignored the field, so a forklift's "detour" ran straight at
   * the person in front of it). Target: the cell closer to the goal than the robot is now with the smallest (path +
   * remaining distance), ties to the smaller remaining distance, then the lower cell index. No wall in sight means the
   * blocker is a robot PIBT can push: nothing to go round.
   */
  private computeDetour(a: TrafficAgent): void {
    const w = this.world!;
    const nbr = w.nbr;
    const X = this.cellX;
    const Y = this.cellY;
    const R = this.opts.detourRadius;
    const S = this.opts.sensorCells;
    const D = this.distOf[a.id]!;
    const passable = this.passOf[a.id]!;
    const occ = this.occ;
    const v = a.cell;
    const vx = X[v];
    const vy = Y[v];
    // Exact shortcut: with no person or parked robot within sensor range the search would count no walls and return
    // without a detour (its walls are a subset of these cells), so skip it. About two thirds of searches at 150 robots.
    if (!this.wallInSight(a, vx, vy, S)) {
      this.counters.detourSkips++;
      return;
    }
    const stamp = ++this.bfsGen;
    const bs = this.bfsStamp;
    const gd = this.gd;
    const par = this.par;
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
    const safety = a.safetyCells > 0;
    while (head < tail) {
      const u = q[head++];
      for (let d = 0; d < 4; d++) {
        const j = nbr[u * 4 + d];
        if (j < 0 || !passable[j] || bs[j] === stamp) continue;
        if (w.isPocket[j] && j !== a.goal) continue;
        const jx = X[j];
        const jy = Y[j];
        const md = (jx > vx ? jx - vx : vx - jx) + (jy > vy ? jy - vy : vy - jy);
        if (md > R) continue;
        const h = occ[j];
        if (h >= 0 && h !== a.id && md <= S && this.isWall(h, j)) {
          walls++;
          continue;
        }
        if (safety) {
          // A forklift can't make this step while a wall it can see stands in the safety cell beyond (j stays open
          // to the other directions).
          const s = nbr[j * 4 + d];
          const hs = s >= 0 && this.open[s] ? occ[s] : -1;
          if (hs >= 0 && hs !== a.id) {
            const sx = X[s];
            const sy = Y[s];
            if ((sx > vx ? sx - vx : vx - sx) + (sy > vy ? sy - vy : vy - sy) <= S && this.isWall(hs, s)) {
              walls++;
              continue;
            }
          }
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
    if (walls === 0) return;
    if (best < 0) {
      this.detourLen[a.id] = 0;
      this.counters.detourFails++;
      return;
    }
    const path = this.path;
    let len = 0;
    for (let c = best; c !== v && c >= 0; c = par[c]) path[len++] = c;
    const keep = len < DETOUR_MAX ? len : DETOUR_MAX;
    const base = a.id * DETOUR_MAX;
    for (let i = 0; i < keep; i++) this.detour[base + i] = path[len - 1 - i];
    this.detourLen[a.id] = keep;
    this.detourPos[a.id] = 0;
    this.detourUntil[a.id] = this.tick + keep * 4 + this.opts.waitTicks;
    this.counters.detours++;
    this.out!.events.push({ t: 'detour', agent: a.id, cell: best });
  }

  /** Any cell within Manhattan range S of (vx, vy) held by a wall for robot a (a person, a parked robot). */
  private wallInSight(a: TrafficAgent, vx: number, vy: number, S: number): boolean {
    const w = this.world!;
    const occ = this.occ;
    for (let dy = -S; dy <= S; dy++) {
      const y = vy + dy;
      if (y < 0 || y >= w.height) continue;
      const r = S - (dy < 0 ? -dy : dy);
      const x0 = vx - r < 0 ? 0 : vx - r;
      const x1 = vx + r >= w.width ? w.width - 1 : vx + r;
      for (let x = x0; x <= x1; x++) {
        const c = y * w.width + x;
        const h = occ[c];
        if (h >= 0 && h !== a.id && this.isWall(h, c)) return true;
      }
    }
    return false;
  }

  /**
   * Manual reset target (a person walks over and wheels the robot clear of the knot): the nearest cell at least 2 steps
   * away that is free with all its neighbours free (open floor), within RESET_REACH steps; failing that, the nearest
   * free cell at least 2 steps away. Never a pocket, never a cell the goal can't be reached from, never one already
   * chosen this pass. -1 if none. (Spike b used the nearest free cell; inside a jam that is a hole the jam needs, so the
   * robot was put straight back into it.)
   */
  private resetTarget(a: TrafficAgent): number {
    const w = this.world!;
    const nbr = w.nbr;
    const passable = this.passOf[a.id]!;
    const D = this.distOf[a.id]!;
    const occ = this.occ;
    const stamp = ++this.bfsGen;
    const claimed = this.claimed;
    const pass = this.pass;
    const bs = this.bfsStamp;
    const gd = this.gd;
    const q = this.q;
    let head = 0;
    let tail = 0;
    let fallback = -1;
    q[tail++] = a.cell;
    bs[a.cell] = stamp;
    gd[a.cell] = 0;
    while (head < tail) {
      const u = q[head++];
      if (gd[u] >= RESET_REACH && fallback >= 0) break;
      for (let d = 0; d < 4; d++) {
        const j = nbr[u * 4 + d];
        if (j < 0 || !passable[j] || w.isPocket[j] || bs[j] === stamp) continue;
        bs[j] = stamp;
        gd[j] = gd[u] + 1;
        q[tail++] = j;
        if (gd[j] < 2 || occ[j] >= 0 || D[j] === UNREACHABLE || claimed[j] === pass) continue;
        if (fallback < 0) fallback = j;
        if (gd[j] <= RESET_REACH && this.openFloor(j)) return j;
      }
    }
    return fallback;
  }

  /** Every standable neighbour of c is free and unclaimed. */
  private openFloor(c: number): boolean {
    const nbr = this.world!.nbr;
    for (let d = 0; d < 4; d++) {
      const j = nbr[c * 4 + d];
      if (j >= 0 && this.open[j] && (this.occ[j] >= 0 || this.claimed[j] === this.pass)) return false;
    }
    return true;
  }
}

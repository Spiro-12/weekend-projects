// Test traffic controllers for Track A's sim-core tests (not shipped). Track B owns the real one-brain planner; these
// only have to be correct (never plan into a held cell) and good enough that work keeps flowing, so the core's order
// flow, Little's law and uplift numbers can be checked before B lands.
//
// TestPibtController: a small causal PIBT (an agent only starts a move into a free cell; pushing a ready robot makes it
// step away and the pusher waits), robots yield to people, forklifts reserve their safety cell, pockets only as a goal,
// a side step once a robot has been blocked a while (stands in for B's detours), and a manual reset after 5 minutes
// without progress (the same rule B's recover() uses). Integers only; deterministic.
import type { TrafficMode } from '../../../../src/contracts/types.ts';
import { NaiveController } from '../../../../src/sim/traffic/naive.ts';
import type { Recovery, TrafficAgent, TrafficController, TrafficEvent, TrafficInput, TrafficPlan } from '../../../../src/sim/traffic/types.ts';
import { classIndex, UNREACHABLE, type World } from '../../../../src/sim/world.ts';

const MOVE = 1;
const WAIT = 2;
const STAY = 0;
export const RESET_TICKS = 5 * 120;

export class TestPibtController implements TrafficController {
  private resv = new Int32Array(0);
  private decided = new Int32Array(0);
  private seen = new Int32Array(0);
  private queue = new Int32Array(0);
  private stamp = 0;
  private open = new Uint8Array(0);
  private tick = 0;
  private input!: TrafficInput;
  private out!: TrafficPlan;
  private readonly cand = new Int32Array(64 * 4);
  private readonly candKey = new Int32Array(64 * 4);
  private readonly candDir = new Int32Array(64 * 4);
  private moves = 0;
  private resets = 0;

  constructor(readonly mode: TrafficMode = 'central') {}

  private init(w: World, agents: number): void {
    if (this.resv.length !== w.n) {
      this.resv = new Int32Array(w.n).fill(-1);
      this.seen = new Int32Array(w.n).fill(-1);
      this.queue = new Int32Array(w.n);
      this.open = new Uint8Array(w.n);
      for (let i = 0; i < w.n; i++) this.open[i] = w.passable[0][i] | w.passable[1][i] | w.passable[2][i];
    }
    if (this.decided.length < agents) this.decided = new Int32Array(agents * 2).fill(-1);
  }

  recover(input: TrafficInput): Recovery {
    this.init(input.world, input.agents.length);
    const resets: { agent: number; cell: number }[] = [];
    for (const id of input.order) {
      const a = input.agents[id];
      if (!a || input.ready[id] !== input.tick || a.sinceProgress < RESET_TICKS) continue;
      const cell = this.freeCellAway(input, a, resets);
      if (cell >= 0) resets.push({ agent: id, cell });
    }
    this.resets += resets.length;
    return { resets, retasks: [] };
  }

  /** Nearest free cell at BFS distance ≥ 2 (a person pushes the robot clear of the knot). */
  private freeCellAway(input: TrafficInput, a: TrafficAgent, taken: { cell: number }[]): number {
    const w = input.world;
    const pass = w.passable[classIndex(a.passClass)];
    const st = ++this.stamp;
    let head = 0;
    let tail = 0;
    this.queue[tail++] = a.cell;
    this.seen[a.cell] = st;
    const depth = new Map<number, number>([[a.cell, 0]]);
    while (head < tail) {
      const u = this.queue[head++];
      for (let d = 0; d < 4; d++) {
        const j = w.nbr[u * 4 + d];
        if (j < 0 || !pass[j] || w.isPocket[j] || this.seen[j] === st) continue;
        this.seen[j] = st;
        const dj = depth.get(u)! + 1;
        depth.set(j, dj);
        if (dj >= 2 && input.occ[j] < 0 && !taken.some((x) => x.cell === j) && input.dist.to(a.passClass, a.goal)[j] !== UNREACHABLE) return j;
        this.queue[tail++] = j;
      }
    }
    return -1;
  }

  plan(input: TrafficInput, out: TrafficPlan): void {
    this.init(input.world, input.agents.length);
    this.input = input;
    this.out = out;
    this.tick = input.tick;
    for (let i = 0; i < input.yields.length; i += 2) {
      const id = input.yields[i];
      const a = input.agents[id];
      if (!a || input.ready[id] !== input.tick || this.decided[id] === input.tick) continue;
      out.events.push({ t: 'yield', agent: id, cell: input.yields[i + 1] } as TrafficEvent);
      this.decide(a, input.yields[i + 1], 0);
    }
    for (const id of input.order) {
      const a = input.agents[id];
      if (a && input.ready[id] === input.tick && this.decided[id] !== input.tick) this.decide(a, -1, 0);
    }
  }

  private decide(a: TrafficAgent, parentCell: number, depth: number): number {
    const { world: w, occ, dist, ready, agents } = this.input;
    const out = this.out;
    const tick = this.tick;
    this.decided[a.id] = tick;
    const pass = w.passable[classIndex(a.passClass)];
    const D = dist.to(a.passClass, a.goal);
    const v = a.cell;
    const base = depth * 4;
    if (base + 4 > this.cand.length) {
      this.resv[v] = tick;
      return STAY;
    }
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[v * 4 + d];
      if (j < 0 || !pass[j] || j === parentCell || (w.isPocket[j] && j !== a.goal) || D[j] === UNREACHABLE) continue;
      const diff = (d - a.heading + 4) & 3;
      const turn = diff === 0 ? 0 : diff === 2 ? 2 : 1;
      const key = D[j] * 32 + turn * 4 + d;
      let k = n++;
      while (k > 0 && this.candKey[base + k - 1] > key) {
        this.cand[base + k] = this.cand[base + k - 1];
        this.candKey[base + k] = this.candKey[base + k - 1];
        this.candDir[base + k] = this.candDir[base + k - 1];
        k--;
      }
      this.cand[base + k] = j;
      this.candKey[base + k] = key;
      this.candDir[base + k] = d;
    }
    out.want[a.id] = n > 0 && this.candKey[base] < D[v] * 32 ? this.cand[base] : -1;
    const stayKey = D[v] * 32 + 31;
    // after a while blocked, a robot may also step to a worse cell (a crude stand-in for B's detours)
    const patience = 6 + (a.id % 7);
    const mayWorsen = parentCell >= 0 || (a.blockedSinceProgress >= patience && (tick + a.id) % 3 === 0);
    for (let k = 0; k < n; k++) {
      if (!mayWorsen && this.candKey[base + k] > stayKey) break;
      const c = this.cand[base + k];
      const d = this.candDir[base + k];
      if (this.resv[c] === tick) continue;
      const h = occ[c];
      if (h >= 0) {
        const b = h < agents.length ? agents[h] : null;
        if (!b || ready[h] !== tick || this.decided[h] === tick) continue;
        if (this.decide(b, v, depth + 1) === MOVE) {
          this.resv[v] = tick;
          return WAIT;
        }
        continue;
      }
      let s = -1;
      if (a.safetyCells > 0) {
        const sc = w.nbr[c * 4 + d];
        if (sc >= 0 && this.open[sc]) {
          if ((occ[sc] >= 0 && occ[sc] !== a.id) || this.resv[sc] === tick) continue;
          s = sc;
        }
      }
      this.resv[c] = tick;
      if (s >= 0) this.resv[s] = tick;
      out.moveTo[a.id] = c;
      out.safety[a.id] = s;
      out.dir[a.id] = d;
      if (out.want[a.id] < 0) out.want[a.id] = c;
      this.moves++;
      return MOVE;
    }
    this.resv[v] = tick;
    return STAY;
  }

  stateWords(): number[] {
    return [this.moves, this.resets];
  }
}

/** Naive traffic plus scripted recovery decisions and events, for the event-mapping tests. */
export class ScriptedController implements TrafficController {
  private readonly inner = new NaiveController();
  readonly mode: TrafficMode = 'central';
  constructor(
    private readonly script: {
      resets?: (input: TrafficInput) => { agent: number; cell: number }[];
      retasks?: (input: TrafficInput) => number[];
      events?: (input: TrafficInput) => TrafficEvent[];
    },
  ) {}

  recover(input: TrafficInput): Recovery {
    return { resets: this.script.resets?.(input) ?? [], retasks: this.script.retasks?.(input) ?? [] };
  }

  plan(input: TrafficInput, out: TrafficPlan): void {
    this.inner.plan(input, out);
    for (const e of this.script.events?.(input) ?? []) out.events.push(e);
  }

  stateWords(): number[] {
    return [];
  }
}

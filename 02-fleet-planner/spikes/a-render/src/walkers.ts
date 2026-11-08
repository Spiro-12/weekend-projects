// Throwaway agent motion for the render spike: random goals, BFS-gradient routes, one cell per move, no traffic logic.
// Moves start and end on 0.5 s tick boundaries like the real sim; the renderer interpolates between cells.
import { DistanceCache, Cell, type World } from '../../../src/sim/world.ts';
import { Rng } from '../../../src/sim/rng.ts';
import type { PassClass } from '../../../src/contracts/types.ts';

export type Kind = 'amr' | 'forklift' | 'person';
const TICK = 0.5;
/** Ticks per cell (1.5 m): AMR and forklift 1.5 m/s, people 1.0 m/s. */
const TICKS_PER_CELL: Record<Kind, number> = { amr: 2, forklift: 2, person: 3 };
const CLASS: Record<Kind, PassClass> = { amr: 'small', forklift: 'forklift', person: 'human' };

export interface Walker {
  kind: Kind;
  /** 0 or 1 (AMR vendor A or D), 2 forklift vendor B. */
  vendor: number;
  from: number;
  to: number;
  t0: number;
  t1: number;
  goal: number;
  /** Cells after `to` toward the goal (for ribbons), at most ROUTE_MAX. */
  route: number[];
  /** Seconds left standing at the goal. */
  dwellUntil: number;
  // Render state, updated by `pose()`.
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** Between two different cells right now. */
  moving: boolean;
  dist: number;
  /** 0..1 lift (forks or AMR top) during dwell. */
  lift: number;
}

export const ROUTE_MAX = 10;

export class WalkerSim {
  readonly walkers: Walker[] = [];
  private rng: Rng;
  private cache: DistanceCache;
  private goals: Record<PassClass, number[]>;
  private t = 0;

  constructor(
    readonly world: World,
    seed: number,
    counts: { amr: number; forklift: number; person: number },
    readonly cellX: Float32Array,
    readonly cellZ: Float32Array,
  ) {
    this.rng = new Rng(seed);
    this.cache = new DistanceCache(world);
    const pool = (cls: PassClass, ok: (i: number) => boolean) => {
      const pass = world.passable[cls === 'small' ? 0 : cls === 'forklift' ? 1 : 2];
      const cells: number[] = [];
      for (let i = 0; i < world.n; i++) if (pass[i] && !world.isPocket[i] && ok(i)) cells.push(i);
      return this.rng.shuffle(cells).slice(0, 160);
    };
    const faceCells = new Set(world.faces.map((f) => f.cell));
    this.goals = {
      small: pool('small', (i) => faceCells.has(i) || world.packStations.some((s) => s.service === i)),
      forklift: pool('forklift', (i) => faceCells.has(i) || world.code[i] === Cell.Staging),
      human: pool('human', (i) => faceCells.has(i)),
    };
    const spawn = (kind: Kind, vendor: number) => {
      const cls = CLASS[kind];
      const start = this.rng.pick(this.goals[cls]);
      const w: Walker = {
        kind, vendor, from: start, to: start, t0: 0, t1: 0, goal: start, route: [],
        dwellUntil: this.rng.int(8) * TICK, x: cellX[start], z: cellZ[start], moving: false, yaw: this.rng.int(4) * (Math.PI / 2), speed: 0, dist: 0, lift: 0,
      };
      this.walkers.push(w);
    };
    for (let i = 0; i < counts.amr; i++) spawn('amr', i % 5 < 3 ? 0 : 1);
    for (let i = 0; i < counts.forklift; i++) spawn('forklift', 2);
    for (let i = 0; i < counts.person; i++) spawn('person', 3);
  }

  count(kind: Kind): number {
    return this.walkers.filter((w) => w.kind === kind).length;
  }

  /** Advance all moves up to sim time `t` (seconds). Independent of frame rate. */
  advanceTo(t: number): void {
    this.t = t;
    for (const w of this.walkers) {
      let guard = 0;
      while (w.t1 <= t && guard++ < 64) this.nextMove(w);
    }
  }

  private nextMove(w: Walker): void {
    const cls = CLASS[w.kind];
    w.from = w.to;
    w.t0 = w.t1;
    if (w.from === w.goal) {
      if (w.dwellUntil < w.t0) {
        // Arrived: dwell for 2 to 6 s, then pick a new goal.
        w.dwellUntil = w.t0 + (4 + this.rng.int(9)) * TICK;
      }
      if (w.t0 < w.dwellUntil) {
        w.t1 = w.dwellUntil;
        w.route = [];
        return;
      }
      let g = w.goal;
      for (let k = 0; k < 4 && g === w.goal; k++) g = this.rng.pick(this.goals[cls]);
      w.goal = g;
    }
    const next = this.cache.next(cls, w.from, w.goal);
    if (next < 0) {
      w.goal = w.from; // unreachable goal: dwell and retry
      w.t1 = w.t0 + TICK;
      return;
    }
    w.to = next;
    w.t1 = w.t0 + TICKS_PER_CELL[w.kind] * TICK;
    w.route = this.cache.route(cls, next, w.goal, ROUTE_MAX);
  }

  /** Interpolated render pose at sim time `t` (call after advanceTo). `dt` is the real frame time for smoothing. */
  pose(t: number, dt: number): void {
    // dt <= 0 (a frozen frame) snaps every smoothed value.
    const k = dt > 0 ? 1 - Math.exp(-dt * 10) : 1;
    const { cellX, cellZ } = this;
    for (const w of this.walkers) {
      const ax = cellX[w.from];
      const az = cellZ[w.from];
      const bx = cellX[w.to];
      const bz = cellZ[w.to];
      const span = w.t1 - w.t0;
      const a = span > 0 ? Math.min(1, Math.max(0, (t - w.t0) / span)) : 1;
      const nx = ax + (bx - ax) * a;
      const nz = az + (bz - az) * a;
      const moved = Math.hypot(nx - w.x, nz - w.z);
      w.dist += moved;
      w.speed += ((dt > 0 ? moved / dt : 0) - w.speed) * k;
      w.x = nx;
      w.z = nz;
      w.moving = w.from !== w.to && t < w.t1;
      if (w.from !== w.to) {
        const target = Math.atan2(-(bz - az), bx - ax);
        let d = target - w.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        w.yaw += d * Math.min(1, k * 1.6);
      }
      // Lift up during a dwell, down while moving.
      const dwelling = w.from === w.to && t < w.dwellUntil;
      const liftTarget = dwelling ? (w.kind === 'forklift' ? 1 : 0.6) : 0;
      w.lift += (liftTarget - w.lift) * Math.min(1, k * (dt > 0 ? 0.4 : 1));
    }
  }

  get time(): number {
    return this.t;
  }
}

// Deadlocks (wait-for cycles that persist >= 10 ticks) and jams (>= 3 agents stopped >= 20 ticks within 5 cells).
import type { World } from '../../../src/sim/world.ts';
import type { Agent } from './agent.ts';

export const DEADLOCK_MIN_TICKS = 10;
export const JAM_STOP_TICKS = 20;
export const JAM_RADIUS = 5;
export const JAM_MIN_AGENTS = 3;

interface Cycle {
  key: number;
  start: number;
  seen: number;
  counted: boolean;
  size: number;
}

export class DeadlockTracker {
  private visit: Int32Array;
  private walk = 0;
  private active: Cycle[] = [];
  private ids: number[] = [];
  /** Cycles that lasted >= DEADLOCK_MIN_TICKS. */
  count = 0;
  /** Longest cycle that has ended, in ticks. */
  maxEnded = 0;
  /** Total ticks spent in counted deadlocks (for the mean). */
  totalTicks = 0;
  /** Number of deadlocks lasting > 2 min (240 ticks). */
  over2min = 0;
  /** Largest cycle seen (agents). */
  maxSize = 0;

  constructor(n: number) {
    this.visit = new Int32Array(n);
  }

  /** edge[i] = agent i waits on, or -1. Call once per tick. */
  update(tick: number, edge: Int32Array, measuring: boolean): void {
    const n = edge.length;
    const base = this.walk;
    const visit = this.visit;
    const ids = this.ids;
    for (let i = 0; i < n; i++) {
      if (edge[i] < 0 || visit[i] > base) continue;
      const wid = ++this.walk;
      let j = i;
      while (j >= 0 && visit[j] <= base) {
        visit[j] = wid;
        j = edge[j];
      }
      if (j < 0 || visit[j] !== wid) continue;
      // cycle through j
      ids.length = 0;
      let k = j;
      do {
        ids.push(k);
        k = edge[k];
      } while (k !== j);
      ids.sort((x, y) => x - y);
      let key = 0x811c9dc5;
      for (let m = 0; m < ids.length; m++) key = Math.imul(key ^ ids[m], 0x01000193) >>> 0;
      let c: Cycle | undefined;
      for (let m = 0; m < this.active.length; m++) if (this.active[m].key === key) c = this.active[m];
      if (!c) {
        c = { key, start: tick, seen: tick, counted: false, size: ids.length };
        this.active.push(c);
      }
      c.seen = tick;
      if (!c.counted && tick - c.start + 1 >= DEADLOCK_MIN_TICKS) {
        c.counted = true;
        if (measuring) this.count++;
        if (c.size > this.maxSize) this.maxSize = c.size;
      }
    }
    // end cycles not seen this tick
    let w = 0;
    for (let m = 0; m < this.active.length; m++) {
      const c = this.active[m];
      if (c.seen === tick) this.active[w++] = c;
      else this.end(c, tick);
    }
    this.active.length = w;
  }

  private end(c: Cycle, tick: number): void {
    const dur = tick - c.start;
    if (c.counted) {
      if (dur > this.maxEnded) this.maxEnded = dur;
      this.totalTicks += dur;
      if (dur > 240) this.over2min++;
    }
  }

  /** Longest still-active cycle at `tick` (a permanent gridlock shows up here). */
  longestActive(tick: number): number {
    let m = 0;
    for (const c of this.active) if (tick - c.start + 1 > m) m = tick - c.start + 1;
    return m;
  }

  state(): number[] {
    return [this.count, this.maxEnded, this.totalTicks, this.over2min, this.maxSize, this.active.length];
  }
}

export class JamTracker {
  private list: number[] = [];
  private comp: Int32Array;
  private prevJam: Uint8Array;
  private nowJam: Uint8Array;
  starts = 0;
  maxAgents = 0;

  constructor(n: number, private readonly w: World) {
    this.comp = new Int32Array(n);
    this.prevJam = new Uint8Array(n);
    this.nowJam = new Uint8Array(n);
  }

  update(agents: readonly Agent[], measuring: boolean): void {
    const list = this.list;
    list.length = 0;
    for (let i = 0; i < agents.length; i++) if (agents[i].stoppedRun >= JAM_STOP_TICKS) list.push(i);
    const now = this.nowJam;
    now.fill(0);
    if (list.length >= JAM_MIN_AGENTS) {
      const W = this.w.width;
      const comp = this.comp;
      for (const i of list) comp[i] = -1;
      let nc = 0;
      const stack: number[] = [];
      for (const s of list) {
        if (comp[s] >= 0) continue;
        comp[s] = nc;
        stack.length = 0;
        stack.push(s);
        const members: number[] = [];
        while (stack.length) {
          const u = stack.pop()!;
          members.push(u);
          const cu = agents[u].cell;
          const ux = cu % W;
          const uy = (cu - ux) / W;
          for (const v of list) {
            if (comp[v] >= 0) continue;
            const cv = agents[v].cell;
            const vx = cv % W;
            const vy = (cv - vx) / W;
            const d = (ux > vx ? ux - vx : vx - ux) + (uy > vy ? uy - vy : vy - uy);
            if (d <= JAM_RADIUS) {
              comp[v] = nc;
              stack.push(v);
            }
          }
        }
        nc++;
        if (members.length >= JAM_MIN_AGENTS) {
          let continuing = false;
          for (const m of members) if (this.prevJam[m]) continuing = true;
          if (!continuing && measuring) this.starts++;
          if (members.length > this.maxAgents) this.maxAgents = members.length;
          for (const m of members) now[m] = 1;
        }
      }
    }
    this.prevJam.set(now);
  }
}

// Deadlock and jam detection (PROTOCOL §6). Lead-owned shared module used by every traffic mode.
// Integers only, deterministic: agents are visited in id order and cycles are keyed by their sorted member ids.

/** A deadlock = a wait-for cycle that lasts at least this many ticks (5 s). */
export const DEADLOCK_MIN_TICKS = 10;
/** A jam = at least JAM_MIN_AGENTS agents stopped JAM_MIN_TICKS (10 s) or more, within JAM_RADIUS cells of each other. */
export const JAM_MIN_AGENTS = 3;
export const JAM_MIN_TICKS = 20;
export const JAM_RADIUS = 5;

/**
 * Cycles in a functional wait-for graph: waitFor[i] = j means agent i waits for agent j (-1 = not waiting).
 * Each agent waits for at most one other, so this is pointer chasing in O(n). Returns each cycle once,
 * as member ids in ascending order, cycles sorted by their smallest member.
 */
export function findCycles(waitFor: ArrayLike<number>): number[][] {
  const n = waitFor.length;
  const color = new Uint8Array(n); // 0 new, 1 on current path, 2 done
  const cycles: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (color[s]) continue;
    const path: number[] = [];
    let v = s;
    while (v >= 0 && v < n && color[v] === 0) {
      color[v] = 1;
      path.push(v);
      v = waitFor[v];
    }
    if (v >= 0 && v < n && color[v] === 1) {
      const at = path.indexOf(v);
      cycles.push(path.slice(at).sort((a, b) => a - b));
    }
    for (const p of path) color[p] = 2;
  }
  cycles.sort((a, b) => a[0] - b[0]);
  return cycles;
}

export interface DeadlockInfo {
  id: number;
  ids: number[];
  sinceTick: number;
  started: boolean;
}

/** Tracks cycles across ticks; reports a deadlock once a cycle has lasted DEADLOCK_MIN_TICKS. */
export class DeadlockTracker {
  private live = new Map<string, DeadlockInfo>();
  private nextId = 1;
  total = 0;

  update(tick: number, waitFor: ArrayLike<number>): { started: DeadlockInfo[]; ended: DeadlockInfo[] } {
    const seen = new Set<string>();
    const started: DeadlockInfo[] = [];
    for (const ids of findCycles(waitFor)) {
      const key = ids.join(',');
      seen.add(key);
      let d = this.live.get(key);
      if (!d) {
        d = { id: 0, ids, sinceTick: tick, started: false };
        this.live.set(key, d);
      }
      if (!d.started && tick - d.sinceTick + 1 >= DEADLOCK_MIN_TICKS) {
        d.started = true;
        d.id = this.nextId++;
        this.total++;
        started.push(d);
      }
    }
    const ended: DeadlockInfo[] = [];
    for (const key of [...this.live.keys()].sort()) {
      if (seen.has(key)) continue;
      const d = this.live.get(key)!;
      this.live.delete(key);
      if (d.started) ended.push(d);
    }
    return { started, ended };
  }

  /** Deadlocks currently active (started and not ended), oldest first. */
  active(): DeadlockInfo[] {
    return [...this.live.values()].filter((d) => d.started).sort((a, b) => a.sinceTick - b.sinceTick || a.ids[0] - b.ids[0]);
  }
}

export interface JamInfo {
  id: number;
  agents: number[];
  /** A representative cell (the stopped agent with the lowest id). */
  cell: number;
  sinceTick: number;
}

/**
 * Tracks jams. Input per tick: for each agent its cell index and how many ticks it has been stopped while wanting
 * to move (blockedTicks). A jam keeps its id while it shares at least one agent with the jam of the previous tick.
 */
export class JamTracker {
  private live: JamInfo[] = [];
  private nextId = 1;
  total = 0;

  constructor(private width: number) {}

  update(tick: number, cells: ArrayLike<number>, blockedTicks: ArrayLike<number>): { started: JamInfo[]; ended: JamInfo[] } {
    const stopped: number[] = [];
    for (let i = 0; i < cells.length; i++) if (blockedTicks[i] >= JAM_MIN_TICKS && cells[i] >= 0) stopped.push(i);
    // Union-find over stopped agents within JAM_RADIUS (Manhattan).
    const parent = stopped.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const w = this.width;
    for (let a = 0; a < stopped.length; a++)
      for (let b = a + 1; b < stopped.length; b++) {
        const ca = cells[stopped[a]];
        const cb = cells[stopped[b]];
        const d = Math.abs((ca % w) - (cb % w)) + Math.abs(((ca - (ca % w)) / w) - ((cb - (cb % w)) / w));
        if (d <= JAM_RADIUS) {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
    const groups = new Map<number, number[]>();
    for (let k = 0; k < stopped.length; k++) {
      const r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(stopped[k]);
    }
    const clusters = [...groups.values()].filter((g) => g.length >= JAM_MIN_AGENTS).map((g) => g.sort((a, b) => a - b));
    clusters.sort((a, b) => a[0] - b[0]);

    const next: JamInfo[] = [];
    const started: JamInfo[] = [];
    const kept = new Set<number>();
    for (const agents of clusters) {
      const prev = this.live.find((j) => !kept.has(j.id) && j.agents.some((a) => agents.includes(a)));
      if (prev) {
        kept.add(prev.id);
        next.push({ ...prev, agents, cell: cells[agents[0]] });
      } else {
        const j: JamInfo = { id: this.nextId++, agents, cell: cells[agents[0]], sinceTick: tick };
        this.total++;
        started.push(j);
        next.push(j);
      }
    }
    const ended = this.live.filter((j) => !kept.has(j.id));
    this.live = next;
    return { started, ended };
  }

  active(): JamInfo[] {
    return this.live;
  }
}

// World: layout → grid graph, per-class passability, pick faces, stations, chargers, cached BFS distance maps.
// Lead-owned shared module (PROTOCOL §5). Integers only, no DOM.
import type { LayoutFile, PassClass } from '../contracts/types.ts';

export const Cell = {
  Wall: 0,
  Rack: 1,
  Narrow: 2, // '.'
  Fork: 3, // '=' and one-way hints
  Dock: 4,
  Staging: 5,
  Pack: 6,
  Charger: 7,
  Parking: 8,
} as const;
export type Cell = (typeof Cell)[keyof typeof Cell];

const CHAR_CODE: Record<string, Cell> = {
  X: Cell.Wall, '#': Cell.Rack, '.': Cell.Narrow, '=': Cell.Fork, '>': Cell.Fork, '<': Cell.Fork, '^': Cell.Fork, v: Cell.Fork,
  D: Cell.Dock, S: Cell.Staging, P: Cell.Pack, C: Cell.Charger, K: Cell.Parking,
};

export const PASS_CLASSES: readonly PassClass[] = ['small', 'forklift', 'human'];
const CLASS_INDEX: Record<PassClass, number> = { small: 0, forklift: 1, human: 2 };

/** Neighbour order is fixed (E, S, W, N) so every tie-break is deterministic. */
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;
export const UNREACHABLE = 0xffff;

export interface PickFace {
  /** Index into world.faces. */
  id: number;
  /** Aisle cell where the picker or robot stands. */
  cell: number;
  /** Rack cell being picked from. */
  rack: number;
  /** 0-based picking aisle number (left to right), -1 for side aisles. */
  aisle: number;
  /** Distance rank from the pack zone, used for ABC slotting (0 = closest). */
  rank: number;
}

export interface Station {
  id: number;
  /** Blocked station cells. */
  cells: number[];
  /** Cell an agent stands on to use it. */
  service: number;
}

export interface Pocket {
  id: number;
  cell: number;
  /** The corridor cell it is entered from. */
  entry: number;
  forClass: PassClass;
}

export interface World {
  layout: LayoutFile;
  width: number;
  height: number;
  n: number;
  code: Uint8Array;
  /** passable[class][cell] = 1 if that class may stand there (pockets only as a goal). */
  passable: Uint8Array[];
  /** 4 neighbours per cell (E, S, W, N), -1 if outside the grid. */
  nbr: Int32Array;
  faces: PickFace[];
  /** Face id for an aisle cell, or -1. */
  faceAt: Int32Array;
  packStations: Station[];
  docks: Station[];
  chargers: Pocket[];
  parking: Pocket[];
  /** Cells inside the pack zone tote lane where idle people wait. */
  humanHome: number[];
  isPocket: Uint8Array;
}

export function idx(w: World | { width: number }, x: number, y: number): number {
  return y * w.width + x;
}
export function cx(w: World, i: number): number {
  return i % w.width;
}
export function cy(w: World, i: number): number {
  return (i - (i % w.width)) / w.width;
}

export function buildWorld(layout: LayoutFile): World {
  const height = layout.grid.length;
  const width = layout.grid[0].length;
  const n = width * height;
  const code = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const row = layout.grid[y];
    if (row.length !== width) throw new Error(`layout ${layout.id}: row ${y} has ${row.length} cells, expected ${width}`);
    for (let x = 0; x < width; x++) {
      const c = CHAR_CODE[row[x]];
      if (c === undefined) throw new Error(`layout ${layout.id}: unknown cell '${row[x]}' at ${x},${y}`);
      code[y * width + x] = c;
    }
  }

  const nbr = new Int32Array(n * 4).fill(-1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) nbr[(y * width + x) * 4 + d] = ny * width + nx;
      }

  const inZone = (id: string, x: number, y: number): boolean =>
    layout.zones.some((z) => z.id === id && x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);

  const isPocket = new Uint8Array(n);
  const passable = PASS_CLASSES.map(() => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    const c = code[i];
    const small = c === Cell.Narrow || c === Cell.Fork || c === Cell.Staging;
    passable[CLASS_INDEX.small][i] = small ? 1 : 0;
    passable[CLASS_INDEX.human][i] = small ? 1 : 0;
    passable[CLASS_INDEX.forklift][i] = c === Cell.Fork || c === Cell.Staging ? 1 : 0;
    if (c === Cell.Charger || c === Cell.Parking) isPocket[i] = 1;
  }

  const chargers: Pocket[] = [];
  const parking: Pocket[] = [];
  for (let i = 0; i < n; i++) {
    if (!isPocket[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    const forklift = inZone('charge-forklift', x, y);
    const cls: PassClass = forklift ? 'forklift' : 'small';
    let entry = -1;
    for (let d = 0; d < 4; d++) {
      const j = nbr[i * 4 + d];
      if (j >= 0 && !isPocket[j] && passable[CLASS_INDEX[cls]][j]) {
        entry = j;
        break;
      }
    }
    if (entry < 0) throw new Error(`layout ${layout.id}: pocket at ${x},${y} has no entry for ${cls}`);
    passable[CLASS_INDEX[cls]][i] = 1;
    const p: Pocket = { id: 0, cell: i, entry, forClass: cls };
    if (code[i] === Cell.Charger) chargers.push({ ...p, id: chargers.length });
    else parking.push({ ...p, id: parking.length });
  }

  // Pick faces: forklift/narrow aisle cells next to a rack, east or west side.
  const faceAt = new Int32Array(n).fill(-1);
  const rawFaces: { cell: number; rack: number; aisle: number }[] = [];
  const storage = layout.zones.find((z) => z.kind === 'storage');
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (code[i] !== Cell.Fork && code[i] !== Cell.Narrow) continue;
      for (const d of [0, 2]) {
        const j = nbr[i * 4 + d];
        if (j >= 0 && code[j] === Cell.Rack) {
          let aisle = -1;
          if (storage && x >= storage.x && x < storage.x + storage.w) aisle = Math.floor((x - storage.x) / 4);
          rawFaces.push({ cell: i, rack: j, aisle });
          break; // one face per aisle cell (2-wide aisles: each lane faces its own side)
        }
      }
    }

  const packStations = stationsOf(Cell.Pack);
  const docks = stationsOf(Cell.Dock);

  function stationsOf(kind: number): Station[] {
    const seen = new Uint8Array(n);
    const out: Station[] = [];
    for (let i = 0; i < n; i++) {
      if (code[i] !== kind || seen[i]) continue;
      const cells: number[] = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        cells.push(k);
        for (let d = 0; d < 4; d++) {
          const j = nbr[k * 4 + d];
          if (j >= 0 && !seen[j] && code[j] === kind) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      cells.sort((a, b) => a - b);
      let service = -1;
      for (const k of cells)
        for (let d = 0; d < 4 && service < 0; d++) {
          const j = nbr[k * 4 + d];
          if (j >= 0 && (code[j] === Cell.Narrow || code[j] === Cell.Fork || code[j] === Cell.Staging)) service = j;
        }
      if (service < 0) throw new Error(`layout ${layout.id}: station at cell ${i} has no service cell`);
      out.push({ id: out.length, cells, service });
    }
    return out;
  }

  const world: World = {
    layout, width, height, n, code, passable, nbr, faces: [], faceAt, packStations, docks, chargers, parking,
    humanHome: [], isPocket,
  };

  // Rank faces by walking distance from the nearest pack station (ABC slotting: fast movers near packing).
  const fromPack = multiSourceBfs(world, 'human', packStations.map((s) => s.service));
  rawFaces.sort((a, b) => fromPack[a.cell] - fromPack[b.cell] || a.cell - b.cell);
  world.faces = rawFaces.map((f, k) => ({ id: k, cell: f.cell, rack: f.rack, aisle: f.aisle, rank: k }));
  for (const f of world.faces) faceAt[f.cell] = f.id;

  const lane = layout.zones.find((z) => z.kind === 'pack');
  if (lane) for (let x = lane.x; x < lane.x + lane.w; x++) {
    const i = lane.y * width + x;
    if (passable[CLASS_INDEX.human][i] && !packStations.some((s) => s.service === i)) world.humanHome.push(i);
  }
  return world;
}

export function classIndex(c: PassClass): number {
  return CLASS_INDEX[c];
}

/** BFS distance in cells from any of `sources` over `cls` cells. Pockets are entered only as a source. */
export function multiSourceBfs(w: World, cls: PassClass, sources: number[]): Uint16Array {
  const pass = w.passable[CLASS_INDEX[cls]];
  const dist = new Uint16Array(w.n).fill(UNREACHABLE);
  const q = new Int32Array(w.n);
  let head = 0;
  let tail = 0;
  for (const s of [...sources].sort((a, b) => a - b)) {
    if (dist[s] !== UNREACHABLE) continue;
    dist[s] = 0;
    q[tail++] = s;
  }
  while (head < tail) {
    const i = q[head++];
    const nd = dist[i] + 1;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[i * 4 + d];
      if (j < 0 || !pass[j] || w.isPocket[j] || dist[j] !== UNREACHABLE) continue;
      dist[j] = nd;
      q[tail++] = j;
    }
  }
  // An agent sitting in a pocket leaves through its entry cell.
  for (let i = 0; i < w.n; i++) {
    if (!w.isPocket[i] || !pass[i] || dist[i] !== UNREACHABLE) continue;
    let best = UNREACHABLE;
    for (let d = 0; d < 4; d++) {
      const j = w.nbr[i * 4 + d];
      if (j >= 0 && !w.isPocket[j] && dist[j] < best) best = dist[j];
    }
    if (best !== UNREACHABLE) dist[i] = best + 1;
  }
  return dist;
}

/** Cached distance-to-goal maps, one per (class, goal). Deterministic and shared by all planners. */
export class DistanceCache {
  private maps = new Map<number, Uint16Array>();
  constructor(readonly world: World) {}

  to(cls: PassClass, goal: number): Uint16Array {
    const key = CLASS_INDEX[cls] * this.world.n + goal;
    let m = this.maps.get(key);
    if (!m) {
      m = multiSourceBfs(this.world, cls, [goal]);
      this.maps.set(key, m);
    }
    return m;
  }

  get size(): number {
    return this.maps.size;
  }

  /** Best next cell from `from` toward `goal` (fixed E, S, W, N tie-break), or -1 if none. */
  next(cls: PassClass, from: number, goal: number): number {
    if (from === goal) return -1;
    const dist = this.to(cls, goal);
    const pass = this.world.passable[CLASS_INDEX[cls]];
    let best = -1;
    let bestD = dist[from];
    for (let d = 0; d < 4; d++) {
      const j = this.world.nbr[from * 4 + d];
      if (j < 0 || !pass[j] || (this.world.isPocket[j] && j !== goal)) continue;
      if (dist[j] < bestD) {
        bestD = dist[j];
        best = j;
      }
    }
    return best;
  }

  /** Up to `max` cells along the distance gradient (for route ribbons). */
  route(cls: PassClass, from: number, goal: number, max = 12): number[] {
    const out: number[] = [];
    let c = from;
    while (out.length < max) {
      const j = this.next(cls, c, goal);
      if (j < 0) break;
      out.push(j);
      c = j;
    }
    return out;
  }
}

// Layout analysis for the world layer: turns the ASCII grid (PROTOCOL §3) into the things we draw, in metres.
// Pure data, no three.js, so it can be unit-tested and reused by the floor painter, the shell and the racks.
// Grid ↔ world (render/core/geom.ts): x = (col + 0.5 − W/2) × 1.5, z = (row + 0.5 − H/2) × 1.5, Y up.
import type { LayoutFile } from '../../contracts/types.ts';
import { CELL_M } from '../core/geom.ts';

/** Deterministic 0..1 noise from integers (render only; the sim never sees it). */
export function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export const RACK_DEPTH = 1.1;
export const RACK_FLUE = 0.3;
export const UPRIGHT_W = 0.1;
export const BEAM_H = 0.13;
/** EUR pallet presented with its 0.8 m face to the aisle, 1.2 m deep into the rack. */
export const PALLET_W = 0.8;
export const PALLET_D = 1.2;
export const PALLET_H = 0.144;
/** One carton layer of the composed SimReady load (3 × 2 × 3 cartons, 1.161 m with the pallet). */
export const CARTON_LAYER = 0.339;

export type LoadKind = 'full' | 'wrap' | 'two' | 'low';

export interface Slot {
  /** Index into WorldPlan.slots. */
  i: number;
  /** Rack cell (y × W + x) this pallet position belongs to: the per-face stock index key. */
  cell: number;
  level: number;
  x: number;
  y: number;
  z: number;
  /** 0 or π (the composed loads look different from each side). */
  yaw: number;
  /** null = empty slot. */
  kind: LoadKind | null;
  /** Carton layers on the pallet (full = 3). */
  layers: number;
  /** Partial top layer: number of cartons (0 = none, up to 5 of 6). */
  topCartons: number;
}

export interface RackRun {
  /** Grid column and first/last row of a straight run of '#' cells. */
  col: number;
  y0: number;
  y1: number;
  /** Rack footprint in metres. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Which side(s) face an aisle: -1 = west, 1 = east, 0 = both (single rack). */
  face: -1 | 0 | 1;
  /** z of every bay boundary (frames), north to south. */
  frames: number[];
}

export interface Door {
  /** Left grid column of the 2-cell door. */
  col: number;
  x: number;
  width: number;
  /** 0 closed, 1 open (trailer docked), 0.5 half open. */
  open: number;
}

export interface CellPos {
  col: number;
  row: number;
  x: number;
  z: number;
}

export interface WorldPlan {
  W: number;
  H: number;
  sizeX: number;
  sizeZ: number;
  levels: number;
  levelH: number;
  rackH: number;
  wallH: number;
  /** Bottom and top of the roof trusses. */
  trussY0: number;
  trussY1: number;
  at(x: number, y: number): string;
  wx(col: number): number;
  wz(row: number): number;
  runs: RackRun[];
  slots: Slot[];
  /** Per-face stock index: rack cell → slot indices (all levels). */
  faceSlots: Map<number, number[]>;
  doors: Door[];
  packStations: CellPos[];
  chargers: (CellPos & { forklift: boolean; wallSide: -1 | 1 })[];
  parking: CellPos[];
  staging: CellPos[];
  conveyor: { x0: number; x1: number; z: number } | null;
  /** Rows of the long cross aisles (all '=' across most of the width), grouped in bands. */
  crossBands: number[][];
  /** Interior columns (in the flue between back-to-back racks) and their z lines. */
  columns: { x: number; z: number }[];
  trussZ: number[];
}

const isRackChar = (c: string) => c === '#';

export function planWorld(layout: LayoutFile): WorldPlan {
  const g = layout.grid;
  const H = g.length;
  const W = g[0].length;
  const sizeX = W * CELL_M;
  const sizeZ = H * CELL_M;
  const at = (x: number, y: number) => (y >= 0 && y < H && x >= 0 && x < W ? g[y][x] : 'X');
  const wx = (x: number) => (x + 0.5 - W / 2) * CELL_M;
  const wz = (y: number) => (y + 0.5 - H / 2) * CELL_M;
  const levels = layout.racks.levels;
  const levelH = layout.racks.heightMm / 1000 / levels;
  const rackH = levels * levelH - 0.25;
  const wallH = Math.max(11, rackH + 2.6);
  const trussY1 = wallH - 0.1;
  const trussY0 = trussY1 - 1.4;

  // ── Rack runs (contiguous '#' down a column) and their bays ──
  const runs: RackRun[] = [];
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!isRackChar(at(x, y))) {
        y++;
        continue;
      }
      const y0 = y;
      while (y < H && isRackChar(at(x, y))) y++;
      const y1 = y - 1;
      const pairE = isRackChar(at(x + 1, y0));
      const pairW = isRackChar(at(x - 1, y0));
      const cellW = wx(x) - CELL_M / 2;
      const cellE = wx(x) + CELL_M / 2;
      let x0: number;
      let x1: number;
      let face: -1 | 0 | 1;
      if (pairE && !pairW) {
        x1 = cellE - RACK_FLUE / 2;
        x0 = x1 - RACK_DEPTH;
        face = -1;
      } else if (pairW && !pairE) {
        x0 = cellW + RACK_FLUE / 2;
        x1 = x0 + RACK_DEPTH;
        face = 1;
      } else {
        x0 = wx(x) - RACK_DEPTH / 2;
        x1 = wx(x) + RACK_DEPTH / 2;
        face = 0;
      }
      const z0 = wz(y0) - CELL_M / 2;
      const z1 = wz(y1) + CELL_M / 2;
      const n = y1 - y0 + 1;
      const frames = [z0];
      for (let k = 2; k <= n; k += 2) frames.push(z0 + k * CELL_M);
      if (n % 2) frames.push(z1);
      runs.push({ col: x, y0, y1, x0, x1, z0, z1, face, frames });
    }
  }

  // ── Pallet slots: 3 pallets per 2-cell bay (1 in an odd 1-cell bay), on the floor and on every beam level ──
  const slots: Slot[] = [];
  const faceSlots = new Map<number, number[]>();
  for (const r of runs) {
    const cx = (r.x0 + r.x1) / 2;
    for (let b = 0; b < r.frames.length - 1; b++) {
      const za = r.frames[b];
      const zb = r.frames[b + 1];
      const span = zb - za;
      const n = span > CELL_M * 1.5 ? 3 : 1;
      const pitch = (span - UPRIGHT_W) / n;
      for (let p = 0; p < n; p++) {
        const z = za + UPRIGHT_W / 2 + pitch * (p + 0.5);
        const row = Math.min(r.y1, Math.max(r.y0, Math.floor((z - 1e-3) / CELL_M + H / 2)));
        const cell = row * W + r.col;
        for (let l = 0; l < levels; l++) {
          const s: Slot = { i: slots.length, cell, level: l, x: cx, y: l * levelH, z, yaw: rnd(cell, l, 7) < 0.5 ? 0 : Math.PI, kind: null, layers: 0, topCartons: 0 };
          stock(s, r.col, row, p + b * 3);
          slots.push(s);
          const list = faceSlots.get(cell) ?? [];
          list.push(s.i);
          faceSlots.set(cell, list);
        }
      }
    }
  }

  // Stock: about 74% of slots hold a pallet. Faces vary (some nearly full, some picked down), heights vary.
  function stock(s: Slot, col: number, row: number, k: number) {
    const faceFill = 0.58 + 0.34 * rnd(col, row >> 1, 11);
    const u = rnd(col * 31 + k, row, s.level * 13 + 5);
    if (u > faceFill) return;
    const v = rnd(k, col + 3 * s.level, row + 17);
    if (v < 0.13) {
      s.kind = 'wrap';
      s.layers = 3;
    } else if (v < 0.62) {
      s.kind = 'full';
      s.layers = 3;
    } else if (v < 0.86) {
      s.kind = 'two';
      s.layers = 2;
      s.topCartons = v < 0.75 ? 1 + Math.floor(rnd(k, row, 3) * 4) : 0;
    } else {
      s.kind = 'low';
      s.layers = 1;
      s.topCartons = Math.floor(rnd(k, col, 9) * 5);
    }
  }

  // ── Docks: 2-cell doors in the top wall ──
  const doors: Door[] = [];
  for (let x = 0; x < W; x++) {
    if (at(x, 0) !== 'D' || at(x - 1, 0) === 'D') continue;
    let w = 1;
    while (at(x + w, 0) === 'D') w++;
    const i = doors.length;
    doors.push({ col: x, x: wx(x) + ((w - 1) * CELL_M) / 2, width: w * CELL_M, open: i % 3 === 1 ? 0 : i % 3 === 2 ? 0.45 : 1 });
  }

  const packStations: CellPos[] = [];
  const chargers: WorldPlan['chargers'] = [];
  const parking: CellPos[] = [];
  const staging: CellPos[] = [];
  const fkZone = layout.zones.find((z) => z.id === 'charge-forklift');
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      const pos = { col: x, row: y, x: wx(x), z: wz(y) };
      if (c === 'P' && at(x - 1, y) !== 'P') {
        let w = 1;
        while (at(x + w, y) === 'P') w++;
        packStations.push({ ...pos, x: wx(x) + ((w - 1) * CELL_M) / 2 });
      } else if (c === 'C') {
        const forklift = !!fkZone && x >= fkZone.x && x < fkZone.x + fkZone.w && y >= fkZone.y && y < fkZone.y + fkZone.h;
        // The post stands against the blocked side (the wall above, or the conveyor below).
        const wallSide: -1 | 1 = at(x, y - 1) === 'X' || at(x, y - 1) === 'D' ? -1 : 1;
        chargers.push({ ...pos, forklift, wallSide });
      } else if (c === 'K') parking.push(pos);
      else if (c === 'S') staging.push(pos);
    }

  const conv = layout.zones.find((z) => z.kind === 'conveyor');
  let conveyor: WorldPlan['conveyor'] = null;
  if (conv) {
    // Run the takeaway conveyor behind the pack stations, from the first station to the east wall ("to shipping").
    const first = packStations.length ? Math.min(...packStations.map((p) => p.col)) - 1 : conv.x;
    const x0 = wx(Math.max(conv.x, first)) - CELL_M / 2;
    const x1 = wx(conv.x + conv.w - 1) + CELL_M / 2;
    conveyor = { x0, x1, z: (wz(conv.y) + wz(conv.y + conv.h - 1)) / 2 };
  }

  const crossRows: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    let run = 0;
    for (let x = 1; x < W - 1; x++) run += at(x, y) === '=' || '<>^v'.includes(at(x, y)) ? 1 : 0;
    if (run > (W - 2) * 0.9) crossRows.push(y);
  }
  const crossBands: number[][] = [];
  for (const r of crossRows) {
    const b = crossBands.at(-1);
    if (b && b.at(-1) === r - 1) b.push(r);
    else crossBands.push([r]);
  }

  // ── Structure: trusses every 2 bays (6 m) on the rack frame grid; columns in the flue of every 2nd pair, every 2nd truss ──
  const trussZ: number[] = [];
  const firstRun = runs.find((r) => r.face === -1) ?? runs[0];
  const z0 = firstRun ? firstRun.z0 : -sizeZ / 2;
  const step = 4 * CELL_M;
  for (let z = z0 - Math.floor((z0 + sizeZ / 2 - 2) / step) * step; z < sizeZ / 2 - 1.5; z += step) trussZ.push(z);
  const columns: { x: number; z: number }[] = [];
  const pairs = runs.filter((r) => r.face === -1);
  const colCols = new Set<number>();
  pairs.forEach((r, i) => {
    if (i % 2 === 1) colCols.add(r.col);
  });
  for (const r of pairs) {
    if (!colCols.has(r.col)) continue;
    const xf = r.x1 + RACK_FLUE / 2;
    for (let k = 0; k < r.frames.length; k++) {
      const z = r.frames[k];
      const onTruss = trussZ.some((t) => Math.abs(t - z) < 0.01);
      if (onTruss && k > 0 && k < r.frames.length - 1 && k % 2 === 0) columns.push({ x: xf, z });
    }
  }

  return {
    W,
    H,
    sizeX,
    sizeZ,
    levels,
    levelH,
    rackH,
    wallH,
    trussY0,
    trussY1,
    at,
    wx,
    wz,
    runs,
    slots,
    faceSlots,
    doors,
    packStations,
    chargers,
    parking,
    staging,
    conveyor,
    crossBands,
    columns,
    trussZ,
  };
}

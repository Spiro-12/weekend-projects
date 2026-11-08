// Generates the preset warehouse layouts as ASCII grids (PROTOCOL §3). Pure function; scripts/layout-gen.ts writes the files.
//
// Shape (top to bottom):
//   wall with dock doors (D) · staging (S) and forklift chargers (C) · front cross aisle (=, 3 rows)
//   storage: single rack · [aisle (2 wide) · back-to-back rack pair] … · aisle · single rack, side aisles on both ends
//   (large layouts get a 2-row mid cross aisle) · back cross aisle (=, 3 rows)
//   pack zone: 2-wide tote lane (.) · pack stations (P), robot chargers (C) and parking (K) as pockets · conveyors · wall
//   (the lane is 2 wide so robots and people can queue and pass at the stations: spike b found a 1-wide lane was the
//   main hotspot in both traffic modes)
import { CELL_MM, type LayoutFile, type LayoutZone } from '../contracts/types.ts';

export interface LayoutParams {
  id: string;
  name: string;
  aisles: number;
  rackLen: number;
  dockDoors: number;
  packStations: number;
  robotChargers: number;
  forkliftChargers: number;
  parking: number;
  midCross: boolean;
  rackLevels: number;
}

export const PRESETS: LayoutParams[] = [
  { id: 'small', name: 'Small DC (8 aisles)', aisles: 8, rackLen: 16, dockDoors: 4, packStations: 4, robotChargers: 8, forkliftChargers: 2, parking: 8, midCross: false, rackLevels: 5 },
  { id: 'default', name: 'Mid-size e-commerce DC (14 aisles)', aisles: 14, rackLen: 20, dockDoors: 6, packStations: 6, robotChargers: 12, forkliftChargers: 3, parking: 12, midCross: false, rackLevels: 5 },
  { id: 'large', name: 'Large fulfilment center (22 aisles)', aisles: 22, rackLen: 30, dockDoors: 10, packStations: 10, robotChargers: 20, forkliftChargers: 5, parking: 20, midCross: true, rackLevels: 6 },
];

export function generateLayout(p: LayoutParams): LayoutFile {
  const storageW = 4 * p.aisles; // '#' + ('==' '##') x (aisles-1) + '==' + '#'
  const W = 1 + 2 + storageW + 2 + 1;
  const midRows = p.midCross ? 2 : 0;
  const top = 1 + 2 + 3; // wall, staging rows, front cross aisle
  const storageH = p.rackLen + midRows;
  const backCross = 3;
  const packRows = 5; // tote lane x2, stations/pockets, conveyor x2
  const H = top + storageH + backCross + packRows + 1;

  const g: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => 'X'));
  const set = (x: number, y: number, c: string) => {
    if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) throw new Error(`layout-gen: ${p.id} writes the border at ${x},${y}`);
    g[y][x] = c;
  };

  // Front: staging rows 1-2, cross aisle rows 3-5 (all forklift-rated).
  for (let y = 1; y <= 5; y++) for (let x = 1; x < W - 1; x++) set(x, y, '=');
  // Dock doors in the top wall, 2 cells wide, each with a 2x2 staging pad below it.
  const doorStart = p.forkliftChargers + 3; // keep the left corner for forklift chargers
  const doorSpan = W - 3 - doorStart;
  for (let i = 0; i < p.dockDoors; i++) {
    const x = doorStart + Math.floor(((i + 0.5) * doorSpan) / p.dockDoors) - 1;
    g[0][x] = 'D';
    g[0][x + 1] = 'D';
    for (const dy of [1, 2]) {
      set(x, dy, 'S');
      set(x + 1, dy, 'S');
    }
  }
  // Forklift chargers: pockets in row 1 at the left corner (reached from row 2).
  for (let i = 0; i < p.forkliftChargers; i++) set(1 + i, 1, 'C');

  // Storage block.
  const y0 = top;
  for (let y = y0; y < y0 + storageH; y++) {
    const isMid = p.midCross && y >= y0 + Math.floor(p.rackLen / 2) && y < y0 + Math.floor(p.rackLen / 2) + midRows;
    // side aisles
    set(1, y, '=');
    set(2, y, '=');
    set(W - 3, y, '=');
    set(W - 2, y, '=');
    for (let i = 0; i < storageW; i++) {
      const x = 3 + i;
      if (isMid) {
        set(x, y, '=');
        continue;
      }
      const m = i % 4; // 0: rack (east face of a pair, or the first single rack), 1-2: aisle, 3: rack
      const isRack = i === 0 || i === storageW - 1 || m === 0 || m === 3;
      set(x, y, isRack ? '#' : '=');
    }
  }

  // Back cross aisle.
  const yb = y0 + storageH;
  for (let y = yb; y < yb + backCross; y++) for (let x = 1; x < W - 1; x++) set(x, y, '=');

  // Pack zone.
  const yLane = yb + backCross; // narrow tote lane (robots and people only), 2 rows
  const yPocket = yLane + 2; // stations and pockets, served from the lane
  for (let x = 1; x < W - 1; x++) {
    set(x, yLane, '.');
    set(x, yLane + 1, '.');
  }
  // Robot chargers at the left, parking at the right, pack stations (2 wide) spread across the middle.
  for (let i = 0; i < p.robotChargers; i++) set(1 + i, yPocket, 'C');
  for (let i = 0; i < p.parking; i++) set(W - 2 - i, yPocket, 'K');
  const midL = 1 + p.robotChargers + 1;
  const midR = W - 2 - p.parking - 1;
  const span = midR - midL - 1;
  for (let i = 0; i < p.packStations; i++) {
    const x = midL + Math.floor(((i + 0.5) * span) / p.packStations) - 1;
    set(x, yPocket, 'P');
    set(x + 1, yPocket, 'P');
  }
  // Conveyor rows stay 'X' (blocked); the conveyor zone tells the renderer to draw belts there.

  const zones: LayoutZone[] = [
    { id: 'dock', label: 'SHIPPING & RECEIVING', kind: 'dock', x: 1, y: 1, w: W - 2, h: 2 },
    { id: 'storage', label: 'STORAGE', kind: 'storage', x: 3, y: y0, w: storageW, h: storageH },
    { id: 'pack', label: 'PICK AND PACK', kind: 'pack', x: midL, y: yLane, w: midR - midL + 1, h: 3 },
    { id: 'charge', label: 'CHARGING', kind: 'charge', x: 1, y: yPocket, w: p.robotChargers, h: 1 },
    { id: 'charge-forklift', label: 'CHARGING', kind: 'charge', x: 1, y: 1, w: p.forkliftChargers, h: 1 },
    { id: 'park', label: 'PARKING', kind: 'park', x: W - 1 - p.parking, y: yPocket, w: p.parking, h: 1 },
    { id: 'conveyor', label: 'TO SHIPPING', kind: 'conveyor', x: 1, y: yPocket + 1, w: W - 2, h: 2 },
  ];

  return {
    format: 'fp-layout',
    v: 1,
    id: p.id,
    name: p.name,
    cellMm: CELL_MM,
    grid: g.map((row) => row.join('')),
    racks: { levels: p.rackLevels, heightMm: p.rackLevels * 1800 },
    zones,
    aisles: p.aisles,
    notes: `Generated by scripts/layout-gen.ts from ${JSON.stringify(p)}`,
  };
}

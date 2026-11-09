// Pick zones for the cart-robot work model (PROTOCOL §5 work model, the Locus model): zone workers (pickers and
// humanoids) are grouped ZONE_PICKERS to a zone; each zone owns one contiguous run of pick faces and its workers stay
// in it. Cart robots stop at faces and wait for the zone's nearest free worker. Deterministic: depends only on the
// layout, the ABC skew and the worker list (in id order).
//
// "Split evenly" is by expected work, not by face count: with 80% of picks on the 20% of faces nearest packing, equal
// face counts would bury the central zones and idle the outer ones. Each face is weighted by its expected share of
// picks, each zone by its workers' pick rates (a humanoid at 40 s/line counts half a person at 20 s/line), and the face
// sequence is cut where the cumulative weights cross. Faces run aisle by aisle in a serpentine (down one aisle, up the
// next), so a zone that spans two aisles joins them at the same end.
import type { World } from '../world.ts';

export interface ZoneWorker {
  id: number;
  /** Relative pick rate (integer), e.g. floor(1e6 / ticks per line). */
  weight: number;
}

export interface Zones {
  /** Zone index of each face (by face id), -1 if no zone. */
  faceZone: Int32Array;
  /** Worker agent ids per zone. */
  members: number[][];
  /** Per worker (aligned with `workers`, id order): its zone, its waiting spot (the middle face of its share of the
   *  zone) and the zone's bounding box (one cell of margin). */
  workers: number[];
  workerZone: number[];
  home: number[];
  x0: number[];
  y0: number[];
  x1: number[];
  y1: number[];
}

/** Face ids in zone order: aisle by aisle (left side aisle, aisles 0…, right side aisle), serpentine in y, then x. */
export function zoneFaceOrder(world: World): number[] {
  const w = world.width;
  const key = (f: number) => {
    const face = world.faces[f];
    const x = face.cell % w;
    return face.aisle >= 0 ? face.aisle + 1 : x < w / 2 ? 0 : 1_000_000;
  };
  const groups = [...new Set(world.faces.map((f) => key(f.id)))].sort((a, b) => a - b);
  const groupIndex = new Map(groups.map((g, i) => [g, i]));
  const ids = world.faces.map((f) => f.id);
  ids.sort((a, b) => {
    const ga = key(a);
    const gb = key(b);
    if (ga !== gb) return ga - gb;
    const ca = world.faces[a].cell;
    const cb = world.faces[b].cell;
    const ya = (ca - (ca % w)) / w;
    const yb = (cb - (cb % w)) / w;
    if (ya !== yb) return (groupIndex.get(ga)! % 2 === 0 ? 1 : -1) * (ya - yb);
    return (ca % w) - (cb % w) || a - b;
  });
  return ids;
}

/** Integer expected-pick weight per face id: an A face (rank < nA) gets aPicksPct/nA of the picks, a B face
 *  (100 − aPicksPct)/(F − nA); both scaled by nA·(F − nA) to stay integers. */
export function faceWeights(faceCount: number, nA: number, aPicksPct: number): number[] {
  const F = faceCount;
  const out: number[] = [];
  for (let f = 0; f < F; f++) {
    if (nA >= F) out.push(1);
    else out.push(f < nA ? aPicksPct * (F - nA) : (100 - aPicksPct) * nA);
  }
  if (!out.some((x) => x > 0)) out.fill(1);
  return out;
}

export function computeZones(world: World, order: readonly number[], weights: readonly number[], workers: readonly ZoneWorker[], perZone: number): Zones {
  const F = order.length;
  const W = workers.length;
  const z: Zones = {
    faceZone: new Int32Array(world.faces.length).fill(-1),
    members: [],
    workers: workers.map((x) => x.id),
    workerZone: [],
    home: [],
    x0: [],
    y0: [],
    x1: [],
    y1: [],
  };
  if (W === 0 || F === 0) return z;
  // workers in id order, perZone at a time (the last zone takes what is left)
  const Z = Math.max(1, Math.floor(W / Math.max(1, perZone)));
  const zoneOf: number[] = workers.map((_, k) => Math.min(Z - 1, Math.floor(k / Math.max(1, perZone))));
  const zoneW: number[] = new Array(Z).fill(0);
  workers.forEach((wk, k) => (zoneW[zoneOf[k]] += Math.max(1, wk.weight)));
  for (let i = 0; i < Z; i++) z.members.push([]);
  workers.forEach((wk, k) => z.members[zoneOf[k]].push(wk.id));

  let T = 0;
  for (const f of order) T += weights[f];
  const cumW: number[] = [];
  let cw = 0;
  for (const x of zoneW) {
    cw += x;
    cumW.push(cw);
  }
  const faces: number[][] = zoneW.map(() => []);
  let k = 0;
  let cf = 0;
  for (const f of order) {
    const mid2 = 2 * cf + weights[f]; // twice the face's weight midpoint
    while (k < Z - 1 && mid2 * cw >= 2 * cumW[k] * T) k++;
    faces[k].push(f);
    z.faceZone[f] = k;
    cf += weights[f];
  }
  const width = world.width;
  const box = faces.map((m) => {
    let x0 = width;
    let y0 = world.height;
    let x1 = -1;
    let y1 = -1;
    for (const f of m) {
      const c = world.faces[f].cell;
      const x = c % width;
      const y = (c - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return m.length ? [x0 - 1, y0 - 1, x1 + 1, y1 + 1] : [0, 0, -1, -1];
  });
  workers.forEach((_, i) => {
    const zi = zoneOf[i];
    const m = faces[zi];
    const team = z.members[zi];
    const j = team.indexOf(workers[i].id);
    // each worker waits in the middle of its share of the zone's faces
    const lo = Math.floor((m.length * j) / team.length);
    const hi = Math.floor((m.length * (j + 1)) / team.length);
    z.workerZone.push(zi);
    z.home.push(hi > lo ? world.faces[m[lo + Math.floor((hi - lo) / 2)]].cell : -1);
    z.x0.push(box[zi][0]);
    z.y0.push(box[zi][1]);
    z.x1.push(box[zi][2]);
    z.y1.push(box[zi][3]);
  });
  return z;
}

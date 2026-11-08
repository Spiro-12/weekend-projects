// Task assignment: greedy nearest (what fleet managers do) and Hungarian / Jonker-Volgenant style shortest augmenting
// path (optimal). Integer costs only, deterministic tie-breaks (lowest index wins). cost is row-major n x m, n <= m.

/** Greedy: rows in order, each takes its cheapest free column. out[row] = column. Returns total cost. */
export function assignGreedy(cost: Int32Array, n: number, m: number, out: Int32Array, used: Uint8Array): number {
  used.fill(0, 0, m);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestC = 0x7fffffff;
    const row = i * m;
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      const c = cost[row + j];
      if (c < bestC) {
        bestC = c;
        best = j;
      }
    }
    out[i] = best;
    if (best >= 0) {
      used[best] = 1;
      total += bestC;
    }
  }
  return total;
}

/** Scratch buffers for assignOptimal, sized for up to n rows and m columns. */
export class HungarianScratch {
  u: Float64Array;
  v: Float64Array;
  p: Int32Array;
  way: Int32Array;
  minv: Float64Array;
  usedCol: Uint8Array;
  constructor(n: number, m: number) {
    this.u = new Float64Array(n + 1);
    this.v = new Float64Array(m + 1);
    this.p = new Int32Array(m + 1);
    this.way = new Int32Array(m + 1);
    this.minv = new Float64Array(m + 1);
    this.usedCol = new Uint8Array(m + 1);
  }
}

/**
 * Optimal assignment (Kuhn-Munkres with potentials, shortest augmenting path: O(n^2 m)). Potentials stay integers
 * because costs are integers (Float64Array only to avoid 32-bit overflow). out[row] = column. Returns total cost.
 */
export function assignOptimal(cost: Int32Array, n: number, m: number, out: Int32Array, s: HungarianScratch): number {
  const INF = 1e15;
  const { u, v, p, way, minv, usedCol } = s;
  u.fill(0, 0, n + 1);
  v.fill(0, 0, m + 1);
  p.fill(0, 0, m + 1);
  way.fill(0, 0, m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(INF, 0, m + 1);
    usedCol.fill(0, 0, m + 1);
    do {
      usedCol[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      const row = (i0 - 1) * m;
      const ui0 = u[i0];
      for (let j = 1; j <= m; j++) {
        if (usedCol[j]) continue;
        const cur = cost[row + j - 1] - ui0 - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (usedCol[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j++)
    if (p[j] !== 0) {
      out[p[j] - 1] = j - 1;
      total += cost[(p[j] - 1) * m + j - 1];
    }
  return total;
}

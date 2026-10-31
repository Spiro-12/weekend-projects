// Dependent multivariate DTW (PROTOCOL.md §6): one warp path for all channels, squared Euclidean
// local cost summed over channels, Sakoe-Chiba band, total accumulated cost (no normalization).

/** Sakoe-Chiba radius from the band fraction: max(1, floor(band * L + 0.5)). */
export const bandRadius = (band: number, L: number): number => Math.max(1, Math.floor(band * L + 0.5));

/** [channel][n] -> interleaved [n][channel] (what dtwFlat reads). */
export function interleave(x: ArrayLike<number>[]): Float32Array {
  const C = x.length;
  const n = C ? x[0].length : 0;
  const out = new Float32Array(n * C);
  for (let c = 0; c < C; c++) {
    if (x[c].length !== n) throw new Error('ml.dtw: channels have different lengths');
    for (let i = 0; i < n; i++) out[i * C + c] = x[c][i];
  }
  return out;
}

// Two rolling rows, reused between calls (index j+1 holds column j; index 0 is the j = -1 sentinel).
let rowA = new Float64Array(0);
let rowB = new Float64Array(0);

/**
 * DTW on interleaved series a (n x C) and b (m x C).
 * Cells with |i - j| > r are skipped (r is widened to |n - m| so a path always exists).
 * If every cell of a row exceeds `cutoff`, gives up and returns Infinity (early abandon; costs only grow).
 */
export function dtwFlat(a: Float32Array, n: number, b: Float32Array, m: number, C: number, r: number, cutoff = Infinity): number {
  if (n === 0 || m === 0) return n === m ? 0 : Infinity;
  const R = Math.max(Math.floor(r), Math.abs(n - m), 0);
  if (rowA.length < m + 1) { rowA = new Float64Array(m + 1); rowB = new Float64Array(m + 1); }
  let prev = rowA, cur = rowB;
  prev.fill(Infinity, 0, m + 1);
  prev[0] = 0; // D(-1, -1) = 0
  for (let i = 0; i < n; i++) {
    const jlo = i - R > 0 ? i - R : 0;
    const jhi = i + R < m - 1 ? i + R : m - 1;
    cur[jlo] = Infinity; // D(i, jlo - 1)
    const ai = i * C;
    let rowMin = Infinity;
    let diag = prev[jlo]; // D(i-1, j-1), carried along the row
    let left = Infinity; // D(i, j-1)
    for (let j = jlo; j <= jhi; j++) {
      const bj = j * C;
      let cost: number;
      if (C === 6) { // the default channel set, unrolled (same summation order as the loop below)
        const d0 = a[ai] - b[bj], d1 = a[ai + 1] - b[bj + 1], d2 = a[ai + 2] - b[bj + 2];
        const d3 = a[ai + 3] - b[bj + 3], d4 = a[ai + 4] - b[bj + 4], d5 = a[ai + 5] - b[bj + 5];
        cost = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 + d4 * d4 + d5 * d5;
      } else {
        cost = 0;
        for (let c = 0; c < C; c++) { const d = a[ai + c] - b[bj + c]; cost += d * d; }
      }
      const up = prev[j + 1];
      let best = diag < up ? diag : up;
      if (left < best) best = left;
      const v = cost + best;
      cur[j + 1] = v;
      if (v < rowMin) rowMin = v;
      diag = up;
      left = v;
    }
    if (jhi + 2 <= m) cur[jhi + 2] = Infinity; // next row reads D(i, jhi + 1): outside this row's band
    if (rowMin > cutoff) return Infinity;
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

/** Public form: a and b are [channel][L]. Same number of channels required. */
export function dtw(a: Float32Array[], b: Float32Array[], radius: number): number {
  if (a.length !== b.length) throw new Error(`ml.dtw: ${a.length} vs ${b.length} channels`);
  const C = a.length;
  if (C === 0) return 0;
  return dtwFlat(interleave(a), a[0].length, interleave(b), b[0].length, C, radius);
}

// Geometry helpers for the asset pipeline: texture sampling into vertex colours, welding, simplifying to a
// triangle budget, and crease-aware normals. Plain typed arrays in, plain typed arrays out.
import sharp from 'sharp';
import { MeshoptSimplifier } from './io.ts';

export interface Image {
  w: number;
  h: number;
  /** RGBA, 8 bit. */
  px: Uint8Array;
}

export async function decodeImage(bytes: Uint8Array, maxEdge = 256): Promise<Image> {
  const { data, info } = await sharp(Buffer.from(bytes))
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, px: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Mean of each channel, 0..1 (no colour-space conversion). */
export function meanChannels(img: Image): [number, number, number, number] {
  const s = [0, 0, 0, 0];
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) s[c] += img.px[i * 4 + c];
  return s.map((v) => v / n / 255) as [number, number, number, number];
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** UV transform from KHR_texture_transform (offset, rotation, scale), applied as in the spec. */
export interface UvTransform {
  offset: [number, number];
  rotation: number;
  scale: [number, number];
}

/** Bilinear, wrapping (REPEAT) sample of an sRGB image; returns linear RGB. */
export function sampleLinear(img: Image, u: number, v: number, out: Float32Array, o: number): void {
  const x = (u - Math.floor(u)) * img.w - 0.5;
  const y = (v - Math.floor(v)) * img.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (a: number, n: number) => ((a % n) + n) % n;
  const xa = wrap(x0, img.w);
  const xb = wrap(x0 + 1, img.w);
  const ya = wrap(y0, img.h);
  const yb = wrap(y0 + 1, img.h);
  for (let c = 0; c < 3; c++) {
    const p = (xx: number, yy: number) => srgbToLinear(img.px[(yy * img.w + xx) * 4 + c] / 255);
    out[o + c] = (p(xa, ya) * (1 - fx) + p(xb, ya) * fx) * (1 - fy) + (p(xa, yb) * (1 - fx) + p(xb, yb) * fx) * fy;
  }
}

export function applyUvTransform(t: UvTransform | null, u: number, v: number): [number, number] {
  if (!t) return [u, v];
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const su = u * t.scale[0];
  const sv = v * t.scale[1];
  return [c * su + s * sv + t.offset[0], -s * su + c * sv + t.offset[1]];
}

/** Merge vertices whose positions match to 0.05 mm. Returns unique positions and a remap old → new. */
export function weldPositions(pos: Float32Array): { pos: Float32Array; remap: Uint32Array } {
  const n = pos.length / 3;
  const remap = new Uint32Array(n);
  const map = new Map<string, number>();
  const out: number[] = [];
  const q = 20000;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * q)},${Math.round(pos[i * 3 + 1] * q)},${Math.round(pos[i * 3 + 2] * q)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = out.length / 3;
      map.set(k, j);
      out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    remap[i] = j;
  }
  return { pos: new Float32Array(out), remap };
}

/** Simplify an index buffer to at most `targetTris`. Falls back to sloppy simplification if topology blocks it. */
export const simplifyLog: string[] = [];

export function simplifyTo(indices: Uint32Array, pos: Float32Array, targetTris: number, label = ''): Uint32Array {
  if (indices.length / 3 <= targetTris) return indices;
  const target = Math.max(3, Math.floor(targetTris) * 3);
  // 1. Normal (attribute seams kept). 2. Permissive (may collapse across seams). 3. Sloppy (ignores topology).
  let [out] = MeshoptSimplifier.simplify(indices, pos, 3, target, 1, []);
  let how = 'seam-aware';
  const seamAware = out.length / 3;
  if (out.length > target) {
    [out] = MeshoptSimplifier.simplify(out, pos, 3, target, 1, ['Permissive']);
    how = 'permissive';
  }
  if (out.length > target) {
    [out] = MeshoptSimplifier.simplifySloppy(out, pos, 3, null, target, 1);
    how = 'sloppy';
  }
  simplifyLog.push(`${label}: ${indices.length / 3} -> ${out.length / 3} (${how}${how !== 'seam-aware' ? `, seam-aware stopped at ${seamAware}` : ''})`);
  return out;
}

/**
 * Rebuild an indexed mesh from welded positions + per-position colours, with crease-aware normals: a corner's
 * normal averages the faces around its position whose normal is within `creaseDeg` of its own face. Degenerate
 * triangles are dropped. Returns de-duplicated vertices.
 */
export function rebuildWithCreases(
  pos: Float32Array,
  col: Float32Array | null,
  tris: Uint32Array,
  creaseDeg = 40,
): { pos: Float32Array; nor: Float32Array; col: Float32Array | null; idx: Uint32Array } {
  const nT = tris.length / 3;
  const fn = new Float32Array(nT * 3); // area-weighted
  const fu = new Float32Array(nT * 3); // unit
  const keep = new Uint8Array(nT);
  for (let t = 0; t < nT; t++) {
    const a = tris[t * 3] * 3;
    const b = tris[t * 3 + 1] * 3;
    const c = tris[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    keep[t] = 1;
    fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
    fu[t * 3] = nx / len; fu[t * 3 + 1] = ny / len; fu[t * 3 + 2] = nz / len;
  }
  // position → faces (CSR)
  const nV = pos.length / 3;
  const count = new Uint32Array(nV + 1);
  for (let t = 0; t < nT; t++) if (keep[t]) for (let k = 0; k < 3; k++) count[tris[t * 3 + k] + 1]++;
  for (let i = 0; i < nV; i++) count[i + 1] += count[i];
  const faces = new Uint32Array(count[nV]);
  const fill = count.slice(0, nV);
  for (let t = 0; t < nT; t++) if (keep[t]) for (let k = 0; k < 3; k++) faces[fill[tris[t * 3 + k]]++] = t;
  const cosC = Math.cos((creaseDeg * Math.PI) / 180);
  const outP: number[] = [];
  const outN: number[] = [];
  const outC: number[] = [];
  const outI: number[] = [];
  const seen = new Map<string, number>();
  for (let t = 0; t < nT; t++) {
    if (!keep[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (let j = count[v]; j < count[v + 1]; j++) {
        const f = faces[j];
        const d = fu[f * 3] * fu[t * 3] + fu[f * 3 + 1] * fu[t * 3 + 1] + fu[f * 3 + 2] * fu[t * 3 + 2];
        if (d >= cosC) {
          nx += fn[f * 3]; ny += fn[f * 3 + 1]; nz += fn[f * 3 + 2];
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const key = `${v}|${Math.round(nx * 500)},${Math.round(ny * 500)},${Math.round(nz * 500)}`;
      let idx = seen.get(key);
      if (idx === undefined) {
        idx = outP.length / 3;
        seen.set(key, idx);
        outP.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        outN.push(nx, ny, nz);
        if (col) outC.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
      }
      outI.push(idx);
    }
  }
  return {
    pos: new Float32Array(outP),
    nor: new Float32Array(outN),
    col: col ? new Float32Array(outC) : null,
    idx: new Uint32Array(outI),
  };
}

export function triArea(pos: Float32Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

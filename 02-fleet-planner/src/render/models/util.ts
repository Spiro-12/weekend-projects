// Small geometry helpers shared by the code-built models: rounded boxes and rounded-rectangle bands, written
// directly (no Shape / ExtrudeGeometry, which would add about 9 KB gz to the first-view bundle).
import * as THREE from 'three';

/** Outline of a rounded rectangle (w along x, d along z), counter-clockwise seen from +Y, with outward normals. */
function outline(w: number, d: number, r: number, seg: number): { p: [number, number][]; n: [number, number][] } {
  r = Math.max(0, Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4));
  const p: [number, number][] = [];
  const n: [number, number][] = [];
  const corners: [number, number, number][] = [
    [w / 2 - r, d / 2 - r, 0],
    [w / 2 - r, -d / 2 + r, -Math.PI / 2],
    [-w / 2 + r, -d / 2 + r, -Math.PI],
    [-w / 2 + r, d / 2 - r, Math.PI / 2],
  ];
  const s = Math.max(1, seg);
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= s; i++) {
      const a = a0 - (i / s) * (Math.PI / 2);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      p.push([cx + nx * r, cz + nz * r]);
      n.push([nx, nz]);
    }
  }
  return { p, n };
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  tri(a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]) {
    this.pos.push(...a, ...b, ...c);
    this.nor.push(...na, ...nb, ...nc);
  }
  quad(a: number[], b: number[], c: number[], d: number[], na: number[], nb: number[], nc: number[], nd: number[]) {
    this.tri(a, b, c, na, nb, nc);
    this.tri(a, c, d, na, nc, nd);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    return g;
  }
}

/** Side wall between two outlines at heights y0 and y1 (smooth normals around the corners). */
function wall(b: Builder, lo: ReturnType<typeof outline>, y0: number, hi: ReturnType<typeof outline>, y1: number, flip = false, tilt = 0) {
  const k = lo.p.length;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const s = flip ? -1 : 1;
    const ny = tilt;
    const nl = Math.sqrt(1 - Math.min(0.99, ny * ny));
    const na = [lo.n[i][0] * s * nl, ny, lo.n[i][1] * s * nl];
    const nb = [lo.n[j][0] * s * nl, ny, lo.n[j][1] * s * nl];
    const a = [lo.p[i][0], y0, lo.p[i][1]];
    const bb = [lo.p[j][0], y0, lo.p[j][1]];
    const c = [hi.p[j][0], y1, hi.p[j][1]];
    const d = [hi.p[i][0], y1, hi.p[i][1]];
    if (flip) b.quad(a, d, c, bb, na, na, nb, nb);
    else b.quad(a, bb, c, d, na, nb, nb, na);
  }
}

/** Flat cap (convex outline) at height y facing up or down. */
function cap(b: Builder, o: ReturnType<typeof outline>, y: number, up: boolean) {
  const n = [0, up ? 1 : -1, 0];
  const c = [0, y, 0];
  for (let i = 0; i < o.p.length; i++) {
    const j = (i + 1) % o.p.length;
    const a = [o.p[i][0], y, o.p[i][1]];
    const bb = [o.p[j][0], y, o.p[j][1]];
    if (up) b.tri(c, a, bb, n, n, n);
    else b.tri(c, bb, a, n, n, n);
  }
}

/** A box with rounded vertical edges, centred on x/z, bottom at y = 0; `bevel` chamfers the top and bottom edges. */
export function roundedBox(w: number, h: number, d: number, r: number, segments = 3, bevel = 0): THREE.BufferGeometry {
  const b = new Builder();
  const full = outline(w, d, r, segments);
  const bv = Math.min(bevel, h / 3, w / 4, d / 4);
  if (bv > 0) {
    const inset = outline(w - bv * 2, d - bv * 2, Math.max(0, r - bv), segments);
    wall(b, inset, 0, full, bv, false, -0.7);
    wall(b, full, bv, full, h - bv);
    wall(b, full, h - bv, inset, h, false, 0.7);
    cap(b, inset, h, true);
    cap(b, inset, 0, false);
  } else {
    wall(b, full, 0, full, h);
    cap(b, full, h, true);
    cap(b, full, 0, false);
  }
  return b.geometry();
}

/** A flat rounded-rectangle band (like a bumper light strip): outer size w × d, band width `band`, height h. */
export function roundedBand(w: number, d: number, r: number, band: number, h: number, segments = 3): THREE.BufferGeometry {
  const b = new Builder();
  const outer = outline(w, d, r, segments);
  const inner = outline(w - band * 2, d - band * 2, Math.max(0, r - band), segments);
  wall(b, outer, 0, outer, h);
  wall(b, inner, 0, inner, h, true);
  const k = outer.p.length;
  const up = [0, 1, 0];
  const dn = [0, -1, 0];
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const o0 = outer.p[i];
    const o1 = outer.p[j];
    const i0 = inner.p[i];
    const i1 = inner.p[j];
    b.quad([o0[0], h, o0[1]], [o1[0], h, o1[1]], [i1[0], h, i1[1]], [i0[0], h, i0[1]], up, up, up, up);
    b.quad([o0[0], 0, o0[1]], [i0[0], 0, i0[1]], [i1[0], 0, i1[1]], [o1[0], 0, o1[1]], dn, dn, dn, dn);
  }
  return b.geometry();
}

// Part ids, emissive kinds and instance flags shared by the code-built models and the agent layer's rig shader.
// Every model is ONE merged geometry with per-vertex `color` (linear albedo) and `aInfo` = (part, roughness,
// metalness, emit). The vertex shader moves each part from per-instance animation values (walk phase, stride,
// fork lift, flags), so a whole agent type is one instanced draw call (PROTOCOL §9: instanced rigid parts).
import * as THREE from 'three';

/** Moving parts. Pivots per model live in `RigPivots`. Forward is +X, up +Y, left is -Z in the baked frame. */
export const PART = {
  BODY: 0,
  LEG_L: 1,
  LEG_R: 2,
  SHIN_L: 3,
  SHIN_R: 4,
  ARM_L: 5,
  ARM_R: 6,
  FORE_L: 7,
  FORE_R: 8,
  /** Forks + carriage: rise by `lift`. */
  FORKS: 9,
  /** Inner mast: rises by max(0, lift - free lift). */
  MAST: 10,
  /** Visible when the agent carries a tote (AMR totes, humanoid's tote). */
  TOTE: 11,
  /** Visible when a picker pushes a cart. Does not bob with the walk. */
  CART: 12,
  /** Visible with a pallet; rides on the forks. */
  PALLET: 13,
  /** Spins about its pivot (lidar puck). */
  LIDAR: 14,
} as const;

/** Emissive kinds (aInfo.w). */
export const EMIT = {
  NONE: 0,
  /** Instance accent colour × instance intensity (vendor light band, sensor line; blinks while waiting). */
  ACCENT: 1,
  /** Vertex colour × a fixed strong intensity (warning lights, LEDs). */
  SELF: 2,
  /** Vertex colour × 1 (screens, soft panels). */
  SOFT: 3,
} as const;

/** Instance flags (aAnim.w, integer bits). */
export const FLAG = {
  TOTE: 1,
  CART: 2,
  PALLET: 4,
  /** Hide everything but the cart (the skinned hero worker stands in). */
  HIDE_BODY: 8,
  /** Arms forward, carrying something in front (humanoid with a tote). */
  HOLD: 16,
  /** Arms forward and low, pushing a cart. */
  PUSH: 32,
} as const;

/** Joint pivots in the baked frame (metres). Missing joints are unused by that model. */
export interface RigPivots {
  hipL?: THREE.Vector3;
  hipR?: THREE.Vector3;
  kneeL?: THREE.Vector3;
  kneeR?: THREE.Vector3;
  shoulderL?: THREE.Vector3;
  shoulderR?: THREE.Vector3;
  elbowL?: THREE.Vector3;
  elbowR?: THREE.Vector3;
  lidar?: THREE.Vector3;
}

export interface PartSpec {
  geo: THREE.BufferGeometry;
  /** Albedo (sRGB hex or Color). Null keeps the geometry's own vertex colours (GLB bakes). */
  color: THREE.ColorRepresentation | null;
  part?: number;
  rough?: number;
  metal?: number;
  emit?: number;
}

export interface BakedModel {
  geometry: THREE.BufferGeometry;
  pivots: RigPivots;
  /** Footprint (x length along forward, z width) and height, metres, for picking, rings and min screen size. */
  size: { length: number; width: number; height: number };
  /** Walk stride (m per cycle) for legged models. */
  stride?: number;
  /** Fork free lift before the inner mast rises (m). */
  freeLift?: number;
  tris: number;
}

const tmpColor = new THREE.Color();

/** A float copy of an attribute (dequantizes meshopt/normalized ints). */
function toFloat(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, itemSize: number): THREE.Float32BufferAttribute {
  const n = attr.count;
  const out = new Float32Array(n * itemSize);
  for (let i = 0; i < n; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
  }
  return new THREE.Float32BufferAttribute(out, itemSize);
}

/** Non-indexed float geometry with position, normal and (optionally) colour only. */
export function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', toFloat(src.attributes.position, 3));
  if (!src.attributes.normal) src.computeVertexNormals();
  out.setAttribute('normal', toFloat(src.attributes.normal, 3));
  if (src.attributes.color) out.setAttribute('color', toFloat(src.attributes.color, 3));
  return out;
}

/** Merge part specs into one non-indexed geometry with `position`, `normal`, `color`, `aInfo`. */
export function bakeParts(specs: PartSpec[]): THREE.BufferGeometry {
  let total = 0;
  const flat = specs.map((s) => {
    const g = plain(s.geo);
    total += g.attributes.position.count;
    return { s, g };
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const info = new Float32Array(total * 4);
  let o = 0;
  for (const { s, g } of flat) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    const vc = g.attributes.color?.array as Float32Array | undefined;
    if (s.color !== null) tmpColor.set(s.color);
    for (let i = 0; i < n; i++) {
      const k = (o + i) * 3;
      if (s.color === null && vc) {
        col[k] = vc[i * 3];
        col[k + 1] = vc[i * 3 + 1];
        col[k + 2] = vc[i * 3 + 2];
      } else {
        col[k] = tmpColor.r;
        col[k + 1] = tmpColor.g;
        col[k + 2] = tmpColor.b;
      }
      const q = (o + i) * 4;
      info[q] = s.part ?? PART.BODY;
      info[q + 1] = s.rough ?? 0.5;
      info[q + 2] = s.metal ?? 0;
      info[q + 3] = s.emit ?? EMIT.NONE;
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Turn a model authored facing +Z into the baked frame (facing +X), pivots included. */
export function faceX(g: THREE.BufferGeometry, pivots: RigPivots): void {
  g.rotateY(Math.PI / 2);
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  for (const v of Object.values(pivots)) (v as THREE.Vector3 | undefined)?.applyMatrix4(m);
  g.computeBoundingBox();
  g.computeBoundingSphere();
}

export function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/** Geometry helpers for authoring. */
export const G = {
  box: (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z),
  /** A tapered limb along -Y from the pivot at the origin: radius r0 at the top, r1 at length len. */
  limb: (r0: number, r1: number, len: number, seg = 10, squashZ = 1) => {
    const g = new THREE.CylinderGeometry(r0, r1, len, seg, 1, false).translate(0, -len / 2, 0);
    if (squashZ !== 1) g.scale(1, 1, squashZ);
    return g;
  },
  sphere: (r: number, ws = 12, hs = 8) => new THREE.SphereGeometry(r, ws, hs),
  /** A cylinder whose axis runs along X (joint actuators). */
  axleX: (r: number, len: number, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2),
};

/** Transform a geometry: returns a transformed copy (scale, then rotate, then translate). */
export function xf(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return g.clone().applyMatrix4(m);
}

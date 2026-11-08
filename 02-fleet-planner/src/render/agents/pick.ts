// Picking helpers: an exact ray test against each agent's oriented box (its posed footprint and height, scaled
// like the drawn instance), and a generous screen-space fallback for small, far agents.
import { Vector3, type Camera, type Ray } from 'three';

const o = new Vector3();
const d = new Vector3();

/**
 * Distance along the ray to an agent box centred on (cx, cz) on the floor, rotated by yaw, half length `hl` along
 * its forward (+X), half width `hw`, height `h`. Null when missed.
 */
export function rayAgentBox(ray: Ray, cx: number, cz: number, yaw: number, hl: number, hw: number, h: number): number | null {
  // Into the agent frame: translate, then rotate by -yaw about Y.
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const ox = ray.origin.x - cx;
  const oz = ray.origin.z - cz;
  o.set(ox * c + oz * s, ray.origin.y, -ox * s + oz * c);
  d.set(ray.direction.x * c + ray.direction.z * s, ray.direction.y, -ray.direction.x * s + ray.direction.z * c);
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (p: number, v: number, lo: number, hi: number) => {
    if (Math.abs(v) < 1e-9) return p >= lo && p <= hi;
    let a = (lo - p) / v;
    let b = (hi - p) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!slab(o.x, d.x, -hl, hl) || !slab(o.y, d.y, 0, h) || !slab(o.z, d.z, -hw, hw)) return null;
  if (t1 < 0) return null;
  return Math.max(0, t0);
}

const v = new Vector3();
export interface ScreenPoint {
  x: number;
  y: number;
}
/** Screen position (CSS px within a w × h view) of a world point, or null when behind the camera. Writes into `out`
 *  when given (no allocation per call), else returns a new object. */
export function toScreen(camera: Camera, x: number, y: number, z: number, w: number, h: number, out?: ScreenPoint): ScreenPoint | null {
  v.set(x, y, z).project(camera);
  if (v.z > 1 || v.z < -1) return null;
  const o = out ?? { x: 0, y: 0 };
  o.x = ((v.x + 1) / 2) * w;
  o.y = ((1 - v.y) / 2) * h;
  return o;
}

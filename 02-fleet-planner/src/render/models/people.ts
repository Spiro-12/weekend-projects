// Warehouse people as instanced rigid parts (PROTOCOL §9): a picker in a hi-vis vest (#C8F031) with reflective bands,
// navy long sleeves, dark trousers, boots and a white hard hat, with swinging legs and arms, plus a picking cart in
// front (PART.CART, shown when the picker pushes one). `seatedDriver()` gives the static seated person that rides a
// manual forklift. Authored facing +Z, baked to face +X. `detail` 0 is the low-tier "simple people" version.
import * as THREE from 'three';
import { bakeParts, faceX, G, PART, triCount, xf, type BakedModel, type PartSpec, type RigPivots } from './parts.ts';
import { roundedBox } from './util.ts';

export const VEST = 0xc8f031;
const SHIRT = 0x27324a;
const TROUSERS = 0x262c37;
const BOOTS = 0x15171b;
const SKIN = 0xc28a66;
const HAT = 0xf2f3f5;
const BAND = 0xd9dee4;
const CART_METAL = 0x9aa1a8;
const CART_DARK = 0x2a2e35;
const CARDBOARD = 0xc49a6c;

const cloth = (geo: THREE.BufferGeometry, color: number, part: number = PART.BODY): PartSpec => ({ geo, color, part, rough: 0.82, metal: 0 });

/** Head with a hard hat, centred at (x, y, z) = the head centre. */
function head(specs: PartSpec[], x: number, y: number, z: number, seg: number) {
  specs.push(cloth(xf(G.sphere(0.098, seg, Math.max(6, seg - 4)), x, y, z, 0, 0, 0, 0.92, 1.05, 1), SKIN));
  specs.push({ geo: xf(new THREE.SphereGeometry(0.118, seg, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, y + 0.03, z + 0.005, 0, 0, 0, 1, 0.92, 1.08), color: HAT, rough: 0.35 });
  specs.push({ geo: xf(new THREE.CylinderGeometry(0.135, 0.135, 0.012, seg), x, y + 0.03, z + 0.03, 0, 0, 0, 1, 1, 1.12), color: HAT, rough: 0.35 });
}

/** Vest + shirt torso between y0 (waist) and y1 (shoulders), centred on x/z. */
function torso(specs: PartSpec[], x: number, y0: number, y1: number, z: number, seg: number, rx = 0) {
  const h = y1 - y0;
  const put = (g: THREE.BufferGeometry) => xf(g, x, y0, z, rx).translate(0, 0, 0);
  specs.push(cloth(put(new THREE.CylinderGeometry(0.16, 0.15, h, seg).translate(0, h / 2, 0).scale(1, 1, 0.64)), SHIRT));
  specs.push(cloth(put(new THREE.CylinderGeometry(0.168, 0.158, h * 0.82, seg, 1, true).translate(0, h * 0.44, 0).scale(1, 1, 0.68)), VEST));
  specs.push(cloth(put(new THREE.CylinderGeometry(0.17, 0.168, h * 0.12, seg, 1, true).translate(0, h * 0.1, 0).scale(1, 1, 0.68)), VEST));
  for (const f of [0.33, 0.6]) {
    specs.push({ geo: put(new THREE.CylinderGeometry(0.171, 0.169, 0.032, seg, 1, true).translate(0, h * f, 0).scale(1, 1, 0.69)), color: BAND, rough: 0.25, metal: 0.55 });
  }
  // Shoulders.
  for (const s of [1, -1]) specs.push(cloth(put(G.sphere(0.06, seg, 6).translate(s * 0.17, h - 0.045, 0)), SHIRT));
}

export function buildPicker(detail = 1): BakedModel {
  const seg = detail ? 12 : 7;
  const specs: PartSpec[] = [];
  const HIP_Y = 0.92;
  const KNEE_Y = 0.5;
  const SHOULDER_Y = 1.42;
  const ELBOW_Y = 1.14;
  const pivots: RigPivots = {};
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const x = side * 0.095;
    const leg = L ? PART.LEG_L : PART.LEG_R;
    const shin = L ? PART.SHIN_L : PART.SHIN_R;
    specs.push(cloth(xf(G.limb(0.083, 0.063, 0.44, seg, 0.95), x, HIP_Y + 0.02, 0), TROUSERS, leg));
    specs.push(cloth(xf(G.limb(0.062, 0.05, 0.42, seg, 0.95), x, KNEE_Y + 0.01, 0), TROUSERS, shin));
    specs.push({ geo: xf(roundedBox(0.105, 0.09, 0.27, 0.045, detail ? 3 : 1), x, 0, 0.04), color: BOOTS, part: shin, rough: 0.6 });
    pivots[L ? 'hipL' : 'hipR'] = new THREE.Vector3(x, HIP_Y, 0);
    pivots[L ? 'kneeL' : 'kneeR'] = new THREE.Vector3(x, KNEE_Y, 0);
  }
  specs.push(cloth(xf(roundedBox(0.31, 0.16, 0.2, 0.08, detail ? 3 : 1), 0, HIP_Y - 0.08, 0), TROUSERS));
  torso(specs, 0, HIP_Y + 0.04, SHOULDER_Y + 0.03, 0, seg + 2);
  specs.push(cloth(xf(new THREE.CylinderGeometry(0.045, 0.05, 0.09, seg), 0, SHOULDER_Y + 0.07, 0), SKIN));
  head(specs, 0, SHOULDER_Y + 0.2, 0.005, seg + 2);
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const x = side * 0.198;
    const arm = L ? PART.ARM_L : PART.ARM_R;
    const fore = L ? PART.FORE_L : PART.FORE_R;
    specs.push(cloth(xf(G.limb(0.05, 0.044, 0.3, seg), x, SHOULDER_Y + 0.01, 0), SHIRT, arm));
    specs.push(cloth(xf(G.limb(0.046, 0.04, 0.24, seg), x, ELBOW_Y + 0.01, 0), SHIRT, fore));
    specs.push(cloth(xf(G.sphere(0.043, seg, 6), x, ELBOW_Y - 0.27, 0.005, 0, 0, 0, 0.8, 1.2, 1), SKIN, fore));
    pivots[L ? 'shoulderL' : 'shoulderR'] = new THREE.Vector3(x, SHOULDER_Y, 0);
    pivots[L ? 'elbowL' : 'elbowR'] = new THREE.Vector3(x, ELBOW_Y, 0);
  }
  cart(specs, detail);
  const geometry = bakeParts(specs);
  faceX(geometry, pivots);
  return { geometry, pivots, size: { length: 0.4, width: 0.5, height: 1.78 }, stride: 1.35, tris: triCount(geometry) };
}

/** A two-shelf picking cart with a push handle at the picker's hands, a tote and a carton on it. */
function cart(specs: PartSpec[], detail: number) {
  const z0 = 0.44;
  const z1 = 1.22;
  const w = 0.56;
  const zc = (z0 + z1) / 2;
  const add = (geo: THREE.BufferGeometry, color: number, rough = 0.45, metal = 0.6) => specs.push({ geo, color, part: PART.CART, rough, metal });
  for (const sx of [-1, 1]) for (const z of [z0 + 0.03, z1 - 0.03]) add(new THREE.CylinderGeometry(0.014, 0.014, 0.96, 6).translate(sx * (w / 2 - 0.02), 0.56, z), CART_METAL);
  for (const y of [0.22, 0.66]) add(G.box(w, 0.03, z1 - z0, 0, y, zc), CART_DARK, 0.6, 0.2);
  add(new THREE.CylinderGeometry(0.016, 0.016, w + 0.04, 6).rotateZ(Math.PI / 2).translate(0, 1.07, z0), CART_DARK, 0.5, 0.3);
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.014, 0.014, 0.08, 6).translate(sx * (w / 2 - 0.02), 1.04, z0), CART_METAL);
  for (const sx of [-1, 1]) for (const z of [z0 + 0.05, z1 - 0.05]) add(G.axleX(0.05, 0.035, detail ? 10 : 6).translate(sx * (w / 2 - 0.04), 0.05, z), CART_DARK, 0.7, 0);
  // Load: a tote on the top shelf, a carton below.
  add(roundedBox(0.4, 0.22, 0.34, 0.03, 2).translate(0, 0.675, zc + 0.12), 0xe8772e, 0.55, 0);
  add(G.box(0.42, 0.3, 0.4, 0, 0.385, zc - 0.05), CARDBOARD, 0.85, 0);
}

/**
 * A seated forklift driver (static, no rig parts): hips at (x, y, z), facing +Z, hands forward to a steering wheel.
 * Used by the manual-forklift model.
 */
export function seatedDriver(x: number, y: number, z: number, seg = 10): PartSpec[] {
  const specs: PartSpec[] = [];
  for (const side of [1, -1]) {
    const sx = x + side * 0.1;
    specs.push(cloth(G.limb(0.08, 0.065, 0.42, seg).rotateX(-Math.PI / 2).translate(sx, y + 0.02, z), TROUSERS));
    specs.push(cloth(G.limb(0.06, 0.05, 0.42, seg).translate(sx, y + 0.02, z + 0.42), TROUSERS));
    specs.push({ geo: roundedBox(0.1, 0.09, 0.26, 0.04, 2).translate(sx, y - 0.45, z + 0.46), color: BOOTS, rough: 0.6 });
    // Arms reaching forward and down to the wheel.
    const ax = x + side * 0.2;
    specs.push(cloth(G.limb(0.052, 0.045, 0.28, seg).rotateX(-0.75).translate(ax, y + 0.5, z - 0.02), SHIRT));
    specs.push(cloth(G.limb(0.045, 0.04, 0.26, seg).rotateX(-1.45).translate(ax, y + 0.29, z + 0.17), SHIRT));
    specs.push(cloth(G.sphere(0.042, seg, 6).translate(ax * 0.92, y + 0.27, z + 0.42), SKIN));
  }
  specs.push(cloth(roundedBox(0.31, 0.15, 0.24, 0.08, 2).translate(x, y - 0.05, z), TROUSERS));
  torso(specs, x, y + 0.04, y + 0.53, z - 0.03, seg + 2, -0.08);
  specs.push(cloth(new THREE.CylinderGeometry(0.045, 0.05, 0.09, seg).translate(x, y + 0.58, z - 0.06), SKIN));
  head(specs, x, y + 0.71, z - 0.05, seg + 2);
  return specs;
}

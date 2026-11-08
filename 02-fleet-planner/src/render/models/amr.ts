// Generic tote-picking cart robot (AMR): Locus-like proportions, no branding. Code-built, one merged geometry:
// white shell, graphite skirt, metal mast and shelves, a tilted screen, a vendor-coloured light band around the base
// and a light bar on the mast cap (both ACCENT, so they glow in the vendor colour), and one orange tote per shelf
// (part TOTE, shown when the robot carries totes). About 1k triangles. Faces +X once baked.
import * as THREE from 'three';
import { bakeParts, EMIT, faceX, PART, triCount, xf, type BakedModel, type PartSpec } from './parts.ts';
import { roundedBand, roundedBox } from './util.ts';

export const AMR_SIZE = { width: 0.56, length: 0.76, height: 1.62 };

/** The tote used by AMRs and humanoids: an open box with a rolled rim, origin at its bottom centre. */
export function toteGeometry(tw = 0.42, th = 0.26, td = 0.44, t = 0.012): THREE.BufferGeometry[] {
  return [
    xf(new THREE.BoxGeometry(tw, t, td), 0, t / 2, 0),
    xf(new THREE.BoxGeometry(tw, th, t), 0, th / 2, -td / 2 + t / 2),
    xf(new THREE.BoxGeometry(tw, th, t), 0, th / 2, td / 2 - t / 2),
    xf(new THREE.BoxGeometry(t, th, td), -tw / 2 + t / 2, th / 2, 0),
    xf(new THREE.BoxGeometry(t, th, td), tw / 2 - t / 2, th / 2, 0),
    xf(new THREE.BoxGeometry(tw + 0.02, 0.015, 0.02), 0, th, -td / 2),
    xf(new THREE.BoxGeometry(tw + 0.02, 0.015, 0.02), 0, th, td / 2),
    xf(new THREE.BoxGeometry(0.02, 0.015, td), -tw / 2, th, 0),
    xf(new THREE.BoxGeometry(0.02, 0.015, td), tw / 2, th, 0),
  ];
}

export const TOTE_COLOR = 0xe8772e;

export function buildAmr(): BakedModel {
  const W = AMR_SIZE.width;
  const L = AMR_SIZE.length;
  const specs: PartSpec[] = [];
  const shell = (geo: THREE.BufferGeometry) => specs.push({ geo, color: 0xe9ecef, rough: 0.34 });
  const dark = (geo: THREE.BufferGeometry) => specs.push({ geo, color: 0x23262b, rough: 0.55, metal: 0.1 });
  const metal = (geo: THREE.BufferGeometry) => specs.push({ geo, color: 0x9aa1a8, rough: 0.38, metal: 0.85 });

  // Lower skirt (graphite) and upper cover (white), rounded.
  dark(xf(roundedBox(W, 0.13, L, 0.12, 3), 0, 0.035, 0));
  shell(xf(roundedBox(W - 0.01, 0.13, L - 0.01, 0.12, 3, 0.02), 0, 0.185, 0));
  // Front lidar window and wheels peeking out.
  dark(xf(new THREE.BoxGeometry(W * 0.62, 0.035, 0.02), 0, 0.2, L / 2 - 0.005));
  const wheel = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10).rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) dark(xf(wheel, sx * (W / 2 - 0.06), 0.06, 0));
  // Mast: two uprights at the back, a top cap, shelves spanning forward.
  const mastZ = -L / 2 + 0.08;
  const mastTop = AMR_SIZE.height - 0.08;
  for (const sx of [-1, 1]) metal(xf(new THREE.BoxGeometry(0.04, mastTop - 0.31, 0.04), sx * 0.22, 0.31 + (mastTop - 0.31) / 2, mastZ));
  shell(xf(roundedBox(0.5, 0.05, 0.08, 0.02, 2), 0, mastTop, mastZ));
  const shelfYs = [0.42, 0.8, 1.18];
  for (const y of shelfYs) {
    dark(xf(new THREE.BoxGeometry(0.46, 0.012, 0.48), 0, y, mastZ + 0.27));
    metal(xf(new THREE.BoxGeometry(0.48, 0.03, 0.015), 0, y + 0.02, mastZ + 0.515));
    for (const sx of [-1, 1]) metal(xf(new THREE.BoxGeometry(0.015, 0.03, 0.5), sx * 0.235, y + 0.02, mastZ + 0.27));
  }
  // Screen on a short arm at the top, tilted toward the picker (front).
  const screenY = mastTop + 0.02;
  dark(xf(new THREE.BoxGeometry(0.03, 0.12, 0.03), 0, screenY + 0.06, mastZ + 0.02));
  dark(xf(roundedBox(0.26, 0.022, 0.18, 0.02, 2), 0, screenY + 0.14, mastZ + 0.06, Math.PI / 2 - 0.45));
  specs.push({ geo: xf(new THREE.PlaneGeometry(0.22, 0.14), 0, screenY + 0.145, mastZ + 0.075, -0.45), color: 0x3d8fe0, emit: EMIT.SOFT, rough: 0.15 });

  // Totes: one per shelf.
  for (const y of shelfYs) for (const g of toteGeometry()) specs.push({ geo: xf(g, 0, y + 0.009, mastZ + 0.27), color: TOTE_COLOR, rough: 0.55, part: PART.TOTE });

  // Light band around the base and a light bar on the mast cap (vendor colour).
  specs.push({ geo: roundedBand(W + 0.014, L + 0.014, 0.125, 0.017, 0.026).translate(0, 0.15, 0), color: 0xffffff, emit: EMIT.ACCENT, rough: 0.4 });
  specs.push({ geo: xf(new THREE.BoxGeometry(0.42, 0.022, 0.05), 0, mastTop + 0.036, mastZ), color: 0xffffff, emit: EMIT.ACCENT, rough: 0.4 });

  const geometry = bakeParts(specs);
  const pivots = {};
  faceX(geometry, pivots);
  return { geometry, pivots, size: { length: L, width: W, height: AMR_SIZE.height }, tris: triCount(geometry) };
}

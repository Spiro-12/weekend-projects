// Generic tote-picking cart robot (AMR): Locus-like proportions, no branding. Pure geometry + materials.
// Named parts for Track E: `body` (chassis, mast, shelves, screen), `totes` (one tote per shelf), `light`
// (bumper light strip, emissive). Forward is +z. Origin on the floor at the footprint centre. About 3k triangles.
import * as THREE from 'three';
import { mergedMesh, place, roundedBox } from './util.ts';

export interface AmrOptions {
  /** Light strip and accent colour (vendor colour). */
  accent?: THREE.ColorRepresentation;
  /** Tote colour. */
  tote?: THREE.ColorRepresentation;
  /** Number of tote shelves (2 or 3). */
  shelves?: 2 | 3;
}

const mats = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = mats.get(key);
  if (!m) mats.set(key, (m = make()));
  return m;
}

export const AMR_SIZE = { width: 0.56, length: 0.76, height: 1.62 };

export function buildAmr(opts: AmrOptions = {}): THREE.Group {
  const accent = new THREE.Color(opts.accent ?? 0x2fd6ff);
  const toteColor = new THREE.Color(opts.tote ?? 0xe86a1c);
  const shelves = opts.shelves ?? 3;
  const W = AMR_SIZE.width;
  const L = AMR_SIZE.length;

  const shell = mat('shell', () => new THREE.MeshStandardMaterial({ name: 'amr_shell', color: 0xe9ecef, roughness: 0.32, metalness: 0 }));
  const graphite = mat('graphite', () => new THREE.MeshStandardMaterial({ name: 'amr_graphite', color: 0x23262b, roughness: 0.55, metalness: 0.1 }));
  const metal = mat('metal', () => new THREE.MeshStandardMaterial({ name: 'amr_metal', color: 0x9aa1a8, roughness: 0.38, metalness: 0.85 }));
  const glass = mat('screen', () => new THREE.MeshStandardMaterial({ name: 'amr_screen', color: 0x0b0e12, roughness: 0.12, metalness: 0.2, emissive: 0x1a5fa0, emissiveIntensity: 0.9 }));
  const light = mat(`light_${accent.getHexString()}`, () => new THREE.MeshStandardMaterial({ name: 'amr_light', color: accent, emissive: accent, emissiveIntensity: 2.2, roughness: 0.4 }));
  const tote = mat(`tote_${toteColor.getHexString()}`, () => new THREE.MeshStandardMaterial({ name: 'amr_tote', color: toteColor, roughness: 0.55, metalness: 0 }));

  const g = new THREE.Group();
  g.name = 'amr';

  // ── body ──
  const shellGeos: THREE.BufferGeometry[] = [];
  const darkGeos: THREE.BufferGeometry[] = [];
  const metalGeos: THREE.BufferGeometry[] = [];
  // Lower skirt (graphite) and upper cover (white), rounded.
  darkGeos.push(place(roundedBox(W, 0.13, L, 0.12, 4), 0, 0.035, 0));
  shellGeos.push(place(roundedBox(W - 0.01, 0.13, L - 0.01, 0.12, 4, 0.02), 0, 0.185, 0));
  // Front lidar window (dark band) and wheels peeking out.
  darkGeos.push(place(new THREE.BoxGeometry(W * 0.62, 0.035, 0.02), 0, 0.2, L / 2 - 0.005));
  const wheel = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12).rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) darkGeos.push(place(wheel, sx * (W / 2 - 0.06), 0.06, 0));
  // Mast: two uprights at the back, a top cap, shelves spanning forward.
  const mastZ = -L / 2 + 0.08;
  const mastTop = AMR_SIZE.height - 0.08;
  for (const sx of [-1, 1]) {
    metalGeos.push(place(new THREE.BoxGeometry(0.04, mastTop - 0.31, 0.04), sx * 0.22, 0.31 + (mastTop - 0.31) / 2, mastZ));
  }
  shellGeos.push(place(roundedBox(0.5, 0.05, 0.08, 0.02, 2), 0, mastTop, mastZ));
  const shelfYs = shelves === 3 ? [0.42, 0.8, 1.18] : [0.5, 1.0];
  for (const y of shelfYs) {
    metalGeos.push(place(new THREE.BoxGeometry(0.48, 0.018, 0.5), 0, y, mastZ + 0.27));
    metalGeos.push(place(new THREE.BoxGeometry(0.48, 0.05, 0.015), 0, y + 0.03, mastZ + 0.515)); // front lip
  }
  // Screen on a short arm at the top, tilted toward the picker (front).
  const screenY = mastTop + 0.02;
  darkGeos.push(place(new THREE.BoxGeometry(0.03, 0.12, 0.03), 0, screenY + 0.06, mastZ + 0.02));
  const screenFrame = place(roundedBox(0.26, 0.022, 0.18, 0.02, 2), 0, 0, 0);
  screenFrame.rotateX(Math.PI / 2 - 0.45);
  screenFrame.translate(0, screenY + 0.14, mastZ + 0.06);
  darkGeos.push(screenFrame);
  const screenFace = new THREE.PlaneGeometry(0.22, 0.14);
  screenFace.rotateX(-0.45);
  screenFace.translate(0, screenY + 0.145, mastZ + 0.075);

  const body = new THREE.Group();
  body.name = 'body';
  body.add(mergedMesh('body_shell', shellGeos, shell), mergedMesh('body_dark', darkGeos, graphite), mergedMesh('body_metal', metalGeos, metal));
  const screen = mergedMesh('body_screen', [screenFace], glass);
  screen.castShadow = false;
  body.add(screen);
  g.add(body);

  // ── totes: open boxes, one per shelf ──
  const toteGeos: THREE.BufferGeometry[] = [];
  const tw = 0.42, td = 0.44, th = shelves === 3 ? 0.26 : 0.3, t = 0.012;
  for (const y of shelfYs) {
    const z = mastZ + 0.27;
    const y0 = y + 0.009;
    toteGeos.push(place(new THREE.BoxGeometry(tw, t, td), 0, y0 + t / 2, z));
    toteGeos.push(place(new THREE.BoxGeometry(tw, th, t), 0, y0 + th / 2, z - td / 2 + t / 2));
    toteGeos.push(place(new THREE.BoxGeometry(tw, th, t), 0, y0 + th / 2, z + td / 2 - t / 2));
    toteGeos.push(place(new THREE.BoxGeometry(t, th, td), -tw / 2 + t / 2, y0 + th / 2, z));
    toteGeos.push(place(new THREE.BoxGeometry(t, th, td), tw / 2 - t / 2, y0 + th / 2, z));
    // Rolled rim.
    toteGeos.push(place(new THREE.BoxGeometry(tw + 0.02, 0.015, 0.02), 0, y0 + th, z - td / 2));
    toteGeos.push(place(new THREE.BoxGeometry(tw + 0.02, 0.015, 0.02), 0, y0 + th, z + td / 2));
  }
  const totes = mergedMesh('totes', toteGeos, tote);
  g.add(totes);

  // ── light: bumper strip around the base ──
  const strip = new THREE.Shape();
  const ring = (w: number, d: number, r: number, path: THREE.Shape | THREE.Path) => {
    const x = -w / 2, y = -d / 2;
    path.moveTo(x + r, y);
    path.lineTo(x + w - r, y);
    path.quadraticCurveTo(x + w, y, x + w, y + r);
    path.lineTo(x + w, y + d - r);
    path.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    path.lineTo(x + r, y + d);
    path.quadraticCurveTo(x, y + d, x, y + d - r);
    path.lineTo(x, y + r);
    path.quadraticCurveTo(x, y, x + r, y);
  };
  ring(W + 0.012, L + 0.012, 0.125, strip);
  const hole = new THREE.Path();
  ring(W - 0.02, L - 0.02, 0.11, hole);
  strip.holes.push(hole);
  const stripGeo = new THREE.ExtrudeGeometry(strip, { depth: 0.022, bevelEnabled: false, curveSegments: 4 });
  stripGeo.rotateX(-Math.PI / 2);
  stripGeo.translate(0, 0.152, 0);
  const lightMesh = mergedMesh('light', [stripGeo], light);
  lightMesh.castShadow = false;
  g.add(lightMesh);

  return g;
}

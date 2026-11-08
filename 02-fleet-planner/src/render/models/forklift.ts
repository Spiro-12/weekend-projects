// Forklifts baked from the SimReady GLBs (loaded through the shared asset loader) into one rig geometry each:
// - autonomous: the walk-behind `stacker` made about 1.5× more solid (scaled, widened), tiller removed, plus code
//   dressing: a drive-unit cover, a sensor mast with a spinning lidar puck (PART.LIDAR), a front safety scanner, an
//   amber warning light, a blue LED and a vendor light band (ACCENT). The blue floor spot is an fx decal.
// - driven: the counterbalance `forklift` with a seated driver in a hi-vis vest.
// Both are recoloured from the SimReady blue to chunky red/orange (#D9452B) with a black mast (Gate 0 review), forks
// and carriage lift (PART.FORKS), the inner mast extends past the free lift (PART.MAST), and a code-built loaded
// pallet rides on the forks (PART.PALLET). Authored facing +Z (like the GLBs), baked to face +X.
import * as THREE from 'three';
import { bakeParts, EMIT, faceX, G, PART, plain, triCount, type BakedModel, type PartSpec, type RigPivots } from './parts.ts';
import { seatedDriver } from './people.ts';
import { roundedBox } from './util.ts';

export const FORKLIFT_PAINT = 0xc8391d;
const BLACK = 0x17191c;
const WOOD = 0xb38b5d;
const CARDBOARD = [0xc49a6c, 0xbd9263, 0xcaa275, 0xb88c5c];

const paint = new THREE.Color(FORKLIFT_PAINT);

/** Recolour a baked SimReady vertex colour (linear): saturated paint → red/orange, the mast and forks → black. */
function recolor(c: Float32Array, part: number) {
  for (let i = 0; i < c.length; i += 3) {
    const r = c[i];
    const g = c[i + 1];
    const b = c[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (part === PART.MAST || part === PART.FORKS) {
      const k = Math.min(1, 0.05 + lum * 0.25);
      c[i] = c[i + 1] = c[i + 2] = k * 0.12 + 0.012;
      continue;
    }
    // Saturated (painted) or the SimReady blue: red/orange paint, keeping a little of the baked shading.
    if (mx - mn > 0.2 || (b > r + 0.15 && b > g + 0.1)) {
      const shade = Math.min(1.05, 0.82 + mx * 0.2);
      c[i] = paint.r * shade;
      c[i + 1] = paint.g * shade;
      c[i + 2] = paint.b * shade;
    }
  }
}

interface Piece {
  geo: THREE.BufferGeometry;
  part: number;
}

/** World-space geometry of every opaque mesh in a GLB scene, tagged with its moving part. */
function piecesOf(scene: THREE.Object3D, skip: (name: string) => boolean): Piece[] {
  scene.updateMatrixWorld(true);
  const out: Piece[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat.transparent || /film/i.test(mat.name ?? '')) return;
    let part: number = PART.BODY;
    let skipIt = false;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) {
      if (skip(p.name)) skipIt = true;
      if (p.name === 'forks' || p.name === 'carriage') part = PART.FORKS;
      else if (p.name === 'mast' && part === PART.BODY) part = PART.MAST;
    }
    if (skipIt) return;
    const g = plain(m.geometry);
    g.applyMatrix4(m.matrixWorld);
    if (!g.attributes.color) {
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      const c = mat.color ?? new THREE.Color(1, 1, 1);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    recolor(g.attributes.color.array as Float32Array, part);
    out.push({ geo: g, part });
  });
  return out;
}

function boundsOf(pieces: Piece[], filter: (p: Piece) => boolean = () => true): THREE.Box3 {
  const b = new THREE.Box3();
  for (const p of pieces) if (filter(p)) {
    p.geo.computeBoundingBox();
    b.union(p.geo.boundingBox!);
  }
  return b;
}

/** A loaded euro pallet (1.2 m along the forks), bottom at y = 0, back edge at z = 0, centred on x. */
function loadedPallet(): PartSpec[] {
  const specs: PartSpec[] = [];
  const wood = (geo: THREE.BufferGeometry) => specs.push({ geo, color: WOOD, part: PART.PALLET, rough: 0.85 });
  const L = 1.2;
  const W = 0.8;
  for (const x of [-0.35, -0.175, 0, 0.175, 0.35]) wood(G.box(0.1, 0.022, L, x, 0.133, L / 2));
  for (const x of [-0.35, 0, 0.35]) {
    wood(G.box(0.1, 0.022, L, x, 0.011, L / 2));
    for (const z of [0.05, L / 2, L - 0.05]) wood(G.box(0.1, 0.078, 0.1, x, 0.061, z));
  }
  for (const z of [0.05, L / 2, L - 0.05]) wood(G.box(W, 0.022, 0.1, 0, 0.111, z));
  // Cartons: 2 across × 3 along × 2 high, with a little deterministic jitter and shade variation.
  let k = 0;
  for (let ly = 0; ly < 2; ly++)
    for (let ix = 0; ix < 2; ix++)
      for (let iz = 0; iz < 3; iz++) {
        const j = ((k * 7919) % 13) / 13 - 0.5;
        const h = 0.3 + (ly === 1 ? 0.02 * j : 0);
        specs.push({
          geo: G.box(0.38, h, 0.38, (ix - 0.5) * 0.39 + j * 0.01, 0.144 + ly * 0.305 + h / 2, 0.21 + iz * 0.39),
          color: CARDBOARD[k % CARDBOARD.length],
          part: PART.PALLET,
          rough: 0.88,
        });
        k++;
      }
  return specs;
}

function finish(specs: PartSpec[], pivots: RigPivots, freeLift: number, size: BakedModel['size']): BakedModel {
  const geometry = bakeParts(specs);
  faceX(geometry, pivots);
  return { geometry, pivots, size, freeLift, tris: triCount(geometry) };
}

/** Transform every piece: centre the footprint on the origin, floor at y = 0, then scale (sx, sy, sz). */
function normalise(pieces: Piece[], sx: number, sy: number, sz: number): THREE.Box3 {
  const b = boundsOf(pieces);
  const c = b.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4().makeScale(sx, sy, sz).multiply(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
  for (const p of pieces) p.geo.applyMatrix4(m);
  return boundsOf(pieces);
}

/** Autonomous forklift from the `stacker` GLB scene (not modified). */
export function bakeAutonomousForklift(stacker: THREE.Object3D): BakedModel {
  const pieces = piecesOf(stacker, (n) => n === 'tiller');
  const box = normalise(pieces, 1.42, 1.3, 1.3);
  const forks = boundsOf(pieces, (p) => p.part === PART.FORKS);
  const body = boundsOf(pieces, (p) => p.part === PART.BODY);
  const specs: PartSpec[] = pieces.map((p) => ({ geo: p.geo, color: null, part: p.part, rough: p.part === PART.BODY ? 0.55 : 0.5, metal: p.part === PART.BODY ? 0.05 : 0.45 }));
  const top = body.max.y;
  const back = box.min.z;
  const W = box.max.x - box.min.x;

  // Drive-unit cover over the back (where the tiller was): a chunky painted housing with a dark top.
  const coverD = 0.62;
  const coverH = 1.0;
  specs.push({ geo: roundedBox(W * 0.98, coverH, coverD, 0.09, 3, 0.02).translate(0, 0.12, back + coverD / 2), color: FORKLIFT_PAINT, rough: 0.55, metal: 0.05 });
  specs.push({ geo: roundedBox(W * 0.9, 0.05, coverD - 0.06, 0.07, 3).translate(0, 0.12 + coverH, back + coverD / 2), color: BLACK, rough: 0.6, metal: 0.2 });
  specs.push({ geo: G.box(W * 1.0, 0.12, coverD + 0.02, 0, 0.06, back + coverD / 2), color: BLACK, rough: 0.7 });
  // Vendor light band around the cover.
  specs.push({ geo: G.box(W * 0.99 + 0.012, 0.03, coverD + 0.012, 0, 0.12 + coverH * 0.72, back + coverD / 2), color: 0xffffff, emit: EMIT.ACCENT });
  // Sensor mast with a lidar puck on top, safety scanner low at the back, amber warning light, blue LED.
  const mastZ = back + 0.12;
  const mastH = top + 0.35;
  specs.push({ geo: new THREE.CylinderGeometry(0.03, 0.03, mastH - coverH, 10).translate(0, coverH + (mastH - coverH) / 2, mastZ), color: 0xb8bec5, rough: 0.35, metal: 0.85 });
  const lidar = new THREE.Vector3(0, mastH, mastZ);
  specs.push({ geo: new THREE.CylinderGeometry(0.075, 0.08, 0.09, 18).translate(lidar.x, lidar.y + 0.045, lidar.z), color: BLACK, rough: 0.35, metal: 0.4, part: PART.LIDAR });
  specs.push({ geo: G.box(0.03, 0.04, 0.16, 0.06, lidar.y + 0.05, lidar.z), color: 0x6fe8ff, emit: EMIT.SELF, part: PART.LIDAR });
  specs.push({ geo: new THREE.CylinderGeometry(0.065, 0.065, 0.025, 18).translate(lidar.x, lidar.y + 0.1, lidar.z), color: 0x2a2e35, rough: 0.4, metal: 0.4, part: PART.LIDAR });
  specs.push({ geo: G.box(0.22, 0.09, 0.08, 0, 0.26, back - 0.02), color: BLACK, rough: 0.3, metal: 0.4 });
  specs.push({ geo: G.box(0.2, 0.05, 0.05, 0, coverH + 0.18, mastZ + 0.08), color: 0xffa21a, emit: EMIT.SELF });
  specs.push({ geo: G.box(0.07, 0.05, 0.05, 0, top + 0.05, back + 0.3), color: 0x2a7bff, emit: EMIT.SELF });

  // Loaded pallet on the forks.
  const palletZ = forks.min.z + 0.18;
  for (const s of loadedPallet()) specs.push({ ...s, geo: s.geo.translate(0, forks.min.y + 0.045, palletZ) });

  const pivots: RigPivots = { lidar };
  const size = { length: box.max.z - box.min.z, width: W, height: mastH + 0.1 };
  return finish(specs, pivots, 0.5, size);
}

/** Manual (driven) counterbalance forklift with a seated driver, from the `forklift` GLB scene (not modified). */
export function bakeDrivenForklift(forklift: THREE.Object3D): BakedModel {
  const pieces = piecesOf(forklift, () => false);
  const box = normalise(pieces, 1, 1, 1);
  const forks = boundsOf(pieces, (p) => p.part === PART.FORKS);
  const specs: PartSpec[] = pieces.map((p) => ({ geo: p.geo, color: null, part: p.part, rough: p.part === PART.BODY ? 0.55 : 0.5, metal: p.part === PART.BODY ? 0.05 : 0.45 }));
  // Seated driver (hips over the seat, a little behind the middle).
  const len = box.max.z - box.min.z;
  for (const s of seatedDriver(0, 1.02, box.min.z + len * 0.36)) specs.push(s);
  const palletZ = forks.min.z + 0.12;
  for (const s of loadedPallet()) specs.push({ ...s, geo: s.geo.translate(0, forks.min.y + 0.04, palletZ) });
  const size = { length: len, width: box.max.x - box.min.x, height: box.max.y };
  return finish(specs, {}, 1.2, size);
}

/** Placeholder until the GLB arrives: a simple boxy forklift in the same colours (never blank). */
export function bakeForkliftPlaceholder(driven: boolean): BakedModel {
  const specs: PartSpec[] = [
    { geo: roundedBox(1.0, 1.0, 1.5, 0.1, 2).translate(0, 0.12, -0.35), color: FORKLIFT_PAINT, rough: 0.42 },
    { geo: G.box(0.9, 2.2, 0.1, 0, 1.1, 0.45), color: BLACK, part: PART.MAST, rough: 0.5, metal: 0.4 },
    { geo: G.box(0.6, 0.05, 1.0, 0, 0.08, 1.0), color: BLACK, part: PART.FORKS, rough: 0.5, metal: 0.4 },
  ];
  if (driven) for (const s of seatedDriver(0, 1.02, -0.5, 6)) specs.push(s);
  else specs.push({ geo: G.box(0.9, 0.03, 1.5, 0, 0.8, -0.35), color: 0xffffff, emit: EMIT.ACCENT });
  return finish(specs, {}, 1.2, { length: 2.5, width: 1, height: 2.3 });
}

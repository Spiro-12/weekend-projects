// Static warehouse from the layout grid: merged floor, merged walls and props, instanced racking, pallets and boxes.
// Draw calls: floor 1, walls/props 1, racking 1, pallets 1, boxes one per chunk (6). Nothing here moves.
import {
  BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  PlaneGeometry, Quaternion, Vector3, type Camera,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Cell } from '../../../src/sim/world.ts';
import { Rng } from '../../../src/sim/rng.ts';
import { CELL, type Grid } from './grid.ts';
import { contactShadowCanvas, floorCanvas, toTexture } from './textures.ts';

export interface StaticWorld {
  group: Group;
  boxChunks: { mesh: InstancedMesh; min: Vector3; max: Vector3 }[];
  counts: { boxes: number; pallets: number; rackParts: number };
  /** Hide box chunks farther than `farM` from the camera (low tier). */
  cullBoxes(camera: Camera, farM: number): void;
}

const LEVEL_GAP = 1.8;
const BEAM_H = 0.12;
const PALLET_H = 0.144;

export function buildStaticWorld(grid: Grid, anisotropy: number): StaticWorld {
  const { world } = grid;
  const group = new Group();
  group.name = 'static';
  const levels = world.layout.racks.levels;
  const rackH = world.layout.racks.heightMm / 1000;

  // ── Floor: one plane, paint + baked contact shadow in the colour map, the shadow again as aoMap.
  const shadow = contactShadowCanvas(world);
  const floorTex = toTexture(floorCanvas(world, shadow), true, anisotropy);
  const aoTex = toTexture(shadow, false, 1);
  const floorGeo = new PlaneGeometry(grid.sizeX, grid.sizeZ);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new Mesh(
    floorGeo,
    new MeshStandardMaterial({
      map: floorTex, aoMap: aoTex, aoMapIntensity: 1, roughness: 0.22, metalness: 0,
      emissiveMap: floorTex, emissive: new Color(0.22, 0.22, 0.22),
    }),
  );
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);

  // ── Walls and props: one merged geometry with vertex colours.
  const parts: BufferGeometry[] = [];
  const addBox = (x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: string) => {
    const g = new BoxGeometry(sx, sy, sz);
    g.translate(x, y + sy / 2, z);
    const c = new Color(hex);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    parts.push(g);
  };
  for (let y = 0; y < world.height; y++)
    for (let x = 0; x < world.width; x++) {
      const i = y * world.width + x;
      const k = world.code[i];
      const px = grid.cellX[i];
      const pz = grid.cellZ[i];
      const edge = x === 0 || y === 0 || x === world.width - 1 || y === world.height - 1;
      if (k === Cell.Wall) {
        if (edge) addBox(px, 0, pz, CELL, 6, CELL, '#262b33');
        else addBox(px, 0, pz, CELL, 0.9, CELL, '#1c2027'); // conveyor bed / low partition
      } else if (k === Cell.Dock) {
        addBox(px, 0, pz, CELL, 6, CELL * 0.6, '#262b33');
        addBox(px, 0, pz + CELL * 0.31, CELL * 0.96, 4.2, 0.06, '#5b6472'); // door panel
        addBox(px, 0, pz + CELL * 0.36, CELL * 0.96, 0.25, 0.1, '#f5c518'); // bumper
      } else if (k === Cell.Pack) {
        addBox(px, 0, pz, CELL * 0.95, 0.9, CELL * 0.8, '#4b5563');
        addBox(px, 0.9, pz, CELL * 0.95, 0.04, CELL * 0.8, '#9aa3ad');
      } else if (k === Cell.Charger) {
        addBox(px, 0, pz + CELL * 0.35, 0.4, 1.1, 0.25, '#1f2937');
        addBox(px, 0.8, pz + CELL * 0.22, 0.3, 0.12, 0.02, '#34d399');
      }
    }
  const props = new Mesh(mergeGeometries(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 }));
  for (const p of parts) p.dispose();
  props.name = 'walls+props';
  group.add(props);

  // ── Racking: uprights, frame ties and beams are all scaled unit boxes in ONE InstancedMesh (instance colours).
  const isRack = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < world.width && y < world.height && world.code[y * world.width + x] === Cell.Rack;
  type Mat = { p: Vector3; s: Vector3; c: Color };
  const rack: Mat[] = [];
  const UPRIGHT = new Color('#2d5d9f');
  const BEAM = new Color('#e8743b');
  const TIE = new Color('#25507f');
  const uprightSeen = new Set<string>();
  // Per rack cell: front and back rails inset from the cell edge (0.15 m on an aisle side, 0.1 m flue between backs).
  const rackCells: number[] = [];
  for (let y = 0; y < world.height; y++)
    for (let x = 0; x < world.width; x++) {
      if (!isRack(x, y)) continue;
      rackCells.push(y * world.width + x);
      const left = grid.edgeX(x) + (isRack(x - 1, y) ? 0.1 : 0.15);
      const right = grid.edgeX(x + 1) - (isRack(x + 1, y) ? 0.1 : 0.15);
      for (const ey of [y, y + 1]) {
        const key = `${x}:${ey}`;
        if (uprightSeen.has(key)) continue;
        uprightSeen.add(key);
        const z = grid.edgeZ(ey) + (ey === y ? (isRack(x, y - 1) ? 0 : 0.05) : isRack(x, y + 1) ? 0 : -0.05);
        for (const rx of [left, right]) rack.push({ p: new Vector3(rx, rackH / 2, z), s: new Vector3(0.08, rackH, 0.08), c: UPRIGHT });
        for (const h of [0.4, rackH * 0.5, rackH - 0.2])
          rack.push({ p: new Vector3((left + right) / 2, h, z), s: new Vector3(right - left, 0.04, 0.04), c: TIE });
      }
      const zc = grid.edgeZ(y + 0.5);
      for (let l = 1; l < levels; l++)
        for (const rx of [left, right])
          rack.push({ p: new Vector3(rx, l * LEVEL_GAP - BEAM_H / 2, zc), s: new Vector3(0.06, BEAM_H, CELL - 0.08), c: BEAM });
    }
  const unit = new BoxGeometry(1, 1, 1);
  const racking = new InstancedMesh(unit, new MeshStandardMaterial({ roughness: 0.45, metalness: 0.55 }), rack.length);
  const m = new Matrix4();
  const q = new Quaternion();
  rack.forEach((r, i) => {
    racking.setMatrixAt(i, m.compose(r.p, q, r.s));
    racking.setColorAt(i, r.c);
  });
  racking.computeBoundingSphere();
  racking.name = 'racking';
  group.add(racking);

  // ── Pallets and boxes: one pallet per cell per level (about 7% empty), 1 to 4 boxes on it.
  const rng = new Rng(2024);
  const palletGeo = makePalletGeometry();
  const pallets = new InstancedMesh(palletGeo, new MeshStandardMaterial({ color: '#8a6a45', roughness: 0.9 }), rackCells.length * levels);
  const BOX_COLORS = ['#b8875a', '#a9784b', '#c79b67', '#9c6d43', '#b8875a', '#d9dcd6', '#2e66b8', '#c79b67'].map((h) => new Color(h));
  const CHUNKS_X = 3;
  const CHUNKS_Y = 2;
  type B = { p: Vector3; s: Vector3; c: Color };
  const chunkBoxes: B[][] = Array.from({ length: CHUNKS_X * CHUNKS_Y }, () => []);
  const storage = world.layout.zones.find((z) => z.kind === 'storage')!;
  let nPallets = 0;
  for (const ci of rackCells) {
    const x = ci % world.width;
    const y = (ci - x) / world.width;
    const left = grid.edgeX(x) + (isRack(x - 1, y) ? 0.1 : 0.15);
    const right = grid.edgeX(x + 1) - (isRack(x + 1, y) ? 0.1 : 0.15);
    const cxm = (left + right) / 2;
    const zc = grid.cellZ[ci];
    const bx = Math.min(CHUNKS_X - 1, Math.max(0, Math.floor(((x - storage.x) / storage.w) * CHUNKS_X)));
    const by = Math.min(CHUNKS_Y - 1, Math.max(0, Math.floor(((y - storage.y) / storage.h) * CHUNKS_Y)));
    const chunk = chunkBoxes[by * CHUNKS_X + bx];
    for (let l = 0; l < levels; l++) {
      if (rng.int(100) < 7) continue;
      const base = l === 0 ? 0 : l * LEVEL_GAP;
      pallets.setMatrixAt(nPallets++, m.compose(new Vector3(cxm, base, zc), q, new Vector3(1, 1, 1)));
      const top = base + PALLET_H;
      const maxH = (l === levels - 1 ? rackH - l * LEVEL_GAP : LEVEL_GAP - BEAM_H) - PALLET_H - 0.12;
      const color = () => BOX_COLORS[rng.int(BOX_COLORS.length)];
      const t = rng.int(10);
      if (t < 2) {
        const h = maxH * (0.7 + rng.int(30) / 100);
        chunk.push({ p: new Vector3(cxm, top + h / 2, zc), s: new Vector3(1.1, h, 0.95), c: BOX_COLORS[5] });
      } else if (t < 6) {
        for (const dz of [-0.24, 0.24]) {
          const h = maxH * (0.45 + rng.int(50) / 100);
          chunk.push({ p: new Vector3(cxm, top + h / 2, zc + dz), s: new Vector3(1.05, h, 0.46), c: color() });
        }
        if (rng.int(2) === 0) {
          const h = 0.3 + rng.int(20) / 100;
          chunk.push({ p: new Vector3(cxm, top + maxH * 0.5 + h / 2, zc), s: new Vector3(0.5, h, 0.45), c: color() });
        }
      } else {
        const h = maxH * (0.35 + rng.int(25) / 100);
        for (const dx of [-0.28, 0.28])
          for (const dz of [-0.24, 0.24])
            chunk.push({ p: new Vector3(cxm + dx, top + h / 2, zc + dz), s: new Vector3(0.54, h, 0.46), c: color() });
      }
    }
  }
  pallets.count = nPallets;
  pallets.computeBoundingSphere();
  pallets.name = 'pallets';
  group.add(pallets);

  const boxMat = new MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
  const boxChunks: StaticWorld['boxChunks'] = [];
  let nBoxes = 0;
  for (const list of chunkBoxes) {
    if (!list.length) continue;
    const mesh = new InstancedMesh(unit, boxMat, list.length);
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    list.forEach((b, i) => {
      mesh.setMatrixAt(i, m.compose(b.p, q, b.s));
      mesh.setColorAt(i, b.c);
      min.min(b.p);
      max.max(b.p);
    });
    mesh.computeBoundingSphere();
    mesh.name = `boxes-${boxChunks.length}`;
    group.add(mesh);
    boxChunks.push({ mesh, min, max });
    nBoxes += list.length;
  }

  const tmp = new Vector3();
  return {
    group,
    boxChunks,
    counts: { boxes: nBoxes, pallets: nPallets, rackParts: rack.length },
    cullBoxes(camera, farM) {
      for (const c of boxChunks) {
        if (!Number.isFinite(farM)) {
          c.mesh.visible = true;
          continue;
        }
        tmp.copy(camera.position).clamp(c.min, c.max);
        c.mesh.visible = tmp.distanceTo(camera.position) < farM;
      }
    },
  };
}

/** A 1.2 x 1.0 m pallet: top deck plus three runners (60 triangles). Origin at the bottom centre. */
function makePalletGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const top = new BoxGeometry(1.2, 0.03, 1.0);
  top.translate(0, PALLET_H - 0.015, 0);
  parts.push(top);
  for (const dz of [-0.44, 0, 0.44]) {
    const r = new BoxGeometry(1.2, PALLET_H - 0.03, 0.1);
    r.translate(0, (PALLET_H - 0.03) / 2, dz);
    parts.push(r);
  }
  const bottom = new BoxGeometry(1.2, 0.02, 0.98);
  bottom.translate(0, 0.01, 0);
  parts.push(bottom);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

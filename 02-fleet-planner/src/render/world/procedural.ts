// Procedural warehouse (Phase 0 lead version; Track D owns src/render/world/ from Phase 1 and swaps in SimReady GLBs).
// Everything here is built from a few KB of code, so the first useful view needs no asset downloads.
// Draw calls: floor 1, walls 1, uprights 1, beams 1, pallets 1, loads 1, docks 2, stations 2, conveyors 2, chargers 2.
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { LayoutFile } from '../../contracts/types.ts';
import { CELL_M } from '../core/geom.ts';

export interface WorldBuild {
  group: Group;
  sizeX: number;
  sizeZ: number;
  dispose(): void;
}

const isAisle = (c: string) => c === '=' || c === '.' || c === 'S' || c === '>' || c === '<' || c === '^' || c === 'v';

/** Deterministic 0..1 noise from integers (render-only; the sim never sees it). */
function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export function buildProceduralWorld(layout: LayoutFile, opts: { farBoxes?: boolean; floorPxPerM?: number } = {}): WorldBuild {
  const g = layout.grid;
  const H = g.length;
  const W = g[0].length;
  const sizeX = W * CELL_M;
  const sizeZ = H * CELL_M;
  const group = new Group();
  group.name = 'procedural-world';
  const disposables: { dispose(): void }[] = [];
  const at = (x: number, y: number) => (y >= 0 && y < H && x >= 0 && x < W ? g[y][x] : 'X');
  const wx = (x: number) => (x + 0.5 - W / 2) * CELL_M;
  const wz = (y: number) => (y + 0.5 - H / 2) * CELL_M;

  // ── Floor with painted markings ──
  const pxPerM = opts.floorPxPerM ?? Math.min(22, 4096 / sizeX, 4096 / sizeZ);
  const cw = Math.round(sizeX * pxPerM);
  const ch = Math.round(sizeZ * pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1a1e25';
  ctx.fillRect(0, 0, cw, ch);
  // Subtle concrete slabs and speckle.
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let m = 0; m < sizeX; m += 6) {
    ctx.beginPath();
    ctx.moveTo(m * pxPerM, 0);
    ctx.lineTo(m * pxPerM, ch);
    ctx.stroke();
  }
  for (let m = 0; m < sizeZ; m += 6) {
    ctx.beginPath();
    ctx.moveTo(0, m * pxPerM);
    ctx.lineTo(cw, m * pxPerM);
    ctx.stroke();
  }
  for (let k = 0; k < (cw * ch) / 90; k++) {
    const v = rnd(k, 7);
    ctx.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(rnd(k, 1) * cw, rnd(k, 2) * ch, 2, 2);
  }
  const cellPx = CELL_M * pxPerM;
  const px = (x: number) => x * cellPx;
  const yellow = '#f2c230';
  // Yellow lines along every rack edge, pack lane edge and cross-aisle edge.
  ctx.lineCap = 'butt';
  ctx.strokeStyle = yellow;
  ctx.lineWidth = Math.max(2, 0.1 * pxPerM);
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const inset = 0.08 * pxPerM;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (!isAisle(c)) continue;
      if (at(x - 1, y) === '#') edge(px(x) + inset, px(y), px(x) + inset, px(y + 1));
      if (at(x + 1, y) === '#') edge(px(x + 1) - inset, px(y), px(x + 1) - inset, px(y + 1));
      if (at(x, y - 1) === '#') edge(px(x), px(y) + inset, px(x + 1), px(y) + inset);
      if (at(x, y + 1) === '#') edge(px(x), px(y + 1) - inset, px(x + 1), px(y + 1) - inset);
      // narrow lane next to forklift aisle: walkway edge
      if (c === '.' && (at(x, y - 1) === '=' || at(x, y - 1) === '>')) edge(px(x), px(y) + inset, px(x + 1), px(y) + inset);
    }
  // Staging squares and dock hazard stripes.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (c === 'S') {
        ctx.strokeStyle = yellow;
        ctx.lineWidth = Math.max(2, 0.07 * pxPerM);
        ctx.strokeRect(px(x) + 3, px(y) + 3, cellPx - 6, cellPx - 6);
      } else if (c === 'C' || c === 'K') {
        ctx.strokeStyle = c === 'C' ? '#3ddc97' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(2, 0.06 * pxPerM);
        ctx.strokeRect(px(x) + 4, px(y) + 4, cellPx - 8, cellPx - 8);
        if (c === 'C') {
          ctx.fillStyle = 'rgba(61,220,151,0.10)';
          ctx.fillRect(px(x) + 4, px(y) + 4, cellPx - 8, cellPx - 8);
        }
      } else if (c === 'D' && y === 0) {
        const stripes = 6;
        for (let k = 0; k < stripes; k++) {
          ctx.fillStyle = k % 2 ? '#111' : yellow;
          ctx.fillRect(px(x) + (k * cellPx) / stripes, px(1), cellPx / stripes, 0.25 * pxPerM);
        }
      }
    }
  // Dashed centre lines and direction chevrons in the cross aisles.
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(2, 0.07 * pxPerM);
  ctx.setLineDash([1.2 * pxPerM, 1.2 * pxPerM]);
  const crossRows: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    let run = 0;
    for (let x = 1; x < W - 1; x++) run += at(x, y) === '=' ? 1 : 0;
    if (run > W * 0.8) crossRows.push(y);
  }
  // Middle row of each band of cross-aisle rows.
  const bands: number[][] = [];
  for (const r of crossRows) {
    const b = bands.at(-1);
    if (b && b.at(-1) === r - 1) b.push(r);
    else bands.push([r]);
  }
  for (const b of bands) {
    const mid = b.length % 2 ? px(b[(b.length - 1) / 2] + 0.5) : px(b[b.length / 2]);
    edge(px(2), mid, px(W - 2), mid);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  for (const b of bands) {
    const yTop = px(b[0]) + cellPx * 0.5;
    const yBot = px(b.at(-1)! + 1) - cellPx * 0.5;
    for (let x = 6; x < W - 6; x += 9) {
      chevron(px(x), yTop, 1);
      chevron(px(x + 4), yBot, -1);
    }
  }
  function chevron(cx: number, cy: number, dir: number) {
    const s = 0.55 * pxPerM;
    ctx.beginPath();
    ctx.moveTo(cx - s * dir, cy - s * 0.8);
    ctx.lineTo(cx + s * 0.4 * dir, cy);
    ctx.lineTo(cx - s * dir, cy + s * 0.8);
    ctx.lineTo(cx - s * 0.55 * dir, cy);
    ctx.closePath();
    ctx.fill();
  }
  // Zone labels painted on the floor.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const z of layout.zones) {
    if (z.kind === 'storage' || z.kind === 'conveyor') continue;
    let cx = px(z.x + z.w / 2);
    let cy = px(z.y + z.h / 2);
    let size = Math.min(1.1, (z.w * CELL_M) / Math.max(6, z.label.length) / 0.62) * pxPerM;
    if (z.kind === 'pack') {
      cy = px(z.y) - 1.6 * pxPerM;
      size = 1.5 * pxPerM;
    }
    if (z.kind === 'dock') {
      cy = px(z.y + z.h) + 1.8 * pxPerM;
      size = 1.3 * pxPerM;
    }
    if (z.kind === 'charge' || z.kind === 'park') {
      cy = px(z.y) - 0.9 * pxPerM;
      size = Math.min(size, 0.75 * pxPerM);
    }
    if (z.id === 'charge-forklift') {
      cy = px(z.y + z.h) + 0.9 * pxPerM;
      cx = px(z.x) + (z.label.length * size * 0.33);
    }
    ctx.font = `700 ${size.toFixed(1)}px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial`;
    ctx.fillStyle = z.kind === 'pack' || z.kind === 'dock' ? 'rgba(242,194,48,0.85)' : 'rgba(255,255,255,0.7)';
    ctx.fillText(z.label, cx, cy);
  }
  // Aisle numbers at the front of every picking aisle.
  ctx.font = `700 ${(0.75 * pxPerM).toFixed(1)}px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const storage = layout.zones.find((z) => z.kind === 'storage');
  if (storage)
    for (let a = 0; a < layout.aisles; a++) {
      const ax = storage.x + a * 4 + 1;
      ctx.fillText(String(a + 1).padStart(2, '0'), px(ax + 1), px(storage.y) - 0.9 * pxPerM);
    }

  const floorTex = new CanvasTexture(canvas);
  floorTex.colorSpace = SRGBColorSpace;
  floorTex.anisotropy = 8;
  floorTex.minFilter = LinearMipmapLinearFilter;
  const floorMat = new MeshStandardMaterial({ map: floorTex, roughness: 0.38, metalness: 0.18, envMapIntensity: 0.9 });
  const floor = new Mesh(new PlaneGeometry(sizeX, sizeZ), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  group.add(floor);
  // Outer apron so the floor doesn't end in a hard edge.
  const apron = new Mesh(new PlaneGeometry(sizeX * 3, sizeZ * 3), new MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.9 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  group.add(apron);
  disposables.push(floorTex, floorMat, floor.geometry, apron.geometry, apron.material as MeshStandardMaterial);

  // ── Instancing helpers ──
  const m4 = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const color = new Color();
  function instanced(geo: BoxGeometry, mat: MeshStandardMaterial, items: { x: number; y: number; z: number; sx: number; sy: number; sz: number; c?: number }[], name: string) {
    const mesh = new InstancedMesh(geo, mat, Math.max(1, items.length));
    mesh.name = name;
    mesh.count = items.length;
    items.forEach((it, i) => {
      p.set(it.x, it.y, it.z);
      s.set(it.sx, it.sy, it.sz);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
      if (it.c !== undefined) mesh.setColorAt(i, color.setHex(it.c));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    disposables.push(geo, mat);
    return mesh;
  }
  const unit = () => {
    const b = new BoxGeometry(1, 1, 1);
    b.translate(0, 0.5, 0);
    return b;
  };

  // ── Racks: blue uprights, orange beams, wooden pallets, loads ──
  const levels = layout.racks.levels;
  const levelH = layout.racks.heightMm / 1000 / levels;
  const uprights: Parameters<typeof instanced>[2] = [];
  const beams: Parameters<typeof instanced>[2] = [];
  const pallets: Parameters<typeof instanced>[2] = [];
  const loads: Parameters<typeof instanced>[2] = [];
  const loadColors = [0xb98a5a, 0xc89a64, 0xa87b4c, 0xd3ad7a, 0x9e7146, 0xe0c9a0, 0x3d6fb3, 0xc9c9c9];
  const rackH = levels * levelH + 0.2;
  const depth = 1.1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (at(x, y) !== '#') continue;
      const cx = wx(x);
      const cz = wz(y);
      // Which side faces an aisle? Uprights sit at the aisle-facing and back edges.
      const openW = isAisle(at(x - 1, y));
      const openE = isAisle(at(x + 1, y));
      const face = openW && !openE ? -1 : openE && !openW ? 1 : 0;
      const ox = face === 0 ? 0 : -face * (CELL_M - depth) * 0.5;
      const xs = [cx + ox - depth / 2, cx + ox + depth / 2];
      const z0 = cz - CELL_M / 2;
      for (const ux of xs) {
        uprights.push({ x: ux, y: 0, z: z0 + 0.04, sx: 0.09, sy: rackH, sz: 0.09 });
        if (at(x, y + 1) !== '#') uprights.push({ x: ux, y: 0, z: z0 + CELL_M - 0.04, sx: 0.09, sy: rackH, sz: 0.09 });
      }
      for (let l = 0; l < levels; l++) {
        const by = 0.12 + l * levelH;
        for (const ux of xs) beams.push({ x: ux, y: by, z: cz, sx: 0.06, sy: 0.12, sz: CELL_M });
        const filled = rnd(x, y, l) < 0.86;
        if (!filled) continue;
        if (!opts.farBoxes && l >= 3 && opts.farBoxes !== undefined) continue;
        const py = by + 0.12;
        pallets.push({ x: cx + ox, y: py, z: cz, sx: 1.0, sy: 0.14, sz: 1.2, c: 0x8a6a45 });
        const hh = (0.55 + rnd(y, x, l + 9) * 0.35) * Math.min(1.1, levelH - 0.35);
        const wrap = rnd(x, l, y + 3) < 0.18;
        loads.push({ x: cx + ox, y: py + 0.14, z: cz, sx: 0.98, sy: hh, sz: 1.14, c: wrap ? 0xd9dde3 : loadColors[Math.floor(rnd(l, y, x + 5) * 6)] });
      }
    }
  instanced(unit(), new MeshStandardMaterial({ color: 0x2f62d6, roughness: 0.45, metalness: 0.55 }), uprights, 'rack-uprights');
  instanced(unit(), new MeshStandardMaterial({ color: 0xe8772e, roughness: 0.5, metalness: 0.4 }), beams, 'rack-beams');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), pallets, 'pallets');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.78 }), loads, 'rack-loads');

  // ── Walls (low at the front so the camera can see in), dock doors, columns ──
  const walls: Parameters<typeof instanced>[2] = [];
  const wallH = 7.5;
  walls.push({ x: 0, y: 0, z: -sizeZ / 2 - 0.15, sx: sizeX + 0.6, sy: wallH, sz: 0.3 });
  walls.push({ x: -sizeX / 2 - 0.15, y: 0, z: 0, sx: 0.3, sy: wallH, sz: sizeZ + 0.6 });
  walls.push({ x: sizeX / 2 + 0.15, y: 0, z: 0, sx: 0.3, sy: wallH, sz: sizeZ + 0.6 });
  walls.push({ x: 0, y: 0, z: sizeZ / 2 + 0.15, sx: sizeX + 0.6, sy: 1.1, sz: 0.3 });
  instanced(unit(), new MeshStandardMaterial({ color: 0x2a313c, roughness: 0.85, metalness: 0.1 }), walls, 'walls');
  const doors: Parameters<typeof instanced>[2] = [];
  const doorFrames: Parameters<typeof instanced>[2] = [];
  for (let x = 0; x < W; x++) {
    if (at(x, 0) !== 'D' || at(x - 1, 0) === 'D') continue;
    const cx = wx(x) + CELL_M / 2;
    doors.push({ x: cx, y: 0, z: -sizeZ / 2 + 0.02, sx: CELL_M * 2 - 0.4, sy: 3.2, sz: 0.12, c: 0x9aa3ad });
    doorFrames.push({ x: cx - CELL_M + 0.15, y: 0, z: -sizeZ / 2 + 0.08, sx: 0.25, sy: 3.4, sz: 0.2, c: 0xf2c230 });
    doorFrames.push({ x: cx + CELL_M - 0.15, y: 0, z: -sizeZ / 2 + 0.08, sx: 0.25, sy: 3.4, sz: 0.2, c: 0xf2c230 });
    doorFrames.push({ x: cx, y: 3.25, z: -sizeZ / 2 + 0.08, sx: CELL_M * 2, sy: 0.25, sz: 0.2, c: 0x2a313c });
  }
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.5 }), doors, 'dock-doors');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), doorFrames, 'dock-frames');

  // ── Pack stations, conveyors, chargers ──
  const tables: Parameters<typeof instanced>[2] = [];
  const belts: Parameters<typeof instanced>[2] = [];
  const rails: Parameters<typeof instanced>[2] = [];
  const chargers: Parameters<typeof instanced>[2] = [];
  const chargerLights: Parameters<typeof instanced>[2] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (c === 'P' && at(x - 1, y) !== 'P') {
        const cx = wx(x) + CELL_M / 2;
        tables.push({ x: cx, y: 0, z: wz(y) - 0.1, sx: 2.6, sy: 0.92, sz: 1.0, c: 0xb8c0c8 });
        tables.push({ x: cx, y: 0.92, z: wz(y) + 0.25, sx: 0.5, sy: 0.4, sz: 0.06, c: 0x1c2330 });
      }
      if (c === 'C') {
        const nbrUp = at(x, y - 1) !== 'X' && at(x, y - 1) !== 'C';
        const zOff = nbrUp ? 0.55 : -0.55;
        chargers.push({ x: wx(x), y: 0, z: wz(y) + zOff, sx: 0.5, sy: 0.55, sz: 0.25, c: 0x3a4250 });
        chargerLights.push({ x: wx(x), y: 0.42, z: wz(y) + zOff - Math.sign(zOff) * 0.13, sx: 0.32, sy: 0.05, sz: 0.02, c: 0x3ddc97 });
      }
    }
  const conv = layout.zones.find((z) => z.kind === 'conveyor');
  if (conv) {
    const z0 = wz(conv.y);
    const x0 = wx(conv.x) - CELL_M / 2;
    const len = conv.w * CELL_M;
    belts.push({ x: x0 + len / 2, y: 0, z: z0 + 0.2, sx: len - 1, sy: 0.85, sz: 1.0, c: 0x40464f });
    rails.push({ x: x0 + len / 2, y: 0.85, z: z0 - 0.32, sx: len - 1, sy: 0.12, sz: 0.06, c: 0xf2c230 });
    rails.push({ x: x0 + len / 2, y: 0.85, z: z0 + 0.72, sx: len - 1, sy: 0.12, sz: 0.06, c: 0xf2c230 });
    for (let k = 0; k * 3 < len - 2; k++) {
      const bx = x0 + 1 + k * 3;
      rails.push({ x: bx, y: 0, z: z0 - 0.32, sx: 0.08, sy: 0.85, sz: 0.08, c: 0x23272e });
      rails.push({ x: bx, y: 0, z: z0 + 0.72, sx: 0.08, sy: 0.85, sz: 0.08, c: 0x23272e });
      if (rnd(k, 99) < 0.45) belts.push({ x: bx + 1.2, y: 0.85, z: z0 + 0.2, sx: 0.45, sy: 0.32, sz: 0.4, c: 0xc89a64 });
    }
  }
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.6 }), tables, 'pack-stations');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.3 }), belts, 'conveyors');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.4 }), rails, 'conveyor-rails');
  instanced(unit(), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.5 }), chargers, 'chargers');
  const glow = new MeshStandardMaterial({ color: 0x000000, emissive: new Color(0x3ddc97), emissiveIntensity: 2.2 });
  instanced(unit(), glow, chargerLights, 'charger-lights');

  return {
    group,
    sizeX,
    sizeZ,
    dispose() {
      group.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
      for (const d of disposables) d.dispose();
    },
  };
}


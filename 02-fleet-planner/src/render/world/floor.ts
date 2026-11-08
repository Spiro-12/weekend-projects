// Floor: dark polished concrete with painted lanes, zone words, aisle numbers, staging pads, chevrons and baked contact
// shadows, all drawn once on a canvas (zero download).
//
// The canvas is a data texture, not a picture: R = yellow paint, G = white paint (R and G together = green paint),
// B = contact shadow / slab joints. The paint channels are lightly blurred and the shader thresholds them at 0.5 with a
// screen-space ramp (the classic distance-field trick), so lane edges and letters stay crisp at robot height even
// though the canvas is only ~28 px per metre. One mesh: the hall floor plus the yard apron (1.2 m lower, dock height).
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  type Texture,
} from 'three';
import type { LayoutFile } from '../../contracts/types.ts';
import type { Tier } from '../../host/index.ts';
import { CELL_M } from '../core/geom.ts';
import { PALLET_D, rnd, type WorldPlan } from './plan.ts';

export const YARD_Y = -1.2;
const APRON = 60;

const isOpen = (c: string) => c === '=' || c === '.' || c === 'S' || c === '<' || c === '>' || c === '^' || c === 'v';

export function floorPxPerM(tier: Tier, p: WorldPlan): number {
  // Canvas caps (memory: an RGBA canvas plus its GPU copy with mips): high 4096 px, medium 3072, low and lite 2048.
  const cap = tier === 'high' ? 4096 : tier === 'medium' ? 3072 : 2048;
  const want = tier === 'high' ? 32 : tier === 'medium' ? 28 : tier === 'low' ? 16 : 12;
  return Math.min(want, cap / p.sizeX, cap / p.sizeZ);
}

/** Paint the floor data canvas. */
export function paintFloor(p: WorldPlan, layout: LayoutFile, pxPerM: number): HTMLCanvasElement {
  const cw = Math.round(p.sizeX * pxPerM);
  const ch = Math.round(p.sizeZ * pxPerM);
  const k = pxPerM;
  // World metres → canvas px (canvas x = world x + sizeX/2; canvas y = world z + sizeZ/2).
  const X = (x: number) => (x + p.sizeX / 2) * k;
  const Z = (z: number) => (z + p.sizeZ / 2) * k;
  const cellL = (col: number) => col * CELL_M * k;

  // ── Paint layer: yellow = #f00, white = #0f0, green = #ff0, drawn additively on black ──
  const paint = canvas(cw, ch);
  const g = paint.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, cw, ch);
  g.globalCompositeOperation = 'lighter';
  const Y = '#ff0000';
  const Wt = '#00ff00';
  const Gr = '#ffff00';
  const line = (x0: number, y0: number, x1: number, y1: number, w: number, col: string) => {
    g.strokeStyle = col;
    g.lineWidth = w * k;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  g.lineCap = 'butt';

  // Lane lines along every rack edge that faces open floor, 0.12 m out from the cell edge, 11 cm wide.
  const LW = 0.11;
  const off = 0.12 * k;
  const ext = (0.12 + LW / 2) * k;
  for (let y = 0; y < p.H; y++)
    for (let x = 0; x < p.W; x++) {
      if (p.at(x, y) !== '#') continue;
      const L = cellL(x);
      const T = cellL(y);
      const R = cellL(x + 1);
      const B = cellL(y + 1);
      const rack = (dx: number, dy: number) => p.at(x + dx, y + dy) === '#';
      if (isOpen(p.at(x - 1, y))) line(L - off, T - (rack(0, -1) ? 0 : ext), L - off, B + (rack(0, 1) ? 0 : ext), LW, Y);
      if (isOpen(p.at(x + 1, y))) line(R + off, T - (rack(0, -1) ? 0 : ext), R + off, B + (rack(0, 1) ? 0 : ext), LW, Y);
      if (isOpen(p.at(x, y - 1))) line(L - (rack(-1, 0) ? 0 : ext), T - off, R + (rack(1, 0) ? 0 : ext), T - off, LW, Y);
      if (isOpen(p.at(x, y + 1))) line(L - (rack(-1, 0) ? 0 : ext), B + off, R + (rack(1, 0) ? 0 : ext), B + off, LW, Y);
    }

  // Tote lane ('.' rows): yellow edges against the cross aisle and against the station row; white dashes between rows.
  const laneRows = [...new Set(Array.from({ length: p.H }, (_, y) => y).filter((y) => countRow(p, y, '.') > (p.W - 2) * 0.8))];
  if (laneRows.length) {
    const top = cellL(laneRows[0]);
    const bot = cellL(laneRows.at(-1)! + 1);
    line(cellL(1), top + 0.06 * k, cellL(p.W - 1), top + 0.06 * k, LW, Y);
    line(cellL(1), bot - 0.06 * k, cellL(p.W - 1), bot - 0.06 * k, LW, Y);
    if (laneRows.length > 1) {
      g.setLineDash([1.0 * k, 0.8 * k]);
      line(cellL(1.6), (top + bot) / 2, cellL(p.W - 1.6), (top + bot) / 2, 0.09, Wt);
      g.setLineDash([]);
    }
  }

  // Cross aisles: dashed white centre line and white chevrons pointing along the aisle (both directions).
  for (const b of p.crossBands) {
    const top = cellL(b[0]);
    const bot = cellL(b.at(-1)! + 1);
    const mid = (top + bot) / 2;
    g.setLineDash([1.2 * k, 1.0 * k]);
    line(cellL(1.6), mid, cellL(p.W - 1.6), mid, 0.1, Wt);
    g.setLineDash([]);
    if (b.length >= 3) {
      for (let x = 5; x < p.W - 5; x += 8) {
        chevron(g, cellL(x), top + (mid - top) * 0.5, 1, k, Wt);
        chevron(g, cellL(x + 4), mid + (bot - mid) * 0.5, -1, k, Wt);
      }
    }
  }

  // Staging pads in front of every door: yellow frame with diagonal hatching.
  const pads = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const d of p.doors) {
    const rows = [1, 2].filter((r) => p.at(d.col, r) === 'S');
    if (!rows.length) continue;
    pads.set(String(d.col), { x0: cellL(d.col), y0: cellL(rows[0]), x1: cellL(d.col + Math.round(d.width / CELL_M)), y1: cellL(rows.at(-1)! + 1) });
  }
  for (const pad of pads.values()) {
    const i = 0.1 * k;
    g.strokeStyle = Y;
    g.lineWidth = 0.1 * k;
    g.strokeRect(pad.x0 + i, pad.y0 + i, pad.x1 - pad.x0 - 2 * i, pad.y1 - pad.y0 - 2 * i);
    g.save();
    g.beginPath();
    g.rect(pad.x0 + i, pad.y0 + i, pad.x1 - pad.x0 - 2 * i, pad.y1 - pad.y0 - 2 * i);
    g.clip();
    const h = pad.y1 - pad.y0;
    for (let d = -h; d < pad.x1 - pad.x0; d += 0.45 * k) line(pad.x0 + d, pad.y1, pad.x0 + d + h, pad.y0, 0.08, Y);
    g.restore();
  }
  // Dock edge: yellow/black hazard band along the leveler, inside each door.
  for (const d of p.doors) {
    const x0 = X(d.x - d.width / 2);
    const x1 = X(d.x + d.width / 2);
    const y0 = cellL(1) - 0.32 * k;
    g.save();
    g.beginPath();
    g.rect(x0, y0, x1 - x0, 0.3 * k);
    g.clip();
    for (let s = x0 - 0.3 * k; s < x1; s += 0.5 * k) {
      g.fillStyle = Y;
      g.beginPath();
      g.moveTo(s, y0 + 0.3 * k);
      g.lineTo(s + 0.25 * k, y0 + 0.3 * k);
      g.lineTo(s + 0.55 * k, y0);
      g.lineTo(s + 0.3 * k, y0);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // Chargers: green pocket outlines with a bolt; parking: white outlines.
  for (const c of p.chargers) {
    const i = 0.14 * k;
    g.strokeStyle = Gr;
    g.lineWidth = 0.09 * k;
    g.strokeRect(cellL(c.col) + i, cellL(c.row) + i, CELL_M * k - 2 * i, CELL_M * k - 2 * i);
    bolt(g, cellL(c.col) + (CELL_M * k) / 2, cellL(c.row) + (CELL_M * k) / 2 + c.wallSide * -0.12 * k, 0.5 * k, Gr);
  }
  for (const c of p.parking) {
    const i = 0.14 * k;
    g.strokeStyle = Wt;
    g.lineWidth = 0.08 * k;
    g.strokeRect(cellL(c.col) + i, cellL(c.row) + i, CELL_M * k - 2 * i, CELL_M * k - 2 * i);
  }
  // Pack stations: a white "stand here" box on the service cells in front of each table.
  for (const s of p.packStations) {
    const i = 0.2 * k;
    g.strokeStyle = Wt;
    g.lineWidth = 0.08 * k;
    g.strokeRect(X(s.x - CELL_M) + i, cellL(s.row - 1) + i, 2 * CELL_M * k - 2 * i, CELL_M * k - 2 * i);
  }

  // ── Words ──
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const font = (m: number) => `800 ${(m * k).toFixed(1)}px ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  const word = (t: string, x: number, y: number, m: number, col: string, maxW?: number) => {
    g.font = font(m);
    g.fillStyle = col;
    if (maxW) {
      const w = g.measureText(t).width;
      if (w > maxW * k) g.font = font((m * maxW * k) / w);
    }
    g.fillText(t, x, y);
  };
  const band = (row: number) => p.crossBands.find((b) => b.includes(row));
  const storage = layout.zones.find((z) => z.kind === 'storage');
  for (const z of layout.zones) {
    if (z.kind === 'pack') {
      // In the back cross aisle, just above the tote lane, nearest the overview camera.
      const b = band(z.y - 3) ?? band(z.y - 1);
      const yc = b ? (cellL(b[0]) + cellL(b.at(-1)! + 1)) / 2 + 0.55 * CELL_M * k : cellL(z.y) - 1.5 * k;
      word(z.label, cellL(z.x + z.w / 2), yc, 1.7, Wt, z.w * CELL_M * 0.8);
    } else if (z.kind === 'dock') {
      // In the front cross aisle, and between the doors.
      const b = band(z.y + z.h + 1);
      if (b) word(z.label, cellL(z.x + z.w / 2), (cellL(b[0]) + cellL(b.at(-1)! + 1)) / 2 - 0.5 * CELL_M * k, 1.5, Wt, 30);
      const gaps = gapsBetweenDoors(p);
      gaps.forEach((gap, i) => {
        if (gap.w < 5) return;
        word(i % 2 ? 'RECEIVING' : 'SHIPPING', X(gap.x), cellL(1) + CELL_M * k, 0.9, Wt, gap.w - 1.2);
      });
    } else if (z.kind === 'charge') {
      const fk = z.id === 'charge-forklift';
      if (fk) word('FORKLIFT CHARGING', cellL(z.x + z.w / 2), cellL(z.y + 1) + 0.55 * k, 0.42, Gr, z.w * CELL_M);
      else word(z.label, cellL(z.x + z.w / 2), cellL(z.y) - 0.75 * k, 0.8, Gr, z.w * CELL_M);
    } else if (z.kind === 'park') {
      word(z.label, cellL(z.x + z.w / 2), cellL(z.y) - 0.75 * k, 0.8, Wt, z.w * CELL_M);
    }
  }
  // Aisle numbers at both ends of every picking aisle.
  if (storage) {
    for (let a = 0; a < layout.aisles; a++) {
      const ax = storage.x + a * 4 + 1;
      if (!isOpen(p.at(ax, storage.y))) continue;
      const label = String(a + 1).padStart(2, '0');
      word(label, cellL(ax + 1), cellL(storage.y) - 0.85 * k, 0.75, Wt);
      word(label, cellL(ax + 1), cellL(storage.y + storage.h) + 0.85 * k, 0.75, Wt);
    }
  }

  // ── Contact shadows and slab joints (B channel; white = open floor) ──
  const ao = canvas(cw, ch);
  const a = ao.getContext('2d')!;
  // B channel: 160 = plain floor (× 1.0 in the shader), darker = contact shadow, brighter = a pool of light.
  a.fillStyle = 'rgb(255,255,160)';
  a.fillRect(0, 0, cw, ch);
  const shade = (v: number) => `rgb(255,255,${Math.round(v * 160)})`;
  // Pools of light under the LED panels (drawn first: rack footprints cover them).
  a.globalCompositeOperation = 'lighter';
  for (const l of p.lights) {
    const r = 4.4 * k;
    const grad = a.createRadialGradient(X(l.x), Z(l.z), 0, X(l.x), Z(l.z), r);
    grad.addColorStop(0, 'rgba(0,0,95,1)');
    grad.addColorStop(0.45, 'rgba(0,0,50,1)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    a.fillStyle = grad;
    a.save();
    a.translate(X(l.x), Z(l.z));
    a.scale(0.75, 1.25);
    a.translate(-X(l.x), -Z(l.z));
    a.fillRect(X(l.x) - r, Z(l.z) - r, 2 * r, 2 * r);
    a.restore();
  }
  a.globalCompositeOperation = 'source-over';
  // Racks: the footprint, darker where pallets sit on the floor.
  for (const r of p.runs) {
    a.fillStyle = shade(0.42);
    a.fillRect(X(r.x0 - 0.12), Z(r.z0 - 0.12), (r.x1 - r.x0 + 0.24) * k, (r.z1 - r.z0 + 0.24) * k);
  }
  for (const s of p.slots) {
    if (s.level !== 0 || !s.kind) continue;
    a.fillStyle = shade(0.22);
    a.fillRect(X(s.x - PALLET_D / 2), Z(s.z - 0.42), PALLET_D * k, 0.84 * k);
  }
  // Walls and blocked cells along them.
  a.fillStyle = shade(0.55);
  const t = 0.5 * k;
  a.fillRect(0, 0, cw, t);
  a.fillRect(0, ch - t, cw, t);
  a.fillRect(0, 0, t, ch);
  a.fillRect(cw - t, 0, t, ch);
  for (const s of p.packStations) {
    a.fillStyle = shade(0.4);
    a.fillRect(X(s.x - 1.0), Z(s.z - 0.65), 2.0 * k, 1.3 * k);
  }
  if (p.conveyor) {
    a.fillStyle = shade(0.45);
    a.fillRect(X(p.conveyor.x0), Z(p.conveyor.z - 0.7), (p.conveyor.x1 - p.conveyor.x0) * k, 1.4 * k);
  }
  for (const c of p.columns) {
    a.fillStyle = shade(0.3);
    a.fillRect(X(c.x - 0.35), Z(c.z - 0.45), 0.7 * k, 0.9 * k);
  }
  const blurred = canvas(cw, ch);
  const bg = blurred.getContext('2d')!;
  bg.filter = `blur(${(0.22 * k).toFixed(1)}px)`;
  bg.drawImage(ao, 0, 0);
  bg.filter = 'none';
  // Slab joints every 6 m and faint wear: crisp-ish dark lines and soft blobs in the aisles.
  bg.globalCompositeOperation = 'multiply';
  bg.strokeStyle = 'rgb(255,255,184)';
  bg.lineWidth = Math.max(1, 0.03 * k);
  for (let m = 6; m < p.sizeX; m += 6) {
    bg.beginPath();
    bg.moveTo(m * k, 0);
    bg.lineTo(m * k, ch);
    bg.stroke();
  }
  for (let m = 6; m < p.sizeZ; m += 6) {
    bg.beginPath();
    bg.moveTo(0, m * k);
    bg.lineTo(cw, m * k);
    bg.stroke();
  }
  bg.filter = `blur(${(0.8 * k).toFixed(1)}px)`;
  for (let i = 0; i < (p.sizeX * p.sizeZ) / 30; i++) {
    const x = rnd(i, 3) * cw;
    const y = rnd(i, 5) * ch;
    bg.fillStyle = `rgb(255,255,${Math.round((0.86 + rnd(i, 9) * 0.12) * 255)})`;
    bg.beginPath();
    bg.ellipse(x, y, (0.6 + rnd(i, 11) * 2.2) * k, (0.4 + rnd(i, 13) * 1.2) * k, rnd(i, 17) * Math.PI, 0, Math.PI * 2);
    bg.fill();
  }
  bg.filter = 'none';

  // ── Combine: (paint.r, paint.g, 255) blurred a little for the threshold, then × shadow in B ──
  const out = canvas(cw, ch);
  const o = out.getContext('2d')!;
  o.fillStyle = '#0000ff';
  o.fillRect(0, 0, cw, ch);
  o.globalCompositeOperation = 'lighter';
  o.filter = `blur(${Math.max(0.6, 0.035 * k).toFixed(2)}px)`;
  o.drawImage(paint, 0, 0);
  o.filter = 'none';
  o.globalCompositeOperation = 'multiply';
  o.drawImage(blurred, 0, 0);
  o.globalCompositeOperation = 'source-over';
  // Free the three full-size scratch canvases now (browsers keep their backing stores until the size drops).
  for (const c of [paint, ao, blurred]) c.width = c.height = 0;
  return out;
}

function countRow(p: WorldPlan, y: number, c: string): number {
  let n = 0;
  for (let x = 0; x < p.W; x++) n += p.at(x, y) === c ? 1 : 0;
  return n;
}

function gapsBetweenDoors(p: WorldPlan): { x: number; w: number }[] {
  const out: { x: number; w: number }[] = [];
  const doors = [...p.doors].sort((a, b) => a.x - b.x);
  for (let i = 0; i + 1 < doors.length; i++) {
    const a = doors[i].x + doors[i].width / 2;
    const b = doors[i + 1].x - doors[i + 1].width / 2;
    out.push({ x: (a + b) / 2, w: b - a });
  }
  return out;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function chevron(g: CanvasRenderingContext2D, cx: number, cy: number, dir: number, k: number, col: string) {
  const s = 0.5 * k;
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(cx - s * dir, cy - s * 0.85);
  g.lineTo(cx + s * 0.45 * dir, cy);
  g.lineTo(cx - s * dir, cy + s * 0.85);
  g.lineTo(cx - s * 0.5 * dir, cy);
  g.closePath();
  g.fill();
}

function bolt(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, col: string) {
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(cx + 0.1 * s, cy - 0.5 * s);
  g.lineTo(cx - 0.25 * s, cy + 0.06 * s);
  g.lineTo(cx - 0.02 * s, cy + 0.06 * s);
  g.lineTo(cx - 0.12 * s, cy + 0.5 * s);
  g.lineTo(cx + 0.25 * s, cy - 0.08 * s);
  g.lineTo(cx + 0.02 * s, cy - 0.08 * s);
  g.closePath();
  g.fill();
}

export interface Floor {
  /** Floor canvas size in px (the canvas itself is released after upload). */
  size: [number, number];
  mesh: Mesh;
  texture: Texture;
  dispose(): void;
}

/** The hall floor (UV 0..1) plus the yard apron around it at dock height below. */
export function buildFloor(p: WorldPlan, layout: LayoutFile, tier: Tier, envMap: Texture | null): Floor {
  const k = floorPxPerM(tier, p);
  const painted = paintFloor(p, layout, k);
  const size: [number, number] = [painted.width, painted.height];
  const tex = new CanvasTexture(painted);
  // Once the GPU has its copy, drop the canvas too (no re-upload is ever needed: a lost context reloads the page).
  tex.onUpdate = () => {
    painted.width = painted.height = 0;
    tex.onUpdate = null;
  };
  tex.colorSpace = NoColorSpace;
  tex.anisotropy = 16; // three clamps to the GPU max; stops lane lines smearing at low camera angles
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;

  const hx = p.sizeX / 2;
  const hz = p.sizeZ / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const u = (x: number) => (x + hx) / p.sizeX;
    const v = (z: number) => 1 - (z + hz) / p.sizeZ;
    // two triangles, facing up (counter-clockwise seen from +Y)
    const pts = [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z1],
      [x1, z0],
    ];
    for (const [x, z] of pts) {
      pos.push(x, y, z);
      uv.push(u(x), v(z));
    }
  };
  quad(-hx, -hz, hx, hz, 0);
  const A = APRON;
  quad(-hx - A, -hz - A, hx + A, -hz, YARD_Y);
  quad(-hx - A, hz, hx + A, hz + A, YARD_Y);
  quad(-hx - A, -hz, -hx, hz, YARD_Y);
  quad(hx, -hz, hx + A, hz, YARD_Y);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new Float32BufferAttribute(new Array((pos.length / 3) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.computeBoundingSphere();

  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0, envMap, envMapIntensity: 0.3 });
  mat.name = 'floor';
  const lin = (hex: string) => new Color(hex);
  const uniforms = {
    uPaint: { value: tex },
    uConcrete: { value: lin('#2d2d2f') },
    uYard: { value: lin('#16181b') },
    uYellow: { value: lin('#f2c230') },
    uWhite: { value: lin('#e4e7ea') },
    uGreen: { value: lin('#2fd08a') },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFloorUv;').replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvFloorUv = uv;',
    );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vFloorUv;
uniform sampler2D uPaint;
uniform vec3 uConcrete, uYard, uYellow, uWhite, uGreen;
#define PAINT_GLOW 0.6
float paintEdge(float v) { float w = clamp(fwidth(v) * 0.75, 0.02, 0.5); return smoothstep(0.5 - w, 0.5 + w, v); }
float fpPaint = 0.0;
vec3 fpPaintGlow = vec3(0.0);
float fpYellow = 0.0;
float fpYard = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
  bool inHall = all(greaterThanEqual(vFloorUv, vec2(0.0))) && all(lessThanEqual(vFloorUv, vec2(1.0)));
  if (inHall) {
    vec3 t = texture2D(uPaint, vFloorUv).rgb;
    float y = paintEdge(t.r), w = paintEdge(t.g);
    float gr = min(y, w);
    y -= gr; w -= gr;
    vec3 c = uConcrete;
    c = mix(c, uYellow, y);
    c = mix(c, uWhite * 0.92, w);
    c = mix(c, uGreen, gr);
    fpPaint = clamp(y + w + gr, 0.0, 1.0);
    // Paint is lit by the hall, not just the key light: a little self-glow keeps it reading as safety yellow (and
    // clean white) on screen after AgX tone mapping, instead of mustard and grey.
    fpPaintGlow = (uYellow * y + uWhite * 0.5 * w + uGreen * gr) * PAINT_GLOW;
    fpYellow = y;
    c *= t.b * 1.6;
    diffuseColor.rgb *= c;
  } else {
    fpYard = 1.0;
    diffuseColor.rgb *= uYard;
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.62, max(fpPaint, fpYard));`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fpPaintGlow;')
      // AgX desaturates the safety yellow to a pale mustard. After tone mapping, keep the brightness it produced but
      // restore the paint's own hue, so lanes read as #F2C230 on screen (shadows and distance still darken them).
      .replace(
        '#include <tonemapping_fragment>',
        `#include <tonemapping_fragment>
if (fpYellow > 0.0) {
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  vec3 tgt = uYellow * clamp(dot(gl_FragColor.rgb, LW) / dot(uYellow, LW), 0.0, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, tgt, fpYellow);
}`,
      )
      // Indoors: no sun glare on the polished floor (the scene's key light is a sun); keep the hall reflections.
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directSpecular *= 0.12;\nreflectedLight.indirectSpecular *= 1.0 - 0.75 * fpPaint;');
  };
  const mesh = new Mesh(geo, mat);
  mesh.name = 'floor';
  mesh.receiveShadow = true;
  return {
    mesh,
    texture: tex,
    size,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}

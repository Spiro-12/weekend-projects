// Floor paint and the baked contact shadow, drawn once on 2D canvases (zero download).
// Canvas pixel (cx * S, cy * S) is grid cell (cx, cy); the floor plane's UVs are laid out to match.
import { CanvasTexture, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter } from 'three';
import { Cell, type World } from '../../../src/sim/world.ts';

const PX = 40; // floor paint pixels per cell (1.5 m), about 3.75 cm per pixel
const AO_PX = 12;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const isRack = (w: World, x: number, y: number) =>
  x >= 0 && y >= 0 && x < w.width && y < w.height && w.code[y * w.width + x] === Cell.Rack;
const isWalk = (w: World, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= w.width || y >= w.height) return false;
  const c = w.code[y * w.width + x];
  return c === Cell.Narrow || c === Cell.Fork || c === Cell.Staging;
};

/** Blurred dark footprints of racks, walls and stations. White = open floor. */
export function contactShadowCanvas(w: World): HTMLCanvasElement {
  const [c, g] = canvas(w.width * AO_PX, w.height * AO_PX);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const grow = AO_PX * 0.12;
  for (let y = 0; y < w.height; y++)
    for (let x = 0; x < w.width; x++) {
      const k = w.code[y * w.width + x];
      if (k === Cell.Rack) g.fillStyle = '#101010';
      else if (k === Cell.Wall || k === Cell.Pack) g.fillStyle = '#303030';
      else continue;
      g.fillRect(x * AO_PX - grow, y * AO_PX - grow, AO_PX + 2 * grow, AO_PX + 2 * grow);
    }
  const [out, og] = canvas(c.width, c.height);
  og.fillStyle = '#fff';
  og.fillRect(0, 0, out.width, out.height);
  og.filter = `blur(${AO_PX * 0.35}px)`;
  og.drawImage(c, 0, 0);
  return out;
}

export function floorCanvas(w: World, shadow: HTMLCanvasElement): HTMLCanvasElement {
  const [c, g] = canvas(w.width * PX, w.height * PX);
  // Base: dark polished concrete with slab joints every 4 cells.
  g.fillStyle = '#1d2026';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  for (let x = 0; x <= w.width; x += 4) line(g, x * PX, 0, x * PX, c.height);
  for (let y = 0; y <= w.height; y += 4) line(g, 0, y * PX, c.width, y * PX);

  // Pedestrian lane ('.' cells): green tint with white edge lines.
  for (let y = 0; y < w.height; y++)
    for (let x = 0; x < w.width; x++) {
      const k = w.code[y * w.width + x];
      if (k === Cell.Narrow) {
        g.fillStyle = 'rgba(40,140,80,0.35)';
        g.fillRect(x * PX, y * PX, PX, PX);
      } else if (k === Cell.Staging) hatch(g, x * PX, y * PX, PX, PX, 'rgba(245,197,24,0.55)');
      else if (k === Cell.Charger) box(g, x * PX + 4, y * PX + 4, PX - 8, PX - 8, '#34d399', 3);
      else if (k === Cell.Parking) box(g, x * PX + 4, y * PX + 4, PX - 8, PX - 8, 'rgba(255,255,255,0.7)', 2);
    }

  // Yellow lane lines: every edge between a rack and a walkable cell, set 0.2 m into the aisle.
  g.strokeStyle = '#f5c518';
  g.lineWidth = 3;
  g.lineCap = 'square';
  const off = (0.2 / 1.5) * PX;
  for (let y = 0; y < w.height; y++)
    for (let x = 0; x < w.width; x++) {
      if (!isRack(w, x, y)) continue;
      const X = x * PX;
      const Y = y * PX;
      if (isWalk(w, x + 1, y)) line(g, X + PX + off, Y - (isRack(w, x, y - 1) ? 0 : off), X + PX + off, Y + PX + (isRack(w, x, y + 1) ? 0 : off));
      if (isWalk(w, x - 1, y)) line(g, X - off, Y - (isRack(w, x, y - 1) ? 0 : off), X - off, Y + PX + (isRack(w, x, y + 1) ? 0 : off));
      if (isWalk(w, x, y - 1)) line(g, X - (isRack(w, x - 1, y) ? 0 : off), Y - off, X + PX + (isRack(w, x + 1, y) ? 0 : off), Y - off);
      if (isWalk(w, x, y + 1)) line(g, X - (isRack(w, x - 1, y) ? 0 : off), Y + PX + off, X + PX + (isRack(w, x + 1, y) ? 0 : off), Y + PX + off);
    }
  // Dashed centre lines in the long cross aisles.
  g.setLineDash([PX * 0.8, PX * 0.6]);
  g.lineWidth = 3;
  for (let y = 1; y < w.height - 1; y++) {
    let run = 0;
    for (let x = 0; x < w.width; x++) run = w.code[y * w.width + x] === Cell.Fork && w.code[(y - 1) * w.width + x] === Cell.Fork && w.code[(y + 1) * w.width + x] === Cell.Fork ? run + 1 : 0;
    if (run > w.width * 0.8) line(g, PX * 1.5, y * PX + PX / 2, (w.width - 1.5) * PX, y * PX + PX / 2);
  }
  g.setLineDash([]);

  // Zone labels painted on the floor.
  g.fillStyle = 'rgba(235,238,245,0.55)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${PX * 0.9}px system-ui, sans-serif`;
  for (const z of w.layout.zones) {
    if (z.kind === 'storage' || z.kind === 'conveyor') continue;
    // Labels go on the nearest open floor: the dock label one row below the dock zone, others one row above.
    const ly = z.kind === 'dock' ? z.y + z.h + 1 : z.y - 0.5;
    if (z.id === 'charge-forklift') continue;
    g.fillText(z.label, (z.x + z.w / 2) * PX, ly * PX);
  }

  // Multiply the contact shadow in.
  g.globalCompositeOperation = 'multiply';
  g.drawImage(shadow, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  return c;
}

function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}
function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, lw: number): void {
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.strokeRect(x, y, w, h);
}
function hatch(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = color;
  g.lineWidth = 3;
  for (let d = -h; d < w; d += 10) line(g, x + d, y + h, x + d + h, y);
  g.restore();
}

export function toTexture(c: HTMLCanvasElement, srgb: boolean, anisotropy: number): CanvasTexture {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
}

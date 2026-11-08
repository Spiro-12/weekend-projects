// Small canvas textures painted in code (no downloads): the carton/pallet atlas used by the far-field rack loads.
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';
import { rnd } from './plan.ts';

/**
 * 512 × 512 atlas:
 * - 4 carton faces (2 × 2 cells of 256 × 224 px), one carton each, with seam shadow, tape and the odd label;
 * - a pallet side strip at the bottom (y 448..512), 128 px = 0.4 m repeat (a block and deck boards).
 */
export function cartonAtlas(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  const browns = ['#c49a6c', '#b98d5f', '#cfa676', '#bf9466'];
  for (let v = 0; v < 4; v++) {
    const x0 = (v % 2) * 256;
    const y0 = Math.floor(v / 2) * 224;
    g.fillStyle = browns[v];
    g.fillRect(x0, y0, 256, 224);
    // Corrugation streaks and grime.
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(${rnd(v, i) < 0.5 ? '255,240,220' : '70,45,20'},${0.04 + rnd(i, v, 3) * 0.05})`;
      g.fillRect(x0 + rnd(i, v, 1) * 256, y0, 1 + rnd(i, v, 2) * 3, 224);
    }
    // Flap line and tape (vertical on the face, like a sealed carton seen from the side).
    g.fillStyle = 'rgba(60,38,18,0.35)';
    g.fillRect(x0, y0 + 26, 256, 3);
    if (v !== 2) {
      g.fillStyle = 'rgba(232,206,160,0.75)';
      g.fillRect(x0 + 108, y0, 40, 70);
    }
    // Label on two variants.
    if (v === 1 || v === 3) {
      g.fillStyle = '#efefe9';
      g.fillRect(x0 + 30, y0 + 120, 74, 50);
      g.fillStyle = '#2b2b2b';
      for (let r = 0; r < 4; r++) g.fillRect(x0 + 38, y0 + 130 + r * 9, 40 + rnd(v, r) * 18, 3);
    }
    // Seam shadow: darker towards the carton edges (the gap to its neighbours).
    const edge = g.createLinearGradient(x0, 0, x0 + 256, 0);
    edge.addColorStop(0, 'rgba(30,18,8,0.55)');
    edge.addColorStop(0.05, 'rgba(30,18,8,0.0)');
    edge.addColorStop(0.95, 'rgba(30,18,8,0.0)');
    edge.addColorStop(1, 'rgba(30,18,8,0.55)');
    g.fillStyle = edge;
    g.fillRect(x0, y0, 256, 224);
    const edgeY = g.createLinearGradient(0, y0, 0, y0 + 224);
    edgeY.addColorStop(0, 'rgba(30,18,8,0.5)');
    edgeY.addColorStop(0.06, 'rgba(30,18,8,0.0)');
    edgeY.addColorStop(0.93, 'rgba(30,18,8,0.0)');
    edgeY.addColorStop(1, 'rgba(30,18,8,0.6)');
    g.fillStyle = edgeY;
    g.fillRect(x0, y0, 256, 224);
  }
  // Pallet side: deck boards top and bottom, a block, dark gaps.
  g.fillStyle = '#1b130c';
  g.fillRect(0, 448, 512, 64);
  for (let r = 0; r < 4; r++) {
    const x0 = r * 128;
    g.fillStyle = '#a7835a';
    g.fillRect(x0, 448, 128, 14);
    g.fillRect(x0, 500, 128, 12);
    g.fillStyle = '#9a774f';
    g.fillRect(x0 + 2, 462, 34, 38);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(x0, 461, 128, 2);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  return t;
}

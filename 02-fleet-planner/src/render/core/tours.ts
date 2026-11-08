// Scripted camera paths (perf harness, screenshots, the clip). u runs 0..1 over the tour. Adapted from spike a.
import type { LayoutFile } from '../../contracts/types.ts';
import { CELL_M } from './geom.ts';
import type { Pose } from './camera.ts';

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: Pose, b: Pose, t: number): Pose => {
  const s = smooth(clamp01(t));
  const l = (x: number[], y: number[]) => x.map((v, i) => v + (y[i] - v) * s) as [number, number, number];
  return { position: l(a.position, b.position), target: l(a.target, b.target) };
};

export const TOURS = ['default', 'overview', 'aisle', 'static'] as const;

export function makeTours(layout: LayoutFile): Record<string, (u: number) => Pose> {
  const W = layout.grid[0].length;
  const H = layout.grid.length;
  const sizeX = W * CELL_M;
  const sizeZ = H * CELL_M;
  const storage = layout.zones.find((z) => z.kind === 'storage')!;
  // The middle picking aisle: the two aisle columns at storage.x + 4k + 1..2.
  const mid = Math.floor(layout.aisles / 2);
  const aisleCol = storage.x + 4 * mid + 1.5;
  const ax = (aisleCol + 0.5 - W / 2) * CELL_M;
  const zSouth = (storage.y + storage.h + 0.5 - H / 2) * CELL_M + 1;
  const zNorth = (storage.y + 0.5 - H / 2) * CELL_M + 1;
  const R = Math.max(sizeX, sizeZ) * 0.75;
  const Hh = R * 0.65;
  const orbit = (theta: number): Pose => ({ position: [R * Math.sin(theta), Hh, R * Math.cos(theta)], target: [0, 0, 2] });
  const aisleAt = (z: number, look = -12): Pose => ({ position: [ax, 2.1, z], target: [ax, 1.5, z + look] });
  const overview: Pose = { position: [sizeX * 0.45, sizeZ * 1.1, sizeZ * 1.35], target: [0, 0, 0] };
  return {
    /** Overview orbit, dive into an aisle, drive it, pull out. The default for every perf gate. */
    default: (u) => {
      if (u < 0.4) return orbit(0.7 - (u / 0.4) * 1.4);
      if (u < 0.55) return lerp(orbit(-0.7), aisleAt(zSouth + 3), (u - 0.4) / 0.15);
      if (u < 0.8) return aisleAt(zSouth + 3 + (zNorth - zSouth - 3) * ((u - 0.55) / 0.25));
      return lerp(aisleAt(zNorth), { position: [-sizeX * 0.5, R * 0.6, -sizeZ * 0.6], target: [0, 0, 0] }, (u - 0.8) / 0.2);
    },
    overview: (u) => orbit(0.9 - u * Math.PI),
    aisle: (u) => (u < 0.5 ? aisleAt(zSouth + (zNorth - zSouth) * (u / 0.5)) : aisleAt(zNorth - (zNorth - zSouth) * ((u - 0.5) / 0.5), 12)),
    static: () => overview,
  };
}


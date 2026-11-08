// Grid cell <-> world metres. The floor is centred on the origin; +x is east (grid x), +z is south (grid y).
import type { World } from '../../../src/sim/world.ts';

export const CELL = 1.5;

export interface Grid {
  world: World;
  /** Floor size in metres. */
  sizeX: number;
  sizeZ: number;
  /** Cell centre per cell index. */
  cellX: Float32Array;
  cellZ: Float32Array;
  /** Grid edge coordinate (0..width) to world x. */
  edgeX(ex: number): number;
  edgeZ(ey: number): number;
}

export function makeGrid(world: World): Grid {
  const sizeX = world.width * CELL;
  const sizeZ = world.height * CELL;
  const edgeX = (ex: number) => ex * CELL - sizeX / 2;
  const edgeZ = (ey: number) => ey * CELL - sizeZ / 2;
  const cellX = new Float32Array(world.n);
  const cellZ = new Float32Array(world.n);
  for (let i = 0; i < world.n; i++) {
    const x = i % world.width;
    const y = (i - x) / world.width;
    cellX[i] = edgeX(x + 0.5);
    cellZ[i] = edgeZ(y + 0.5);
  }
  return { world, sizeX, sizeZ, cellX, cellZ, edgeX, edgeZ };
}

// Grid ↔ world coordinates. One cell = 1.5 m; the warehouse is centred on the origin, Y up, rows run along +Z.
import { CELL_MM } from '../../contracts/types.ts';

export const CELL_M = CELL_MM / 1000;

export interface GridDims {
  width: number;
  height: number;
}

export function cellX(d: GridDims, cell: number): number {
  return ((cell % d.width) + 0.5 - d.width / 2) * CELL_M;
}
export function cellZ(d: GridDims, cell: number): number {
  return (Math.floor(cell / d.width) + 0.5 - d.height / 2) * CELL_M;
}
/** Heading 0..3 (E, S, W, N) to a Y rotation so the model's +X axis points along the move. */
export function headingYaw(h: number): number {
  return [0, -Math.PI / 2, Math.PI, Math.PI / 2][h] ?? 0;
}

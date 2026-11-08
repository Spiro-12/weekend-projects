// Scripted camera paths for the perf harness and fixed poses for screenshots. u runs 0..1 over the tour.
import { Vector3 } from 'three';
import type { Grid } from './grid.ts';

export interface Pose {
  pos: Vector3;
  target: Vector3;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const s = smooth(clamp01(t));
  return { pos: a.pos.clone().lerp(b.pos, s), target: a.target.clone().lerp(b.target, s) };
}

export function makeTours(grid: Grid) {
  // A central picking aisle: between the rack pair at grid x 26-27 and the pair at 30-31 (cells 28 and 29).
  const aisleX = grid.edgeX(29);
  const zSouth = grid.edgeZ(26) + 4;
  const zNorth = grid.edgeZ(6) + 2;
  const R = 70;
  const H = 46;
  const orbit = (theta: number): Pose => ({
    pos: new Vector3(R * Math.sin(theta), H, R * Math.cos(theta)),
    target: new Vector3(0, 0, 2),
  });
  const aisleAt = (z: number, lookAhead = -12): Pose => ({
    pos: new Vector3(aisleX + 0.3, 2.1, z),
    target: new Vector3(aisleX + 0.3, 1.5, z + lookAhead),
  });

  const poses: Record<string, Pose> = {
    overview: { pos: new Vector3(42, 58, 72), target: new Vector3(0, 0, 0) },
    aisle: aisleAt(zSouth - 3),
    high: { pos: new Vector3(0, 80, 30), target: new Vector3(0, 0, 0) },
    /** Whole floor inside a half-width split view. */
    far: { pos: new Vector3(58, 92, 104), target: new Vector3(0, 0, 0) },
  };

  const tours: Record<string, (u: number) => Pose> = {
    /** Overview orbit, dive into an aisle, drive it, pull out. The default for every gate. */
    default: (u) => {
      if (u < 0.4) return orbit(0.7 - (u / 0.4) * 1.4);
      if (u < 0.55) return lerpPose(orbit(-0.7), aisleAt(zSouth + 3), (u - 0.4) / 0.15);
      if (u < 0.8) {
        const t = (u - 0.55) / 0.25;
        return aisleAt(zSouth + 3 + (zNorth - zSouth - 3) * t);
      }
      return lerpPose(aisleAt(zNorth), { pos: new Vector3(-48, 42, -52), target: new Vector3(0, 0, 0) }, (u - 0.8) / 0.2);
    },
    /** Half orbit around the whole floor. */
    overview: (u) => orbit(0.9 - u * Math.PI),
    /** Down an aisle and back at robot height. */
    aisle: (u) => (u < 0.5 ? aisleAt(zSouth + (zNorth - zSouth) * (u / 0.5)) : aisleAt(zNorth - (zNorth - zSouth) * ((u - 0.5) / 0.5), 12)),
    /** Holds the overview pose (steady-state cost without camera motion). */
    static: () => poses.overview,
  };
  return { poses, tours };
}

// Camera-dependent cut-aways, done in the vertex shader so every view (and both split-screen sides) gets its own:
// - walls: when the camera is outside a wall's plane, that wall drops to a low curb (or vanishes, for windows,
//   doors and wall steel), so the overview can see in;
// - roof (trusses, purlins, LED panels): when the camera is above the roof, pieces whose centre falls in the lower part
//   of the screen are dropped, so the roof frames the far end of the hall (like the references) without covering the
//   floor. Pieces are small (≤ 6 m) so the cut line reads as a clean edge.
//
// Per instance (or per vertex for merged meshes): `aCut` = (nx, nz, d, mode) and `aGroup` = (x, y, z) centre.
// Modes: 0 = always drawn, 1 = wall (cut to the curb), 2 = wall part (removed when cut), 3 = roof (screen cut).
// A removed piece collapses to one point, so it costs no fragments (its vertices still run).
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

export const CURB_H = 1.25;

export interface CutUniforms {
  uCurb: { value: number };
  uRoofY: { value: number };
  /** Roof pieces stay when their centre is above this NDC y. */
  uRoofCut: { value: number };
}

export function cutUniforms(roofY: number): CutUniforms {
  return { uCurb: { value: CURB_H }, uRoofY: { value: roofY }, uRoofCut: { value: 0.45 } };
}

/** Patch a built-in material (Standard/Basic) for cut-aways. Chains any existing onBeforeCompile. */
export function patchCutaway(mat: Material, u: CutUniforms, opts: { instanced: boolean }) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aCut;
attribute vec3 aGroup;
uniform float uCurb;
uniform float uRoofY;
uniform float uRoofCut;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float mode = aCut.w;
  if (mode > 0.5 && mode < 2.5) {
    if (dot(aCut.xy, cameraPosition.xz) > aCut.z) {
      if (mode < 1.5) {
        ${
          opts.instanced
            ? `float sy = length(instanceMatrix[1].xyz); float ty = instanceMatrix[3].y;
        transformed.y = min(transformed.y, (uCurb - ty) / max(sy, 1e-4));`
            : 'transformed.y = min(transformed.y, uCurb);'
        }
      } else {
        transformed = vec3(0.0);
      }
    }
  } else if (mode > 2.5 && cameraPosition.y > uRoofY) {
    vec4 c = projectionMatrix * viewMatrix * modelMatrix * vec4(aGroup, 1.0);
    if (c.w <= 0.0 || c.y / c.w < uRoofCut) transformed = vec3(0.0);
  }
}`,
      );
  };
  // Patched variants must not share a program with the unpatched material (or with each other).
  const tag = `|fp-cutaway${opts.instanced ? 'i' : 'm'}|${prev ? prev.toString() : ''}`;
  mat.customProgramCacheKey = () => tag;
}

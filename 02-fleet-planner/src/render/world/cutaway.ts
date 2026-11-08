// Camera-dependent cut-aways, done in the vertex shader so every view (and both split-screen sides) gets its own:
// - walls: when the camera is outside a wall's plane, that wall drops to a low curb (or vanishes, for windows,
//   doors and wall steel), so the overview can see in;
// - roof (trusses, purlins, lights): when the camera is above the roof, pieces in the lower part of the screen fade
//   out (ordered dither), so the roof frames the far end of the hall like the references without covering the floor.
//
// Per instance (or per vertex for merged meshes): `aCut` = (nx, nz, d, mode) and `aGroup` = (x, y, z) centre.
// Modes: 0 = always drawn, 1 = wall (cut to the curb), 2 = wall part (removed when cut), 3 = roof (screen fade).
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

export const CURB_H = 1.25;

export interface CutUniforms {
  uCurb: { value: number };
  uRoofY: { value: number };
  uFade: { value: [number, number] };
}

export function cutUniforms(roofY: number): CutUniforms {
  return { uCurb: { value: CURB_H }, uRoofY: { value: roofY }, uFade: { value: [0.38, 0.6] } };
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
uniform vec2 uFade;
varying float vFpFade;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vFpFade = 1.0;
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
    float ny = c.w > 0.0 ? c.y / c.w : -2.0;
    vFpFade = smoothstep(uFade.x, uFade.y, ny);
    if (vFpFade < 0.003) transformed = vec3(0.0);
  }
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vFpFade;
float fpBayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  int i = int(q.x) + int(q.y) * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}`,
      )
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif (vFpFade < 0.999 && fpBayer(gl_FragCoord.xy) > vFpFade) discard;`);
  };
  // Different patched variants must not share a program cache key with the unpatched material.
  const tag = `|fp-cutaway${opts.instanced ? 'i' : 'm'}|${prev ? prev.toString() : ''}`;
  mat.customProgramCacheKey = () => tag;
}

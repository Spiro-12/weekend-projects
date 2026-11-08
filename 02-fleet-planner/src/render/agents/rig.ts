// One instanced draw call per agent type. A baked model (one merged geometry with per-vertex part ids, colours and
// material values, see models/parts.ts) is drawn with a MeshStandardMaterial whose vertex shader poses each part
// from per-instance values: walk phase and stride amount (legs and arms swing about their pivots), fork lift,
// cargo and pose flags. Per-vertex roughness / metalness / emission let one material cover paint, metal, visors
// and glowing light bands. Spike a measured instanced parts at 23 draw calls for 40 people vs 779 skinned; this goes
// further: any crowd of one type is a single call.
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { BakedModel } from '../models/parts.ts';

const PIVOT_KEYS = ['hipL', 'hipR', 'kneeL', 'kneeR', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'lidar'] as const;

const VERT_PARS = /* glsl */ `
attribute vec4 aInfo;
attribute vec4 aAnim;
attribute vec4 aAccent;
uniform vec3 uPivot[9];
uniform float uTime;
uniform vec4 uRig;
uniform float uSelfEmit;
varying vec2 vFpMat;
varying vec3 vFpEmit;
mat3 fpRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
mat3 fpRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
`;

// Runs at the start of main's normal block: computes the part transform (fpR, fpT) used for normal and position.
const VERT_POSE = /* glsl */ `
int fpPart = int(aInfo.x + 0.5);
int fpFlags = int(aAnim.w + 0.5);
float fpPhase = aAnim.x * 6.2831853;
float fpAmt = aAnim.y;
float fpLift = aAnim.z;
mat3 fpR = mat3(1.0);
vec3 fpT = vec3(0.0);
bool fpHide = (fpPart == 11 && (fpFlags & 1) == 0) || (fpPart == 12 && (fpFlags & 2) == 0) ||
  (fpPart == 13 && (fpFlags & 4) == 0) || ((fpFlags & 8) != 0 && fpPart != 12);
if (fpPart >= 1 && fpPart <= 8) {
  bool fpLeft = (fpPart % 2) == 1;
  float t = fpPhase + (fpLeft ? 0.0 : 3.14159265);
  if (fpPart <= 4) {
    vec3 hp = fpLeft ? uPivot[0] : uPivot[1];
    mat3 rh = fpRotZ(sin(t) * uRig.x * fpAmt);
    if (fpPart >= 3) {
      vec3 kp = fpLeft ? uPivot[2] : uPivot[3];
      mat3 rk = fpRotZ(-max(0.0, sin(t + 1.5708)) * uRig.w * fpAmt);
      fpR = rh * rk;
      fpT = rh * (kp - rk * kp - hp) + hp;
    } else {
      fpR = rh;
      fpT = hp - rh * hp;
    }
  } else {
    bool hold = (fpFlags & 16) != 0;
    bool push = (fpFlags & 32) != 0;
    float sh = hold ? 0.5 : push ? 0.55 : -sin(t) * uRig.y * fpAmt;
    float el = hold ? 1.1 : push ? 0.75 : 0.12 + max(0.0, -sin(t)) * 0.35 * fpAmt;
    vec3 sp = fpLeft ? uPivot[4] : uPivot[5];
    mat3 rs = fpRotZ(sh);
    if (fpPart >= 7) {
      vec3 ep = fpLeft ? uPivot[6] : uPivot[7];
      mat3 re = fpRotZ(el);
      fpR = rs * re;
      fpT = rs * (ep - re * ep - sp) + sp;
    } else {
      fpR = rs;
      fpT = sp - rs * sp;
    }
  }
}
if (fpPart == 9 || fpPart == 13) fpT.y += fpLift;
if (fpPart == 10) fpT.y += max(0.0, fpLift - uRig.z);
if (fpPart == 14) { fpR = fpRotY(uTime * 7.0); fpT = uPivot[8] - fpR * uPivot[8]; }
if (fpPart != 12 && uRig.x > 0.0) fpT.y -= abs(cos(fpPhase)) * 0.022 * fpAmt;
if (fpHide) { fpR = mat3(0.0); fpT = vec3(0.0); }
vFpMat = aInfo.yz;
int fpEmit = int(aInfo.w + 0.5);
vFpEmit = vec3(0.0);
#ifdef USE_COLOR
if (fpEmit == 1) { vFpEmit = aAccent.rgb * aAccent.a; vColor.rgb *= 0.12; }
else if (fpEmit == 2) vFpEmit = color.rgb * uSelfEmit;
else if (fpEmit == 3) vFpEmit = color.rgb;
#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec2 vFpMat;
varying vec3 vFpEmit;
`;

export interface RigUniforms {
  uPivot: { value: Vector3[] };
  uTime: { value: number };
  uRig: { value: [number, number, number, number] };
  uSelfEmit: { value: number };
}

/** The shared material for one model: MeshStandardMaterial + the rig shader. */
export function rigMaterial(model: BakedModel, rig: { legSwing?: number; armSwing?: number; kneeBend?: number } = {}): { material: MeshStandardMaterial; uniforms: RigUniforms } {
  const uniforms: RigUniforms = {
    uPivot: { value: PIVOT_KEYS.map((k) => model.pivots[k]?.clone() ?? new Vector3()) },
    uTime: { value: 0 },
    uRig: { value: [rig.legSwing ?? 0, rig.armSwing ?? 0, model.freeLift ?? 1, rig.kneeBend ?? 0] },
    uSelfEmit: { value: 4 },
  };
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_POSE}\nobjectNormal = fpR * objectNormal;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = fpR * transformed + fpT;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vFpMat.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vFpMat.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vFpEmit;');
  };
  material.customProgramCacheKey = () => 'fp-rig-v1';
  return { material, uniforms };
}

const tmpColor = new Color();

/** An instanced draw of one baked model, filled each frame with `begin()` / `push()` / `end()`. */
export class RigMesh {
  mesh: InstancedMesh;
  readonly material: MeshStandardMaterial;
  readonly uniforms: RigUniforms;
  /** Instance index → agent id (picking, tests). */
  ids: Int32Array;
  private anim!: InstancedBufferAttribute;
  private accent!: InstancedBufferAttribute;
  private n = 0;
  private cap: number;

  constructor(
    readonly name: string,
    readonly model: BakedModel,
    capacity: number,
    rig: { legSwing?: number; armSwing?: number; kneeBend?: number } = {},
    private onRebuild: (old: InstancedMesh, next: InstancedMesh) => void = () => {},
  ) {
    const m = rigMaterial(model, rig);
    this.material = m.material;
    this.uniforms = m.uniforms;
    this.cap = Math.max(1, capacity);
    this.ids = new Int32Array(this.cap);
    this.mesh = this.build(this.cap);
  }

  private build(cap: number): InstancedMesh {
    const geo: BufferGeometry = this.model.geometry.clone();
    this.anim = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    this.accent = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('aAnim', this.anim);
    geo.setAttribute('aAccent', this.accent);
    const mesh = new InstancedMesh(geo, this.material, cap);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = `agents-${this.name}`;
    return mesh;
  }

  /** Make room for n instances (rebuilds the mesh when it has to grow). */
  reserve(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const old = this.mesh;
    this.cap = cap;
    this.ids = new Int32Array(cap);
    this.mesh = this.build(cap);
    this.onRebuild(old, this.mesh);
    old.geometry.dispose();
    old.dispose();
  }

  begin() {
    this.n = 0;
  }

  push(id: number, matrix: Matrix4, phase: number, amount: number, lift: number, flags: number, accent: number, intensity: number) {
    const i = this.n++;
    this.ids[i] = id;
    this.mesh.setMatrixAt(i, matrix);
    const a = this.anim.array as Float32Array;
    a[i * 4] = phase;
    a[i * 4 + 1] = amount;
    a[i * 4 + 2] = lift;
    a[i * 4 + 3] = flags;
    tmpColor.setHex(accent);
    const c = this.accent.array as Float32Array;
    c[i * 4] = tmpColor.r;
    c[i * 4 + 1] = tmpColor.g;
    c[i * 4 + 2] = tmpColor.b;
    c[i * 4 + 3] = intensity;
  }

  end(time: number) {
    const n = this.n;
    this.mesh.count = n;
    this.uniforms.uTime.value = time;
    for (const attr of [this.mesh.instanceMatrix, this.anim, this.accent]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, n) * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  get count(): number {
    return this.n;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}

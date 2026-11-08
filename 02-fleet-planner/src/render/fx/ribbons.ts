// Route ribbons: flat 12 cm floor ribbons 1 cm above the floor along each robot's route, additive and emissive
// (HDR colour above the bloom threshold), coloured by type with a vendor shade. Dashes flow toward the goal at
// 1.5 m/s and the tail fades. Others show only the next ~10 m; the selected agent shows its whole route, brighter.
// One instanced draw call: one instance per straight run of the route. From far away the ribbon keeps at least
// ~1.6 px of width so routes still read in the overview.
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';

const vert = /* glsl */ `
attribute vec4 aSeg;    // start.xz, end.xz
attribute vec4 aColor;  // rgb (HDR), alpha
attribute vec4 aAlong;  // metres from the agent at start, at end; fade at start, at end
uniform float uWidth;
uniform float uMinPx;
uniform float uViewH;
varying float vAcross;
varying float vAlong;
varying float vFade;
varying vec4 vColor;
void main() {
  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec2 c = mix(a, b, position.x);
  // Metres per pixel at this point: keep the ribbon at least uMinPx wide on screen.
  vec4 vc = viewMatrix * vec4(c.x, 0.01, c.y, 1.0);
  float mpp = 2.0 * (-vc.z) / (projectionMatrix[1][1] * uViewH);
  float w = max(uWidth, uMinPx * mpp);
  vec2 p = c + n * position.y * w * 0.5;
  vAcross = position.y;
  vAlong = mix(aAlong.x, aAlong.y, position.x);
  vFade = mix(aAlong.z, aAlong.w, position.x);
  vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.01, p.y, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime;
varying float vAcross;
varying float vAlong;
varying float vFade;
varying vec4 vColor;
void main() {
  float r = abs(vAcross);
  float core = 1.0 - smoothstep(0.55, 1.0, r);
  float dash = 0.45 + 0.55 * smoothstep(0.25, 0.55, fract((vAlong - uTime * 1.5) / 0.9));
  float a = core * dash * vFade * vColor.a;
  gl_FragColor = vec4(vColor.rgb * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Ribbons {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private geo: InstancedBufferGeometry;
  private seg!: InstancedBufferAttribute;
  private col!: InstancedBufferAttribute;
  private along!: InstancedBufferAttribute;
  private cap = 0;
  private n = 0;
  /** Agents with a ribbon this frame. */
  agents = 0;

  constructor(capacity: number) {
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    this.geo = geo;
    this.alloc(capacity);
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uWidth: { value: 0.12 }, uTime: { value: 0 }, uMinPx: { value: 1.6 }, uViewH: { value: 900 } },
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'agents-ribbons';
  }

  private alloc(cap: number) {
    const keep = this.n;
    const old = this.cap ? [this.seg.array, this.col.array, this.along.array] : null;
    this.cap = cap;
    this.seg = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    this.col = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    this.along = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    if (old) {
      (this.seg.array as Float32Array).set((old[0] as Float32Array).subarray(0, keep * 4));
      (this.col.array as Float32Array).set((old[1] as Float32Array).subarray(0, keep * 4));
      (this.along.array as Float32Array).set((old[2] as Float32Array).subarray(0, keep * 4));
      this.geo.dispose();
    }
    this.geo.setAttribute('aSeg', this.seg);
    this.geo.setAttribute('aColor', this.col);
    this.geo.setAttribute('aAlong', this.along);
  }

  begin() {
    this.n = 0;
    this.agents = 0;
  }

  /** One straight run from (ax, az) to (bx, bz), `s0`..`s1` metres along the route, fade f0..f1. */
  segment(ax: number, az: number, bx: number, bz: number, s0: number, s1: number, f0: number, f1: number, r: number, g: number, b: number, a: number) {
    if (this.n >= this.cap) this.alloc(this.cap * 2);
    const i = this.n++;
    const S = this.seg.array as Float32Array;
    S[i * 4] = ax;
    S[i * 4 + 1] = az;
    S[i * 4 + 2] = bx;
    S[i * 4 + 3] = bz;
    const C = this.col.array as Float32Array;
    C[i * 4] = r;
    C[i * 4 + 1] = g;
    C[i * 4 + 2] = b;
    C[i * 4 + 3] = a;
    const A = this.along.array as Float32Array;
    A[i * 4] = s0;
    A[i * 4 + 1] = s1;
    A[i * 4 + 2] = f0;
    A[i * 4 + 3] = f1;
  }

  end(time: number, viewH: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uViewH.value = viewH;
    this.geo.instanceCount = this.n;
    for (const attr of [this.seg, this.col, this.along]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, this.n) * 4);
      attr.needsUpdate = true;
    }
  }

  get segments(): number {
    return this.n;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}

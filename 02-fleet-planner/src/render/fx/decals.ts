// Floor decals for every agent in ONE instanced draw call: soft type-coloured glow discs with a dark contact core
// (grounds agents and makes them readable from the overview), the forklift's blue safety spot, thin glowing rings
// (selection: 6 cm cyan; blocked: amber; deadlock: pulsing red) and flowing arrows (deadlock wait-for cycles, the
// selected agent's "waiting for"). Premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA): rgb adds light, alpha
// darkens, so glow and contact shadow share one pass.
import {
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  AddEquation,
} from 'three';

export const DECAL = { DISC: 0, RING: 1, ARROW: 2 } as const;

const vert = /* glsl */ `
attribute vec4 aKind;   // kind, p1, p2, p3
attribute vec4 aColor;  // rgb (HDR), alpha
varying vec2 vM;        // metres from the centre (x along, y across)
varying vec2 vSize;     // quad size in metres
varying vec4 vKind;
varying vec4 vColor;
void main() {
  float sx = length(instanceMatrix[0].xyz);
  float sz = length(instanceMatrix[2].xyz);
  vSize = vec2(sx, sz);
  vM = vec2(position.x * sx, position.z * sz);
  vKind = aKind;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime;
varying vec2 vM;
varying vec2 vSize;
varying vec4 vKind;
varying vec4 vColor;
void main() {
  int kind = int(vKind.x + 0.5);
  vec3 rgb = vec3(0.0);
  float a = 0.0;
  if (kind == 0) {
    // Glow disc (ellipse): soft light falloff + a dark contact core (p1 = shadow strength).
    vec2 q = vM / (vSize * 0.5);
    float r = length(q);
    float glow = pow(max(0.0, 1.0 - r), 2.2);
    float core = (1.0 - smoothstep(0.15, 0.75, r)) * vKind.y;
    rgb = vColor.rgb * glow * vColor.a;
    a = core;
  } else if (kind == 1) {
    // Ring: radius p1 (m), line width p2 (m), pulse p3 (0 / 1).
    float r = length(vM);
    float d = abs(r - vKind.y);
    float w = vKind.z * 0.5;
    float aa = fwidth(r) * 1.2;
    float line = 1.0 - smoothstep(w, w + aa, d);
    float halo = exp(-d * d / (w * w * 4.0)) * 0.22;
    float pulse = vKind.w > 0.5 ? 0.55 + 0.45 * sin(uTime * 6.0) : 1.0;
    rgb = vColor.rgb * (line + halo) * pulse * vColor.a;
    a = line * 0.15 * vColor.a;
  } else {
    // Arrow along +x: shaft with flowing dashes, a head at the far end. p1 = width (m).
    float len = vSize.x;
    float along = vM.x + len * 0.5;
    float w = vKind.y;
    float head = min(0.55, len * 0.45);
    float x = along - (len - head);
    float aa = fwidth(vM.y) * 1.5;
    float shaft = (1.0 - smoothstep(w * 0.22, w * 0.22 + aa, abs(vM.y))) * step(along, len - head);
    float dash = smoothstep(0.35, 0.5, fract((along - uTime * 1.5) / 0.45)) * 0.6 + 0.4;
    float hw = w * 0.5 * (1.0 - clamp(x / head, 0.0, 1.0));
    float tip = (1.0 - smoothstep(hw, hw + aa, abs(vM.y))) * step(0.0, x);
    float m = max(shaft * dash, tip);
    float pulse = vKind.z > 0.5 ? 0.65 + 0.35 * sin(uTime * 6.0) : 1.0;
    rgb = vColor.rgb * m * pulse * vColor.a;
    a = m * 0.2 * vColor.a;
  }
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const m4 = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const p = new Vector3();
const s = new Vector3();

export class Decals {
  mesh: InstancedMesh;
  readonly material: ShaderMaterial;
  private kind!: InstancedBufferAttribute;
  private color!: InstancedBufferAttribute;
  private n = 0;
  private cap: number;
  /** Counts by kind for debug(). */
  counts = { discs: 0, rings: 0, arrows: 0 };

  constructor(capacity: number, private onRebuild: (old: InstancedMesh, next: InstancedMesh) => void) {
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.cap = capacity;
    this.mesh = this.build(capacity);
  }

  private build(cap: number): InstancedMesh {
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.kind = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    this.color = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('aKind', this.kind);
    geo.setAttribute('aColor', this.color);
    const mesh = new InstancedMesh(geo, this.material, cap);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.name = 'agents-decals';
    return mesh;
  }

  begin() {
    this.n = 0;
    this.counts.discs = this.counts.rings = this.counts.arrows = 0;
  }

  private slot(): number {
    if (this.n >= this.cap) {
      const old = this.mesh;
      const oldKind = this.kind.array as Float32Array;
      const oldColor = this.color.array as Float32Array;
      const oldMat = old.instanceMatrix.array as Float32Array;
      this.cap *= 2;
      this.mesh = this.build(this.cap);
      (this.kind.array as Float32Array).set(oldKind);
      (this.color.array as Float32Array).set(oldColor);
      (this.mesh.instanceMatrix.array as Float32Array).set(oldMat);
      this.onRebuild(old, this.mesh);
      old.geometry.dispose();
      old.dispose();
    }
    return this.n++;
  }

  private write(i: number, kind: number, p1: number, p2: number, p3: number, r: number, g: number, b: number, a: number) {
    const k = this.kind.array as Float32Array;
    k[i * 4] = kind;
    k[i * 4 + 1] = p1;
    k[i * 4 + 2] = p2;
    k[i * 4 + 3] = p3;
    const c = this.color.array as Float32Array;
    c[i * 4] = r;
    c[i * 4 + 1] = g;
    c[i * 4 + 2] = b;
    c[i * 4 + 3] = a;
  }

  /** Elliptical glow disc (length along yaw × width) with a contact-shadow core. */
  disc(x: number, z: number, y: number, yaw: number, length: number, width: number, r: number, g: number, b: number, intensity: number, shadow: number) {
    const i = this.slot();
    q.setFromAxisAngle(up, yaw);
    this.mesh.setMatrixAt(i, m4.compose(p.set(x, y, z), q, s.set(length, 1, width)));
    this.write(i, DECAL.DISC, shadow, 0, 0, r, g, b, intensity);
    this.counts.discs++;
  }

  ring(x: number, z: number, radius: number, lineWidth: number, r: number, g: number, b: number, intensity: number, pulse: boolean) {
    const i = this.slot();
    const size = (radius + lineWidth * 3) * 2;
    this.mesh.setMatrixAt(i, m4.compose(p.set(x, 0.022, z), q.identity(), s.set(size, 1, size)));
    this.write(i, DECAL.RING, radius, lineWidth, pulse ? 1 : 0, r, g, b, intensity);
    this.counts.rings++;
  }

  arrow(x0: number, z0: number, x1: number, z1: number, width: number, r: number, g: number, b: number, intensity: number, pulse: boolean) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const i = this.slot();
    q.setFromAxisAngle(up, Math.atan2(-dz, dx));
    this.mesh.setMatrixAt(i, m4.compose(p.set((x0 + x1) / 2, 0.026, (z0 + z1) / 2), q, s.set(len, 1, width)));
    this.write(i, DECAL.ARROW, width, pulse ? 1 : 0, 0, r, g, b, intensity);
    this.counts.arrows++;
  }

  end(time: number) {
    this.mesh.count = this.n;
    this.material.uniforms.uTime.value = time;
    for (const attr of [this.mesh.instanceMatrix, this.kind, this.color]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, this.n) * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}

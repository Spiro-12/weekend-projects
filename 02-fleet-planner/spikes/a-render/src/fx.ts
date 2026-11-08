// Agent effects, one draw call each per side: instanced blob shadows and glowing route ribbons.
import {
  AdditiveBlending, CanvasTexture, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, Float32BufferAttribute, Vector3,
  Quaternion,
} from 'three';
import { ROUTE_MAX, type Walker } from './walkers.ts';

// ───────────── Blob shadows (medium and low tiers) ─────────────
function blobTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.4)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

const BLOB: Record<Walker['kind'], [number, number]> = { amr: [1.25, 1.0], forklift: [2.6, 1.5], person: [0.8, 0.8] };

export class BlobShadows {
  readonly mesh: InstancedMesh;
  private m = new Matrix4();
  private q = new Quaternion();
  private p = new Vector3();
  private s = new Vector3();
  private up = new Vector3(0, 1, 0);

  constructor(private walkers: Walker[]) {
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, color: 0x000000 });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    this.mesh = new InstancedMesh(geo, mat, Math.max(1, walkers.length));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = walkers.length;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'blob-shadows';
  }

  update(): void {
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i];
      const [sx, sz] = BLOB[w.kind];
      this.q.setFromAxisAngle(this.up, w.yaw);
      this.p.set(w.x, 0.012, w.z);
      this.s.set(sx, 1, sz);
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ───────────── Route ribbons (all tiers) ─────────────
const RIBBON_COLOR = [new Color(2.2, 1.0, 0.25), new Color(0.3, 1.1, 2.6), new Color(2.2, 1.7, 0.3)];

const vert = /* glsl */ `
attribute vec4 aSeg;    // start.xz, end.xz
attribute vec4 aColor;  // rgb, unused
attribute vec2 aFade;   // alpha at start, alpha at end
uniform float uWidth;
varying float vAcross;
varying float vAlpha;
varying float vAlong;
varying vec3 vColor;
void main() {
  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float ext = uWidth * 0.5;
  vec2 p = mix(a - dir * ext, b + dir * ext, position.x) + n * position.y * uWidth * 0.5;
  vAcross = position.y;
  vAlpha = mix(aFade.x, aFade.y, position.x);
  vAlong = mix(-ext, len + ext, position.x);
  vColor = aColor.rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.025, p.y, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime;
varying float vAcross;
varying float vAlpha;
varying float vAlong;
varying vec3 vColor;
void main() {
  float r = abs(vAcross);
  float core = exp(-r * r * 40.0);
  float glow = exp(-r * r * 5.0) * 0.35;
  float flow = 0.8 + 0.2 * sin((vAlong - uTime * 2.5) * 5.0);
  float a = (core + glow) * vAlpha * flow * (1.0 - smoothstep(0.85, 1.0, r));
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Ribbons {
  readonly mesh: Mesh;
  private seg: InstancedBufferAttribute;
  private col: InstancedBufferAttribute;
  private fade: InstancedBufferAttribute;
  private geo: InstancedBufferGeometry;
  private robots: Walker[];
  readonly material: ShaderMaterial;

  constructor(walkers: Walker[], private cellX: Float32Array, private cellZ: Float32Array) {
    this.robots = walkers.filter((w) => w.kind !== 'person');
    const max = Math.max(1, this.robots.length * (ROUTE_MAX + 1));
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]); // counter-clockwise seen from above (+y)
    this.seg = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.col = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.fade = new InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(DynamicDrawUsage);
    geo.setAttribute('aSeg', this.seg);
    geo.setAttribute('aColor', this.col);
    geo.setAttribute('aFade', this.fade);
    geo.instanceCount = 0;
    this.geo = geo;
    this.material = new ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uWidth: { value: 0.42 }, uTime: { value: 0 } },
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'ribbons';
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    const S = this.seg.array as Float32Array;
    const C = this.col.array as Float32Array;
    const F = this.fade.array as Float32Array;
    const { cellX, cellZ } = this;
    let n = 0;
    for (const w of this.robots) {
      if (w.from === w.goal && w.to === w.goal) continue;
      const total = w.route.length + 1;
      const c = RIBBON_COLOR[w.vendor] ?? RIBBON_COLOR[0];
      let ax = w.x;
      let az = w.z;
      for (let k = 0; k < total; k++) {
        const cell = k === 0 ? w.to : w.route[k - 1];
        const bx = cellX[cell];
        const bz = cellZ[cell];
        S[n * 4] = ax;
        S[n * 4 + 1] = az;
        S[n * 4 + 2] = bx;
        S[n * 4 + 3] = bz;
        C[n * 4] = c.r;
        C[n * 4 + 1] = c.g;
        C[n * 4 + 2] = c.b;
        F[n * 2] = 1 - k / total;
        F[n * 2 + 1] = 1 - (k + 1) / total;
        n++;
        ax = bx;
        az = bz;
      }
    }
    this.geo.instanceCount = n;
    for (const a of [this.seg, this.col, this.fade]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get segments(): number {
    return this.geo.instanceCount;
  }
}

// People option (ii): instanced rigid parts with a procedural limb swing. 4 draw calls per side for any crowd size.
import {
  CapsuleGeometry, Color, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, SphereGeometry,
  BufferGeometry, Float32BufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Walker } from './walkers.ts';

const VESTS = ['#d7f205', '#ff8a1f', '#d7f205', '#c6f000'].map((h) => new Color(h));
const STRIDE = 1.3; // metres per full walk cycle

function tint(g: BufferGeometry, hex: string): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(a, 3));
  return g;
}

export class PeopleParts {
  readonly group = new Group();
  private torso: InstancedMesh;
  private head: InstancedMesh;
  private legs: InstancedMesh;
  private arms: InstancedMesh;
  private swing: Float32Array;
  private base = new Matrix4();
  private local = new Matrix4();
  private out = new Matrix4();

  constructor(private people: Walker[], castShadow: boolean) {
    const n = people.length;
    this.swing = new Float32Array(n);
    const mk = (geo: BufferGeometry, mat: MeshStandardMaterial, count: number, name: string) => {
      const m = new InstancedMesh(geo, mat, Math.max(1, count));
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.count = count;
      m.frustumCulled = false;
      m.castShadow = castShadow;
      m.name = name;
      this.group.add(m);
      return m;
    };
    // Torso (vest), flattened front to back. Faces +x.
    const torsoGeo = new CapsuleGeometry(0.17, 0.32, 4, 10);
    torsoGeo.scale(0.75, 1, 1);
    torsoGeo.translate(0, 1.2, 0);
    this.torso = mk(torsoGeo, new MeshStandardMaterial({ roughness: 0.6 }), n, 'people-torso');
    // Head + hard hat, vertex coloured.
    const head = tint(new SphereGeometry(0.105, 12, 8).translate(0, 1.62, 0), '#c98e6a');
    const hat = tint(new SphereGeometry(0.125, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.66, 0), '#f3f4f6');
    this.head = mk(mergeGeometries([head, hat]), new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), n, 'people-head');
    head.dispose();
    hat.dispose();
    // Leg and arm hang from their pivot (y = 0 at hip / shoulder).
    const leg = new CapsuleGeometry(0.075, 0.72, 3, 8).translate(0, -0.43, 0);
    this.legs = mk(leg, new MeshStandardMaterial({ color: '#2b3442', roughness: 0.8 }), n * 2, 'people-legs');
    const arm = new CapsuleGeometry(0.055, 0.5, 3, 8).translate(0, -0.3, 0);
    this.arms = mk(arm, new MeshStandardMaterial({ color: '#3a4250', roughness: 0.8 }), n * 2, 'people-arms');
    people.forEach((_, i) => this.torso.setColorAt(i, VESTS[i % VESTS.length]));
  }

  update(dt: number): void {
    const { base, local, out } = this;
    const k = dt > 0 ? 1 - Math.exp(-dt * 6) : 1;
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      this.swing[i] += ((p.moving ? 0.5 : 0) - this.swing[i]) * k;
      const amp = this.swing[i];
      const phase = (p.dist / STRIDE) * Math.PI * 2;
      const s = Math.sin(phase) * amp;
      const bob = Math.abs(Math.cos(phase)) * 0.03 * amp * 2;
      base.makeRotationY(p.yaw).setPosition(p.x, bob, p.z);
      this.torso.setMatrixAt(i, base);
      this.head.setMatrixAt(i, base);
      local.makeRotationZ(s).setPosition(0, 0.9, 0.1);
      this.legs.setMatrixAt(i * 2, out.multiplyMatrices(base, local));
      local.makeRotationZ(-s).setPosition(0, 0.9, -0.1);
      this.legs.setMatrixAt(i * 2 + 1, out.multiplyMatrices(base, local));
      local.makeRotationZ(-s * 0.8).setPosition(0, 1.42, 0.2);
      this.arms.setMatrixAt(i * 2, out.multiplyMatrices(base, local));
      local.makeRotationZ(s * 0.8).setPosition(0, 1.42, -0.2);
      this.arms.setMatrixAt(i * 2 + 1, out.multiplyMatrices(base, local));
    }
    for (const m of [this.torso, this.head, this.legs, this.arms]) m.instanceMatrix.needsUpdate = true;
  }
}

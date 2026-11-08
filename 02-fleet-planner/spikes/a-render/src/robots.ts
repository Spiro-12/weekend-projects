// Robots as instanced rigid parts, one set of meshes per side (split screen = two sets on different layers).
// Draw calls per side: AMR body, AMR lift top, forklift body, mast, forks, wheels (shared), lights (shared) = 7.
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DynamicDrawUsage, Float32BufferAttribute, Group, InstancedMesh,
  Matrix4, MeshBasicMaterial, MeshStandardMaterial, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Walker } from './walkers.ts';

const VENDOR_BODY = [new Color('#f28c28'), new Color('#3b82f6'), new Color('#f5c518')];
/** HDR light colours (> 1 so they bloom on the high tier). */
const VENDOR_LIGHT = [new Color(3.2, 1.6, 0.4), new Color(0.5, 1.6, 4.0), new Color(3.0, 2.4, 0.4)];

function colored(g: BufferGeometry, hex: string): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(a, 3));
  return g;
}
function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, hex = '#ffffff'): BufferGeometry {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  return colored(g, hex);
}
function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

function inst(geo: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, count: number, name: string): InstancedMesh {
  const m = new InstancedMesh(geo, mat, Math.max(1, count));
  m.instanceMatrix.setUsage(DynamicDrawUsage);
  m.count = count;
  m.frustumCulled = false; // agents roam the whole floor; one sphere test per mesh would not save anything
  m.name = name;
  return m;
}

export class RobotMeshes {
  readonly group = new Group();
  private amrBody: InstancedMesh;
  private amrTop: InstancedMesh;
  private fkBody: InstancedMesh;
  private mast: InstancedMesh;
  private forks: InstancedMesh;
  private wheels: InstancedMesh;
  private lights: InstancedMesh;
  private amrs: Walker[];
  private fks: Walker[];
  private base = new Matrix4();
  private local = new Matrix4();
  private out = new Matrix4();

  constructor(walkers: Walker[], castShadow: boolean) {
    this.amrs = walkers.filter((w) => w.kind === 'amr');
    this.fks = walkers.filter((w) => w.kind === 'forklift');
    const nA = this.amrs.length;
    const nF = this.fks.length;
    const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]) => new MeshStandardMaterial(o);

    // AMR: 0.9 x 0.65 m, 0.38 m tall, wheel radius 0.08.
    const amrBody = merge([
      box(0.9, 0.26, 0.65, 0, 0.21, 0),
      box(0.92, 0.05, 0.67, 0, 0.1, 0, '#1b1f27'), // bumper band
      box(0.06, 0.12, 0.3, 0.44, 0.24, 0, '#111318'), // front sensor window
    ]);
    this.amrBody = inst(amrBody, std({ vertexColors: true, roughness: 0.35, metalness: 0.2 }), nA, 'amr-body');
    this.amrTop = inst(box(0.82, 0.04, 0.58, 0, 0.36, 0, '#c9ced6'), std({ vertexColors: true, roughness: 0.5, metalness: 0.6 }), nA, 'amr-top');

    // Forklift: about 2.3 m long with forks, mast 2.3 m.
    const fkBody = merge([
      box(1.3, 0.55, 0.95, -0.15, 0.42, 0),
      box(0.55, 0.75, 0.9, -0.55, 1.05, 0), // counterweight / battery
      box(0.12, 0.35, 0.12, -0.55, 1.6, 0, '#111318'), // lidar tower
      box(0.45, 0.06, 0.95, 0.25, 0.72, 0, '#1b1f27'),
    ]);
    this.fkBody = inst(fkBody, std({ vertexColors: true, roughness: 0.4, metalness: 0.25 }), nF, 'forklift-body');
    const mast = merge([box(0.08, 2.3, 0.08, 0.55, 1.2, 0.32, '#3a3f48'), box(0.08, 2.3, 0.08, 0.55, 1.2, -0.32, '#3a3f48'), box(0.06, 0.08, 0.72, 0.55, 2.3, 0, '#3a3f48')]);
    this.mast = inst(mast, std({ vertexColors: true, roughness: 0.5, metalness: 0.7 }), nF, 'forklift-mast');
    const forks = merge([box(0.05, 0.5, 0.8, 0.62, 0.3, 0, '#2a2e35'), box(1.05, 0.05, 0.12, 1.15, 0.06, 0.25, '#4b5160'), box(1.05, 0.05, 0.12, 1.15, 0.06, -0.25, '#4b5160')]);
    this.forks = inst(forks, std({ vertexColors: true, roughness: 0.4, metalness: 0.8 }), nF, 'forklift-forks');

    // Wheels: an axle pair (two cylinders sharing the local z axis), radius 1, scaled per type.
    const w = new CylinderGeometry(1, 1, 0.6, 14);
    w.rotateX(Math.PI / 2);
    const wl = w.clone().translate(0, 0, 4.2);
    const wr = w.clone().translate(0, 0, -4.2);
    w.dispose();
    this.wheels = inst(merge([colored(wl, '#15171c'), colored(wr, '#15171c')]), std({ vertexColors: true, roughness: 0.9 }), (nA + nF) * 2, 'wheels');

    this.lights = inst(box(0.03, 0.05, 0.42, 0, 0, 0), new MeshBasicMaterial({ vertexColors: true }), nA + nF, 'lights');

    let i = 0;
    for (const a of this.amrs) {
      this.amrBody.setColorAt(i, VENDOR_BODY[a.vendor]);
      this.lights.setColorAt(i++, VENDOR_LIGHT[a.vendor]);
    }
    let j = 0;
    for (const f of this.fks) {
      this.fkBody.setColorAt(j++, VENDOR_BODY[f.vendor]);
      this.lights.setColorAt(i++, VENDOR_LIGHT[f.vendor]);
    }
    for (const m of [this.amrBody, this.amrTop, this.fkBody, this.mast, this.forks, this.wheels, this.lights]) {
      m.castShadow = castShadow && m !== this.lights;
      if (m.count > 0) this.group.add(m);
    }
  }

  update(): void {
    const { base, local, out } = this;
    let wi = 0;
    let li = 0;
    for (let i = 0; i < this.amrs.length; i++) {
      const a = this.amrs[i];
      base.makeRotationY(a.yaw).setPosition(a.x, 0, a.z);
      this.amrBody.setMatrixAt(i, base);
      local.makeTranslation(0, a.lift * 0.12, 0);
      this.amrTop.setMatrixAt(i, out.multiplyMatrices(base, local));
      const spin = -a.dist / 0.08;
      for (const dx of [0.3, -0.3]) {
        local.makeRotationZ(spin).scale(SCALE_AMR_WHEEL).setPosition(dx, 0.08, 0);
        this.wheels.setMatrixAt(wi++, out.multiplyMatrices(base, local));
      }
      local.makeTranslation(0.455, 0.26, 0);
      this.lights.setMatrixAt(li++, out.multiplyMatrices(base, local));
    }
    for (let i = 0; i < this.fks.length; i++) {
      const f = this.fks[i];
      base.makeRotationY(f.yaw).setPosition(f.x, 0, f.z);
      this.fkBody.setMatrixAt(i, base);
      this.mast.setMatrixAt(i, base);
      local.makeTranslation(0, f.lift * 1.6, 0);
      this.forks.setMatrixAt(i, out.multiplyMatrices(base, local));
      const spin = -f.dist / 0.16;
      for (const dx of [0.35, -0.6]) {
        local.makeRotationZ(spin).scale(SCALE_FK_WHEEL).setPosition(dx, 0.16, 0);
        this.wheels.setMatrixAt(wi++, out.multiplyMatrices(base, local));
      }
      local.makeTranslation(-0.83, 1.0, 0);
      this.lights.setMatrixAt(li++, out.multiplyMatrices(base, local));
    }
    for (const m of [this.amrBody, this.amrTop, this.fkBody, this.mast, this.forks, this.wheels, this.lights]) m.instanceMatrix.needsUpdate = true;
  }
}

/** Unit wheel geometry: radius 1, axle pair at z = +-4.2 → scaled to radius 0.08 (AMR, pair 0.67 m apart) etc. */
const SCALE_AMR_WHEEL = new Vector3(0.08, 0.08, 0.08);
const SCALE_FK_WHEEL = new Vector3(0.16, 0.16, 0.1);

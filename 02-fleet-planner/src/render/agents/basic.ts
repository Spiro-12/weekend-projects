// Basic agent layer (Phase 0 lead version; Track E owns src/render/agents/ from Phase 1 with real models, ribbons
// and deadlock markers). Simple instanced shapes per type, interpolated from (cell, to, moveStart, moveEnd) at the
// fractional render tick, faint route lines, a selection ring and picking.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Camera,
  type Raycaster,
} from 'three';
import type { AgentTypeId, AgentView, Snapshot } from '../../contracts/types.ts';
import { CELL_M, headingYaw, type GridDims } from '../core/geom.ts';

export const VENDOR_COLORS: Record<string, number> = { A: 0x38d9ff, D: 0xb07cff, B: 0xff8a3d, C: 0x4dffb8, '-': 0xffd23f };
const MAX = 400;

interface Part {
  mesh: InstancedMesh;
  types: AgentTypeId[];
  /** Local transform of the part relative to the agent origin. */
  local: Matrix4;
  /** Per-agent color, or null to keep the material color. */
  color: ((a: AgentView) => number) | null;
  pickable: boolean;
}

export class BasicAgentLayer {
  readonly group = new Group();
  private parts: Part[] = [];
  private order: AgentView[] = [];
  private pos = new Map<number, Vector3>();
  private yaw = new Map<number, number>();
  private routes: LineSegments;
  private routePos: Float32Array;
  private routeCol: Float32Array;
  private ring: Mesh;
  private tmp = new Object3D();
  private m = new Matrix4();
  private c = new Color();

  constructor(private dims: GridDims) {
    this.group.name = 'agents-basic';
    const dark = new MeshStandardMaterial({ color: 0x262b33, roughness: 0.45, metalness: 0.5 });
    const white = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 });
    const glow = new MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1.8, toneMapped: false });
    const skin = new MeshStandardMaterial({ color: 0xd9a37a, roughness: 0.7 });
    const box = (w: number, h: number, d: number, y: number) => new BoxGeometry(w, h, d).translate(0, y + h / 2, 0);
    const T = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
    const vendor = (a: AgentView) => VENDOR_COLORS[a.vendor] ?? 0xffffff;

    // AMR: low dark base, glowing vendor band, mast, two totes.
    this.part(box(0.62, 0.3, 0.62, 0.04), dark, ['amr'], T(0, 0, 0), null, true);
    this.part(box(0.64, 0.05, 0.64, 0.2), glow, ['amr'], T(0, 0, 0), vendor, false);
    this.part(box(0.06, 0.95, 0.06, 0.34), dark, ['amr'], T(-0.22, 0, 0), null, false);
    this.part(box(0.46, 0.22, 0.38, 0.5), white, ['amr'], T(0.05, 0, 0), () => 0x2f6fd6, false);
    this.part(box(0.46, 0.22, 0.38, 0.86), white, ['amr'], T(0.05, 0, 0), () => 0xe8772e, false);
    // Forklifts: body, mast, forks; human-driven ones carry a yellow-vest driver.
    this.part(box(1.6, 1.05, 1.0, 0.12), white, ['forklift', 'driver'], T(-0.2, 0, 0), (a) => (a.type === 'forklift' ? vendor(a) : 0xd4a017), true);
    this.part(box(0.12, 2.3, 0.85, 0.05), dark, ['forklift', 'driver'], T(0.68, 0, 0), null, false);
    this.part(box(1.0, 0.06, 0.7, 0.12), dark, ['forklift', 'driver'], T(1.2, 0, 0), null, false);
    this.part(box(0.1, 0.18, 0.18, 2.35), glow, ['forklift'], T(0.68, 0, 0), vendor, false);
    this.part(new CapsuleGeometry(0.2, 0.45, 4, 8).translate(0, 1.5, 0), white, ['driver'], T(-0.35, 0, 0), () => 0xffd23f, false);
    // Humanoid: light grey body, head with glowing visor.
    this.part(new CapsuleGeometry(0.2, 0.95, 4, 10).translate(0, 0.72, 0), white, ['humanoid'], T(0, 0, 0), () => 0xd5dae1, true);
    this.part(new SphereGeometry(0.15, 12, 8).translate(0, 1.58, 0), dark, ['humanoid'], T(0, 0, 0), null, false);
    this.part(box(0.06, 0.06, 0.2, 1.56), glow, ['humanoid'], T(0.13, 0, 0), vendor, false);
    // People: navy body, hi-vis vest, head; pickers push a small cart.
    this.part(new CapsuleGeometry(0.2, 0.85, 4, 10).translate(0, 0.65, 0), white, ['picker'], T(0, 0, 0), () => 0x2b3445, true);
    this.part(new CylinderGeometry(0.235, 0.235, 0.5, 12).translate(0, 1.05, 0), white, ['picker'], T(0, 0, 0), () => 0xd8f02a, false);
    this.part(new SphereGeometry(0.13, 12, 8).translate(0, 1.55, 0), skin, ['picker'], T(0, 0, 0), null, false);
    this.part(box(0.7, 0.5, 0.45, 0.3), white, ['picker'], T(0.62, 0, 0), () => 0x5b6370, false);

    // Route lines: up to 12 segments per agent, additive.
    const segs = MAX * 12;
    this.routePos = new Float32Array(segs * 6);
    this.routeCol = new Float32Array(segs * 6);
    const rg = new BufferGeometry();
    rg.setAttribute('position', new BufferAttribute(this.routePos, 3).setUsage(DynamicDrawUsage));
    rg.setAttribute('color', new BufferAttribute(this.routeCol, 3).setUsage(DynamicDrawUsage));
    this.routes = new LineSegments(rg, new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.routes.frustumCulled = false;
    this.group.add(this.routes);

    this.ring = new Mesh(new RingGeometry(0.75, 0.95, 40).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0xffc531, transparent: true, opacity: 0.9, toneMapped: false }));
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  private part(geo: BufferGeometry, mat: MeshStandardMaterial, types: AgentTypeId[], local: Matrix4, color: Part['color'], pickable: boolean) {
    const mesh = new InstancedMesh(geo, mat, MAX);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    if (color) mesh.setColorAt(0, new Color(0xffffff));
    this.group.add(mesh);
    this.parts.push({ mesh, types, local, color, pickable });
  }

  private center(cell: number, out: Vector3): Vector3 {
    const { width, height } = this.dims;
    return out.set(((cell % width) + 0.5 - width / 2) * CELL_M, 0, (Math.floor(cell / width) + 0.5 - height / 2) * CELL_M);
  }

  /** Interpolate every agent to `renderTick` and write instance matrices. */
  update(snap: Snapshot, renderTick: number, selectedId: number | null, dtMs: number) {
    this.order = snap.agents;
    const a0 = new Vector3();
    const a1 = new Vector3();
    for (const a of snap.agents) {
      let p = this.pos.get(a.id);
      if (!p) {
        p = new Vector3();
        this.pos.set(a.id, p);
      }
      this.center(a.cell, a0);
      if (a.to >= 0 && a.moveEnd > a.moveStart) {
        const k = Math.min(1, Math.max(0, (renderTick - a.moveStart) / (a.moveEnd - a.moveStart)));
        this.center(a.to, a1);
        p.lerpVectors(a0, a1, k);
      } else p.copy(a0);
      // Smooth turning.
      const target = headingYaw(a.heading);
      const cur = this.yaw.get(a.id) ?? target;
      let d = target - cur;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw.set(a.id, cur + d * Math.min(1, dtMs / 140));
    }
    for (const part of this.parts) {
      let n = 0;
      for (const a of snap.agents) {
        if (!part.types.includes(a.type)) continue;
        const p = this.pos.get(a.id)!;
        this.tmp.position.copy(p);
        this.tmp.rotation.set(0, this.yaw.get(a.id) ?? 0, 0);
        this.tmp.updateMatrix();
        this.m.multiplyMatrices(this.tmp.matrix, part.local);
        part.mesh.setMatrixAt(n, this.m);
        if (part.color) part.mesh.setColorAt(n, this.c.setHex(part.color(a)));
        n++;
      }
      part.mesh.count = n;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    // Routes for robots.
    let s = 0;
    const h = 0.04;
    for (const a of snap.agents) {
      if (a.type === 'picker' || !a.route.length) continue;
      const col = this.c.setHex(VENDOR_COLORS[a.vendor] ?? 0xffffff);
      let prev = this.pos.get(a.id)!.clone();
      a.route.forEach((cell, i) => {
        if (s >= MAX * 12) return;
        this.center(cell, a1);
        const fade = (1 - i / a.route.length) * (a.id === selectedId ? 1 : 0.55);
        this.routePos.set([prev.x, h, prev.z, a1.x, h, a1.z], s * 6);
        this.routeCol.set([col.r * fade, col.g * fade, col.b * fade, col.r * fade * 0.8, col.g * fade * 0.8, col.b * fade * 0.8], s * 6);
        prev = a1.clone();
        s++;
      });
    }
    this.routes.geometry.setDrawRange(0, s * 2);
    (this.routes.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    (this.routes.geometry.attributes.color as BufferAttribute).needsUpdate = true;
    // Selection ring.
    const sel = selectedId !== null ? this.pos.get(selectedId) : undefined;
    this.ring.visible = !!sel && snap.agents.some((a) => a.id === selectedId);
    if (sel) this.ring.position.set(sel.x, 0.03, sel.z);
  }

  positionOf(id: number): Vector3 | null {
    return this.order.some((a) => a.id === id) ? (this.pos.get(id) ?? null) : null;
  }

  /** Position and smoothed yaw, for the follow camera. */
  followTarget(id: number): { pos: Vector3; yaw: number } | null {
    const pos = this.positionOf(id);
    return pos ? { pos, yaw: this.yaw.get(id) ?? 0 } : null;
  }

  /** Agent id under the ray, or null. */
  pick(ray: Raycaster): number | null {
    let best: { d: number; id: number } | null = null;
    for (const part of this.parts) {
      if (!part.pickable) continue;
      const hits = ray.intersectObject(part.mesh, false);
      for (const h of hits) {
        if (h.instanceId === undefined) continue;
        const agents = this.order.filter((a) => part.types.includes(a.type));
        const a = agents[h.instanceId];
        if (a && (!best || h.distance < best.d)) best = { d: h.distance, id: a.id };
      }
    }
    // Generous fallback: nearest agent within 1.2 m of where the ray meets the floor.
    if (best === null && ray.ray.direction.y < 0) {
      const t = -ray.ray.origin.y / ray.ray.direction.y;
      const hit = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
      let bd = 1.2;
      for (const a of this.order) {
        const p = this.pos.get(a.id);
        if (!p) continue;
        const d = Math.hypot(p.x - hit.x, p.z - hit.z);
        if (d < bd) {
          bd = d;
          best = { d, id: a.id };
        }
      }
    }
    return best?.id ?? null;
  }

  /** Screen position of an agent (for tests). */
  project(id: number, camera: Camera, w: number, h: number): { x: number; y: number } | null {
    const p = this.positionOf(id);
    if (!p) return null;
    const v = p.clone().setY(0.6).project(camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  count(): number {
    return this.order.length;
  }

  dispose() {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    this.routes.geometry.dispose();
  }
}

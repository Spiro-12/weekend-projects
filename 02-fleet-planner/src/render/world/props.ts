// Everything else in the hall: SimReady props (columns, LED panels, dock gates, pack tables, conveyor sections, rack-end
// guard rails), their procedural stand-ins for the first view, code-built chargers and station details, and the
// cartons riding the conveyor.
//
// Draw calls: boxes 1, glow 1, stand-ins 1 (hidden once the GLBs are in), conveyor cartons 1, plus one per GLB
// primitive (column 2, light panel 3, dock gate 2, pack table 2, conveyor 2, guard rail 2).
import {
  BoxGeometry,
  Color,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import type { Tier } from '../../host/index.ts';
import { CELL_M } from '../core/geom.ts';
import { patchCutaway, type CutUniforms } from './cutaway.ts';
import { GlbInstances, type ExtraAttr, type GlbPart } from './glb.ts';
import { blockGeometry } from './racks.ts';
import { RACK_FLUE, rnd, type WorldPlan } from './plan.ts';

export type PropKey = 'column' | 'light_panel' | 'dock_gate' | 'pack_table' | 'conveyor' | 'guard_rail';

interface Placement {
  m: Matrix4;
  /** Roof fade centre for lights; zero otherwise. */
  g?: Vector3;
}

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const e = new Euler();

function place(x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
  q.setFromEuler(e.set(0, yaw, 0));
  return new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
}

type BoxItem = { x: number; y: number; z: number; sx: number; sy: number; sz: number; c: string | number; yaw?: number };

export class Props {
  readonly group = new Group();
  readonly placements: Record<PropKey, Placement[]>;
  readonly glb: Partial<Record<PropKey, GlbInstances>> = {};
  private boxes: InstancedMesh;
  private glow: InstancedMesh;
  private standIns: InstancedMesh;
  private cartons: InstancedMesh;
  private cartonLoad: InstancedBufferAttribute;
  private cartonX: Float32Array;
  private conv: { x0: number; x1: number; z: number; y: number } | null;
  private mats: Material[] = [];
  private lightStandIn: [number, number] = [0, 0];

  constructor(
    plan: WorldPlan,
    envMap: Texture | null,
    private cut: CutUniforms,
    loadMat: MeshStandardMaterial,
  ) {
    this.group.name = 'props';
    const p = plan;
    const hx = p.sizeX / 2;
    const hz = p.sizeZ / 2;
    const P: Record<PropKey, Placement[]> = { column: [], light_panel: [], dock_gate: [], pack_table: [], conveyor: [], guard_rail: [] };
    const box: BoxItem[] = [];
    const glow: BoxItem[] = [];
    const stand: BoxItem[] = [];

    // ── Interior columns in the rack flues (SimReady column, slimmed to fit the 0.3 m flue) ──
    for (const c of p.columns) {
      P.column.push({ m: place(c.x, 0, c.z, 0, (RACK_FLUE - 0.02) / 0.737, p.trussY0 / 8.5, 0.62 / 0.737) });
      stand.push({ x: c.x, y: 0, z: c.z, sx: RACK_FLUE - 0.02, sy: p.trussY0, sz: 0.62, c: '#b8bcc2' });
    }

    // ── LED panels: a grid over the aisles, between the trusses, just above the rack tops ──
    const lightGlow0 = glow.length;
    for (const l of p.lights) {
      P.light_panel.push({ m: place(l.x, l.y, l.z, Math.PI / 2, 0.42, 1.2, 0.36), g: new Vector3(l.x, l.y, l.z) });
      glow.push({ x: l.x, y: l.y, z: l.z, sx: 0.5, sy: 0.08, sz: 2.4, c: '#ffffff' });
    }

    // ── Docks: SimReady safety gate at the inner edge of each door well ──
    for (const d of p.doors) {
      P.dock_gate.push({ m: place(d.x, 0, -hz + CELL_M - 0.1, 0, d.width / 3.16, 1, 1) });
      stand.push({ x: d.x, y: 0.95, z: -hz + CELL_M - 0.1, sx: d.width - 0.2, sy: 0.06, sz: 0.06, c: '#e2b33a' });
      // Door signal lights: green when a trailer is docked, red otherwise.
      glow.push({ x: d.x + d.width / 2 + 0.45, y: 2.6, z: -hz + 0.06, sx: 0.14, sy: 0.14, sz: 0.06, c: d.open > 0 ? '#36e07a' : '#ff3b30' });
      box.push({ x: d.x + d.width / 2 + 0.45, y: 2.45, z: -hz + 0.05, sx: 0.22, sy: 0.45, sz: 0.06, c: '#1d2024' });
    }

    // ── Pack stations: SimReady table, a monitor, a carton stock pile, a tape stand ──
    for (const s of p.packStations) {
      P.pack_table.push({ m: place(s.x, 0, s.z + 0.05) });
      stand.push({ x: s.x, y: 0, z: s.z + 0.05, sx: 1.87, sy: 0.95, sz: 1.2, c: '#e9ecef' });
      box.push({ x: s.x + 0.55, y: 0.99, z: s.z + 0.35, sx: 0.05, sy: 0.38, sz: 0.05, c: '#2b2f35' });
      box.push({ x: s.x + 0.55, y: 1.3, z: s.z + 0.33, sx: 0.5, sy: 0.32, sz: 0.04, c: '#16191d' });
      glow.push({ x: s.x + 0.55, y: 1.32, z: s.z + 0.31, sx: 0.44, sy: 0.27, sz: 0.01, c: '#5fb8ff' });
      box.push({ x: s.x - 0.55, y: 0.99, z: s.z + 0.25, sx: 0.32, sy: 0.12, sz: 0.24, c: '#d9d3c7' });
      // Flat-packed cartons and a few built boxes beside the table (in the blocked cell between stations).
      box.push({ x: s.x - 1.35, y: 0, z: s.z + 0.1, sx: 0.6, sy: 0.55, sz: 0.8, c: '#b88c5c' });
      box.push({ x: s.x + 1.32, y: 0, z: s.z + 0.15, sx: 0.5, sy: 0.9, sz: 0.5, c: '#3a6ea5' });
    }

    // ── Chargers: a post against the wall side with a glow strip (green = free) ──
    for (const c of p.chargers) {
      const zEdge = c.z + c.wallSide * (CELL_M / 2 - 0.2);
      const w = c.forklift ? 0.75 : 0.5;
      box.push({ x: c.x, y: 0, z: zEdge, sx: w, sy: c.forklift ? 1.6 : 1.15, sz: 0.3, c: '#2c3239' });
      box.push({ x: c.x, y: 0.12, z: zEdge - c.wallSide * 0.2, sx: w * 0.7, sy: 0.06, sz: 0.14, c: '#8a929c' });
      glow.push({ x: c.x, y: c.forklift ? 1.3 : 0.86, z: zEdge - c.wallSide * 0.155, sx: w * 0.62, sy: 0.07, sz: 0.02, c: '#2ee88a' });
    }

    // ── Conveyor: SimReady roller sections, guard frames, the riding cartons, electrical cabinets at the west end ──
    this.conv = null;
    if (p.conveyor) {
      const c = p.conveyor;
      // Sections stretched to about 3 m (the 2 m model has close rollers; at 3 m it still reads as a roller bed).
      const n = Math.max(1, Math.round((c.x1 - c.x0) / 3));
      const len = (c.x1 - c.x0) / n;
      for (let i = 0; i < n; i++) {
        const x = c.x0 + len * (i + 0.5);
        P.conveyor.push({ m: place(x, 0, c.z, Math.PI / 2, 1, 1, len / 2) });
        stand.push({ x, y: 0.55, z: c.z, sx: len - 0.02, sy: 0.35, sz: 1.1, c: '#2f63b5' });
      }
      // Yellow guard frames on the station side, every 2 sections (An Xuan style).
      const zg = c.z - 0.95;
      for (let x = c.x0 + 0.2; x <= c.x1 - 0.1; x += 4) {
        box.push({ x, y: 0, z: zg, sx: 0.08, sy: 1.45, sz: 0.08, c: '#f2c230' });
        box.push({ x, y: 0, z: c.z + 0.95, sx: 0.08, sy: 1.45, sz: 0.08, c: '#f2c230' });
        box.push({ x, y: 1.38, z: c.z, sx: 0.07, sy: 0.07, sz: 1.9, c: '#f2c230' });
      }
      box.push({ x: (c.x0 + c.x1) / 2, y: 1.38, z: zg, sx: c.x1 - c.x0 - 0.2, sy: 0.07, sz: 0.07, c: '#f2c230' });
      box.push({ x: (c.x0 + c.x1) / 2, y: 0.5, z: zg, sx: c.x1 - c.x0 - 0.2, sy: 0.06, sz: 0.06, c: '#f2c230' });
      this.conv = { ...c, y: 1.03 };
      // West of the conveyor: electrical cabinets and a battery rack behind the chargers.
      for (let x = -hx + 1.2; x < c.x0 - 0.8; x += 1.4) {
        box.push({ x, y: 0, z: hz - 0.55, sx: 1.2, sy: 2.1, sz: 0.6, c: rnd(Math.round(x * 10)) < 0.5 ? '#9aa3ad' : '#8b949e' });
        glow.push({ x: x + 0.35, y: 1.75, z: hz - 0.86, sx: 0.08, sy: 0.08, sz: 0.02, c: '#2ee88a' });
      }
    }

    // ── Rack ends: SimReady guard rails across every run end, sized to the rack (pairs share one) ──
    const seen = new Set<string>();
    for (const r of p.runs) {
      const partner = p.runs.find((o) => o !== r && o.y0 === r.y0 && Math.abs(o.col - r.col) === 1);
      const x0 = partner ? Math.min(r.x0, partner.x0) : r.x0;
      const x1 = partner ? Math.max(r.x1, partner.x1) : r.x1;
      const key = `${x0.toFixed(2)}:${r.y0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const w = x1 - x0 + 0.1;
      for (const [z, yaw] of [
        [r.z0 - 0.16, Math.PI],
        [r.z1 + 0.16, 0],
      ] as const) {
        P.guard_rail.push({ m: place((x0 + x1) / 2, 0, z, yaw, w / 2.79, 1, 1) });
        stand.push({ x: (x0 + x1) / 2, y: 0.2, z, sx: w, sy: 0.6, sz: 0.2, c: '#e8a35a' });
      }
    }
    this.placements = P;

    // ── Instanced boxes ──
    const unit = new BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const boxMat = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25, envMap, envMapIntensity: 0.7 });
    boxMat.name = 'props';
    const glowMat = new MeshBasicMaterial({ color: new Color(2.4, 2.4, 2.4) });
    glowMat.name = 'glow';
    const standMat = new MeshStandardMaterial({ roughness: 0.6, metalness: 0.2, envMap, envMapIntensity: 0.6 });
    standMat.name = 'stand-ins';
    this.mats.push(boxMat, glowMat, standMat);
    this.boxes = instancedBoxes(unit, boxMat, box, 'props');
    this.glow = instancedBoxes(unit.clone(), glowMat, glow, 'glow');
    this.standIns = instancedBoxes(unit.clone(), standMat, stand, 'stand-ins');
    this.lightStandIn = [lightGlow0, P.light_panel.length];
    this.group.add(this.boxes, this.glow, this.standIns);

    // ── Cartons riding the conveyor (block material: kind 2 = cartons, no pallet) ──
    const nCartons = this.conv ? Math.floor((this.conv.x1 - this.conv.x0) / 2.6) : 0;
    const cg = blockGeometry();
    this.cartonLoad = new InstancedBufferAttribute(new Float32Array(Math.max(1, nCartons) * 4), 4);
    cg.setAttribute('aLoad', this.cartonLoad);
    this.cartons = new InstancedMesh(cg, loadMat, Math.max(1, nCartons));
    this.cartons.count = nCartons;
    this.cartonX = new Float32Array(nCartons);
    for (let i = 0; i < nCartons; i++) {
      this.cartonX[i] = this.conv!.x0 + ((i + rnd(i, 3) * 0.6) / nCartons) * (this.conv!.x1 - this.conv!.x0);
      this.cartonLoad.setXYZW(i, 2, rnd(i, 8) * 97, 0.32 + rnd(i, 4) * 0.12, 0);
    }
    this.cartons.frustumCulled = false;
    this.cartons.name = 'conveyor-cartons';
    this.group.add(this.cartons);
    this.update(0);
  }

  /** Install a SimReady prop (or swap its LOD). */
  setGlb(key: PropKey, parts: GlbPart[]) {
    const pl = this.placements[key];
    if (!pl.length) return;
    let inst = this.glb[key];
    if (!inst) {
      const extras: ExtraAttr[] = [];
      let patch: ((m: Material, part: GlbPart) => void) | undefined;
      if (key === 'light_panel') {
        const cut = new Float32Array(pl.length * 4);
        const grp = new Float32Array(pl.length * 3);
        pl.forEach((x, i) => {
          cut.set([0, 0, 0, 3], i * 4);
          grp.set([x.g!.x, x.g!.y, x.g!.z], i * 3);
        });
        extras.push({ name: 'aCut', size: 4, data: cut }, { name: 'aGroup', size: 3, data: grp });
        patch = (m) => {
          const sm = m as MeshStandardMaterial;
          if (sm.emissive && sm.emissive.getHex() !== 0) {
            sm.emissive.set('#fff8ee');
            sm.emissiveIntensity = 4;
            sm.toneMapped = true;
          } else {
            sm.color.multiplyScalar(0.85);
            // A soft glow on the housing too, so the far rows still read as lights from the overview (above).
            sm.emissive.set('#ffffff');
            sm.emissiveIntensity = 0.35;
          }
          patchCutaway(m, this.cut, { instanced: true });
        };
      } else if (key === 'pack_table') {
        // White work surface on a blue steel frame (the SimReady table bakes both into one painted material).
        patch = (m, part) => {
          const sm = m as MeshStandardMaterial;
          if (sm.metalness > 0.5) {
            sm.color.set('#2f66b3');
            sm.metalness = 0.35;
            sm.roughness = 0.45;
            return;
          }
          const pos = part.geometry.getAttribute('position');
          const col = part.geometry.getAttribute('color');
          if (!col) return;
          const top = new Color('#eceae5');
          const frame = new Color('#2c62b0');
          for (let i = 0; i < pos.count; i++) {
            const c = pos.getY(i) > 0.92 ? top : frame;
            col.setXYZ(i, c.r, c.g, c.b);
          }
          col.needsUpdate = true;
        };
      } else if (key === 'guard_rail') {
        patch = (m) => {
          const sm = m as MeshStandardMaterial;
          sm.color.set('#ffd23a');
        };
      } else if (key === 'column') {
        patch = (m) => {
          const sm = m as MeshStandardMaterial;
          sm.color.multiplyScalar(0.92);
        };
      }
      inst = new GlbInstances(key, pl.length, extras, patch);
      pl.forEach((x, i) => inst!.setMatrix(i, x.m));
      inst.setCount(pl.length);
      this.glb[key] = inst;
    }
    inst.setParts(parts, this.group);
    this.hideStandIns(key);
  }

  private hideStandIns(key: PropKey) {
    if (key === 'light_panel') {
      const [a, n] = this.lightStandIn;
      const arr = this.glow.instanceMatrix.array as Float32Array;
      arr.fill(0, a * 16, (a + n) * 16);
      this.glow.instanceMatrix.needsUpdate = true;
    }
    const done = (Object.keys(this.placements) as PropKey[]).filter((k) => k !== 'light_panel' && this.placements[k].length).every((k) => this.glb[k]);
    this.standIns.visible = !done;
  }

  /** Keep the first-view stand-ins for props that won't load at this tier. */
  keepStandIns() {
    this.standIns.visible = true;
  }

  private um = new Matrix4();
  private up = new Vector3();
  private us = new Vector3();

  update(nowMs: number) {
    if (!this.conv || !this.cartons.count) return;
    const c = this.conv;
    const L = c.x1 - c.x0;
    const t = nowMs / 1000;
    for (let i = 0; i < this.cartons.count; i++) {
      const x = c.x0 + ((((this.cartonX[i] - c.x0 + t * 0.6) % L) + L) % L);
      const s = 0.38 + rnd(i, 4) * 0.2;
      q.setFromAxisAngle(UP, (rnd(i, 5) - 0.5) * 0.3);
      this.up.set(x, c.y, c.z + (rnd(i, 6) - 0.5) * 0.25);
      this.us.set(s, this.cartonLoad.getZ(i), s * 0.85);
      this.cartons.setMatrixAt(i, this.um.compose(this.up, q, this.us));
    }
    this.cartons.instanceMatrix.needsUpdate = true;
  }

  stats() {
    const out: Record<string, number> = {};
    for (const k of Object.keys(this.placements) as PropKey[]) out[k] = this.placements[k].length;
    out.boxes = this.boxes.count;
    out.glow = this.glow.count;
    out.cartons = this.cartons.count;
    return out;
  }

  dispose() {
    for (const g of Object.values(this.glb)) g?.dispose();
    for (const mesh of [this.boxes, this.glow, this.standIns]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.cartons.geometry.dispose();
    this.cartons.dispose();
    for (const m of this.mats) m.dispose();
  }
}

function instancedBoxes(geo: BoxGeometry, mat: Material, items: BoxItem[], name: string): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, Math.max(1, items.length));
  const m = new Matrix4();
  const c = new Color();
  items.forEach((it, i) => {
    q.setFromAxisAngle(UP, it.yaw ?? 0);
    m.compose(new Vector3(it.x, it.y, it.z), q, new Vector3(it.sx, it.sy, it.sz));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(it.c));
  });
  mesh.count = items.length;
  mesh.computeBoundingSphere();
  mesh.name = name;
  return mesh;
}

/** Which file each prop uses at a tier (the low tier never fetches a high-detail file). */
export function propTier(key: PropKey, t: Tier): Tier | null {
  const low = t === 'low' || t === 'lite';
  if (key === 'dock_gate') return low ? null : t; // its low LOD lost the rail; the stand-in reads better
  if (key === 'light_panel' || key === 'guard_rail') return 'low'; // the low LOD looks the same from below / afar
  if (key === 'conveyor') return t === 'high' ? 'high' : 'low';
  return low ? 'low' : t;
}

// Pallet racking: procedural instanced frames (blue uprights and bracing, orange beams) and the loads.
//
// Loads have two looks, chosen per pallet every time the camera moves:
// - near (in view, closest first, capped per tier): the SimReady composites `pallet_loaded` / `pallet_wrapped`;
// - everything else: one textured block per pallet (10 triangles; the carton grid and pallet side come from a small
//   painted atlas and are laid out in metres in the shader, so heights can vary without stretching).
// Partial stacks (two layers, a few loose cartons on top) always use blocks. Each rack cell keeps the list of its slots
// (`plan.faceSlots`), so Phase 2 can empty picked faces with `setFaceFill`.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type Camera,
  type Texture,
} from 'three';
import type { Tier } from '../../host/index.ts';
import { GlbInstances, type GlbPart } from './glb.ts';
import { BEAM_H, CARTON_LAYER, PALLET_D, PALLET_H, PALLET_W, rnd, UPRIGHT_W, type Slot, type WorldPlan } from './plan.ts';
import { cartonAtlas } from './textures.ts';

const UPRIGHT = new Color('#1f5faf');
const BRACE = new Color('#2a6cc0');
const BEAM = new Color('#e2621b');

/** Unit box with its base at y = 0 and no bottom face (10 triangles). */
export function blockGeometry(): BufferGeometry {
  const g = new BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  // BoxGeometry groups: +x, -x, +y, -y, +z, -z (6 indices each pair of tris). Drop -y (bottom).
  const idx = g.index!.array as ArrayLike<number>;
  const keep: number[] = [];
  for (let f = 0; f < 6; f++) if (f !== 3) for (let i = 0; i < 6; i++) keep.push(idx[f * 6 + i]);
  g.setIndex(keep);
  g.clearGroups();
  return g;
}

/** Triangles one near SimReady pallet adds (composite ~1.2-1.5k; its hidden far block still draws). */
export const NEAR_PALLET_TRIS = 1400;

export interface NearCaps {
  /** How many pallets may use the SimReady composites at once. */
  pallets: number;
  /** Max distance from a camera, metres. */
  radius: number;
}

export function nearCaps(t: Tier): NearCaps {
  if (t === 'high') return { pallets: 170, radius: 36 };
  if (t === 'medium') return { pallets: 130, radius: 32 };
  if (t === 'low') return { pallets: 48, radius: 22 };
  return { pallets: 0, radius: 0 };
}

export class Racks {
  readonly group = new Group();
  readonly frames: InstancedMesh;
  readonly blocks: InstancedMesh;
  readonly full: GlbInstances;
  readonly wrap: GlbInstances;
  private atlas: Texture;
  readonly blockMat: MeshStandardMaterial;
  private frameMat: MeshStandardMaterial;
  /** Per slot: block instance index (or -1), its loose top-layer block (or -1) and the slot's pallet matrix. */
  private slotBlock: Int32Array;
  private slotTop: Int32Array;
  /** Slots that may use the SimReady composites (full or wrapped stacks). */
  private eligible: Int32Array;
  private slotMatrix: Float32Array;
  private blockMatrix: Float32Array;
  private near = new Set<number>();
  private caps: NearCaps;
  private tier: Tier;
  /** Max near pallets the world's triangle budget leaves room for (set by the layer once the props are in). */
  private budgetPallets = Infinity;
  private glbReady = false;
  private lastCams: { p: Vector3; d: Vector3 }[] = [];
  private lastRebuild = -1e9;
  private dirty = true;
  /** The composites' instance lists no longer match `near` (setFaceFill emptied a near slot, or new parts). */
  private nearStale = true;
  private loadAttr: InstancedBufferAttribute;

  constructor(
    private plan: WorldPlan,
    tier: Tier,
    envMap: Texture | null,
    /** Extra full pallets outside the racks (inside open trailers). */
    extra: { x: number; y: number; z: number }[] = [],
  ) {
    this.group.name = 'racks';
    this.tier = tier;
    this.caps = nearCaps(tier);
    const p = plan;

    // ── Frames: uprights, bracing and beams in one InstancedMesh with instance colours ──
    type Part = { p: Vector3; s: Vector3; q?: Quaternion; c: Color };
    const parts: Part[] = [];
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
    const rackH = p.rackH;
    const qz = (a: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a);
    for (const r of p.runs) {
      const xf = r.x0 + UPRIGHT_W / 2;
      const xb = r.x1 - UPRIGHT_W / 2;
      const depth = xb - xf;
      r.frames.forEach((zf, k) => {
        const z = k === 0 ? zf + 0.045 : k === r.frames.length - 1 ? zf - 0.045 : zf;
        for (const x of [xf, xb]) parts.push({ p: v(x, 0, z), s: v(UPRIGHT_W, rackH, 0.075), c: UPRIGHT });
        // Frame bracing: bottom tie, zig-zag diagonals, top tie.
        parts.push({ p: v((xf + xb) / 2, 0.12, z), s: v(depth, 0.045, 0.035), c: BRACE });
        parts.push({ p: v((xf + xb) / 2, rackH - 0.12, z), s: v(depth, 0.045, 0.035), c: BRACE });
        const step = 1.6;
        for (let y = 0.15, i = 0; y + step < rackH - 0.1; y += step, i++) {
          const len = Math.hypot(depth, step);
          const a = Math.atan2(step, depth) * (i % 2 ? -1 : 1);
          // Unit box base is at y=0: rotate a box centred on the diagonal's midpoint instead (shift half its height).
          parts.push({ p: v((xf + xb) / 2, y + step / 2 - 0.0175, z), s: v(len, 0.035, 0.03), q: qz(a), c: BRACE });
        }
      });
      // Beams: one continuous member per level and side (it runs through the uprights, so it reads as one beam per
      // bay at a tenth of the triangles).
      for (let l = 1; l < p.levels; l++) {
        const y = l * p.levelH - BEAM_H;
        for (const x of [r.x0 + 0.03, r.x1 - 0.03]) parts.push({ p: v(x, y, (r.z0 + r.z1) / 2), s: v(0.055, BEAM_H, r.z1 - r.z0 - 0.06), c: BEAM });
      }
    }
    const unit = blockGeometry();
    this.frameMat = new MeshStandardMaterial({ roughness: 0.42, metalness: 0.45, envMap, envMapIntensity: 0.9 });
    this.frameMat.name = 'rack-frames';
    this.frames = new InstancedMesh(unit, this.frameMat, parts.length);
    const m = new Matrix4();
    const q0 = new Quaternion();
    parts.forEach((pt, i) => {
      this.frames.setMatrixAt(i, m.compose(pt.p, pt.q ?? q0, pt.s));
      this.frames.setColorAt(i, pt.c);
    });
    this.frames.computeBoundingSphere();
    this.frames.name = 'rack-frames';
    this.group.add(this.frames);

    // ── Far-field blocks: one per stocked slot + one per partial top layer ──
    const slots = p.slots;
    this.slotBlock = new Int32Array(slots.length).fill(-1);
    this.slotTop = new Int32Array(slots.length).fill(-1);
    this.eligible = Int32Array.from(slots.filter((s) => s.kind === 'full' || s.kind === 'wrap').map((s) => s.i));
    this.slotMatrix = new Float32Array(slots.length * 16);
    const blocks: { m: Matrix4; load: [number, number, number, number] }[] = [];
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (const s of slots) {
      q.setFromAxisAngle(up, s.yaw);
      m.compose(v(s.x, s.y, s.z), q, v(1, 1, 1));
      m.toArray(this.slotMatrix, s.i * 16);
    }
    const capacity = slots.length * 2 + extra.length + 8;
    this.blockMatrix = new Float32Array(capacity * 16);
    const loadData = new Float32Array(capacity * 4);
    this.loadAttr = new InstancedBufferAttribute(loadData, 4);
    const pushBlock = (mm: Matrix4, load: [number, number, number, number]) => {
      blocks.push({ m: mm.clone(), load });
      return blocks.length - 1;
    };
    for (const s of slots) {
      if (!s.kind) continue;
      const h = s.kind === 'wrap' ? 1.222 : PALLET_H + s.layers * CARTON_LAYER;
      q.setFromAxisAngle(up, s.yaw);
      this.slotBlock[s.i] = pushBlock(m.compose(v(s.x, s.y, s.z), q, v(PALLET_D, h, PALLET_W)), [s.kind === 'wrap' ? 1 : 0, rnd(s.i, 1) * 97, CARTON_LAYER, 0]);
      if (s.topCartons > 0) {
        const [nx, nz] = [
          [1, 1],
          [2, 1],
          [3, 1],
          [2, 2],
          [2, 2],
        ][Math.min(4, s.topCartons - 1)];
        const sx = nx * 0.4;
        const sz = nz * 0.4;
        // Picked from the aisle side, so what is left sits at the back of the pallet.
        const back = rnd(s.i, 5) < 0.5 ? 1 : -1;
        const ox = back * (PALLET_D - sx) * 0.5;
        const oz = (rnd(s.i, 6) < 0.5 ? -1 : 1) * (PALLET_W - sz) * 0.5;
        this.slotTop[s.i] = pushBlock(m.compose(v(s.x + ox, s.y + h, s.z + oz), q, v(sx, CARTON_LAYER, sz)), [2, rnd(s.i, 2) * 97, CARTON_LAYER, 0]);
      }
    }
    extra.forEach((x, i) => {
      const h = PALLET_H + 3 * CARTON_LAYER;
      pushBlock(m.compose(v(x.x, x.y, x.z), q.identity(), v(PALLET_D, h, PALLET_W)), [rnd(i, 4) < 0.3 ? 1 : 0, rnd(i, 9) * 97, CARTON_LAYER, 0]);
    });
    this.atlas = cartonAtlas();
    this.blockMat = blockMaterial(this.atlas, envMap);
    const bg = blockGeometry();
    bg.setAttribute('aLoad', this.loadAttr);
    this.blocks = new InstancedMesh(bg, this.blockMat, capacity);
    blocks.forEach((b, i) => {
      b.m.toArray(this.blockMatrix, i * 16);
      loadData.set(b.load, i * 4);
    });
    (this.blocks.instanceMatrix.array as Float32Array).set(this.blockMatrix);
    this.blocks.count = blocks.length;
    this.blocks.frustumCulled = false;
    this.blocks.name = 'rack-loads';
    this.group.add(this.blocks);

    // ── Near-field SimReady loads (filled in when the GLBs arrive) ──
    this.full = new GlbInstances('rack-loads-near', Math.max(1, nearCaps('high').pallets));
    this.wrap = new GlbInstances('rack-loads-near-wrap', Math.max(1, nearCaps('high').pallets));
  }

  /** Install the composites (call again after a tier change with the other LOD). */
  setGlb(full: GlbPart[] | null, wrap: GlbPart[] | null) {
    // null keeps what that composite already has (its file did not change).
    if (full) this.full.setParts(full, this.group);
    if (wrap) this.wrap.setParts(wrap, this.group);
    this.glbReady = this.full.meshes.length > 0 && this.wrap.meshes.length > 0;
    this.dirty = true;
    this.nearStale = true;
  }

  setTier(t: Tier) {
    this.tier = t;
    this.caps = { ...nearCaps(t), pallets: Math.min(nearCaps(t).pallets, this.budgetPallets) };
    this.dirty = true;
  }

  /** Cap the near SimReady pallets so the whole world stays inside `trianglesLeft`. */
  setTriangleBudget(trianglesLeft: number) {
    this.budgetPallets = Math.max(0, Math.floor(trianglesLeft / NEAR_PALLET_TRIS));
    this.setTier(this.tier);
  }

  get nearCap() {
    return this.caps.pallets;
  }

  /**
   * Phase 2 hook: set how full a rack face (cell) is, 0..1. Re-rolls which of its slots hold pallets, deterministically.
   * Returns the number of stocked slots on the face.
   */
  setFaceFill(cell: number, fill: number): number {
    const list = this.plan.faceSlots.get(cell);
    if (!list) return 0;
    let n = 0;
    for (const i of list) {
      const s = this.plan.slots[i];
      const on = rnd(i, 77) < fill;
      const b = this.slotBlock[i];
      if (b < 0) continue; // slot was empty when built; only built pallets can come and go
      if (on) n++;
      this.setBlockVisible(b, on && !this.near.has(i));
      // The loose cartons on top go with their pallet.
      if (this.slotTop[i] >= 0) this.setBlockVisible(this.slotTop[i], on);
      if (!on && this.near.has(i)) {
        this.near.delete(i);
        this.nearStale = true;
      }
      (s as Slot & { hidden?: boolean }).hidden = !on;
    }
    this.flushBlocks();
    this.dirty = true;
    return n;
  }

  /** Test/debug: the block instance indices of a face's pallets and loose top layers. */
  faceBlocks(cell: number): number[] {
    const out: number[] = [];
    for (const i of this.plan.faceSlots.get(cell) ?? []) {
      if (this.slotBlock[i] >= 0) out.push(this.slotBlock[i]);
      if (this.slotTop[i] >= 0) out.push(this.slotTop[i]);
    }
    return out;
  }

  /** Changed block instances since the last upload (only those ranges go to the GPU). */
  private changed: number[] = [];

  private setBlockVisible(b: number, on: boolean) {
    const arr = this.blocks.instanceMatrix.array as Float32Array;
    if (on) arr.set(this.blockMatrix.subarray(b * 16, b * 16 + 16), b * 16);
    else arr.fill(0, b * 16, b * 16 + 16);
    this.changed.push(b);
  }

  private flushBlocks() {
    if (!this.changed.length) return;
    const im = this.blocks.instanceMatrix;
    // Coalesce neighbouring instances into one range each.
    this.changed.sort((a, b) => a - b);
    let a = this.changed[0];
    let prev = a;
    for (let k = 1; k <= this.changed.length; k++) {
      const c = this.changed[k];
      if (c === prev || c === prev + 1) {
        prev = c;
        continue;
      }
      im.addUpdateRange(a * 16, (prev - a + 1) * 16);
      a = prev = c;
    }
    this.changed.length = 0;
    im.needsUpdate = true;
  }

  private pm = new Matrix4();
  private sphere = new Sphere(new Vector3(), 0.95);
  private dirs: Vector3[] = [];
  private frs: Frustum[] = [];
  private cand: { i: number; d: number }[] = [];
  private next = new Set<number>();

  /** Re-pick the near pallets when a camera has moved (throttled). Uploads only the instances that changed. */
  update(cams: readonly Camera[], now: number) {
    if (!this.glbReady) return;
    while (this.dirs.length < cams.length) this.dirs.push(new Vector3());
    for (let k = 0; k < cams.length; k++) cams[k].getWorldDirection(this.dirs[k]);
    let moved = this.dirty || cams.length !== this.lastCams.length;
    if (!moved)
      for (let k = 0; k < cams.length; k++) {
        const l = this.lastCams[k];
        if (l.p.distanceToSquared(cams[k].position) > 0.6 || l.d.dot(this.dirs[k]) < 0.996) moved = true;
      }
    if (!moved || now - this.lastRebuild < 110) return;
    this.lastRebuild = now;
    this.dirty = false;
    while (this.lastCams.length < cams.length) this.lastCams.push({ p: new Vector3(), d: new Vector3() });
    this.lastCams.length = cams.length;
    for (let k = 0; k < cams.length; k++) {
      this.lastCams[k].p.copy(cams[k].position);
      this.lastCams[k].d.copy(this.dirs[k]);
    }

    const caps = this.caps;
    const slots = this.plan.slots;
    const cand = this.cand;
    cand.length = 0;
    if (caps.pallets > 0) {
      while (this.frs.length < cams.length) this.frs.push(new Frustum());
      for (let k = 0; k < cams.length; k++) {
        cams[k].updateMatrixWorld();
        this.frs[k].setFromProjectionMatrix(this.pm.multiplyMatrices(cams[k].projectionMatrix, cams[k].matrixWorldInverse));
      }
      const r2 = caps.radius * caps.radius;
      for (const i of this.eligible) {
        const s = slots[i];
        if ((s as Slot & { hidden?: boolean }).hidden) continue;
        this.sphere.center.set(s.x, s.y + 0.6, s.z);
        let best = Infinity;
        for (let k = 0; k < cams.length; k++) {
          const d2 = cams[k].position.distanceToSquared(this.sphere.center);
          if (d2 > r2 || d2 >= best) continue;
          if (!this.frs[k].intersectsSphere(this.sphere)) continue;
          best = d2;
        }
        if (best < Infinity) cand.push({ i, d: best });
      }
      cand.sort((a, b) => a.d - b.d);
      if (cand.length > caps.pallets) cand.length = caps.pallets;
    }
    const next = this.next;
    next.clear();
    for (const c of cand) next.add(c.i);
    // Same pallets as before: nothing to upload.
    let same = next.size === this.near.size;
    if (same) for (const i of next) if (!this.near.has(i)) same = false;
    // Unchanged set and nothing removed behind its back: nothing to upload.
    if (same && !this.nearStale) return;
    this.nearStale = false;
    for (const i of this.near) if (!next.has(i)) this.setBlockVisible(this.slotBlock[i], true);
    for (const i of next) if (!this.near.has(i)) this.setBlockVisible(this.slotBlock[i], false);
    this.flushBlocks();
    this.next = this.near;
    this.near = next;
    let nf = 0;
    let nw = 0;
    for (const i of next) {
      if (slots[i].kind === 'wrap') this.wrap.copyMatrix(nw++, this.slotMatrix, i);
      else this.full.copyMatrix(nf++, this.slotMatrix, i);
    }
    this.full.setCount(nf);
    this.wrap.setCount(nw);
    this.full.flush();
    this.wrap.flush();
  }

  stats() {
    let stocked = 0;
    for (const s of this.plan.slots) if (s.kind && !(s as Slot & { hidden?: boolean }).hidden) stocked++;
    return {
      slots: this.plan.slots.length,
      stocked,
      fillPct: Math.round((stocked / Math.max(1, this.plan.slots.length)) * 100),
      faces: this.plan.faceSlots.size,
      frameParts: this.frames.count,
      blocks: this.blocks.count,
      nearPallets: this.near.size,
      nearCap: this.caps.pallets,
      nearFull: this.full.size,
      nearWrap: this.wrap.size,
    };
  }

  dispose() {
    this.frames.geometry.dispose();
    this.frameMat.dispose();
    this.frames.dispose();
    this.blocks.geometry.dispose();
    this.blockMat.dispose();
    this.blocks.dispose();
    this.atlas.dispose();
    this.full.dispose();
    this.wrap.dispose();
  }
}

/** The far-field load material: carton grid and pallet side laid out in metres from the instance scale. */
function blockMaterial(atlas: Texture, envMap: Texture | null): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, envMap, envMapIntensity: 0.6 });
  mat.name = 'rack-loads';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAtlas = { value: atlas };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aLoad;
varying vec3 vBlk;
varying float vBlkH;
varying vec4 vLoad;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec3 lm = (position + vec3(0.5, 0.0, 0.5)) * sc;
  vec3 an = abs(normal);
  if (an.y > 0.5) vBlk = vec3(lm.x, lm.z, 1.0);
  else if (an.x > 0.5) vBlk = vec3(lm.z, lm.y, 0.0);
  else vBlk = vec3(lm.x, lm.y, 0.0);
  vBlkH = lm.y;
  vLoad = aLoad;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uAtlas;
varying vec3 vBlk;
varying float vBlkH;
varying vec4 vLoad;
float fpHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fpWrap = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
  float kind = vLoad.x;
  float pal = kind < 1.5 ? ${PALLET_H.toFixed(3)} : 0.0;
  vec3 col;
  if (vBlk.z < 0.5 && vBlkH < pal) {
    vec2 c = vec2(vBlk.x / 0.4, vBlkH / pal);
    vec2 a = vec2(fract(c.x) * 0.25, 0.875 + (1.0 - c.y) * 0.125);
    col = textureGrad(uAtlas, vec2(a.x, 1.0 - a.y), dFdx(c * vec2(0.25, 0.125)), dFdy(c * vec2(0.25, 0.125))).rgb;
  } else {
    vec2 c = vBlk.z > 0.5 ? vBlk.xy / 0.4 : vec2(vBlk.x / 0.4, (vBlkH - pal) / vLoad.z);
    vec2 cell = floor(c);
    float h = fpHash(cell + vLoad.y);
    float variant = floor(h * 4.0);
    vec2 f = fract(c);
    vec2 a = vec2((mod(variant, 2.0) + f.x) * 0.5, (floor(variant / 2.0) + (1.0 - f.y)) * 0.4375);
    col = textureGrad(uAtlas, vec2(a.x, 1.0 - a.y), dFdx(c * vec2(0.5, 0.4375)), dFdy(c * vec2(0.5, 0.4375))).rgb;
    col *= mix(0.86, 1.08, fpHash(cell + vLoad.y + 17.0));
    if (vBlk.z > 0.5) col *= 1.06;
    if (kind > 0.5 && kind < 1.5) {
      fpWrap = 1.0;
      col = mix(col, vec3(0.7, 0.72, 0.76), 0.22);
    }
  }
  diffuseColor.rgb *= col;
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.5, fpWrap);`,
      );
  };
  return mat;
}

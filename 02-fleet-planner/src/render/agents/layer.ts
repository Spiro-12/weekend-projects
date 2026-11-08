// The agent layer (Track E, PROTOCOL §9): every agent interpolated from (cell, to, moveStart, moveEnd) at the
// fractional render tick, drawn as one instanced rig mesh per type (cart robots, autonomous forklifts, driven
// forklifts with a seated driver, humanoids, pickers), plus one decal draw (glow discs, safety spots, rings,
// arrows), one ribbon draw, at most one skinned hero worker and DOM labels. Works for any snapshot (FakeSim now, the
// real core later): it only reads PROTOCOL §5 fields.
import { Group, Matrix4, Quaternion, Vector3, type Camera, type InstancedMesh, type PerspectiveCamera, type Raycaster } from 'three';
import agentsData from '../../../data/agents.json';
import type { AgentState, AgentTypeId, AgentView, AgentsFile, Snapshot } from '../../contracts/types.ts';
import type { Tier } from '../../host/index.ts';
import type { AssetLoader } from '../core/assets.ts';
import { CELL_M, headingYaw } from '../core/geom.ts';
import type { AgentLayer, AgentLayerOptions } from '../core/layers.ts';
import type { RendererCore } from '../core/renderer.ts';
import { tierSettings } from '../core/tiers.ts';
import { FollowFraming, type Framing } from '../camera/follow.ts';
import { Decals } from '../fx/decals.ts';
import { Ribbons } from '../fx/ribbons.ts';
import type { Bloom } from '../fx/bloom.ts';
import { buildAmr } from '../models/amr.ts';
import { bakeAutonomousForklift, bakeDrivenForklift, bakeForkliftPlaceholder } from '../models/forklift.ts';
import { buildHumanoid } from '../models/humanoid.ts';
import { FLAG, type BakedModel } from '../models/parts.ts';
import { buildPicker } from '../models/people.ts';
import type { HeroWorker } from './hero.ts';
import { clock, Labels } from './labels.ts';
import { DEFAULT_LIGHT, FX, TYPE_LABEL, typeShade, VENDOR_LIGHT } from './palette.ts';
import { rayAgentBox, toScreen, type ScreenPoint } from './pick.ts';
import { RigMesh } from './rig.ts';

const TYPES: AgentTypeId[] = ['amr', 'forklift', 'driver', 'humanoid', 'picker'];
const ROBOTS = new Set<AgentTypeId>(['amr', 'forklift', 'humanoid']);
const SPECS = new Map((agentsData as AgentsFile).agents.map((s) => [s.id, s]));
const RIG: Partial<Record<AgentTypeId, { legSwing: number; armSwing: number; kneeBend: number }>> = {
  humanoid: { legSwing: 0.36, armSwing: 0.22, kneeBend: 0.6 },
  picker: { legSwing: 0.45, armSwing: 0.42, kneeBend: 0.7 },
};

interface Move {
  from: number;
  to: number;
  ms: number;
  me: number;
  /** Ticks spent turning in place before rolling (robots with turnTicks). */
  turn: number;
  yaw: number;
}

interface Motion {
  id: number;
  type: AgentTypeId;
  x: number;
  z: number;
  yaw: number;
  /** Travel direction (down the aisle), smoothed: the chase camera follows this, not a turn toward a rack face. */
  camYaw: number;
  cur: Move | null;
  prev: Move | null;
  phase: number;
  amount: number;
  /** Displayed speed, m per real second. */
  speed: number;
  lift: number;
  state: AgentState;
  stateSince: number;
  /** Real seconds (layer clock) since it last moved, for the dwell pull-out. */
  stillSince: number;
  scale: number;
  seen: number;
  fresh: boolean;
}

const smooth = (k: number) => k * k * (3 - 2 * k);
/** Low and lite use the -lo GLBs and simple people (same rule as core/assets.ts, kept here so the loader stays lazy). */
const useLow = (t: Tier) => t === 'low' || t === 'lite';
const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export class AgentLayerImpl implements AgentLayer {
  readonly group = new Group();
  private core: RendererCore;
  private width: number;
  private height: number;
  private grid: string[];
  private rackLevelM: number;
  private baseUrl: string;
  private loaderP: Promise<AssetLoader> | null = null;
  private tier: Tier;
  private rigs = {} as Record<AgentTypeId, RigMesh>;
  private models = {} as Record<AgentTypeId, { model: BakedModel; source: string }>;
  private decals: Decals;
  private ribbons: Ribbons;
  private labels: Labels;
  private hero: HeroWorker | null = null;
  private heroLoading = false;
  private framing = new FollowFraming();
  private follow: Framing | null = null;
  private followOut: Framing = { id: -1, distance: 0, height: 0, pulled: false };
  private motions = new Map<number, Motion>();
  private snap: Snapshot | null = null;
  private injected: Snapshot | null = null;
  private frame = 0;
  private lastTick = Number.NaN;
  private time = 0;
  private heroId: number | null = null;
  private bloom: Bloom | null = null;
  private bloomWanted = false;
  private disposed = false;
  private glbKey = '';
  /** GLB forklifts load only after the first useful view (they belong to the full look, not the 0.4 MB first view). */
  private glbAllowed = false;
  private dbg = { ribbons: 0, deadlockRings: 0, deadlockArrows: 0, blockedRings: 0, selectionRings: 0, waitArrows: 0, safetySpots: 0 };
  /** Deadlock label anchors (pooled; the first `anchorCount` are live) and their screen positions. */
  private labelAnchors: { text: string; sec: number; x: number; y: number; z: number }[] = [];
  private anchorCount = 0;
  private labelItems: { text: string; x: number; y: number }[] = [];
  private labelsQueued = false;
  private placeLabelsFn = () => {
    this.labelsQueued = false;
    this.placeLabels();
  };
  private hoverText = { id: -1, state: '', text: '' };
  // Per-frame scratch, reused so update() allocates nothing in steady state.
  private byId = new Map<number, AgentView>();
  private inDeadlock = new Set<number>();
  private members: number[] = [];
  private pts: number[] = [];
  private typeCount = { amr: 0, forklift: 0, driver: 0, humanoid: 0, picker: 0 } as Record<AgentTypeId, number>;
  private sp: ScreenPoint = { x: 0, y: 0 };
  private posOut = new Vector3();
  private followPos = new Vector3();
  private followOutT: { pos: Vector3; yaw: number; distance?: number; height?: number } = { pos: this.followPos, yaw: 0 };
  /** Deadlock arrows drawn this frame (x0, z0, x1, z1 per arrow), for tests. */
  private arrowSegs: number[] = [];
  private hover: { x: number; y: number; dirty: boolean; id: number | null; at: number } = { x: 0, y: 0, dirty: false, id: null, at: 0 };
  private canHover: boolean;
  private m4 = new Matrix4();
  private q = new Quaternion();
  private up = new Vector3(0, 1, 0);
  private v3 = new Vector3();
  private s3 = new Vector3();
  private onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const r = this.core.renderer.domElement.getBoundingClientRect();
    this.hover.x = e.clientX - r.left;
    this.hover.y = e.clientY - r.top;
    this.hover.dirty = true;
  };
  private onLeave = () => {
    this.hover.id = null;
    this.hover.dirty = false;
    this.labels.setHover(null);
  };

  constructor(o: AgentLayerOptions) {
    this.core = o.core;
    this.grid = o.layout.grid;
    this.width = o.layout.grid[0].length;
    this.height = o.layout.grid.length;
    this.rackLevelM = (o.layout.racks?.heightMm ?? 9000) / 1000 / Math.max(1, o.layout.racks?.levels ?? 5);
    this.baseUrl = o.baseUrl;
    this.tier = o.tier;
    this.group.name = 'agents';

    this.setModel('amr', buildAmr(), 'code', 64);
    this.setModel('humanoid', buildHumanoid(), 'code', 16);
    this.setModel('picker', buildPicker(useLow(o.tier) ? 0 : 1), 'code', 48);
    this.setModel('forklift', bakeForkliftPlaceholder(false), 'placeholder', 16);
    this.setModel('driver', bakeForkliftPlaceholder(true), 'placeholder', 16);

    this.ribbons = new Ribbons(256);
    this.group.add(this.ribbons.mesh);
    this.decals = new Decals(256, (old, next) => this.swap(old, next));
    this.group.add(this.decals.mesh);

    const canvas = this.core.renderer.domElement;
    this.labels = new Labels(canvas.parentElement ?? document.body);
    this.canHover = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (this.canHover) {
      canvas.addEventListener('pointermove', this.onMove);
      canvas.addEventListener('pointerleave', this.onLeave);
    }
    this.applyTier(o.tier);
  }

  // ───────── models ─────────

  private swap(old: InstancedMesh, next: InstancedMesh) {
    this.group.remove(old);
    this.group.add(next);
  }

  /** The shared asset loader, imported on first use so GLTFLoader stays out of the first-view bundle. */
  private assets(): Promise<AssetLoader> {
    this.loaderP ??= import('../core/assets.ts').then((m) => m.assetLoader(this.baseUrl));
    return this.loaderP;
  }

  /** The skinned hero worker module and model, loaded the first time a person is followed. */
  private loadHero() {
    if (this.heroLoading) return;
    this.heroLoading = true;
    void Promise.all([import('./hero.ts'), this.assets()])
      .then(([{ HeroWorker }, loader]) => {
        if (this.disposed) return;
        const hero = new HeroWorker(loader, () => this.tier);
        return hero.load().then(() => {
          if (this.disposed) return;
          this.hero = hero;
          this.group.add(hero.group);
        });
      })
      .catch((e) => console.warn('hero worker unavailable', e));
  }

  private setModel(type: AgentTypeId, model: BakedModel, source: string, capacity?: number) {
    const prev = this.rigs[type];
    const rig = new RigMesh(type, model, capacity ?? Math.max(16, prev?.mesh.count ?? 16), RIG[type], (a, b) => this.swap(a, b));
    if (prev) {
      this.group.remove(prev.mesh);
      prev.dispose();
    }
    this.rigs[type] = rig;
    this.models[type] = { model, source };
    this.group.add(rig.mesh);
  }

  /** (Re)load the forklift GLBs for the tier (low and lite use the -lo files). */
  private loadForklifts(tier: Tier) {
    if (!this.glbAllowed) return;
    const key = useLow(tier) ? 'lo' : 'hi';
    if (key === this.glbKey) return;
    this.glbKey = key;
    const load = (asset: string, type: AgentTypeId, bake: (s: Group) => BakedModel) =>
      this.assets()
        .then((l) => l.scene(asset, tier))
        .then((scene) => {
          if (this.disposed || this.glbKey !== key) return;
          this.setModel(type, bake(scene), `glb:${asset}${key === 'lo' ? '-lo' : ''}`);
        })
        .catch((e) => console.warn(`agent model ${asset} failed to load; keeping the simple one`, e));
    void load('stacker', 'forklift', bakeAutonomousForklift);
    void load('forklift', 'driver', bakeDrivenForklift);
  }

  setTier(t: Tier) {
    if (t === this.tier) return;
    const wasLow = useLow(this.tier);
    this.tier = t;
    if (useLow(t) !== wasLow) this.setModel('picker', buildPicker(useLow(t) ? 0 : 1), 'code');
    this.applyTier(t);
  }

  private applyTier(t: Tier) {
    this.loadForklifts(t);
    const s = tierSettings(t);
    this.bloomWanted = s.bloom;
    if (s.bloom && !this.bloom) {
      void import('../fx/bloom.ts').then(({ Bloom }) => {
        if (this.disposed || !this.bloomWanted || this.bloom) return;
        // No MSAA in the HDR target: 4x multisampled half-float at DPR 1.5 costs more than the bloom itself (spike a: high = no MSAA).
        this.bloom = new Bloom(this.core, s.bloomScale || 0.5, 0);
        this.core.setRenderPass(this.bloom.render);
      });
    } else if (!s.bloom && this.bloom) {
      this.core.setRenderPass(null);
      this.bloom.dispose();
      this.bloom = null;
    }
  }

  // ───────── geometry helpers ─────────

  private cx(cell: number) {
    return ((cell % this.width) + 0.5 - this.width / 2) * CELL_M;
  }
  private cz(cell: number) {
    return (Math.floor(cell / this.width) + 0.5 - this.height / 2) * CELL_M;
  }
  private moveYaw(from: number, to: number) {
    return Math.atan2(-(this.cz(to) - this.cz(from)), this.cx(to) - this.cx(from));
  }
  /** True when a rack is next to the cell (a pick face). */
  private atFace(cell: number) {
    return this.rackYaw(cell) !== null;
  }
  /** Yaw that faces the rack next to a cell (E and W first: aisles run along rows), or null. */
  private rackYaw(cell: number): number | null {
    const x = cell % this.width;
    const y = Math.floor(cell / this.width);
    const r = (xx: number, yy: number) => this.grid[yy]?.[xx] === '#';
    if (r(x + 1, y)) return 0;
    if (r(x - 1, y)) return Math.PI;
    if (r(x, y + 1)) return -Math.PI / 2;
    if (r(x, y - 1)) return Math.PI / 2;
    return null;
  }
  private camera(): PerspectiveCamera | null {
    return (this.core.views.find((v) => v.layers.includes(0)) ?? this.core.views[0])?.camera ?? null;
  }
  private model(type: AgentTypeId): BakedModel {
    return (this.models[type] ?? this.models.amr).model;
  }
  private ringRadius(a: AgentView, m: Motion) {
    const s = this.model(a.type).size;
    const r = a.type === 'picker' || a.type === 'humanoid' ? 0.5 : 0.5 * Math.hypot(s.length, s.width) + 0.12;
    return r * m.scale;
  }

  // ───────── per frame ─────────

  update(live: Snapshot, renderTick: number, selectedId: number | null, dtMs: number): void {
    if (!this.glbAllowed && this.core.perf.firstUsefulViewMs != null) {
      this.glbAllowed = true;
      setTimeout(() => {
        if (!this.disposed) this.loadForklifts(this.tier);
      }, 250);
    }
    const snap = this.injected ?? live;
    this.snap = snap;
    this.frame++;
    const realSec = Math.min(0.25, Math.max(0, dtMs / 1000));
    const dTick = Number.isNaN(this.lastTick) ? 0 : Math.min(4, Math.max(0, renderTick - this.lastTick));
    this.lastTick = renderTick;
    this.time += realSec;
    const eff = Math.max(dTick * 0.5, realSec);
    const cam = this.camera();
    const canvas = this.core.renderer.domElement;
    const viewH = canvas.clientHeight || 900;
    const minPx = this.canHover ? 14 : 10;
    const tanHalf = cam ? Math.tan((cam.fov * Math.PI) / 360) : 0.35;
    const high = this.tier === 'high';
    // High renders through the bloom composer in linear HDR: additive effects need more energy to look the same and
    // to cross the bloom threshold (only emissive things should).
    const fxk = high ? 1.2 : 1;
    // Rings and arrows are emissive lines: on high their cores must clear the bloom threshold (BLOOM.threshold).
    const ringk = high ? 1.6 : 1;

    // 1. Kinematics.
    for (const a of snap.agents) this.advance(a, renderTick, snap.tick, dTick, realSec, eff);
    for (const [id, m] of this.motions) if (m.seen !== this.frame) this.motions.delete(id);

    // Hero worker for a followed picker.
    const sel = selectedId !== null ? snap.agents.find((a) => a.id === selectedId) : undefined;
    const selM = sel ? this.motions.get(sel.id) : undefined;
    const wantHero = !!sel && !!selM && sel.type === 'picker';
    if (wantHero && !this.hero) this.loadHero();
    const heroShown = wantHero && !!this.hero && this.hero.update(true, selM!.x, selM!.z, selM!.yaw, selM!.speed, sel!.cargo === 'cart', dtMs);
    if (!heroShown) this.hero?.update(false, 0, 0, 0, 0, false, dtMs);
    this.heroId = heroShown ? sel!.id : null;

    // Follow framing (pull out on a long dwell).
    if (sel && selM) {
      this.follow = this.framing.framing(sel.id, sel.type, this.time - selM.stillSince, dtMs, this.followOut);
    } else this.follow = null;

    // 2. Instances, glow discs, rings.
    const tc = this.typeCount;
    for (const t of TYPES) tc[t] = 0;
    for (const a of snap.agents) tc[a.type] = (tc[a.type] ?? 0) + 1;
    for (const t of TYPES) {
      this.rigs[t].reserve(tc[t]);
      this.rigs[t].begin();
    }
    this.decals.begin();
    const d = this.dbg;
    d.blockedRings = d.deadlockRings = d.deadlockArrows = d.selectionRings = d.waitArrows = d.safetySpots = 0;
    const inDeadlock = this.inDeadlock;
    inDeadlock.clear();
    for (const dl of snap.deadlocks) for (const id of dl.ids) inDeadlock.add(id);
    const byId = this.byId;
    byId.clear();
    for (const a of snap.agents) byId.set(a.id, a);

    for (const a of snap.agents) {
      const m = this.motions.get(a.id)!;
      const model = this.model(a.type);
      const size = model.size;
      // Screen-space minimum size at overview zoom, and a "far" factor (0 close, 1 at overview distance) that makes
      // glow discs and light bands carry further so agents read against the racks.
      let s = 1;
      let far = 0;
      if (cam && a.id !== selectedId) {
        const dist = Math.hypot(cam.position.x - m.x, cam.position.y - size.height * 0.5, cam.position.z - m.z);
        const pxPerM = viewH / (2 * Math.max(0.1, dist) * tanHalf);
        s = Math.min(2.5, Math.max(1, minPx / (Math.max(size.height, size.length) * pxPerM)));
        far = Math.min(1, Math.max(0, (dist - 18) / 45));
      }
      m.scale = s;
      this.q.setFromAxisAngle(this.up, m.yaw);
      this.m4.compose(this.v3.set(m.x, 0, m.z), this.q, this.s3.set(s, s, s));
      let flags = 0;
      if (a.cargo === 'tote') flags |= FLAG.TOTE | (a.type === 'humanoid' ? FLAG.HOLD : 0);
      if (a.cargo === 'cart' && a.type === 'picker') flags |= FLAG.CART | FLAG.PUSH;
      if (a.cargo === 'pallet') flags |= FLAG.PALLET;
      if (a.id === this.heroId) flags |= FLAG.HIDE_BODY;
      let accent = VENDOR_LIGHT[a.vendor] ?? DEFAULT_LIGHT;
      let glow = (high ? 6.5 : 2.6) * (1 + far * 1.2);
      if (a.state === 'wait') glow *= 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 4.2 + a.id));
      else if (a.state === 'broken') {
        accent = 0xff3b3b;
        glow *= 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(this.time * 2.5));
      } else if (a.state === 'charge') glow *= 0.7 + 0.3 * Math.sin(this.time * 1.6 + a.id);
      this.rigs[a.type].push(a.id, this.m4, m.phase, m.amount, m.lift, flags, accent, glow);

      // Glow disc with a contact-shadow core (0.9 m for people-sized agents, the footprint for vehicles).
      const c = typeShade(a.type, a.vendor);
      const human = a.type === 'picker' || a.type === 'driver';
      const grow = s * (1 + far * 0.7);
      const dl = Math.max(0.9, size.length + 0.35) * grow;
      const dw = Math.max(0.9, size.width + 0.35) * grow;
      const gi = (human ? 0.4 : 0.55) * (0.75 + far * 1.6) * (high ? 1.15 : 1);
      this.decals.disc(m.x, m.z, 0.014, m.yaw, dl, dw, c.r, c.g, c.b, gi, 0.6 * (1 - far * 0.5));
      if (a.type === 'picker' && a.cargo === 'cart') {
        const fx = Math.cos(m.yaw);
        const fz = -Math.sin(m.yaw);
        this.decals.disc(m.x + fx * 0.85 * s, m.z + fz * 0.85 * s, 0.013, m.yaw, 1.1 * s, 0.85 * s, 0, 0, 0, 0, 0.5);
      }
      // Autonomous forklift: blue safety spot projected ahead of the forks while it drives.
      if (a.type === 'forklift' && (a.state === 'travel' || m.amount > 0.05)) {
        const fx = Math.cos(m.yaw);
        const fz = -Math.sin(m.yaw);
        const ahead = (size.length / 2 + 0.9) * s;
        const b = FX.safetySpot;
        this.decals.disc(m.x + fx * ahead, m.z + fz * ahead, 0.016, m.yaw, 1.15 * s, 0.85 * s, b.r, b.g, b.b, 1.6 * fxk, 0);
        d.safetySpots++;
      }
      // Blocked: amber ring.
      if (a.blockedTicks > 4 && !inDeadlock.has(a.id)) {
        const b = FX.blocked;
        this.decals.ring(m.x, m.z, this.ringRadius(a, m) + 0.08, 0.07, b.r, b.g, b.b, 2.2 * ringk, false);
        d.blockedRings++;
      }
    }

    // Deadlocks: pulsing red rings, red arrows along the wait-for cycle, a label per deadlock.
    this.anchorCount = 0;
    this.arrowSegs.length = 0;
    const red = FX.deadlock;
    const members = this.members;
    for (const dl of snap.deadlocks) {
      members.length = 0;
      for (const id of dl.ids) if (byId.has(id) && this.motions.has(id)) members.push(id);
      if (!members.length) continue;
      let cx = 0;
      let cz = 0;
      let top = 0;
      const pair = members.length === 2;
      for (let i = 0; i < members.length; i++) {
        const id = members[i];
        const a = byId.get(id)!;
        const m = this.motions.get(id)!;
        const r = this.ringRadius(a, m) + 0.12;
        this.decals.ring(m.x, m.z, r, 0.1, red.r, red.g, red.b, 3 * ringk, true);
        d.deadlockRings++;
        cx += m.x;
        cz += m.z;
        top = Math.max(top, this.model(a.type).size.height * m.scale);
        const nextId = members.includes(a.waitOn) ? a.waitOn : members[(i + 1) % members.length];
        if (nextId !== id) {
          const nb = byId.get(nextId)!;
          const n = this.motions.get(nextId)!;
          const rn = this.ringRadius(nb, n) + 0.12;
          // Two robots waiting on each other share one centre line: put each arrow in its own "lane" beside the
          // bodies (like traffic), so both are visible instead of hidden under the robots.
          const lane = pair ? Math.max(this.model(a.type).size.width * m.scale, this.model(nb.type).size.width * n.scale) / 2 + 0.3 : 0;
          if (this.arrowBetween(m.x, m.z, r, n.x, n.z, rn, lane, 0.42, red.r, red.g, red.b, 2.6 * ringk, true, this.arrowSegs)) d.deadlockArrows++;
        }
      }
      const sec = Math.floor(Math.max(0, (snap.tick - dl.sinceTick) * 0.5));
      let an = this.labelAnchors[this.anchorCount];
      if (!an) this.labelAnchors.push((an = { text: '', sec: -1, x: 0, y: 0, z: 0 }));
      if (an.sec !== sec) {
        an.sec = sec;
        an.text = `DEADLOCK ${clock(sec)}`;
      }
      an.x = cx / members.length;
      an.y = top + 0.6;
      an.z = cz / members.length;
      this.anchorCount++;
    }

    // Selection: a thin glowing cyan ring, and a "waiting for" arrow to the agent it waits on.
    if (sel && selM) {
      const sc = FX.select;
      const r = this.ringRadius(sel, selM) + 0.15;
      this.decals.ring(selM.x, selM.z, r, 0.06, sc.r, sc.g, sc.b, 3.2 * ringk, false);
      d.selectionRings++;
      const w = sel.waitOn >= 0 ? byId.get(sel.waitOn) : undefined;
      const wm = w ? this.motions.get(w.id) : undefined;
      if (w && wm) {
        const y = FX.waitFor;
        if (this.arrowBetween(selM.x, selM.z, r, wm.x, wm.z, this.ringRadius(w, wm) + 0.15, 0, 0.36, y.r, y.g, y.b, 2.4 * ringk, false, null)) d.waitArrows++;
      }
    }
    for (const t of TYPES) this.rigs[t].end(this.time);
    this.decals.end(this.time);

    // 3. Route ribbons.
    this.fillRibbons(snap, selectedId, high);
    this.ribbons.end(this.time, viewH);

    // 4. Hover and labels (placed after the frame renders, when the camera has moved).
    if (this.canHover && this.hover.dirty && this.time - this.hover.at > 0.06) {
      this.hover.dirty = false;
      this.hover.at = this.time;
      this.hover.id = cam ? this.pickScreen(this.hover.x, this.hover.y, cam) : null;
    }
    if (!this.labelsQueued) {
      this.labelsQueued = true;
      queueMicrotask(this.placeLabelsFn);
    }
  }

  /**
   * Arrow from ring edge to ring edge, shifted `lane` metres to its right. When the rings overlap (nose to nose) it
   * runs beside the bodies from centre to centre. `segs` (optional) collects x0, z0, x1, z1 for tests.
   */
  private arrowBetween(x0: number, z0: number, r0: number, x1: number, z1: number, r1: number, lane: number, w: number, r: number, g: number, b: number, k: number, pulse: boolean, segs: number[] | null): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return false;
    const ux = dx / len;
    const uz = dz / len;
    // (-uz, ux) is the right-hand side of the direction (ux, uz) on the floor (+X forward has +Z on its right).
    const px = -uz * lane;
    const pz = ux * lane;
    let a0 = r0;
    let a1 = r1;
    if (len < r0 + r1 + 0.1) {
      a0 = len * 0.1;
      a1 = len * 0.1;
    }
    const sx = x0 + ux * a0 + px;
    const sz = z0 + uz * a0 + pz;
    const ex = x1 - ux * a1 + px;
    const ez = z1 - uz * a1 + pz;
    this.decals.arrow(sx, sz, ex, ez, w, r, g, b, k, pulse);
    segs?.push(sx, sz, ex, ez);
    return true;
  }

  /** Advance one agent's displayed pose, walk phase, fork lift and dwell timer. */
  private advance(a: AgentView, rt: number, tick: number, dTick: number, realSec: number, eff: number) {
    let m = this.motions.get(a.id);
    if (!m || m.type !== a.type) {
      m = {
        id: a.id, type: a.type, x: this.cx(a.cell), z: this.cz(a.cell), yaw: headingYaw(a.heading), camYaw: headingYaw(a.heading), cur: null, prev: null,
        phase: (a.id * 0.37) % 1, amount: 0, speed: 0, lift: 0, state: a.state, stateSince: tick, stillSince: this.time, scale: 1, seen: 0, fresh: true,
      };
      this.motions.set(a.id, m);
    }
    m.seen = this.frame;
    if (m.state !== a.state) {
      m.state = a.state;
      m.stateSince = tick;
    }
    // Move records: keep the previous move so a just-finished move plays out to its end (the render tick lags the
    // sim by up to one tick, so the snapshot can already show the agent arrived or on its next move).
    const turnTicks = SPECS.get(a.type)?.turnTicks ?? 0;
    if (a.to >= 0 && a.moveEnd > a.moveStart) {
      if (!m.cur || m.cur.ms !== a.moveStart || m.cur.to !== a.to || m.cur.from !== a.cell) {
        const yaw = this.moveYaw(a.cell, a.to);
        const refYaw = m.cur ? m.cur.yaw : m.yaw;
        const quarter = Math.round(Math.abs(wrap(yaw - refYaw)) / (Math.PI / 2));
        const turn = Math.min(turnTicks * quarter, (a.moveEnd - a.moveStart) * 0.6);
        // Recycle the older record instead of allocating one per move.
        const rec: Move = m.prev && m.prev !== m.cur ? m.prev : { from: 0, to: 0, ms: 0, me: 0, turn: 0, yaw: 0 };
        rec.from = a.cell;
        rec.to = a.to;
        rec.ms = a.moveStart;
        rec.me = a.moveEnd;
        rec.turn = turn;
        rec.yaw = yaw;
        m.prev = m.cur;
        m.cur = rec;
      }
    } else if (m.cur) {
      m.prev = m.cur;
      m.cur = null;
    }
    let mv: Move | null = null;
    if (m.cur && rt >= m.cur.ms) mv = m.cur;
    else if (m.prev && m.prev.to === (m.cur ? m.cur.from : a.cell) && rt < m.prev.me && rt >= m.prev.ms) mv = m.prev;
    let x: number;
    let z: number;
    let moving = false;
    let yawTarget = headingYaw(a.heading);
    let camTarget = yawTarget;
    if (mv) {
      const span = Math.max(0.001, mv.me - mv.ms - mv.turn);
      const k = Math.min(1, Math.max(0, (rt - mv.ms - mv.turn) / span));
      x = this.cx(mv.from) + (this.cx(mv.to) - this.cx(mv.from)) * k;
      z = this.cz(mv.from) + (this.cz(mv.to) - this.cz(mv.from)) * k;
      moving = k > 0 && k < 1;
      yawTarget = camTarget = mv.yaw;
    } else {
      x = this.cx(a.cell);
      z = this.cz(a.cell);
      if (m.cur) yawTarget = camTarget = m.cur.yaw;
      // A forklift working at a rack face turns to put its forks into the bay.
      if ((a.type === 'forklift' || a.type === 'driver') && a.state === 'work' && !m.cur) {
        const r = this.rackYaw(a.cell);
        if (r !== null) yawTarget = r;
      }
    }
    const step = Math.hypot(x - m.x, z - m.z);
    if (step > 3 || m.fresh) {
      // Teleport (new agent, inject, reset): snap.
      m.yaw = yawTarget;
      m.camYaw = camTarget;
      m.speed = 0;
      m.fresh = false;
    } else {
      m.phase = (m.phase + step / (this.model(a.type).stride ?? 1.3)) % 1;
      m.speed += ((realSec > 0 ? step / realSec : 0) - m.speed) * Math.min(1, realSec * 8);
      m.yaw = wrap(m.yaw + wrap(yawTarget - m.yaw) * (1 - Math.exp(-eff * 9)));
      m.camYaw = wrap(m.camYaw + wrap(camTarget - m.camYaw) * (1 - Math.exp(-eff * 9)));
    }
    m.x = x;
    m.z = z;
    m.amount += ((moving ? 1 : 0) - m.amount) * (1 - Math.exp(-eff * 6));
    if (moving) m.stillSince = this.time;

    // Forks: rise at a rack face during `work` (up, hold, down over the pallet move time), low with a pallet.
    if (a.type === 'forklift' || a.type === 'driver') {
      let target = a.cargo === 'pallet' ? 0.15 : 0;
      if (a.state === 'work') {
        const spec = SPECS.get(a.type);
        const dur = Math.max(4, (spec?.palletSecPerMove?.value ?? 30) * 2);
        const u = Math.max(0, rt - m.stateSince + 1) / dur;
        const level = this.atFace(a.cell) ? 1 + ((a.id + a.taskId) % 2) : 0;
        const maxLift = a.type === 'driver' ? 3.2 : 2.4;
        const h = Math.min(maxLift, level * this.rackLevelM + 0.12);
        target = u < 0.12 ? h * smooth(u / 0.12) : u < 0.62 ? h : u < 0.85 ? h * (1 - smooth((u - 0.62) / 0.23)) : 0;
        if (!this.atFace(a.cell)) target = 0.08;
      }
      const rate = 0.7 * Math.max(dTick * 0.5, realSec * 0.5);
      m.lift += Math.max(-rate, Math.min(rate, target - m.lift));
    }
  }

  private fillRibbons(snap: Snapshot, selectedId: number | null, high: boolean) {
    this.ribbons.begin();
    let ribbonAgents = 0;
    if (this.tier === 'lite') {
      this.dbg.ribbons = 0;
      return;
    }
    const everyOther = this.tier === 'low';
    let robotIdx = 0;
    for (const a of snap.agents) {
      if (!ROBOTS.has(a.type) || a.route.length === 0) continue;
      const selected = a.id === selectedId;
      const idx = robotIdx++;
      if (everyOther && !selected && idx % 2 === 1) continue;
      const m = this.motions.get(a.id);
      if (!m) continue;
      const maxLen = selected ? Infinity : 10;
      const c = typeShade(a.type, a.vendor);
      // On high the ribbon core must clear the bloom threshold (about 3.3 for others, 5 for the selected agent).
      const k = (selected ? 1.05 : 0.7) * (high ? 9 : 1);
      // Points: the agent, its move target, then the route (skipping the cell it stands on).
      const pts = this.pts;
      pts.length = 0;
      pts.push(m.x, m.z);
      if (a.to >= 0 && a.route[0] !== a.to) pts.push(this.cx(a.to), this.cz(a.to));
      for (const cell of a.route) if (cell !== a.cell) pts.push(this.cx(cell), this.cz(cell));
      if (pts.length < 4) continue;
      // Total length (clipped) for the tail fade.
      let total = 0;
      for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      total = Math.min(total, maxLen);
      if (total < 0.2) continue;
      // Merge straight runs into one segment each.
      let s = 0;
      let i = 0;
      let added = false;
      while (i + 2 < pts.length && s < total) {
        const ax = pts[i];
        const az = pts[i + 1];
        let j = i + 2;
        const dx = Math.sign(Math.round((pts[j] - ax) * 100));
        const dz = Math.sign(Math.round((pts[j + 1] - az) * 100));
        while (j + 2 < pts.length && Math.sign(Math.round((pts[j + 2] - pts[j]) * 100)) === dx && Math.sign(Math.round((pts[j + 3] - pts[j + 1]) * 100)) === dz) j += 2;
        let bx = pts[j];
        let bz = pts[j + 1];
        let len = Math.hypot(bx - ax, bz - az);
        if (s + len > total) {
          const f = (total - s) / len;
          bx = ax + (bx - ax) * f;
          bz = az + (bz - az) * f;
          len = total - s;
        }
        if (len > 0.01) {
          const f0 = 1 - s / total;
          const f1 = 1 - (s + len) / total;
          this.ribbons.segment(ax, az, bx, bz, s, s + len, f0, Math.max(0, f1), c.r * k, c.g * k, c.b * k, selected ? 1 : 0.8);
          added = true;
        }
        s += len;
        i = j;
      }
      if (added) ribbonAgents++;
    }
    this.dbg.ribbons = ribbonAgents;
  }

  private placeLabels() {
    if (this.disposed) return;
    const cam = this.camera();
    const canvas = this.core.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!cam) return;
    const items = this.labelItems;
    let n = 0;
    for (let i = 0; i < this.anchorCount; i++) {
      const l = this.labelAnchors[i];
      const p = toScreen(cam, l.x, l.y, l.z, w, h, this.sp);
      if (!p || p.x < -50 || p.x > w + 50 || p.y < -20 || p.y > h + 60) continue;
      let it = items[n];
      if (!it) items.push((it = { text: '', x: 0, y: 0 }));
      it.text = l.text;
      it.x = p.x;
      it.y = p.y;
      n++;
    }
    this.labels.setDeadlocks(items, n);
    const id = this.hover.id;
    const a = id !== null ? this.byId.get(id) : undefined;
    const m = id !== null ? this.motions.get(id) : undefined;
    if (a && m) {
      const p = toScreen(cam, m.x, this.model(a.type).size.height * m.scale + 0.15, m.z, w, h, this.sp);
      const ht = this.hoverText;
      if (ht.id !== a.id || ht.state !== a.state) {
        ht.id = a.id;
        ht.state = a.state;
        ht.text = `${a.name} · ${TYPE_LABEL[a.type] ?? a.type} · ${a.state}`;
      }
      if (p) this.labels.setHover(ht.text, p.x, p.y);
      else this.labels.setHover(null);
    } else this.labels.setHover(null);
  }

  // ───────── queries ─────────

  /** Displayed position (a shared vector, valid until the next call), or null when the agent isn't in the snapshot. */
  positionOf(id: number): Vector3 | null {
    const m = this.motions.get(id);
    if (!m || !this.byId.has(id)) return null;
    return this.posOut.set(m.x, 0, m.z);
  }

  /** Chase target for the rig (a shared object, refreshed on every call; the rig reads it immediately). */
  followTarget(id: number): { pos: Vector3; yaw: number; distance?: number; height?: number } | null {
    const m = this.motions.get(id);
    if (!m || !this.byId.has(id)) return null;
    const t = this.followOutT;
    t.pos.set(m.x, 0, m.z);
    t.yaw = m.camYaw;
    const f = this.follow?.id === id ? this.follow : null;
    t.distance = f?.distance;
    t.height = f?.height;
    return t;
  }

  /** Nearest agent whose posed box the ray hits; else the nearest agent within a generous screen radius. */
  pick(ray: Raycaster): number | null {
    let best: number | null = null;
    let bestT = Infinity;
    if (!this.snap) return null;
    for (const a of this.snap.agents) {
      const m = this.motions.get(a.id);
      if (!m) continue;
      const s = this.model(a.type).size;
      const pad = 0.12;
      const t = rayAgentBox(ray.ray, m.x, m.z, m.yaw, (s.length / 2 + pad) * m.scale, (s.width / 2 + pad) * m.scale, (s.height + pad) * m.scale);
      if (t !== null && t < bestT) {
        bestT = t;
        best = a.id;
      }
    }
    if (best !== null) return best;
    const cam = ray.camera as Camera | undefined;
    if (!cam) return null;
    const canvas = this.core.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const click = toScreen(cam, ray.ray.origin.x + ray.ray.direction.x * 5, ray.ray.origin.y + ray.ray.direction.y * 5, ray.ray.origin.z + ray.ray.direction.z * 5, w, h);
    return click ? this.pickScreen(click.x, click.y, cam) : null;
  }

  /** Agent whose projected centre is nearest a screen point (CSS px), within 26 px (mouse) or 36 px (touch). */
  private pickScreen(x: number, y: number, cam: Camera): number | null {
    if (!this.snap) return null;
    const canvas = this.core.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const radius = this.canHover ? 26 : 36;
    let best: number | null = null;
    let bd = radius;
    for (const a of this.snap.agents) {
      const m = this.motions.get(a.id);
      if (!m) continue;
      const p = toScreen(cam, m.x, this.model(a.type).size.height * 0.45 * m.scale, m.z, w, h, this.sp);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = a.id;
      }
    }
    return best;
  }

  project(id: number, camera: Camera, w: number, h: number): { x: number; y: number } | null {
    const m = this.motions.get(id);
    const a = this.snap?.agents.find((x) => x.id === id);
    if (!m || !a) return null;
    return toScreen(camera, m.x, Math.min(1.0, this.model(a.type).size.height * 0.45) * m.scale, m.z, w, h);
  }

  count(): number {
    return this.snap?.agents.length ?? 0;
  }

  inject(snap: Snapshot | null): void {
    this.injected = snap;
    for (const m of this.motions.values()) {
      m.fresh = true;
      m.cur = m.prev = null;
    }
  }

  debug(): Record<string, unknown> {
    const instances: Record<string, number> = {};
    const models: Record<string, string> = {};
    const tris: Record<string, number> = {};
    for (const t of TYPES) {
      instances[t] = this.rigs[t].count;
      models[t] = this.models[t].source;
      tris[t] = this.models[t].model.tris;
    }
    let drawCalls = 0;
    this.group.traverseVisible((o) => {
      const im = o as InstancedMesh;
      if ((o as { isMesh?: boolean }).isMesh) {
        if (im.isInstancedMesh) drawCalls += im.count > 0 ? 1 : 0;
        else if (o === this.ribbons.mesh) drawCalls += this.ribbons.segments > 0 ? 1 : 0;
        else drawCalls++;
      }
    });
    return {
      instances,
      models,
      tris,
      hero: this.heroId !== null,
      heroLoaded: this.hero?.ready ?? false,
      ribbons: this.dbg.ribbons,
      ribbonSegments: this.ribbons.segments,
      discs: this.decals.counts.discs,
      rings: this.decals.counts.rings,
      arrows: this.decals.counts.arrows,
      safetySpots: this.dbg.safetySpots,
      blockedRings: this.dbg.blockedRings,
      selectionRings: this.dbg.selectionRings,
      waitArrows: this.dbg.waitArrows,
      deadlockRings: this.dbg.deadlockRings,
      deadlockArrows: this.dbg.deadlockArrows,
      deadlockLabels: this.labels.deadlockLabels,
      deadlockLabelAnchors: this.anchorCount,
      deadlockArrowSegs: this.arrowSegs.slice(),
      heroYaw: this.heroId !== null ? (this.hero?.facingYaw() ?? null) : null,
      drawCalls,
      bloom: this.bloom !== null,
      injected: this.injected !== null,
      followFraming: this.follow ? { ...this.follow } : null,
      tier: this.tier,
    };
  }

  dispose(): void {
    this.disposed = true;
    const canvas = this.core.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerleave', this.onLeave);
    if (this.bloom) {
      this.core.setRenderPass(null);
      this.bloom.dispose();
      this.bloom = null;
    }
    for (const t of TYPES) this.rigs[t].dispose();
    this.decals.dispose();
    this.ribbons.dispose();
    this.hero?.dispose();
    this.labels.dispose();
    this.group.clear();
  }
}

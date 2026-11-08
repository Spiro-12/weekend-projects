// The one skinned "hero" worker (PROTOCOL §9): the manifest `worker` (Quaternius CC0, walk / idle / push clips)
// stands in for the followed picker only; its instanced body is hidden while it does. Loaded lazily the first time a
// person is followed, through the shared asset loader.
import { AnimationMixer, Box3, Group, LoopRepeat, Vector3, type AnimationAction, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetLoader } from '../core/assets.ts';
import type { Tier } from '../../host/index.ts';

type Clip = 'walk' | 'idle' | 'push';

export class HeroWorker {
  readonly group = new Group();
  private model: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private actions: Partial<Record<Clip, AnimationAction>> = {};
  private current: Clip | null = null;
  private loading: Promise<void> | null = null;
  failed = false;

  constructor(private loader: AssetLoader, private tier: () => Tier) {
    this.group.name = 'agents-hero';
    this.group.visible = false;
  }

  get ready(): boolean {
    return this.model !== null;
  }

  /** Start loading (once). */
  load(): Promise<void> {
    this.loading ??= this.loader
      .gltf('worker', this.tier())
      .then((gltf) => {
        const m = cloneSkinned(gltf.scene);
        m.traverse((o) => {
          o.frustumCulled = false;
        });
        // Agents face +X at yaw 0. Measure which way the worker faces from its feet (heel → ball) instead of trusting
        // the export axis, and turn it to face +X. Scale its superhero build to a 1.78 m person.
        m.updateMatrixWorld(true);
        const fwd = this.feetForward(m);
        m.rotation.y = fwd ? -Math.atan2(-fwd.z, fwd.x) : Math.PI / 2;
        const h = new Box3().setFromObject(m).getSize(new Vector3()).y;
        if (h > 0.5) m.scale.setScalar(1.78 / h);
        this.group.add(m);
        this.model = m;
        this.mixer = new AnimationMixer(m);
        for (const clip of gltf.animations) {
          const name = clip.name.toLowerCase() as Clip;
          if (name === 'walk' || name === 'idle' || name === 'push') {
            const a = this.mixer.clipAction(clip);
            a.setLoop(LoopRepeat, Infinity);
            this.actions[name] = a;
          }
        }
      })
      .catch((e) => {
        this.failed = true;
        console.warn('hero worker failed to load', e);
      });
    return this.loading;
  }

  /** Horizontal heel → ball direction of both feet in world space (the way the worker faces), or null. */
  private feetForward(root: Object3D): Vector3 | null {
    const p = (n: string) => root.getObjectByName(n)?.getWorldPosition(new Vector3());
    const fl = p('foot_l');
    const fr = p('foot_r');
    const bl = p('ball_l');
    const br = p('ball_r');
    if (!fl || !fr || !bl || !br) return null;
    const d = bl.add(br).sub(fl).sub(fr).setY(0);
    return d.lengthSq() > 1e-8 ? d.normalize() : null;
  }

  /** Yaw the hero's feet point at in the world (tests: must match the followed agent's heading), or null. */
  facingYaw(): number | null {
    if (!this.model || !this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    const f = this.feetForward(this.model);
    return f ? Math.atan2(-f.z, f.x) : null;
  }

  /**
   * Show the hero at (x, z) facing yaw, or hide it. `speed` in m per real second drives the walk clip rate.
   * Returns true when it is visible (the caller then hides the instanced body).
   */
  update(show: boolean, x: number, z: number, yaw: number, speed: number, pushing: boolean, dtMs: number): boolean {
    if (!show || !this.model || !this.mixer) {
      this.group.visible = false;
      if (show && !this.failed) void this.load();
      return false;
    }
    this.group.visible = true;
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    const moving = speed > 0.15;
    const want: Clip = moving ? (pushing && this.actions.push ? 'push' : 'walk') : 'idle';
    if (want !== this.current) {
      const next = this.actions[want];
      const prev = this.current ? this.actions[this.current] : undefined;
      if (next) {
        next.reset().play();
        if (prev) next.crossFadeFrom(prev, 0.25, false);
      }
      this.current = want;
    }
    const a = this.actions[want];
    // The clips are authored at about 1.4 m/s walking.
    if (a) a.timeScale = moving ? Math.min(3, Math.max(0.4, speed / 1.4)) : 1;
    this.mixer.update(Math.min(0.1, dtMs / 1000));
    return true;
  }

  dispose() {
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    this.group.removeFromParent();
  }
}

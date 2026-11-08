// Camera rig (lead-owned API, PROTOCOL §9): overview, follow an agent, fly to a pose, user orbit/pan/zoom.
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface FollowTarget {
  pos: Vector3;
  /** Yaw of the agent (radians about +Y; 0 = facing +X). The chase camera sits behind it. */
  yaw: number;
  /** Chase distance behind (m), default 3.2. The agent layer can raise it (e.g. pull out during a long dwell). */
  distance?: number;
  /** Camera height (m), default 2.0. */
  height?: number;
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(38, 1, 0.3, 900);
  readonly controls: OrbitControls;
  private followFn: (() => FollowTarget | null) | null = null;
  private fly: { from: Pose; to: Pose; t0: number; ms: number } | null = null;
  private chaseYaw = 0;

  constructor(dom: HTMLElement, private sizeX: number, private sizeZ: number) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = MathUtils.degToRad(84);
    this.controls.minDistance = 3;
    this.controls.maxDistance = Math.max(sizeX, sizeZ) * 1.6;
    this.controls.screenSpacePanning = false;
    this.setPose(this.overviewPose());
    // Dragging takes the camera back from a fly-in or a chase.
    this.controls.addEventListener('start', () => {
      this.fly = null;
      this.followFn = null;
    });
  }

  /** A pose that fits the whole building for the current aspect ratio (portrait phones pull back further). */
  overviewPose(): Pose {
    const aspect = Math.max(0.3, this.camera.aspect || 1.6);
    const portrait = aspect < 0.9;
    // In portrait, look from the long side so the building's length runs up the screen.
    const across = portrait ? this.sizeZ : this.sizeX;
    const along = portrait ? this.sizeX : this.sizeZ;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const fitW = (across * 0.6) / Math.tan(hfov / 2);
    const fitH = (along * 0.6) / Math.tan(vfov / 2);
    const d = Math.max(fitW, fitH) * 0.92;
    // Landscape: about 30° yaw and 38° pitch so walls and trusses read and racks don't lean (Gate 0 visual review).
    const dir = portrait ? new Vector3(0.6, 0.78, -0.12).normalize() : new Vector3(-0.394, 0.616, 0.682).normalize();
    const tz = portrait ? 0 : this.sizeZ * 0.06;
    return { position: [dir.x * d, dir.y * d, dir.z * d + tz], target: [0, 0, tz] };
  }

  /** Distance from the camera to what it looks at (fog scales with it). */
  distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Re-fit the overview after a resize, when not following or flying. */
  refit() {
    if (!this.followFn && !this.fly && this.atOverview) this.setPose(this.overviewPose());
  }
  private atOverview = true;

  pose(): Pose {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  setPose(p: Pose) {
    this.camera.position.set(...p.position);
    this.controls.target.set(...p.target);
    this.controls.update();
  }

  overview(ms = 1200) {
    this.followFn = null;
    this.atOverview = true;
    this.flyTo(this.overviewPose(), ms);
  }

  /** Chase cam (Gate 0 visual review): 3.2 m behind, 2 m up, looking 2 m ahead at 0.6 m, so the subject fills about
   *  a quarter of the frame height in the lower third. */
  private chase(t: FollowTarget): Pose {
    const dx = Math.cos(this.chaseYaw);
    const dz = -Math.sin(this.chaseYaw);
    const back = t.distance ?? 3.2;
    const up = t.height ?? 2.0;
    return {
      position: [t.pos.x - dx * back, up, t.pos.z - dz * back],
      target: [t.pos.x + dx * 2, 0.6, t.pos.z + dz * 2],
    };
  }

  /** Follow a moving agent with a smooth chase camera. Dragging the view lets go. */
  follow(getTarget: () => FollowTarget | null, ms = 900) {
    this.followFn = getTarget;
    this.atOverview = false;
    const t = getTarget();
    if (t) {
      this.chaseYaw = t.yaw;
      this.flyTo(this.chase(t), ms);
    }
  }

  get following(): boolean {
    return this.followFn !== null;
  }

  flyTo(to: Pose, ms = 1000) {
    this.fly = { from: this.pose(), to, t0: performance.now(), ms };
  }

  update(now: number) {
    if (this.fly) {
      const k = Math.min(1, (now - this.fly.t0) / this.fly.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const lerp = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * e) as [number, number, number];
      let to = this.fly.to;
      const ft = this.followFn?.();
      if (ft) to = this.chase(ft);
      this.setPose({ position: lerp(this.fly.from.position, to.position), target: lerp(this.fly.from.target, to.target) });
      if (k >= 1) this.fly = null;
      return;
    }
    if (this.followFn) {
      const t = this.followFn();
      if (!t) {
        this.followFn = null;
      } else {
        // Ease the chase heading toward the agent's heading so turns feel smooth.
        let d = t.yaw - this.chaseYaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.chaseYaw += d * 0.04;
        const want = this.chase(t);
        const k = 0.1;
        const p = this.camera.position;
        const tg = this.controls.target;
        p.set(p.x + (want.position[0] - p.x) * k, p.y + (want.position[1] - p.y) * k, p.z + (want.position[2] - p.z) * k);
        tg.set(tg.x + (want.target[0] - tg.x) * k, tg.y + (want.target[1] - tg.y) * k, tg.z + (want.target[2] - tg.z) * k);
      }
    }
    this.controls.update();
  }
}

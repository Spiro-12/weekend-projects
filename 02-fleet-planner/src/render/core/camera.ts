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
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(45, 1, 0.3, 600);
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
    const fitW = (across * 0.56) / Math.tan(hfov / 2);
    const fitH = (along * 0.62) / Math.tan(vfov / 2);
    const d = Math.max(fitW, fitH) * 0.95;
    const dir = portrait ? new Vector3(0.6, 0.78, -0.12).normalize() : new Vector3(-0.12, 0.72, 0.68).normalize();
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

  /** Chase pose: behind the agent along its heading, looking down the aisle ahead of it. */
  private chase(t: FollowTarget): Pose {
    const dx = Math.cos(this.chaseYaw);
    const dz = -Math.sin(this.chaseYaw);
    return {
      position: [t.pos.x - dx * 6.5, 4.2, t.pos.z - dz * 6.5],
      target: [t.pos.x + dx * 4, 0.9, t.pos.z + dz * 4],
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
        const k = 0.12;
        const p = this.camera.position;
        const tg = this.controls.target;
        p.set(p.x + (want.position[0] - p.x) * k, p.y + (want.position[1] - p.y) * k, p.z + (want.position[2] - p.z) * k);
        tg.set(tg.x + (want.target[0] - tg.x) * k, tg.y + (want.target[1] - tg.y) * k, tg.z + (want.target[2] - tg.z) * k);
      }
    }
    this.controls.update();
  }
}

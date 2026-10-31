// 3D head: a stylized bust wearing AirPods, turned by the attitude quaternion `q`.
// three.js is loaded lazily (when this panel first scrolls near the screen). No WebGL: a note, and the
// angle readout still updates.
//
// Axes: the CoreMotion headphone frame is taken as x = right ear, y = forward (nose), z = up
// (pitch = nod around x, roll = tilt around y, yaw = turn around z). The view is a mirror: you see
// the head like your reflection, so turning your head left turns the model to the screen's left.
// Recenter (and the first sample from each source) sets "straight ahead".
import type { App, Panel } from '../core/app';
import type { Quat } from '../core/contracts';
import type * as T from 'three';

const CSS = `
.ss-head { display: flex; flex-direction: column; gap: 10px; }
.ss-head .stage { position: relative; height: 300px; border-radius: 12px; overflow: hidden;
  background: radial-gradient(120% 95% at 50% 28%, #1c2338 0%, #131722 58%, #0e1118 100%); border: 1px solid var(--line); }
.ss-head .stage canvas { display: block; width: 100%; height: 100%; }
.ss-head .cap { position: absolute; left: 12px; top: 10px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; pointer-events: none; }
.ss-head .cap i { width: 8px; height: 8px; border-radius: 50%; background: #7c9cff; box-shadow: 0 0 8px #7c9cff; }
.ss-head .cap[hidden], .ss-head .note[hidden] { display: none; }
.ss-head .note { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center;
  padding: 24px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.5; }
.ss-head .note b { color: var(--text); font-weight: 600; }
.ss-head .row { display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap; }
.ss-head .angles { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.ss-head .angles span { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: #ffffff05; white-space: nowrap; }
.ss-head .angles b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
`;

function injectCss(id: string, css: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.append(s);
}

// ---------- quaternion helpers ([w, x, y, z], CoreMotion frame) ----------
const conj = ([w, x, y, z]: Quat): Quat => [w, -x, -y, -z];
function mul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}
function normalize(q: Quat): Quat {
  const n = Math.hypot(...q);
  return n > 1e-9 ? (q.map((v) => v / n) as Quat) : [1, 0, 0, 0];
}

/** Turn (yaw, + = left), nod (pitch, + = up), tilt (roll, + = right) in degrees, as R = Rz(yaw) Rx(pitch) Ry(roll). */
export function headAngles([w, x, y, z]: Quat) {
  const f = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]; // forward (nose)
  const rz = 2 * (x * z - w * y); // right ear, z component
  const uz = 1 - 2 * (x * x + y * y); // up, z component
  const deg = 180 / Math.PI;
  return {
    turn: Math.atan2(-f[0], f[1]) * deg,
    nod: Math.asin(Math.max(-1, Math.min(1, f[2]))) * deg,
    tilt: Math.atan2(-rz, uz) * deg,
  };
}

/**
 * CoreMotion (right, forward, up) seen in a mirror -> three.js (x right, y up, z toward the viewer).
 * The mirror maps right->x, forward->z, up->y (a reflection), so the rotation axis flips: (x, y, z) -> (-x, -z, -y).
 * Returns three.js order [x, y, z, w].
 */
const toThreeMirror = ([w, x, y, z]: Quat): [number, number, number, number] => [-x, -z, -y, w];

/** null = no WebGL. Otherwise whether it is a software renderer (slow: render small and rarely). */
function probeWebGL(): { software: boolean } | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) };
  } catch {
    return null;
  }
}

const panel: Panel = {
  id: 'head3d',
  order: 30,
  title: 'Head pose',
  mount(el: HTMLElement, app: App) {
    injectCss('ss-head-css', CSS);
    el.innerHTML = `
      <div class="ss-head">
        <div class="stage" data-testid="head3d-stage">
          <div class="cap" hidden><i></i><span></span></div>
          <div class="note" data-testid="head3d-note"><span>Loading 3D view…</span></div>
        </div>
        <div class="row">
          <div class="angles" data-testid="head-angles">
            <span>Turn <b data-k="turn">–</b></span><span>Nod <b data-k="nod">–</b></span><span>Tilt <b data-k="tilt">–</b></span>
          </div>
          <button class="ghost" data-testid="head-recenter" title="Make the current head position the new straight ahead">Recenter</button>
        </div>
      </div>`;
    const stage = el.querySelector('.stage') as HTMLElement;
    const note = el.querySelector('.note') as HTMLElement;
    const cap = el.querySelector('.cap') as HTMLElement;
    const angleEls = Object.fromEntries([...el.querySelectorAll<HTMLElement>('.angles b')].map((b) => [b.dataset.k, b]));

    // Pose state, kept even before (or without) three.js.
    let raw: Quat | null = null;
    let ref: Quat = [1, 0, 0, 0];
    let needRef = true; // the first sample of each source becomes "straight ahead"
    let dirty = true;
    let loc: string | null = null;
    const rel = (): Quat => (raw ? normalize(mul(conj(ref), raw)) : [1, 0, 0, 0]);

    app.bus.on('source', () => { needRef = true; raw = null; dirty = true; });
    app.bus.on('motion', (s) => {
      raw = s.q;
      if (needRef) { ref = normalize(s.q); needRef = false; }
    });
    app.bus.on('status', (s) => {
      if (s.loc === loc) return;
      loc = s.loc;
      const side = s.loc === 'left' || s.loc === 'right' ? s.loc : null;
      cap.hidden = !side;
      (cap.querySelector('span') as HTMLElement).textContent = side ? `Sensor in the ${side} AirPod` : '';
      dirty = true;
    });
    (el.querySelector('[data-testid=head-recenter]') as HTMLButtonElement).onclick = (e) => {
      if (raw) ref = normalize(raw);
      dirty = true;
      (e.currentTarget as HTMLElement).blur(); // keep Space for push to talk
    };

    const fmt = (v: number, pos: string, neg: string) => (Math.abs(v) < 0.5 ? '0°' : `${Math.abs(v).toFixed(0)}° ${v > 0 ? pos : neg}`);
    let lastAngles = 0;
    const updateAngles = (now: number) => {
      if (now - lastAngles < 100 || !raw) return; // 10 Hz is plenty for text
      lastAngles = now;
      const a = headAngles(rel());
      const set = (k: string, t: string) => { if (angleEls[k] && angleEls[k].textContent !== t) angleEls[k].textContent = t; };
      set('turn', fmt(a.turn, 'left', 'right'));
      set('nod', fmt(a.nod, 'up', 'down'));
      set('tilt', fmt(a.tilt, 'right', 'left'));
    };

    let textLoop = false;
    const showNote = (html: string) => {
      note.innerHTML = html;
      note.hidden = false;
      cap.remove();
      stage.querySelector('canvas')?.remove();
      if (textLoop) return;
      textLoop = true;
      const loop = (now: number) => { updateAngles(now); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    };

    const gl = probeWebGL();
    if (!gl) {
      showNote('<b>3D view needs WebGL</b><span>This browser has it turned off. The head angles below still update live.</span>');
      return;
    }

    // Only load three.js when the panel is (nearly) on screen, and only render while it is.
    let visible = false;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      init(gl.software).catch((e) => {
        console.warn('[head3d] failed to start', e);
        showNote('<b>3D view could not start</b><span>The head angles below still update live.</span>');
      });
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (visible) { dirty = true; start(); }
      }, { rootMargin: '200px' }).observe(stage);
    } else {
      visible = true;
      start();
    }

    async function init(software: boolean) {
      const THREE = await import('three');
      let renderer: T.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: !software, alpha: true, powerPreference: 'low-power' });
      } catch (e) {
        console.warn('[head3d] WebGL renderer failed', e);
        showNote('<b>3D view could not start</b><span>WebGL failed to start here. The head angles below still update live.</span>');
        return;
      }
      renderer.setPixelRatio(software ? 1 : Math.min(2, window.devicePixelRatio || 1));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.setClearColor(0x000000, 0);
      const canvas = renderer.domElement;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', '3D head wearing AirPods that follows your head movement');

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
      camera.position.set(2.4, 0.75, 6.4);
      camera.lookAt(0, -0.42, 0);

      scene.add(new THREE.HemisphereLight(0xc8d4ff, 0x0b0d12, 1.2));
      const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
      key.position.set(3, 4, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x7c9cff, 4);
      rim.position.set(-4, 2.5, -4);
      scene.add(rim);
      const rim2 = new THREE.DirectionalLight(0x3ddc97, 0.45);
      rim2.position.set(4, -0.5, -3.5);
      scene.add(rim2);

      // ---- materials ----
      const skin = new THREE.MeshStandardMaterial({ color: 0x7a85a6, roughness: 0.5, metalness: 0.04 });
      const body = new THREE.MeshStandardMaterial({ color: 0x283048, roughness: 0.75, metalness: 0.05 });
      const white = new THREE.MeshStandardMaterial({ color: 0xf5f7fb, roughness: 0.18, metalness: 0.0 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x07080c, roughness: 0.3 });
      const seg = software ? 0.5 : 1; // fewer triangles for software renderers

      // ---- bust (fixed): neck + shoulders ----
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.34, 0.9, 48 * seg), body);
      neck.position.set(0, -1.2, -0.1);
      scene.add(neck);
      const shoulders = new THREE.Mesh(new THREE.SphereGeometry(1, 64 * seg, 32 * seg), body);
      shoulders.scale.set(1.3, 0.45, 0.7);
      shoulders.position.set(0, -1.98, -0.12);
      scene.add(shoulders);

      // ---- head: rotates around the top of the neck ----
      const pivot = new THREE.Group();
      pivot.position.set(0, -0.8, -0.08);
      scene.add(pivot);
      const head = new THREE.Group();
      head.position.set(0, 0.8, 0.08);
      pivot.add(head);

      // Egg shaped skull from a lathe profile (radius, height), smoothed with a spline.
      const profile = new THREE.SplineCurve([
        [0.001, -1.0], [0.3, -0.96], [0.5, -0.83], [0.63, -0.6], [0.72, -0.3], [0.78, 0.0],
        [0.8, 0.25], [0.76, 0.55], [0.6, 0.84], [0.34, 1.0], [0.001, 1.04],
      ].map(([r, y]) => new THREE.Vector2(r, y)));
      const skull = new THREE.Mesh(new THREE.LatheGeometry(profile.getPoints(48 * seg), 96 * seg), skin);
      skull.scale.set(1, 1, 1.14);
      head.add(skull);
      // Calm mannequin face: a nose, closed eyes and a mouth line (the face points along +z).
      const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 32 * seg, 24 * seg), skin);
      nose.scale.set(0.075, 0.16, 0.17);
      nose.rotation.x = -0.35; // bottom sticks out further than the top
      nose.position.set(0, -0.1, 0.84);
      head.add(nose);
      const line = new THREE.MeshStandardMaterial({ color: 0x2a3147, roughness: 0.6 });
      const addLine = (x: number, y: number, z: number, len: number, roll: number) => {
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, len, 4, 12), line);
        m.position.set(x, y, z);
        m.lookAt(x * 2.2, y, z + 1.2); // face outward along the surface
        m.rotateZ(Math.PI / 2 + roll); // lie flat, sideways
        head.add(m);
      };
      addLine(-0.27, 0.13, 0.84, 0.12, -0.12);
      addLine(0.27, 0.13, 0.84, 0.12, 0.12);
      addLine(0, -0.47, 0.76, 0.16, 0);
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 40 * seg, 32 * seg), skin);
        ear.scale.set(0.07, 0.2, 0.13);
        ear.position.set(sx * 0.77, -0.05, -0.04);
        head.add(ear);
      }

      // ---- AirPods Pro (bud + stem). The sensor bud (status.loc) gets a soft glow. ----
      const glowTex = (() => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d')!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(124,156,255,0.95)');
        grad.addColorStop(0.35, 'rgba(124,156,255,0.35)');
        grad.addColorStop(1, 'rgba(124,156,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      })();
      const glows: Record<'left' | 'right', T.Sprite> = {} as Record<'left' | 'right', T.Sprite>;
      const buds: Record<'left' | 'right', T.Mesh> = {} as Record<'left' | 'right', T.Mesh>;
      const sensorWhite = white.clone();
      sensorWhite.emissive.set(0x7c9cff);
      sensorWhite.emissiveIntensity = 0.35;
      for (const side of ['left', 'right'] as const) {
        const sx = side === 'right' ? 1 : -1; // mirror view: your right ear is on the screen's right
        const pod = new THREE.Group();
        pod.position.set(sx * 0.84, -0.08, 0.04);
        const bud = new THREE.Mesh(new THREE.SphereGeometry(0.115, 32 * seg, 24 * seg), white);
        bud.scale.set(0.85, 1, 1.05);
        pod.add(bud);
        const stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.26, 6, 20 * seg), white);
        stem.position.set(sx * 0.02, -0.2, 0.06);
        stem.rotation.x = -0.32;
        pod.add(stem);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), dark);
        tip.position.set(sx * 0.024, -0.345, 0.115);
        pod.add(tip);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        }));
        glow.scale.setScalar(0.42);
        glow.position.set(sx * 0.05, -0.02, 0.02);
        glow.visible = false;
        pod.add(glow);
        head.add(pod);
        glows[side] = glow;
        buds[side] = bud;
      }

      // ---- soft floor shadow (fixed) ----
      const shadowTex = (() => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d')!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(0,0,0,0.6)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
      })();
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.4),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = -2.25;
      scene.add(shadow);

      // Compile shaders without blocking the page, then show the canvas.
      await renderer.compileAsync(scene, camera).catch(() => undefined);
      stage.prepend(canvas);
      note.hidden = true;

      // ---- sizing ----
      let w = 0, h = 0;
      const fit = () => {
        const r = stage.getBoundingClientRect();
        if (r.width === w && r.height === h) return;
        w = r.width; h = r.height;
        renderer.setSize(Math.max(1, w), Math.max(1, h), false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
        dirty = true;
      };
      new ResizeObserver(fit).observe(stage);
      fit();

      let lost = false;
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        lost = true;
        showNote('<b>3D view paused</b><span>The graphics context was lost. Reload the page to bring it back.</span>');
      });

      // ---- render loop: ease toward the latest pose; render only when it visibly changed ----
      const target = new THREE.Quaternion();
      const shown = new THREE.Quaternion();
      const drawn = new THREE.Quaternion(0, 0, 0, 0); // never equal to a real pose: forces the first draw
      const minFrameMs = software ? 125 : 0; // software renderers: ~8 fps, they cost ~10x more per frame
      let prev = performance.now(), lastDraw = 0;
      const loop = (now: number) => {
        if (lost) return;
        requestAnimationFrame(loop);
        const dt = Math.min(0.1, Math.max(0, (now - prev) / 1000));
        prev = now;
        updateAngles(now);
        target.set(...toThreeMirror(rel()));
        shown.slerp(target, 1 - Math.exp(-dt / 0.06));
        if (!visible || now - lastDraw < minFrameMs) return;
        if (!dirty && Math.abs(drawn.dot(shown)) > 1 - 1e-7) return; // < ~0.05° change: skip
        dirty = false;
        lastDraw = now;
        drawn.copy(shown);
        pivot.quaternion.copy(shown);
        for (const side of ['left', 'right'] as const) {
          glows[side].visible = loc === side;
          buds[side].material = loc === side ? sensorWhite : white;
        }
        renderer.render(scene, camera);
      };
      requestAnimationFrame(loop);
    }
  },
};
export default panel;

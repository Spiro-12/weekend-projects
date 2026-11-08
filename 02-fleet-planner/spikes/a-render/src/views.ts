// One renderer, one canvas, one or two scissor viewports. Side k's agents live on layer k + 1; camera k sees layer 0
// (static world) plus its own side. High tier renders both viewports into the composer's target, then ONE bloom pass.
import { Color, PerspectiveCamera, Vector2, type Scene, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import type { ViewInfo } from '../../../tests/perf/hook.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Composer = {
  render(): void;
  setSize(w: number, h: number): void;
  setPixelRatio(r: number): void;
};

export class Views {
  readonly cams: PerspectiveCamera[] = [];
  rects: Rect[] = [];
  viewInfo: ViewInfo[] = [];
  /** Draw calls and triangles of the whole last frame (views + shadow + post). */
  frameCalls = 0;
  frameTris = 0;
  /** Called right before each view renders (per-view culling such as the low tier's far boxes). */
  beforeView: (i: number, cam: PerspectiveCamera) => void = () => {};
  private composer: Composer | null = null;
  readonly bg = new Color('#0b0e14');

  constructor(
    readonly renderer: WebGLRenderer,
    readonly scene: Scene,
    readonly sides: number,
    private dprCap: number,
  ) {
    for (let i = 0; i < sides; i++) {
      const cam = new PerspectiveCamera(45, 1, 0.3, 400);
      cam.layers.enable(i + 1);
      this.cams.push(cam);
      this.viewInfo.push({ id: sides === 1 ? 'main' : i === 0 ? 'left' : 'right', calls: 0, triangles: 0 });
    }
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.setClearColor(this.bg, 1);
  }

  /** High tier: SplitRenderPass -> UnrealBloomPass -> OutputPass (lazy chunk). */
  async enableBloom(scale = 1): Promise<void> {
    const [{ EffectComposer }, { UnrealBloomPass }, { OutputPass }, { Pass }] = await Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/OutputPass.js'),
      import('three/examples/jsm/postprocessing/Pass.js'),
    ]);
    const views = this;
    class SplitRenderPass extends Pass {
      constructor() {
        super();
        this.needsSwap = false;
      }
      render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget): void {
        renderer.setRenderTarget(this.renderToScreen ? null : read);
        renderer.setClearColor(views.bg, 1);
        renderer.clear();
        views.renderViews(this.renderToScreen ? null : read);
      }
    }
    const { width, height } = this.size();
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new SplitRenderPass());
    const bloom = new UnrealBloomPass(new Vector2(width, height), 0.6, 0.4, 1.4);
    if (scale !== 1) {
      // Run the bright pass and blur mips at a fraction of the composer size (the final blend is still full size).
      const setSize = bloom.setSize.bind(bloom);
      bloom.setSize = (w: number, h: number) => setSize(Math.round(w * scale), Math.round(h * scale));
    }
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.resize();
  }

  private size(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  resize(): void {
    const { width, height } = this.size();
    const pr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(width, height);
    this.composer?.setPixelRatio(pr);
    this.composer?.setSize(width, height);
    // Side by side on landscape, stacked on portrait (phones).
    if (this.sides === 1) this.rects = [{ x: 0, y: 0, w: width, h: height }];
    else if (width >= height) {
      const half = Math.floor(width / 2);
      this.rects = [{ x: 0, y: 0, w: half, h: height }, { x: half, y: 0, w: width - half, h: height }];
    } else {
      const half = Math.floor(height / 2);
      // GL viewport origin is bottom-left: the first (top) view sits at y = half.
      this.rects = [{ x: 0, y: half, w: width, h: height - half }, { x: 0, y: 0, w: width, h: half }];
    }
    this.cams.forEach((c, i) => {
      c.aspect = this.rects[i].w / this.rects[i].h;
      c.updateProjectionMatrix();
    });
  }

  /** Render all views for this frame. */
  render(): void {
    const r = this.renderer;
    r.info.reset();
    if (this.composer) this.composer.render();
    else {
      r.setRenderTarget(null);
      r.setScissorTest(false);
      r.clear();
      this.renderViews(null);
    }
    this.frameCalls = r.info.render.calls;
    this.frameTris = r.info.render.triangles;
  }

  /** Each view into `target` (null = canvas), with scissor. */
  renderViews(target: WebGLRenderTarget | null): void {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const split = this.sides > 1;
    for (let i = 0; i < this.sides; i++) {
      const v = this.rects[i];
      if (target) {
        target.viewport.set(v.x * pr, v.y * pr, v.w * pr, v.h * pr);
        target.scissor.set(v.x * pr, v.y * pr, v.w * pr, v.h * pr);
        target.scissorTest = split;
        r.setRenderTarget(target);
      } else {
        r.setViewport(v.x, v.y, v.w, v.h);
        r.setScissor(v.x, v.y, v.w, v.h);
        r.setScissorTest(split);
      }
      this.beforeView(i, this.cams[i]);
      const c0 = r.info.render.calls;
      const t0 = r.info.render.triangles;
      r.render(this.scene, this.cams[i]);
      this.viewInfo[i].calls = r.info.render.calls - c0;
      this.viewInfo[i].triangles = r.info.render.triangles - t0;
    }
    if (target) {
      target.viewport.set(0, 0, target.width, target.height);
      target.scissor.set(0, 0, target.width, target.height);
      target.scissorTest = false;
      r.setRenderTarget(target);
    } else {
      r.setScissorTest(false);
      const { width, height } = this.size();
      r.setViewport(0, 0, width, height);
    }
  }
}

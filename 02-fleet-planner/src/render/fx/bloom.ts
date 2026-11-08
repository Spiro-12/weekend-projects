// High-tier bloom (lazy chunk): only bright emissive things glow (agent light bands, ribbons, rings, the world's LED
// rows); a luminance threshold above anything lit keeps floors and racks out. Each view renders through its own
// composer sized to that view (scene → half-size UnrealBloom mips → OutputPass → FXAA into the view's viewport), so
// in split screen one side's glow never bleeds across the seam (spike a's single full-canvas pass did). The HDR target
// has no MSAA (too costly at DPR 1.5, spike a), so FXAA smooths the edges after tone mapping.
import { HalfFloatType, Vector2, Vector4, WebGLRenderTarget, type PerspectiveCamera } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { RendererCore, View } from '../core/renderer.ts';

/** Linear-HDR threshold: lit floors and racks stay under it; light bands, ribbons and rings on high go over. */
export const BLOOM = { strength: 0.45, radius: 0.15, threshold: 2.8 };

interface PerView {
  composer: EffectComposer;
  pass: RenderPass;
  bloom: UnrealBloomPass;
  w: number;
  h: number;
  pr: number;
  last: number;
}

export class Bloom {
  private views = new Map<string, PerView>();
  private vp = new Vector4();

  constructor(private core: RendererCore, private scale: number, private samples: number) {}

  private forView(v: View, w: number, h: number): PerView {
    const r = this.core.renderer;
    const pr = r.getPixelRatio();
    let pv = this.views.get(v.id);
    if (!pv) {
      const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: this.samples });
      const composer = new EffectComposer(r, rt);
      const pass = new RenderPass(this.core.scene, v.camera);
      const bloom = new UnrealBloomPass(new Vector2(w, h), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      composer.addPass(pass);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      composer.addPass(new FXAAPass());
      pv = { composer, pass, bloom, w: 0, h: 0, pr: 0, last: performance.now() };
      this.views.set(v.id, pv);
    }
    if (pv.w !== w || pv.h !== h || pv.pr !== pr) {
      pv.composer.setPixelRatio(pr);
      pv.composer.setSize(w, h);
      pv.bloom.setSize(Math.max(2, Math.round(w * pr * this.scale)), Math.max(2, Math.round(h * pr * this.scale)));
      pv.w = w;
      pv.h = h;
      pv.pr = pr;
    }
    return pv;
  }

  /** The renderer core's per-view render pass (viewport and scissor are already set to the view). */
  readonly render = (v: View) => {
    const now = performance.now();
    // The core draws its views in order, so the first view starts a frame: drop composers for view ids the core no
    // longer has (leaving split screen, or views swapped for new ids).
    if (v === this.core.views[0]) this.prune();
    const r = this.core.renderer;
    r.getViewport(this.vp);
    const w = Math.max(1, Math.round(this.vp.z));
    const h = Math.max(1, Math.round(this.vp.w));
    const pv = this.forView(v, w, h);
    pv.pass.camera = v.camera as PerspectiveCamera;
    pv.composer.render((now - pv.last) / 1000);
    pv.last = now;
  };

  /** Dispose composers whose view id the core no longer draws. No allocation when nothing changed. */
  private prune() {
    this.views.forEach(this.dropIfGone);
  }
  private dropIfGone = (pv: PerView, id: string) => {
    for (const v of this.core.views) if (v.id === id) return;
    this.disposeView(pv);
    this.views.delete(id);
  };

  private disposeView(pv: PerView) {
    pv.composer.renderTarget1.dispose();
    pv.composer.renderTarget2.dispose();
    for (const p of pv.composer.passes) p.dispose();
  }

  dispose() {
    for (const pv of this.views.values()) this.disposeView(pv);
    this.views.clear();
  }
}

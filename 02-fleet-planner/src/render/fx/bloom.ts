// High-tier bloom (lazy chunk): only bright emissive things glow (agent light bands, ribbons, the world's LED rows);
// a luminance threshold above anything lit keeps floors and walls out. Each view renders through its own composer
// sized to that view (scene → half-size UnrealBloom mips → OutputPass into the view's viewport), so in split screen
// one side's glow never bleeds across the seam (spike a's single full-canvas pass did).
import { HalfFloatType, Vector2, Vector4, WebGLRenderTarget, type PerspectiveCamera } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { RendererCore, View } from '../core/renderer.ts';

export const BLOOM = { strength: 0.6, radius: 0.4, threshold: 1.25 };

interface PerView {
  composer: EffectComposer;
  pass: RenderPass;
  bloom: UnrealBloomPass;
  w: number;
  h: number;
  pr: number;
}

export class Bloom {
  private views = new Map<string, PerView>();
  private vp = new Vector4();
  private last = performance.now();

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
      pv = { composer, pass, bloom, w: 0, h: 0, pr: 0 };
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
    const r = this.core.renderer;
    r.getViewport(this.vp);
    const w = Math.max(1, Math.round(this.vp.z));
    const h = Math.max(1, Math.round(this.vp.w));
    const pv = this.forView(v, w, h);
    pv.pass.camera = v.camera as PerspectiveCamera;
    const now = performance.now();
    pv.composer.render((now - this.last) / 1000);
    this.last = now;
  };

  dispose() {
    for (const pv of this.views.values()) {
      pv.composer.renderTarget1.dispose();
      pv.composer.renderTarget2.dispose();
      pv.bloom.dispose();
      for (const p of pv.composer.passes) p.dispose();
    }
    this.views.clear();
  }
}

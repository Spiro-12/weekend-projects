// GPU-verified Chromium launch for perf runs and screenshots (Node only).
// New headless first; if the WebGL renderer is not an Apple/Metal GPU, relaunch headed with the Metal ANGLE flags.
// Software renderers (SwiftShader, llvmpipe) are refused: fps from them is meaningless.
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { isAppleMetal, isSoftwareGpu } from './stats.ts';

/** tsx (esbuild keepNames) wraps named inner functions in `__name(fn, "f")`; functions passed to page.evaluate then
 *  throw "__name is not defined" in the page. Defining it as identity in every page fixes that. */
export const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f);';

export const GPU_FLAGS =['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
/** Lets frames run faster than the display refresh, to see headroom (frame time = real cost, not vsync). */
export const UNCAPPED_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
/** Forces software WebGL. Only for checking that the harness refuses it (`perf.ts --selftest-software`). */
export const SOFTWARE_FLAGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export interface GpuInfo {
  vendor: string;
  renderer: string;
  /** WebGL2 extension EXT_disjoint_timer_query_webgl2 is exposed. */
  timerQuery: boolean;
}

export interface LaunchResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  gpu: GpuInfo;
  mode: 'headless' | 'headed';
  appleMetal: boolean;
}

export class SoftwareGpuError extends Error {
  constructor(readonly gpu: GpuInfo) {
    super(`refusing to measure: WebGL is software rendered (${gpu.renderer})`);
  }
}

export interface LaunchOptions {
  context?: BrowserContextOptions;
  /** Skip new headless and go straight to headed. */
  headed?: boolean;
  uncapped?: boolean;
  /** Launch with SOFTWARE_FLAGS instead of the GPU flags (self-test of the refusal). */
  forceSoftware?: boolean;
  log?: (msg: string) => void;
}

/** Read the unmasked WebGL renderer string from a scratch canvas in the page. */
export async function probeGpu(page: Page): Promise<GpuInfo> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { vendor: 'none', renderer: 'no webgl2', timerQuery: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const timerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { vendor, renderer, timerQuery };
  });
}

async function open(headless: boolean, opts: LaunchOptions): Promise<Omit<LaunchResult, 'appleMetal'>> {
  const gpuArgs = opts.forceSoftware ? SOFTWARE_FLAGS : headless ? [] : GPU_FLAGS;
  const args = [...gpuArgs, ...(opts.uncapped ? UNCAPPED_FLAGS : [])];
  // channel 'chromium' = the full Chromium build in new headless mode (not the old headless shell).
  const browser = await chromium.launch({ channel: 'chromium', headless, args });
  const context = await browser.newContext(opts.context);
  await context.addInitScript(NAME_SHIM);
  const page = await context.newPage();
  await page.goto('about:blank');
  const gpu = await probeGpu(page);
  return { browser, context, page, gpu, mode: headless ? 'headless' : 'headed' };
}

/**
 * Launch Chromium on the real GPU. Throws SoftwareGpuError if only a software renderer is available.
 * On a non-Apple machine with a real GPU it returns that GPU with appleMetal = false (the caller warns).
 */
export async function launchGpuChromium(opts: LaunchOptions = {}): Promise<LaunchResult> {
  const log = opts.log ?? (() => {});
  if (!opts.headed) {
    const r = await open(true, opts);
    log(`new headless: ${r.gpu.renderer}`);
    if (isAppleMetal(r.gpu.renderer)) return { ...r, appleMetal: true };
    await r.browser.close();
    log('not an Apple/Metal GPU in headless; falling back to headed with ' + (opts.forceSoftware ? SOFTWARE_FLAGS : GPU_FLAGS).join(' '));
  }
  const r = await open(false, opts);
  log(`headed: ${r.gpu.renderer}`);
  if (isSoftwareGpu(r.gpu.renderer) || r.gpu.renderer === 'no webgl2') {
    await r.browser.close();
    throw new SoftwareGpuError(r.gpu);
  }
  return { ...r, appleMetal: isAppleMetal(r.gpu.renderer) };
}

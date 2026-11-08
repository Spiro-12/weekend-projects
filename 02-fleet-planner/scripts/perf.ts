// Perf harness: frame cost of a page on the real GPU, over a scripted camera tour (PLAN §9.3).
//
//   npx tsx scripts/perf.ts --url <url> --out tests/perf/out/<name>.json [--tour default] [--seconds 20]
//        [--runs 3] [--warmup 3] [--phone] [--headed] [--uncapped] [--viewport 1440x900] [--dpr 2]
//        [--budget-ms 16.7] [--budget-calls 150] [--strict] [--no-caffeinate] [--selftest-software] [--sync] [--raw]
//
// - Chromium via Playwright: new headless first, headed with Metal ANGLE flags if the GPU is not Apple/Metal.
//   Refuses (exit 2, no numbers) when WebGL is software rendered (SwiftShader, llvmpipe).
// - Asserts the page is visible and logs the display refresh rate (median rAF interval on an idle page).
// - The page exposes window.__fp (tests/perf/hook.ts): perf.cpuMs()/gpuMs() or perf.drain(), render.info(), tour().
// - Runs the tour `--runs` times (fresh page load each), then checks the runs agree within 5% (else "noisy").
// - --phone: 390x844, DPR 3, touch, 4x CPU slowdown (CDP), ?tier=low, one 120 s run; passes at >= 30 fps.
// - --strict: exit 1 when a budget fails or the runs are noisy.
// - --sync: ask the page for sync mode (perf.sync(true): a 1-pixel readback each frame) and report `work` = frame start to
//   GPU done. Then the budget metric is work.p95 instead of the timer-query cpu+gpu (which reads high on ANGLE/Metal).
// - --raw: keep every per-frame sample in the output JSON.
// - --selftest-software: force SwiftShader to check the refusal path (expect exit 2 and no output file).
// - On macOS the whole run sits under `caffeinate -d -i` so the Mac doesn't sleep.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';
import { launchGpuChromium, SoftwareGpuError } from '../tests/perf/launch.ts';
import { agreement, countAbove, dist, fpsOf, median, pairedSum, type Dist } from '../tests/perf/stats.ts';
import type { PerfWindow, RenderInfo } from '../tests/perf/hook.ts';

interface Args {
  url: string;
  out: string;
  tour: string;
  seconds: number;
  runs: number;
  warmup: number;
  phone: boolean;
  headed: boolean;
  uncapped: boolean;
  width: number;
  height: number;
  dpr: number;
  budgetMs: number;
  budgetCalls: number;
  strict: boolean;
  caffeinate: boolean;
  selftestSoftware: boolean;
  sync: boolean;
  raw: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string) => argv.includes(`--${k}`);
  const url = get('url');
  const out = get('out');
  if (!url || !out) {
    console.error('usage: tsx scripts/perf.ts --url <url> --out tests/perf/out/<name>.json [--tour default] [--seconds 20] [--runs 3] [--phone]');
    process.exit(64);
  }
  const phone = has('phone');
  const [w, h] = (get('viewport') ?? (phone ? '390x844' : '1440x900')).split('x').map(Number);
  return {
    url, out, phone,
    tour: get('tour') ?? 'default',
    seconds: Number(get('seconds') ?? (phone ? 120 : 20)),
    runs: Number(get('runs') ?? (phone ? 1 : 3)),
    warmup: Number(get('warmup') ?? 3),
    headed: has('headed'),
    uncapped: has('uncapped'),
    width: w,
    height: h,
    dpr: Number(get('dpr') ?? (phone ? 3 : 2)),
    budgetMs: Number(get('budget-ms') ?? 16.7),
    budgetCalls: Number(get('budget-calls') ?? (phone ? 60 : 150)),
    strict: has('strict'),
    caffeinate: !has('no-caffeinate'),
    selftestSoftware: has('selftest-software'),
    sync: has('sync'),
    raw: has('raw'),
  };
}

/** Median rAF interval (ms) on the current (idle) page. */
async function idleRefresh(page: Page): Promise<number> {
  const deltas = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const ts: number[] = [];
        const step = (t: number) => {
          ts.push(t);
          if (ts.length < 91) requestAnimationFrame(step);
          else resolve(ts.slice(1).map((v, i) => v - ts[i]));
        };
        requestAnimationFrame(step);
      }),
  );
  return median(deltas);
}

interface RawRun {
  frame: number[];
  cpu: number[];
  gpu: (number | null)[];
  work: number[] | null;
  calls: number[];
  tris: number[];
  exactSamples: boolean;
  info: RenderInfo;
  tier: string;
}

/** One measured tour inside the page: rAF intervals, CPU/GPU samples, draw calls every 10th frame. */
async function measureTour(page: Page, tour: string, seconds: number, sync: boolean): Promise<RawRun> {
  return page.evaluate(
    async ({ tour, seconds, sync }) => {
      const fp = (window as PerfWindow).__fp!;
      const frame: number[] = [];
      const cpuPoll: number[] = [];
      const gpuPoll: (number | null)[] = [];
      const calls: number[] = [];
      const tris: number[] = [];
      const exact = typeof fp.perf.drain === 'function';
      if (sync) {
        if (typeof fp.perf.sync !== 'function') throw new Error('--sync: the page has no perf.sync()');
        fp.perf.sync(true);
      }
      if (exact) fp.perf.drain!();
      let last = -1;
      let n = 0;
      let running = true;
      const tick = (t: number) => {
        if (!running) return;
        if (last >= 0) frame.push(t - last);
        last = t;
        if (!exact) {
          cpuPoll.push(fp.perf.cpuMs());
          gpuPoll.push(fp.perf.gpuMs());
        }
        if (n++ % 10 === 0) {
          const i = fp.render.info();
          calls.push(i.calls);
          tris.push(i.triangles);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await fp.tour(tour, seconds);
      running = false;
      // Let the last frames' GPU timer queries resolve before draining.
      await new Promise((r) => setTimeout(r, 200));
      const samples = exact ? fp.perf.drain!() : { cpu: cpuPoll, gpu: gpuPoll, work: undefined };
      if (sync) fp.perf.sync!(false);
      return {
        frame, cpu: samples.cpu, gpu: samples.gpu, work: samples.work ?? null, calls, tris, exactSamples: exact,
        info: fp.render.info(), tier: fp.perf.tier,
      };
    },
    { tour, seconds, sync },
  );
}

interface RunStats {
  frame: Dist | null;
  cpu: Dist | null;
  gpu: Dist | null;
  /** Per-frame CPU + GPU (paired by frame), or null without GPU samples. */
  cpuGpu: Dist | null;
  /** Sync mode: frame start to GPU done (1-pixel readback). */
  work: Dist | null;
  fps: number;
  longFrames: number;
  frames: number;
  gpuSamples: number;
  drawCalls: Dist | null;
  triangles: Dist | null;
}

function runStats(r: RawRun, refreshMs: number): RunStats {
  const gpu = r.gpu.filter((g): g is number => g !== null && Number.isFinite(g));
  const paired = r.exactSamples ? pairedSum(r.cpu, r.gpu) : [];
  // Without exact pairing, use p-wise sums as an upper bound.
  const cpuD = dist(r.cpu);
  const gpuD = dist(gpu);
  let cpuGpu = dist(paired);
  if (!cpuGpu && cpuD && gpuD)
    cpuGpu = { n: cpuD.n, p50: cpuD.p50 + gpuD.p50, p95: cpuD.p95 + gpuD.p95, p99: cpuD.p99 + gpuD.p99, max: cpuD.max + gpuD.max, mean: cpuD.mean + gpuD.mean };
  return {
    frame: dist(r.frame),
    cpu: cpuD,
    gpu: gpuD,
    cpuGpu,
    work: r.work ? dist(r.work) : null,
    fps: fpsOf(r.frame),
    longFrames: countAbove(r.frame, refreshMs * 1.5),
    frames: r.frame.length,
    gpuSamples: gpu.length,
    drawCalls: dist(r.calls),
    triangles: dist(r.tris),
  };
}

/** Median across runs of one field of a Dist. */
function medianOf(runs: RunStats[], pick: (r: RunStats) => Dist | null, key: keyof Dist): number | null {
  const v = runs.map(pick).filter((d): d is Dist => d !== null).map((d) => d[key]);
  return v.length ? median(v) : null;
}

function withTier(url: string, tier: string): string {
  const u = new URL(url);
  if (!u.searchParams.has('tier')) u.searchParams.set('tier', tier);
  return u.toString();
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const url = a.phone ? withTier(a.url, 'low') : a.url;
  let caf: ChildProcess | null = null;
  if (process.platform === 'darwin' && a.caffeinate) {
    caf = spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' });
  }
  const log = (m: string) => console.log(`[perf] ${m}`);
  let launched;
  try {
    launched = await launchGpuChromium({
      headed: a.headed,
      uncapped: a.uncapped,
      forceSoftware: a.selftestSoftware,
      log,
      context: {
        viewport: { width: a.width, height: a.height },
        deviceScaleFactor: a.dpr,
        isMobile: a.phone,
        hasTouch: a.phone,
      },
    });
  } catch (e) {
    caf?.kill();
    if (e instanceof SoftwareGpuError) {
      console.error(`[perf] REFUSED: ${e.message}. No numbers reported.`);
      return 2;
    }
    throw e;
  }
  const { browser, page, gpu, mode, appleMetal } = launched;
  try {
    if (!appleMetal) log(`WARNING: GPU is not Apple/Metal (${gpu.renderer}); numbers are from this GPU, not Spiro's Mac.`);
    if (!gpu.timerQuery) log('WARNING: EXT_disjoint_timer_query_webgl2 unavailable; GPU ms will be missing.');
    const refreshMs = await idleRefresh(page);
    const refreshHz = Math.round(1000 / refreshMs);
    log(`GPU ${gpu.renderer} (${mode}); idle refresh ${refreshHz} Hz (${refreshMs.toFixed(2)} ms)`);
    if (a.phone) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      log('phone: 390x844 DPR 3, touch, CPU throttled 4x');
    }

    const raws: RawRun[] = [];
    const stats: RunStats[] = [];
    let visibility = 'unknown';
    for (let i = 0; i < a.runs; i++) {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => (window as PerfWindow).__fp?.ready === true, null, { timeout: 60_000 });
      visibility = await page.evaluate(() => document.visibilityState);
      if (visibility !== 'visible') throw new Error(`page is '${visibility}', not visible: rAF is throttled, numbers would be wrong`);
      await page.waitForTimeout(a.warmup * 1000);
      const raw = await measureTour(page, a.tour, a.seconds, a.sync);
      const s = runStats(raw, refreshMs);
      raws.push(raw);
      stats.push(s);
      log(
        `run ${i + 1}/${a.runs}: fps ${s.fps}  frame p95 ${s.frame?.p95}  cpu p95 ${s.cpu?.p95}  gpu p95 ${s.gpu?.p95}  ` +
          `cpu+gpu p95 ${s.cpuGpu?.p95}${s.work ? `  work p95 ${s.work.p95}` : ''}  calls max ${s.drawCalls?.max}  tris max ${s.triangles?.max}`,
      );
    }

    const budgetMetric = stats.every((s) => s.work) ? 'work.p95' : stats.every((s) => s.cpuGpu) ? 'cpuGpu.p95' : 'cpu.p95';
    const pickMetric = (s: RunStats) => (budgetMetric === 'work.p95' ? s.work! : budgetMetric === 'cpuGpu.p95' ? s.cpuGpu! : s.cpu!).p95;
    const metricValues = stats.map(pickMetric);
    const agree = agreement(metricValues);
    const last = raws[raws.length - 1];
    const summary = {
      cpu: { p50: medianOf(stats, (s) => s.cpu, 'p50'), p95: medianOf(stats, (s) => s.cpu, 'p95'), max: medianOf(stats, (s) => s.cpu, 'max') },
      gpu: { p50: medianOf(stats, (s) => s.gpu, 'p50'), p95: medianOf(stats, (s) => s.gpu, 'p95'), max: medianOf(stats, (s) => s.gpu, 'max') },
      cpuGpu: { p50: medianOf(stats, (s) => s.cpuGpu, 'p50'), p95: medianOf(stats, (s) => s.cpuGpu, 'p95'), max: medianOf(stats, (s) => s.cpuGpu, 'max') },
      work: { p50: medianOf(stats, (s) => s.work, 'p50'), p95: medianOf(stats, (s) => s.work, 'p95'), max: medianOf(stats, (s) => s.work, 'max') },
      frame: { p50: medianOf(stats, (s) => s.frame, 'p50'), p95: medianOf(stats, (s) => s.frame, 'p95'), max: medianOf(stats, (s) => s.frame, 'max') },
      fps: median(stats.map((s) => s.fps)),
      drawCalls: { p50: medianOf(stats, (s) => s.drawCalls, 'p50'), max: Math.max(...stats.map((s) => s.drawCalls?.max ?? 0)) },
      triangles: { p50: medianOf(stats, (s) => s.triangles, 'p50'), max: Math.max(...stats.map((s) => s.triangles?.max ?? 0)) },
    };
    const checks = a.phone
      ? { fpsAtLeast30: summary.fps >= 30, drawCallsWithinBudget: summary.drawCalls.max <= a.budgetCalls }
      : {
          p95WithinBudget: median(metricValues) <= a.budgetMs,
          drawCallsWithinBudget: summary.drawCalls.max <= a.budgetCalls,
        };
    const noisy = !agree.agree;
    const result = {
      tool: 'fleet-perf v1',
      timestamp: new Date().toISOString(),
      url,
      tour: a.tour,
      seconds: a.seconds,
      runs: a.runs,
      browser: { mode, version: browser.version(), uncapped: a.uncapped },
      gpu: { ...gpu, appleMetal },
      refreshHz,
      refreshMs: Math.round(refreshMs * 1000) / 1000,
      visibility,
      viewport: { width: a.width, height: a.height, deviceScaleFactor: a.dpr },
      phone: a.phone ? { cpuThrottle: 4, isMobile: true } : null,
      tier: last.tier,
      agents: last.info.agents ?? null,
      labels: last.info.labels ?? null,
      views: last.info.views ?? null,
      exactSamples: last.exactSamples,
      summary,
      budgets: { cpuGpuP95Ms: a.budgetMs, drawCalls: a.budgetCalls },
      checks,
      agreement: { metric: budgetMetric, values: metricValues, ...agree, tolerance: 0.05 },
      verdict: noisy ? 'noisy' : 'ok',
      perRun: stats,
      sync: a.sync,
      raw: a.raw ? raws.map((r) => ({ frame: r.frame, cpu: r.cpu, gpu: r.gpu, work: r.work })) : undefined,
    };
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, JSON.stringify(result, null, 2) + '\n');
    log(
      `${noisy ? 'NOISY' : 'ok'}: ${budgetMetric} ${metricValues.join(' / ')} ms (spread ${(agree.spread * 100).toFixed(1)}%); ` +
        `p95 cpu ${summary.cpu.p95} gpu ${summary.gpu.p95} cpu+gpu ${summary.cpuGpu.p95}${a.sync ? ` work ${summary.work.p95}` : ''} ms; fps ${summary.fps}; ` +
        `calls max ${summary.drawCalls.max}; checks ${JSON.stringify(checks)} -> ${a.out}`,
    );
    const failed = Object.values(checks).some((v) => !v);
    return a.strict && (failed || noisy) ? 1 : 0;
  } finally {
    await browser.close();
    caf?.kill();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('[perf] failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

// Budget checks that work without a GPU (CI): JS size, first-useful-view bytes, draw calls, triangles (PLAN §9).
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import budgets from '../../budgets.json' with { type: 'json' };
import { openApp } from './helpers.ts';

test('initial JS stays under budget (gzipped)', () => {
  const html = readFileSync('dist/index.html', 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\/weekend-projects\/02-fleet-planner\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  expect(files.length).toBeGreaterThan(0);
  const kb = files.reduce((t, f) => t + gzipSync(readFileSync(`dist/${f}`), { level: 6 }).length, 0) / 1024;
  console.log(`initial JS+CSS: ${kb.toFixed(1)} KB gz (${files.join(', ')}); all assets: ${readdirSync('dist/assets').length} files`);
  expect(kb).toBeLessThanOrEqual(budgets.jsInitialGzKB);
});

test('first useful view downloads under budget', async ({ page }) => {
  // Bytes requested before the first useful view (the browser's own resource timing), plus the page itself.
  // The full-look files (the asset manifest and the models it lists) wait behind the load gate
  // (src/render/core/load-gate.ts), which opens at the first useful view, or after 4 s when the first view is slow (as
  // on CI's shared runner). So the count doesn't depend on machine speed, the test holds the manifest's response until
  // the first view: no model can then download before it, and a first view that needed a model would never arrive
  // (timeout). The held request still records when the app asked for it, so none may have started before the gate.
  // Still speed-dependent, but small: on a slow machine the world layer imports the loader chunk (GLTFLoader + meshopt,
  // ~21 KB gz) 2.5 s after its first frame (src/render/world/index.ts), and that counts.
  const m = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as { models: Record<string, { url: string; urlLo?: string }> };
  const fullLook = ['assets/manifest.json', ...Object.values(m.models).flatMap((x) => (x.urlLo ? [x.url, x.urlLo] : [x.url]))];
  await page.route('**/assets/manifest.json', async (route) => {
    await page.waitForFunction(() => window.__fp?.perf.firstUsefulViewMs != null, null, { timeout: 30_000 }).catch(() => {});
    await route.continue().catch(() => {}); // the page may have closed (test failed or timed out)
  });
  await openApp(page);
  // Wait for the world's full look so its downloads have finished and show up in resource timing (entries appear on
  // completion). The agent layer's forklift models start 250 ms after the first view and may still be loading; they
  // go through the same manifest, so they can't skip the gate either.
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  const r = await page.evaluate((fullLook) => {
    const fuv = window.__fp!.perf.firstUsefulViewMs!;
    const gate = performance.getEntriesByName('fp:load-gate')[0] as PerformanceMark | undefined;
    const size = (e: PerformanceResourceTiming) => e.transferSize || e.encodedBodySize;
    const isFullLook = (e: PerformanceResourceTiming) => fullLook.some((u) => new URL(e.name).pathname.endsWith(`/${u}`));
    const nav = performance.getEntriesByType('navigation') as PerformanceResourceTiming[];
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const first = res.filter((e) => e.startTime <= fuv && !isFullLook(e));
    const full = res.filter(isFullLook);
    const name = (e: PerformanceResourceTiming) => new URL(e.name).pathname.split('/').pop();
    return {
      kb: [...nav, ...first].reduce((t, e) => t + size(e), 0) / 1024,
      n: first.length + nav.length,
      fuv,
      gate: gate ? { ms: gate.startTime, by: String(gate.detail) } : null,
      fullN: full.length,
      fullBeforeFuv: full.filter((e) => e.startTime <= fuv).map(name),
      early: full.filter((e) => !gate || e.startTime < gate.startTime).map((e) => `${name(e)} at ${e.startTime.toFixed(0)} ms`),
    };
  }, fullLook);
  console.log(
    `first useful view: ${r.kb.toFixed(1)} KB transferred in ${r.n} requests at ${r.fuv} ms; ` +
      `load gate opened by ${r.gate?.by} at ${r.gate?.ms.toFixed(0)} ms; ${r.fullN} full-look files, not counted (${r.fullBeforeFuv.join(', ') || 'none'} requested before the first view)`,
  );
  expect(r.gate, 'the load gate opened').not.toBeNull();
  expect(r.fullN, 'full-look files loaded').toBeGreaterThan(1);
  expect(r.early, 'full-look files that started before the load gate opened').toEqual([]);
  expect(r.n).toBeGreaterThan(1);
  expect(r.kb).toBeLessThanOrEqual(budgets.firstUsefulViewKB);
});

test('draw calls and triangles: each view at most half the two-view budget, after the full look loads', async ({ page }) => {
  await openApp(page, '?tier=high');
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => window.__fp!.render.info());
  console.log(`overview (high): ${info.calls} draw calls, ${info.triangles} triangles in ${info.views.length} view(s)`);
  for (const v of info.views) {
    expect(v.calls, `view ${v.id} draw calls`).toBeLessThanOrEqual(budgets.drawCalls / 2);
    expect(v.triangles, `view ${v.id} triangles`).toBeLessThanOrEqual(budgets.triangles / 2);
  }
  expect(info.calls).toBeLessThanOrEqual(budgets.drawCalls);
  expect(info.triangles).toBeLessThanOrEqual(budgets.triangles);
});

test('phone (low tier): draw calls and triangles under the phone budget', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await openApp(page);
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => ({ ...window.__fp!.render.info(), tier: window.__fp!.perf.tier }));
  console.log(`phone (${info.tier}): ${info.calls} draw calls, ${info.triangles} triangles`);
  expect(info.calls).toBeLessThanOrEqual(budgets.phoneDrawCalls);
  expect(info.triangles).toBeLessThanOrEqual(budgets.phoneTriangles);
  await ctx.close();
});

test('asset bytes from the manifest: first tier, phone, everything', () => {
  const m = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as {
    decoder: { gzBytes: number };
    models: Record<string, { gzBytes: number; gzBytesLo?: number; firstTier: boolean }>;
  };
  const models = Object.values(m.models);
  const kb = (b: number) => b / 1024;
  const first = kb(m.decoder.gzBytes + models.filter((x) => x.firstTier).reduce((t, x) => t + x.gzBytes, 0));
  const phone = kb(m.decoder.gzBytes + models.filter((x) => x.firstTier).reduce((t, x) => t + (x.gzBytesLo ?? x.gzBytes), 0));
  const all = kb(m.decoder.gzBytes + models.reduce((t, x) => t + x.gzBytes + (x.gzBytesLo ?? 0), 0));
  console.log(`assets gz: first tier ${first.toFixed(0)} KB, phone ${phone.toFixed(0)} KB, all ${all.toFixed(0)} KB`);
  expect(first).toBeLessThanOrEqual(budgets.fullLookGzKB);
  expect(phone).toBeLessThanOrEqual(budgets.phoneAssetsGzKB);
  expect(all).toBeLessThanOrEqual(budgets.allAssetsGzKB);
});

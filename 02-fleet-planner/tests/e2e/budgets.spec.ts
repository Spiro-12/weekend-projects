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
  // Bytes requested before the first useful view (the browser's own resource timing, so models that start loading
  // afterwards don't count however slow the machine is), plus the page itself.
  await openApp(page);
  const { kb, n } = await page.evaluate(() => {
    const fuv = window.__fp!.perf.firstUsefulViewMs!;
    const size = (e: PerformanceResourceTiming) => e.transferSize || e.encodedBodySize;
    const nav = performance.getEntriesByType('navigation') as PerformanceResourceTiming[];
    const res = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((e) => e.startTime <= fuv);
    return { kb: [...nav, ...res].reduce((t, e) => t + size(e), 0) / 1024, n: res.length + nav.length };
  });
  console.log(`first useful view: ${kb.toFixed(1)} KB transferred in ${n} requests`);
  expect(n).toBeGreaterThan(1);
  expect(kb).toBeLessThanOrEqual(budgets.firstUsefulViewKB);
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

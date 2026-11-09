// Track D: the low tier fetches only the low-detail model files (urlLo) wherever a model has one, and still swaps them in.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as {
  models: Record<string, { url: string; urlLo?: string }>;
};

test('low tier loads only urlLo models', async ({ page }) => {
  const glbs: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.glb')) glbs.push(new URL(r.url()).pathname.replace(/^.*\/assets\//, 'assets/'));
  });
  const errors = await openApp(page, '?tier=low');
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  console.log(`low tier fetched: ${glbs.join(', ')}`);
  expect(glbs.length).toBeGreaterThan(3);
  for (const [key, m] of Object.entries(manifest.models)) if (m.urlLo) expect(glbs, `${key} must not fetch ${m.url}`).not.toContain(m.url);
  const dbg = await page.evaluate(() => window.__fp!.render.layers.world.debug?.() as { models: Record<string, string>; failed: string[] });
  for (const url of Object.values(dbg.models)) expect(url).toMatch(/-lo\.glb$/);
  expect(dbg.failed).toEqual([]);
  await expectNoErrors(errors);
});

test('tier switch at runtime keeps the world (medium → low → medium)', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  for (const t of ['low', 'medium'] as const) {
    await page.evaluate((t) => {
      window.__fp!.render.layers.world.setTier(t);
      window.__fp!.render.layers.agents.setTier(t);
    }, t);
    // The swap is done when the models use the file for this tier (low: -lo; medium: the pallets are hi).
    await page.waitForFunction(
      (t) => {
        const m = (window.__fp!.render.layers.world.debug?.() as { models: Record<string, string> }).models;
        return t === 'low' ? m.pallet_loaded.endsWith('-lo.glb') && m.pack_table.endsWith('-lo.glb') : !m.pallet_loaded.endsWith('-lo.glb');
      },
      t,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(300);
    const dbg = await page.evaluate(() => window.__fp!.render.layers.world.debug?.() as { tier: string; failed: string[] });
    expect(dbg.tier).toBe(t);
    expect(dbg.failed).toEqual([]);
    const info = await page.evaluate(() => window.__fp!.render.info());
    expect(info.triangles).toBeGreaterThan(100_000);
  }
  await expectNoErrors(errors);
});

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
  let bytes = 0;
  page.on('response', async (r) => {
    const len = Number((await r.allHeaders())['content-length'] ?? 0);
    bytes += len;
  });
  await openApp(page);
  const kb = bytes / 1024;
  console.log(`first useful view: ${kb.toFixed(1)} KB transferred`);
  expect(kb).toBeLessThanOrEqual(budgets.firstUsefulViewKB);
});

test('draw calls and triangles at the overview stay under budget', async ({ page }) => {
  await openApp(page, '?tier=high');
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => window.__fp!.render.info());
  console.log(`overview: ${info.drawCalls} draw calls, ${info.triangles} triangles`);
  expect(info.drawCalls).toBeLessThanOrEqual(budgets.drawCalls);
  expect(info.triangles).toBeLessThanOrEqual(budgets.triangles);
});

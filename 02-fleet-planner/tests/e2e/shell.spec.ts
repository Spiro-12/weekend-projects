import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

test('loads the warehouse with KPI tiles and moving agents, no errors', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.getByTestId('stage-canvas')).toBeVisible();
  await expect(page.getByTestId('kpi-oph')).toContainText(/\d/);
  const cellsA = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.map((a) => a.cell));
  await page.waitForTimeout(3000);
  const cellsB = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.map((a) => a.cell));
  const moved = cellsA.filter((c, i) => c !== cellsB[i]).length;
  expect(moved).toBeGreaterThan(5);
  await expectNoErrors(errors);
});

test('click an agent to follow it, Escape to pull back out', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => window.__fp!.freeze(true));
  const first = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.find((x) => x.type === 'amr')!.id);
  await page.evaluate((id) => window.__fp!.host.select(0, id), first);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__fp!.render.following())).toBe(true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1600); // fly back to the overview
  expect(await page.evaluate(() => window.__fp!.host.selected.value)).toBeNull();
  expect(await page.evaluate(() => window.__fp!.render.following())).toBe(false);
  // A real click on the agent nearest the middle of the screen (away from the panels).
  const target = await page.evaluate(() => {
    const fp = window.__fp!;
    let best: { id: number; x: number; y: number; d: number } | null = null;
    for (const a of fp.host.live.snapshot.agents) {
      const p = fp.render.project(a.id);
      if (!p) continue;
      const d = Math.hypot(p.x - innerWidth / 2, p.y - innerHeight * 0.55);
      if (!best || d < best.d) best = { id: a.id, x: p.x, y: p.y, d };
    }
    return best!;
  });
  const picked = await page.evaluate(([x, y]) => window.__fp!.render.pick(x, y), [target.x, target.y]);
  expect(picked).not.toBeNull();
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => window.__fp!.host.selected.value);
  expect(sel?.agentId).toBe(picked);
  expect(await page.evaluate(() => window.__fp!.render.following())).toBe(true);
  await expectNoErrors(errors);
});

test('phone layout loads and fits the building', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = await openApp(page);
  await expect(page.getByTestId('kpi-oph')).toBeVisible();
  // A touch phone starts at low. On a GPU-less CI box the adaptive tier may already have stepped down to lite.
  const tier = await page.evaluate(() => window.__fp!.perf.tier);
  expect(process.env.CI ? ['low', 'lite'] : ['low']).toContain(tier);
  await expectNoErrors(errors);
  await ctx.close();
});

test('the Web Worker runner computes results off the main thread', async ({ page }) => {
  const errors = await openApp(page, '?runner=worker');
  await expect(page.getByTestId('kpi-oph')).toContainText(/\d/);
  const r = await page.evaluate(() => ({ kind: window.__fp!.runner.kind, oph: window.__fp!.host.result.value?.kpis.oph, ticks: window.__fp!.host.result.value?.ticks }));
  expect(r.kind).toBe('worker');
  expect(r.oph).toBeGreaterThan(0);
  expect(r.ticks).toBe(18000);
  await expectNoErrors(errors);
});

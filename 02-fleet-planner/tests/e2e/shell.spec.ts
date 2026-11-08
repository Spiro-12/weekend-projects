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
  // Fly closer so agents are big enough to click reliably.
  const target = await page.evaluate(() => {
    const a = window.__fp!.host.live.snapshot.agents.find((x) => x.type === 'amr')!;
    return a.id;
  });
  await page.evaluate((id) => window.__fp!.host.select(0, id), target);
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__fp!.host.selected.value)).toBeNull();
  // Now a real click at the agent's screen position.
  const pos = await page.evaluate((id) => window.__fp!.render.project(id), target);
  expect(pos).not.toBeNull();
  const picked = await page.evaluate(([x, y]) => window.__fp!.render.pick(x, y), [pos!.x, pos!.y]);
  expect(picked).not.toBeNull();
  await page.mouse.click(pos!.x, pos!.y);
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
  expect(await page.evaluate(() => window.__fp!.perf.tier)).toBe('low');
  await expectNoErrors(errors);
  await ctx.close();
});

// Track F: time controls drive the live clock (1x / 10x / 60x, pause) and the sim clock shows it.
import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

/** Ticks per real second over a window, measured in the page. */
const rate = (page: Page, ms: number) =>
  page.evaluate(async (wait) => {
    const live = window.__fp!.host.live;
    const t0 = performance.now();
    const k0 = live.sim.tick;
    await new Promise((r) => setTimeout(r, wait));
    return ((live.sim.tick - k0) * 1000) / (performance.now() - t0);
  }, ms);

test('10x runs the live view about 10 times faster than 1x; pause stops it', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByTestId('speed-1').click();
  const r1 = await rate(page, 3000);
  await page.getByTestId('speed-10').click();
  await expect(page.getByTestId('speed-10')).toHaveAttribute('aria-pressed', 'true');
  const r10 = await rate(page, 2000);
  console.log(`ticks/s: 1x ${r1.toFixed(2)}, 10x ${r10.toFixed(2)} (ratio ${(r10 / r1).toFixed(1)})`);
  expect(r1).toBeGreaterThan(1.2); // 2 ticks/s nominal
  expect(r1).toBeLessThan(2.8);
  expect(r10 / r1).toBeGreaterThan(6);
  expect(r10 / r1).toBeLessThan(14);
  await page.getByTestId('speed-60').click();
  const r60 = await rate(page, 1500);
  expect(r60 / r10).toBeGreaterThan(3.5);

  // The clock shows warehouse time as hh:mm.
  await expect(page.getByTestId('sim-clock')).toHaveText(/^\d\d:\d\d$/);
  const tick = await page.evaluate(() => window.__fp!.host.live.sim.tick);
  const shown = await page.getByTestId('sim-clock').innerText();
  const [h, m] = shown.split(':').map(Number);
  expect(Math.abs(h * 60 + m - tick / 120)).toBeLessThanOrEqual(2);

  await page.getByTestId('pause').click();
  expect(await rate(page, 1000)).toBe(0);
  await page.getByTestId('pause').click();
  expect(await rate(page, 1000)).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

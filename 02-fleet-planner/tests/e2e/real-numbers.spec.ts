// The real numbers end to end (PLAN §9.1): the worker pool runs the real sim + one-brain planner + Track C's KPIs and
// money, with no "demo data". UI behaviour is covered on the toy runner elsewhere; this file checks the real pipeline.
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

test.describe.configure({ timeout: 180_000 });

const settledReal = (page: import('@playwright/test').Page) =>
  page.waitForFunction(
    () => {
      const h = window.__fp!.host;
      return h.result.value != null && h.money.value != null && !h.pending.value && !h.moneyPending.value;
    },
    null,
    { timeout: 150_000 },
  );

test('real numbers: the default keeps up, pays back, and nothing says "demo data"', async ({ page }) => {
  const errors = await openApp(page, '?runner=worker');
  await settledReal(page);
  const r = await page.evaluate(() => {
    const h = window.__fp!.host;
    const k = h.result.value!.kpis;
    const m = h.money.value!;
    return { demo: h.demoData, oph: k.oph, cap: k.capacityOph, keepsUp: k.keepsUp, crew: h.baseline.value?.crew, payback: m.paybackMonths.value, capex: m.capex.value };
  });
  expect(r.demo).toBe(false);
  await expect(page.getByText('demo data', { exact: false })).toHaveCount(0);
  expect(r.keepsUp).toBe(true);
  expect(r.cap).toBeGreaterThanOrEqual(600);
  expect(r.crew).toEqual({ picker: 20, driver: 1 }); // RESULTS.md: the auto-sized people-only crew
  expect(r.payback).toBeGreaterThan(12);
  expect(r.payback).toBeLessThan(48);
  expect(r.capex).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

test('real numbers: People only ⇒ $0 robot cost; adding cart robots back brings the cost back', async ({ page }) => {
  const errors = await openApp(page, '?runner=worker');
  await settledReal(page);
  await page.getByTestId('fleet-people-only').click();
  await settledReal(page);
  const po = await page.evaluate(() => {
    const m = window.__fp!.host.money.value!;
    return { capex: m.capex.value, opex: m.robotOpexYear.value, fleet: window.__fp!.host.settings.value.fleet };
  });
  expect(po.fleet.amr + po.fleet.forklift + po.fleet.humanoid).toBe(0);
  expect(po.capex).toBe(0);
  expect(po.opex).toBe(0);
  await page.evaluate(() => window.__fp!.host.setFleet('amr', 32));
  await settledReal(page);
  expect(await page.evaluate(() => window.__fp!.host.money.value!.capex.value)).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

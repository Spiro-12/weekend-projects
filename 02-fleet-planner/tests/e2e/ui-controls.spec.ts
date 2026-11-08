// Track F: every control changes the host settings (and the live sim), People only, recalculating and flag states.
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';
import { settings, settled } from './ui-helpers.ts';

test('each control changes host.settings as expected', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const start = await settings(page);

  // Steppers and sliders per type.
  await page.getByTestId('fleet-amr-plus').click();
  expect((await settings(page)).fleet.amr).toBe(start.fleet.amr + 1);
  await expect(page.getByTestId('fleet-amr-count')).toHaveText(String(start.fleet.amr + 1));
  await page.getByTestId('fleet-amr-minus').click();
  expect((await settings(page)).fleet.amr).toBe(start.fleet.amr);
  await page.getByTestId('fleet-forklift-slider').fill('7');
  expect((await settings(page)).fleet.forklift).toBe(7);
  await page.getByTestId('fleet-humanoid-plus').click();
  expect((await settings(page)).fleet.humanoid).toBe(start.fleet.humanoid + 1);
  await page.getByTestId('fleet-picker-slider').fill('20');
  expect((await settings(page)).fleet.picker).toBe(20);
  await page.getByTestId('fleet-driver-plus').click();
  expect((await settings(page)).fleet.driver).toBe(start.fleet.driver + 1);
  // The live sim got the same changes as commands.
  await expect
    .poll(() => page.evaluate(() => window.__fp!.host.live.sim.commandLog().map((e) => e.c)))
    .toEqual(
      expect.arrayContaining([
        { t: 'setFleet', type: 'forklift', count: 7 },
        { t: 'setFleet', type: 'picker', count: 20 },
      ]),
    );

  // Order volume.
  await page.getByTestId('order-rate').fill('900');
  expect((await settings(page)).orders.perHour).toBe(900);
  await expect(page.getByTestId('order-rate-value')).toContainText('900');

  // Buy / rent: only the economics change.
  await page.getByTestId('financing-raas').click();
  expect((await settings(page)).economics.financing).toBe('raas');
  await expect(page.getByTestId('financing-raas')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('financing-buy').click();
  expect((await settings(page)).economics.financing).toBe('buy');

  // Scenario picker.
  await page.getByTestId('scenario-small').click();
  await expect.poll(async () => (await settings(page)).layout).toBe('small');
  expect((await settings(page)).id).toBe('small');
  await expect(page.getByTestId('scenario-small')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('scenario-default').click();
  await expect.poll(async () => (await settings(page)).id).toBe('default');

  // Time controls.
  await page.getByTestId('speed-10').click();
  expect(await page.evaluate(() => window.__fp!.host.speed.value)).toBe(10);
  expect(await page.evaluate(() => window.__fp!.host.live.speed)).toBe(10);
  await page.getByTestId('speed-1').click();
  await page.getByTestId('pause').click();
  expect(await page.evaluate(() => window.__fp!.host.paused.value)).toBe(true);
  await expect(page.getByTestId('pause')).toHaveAttribute('aria-label', 'Play');
  await page.getByTestId('pause').click();
  expect(await page.evaluate(() => window.__fp!.host.paused.value)).toBe(false);
  await expectNoErrors(errors);
});

test('People only: upfront cost $0 and the payback is a flag in words', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  await expect(page.getByTestId('money-capex')).not.toHaveText('$0');
  await page.getByTestId('fleet-people-only').click();
  const s = await settings(page);
  expect([s.fleet.amr, s.fleet.forklift, s.fleet.humanoid]).toEqual([0, 0, 0]);
  await settled(page);
  await expect(page.getByTestId('money-capex')).toHaveText('$0');
  await expect(page.getByTestId('money-robot-opex')).toHaveText('$0');
  await expect(page.getByTestId('money-payback')).toHaveText(/Never pays back at these numbers|Can’t keep up with the orders|Can't keep up with the orders/);
  // A flag is words, never a number.
  await expect(page.getByTestId('money-payback')).not.toHaveText(/\d/);
  await expect(page.getByTestId('fleet-people-only')).toHaveAttribute('aria-pressed', 'true');
  // No robot lines left (people lines may stay: they carry pay and trucks).
  for (const t of ['amr', 'forklift', 'humanoid']) await expect(page.getByTestId(`money-line-${t}`)).toHaveCount(0);
  await expect(page.locator('.mline-empty')).toHaveText('No robots in this plan.');
  await expectNoErrors(errors);
});

test('raising cart robots changes the numbers, with a recalculating state in between', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const read = () =>
    Promise.all(['money-capex', 'money-payback', 'money-3yr', 'kpi-util', 'money-line-amr-capex'].map((id) => page.getByTestId(id).innerText()));
  const before = await read();
  const sawRecalculating = page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="kpi-oph"]');
      const money = document.querySelector('[data-testid="money-status"]');
      return !!el?.classList.contains('pending') && el.querySelector('.kpi-note')?.textContent === 'recalculating…' && !!money?.textContent;
    },
    null,
    { polling: 'raf', timeout: 5_000 },
  );
  await page.getByTestId('fleet-amr-slider').fill('61');
  // The tiles and the money panel say so while the runner works (fake runner 120 ms + host debounce 250 ms).
  await sawRecalculating;
  await settled(page);
  await expect(page.getByTestId('kpi-oph')).not.toHaveClass(/pending/);
  const after = await read();
  expect(after[0]).not.toBe(before[0]);
  expect(after[4]).not.toBe(before[4]);
  expect(after.join('|')).not.toBe(before.join('|'));
  await expect(page.getByTestId('money-line-amr')).toContainText('61');
  await expectNoErrors(errors);
});

test('more orders than the fleet can handle: the plan is blamed, savings are words, no fake payback', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  // 700 orders/h: above the default fleet's capacity (about 645 in the fake model), below the people-only crew's
  // (720, the 6 pack stations), so only the plan falls behind and the baseline search stays short (about 10 runs).
  await page.getByTestId('order-rate').fill('700');
  await settled(page);
  expect(await page.evaluate(() => window.__fp!.host.result.value!.kpis.keepsUp)).toBe(false);
  expect(await page.evaluate(() => window.__fp!.host.money.value!.baseline.keepsUp)).toBe(true);
  await expect(page.getByTestId('kpi-oph')).toHaveClass(/warn/);
  await expect(page.getByTestId('kpi-oph-note')).toHaveText('backlog growing');
  await expect(page.getByTestId('money-keepsup')).toContainText("Can't keep up with the orders. This plan ships");
  await expect(page.getByTestId('money-keepsup')).not.toContainText('either');
  await expect(page.getByTestId('money-payback')).toHaveText("Can't keep up with the orders");
  // Savings of a plan that can't keep up: words, never a number (the hover keeps it small, for reference).
  await expect(page.getByTestId('money-3yr')).toHaveText('Not comparable');
  await expect(page.locator('.hero-item').nth(1)).toContainText('this plan falls behind the orders');
  await expect(page.getByTestId('money-savings')).toHaveText('not comparable');
  await page.getByTestId('money-savings').hover();
  const pop = page.getByTestId('explain-popover');
  await expect(pop.getByTestId('explain-flag')).toHaveText('Not comparable: this plan falls behind the orders');
  await expect(pop.getByTestId('explain-reference')).toHaveText(/^For reference only: /);
  await expect(pop.locator('.xp-value')).toHaveCount(0);
  await expect(page.getByTestId('money-baseline')).not.toContainText('can’t keep up');
  await expectNoErrors(errors);
});

test('robots keep up but people only can’t: the blame goes to the people-only crew', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  // The real economics flag payback and the 3-year net when either side falls behind. Here the plan keeps up and
  // the people-only crew doesn't (the strongest sales case), shaped like Track C's report.
  await page.evaluate(() => {
    const h = window.__fp!.host;
    // This plan keeps up (set here like the money below, so the test doesn't depend on the toy model's default fleet).
    const r = h.result.value!;
    h.result.value = { ...r, kpis: { ...r.kpis, keepsUp: true, backlogTrendPerHour: 0, oph: h.settings.value.orders.perHour } };
    const m = h.money.value!;
    const why = "the people-only crew (18 pickers + 3 drivers) can't keep up with the orders: it ships 520.0 orders/h of the 600 ordered";
    h.money.value = {
      ...m,
      baseline: { ...m.baseline, keepsUp: false },
      paybackMonths: { ...m.paybackMonths, value: null, flag: 'doesntKeepUp', formula: `no payback: ${why}` },
      threeYearNet: { ...m.threeYearNet, value: null, flag: 'doesntKeepUp', formula: `no 3-year net: ${why}` },
    };
  });
  expect(await page.evaluate(() => window.__fp!.host.result.value!.kpis.keepsUp)).toBe(true);
  await expect(page.getByTestId('money-people-behind')).toContainText('This plan keeps up; people only can’t.');
  await expect(page.getByTestId('money-people-behind')).toContainText('no like-for-like payback');
  await expect(page.getByTestId('money-keepsup')).toHaveCount(0);
  await expect(page.getByTestId('money-payback')).toHaveText('People only can’t keep up');
  await expect(page.locator('.hero-item').first()).toContainText('so there’s no like-for-like payback');
  await expect(page.locator('.hero-item').first()).not.toContainText('add robots or people');
  await expect(page.getByTestId('money-3yr')).toHaveText('Not comparable');
  await expect(page.locator('.hero-item').nth(1)).toContainText('people only falls behind the orders');
  await expect(page.locator('.hero-item').nth(1)).not.toContainText('shown once the plan keeps up');
  await expect(page.getByTestId('money-savings')).toHaveText('not comparable');
  await expect(page.getByTestId('money-baseline')).toContainText('This crew can’t keep up with these orders.');
  await expect(page.getByTestId('money-baseline')).not.toContainText('either');
  await page.getByTestId('money-payback').hover();
  const pop = page.getByTestId('explain-popover');
  await expect(pop.getByTestId('explain-flag')).toHaveText('The people-only crew can’t keep up with these orders, so there’s no like-for-like payback');
  await expect(pop).not.toContainText('orders pile up');
  await expectNoErrors(errors);
});

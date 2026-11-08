// Track F: every money number explains itself (formula with real numbers, inputs with origin badges, source links,
// estimate notes, what's left out); KPI tiles explain how they are measured; keyboard access.
import { expect, test } from '@playwright/test';
import agents from '../../data/agents.json' with { type: 'json' };
import { expectNoErrors, openApp } from './helpers.ts';
import { emptyFloor, mouseAway, settled, SOURCE_URLS } from './ui-helpers.ts';

test('hovering the payback shows the formula, the worked numbers and real source links', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  await page.getByTestId('money-payback').hover();
  const pop = page.getByTestId('explain-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Pays back in');
  await expect(pop.getByTestId('explain-formula')).not.toBeEmpty();
  // Hovering says how to keep it open.
  await expect(pop.getByTestId('explain-hint')).toHaveText('click to keep open');
  const flag = await page.evaluate(() => window.__fp!.host.money.value!.paybackMonths.flag ?? null);
  if (flag === null) {
    // The formula with the real numbers, once: in the worked line (fake economics) or in the formula itself
    // (Track C's formulas carry the numbers, so no worked line repeats them).
    await expect(pop).toContainText(/\$[\d,]+[^=]*÷[^=]*= [\d.]+ months/);
    const formula = await pop.getByTestId('explain-formula').innerText();
    if (/\$\d/.test(formula)) await expect(pop.getByTestId('explain-worked')).toHaveCount(0);
  } else {
    await expect(pop.getByTestId('explain-flag')).not.toBeEmpty();
  }
  const hrefs = await pop.getByTestId('explain-source').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(SOURCE_URLS.has(h), h).toBe(true);
  // Every input has an origin badge, and every estimate explains itself.
  const rows = pop.locator('.xp-row');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const from of await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-from')))) expect(['source', 'estimate', 'sim', 'user']).toContain(from);
  for (const note of await pop.locator('.xp-row[data-from="estimate"] .xp-row-note').allInnerTexts()) expect(note.trim().length).toBeGreaterThan(5);
  await expect(pop).toContainText('Left out of these numbers: taxes, depreciation');
  // Moving away closes a hover popover.
  await mouseAway(page);
  await expect(pop).toBeHidden();
  await expectNoErrors(errors);
});

test('an estimate input shows its note; a source input links to its source', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const amr = agents.agents.find((a) => a.id === 'amr')!;
  await page.getByTestId('fleet-amr-info').hover();
  const pop = page.getByTestId('explain-popover');
  await expect(pop).toContainText('Based on: Locus Origin');
  const price = pop.locator('.xp-row', { hasText: 'Price to buy' });
  await expect(price).toHaveAttribute('data-from', 'estimate');
  await expect(price.locator('.xp-badge')).toHaveText('estimate');
  await expect(price.locator('.xp-row-note')).toContainText(amr.cost.buyUsd!.note!);
  const sourced = pop.locator('.xp-row[data-from="source"]').first();
  await expect(sourced.locator('.xp-badge')).toHaveText('source');
  expect(SOURCE_URLS.has((await sourced.getByTestId('explain-source').getAttribute('href'))!)).toBe(true);
  // The fleet row shows the estimate badge for the headline price.
  await expect(page.getByTestId('fleet-amr').locator('.est')).toHaveText('estimate');
  await mouseAway(page);

  // Every money number on the panel opens a popover with a formula and badged inputs.
  for (const id of ['money-3yr', 'money-capex', 'money-robot-opex', 'money-labor', 'money-labor-base', 'money-cpo', 'money-cpo-base', 'money-savings', 'money-line-amr-capex', 'money-line-amr-opex']) {
    await page.getByTestId(id).hover();
    await expect(pop, id).toBeVisible();
    await expect(pop.getByTestId('explain-formula'), id).not.toBeEmpty();
    expect(await pop.locator('.xp-row').count(), id).toBeGreaterThan(0);
    await mouseAway(page);
    await expect(pop, id).toBeHidden();
  }
  await expectNoErrors(errors);
});

test('KPI tiles explain how they are measured', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const pop = page.getByTestId('explain-popover');
  for (const id of ['kpi-oph', 'kpi-util', 'kpi-jams', 'kpi-order-time']) {
    await page.getByTestId(id).hover();
    await expect(pop, id).toBeVisible();
    await expect(pop, id).toContainText('Simulated: 30 min warm-up + 2 h measured, same orders every run.');
    await mouseAway(page);
  }
  await page.getByTestId('kpi-jams').hover();
  await expect(pop).toContainText('3 or more robots or people stopped for 10 seconds');
  await mouseAway(page);
  await page.getByTestId('kpi-cost').hover();
  await expect(pop).toContainText('Cost per order');
  await expect(pop).toContainText(/orders an hour|orders\/h/);
  await expectNoErrors(errors);
});

test('keyboard: Tab shows the popover, Enter pins it, Esc closes it (and does not stop following a robot)', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const pop = page.getByTestId('explain-popover');
  const id = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.find((a) => a.type === 'amr')!.id);
  await page.evaluate((i) => window.__fp!.host.select(0, i), id);
  // Hero numbers have an accessible name with their label.
  await expect(page.getByTestId('money-payback')).toHaveAttribute('aria-label', /^Pays back in: /);
  await expect(page.getByTestId('money-3yr')).toHaveAttribute('aria-label', /^Net savings over 3 years: /);
  await page.getByTestId('financing-raas').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('money-payback')).toBeFocused();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  expect(await page.evaluate(() => window.__fp!.host.selected.value?.agentId)).toBe(id);
  await page.keyboard.press('Enter');
  await expect(pop).toBeVisible();
  await expect(pop).toBeFocused();
  await expect(pop.getByTestId('explain-close')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(page.getByTestId('money-payback')).toBeFocused();
  // A pinned popover closes when keyboard focus leaves it, and focus goes back to its number.
  await page.keyboard.press('Enter');
  await expect(pop).toBeFocused();
  for (let i = 0; i < 40 && (await pop.isVisible()); i++) await page.keyboard.press('Tab');
  await expect(pop).toBeHidden();
  await expect(page.getByTestId('money-payback')).toBeFocused();
  // Tab moves on to the next explained text (the 3-year mark, with its survey source), then the next number.
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  if (next === 'money-3yr-mark') {
    await expect(pop).toContainText('80% expected their money back within 3 years');
    await expect(pop.getByTestId('explain-source')).toHaveAttribute('href', /automatedwarehouseonline\.com/);
    await page.keyboard.press('Tab');
  }
  await expect(page.getByTestId('money-3yr')).toBeFocused();
  await expect(pop).toContainText('Net savings over 3 years');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expectNoErrors(errors);
});

test('a click pins the popover until you click elsewhere', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const pop = page.getByTestId('explain-popover');
  await page.getByTestId('money-capex').click();
  await expect(pop).toBeVisible();
  await mouseAway(page);
  await page.waitForTimeout(400);
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Upfront cost');
  const p = emptyFloor(page);
  await page.mouse.click(p.x, p.y);
  await expect(pop).toBeHidden();
  await expectNoErrors(errors);
});

test('a hover popover waits for the pointer to travel to it, so its source links can be clicked', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const pop = page.getByTestId('explain-popover');
  const anchor = (await page.getByTestId('money-payback').boundingBox())!;
  const start = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  await page.mouse.move(start.x, start.y);
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  const lb = (await pop.getByTestId('explain-source').first().boundingBox())!;
  // A slow, steady walk (16 steps × 60 ms ≈ 1 s, longer than the 500 ms grace): first left across the empty part of
  // the card into the popover, then down to its first source link.
  const path = [
    { x: box.x + box.width - 16, y: Math.min(start.y, box.y + box.height - 16) },
    { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 },
  ];
  let from = start;
  for (const to of path) {
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await page.waitForTimeout(60);
    }
    from = to;
  }
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Pays back in');
  await page.waitForTimeout(700);
  await expect(pop).toBeVisible();
  // Moving away still closes it.
  await mouseAway(page);
  await expect(pop).toBeHidden();
  await expectNoErrors(errors);
});

test('while recalculating, a popover says so; before any money, no stray units', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const pop = page.getByTestId('explain-popover');
  await page.evaluate(() => (window.__fp!.host.moneyPending.value = true));
  await expect(page.getByTestId('money-status')).toHaveText('Recalculating…');
  await page.getByTestId('money-capex').hover();
  await expect(pop.getByTestId('explain-stale')).toBeVisible();
  await mouseAway(page);
  await page.evaluate(() => (window.__fp!.host.moneyPending.value = false));
  await page.getByTestId('money-capex').hover();
  await expect(pop).toBeVisible();
  await expect(pop.getByTestId('explain-stale')).toHaveCount(0);
  await mouseAway(page);
  // No money yet: a dash, not "— months".
  await page.evaluate(() => (window.__fp!.host.money.value = null));
  await expect(page.getByTestId('money-payback')).toHaveText('—');
  await expectNoErrors(errors);
});

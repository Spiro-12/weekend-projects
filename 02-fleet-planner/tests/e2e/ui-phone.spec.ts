// Track F on a phone (390×844, touch): one-row KPI chips, bottom-sheet tabs for every panel, tap a money number to
// get its explanation as a bottom sheet, and the follow card above the tabs. Screenshots go to test-results/.
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';
import { settled } from './ui-helpers.ts';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

test('phone: tabs open each panel, a tap on a money number explains it', async ({ page }, info) => {
  const errors = await openApp(page);
  await settled(page);

  // KPI chips: one row that scrolls sideways, short labels that never wrap.
  const tiles = page.locator('[data-testid^="kpi-"].kpi');
  expect(await tiles.count()).toBe(5);
  const boxes = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, h: r.height })));
  for (const b of boxes) {
    expect(Math.abs(b.top - boxes[0].top)).toBeLessThan(1);
    expect(b.h).toBeLessThanOrEqual(40);
  }
  await expect(page.getByTestId('kpi-oph').locator('.short')).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-home.png') });

  const tabs = page.locator('.sheet-tabs button');
  await expect(tabs).toHaveCount(3);
  const expectations: [string, string, string][] = [
    ['Setup', 'left', 'fleet-amr'],
    ['Money', 'right', 'money-payback'],
    ['Live', 'bottom', 'pause'],
  ];
  for (const [label, slot, testid] of expectations) {
    const tab = tabs.filter({ hasText: label });
    await tab.tap();
    await expect(page.locator(`.slot-${slot}`)).toHaveClass(/open/);
    await expect(page.getByTestId(testid)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`phone-${label.toLowerCase()}.png`) });
    if (label === 'Money') {
      await page.getByTestId('money-payback').tap();
      const pop = page.getByTestId('explain-popover');
      await expect(pop).toBeVisible();
      await expect(pop).toHaveClass(/xp-sheet/);
      await expect(pop.getByTestId('explain-formula')).toBeVisible();
      // A bottom sheet: full width, touching the bottom of the screen.
      const pb = (await pop.boundingBox())!;
      expect(pb.width).toBeGreaterThanOrEqual(389);
      expect(Math.abs(pb.y + pb.height - 844)).toBeLessThan(2);
      await page.screenshot({ path: info.outputPath('phone-money-explain.png') });
      await pop.getByTestId('explain-close').tap();
      await expect(pop).toBeHidden();
    }
    await tab.tap();
    await expect(page.locator(`.slot-${slot}`)).not.toHaveClass(/open/);
  }

  // A control works by touch inside its sheet.
  await tabs.filter({ hasText: 'Setup' }).tap();
  const before = await page.evaluate(() => window.__fp!.host.settings.value.fleet.amr);
  await page.getByTestId('fleet-amr-plus').tap();
  expect(await page.evaluate(() => window.__fp!.host.settings.value.fleet.amr)).toBe(before + 1);
  await tabs.filter({ hasText: 'Setup' }).tap();

  // Follow card: a compact card above the tabs, never covering them.
  const id = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.find((a) => a.type === 'driver')!.id); // a driven forklift: in every default fleet
  await page.evaluate((i) => window.__fp!.host.select(0, i), id);
  const card = page.getByTestId('follow-card');
  await expect(card).toBeVisible();
  const cb = (await card.boundingBox())!;
  const tb = (await page.locator('.sheet-tabs').boundingBox())!;
  expect(cb.y + cb.height).toBeLessThanOrEqual(tb.y);
  expect(cb.width).toBeGreaterThan(340);
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('phone-follow.png') });
  await card.getByTestId('follow-close').tap();
  await expect(card).toHaveCount(0);

  // A tap on a KPI chip explains it too; a tap on the dimmed backdrop closes it without touching the 3D view.
  await page.getByTestId('kpi-oph').tap();
  await expect(page.getByTestId('explain-popover')).toContainText('Orders shipped per hour');
  await page.touchscreen.tap(195, 300);
  await expect(page.getByTestId('explain-popover')).toBeHidden();
  expect(await page.evaluate(() => window.__fp!.host.selected.value)).toBeNull();
  await expectNoErrors(errors);
});

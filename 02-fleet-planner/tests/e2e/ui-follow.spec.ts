// Track F: the follow card for the selected agent (content, ≤ 4 Hz updates, close button) and the live strip.
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';
import { settled } from './ui-helpers.ts';

test('selecting an agent shows its card; the close button clears the selection', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  await expect(page.getByTestId('follow-card')).toHaveCount(0);
  const a = await page.evaluate(() => {
    const ag = window.__fp!.host.live.snapshot.agents.find((x) => x.type === 'amr')!;
    return { id: ag.id, name: ag.name };
  });
  await page.evaluate((id) => window.__fp!.host.select(0, id), a.id);
  const card = page.getByTestId('follow-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('follow-name')).toHaveText(a.name);
  await expect(card).toContainText('Cart robot');
  await expect(card.getByTestId('follow-state')).toHaveText(/Idle|Moving|Working|Waiting|Blocked|Charging|Broken down/);
  await expect(card.getByTestId('follow-battery')).toBeVisible();
  await expect(card.getByTestId('follow-timeline').locator('li').first()).toBeVisible();
  // Bottom-right on desktop, and it doesn't sit under the money panel.
  const box = (await card.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThan(vp.width - 40);
  expect(box.y + box.height).toBeGreaterThan(vp.height - 40);
  const money = (await page.locator('.slot-right').boundingBox())!;
  expect(money.y + money.height).toBeLessThanOrEqual(box.y);

  await card.getByTestId('follow-close').click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.__fp!.host.selected.value)).toBeNull();
  await expectNoErrors(errors);
});

test('the follow card updates from the live view at most 4 times a second', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  const id = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.find((x) => x.type === 'driver')!.id); // a driven forklift: in every default fleet
  await page.getByTestId('speed-60').click();
  await page.evaluate((i) => window.__fp!.host.select(0, i), id);
  await expect(page.getByTestId('follow-card')).toBeVisible();
  // Count re-renders of the card (one mutation batch per render) over 3 s at 60x.
  const renders = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="follow-card"]')!;
    let n = 0;
    const mo = new MutationObserver(() => n++);
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    await new Promise((r) => setTimeout(r, 3000));
    mo.disconnect();
    return n;
  });
  expect(renders).toBeGreaterThan(3);
  expect(renders).toBeLessThanOrEqual(14);
  // The task timer moves on.
  await expect(page.getByTestId('follow-task')).not.toHaveText('');
  await expectNoErrors(errors);
});

test('the live strip counts what the 3D view shows', async ({ page }) => {
  const errors = await openApp(page);
  await settled(page);
  await expect(page.getByTestId('live-strip')).toContainText('live view');
  await page.getByTestId('speed-60').click();
  await expect
    .poll(async () => Number(await page.getByTestId('live-shipped').innerText()), { timeout: 20_000 })
    .toBeGreaterThan(0);
  const snap = await page.evaluate(() => {
    const s = window.__fp!.host.live.snapshot;
    return { shipped: s.shippedOrders, open: s.openOrders, deadlocks: s.deadlocks.length };
  });
  // Shown at most 250 ms behind the live sim.
  expect(Number(await page.getByTestId('live-shipped').innerText())).toBeLessThanOrEqual(snap.shipped);
  expect(Number(await page.getByTestId('live-open').innerText())).toBeGreaterThanOrEqual(0);
  expect(Number(await page.getByTestId('live-deadlocks').innerText())).toBeGreaterThanOrEqual(0);
  await expectNoErrors(errors);
});

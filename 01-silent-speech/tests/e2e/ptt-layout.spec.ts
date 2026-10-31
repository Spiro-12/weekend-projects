import { expect, test } from '@playwright/test';

test('holding Space does not change the page layout', async ({ page }) => {
  await page.goto('./?mode=fake');
  await page.waitForTimeout(500);
  const before = await page.locator('header.top').boundingBox();
  await page.keyboard.down('Space');
  await page.waitForTimeout(200);
  const during = await page.locator('header.top').boundingBox();
  const bodyDisplay = await page.evaluate(() => getComputedStyle(document.body).display);
  await page.keyboard.up('Space');
  expect(bodyDisplay).toBe('block');
  expect(during).toEqual(before);
  await expect(page.getByTestId('ptt')).not.toHaveClass(/down/);
});

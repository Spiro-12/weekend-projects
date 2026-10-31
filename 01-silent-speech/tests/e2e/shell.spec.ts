import { expect, test } from '@playwright/test';


test('fake mode streams ~25 Hz', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await page.waitForTimeout(2000);
  const n = await page.evaluate(() => window.__ss.counts.motion ?? 0);
  expect(n).toBeGreaterThanOrEqual(40);
  await expect(page.getByTestId('hz-browser')).toHaveText(/2[3-7]\.\d Hz/);
});

test('holding Space records one clip', async ({ page }) => {
  await page.goto('./?mode=fake');
  await page.waitForTimeout(800);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => window.__ss.counts.clip ?? 0)).toBe(1);
});

test('panels mount and assets use the Pages base path', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?mode=fake');
  await expect(page.locator('[data-panel=about]')).toBeVisible();
  const src = await page.locator('script[type=module]').getAttribute('src');
  expect(src).toMatch(/^\/weekend-projects\/01-silent-speech\/assets\//);
  expect(errors).toEqual([]);
});

test('public visitor (no mode, never used the Mac app) gets a working page fast', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('source-pill')).toHaveText(/(fake|replay) · open/, { timeout: 2500 });
  await expect.poll(() => page.evaluate(() => window.__ss.counts.motion ?? 0)).toBeGreaterThan(10);
});

test('Space still works right after picking a fake sentence', async ({ page }) => {
  await page.goto('./?mode=fake');
  await page.getByTestId('mode-toggle').click(); // the fake picker only shows in Recognize mode
  const sel = page.getByTestId('fake-label');
  await sel.focus();
  await page.keyboard.press('ArrowDown'); // keyboard change keeps focus on the select unless we blur it
  await expect(sel).not.toHaveValue('');
  await page.waitForTimeout(500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => window.__ss.counts.clip ?? 0)).toBe(1);
});

test('fake sentence picker hides in Record mode and shows in Recognize mode', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  await expect(page.getByTestId('fake-label')).toBeHidden();
  await page.getByTestId('mode-toggle').click();
  await expect(page.getByTestId('fake-label')).toBeVisible();
});

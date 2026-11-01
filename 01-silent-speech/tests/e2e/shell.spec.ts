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

test('header rate drops to 0 when data stops', async ({ page }) => {
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('hz-browser')).toHaveText(/2[3-7]\.\d Hz/);
  await page.evaluate(() => window.__ss.app.source?.stop());
  await expect(page.getByTestId('hz-browser')).toHaveText('0.0 Hz', { timeout: 4000 });
});

test('pairing link: #pair= token is kept in memory only and removed from the address bar', async ({ page }) => {
  const token = '0123456789abcdef0123456789abcdef';
  await page.goto(`./?mode=fake#pair=${token}`);
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.__ss.app.pairToken)).toBe(token);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token); // other pages on the origin can't read it
  await page.reload();
  expect(await page.evaluate(() => window.__ss.app.pairToken)).toBeNull(); // must come from the Mac app's link again
});

test('a malformed #pair= is ignored', async ({ page }) => {
  await page.goto('./?mode=fake#pair=not-hex!');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  expect(await page.evaluate(() => localStorage.getItem('ss.pair'))).toBeNull();
});

test('holding Space does not scroll the page (auto repeat keydowns are swallowed too)', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 }); // short window so the page can scroll
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('source-pill')).toHaveText(/fake · open/);
  const prevented = await page.evaluate(() => {
    const ev = (repeat: boolean) => new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat, cancelable: true, bubbles: true });
    const first = ev(false), again = ev(true);
    document.body.dispatchEvent(first);
    document.body.dispatchEvent(again);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', cancelable: true, bubbles: true }));
    return [first.defaultPrevented, again.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  // and a real held key leaves the scroll position alone
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.keyboard.down('Space');
  await page.waitForTimeout(800);
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

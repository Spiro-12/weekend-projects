// Track D: credits. CC BY 4.0 requires the attribution wherever the SimReady models ship, so the in-app About card must
// list every manifest model's credit plus the NVIDIA line (exactly as CREDITS.md words it), and CREDITS.md must name
// every shipped model too.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as {
  models: Record<string, { credit: string; label: string; license: string }>;
};
const credits = readFileSync('CREDITS.md', 'utf8');
/** The NVIDIA paragraph of CREDITS.md as plain text (markdown bold removed). */
const nvidiaLine = credits
  .split('\n')
  .find((l) => l.startsWith('3D models from'))!
  .replace(/\*\*/g, '')
  .trim();

test('CREDITS.md names every shipped model', () => {
  for (const key of Object.keys(manifest.models)) expect(credits, `CREDITS.md mentions ${key}`).toContain(`\`${key}\``);
  expect(credits).toContain('Quaternius');
  expect(credits).toContain('CC BY 4.0');
});

test('About & credits opens and lists every model credit and the NVIDIA line', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await expect(page.getByTestId('about-card')).toHaveCount(0);
  await page.getByTestId('about-button').click();
  const card = page.getByTestId('about-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('about-models')).toBeVisible();
  const nvidia = (await page.getByTestId('about-nvidia').textContent())!.replace(/\s+/g, ' ').trim();
  expect(nvidia).toBe(nvidiaLine.replace(/\s+/g, ' '));
  for (const [key, m] of Object.entries(manifest.models)) {
    const item = page.getByTestId(`about-credit-${key}`);
    await expect(item, key).toHaveCount(1);
    const text = (await item.textContent())!.replace(/\s+/g, ' ');
    expect(text, key).toContain(m.credit.replace(/\s+/g, ' '));
  }
  await expect(page.getByTestId('about-quaternius')).toContainText('CC0 1.0');
  await expect(card.locator('a[href="https://creativecommons.org/licenses/by/4.0/"]').first()).toBeVisible();
  // Escape closes it; the canvas still takes clicks around the button.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expectNoErrors(errors);
});

test('About button sits clear of the phone sheet tabs', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = await openApp(page);
  const btn = await page.getByTestId('about-button').boundingBox();
  expect(btn).not.toBeNull();
  expect(btn!.y).toBeLessThan(100);
  await page.getByTestId('about-button').tap();
  const card = await page.getByTestId('about-card').boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(390);
  await expectNoErrors(errors);
  await ctx.close();
});

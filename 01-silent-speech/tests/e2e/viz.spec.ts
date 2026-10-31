// Charts and 3D head in fake mode.
import { expect, test, type Locator, type Page } from '@playwright/test';

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Hash of the chart pixels plus how many clearly colored (line) pixels there are. */
const snapshot = (canvas: Locator) => canvas.evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let hash = 0, colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    hash = (Math.imul(hash, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) >>> 0;
    if (d[i + 3] > 200 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 80) colored++;
  }
  return { hash, colored, w: c.width };
});

test('chart canvas draws the stream and changes over time', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('./?mode=fake');
  const canvas = page.getByTestId('chart-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('[data-panel=charts]')).toHaveClass(/wide/);
  await expect.poll(async () => (await snapshot(canvas)).colored).toBeGreaterThan(300);
  const a = await snapshot(canvas);
  await page.waitForTimeout(400);
  const b = await snapshot(canvas);
  expect(b.hash).not.toBe(a.hash);
  expect(a.w).toBeGreaterThan(600);
  expect(errors).toEqual([]);
});

test('push to talk is shaded on the chart and the jaw meter reads a value', async ({ page }) => {
  await page.goto('./?mode=fake');
  const canvas = page.getByTestId('chart-canvas');
  await page.waitForTimeout(600);
  await page.keyboard.down('Space');
  await expect(canvas).toHaveAttribute('data-ptt-windows', '1');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => window.__ss.counts.clip ?? 0)).toBe(1);
  await expect(page.getByTestId('jaw-energy')).toHaveAttribute('data-value', /^\d+\.\d{3}$/);
});

test('hovering the chart shows a readout of every channel', async ({ page }) => {
  await page.goto('./?mode=fake');
  const canvas = page.getByTestId('chart-canvas');
  await page.waitForTimeout(1500);
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await canvas.hover({ position: { x: box.width * 0.9, y: box.height * 0.4 } });
  const tip = page.locator('.ss-chart .tip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.row b')).toHaveCount(6);
  await expect(tip.locator('.row b').first()).toHaveText(/^−?\d\.\d{3}$/);
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
});

test('head panel mounts with no page errors', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('./?mode=fake');
  const panel = page.locator('[data-panel=head3d]');
  await panel.scrollIntoViewIfNeeded(); // three.js loads when the panel comes on screen
  await expect(panel).toBeVisible();
  // Either the WebGL canvas shows up, or a friendly "needs WebGL" note.
  await expect.poll(() => panel.evaluate((p) => {
    if (p.querySelector('canvas')) return 'canvas';
    const note = p.querySelector('[data-testid=head3d-note]') as HTMLElement;
    return note && !note.hidden && /WebGL|could not/.test(note.textContent ?? '') ? 'note' : 'loading';
  }), { timeout: 15_000 }).not.toBe('loading');
  await expect(page.getByTestId('head-angles')).toContainText(/Turn \d+°/);
  await page.getByTestId('head-recenter').click();
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('without WebGL the head panel shows a note and angles still update', async ({ page }) => {
  const errors = pageErrors(page);
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (orig as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof orig;
  });
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('head3d-note')).toContainText('needs WebGL');
  await expect(page.locator('[data-panel=head3d] canvas')).toHaveCount(0);
  await expect(page.getByTestId('head-angles')).toContainText(/Turn \d+°/);
  await expect(page.getByTestId('chart-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('one absurd sample does not break the chart scale or the jaw meter', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('./?mode=fake');
  const canvas = page.getByTestId('chart-canvas');
  await expect.poll(async () => (await snapshot(canvas)).colored).toBeGreaterThan(300);
  await page.evaluate(() => {
    const app = window.__ss.app;
    const last = app.ring[app.ring.length - 1];
    app.bus.emit('motion', { seq: last.seq, t: last.t + 0.001, q: [1, 0, 0, 0], rr: [1.6e308, 0, 0], ua: [0, 0, 1.6e308] });
  });
  await page.waitForTimeout(800);
  const a = await snapshot(canvas);
  expect(a.colored).toBeGreaterThan(300); // the lines are still drawn (a NaN scale would draw nothing)
  await page.waitForTimeout(300);
  expect((await snapshot(canvas)).hash).not.toBe(a.hash); // still live
  await expect(page.getByTestId('jaw-energy')).toHaveAttribute('data-value', /^\d+\.\d{3}$/);
  expect(errors).toEqual([]);
});

test('when the data stops, the chart draws a final frame and then holds still', async ({ page }) => {
  await page.goto('./?mode=fake');
  const canvas = page.getByTestId('chart-canvas');
  await expect.poll(async () => (await snapshot(canvas)).colored).toBeGreaterThan(300);
  await page.evaluate(() => window.__ss.app.source!.stop());
  await page.waitForTimeout(3000); // 1.5 s until stale, then the meter settles
  const a = await snapshot(canvas);
  await page.waitForTimeout(1000);
  expect((await snapshot(canvas)).hash).toBe(a.hash);
  await expect(page.getByTestId('jaw-energy')).toHaveAttribute('data-value', '–');
});

test('at 320 px wide nothing overflows', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('./?mode=fake');
  await expect(page.getByTestId('status-browser-hz')).toHaveText(/Hz/);
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push(`page ${document.documentElement.scrollWidth}`);
    for (const sel of ['.ss-status .tile .val', '.ss-status .tile .sub', '.ss-status dd', '.ss-chart .bar', '.ss-head .row']) {
      document.querySelectorAll<HTMLElement>(sel).forEach((n) => { if (n.scrollWidth > n.clientWidth + 1) bad.push(`${sel}: ${n.textContent}`); });
    }
    return bad;
  });
  expect(overflow).toEqual([]);
});

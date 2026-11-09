// Shared helpers for the Track F UI specs (tests/e2e/ui-*.spec.ts).
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export const SOURCE_URLS = new Set((JSON.parse(readFileSync('data/sources.json', 'utf8')) as { sources: { url: string }[] }).sources.map((s) => s.url));

/** Wait until the run, the baseline and the money report are all settled. */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const h = window.__fp!.host;
      return h.result.value != null && h.money.value != null && !h.pending.value && !h.moneyPending.value;
    },
    null,
    { timeout: 20_000 },
  );
  // Let number tweens finish (450 ms).
  await page.waitForTimeout(600);
}

export const settings = (page: Page) => page.evaluate(() => window.__fp!.host.settings.value);

/** Empty floor that no panel or popover covers on a 1440×900 desktop (bottom left, under the fleet panel). */
export const emptyFloor = (page: Page) => {
  const vp = page.viewportSize()!;
  return { x: Math.round(vp.width * 0.14), y: vp.height - 70 };
};

/** Move the mouse to empty floor so no hover popover stays open. */
export async function mouseAway(page: Page): Promise<void> {
  const p = emptyFloor(page);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(350);
}

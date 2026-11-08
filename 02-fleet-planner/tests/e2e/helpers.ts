import { expect, type Page } from '@playwright/test';

/** Open the app and wait for the first useful view. Collects page errors into the returned array. */
export async function openApp(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`./${query}`);
  await page.waitForFunction(() => window.__fp?.perf.firstUsefulViewMs != null, null, { timeout: 30_000 });
  return errors;
}

export async function expectNoErrors(errors: string[]) {
  expect(errors, errors.join('\n')).toEqual([]);
}

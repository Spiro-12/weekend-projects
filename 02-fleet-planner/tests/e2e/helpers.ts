import { expect, type Page } from '@playwright/test';

/** Open the app and wait for the first useful view. Collects page errors into the returned array.
 *  UI tests get the instant toy runner (`?runner=fake`) unless the query names a runner: the live 3D view always runs the
 *  real sim, but real numbers take up to 9 simulations per change, which crawls on CI's GPU-less machines.
 *  tests/e2e/real-numbers.spec.ts covers the real runner end to end. */
export async function openApp(page: Page, query = ''): Promise<string[]> {
  if (!/[?&]runner=/.test(query)) query = query ? `${query}&runner=fake` : '?runner=fake';
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

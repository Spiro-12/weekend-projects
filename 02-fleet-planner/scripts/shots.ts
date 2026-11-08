// Screenshots of key views for the visual check (PLAN §9.4). Usage:
//   npx tsx scripts/shots.ts [--url http://localhost:5180/weekend-projects/02-fleet-planner/] [--out tests/visual/out] [--headed]
// Views: overview, follow (an agent followed in an aisle), phone. Each at a frozen sim tick and a fixed tier.
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const url = arg('--url', 'http://localhost:5180/weekend-projects/02-fleet-planner/');
const out = arg('--out', 'tests/visual/out');
const headed = process.argv.includes('--headed');
const tier = arg('--tier', 'high');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: !headed,
  channel: 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];

async function open(viewport: { width: number; height: number }, extra = '', mobile = false) {
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${url}?tier=${tier}${extra}`);
  await page.waitForFunction(() => window.__fp?.perf.firstUsefulViewMs != null, null, { timeout: 30_000 });
  return { ctx, page };
}

{
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await page.waitForTimeout(4000);
  const gpu = await page.evaluate(() => window.__fp!.perf.gpuName);
  console.log('GPU:', gpu);
  await page.screenshot({ path: `${out}/overview.png` });
  // Follow a robot.
  const id = await page.evaluate(() => window.__fp!.host.live.snapshot.agents.find((a) => a.type === 'amr')?.id ?? 0);
  await page.evaluate((i) => window.__fp!.host.select(0, i), id);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/follow.png` });
  const info = await page.evaluate(() => ({
    ...window.__fp!.render.info(),
    perf: window.__fp!.perf.summary(),
    fuv: window.__fp!.perf.firstUsefulViewMs,
    marks: Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, Math.round(m.startTime)])),
    nav: Math.round((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.domContentLoadedEventEnd ?? 0),
  }));
  console.log(JSON.stringify(info));
  await ctx.close();
}
{
  const { ctx, page } = await open({ width: 390, height: 844 }, '', true);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/phone.png` });
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.error('Page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`shots written to ${out}`);

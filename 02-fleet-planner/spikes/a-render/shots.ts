// Spike screenshots on the real GPU: overview, aisle close-up, split screen -> spikes/a-render/out/*.png,
// plus a compressed high-tier overview -> spikes/a-render/overview.png (committed, <= 500 KB).
// Usage (from 02-fleet-planner/, spike served on 5191): npx tsx spikes/a-render/shots.ts [--url http://localhost:5191/weekend-projects/02-fleet-planner/]
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { launchGpuChromium } from '../../tests/perf/launch.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const argUrl = process.argv.indexOf('--url');
const base = argUrl > 0 ? process.argv[argUrl + 1] : 'http://localhost:5191/weekend-projects/02-fleet-planner/';
mkdirSync(`${here}out`, { recursive: true });

const SHOTS: [string, string][] = [
  ['overview', '?tier=high&freeze=40&pose=overview'],
  ['aisle', '?tier=high&freeze=40&pose=aisle'],
  ['split', '?tier=high&view=split&robots=150&people=40&freeze=40&pose=far'],
  ['skinned', '?tier=high&people=40&peopleMode=skinned&freeze=40&pose=aisle'],
  ['overview-medium', '?tier=medium&freeze=40&pose=overview'],
  ['overview-low', '?tier=low&freeze=40&pose=overview'],
];

const run = await launchGpuChromium({
  context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  log: (m) => console.log(m),
});
try {
  for (const [name, query] of SHOTS) {
    await run.page.goto(base + query);
    await run.page.waitForFunction(() => (window as unknown as { __fp?: { ready: boolean } }).__fp?.ready === true, null, { timeout: 30_000 });
    await run.page.waitForTimeout(800);
    const file = `${here}out/${name}.png`;
    await run.page.screenshot({ path: file });
    const info = await run.page.evaluate(() => (window as unknown as { __fp: { render: { info(): unknown } } }).__fp.render.info());
    console.log(name, JSON.stringify(info));
  }
  // Committed copy: 1440 px wide, palette PNG.
  const out = `${here}overview.png`;
  await sharp(`${here}out/overview.png`).resize({ width: 1440 }).png({ palette: true, quality: 85, effort: 10 }).toFile(out);
  console.log(`overview.png ${(statSync(out).size / 1024).toFixed(0)} KB`);
} finally {
  await run.browser.close();
}

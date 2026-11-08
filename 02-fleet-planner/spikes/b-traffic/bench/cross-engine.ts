// Cross-engine determinism: the same 1 h one-brain and many-brains run in Node, Chromium, Firefox and WebKit.
// Bundles browser/entry.ts with esbuild to an IIFE, loads it into about:blank via Playwright, hashes the final state.
//   npx tsx spikes/b-traffic/bench/cross-engine.ts [hours]
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from '@playwright/test';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../browser/entry.ts';

const hours = Number(process.argv[2] ?? 1);
const outDir = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const bundle = `${outDir}bundle.js`;
await build({
  entryPoints: [fileURLToPath(new URL('../browser/entry.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  outfile: bundle,
  logLevel: 'warning',
});
console.log(`bundle ${(statSync(bundle).size / 1024).toFixed(0)} KB`);

type Res = ReturnType<typeof run>;
const results: Record<string, Res[]> = {};
results.node = [run('central', hours), run('siloed', hours)];
const engines: [string, BrowserType][] = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];
for (const [name, type] of engines) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>spike b</title>');
    await page.addScriptTag({ path: bundle });
    const out: Res[] = [];
    for (const mode of ['central', 'siloed'] as const) {
      out.push(await page.evaluate(([m, h]) => (globalThis as any).fpSpikeB.run(m, h), [mode, hours] as const));
    }
    results[name] = out;
    console.log(name, (await browser.version?.()) ?? '');
  } finally {
    await browser.close();
  }
}
let ok = true;
console.log('| engine | one brain hash | many brains hash | state words | all integers | ms (one / many) |\n|---|---|---|---|---|---|');
for (const [name, [c, s]] of Object.entries(results)) {
  console.log(`| ${name} | ${c.hash} | ${s.hash} | ${c.words} / ${s.words} | ${c.allIntegers && s.allIntegers} | ${c.ms} / ${s.ms} |`);
  if (c.hash !== results.node[0].hash || s.hash !== results.node[1].hash || !c.allIntegers || !s.allIntegers) ok = false;
}
writeFileSync(`${outDir}cross-engine.json`, JSON.stringify(results, null, 1));
console.log(ok ? 'ALL HASHES EQUAL' : 'HASH MISMATCH');
process.exit(ok ? 0 : 1);

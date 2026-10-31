// Train the DTW + kNN model on dataset files and write it for the web app.
//   npx tsx scripts/export-model.ts <dataset.json...> [--opts '{"k":3,"threshold":0.6}'] [--out web/public/models/templates.json]
// Clips are merged across files and deduped by id. Templates are stored preprocessed (DtwKnnModelJSON).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset, DtwKnnOptions } from '../web/src/core/contracts';
import { validateDataset } from '../web/src/core/validate';
import { mergeDatasets } from '../web/src/ml/data';
import { loadModel, train } from '../web/src/ml/index';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function main() {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let opts: DtwKnnOptions = {};
  let out = resolve(ROOT, 'web/public/models/templates.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--opts') opts = JSON.parse(argv[++i]) as DtwKnnOptions;
    else if (a === '--out') out = resolve(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  if (!files.length) throw new Error('usage: npx tsx scripts/export-model.ts <dataset.json...> [--opts JSON] [--out file]');
  const ds = files.map((f) => {
    const d = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    const errs = validateDataset(d);
    if (errs.length) throw new Error(`${f}: not a valid ss-dataset: ${errs.slice(0, 3).join('; ')}`);
    return d as Dataset;
  });
  const { clips, duplicates } = mergeDatasets(ds);
  const model = train(clips, opts);
  const json = model.toJSON();
  loadModel(json); // sanity: it loads back
  const text = JSON.stringify(json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text + '\n');
  const counts = json.labels.map((l) => `${l} ${json.templates.filter((t) => t.label === l).length}`).join(', ');
  console.log(`${clips.length} templates${duplicates ? ` (${duplicates} duplicate ids dropped)` : ''}: ${counts}`);
  console.log(`opts ${JSON.stringify(json.opts)}`);
  console.log(`wrote ${out} (${(text.length / 1024).toFixed(0)} KB)`);
}

main();

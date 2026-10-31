// DTW + kNN cross validation from the command line.
//   npx tsx scripts/eval-dtw.ts <dataset.json...> [--protocol loo|loso|both] [--opts '{"k":1}'] [--no-write]
//   npx tsx scripts/eval-dtw.ts <dataset.json...> --sweep [--protocol loso] [--opts '{...}'] [--json sweep.json]
// No dataset given = shared/fixtures/dataset.synthetic.json.
// Writes ml/results/dtw-knn/<protocol>.json (the Metrics schema, PROTOCOL.md §6) unless --no-write or --sweep.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Channel, Dataset, DtwKnnOptions, Metrics } from '../web/src/core/contracts';
import { DEFAULT_CHANNELS } from '../web/src/core/contracts';
import { validateDataset } from '../web/src/core/validate';
import { mergeDatasets } from '../web/src/ml/data';
import { evaluate } from '../web/src/ml/index';
import { resolveOpts } from '../web/src/ml/preprocess';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
type Protocol = 'loo' | 'loso';

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let protocol: Protocol | 'both' | undefined;
  let opts: DtwKnnOptions = {};
  let sweep = false, write = true;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--protocol') protocol = argv[++i] as Protocol | 'both';
    else if (a === '--opts') opts = JSON.parse(argv[++i]) as DtwKnnOptions;
    else if (a === '--sweep') sweep = true;
    else if (a === '--no-write') write = false;
    else if (a === '--json') json = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 6).join('\n')); process.exit(0); }
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  if (protocol && !['loo', 'loso', 'both'].includes(protocol)) throw new Error('--protocol must be loo, loso or both');
  resolveOpts(opts); // fail fast on bad options
  return { files, protocol, opts, sweep, write, json };
}

function loadClips(files: string[]) {
  const ds = files.map((f) => {
    const d = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    const errs = validateDataset(d);
    if (errs.length) throw new Error(`${f}: not a valid ss-dataset: ${errs.slice(0, 3).join('; ')}`);
    return d as Dataset;
  });
  return mergeDatasets(ds);
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const pad = (s: string | number, n: number) => String(s).padStart(n);
/** Pretty JSON, but arrays of plain numbers / strings stay on one line (confusion rows, labels). */
const prettyJson = (x: unknown) =>
  JSON.stringify(x, null, 2).replace(/\[\s*\n([^[\]{}]*?)\n\s*\]/g, (_, inner: string) => `[${inner.trim().split(/,\s*\n\s*/).join(', ')}]`);

function printMetrics(m: Metrics) {
  const sessions = (m.params as { nSessions?: number }).nSessions;
  console.log(`\ndtw-knn  ${m.protocol.toUpperCase()}  ${m.nClips} clips, ${m.labels.length} labels, ${sessions} session(s)`);
  console.log(`accuracy ${pct(m.accuracy)}   macro F1 ${pct(m.macroF1)}   none false accepts ${pct(m.noneFalseAcceptRate)}   ${m.inferMsPerClip.toFixed(2)} ms/clip`);
  const w = Math.max(...m.labels.map((l) => l.length));
  const short = m.labels.map((l) => l.slice(0, 5));
  console.log(`${' '.repeat(w)}  ${short.map((s) => pad(s, 5)).join(' ')}   (rows true, cols predicted)`);
  m.confusion.forEach((row, i) => console.log(`${m.labels[i].padEnd(w)}  ${row.map((v) => pad(v || '.', 5)).join(' ')}`));
}

const CHANNEL_SETS: Record<string, Channel[]> = {
  all: [...DEFAULT_CHANNELS],
  rr: ['rr.x', 'rr.y', 'rr.z'],
  ua: ['ua.x', 'ua.y', 'ua.z'],
};

function sweep(clips: ReturnType<typeof loadClips>['clips'], base: DtwKnnOptions, protocol: Protocol) {
  const rows: { chans: string; opts: DtwKnnOptions; m: Metrics }[] = [];
  const grid: { chans: string; opts: DtwKnnOptions }[] = [];
  for (const [chans, channels] of Object.entries(CHANNEL_SETS))
    for (const L of [48, 64, 96]) for (const band of [0.05, 0.1, 0.2])
      for (const norm of ['global', 'clip'] as const) for (const k of [1, 3])
        grid.push({ chans, opts: { ...base, channels, L, band, norm, k } });
  grid.forEach((g, i) => {
    process.stderr.write(`\r${i + 1}/${grid.length} ${g.chans} L=${g.opts.L} band=${g.opts.band} ${g.opts.norm} k=${g.opts.k}      `);
    rows.push({ ...g, m: evaluate(clips, g.opts, protocol) });
  });
  process.stderr.write('\n');
  rows.sort((a, b) => b.m.accuracy - a.m.accuracy || b.m.macroF1 - a.m.macroF1 || a.m.noneFalseAcceptRate - b.m.noneFalseAcceptRate);
  console.log(`\nSweep, ${protocol.toUpperCase()}, ${clips.length} clips, ranked by accuracy (then macro F1, then none false accepts)`);
  console.log(' # chans   L  band   norm  k    acc  macroF1  noneFA  ms/clip');
  rows.forEach((r, i) => {
    const o = r.opts;
    console.log(`${pad(i + 1, 2)} ${r.chans.padEnd(5)} ${pad(o.L!, 3)} ${pad(o.band!.toFixed(2), 5)} ${pad(o.norm!, 6)} ${o.k} ${pad(pct(r.m.accuracy), 6)} ${pad(pct(r.m.macroF1), 8)} ${pad(pct(r.m.noneFalseAcceptRate), 7)} ${pad(r.m.inferMsPerClip.toFixed(2), 8)}`);
  });
  return rows.map((r) => ({ channels: r.chans, ...r.opts, accuracy: r.m.accuracy, macroF1: r.m.macroF1, noneFalseAcceptRate: r.m.noneFalseAcceptRate, inferMsPerClip: r.m.inferMsPerClip }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.files.length ? args.files : [resolve(ROOT, 'shared/fixtures/dataset.synthetic.json')];
  if (!args.files.length) console.log('No dataset given, using shared/fixtures/dataset.synthetic.json');
  const { clips, duplicates } = loadClips(files);
  const nSessions = new Set(clips.map((c) => c.session)).size;
  console.log(`${files.length} file(s), ${clips.length} clips${duplicates ? ` (${duplicates} duplicate ids dropped)` : ''}, ${nSessions} session(s)`);
  const datasets = files.map((f) => basename(f));

  if (args.sweep) {
    const table = sweep(clips, args.opts, args.protocol === 'loo' ? 'loo' : 'loso');
    if (args.json) { writeFileSync(args.json, prettyJson(table) + '\n'); console.log(`wrote ${args.json}`); }
    return;
  }
  const protocols: Protocol[] = args.protocol && args.protocol !== 'both' ? [args.protocol] : ['loo', 'loso'];
  for (const p of protocols) {
    if (p === 'loso' && nSessions < 2) { console.log('\nLOSO skipped: needs at least 2 sessions'); continue; }
    const m = evaluate(clips, args.opts, p);
    m.params = { ...m.params, datasets };
    printMetrics(m);
    if (args.write) {
      const dir = resolve(ROOT, 'ml/results/dtw-knn');
      mkdirSync(dir, { recursive: true });
      const out = resolve(dir, `${p}.json`);
      writeFileSync(out, prettyJson(m) + '\n');
      console.log(`wrote ${out.slice(ROOT.length)}`);
    }
  }
}

main();

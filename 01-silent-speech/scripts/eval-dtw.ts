// DTW + kNN cross validation from the command line (PROTOCOL.md §6).
//   npx tsx scripts/eval-dtw.ts <dataset.json...> [--exclude data/raw/exclude.json] [--protocol loo|loso|both] [--opts '{"k":1}'] [--no-write]
//   npx tsx scripts/eval-dtw.ts <dataset.json...> [--exclude ...] --sweep [--jobs 4] [--work-dir dir] [--top 20] [--json sweep.json] [--opts '{...}']
//   npx tsx scripts/eval-dtw.ts <dataset.json...> [--exclude ...] --thresholds [--opts '{...}'] [--json thresholds.json]
// No dataset given = shared/fixtures/dataset.synthetic.json. --exclude skips the clip ids of an ss-exclude file (PROTOCOL §3).
// Writes ml/results/dtw-knn/<protocol>.json (the Metrics schema) unless --no-write, --sweep or --thresholds.
//
// --sweep and --thresholds score a config three ways (LOSO = leave one session out):
//   all   LOSO over every clip. The headline: the sweep ranks by it (tie break: xbud, then macro F1).
//   same  LOSO over the main bud's clips only (the bud with the most clips; real data: s2 + s3, left bud).
//   xbud  cross bud: train on the main bud's clips, test on the other bud's (real data: s2 + s3 -> s1, right bud).
// A clip's bud is its loc as step 0 sees it: 'right', or the left frame (left / default / unknown).
// --work-dir keeps a sweep's progress on disk: run the same command again after a crash and it resumes.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Channel, Clip, Dataset, DtwKnnOptions, Metrics } from '../web/src/core/contracts';
import { DEFAULT_CHANNELS, NONE } from '../web/src/core/contracts';
import { validateDataset } from '../web/src/core/validate';
import { applyExclude, mergeDatasets, parseExclude } from '../web/src/ml/data';
import { crossValidate, holdOut, metricsFrom, type FoldResult } from '../web/src/ml/eval';
import { evaluate } from '../web/src/ml/index';
import { DEFAULT_OPTS, resolveOpts } from '../web/src/ml/preprocess';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
type Protocol = 'loo' | 'loso';

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let protocol: Protocol | 'both' | undefined;
  let opts: DtwKnnOptions = {};
  let sweep = false, thresholds = false, write = true;
  let json: string | undefined, exclude: string | undefined, workDir: string | undefined, shard: [number, number] | undefined;
  let jobs = 1, top = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--protocol') protocol = argv[++i] as Protocol | 'both';
    else if (a === '--opts') opts = JSON.parse(argv[++i]) as DtwKnnOptions;
    else if (a === '--exclude') exclude = argv[++i];
    else if (a === '--sweep') sweep = true;
    else if (a === '--thresholds') thresholds = true;
    else if (a === '--no-write') write = false;
    else if (a === '--json') json = argv[++i];
    else if (a === '--jobs') jobs = Number(argv[++i]);
    else if (a === '--top') top = Number(argv[++i]);
    else if (a === '--work-dir') workDir = argv[++i];
    else if (a === '--shard') { const [k, n] = argv[++i].split('/').map(Number); shard = [k, n]; } // internal (--jobs)
    else if (a === '-h' || a === '--help') { console.log(readFileSync(SELF, 'utf8').split('\n').slice(0, 12).join('\n')); process.exit(0); }
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  if (protocol && !['loo', 'loso', 'both'].includes(protocol)) throw new Error('--protocol must be loo, loso or both');
  if (!(Number.isInteger(jobs) && jobs >= 1)) throw new Error('--jobs must be a whole number >= 1');
  if (shard && !(shard[1] >= 1 && shard[0] >= 0 && shard[0] < shard[1])) throw new Error('--shard must be k/n with 0 <= k < n');
  if (shard && !json) throw new Error('--shard needs --json');
  resolveOpts(opts); // fail fast on bad options
  if (workDir) workDir = resolve(workDir);
  return { files, protocol, opts, sweep, thresholds, write, json, exclude, workDir, jobs, top, shard };
}

function loadClips(files: string[], exclude?: string) {
  const ds = files.map((f) => {
    const d = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    const errs = validateDataset(d);
    if (errs.length) throw new Error(`${f}: not a valid ss-dataset: ${errs.slice(0, 3).join('; ')}`);
    return d as Dataset;
  });
  const merged = mergeDatasets(ds);
  let clips = merged.clips, excluded = 0;
  if (exclude) {
    const r = applyExclude(clips, parseExclude(JSON.parse(readFileSync(exclude, 'utf8')) as unknown));
    clips = r.clips;
    excluded = r.excluded;
  }
  return { clips, duplicates: merged.duplicates, excluded, sources: [...new Set(ds.map((d) => d.source))].sort() };
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

// ---------- the three scores ----------

const budOf = (c: Clip) => (c.loc === 'right' ? 'right' : 'left');

interface Splits { all: Clip[]; same: Clip[] | null; xbud: { train: Clip[]; test: Clip[] } | null; describe: string }

function splitsOf(clips: Clip[]): Splits {
  const right = clips.filter((c) => budOf(c) === 'right'), left = clips.filter((c) => budOf(c) === 'left');
  const [main, other, mainBud] = right.length > left.length ? [right, left, 'right'] : [left, right, 'left'];
  const sessions = (cs: Clip[]) => [...new Set(cs.map((c) => c.session ?? ''))].sort();
  const same = sessions(main).length >= 2 ? main : null;
  const xbud = main.length && other.length ? { train: main, test: other } : null;
  const describe = [
    `all = LOSO over ${clips.length} clips (${sessions(clips).join(', ')})`,
    same ? `same = LOSO over the ${mainBud} bud's ${main.length} clips (${sessions(main).join(', ')})` : 'same = n/a (main bud has < 2 sessions)',
    xbud ? `xbud = train ${sessions(main).join(' + ')} (${mainBud}), test ${sessions(other).join(' + ')} (${mainBud === 'left' ? 'right' : 'left'}, ${other.length} clips)` : 'xbud = n/a (one bud only)',
  ].join('\n');
  return { all: clips, same, xbud, describe };
}

interface Summary { acc: number; macroF1: number; noneFA: number; n: number; ms: number }
const summarize = (r: FoldResult[]): Summary => {
  const m = metricsFrom(r, 'loso', {});
  return { acc: m.accuracy, macroF1: m.macroF1, noneFA: m.noneFalseAcceptRate, n: m.nClips, ms: m.inferMsPerClip };
};

interface Folds { all: FoldResult[]; same: FoldResult[] | null; xbud: FoldResult[] | null }
function runFolds(sp: Splits, o: DtwKnnOptions, sameCache?: Map<string, FoldResult[]>): Folds {
  let same: FoldResult[] | null = null;
  if (sp.same) {
    // budNorm only matters when a clip is mirrored: reuse the 'same' folds across budNorm when none is
    const key = JSON.stringify({ ...resolveOpts(o), budNorm: sp.same.some((c) => c.loc === 'right') ? o.budNorm : '-' });
    same = sameCache?.get(key) ?? crossValidate(sp.same, o, 'loso');
    sameCache?.set(key, same);
  }
  return { all: crossValidate(sp.all, o, 'loso'), same, xbud: sp.xbud ? holdOut(sp.xbud.train, sp.xbud.test, o) : null };
}

// ---------- --sweep ----------

const CHANNEL_SETS: Record<string, Channel[]> = {
  all: [...DEFAULT_CHANNELS],
  rr: ['rr.x', 'rr.y', 'rr.z'],
  ua: ['ua.x', 'ua.y', 'ua.z'],
  'rr+ua.yz': ['rr.x', 'rr.y', 'rr.z', 'ua.y', 'ua.z'],
  'rr+ua.y': ['rr.x', 'rr.y', 'rr.z', 'ua.y'],
  'rr.yz+ua.yz': ['rr.y', 'rr.z', 'ua.y', 'ua.z'],
  'rr.yz+ua.y': ['rr.y', 'rr.z', 'ua.y'],
  'rr.yz': ['rr.y', 'rr.z'],
};
const chansName = (cs: Channel[]) => Object.entries(CHANNEL_SETS).find(([, v]) => v.join() === cs.join())?.[0] ?? cs.join(',');

interface SweepRow { chans: string; opts: Required<DtwKnnOptions>; all: Summary; same: Summary | null; xbud: Summary | null }

/** Base configs (each run with both budNorm values, so the 'same' folds are shared). */
function sweepGrid(base: DtwKnnOptions): DtwKnnOptions[][] {
  const grid: DtwKnnOptions[][] = [];
  for (const channels of Object.values(CHANNEL_SETS))
    for (const L of [48, 64, 96, 128]) for (const band of [0.05, 0.1, 0.2])
      for (const norm of ['global', 'clip'] as const) for (const k of [1, 3])
        grid.push((['mirror', 'none'] as const).map((budNorm) => ({ ...base, channels, L, band, norm, k, budNorm })));
  return grid;
}

/**
 * Runs this shard's base configs. Each finished one is appended to `out` as a JSON line { i, rows }, and configs
 * already in `out` are skipped, so a killed sweep picks up where it stopped (--work-dir).
 */
function sweepShard(sp: Splits, base: DtwKnnOptions, shard: [number, number], out: string | null, progress: () => void): SweepRow[] {
  const rows: SweepRow[] = [];
  const done = new Set<number>();
  if (out && existsSync(out)) {
    for (const line of readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as { i: number; rows: SweepRow[] }; done.add(r.i); rows.push(...r.rows); } catch { /* a line cut off by a kill: redo it */ }
    }
  }
  sweepGrid(base).forEach((group, i) => {
    if (i % shard[1] !== shard[0]) return;
    if (!done.has(i)) {
      const mine: SweepRow[] = [];
      const cache = new Map<string, FoldResult[]>();
      for (const o of group) {
        const f = runFolds(sp, o, cache);
        mine.push({ chans: chansName(o.channels!), opts: resolveOpts(o), all: summarize(f.all), same: f.same && summarize(f.same), xbud: f.xbud && summarize(f.xbud) });
      }
      if (out) appendFileSync(out, JSON.stringify({ i, rows: mine }) + '\n');
      rows.push(...mine);
    }
    progress();
  });
  return rows;
}

/**
 * Runs the shards in `jobs` child processes (same tsx loader) and merges their rows.
 * workDir: keep the shards' progress there (rerun the same command to resume); default a temp dir, removed after.
 */
async function sweepParallel(argv: string[], jobs: number, total: number, workDir?: string): Promise<SweepRow[]> {
  const dir = workDir ?? mkdtempSync(join(tmpdir(), 'eval-dtw-'));
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--jobs', '--json', '--top', '--shard', '--work-dir'].includes(argv[i])) i++;
    else rest.push(argv[i]);
  }
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, 'args.json'), args = JSON.stringify({ rest, jobs });
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') !== args) throw new Error(`--work-dir ${dir} holds a different sweep (args or --jobs changed): use another dir`);
  writeFileSync(stamp, args);
  let done = 0;
  try {
    await Promise.all(Array.from({ length: jobs }, (_, k) => new Promise<void>((ok, fail) => {
      const child = spawn(process.execPath, [...process.execArgv, SELF, ...rest, '--shard', `${k}/${jobs}`, '--json', join(dir, `${k}of${jobs}.jsonl`)], { stdio: ['ignore', 'pipe', 'inherit'] });
      createInterface({ input: child.stdout }).on('line', (l) => {
        if (l === '@step') process.stderr.write(`\r${++done}/${total} configs x 2 budNorm   `);
      });
      child.on('error', fail);
      child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`sweep shard ${k}/${jobs} exited with ${code}`))));
    })));
    process.stderr.write('\n');
    const shardFile = (k: number) => join(dir, `${k}of${jobs}.jsonl`);
    return Array.from({ length: jobs }, (_, k) => (existsSync(shardFile(k)) ? readFileSync(shardFile(k), 'utf8') : '').split('\n').filter((l) => l.trim())
      .flatMap((l) => (JSON.parse(l) as { rows: SweepRow[] }).rows)).flat();
  } finally {
    if (!workDir) rmSync(dir, { recursive: true, force: true });
  }
}

const byRank = (a: SweepRow, b: SweepRow) =>
  b.all.acc - a.all.acc || (b.xbud?.acc ?? -1) - (a.xbud?.acc ?? -1) || b.all.macroF1 - a.all.macroF1 || a.all.noneFA - b.all.noneFA;
const sameOpts = (a: Required<DtwKnnOptions>, b: Required<DtwKnnOptions>) =>
  a.channels.join() === b.channels.join() && a.L === b.L && a.band === b.band && a.norm === b.norm && a.k === b.k && a.budNorm === b.budNorm;

function printSweep(rows: SweepRow[], top: number) {
  const s = (x: Summary | null) => pad(x ? pct(x.acc) : 'n/a', 6);
  console.log('  # chans          L  band   norm k  budNorm    all   same   xbud  macroF1(all)  noneFA(all)  ms/clip');
  const line = (r: SweepRow, rank: number) => {
    const o = r.opts;
    console.log(`${pad(rank, 3)} ${r.chans.padEnd(12)} ${pad(o.L, 3)} ${pad(o.band.toFixed(2), 5)} ${pad(o.norm, 6)} ${o.k} ${pad(o.budNorm, 8)} ${s(r.all)} ${s(r.same)} ${s(r.xbud)} ${pad(pct(r.all.macroF1), 13)} ${pad(pct(r.all.noneFA), 12)} ${pad(r.all.ms.toFixed(2), 8)}`);
  };
  rows.slice(0, top).forEach((r, i) => line(r, i + 1));
  const dflt = resolveOpts({ ...DEFAULT_OPTS });
  const phase1 = resolveOpts({ channels: [...DEFAULT_CHANNELS], L: 64, band: 0.1, norm: 'global', k: 1, budNorm: 'mirror' });
  for (const [what, o] of [['current DEFAULT_OPTS', dflt], ['Phase 1 defaults (6 ch, L 64, band 0.1, global, k 1)', phase1]] as const) {
    const i = rows.findIndex((r) => sameOpts(r.opts, o));
    if (i >= top) { console.log(`... ${what}:`); line(rows[i], i + 1); }
  }
}

// ---------- --thresholds ----------

const THRESHOLDS = Array.from({ length: 20 }, (_, i) => i / 20);

/** Per threshold: correct accepted / wrong accepted (share of sentence clips) and none false accepts (share of none clips). */
function thresholdTable(r: FoldResult[], ts = THRESHOLDS) {
  const S = r.filter((x) => x.label !== NONE), N = r.filter((x) => x.label === NONE);
  return ts.map((t) => {
    const fires = (x: FoldResult) => x.predicted !== NONE && x.confidence >= t;
    return {
      threshold: t,
      correctAccepted: S.length ? S.filter((x) => fires(x) && x.predicted === x.label).length / S.length : 0,
      wrongAccepted: S.length ? S.filter((x) => fires(x) && x.predicted !== x.label).length / S.length : 0,
      noneFalseAccept: N.length ? N.filter(fires).length / N.length : null,
      nSentence: S.length, nNone: N.length,
    };
  });
}

/**
 * Small models (PROTOCOL §6: confidence must drop for clips far from every template): 2 to 4 class models trained
 * on some sessions, tested on another session. `known` = their own sentences, `unknown` = sentences they were not
 * trained on (any accept there is a false action). Same sets and splits as tests/unit/ml/safety-real.test.ts;
 * splits whose sessions aren't loaded are skipped.
 */
const SMALL_SETS = [['text_mom', NONE], ['text_mom', 'volume_up', NONE], ['call_back', 'help', 'calendar', NONE], ['focus_music', 'demo_48h', NONE]];
const SMALL_SPLITS: [string[], string[]][] = [[['s2'], ['s3']], [['s3'], ['s2']], [['s2', 's3'], ['s1']], [['s1', 's2'], ['s3']]];

function smallModels(clips: Clip[], o: DtwKnnOptions) {
  const sess = (s: string[]) => clips.filter((c) => s.includes(c.session ?? ''));
  const known: FoldResult[] = [], unknown: FoldResult[] = [];
  for (const set of SMALL_SETS) for (const [tr, te] of SMALL_SPLITS) {
    const train = sess(tr).filter((c) => set.includes(c.label)), test = sess(te);
    if (new Set(train.map((c) => c.label)).size < 2 || !test.length) continue;
    for (const r of holdOut(train, test, o)) {
      if (!set.includes(r.label)) unknown.push(r);
      else if (r.label !== NONE) known.push(r);
    }
  }
  return { known, unknown };
}

function printThresholds(f: Folds, small: ReturnType<typeof smallModels>) {
  const tabs = Object.entries({ all: f.all, same: f.same, xbud: f.xbud })
    .filter((e): e is [string, FoldResult[]] => e[1] !== null).map(([k, r]) => ({ split: k, rows: thresholdTable(r) }));
  const fires = (r: FoldResult, t: number) => r.predicted !== NONE && r.confidence >= t;
  const smallRows = THRESHOLDS.map((t) => ({
    threshold: t,
    knownCorrectAccepted: small.known.length ? small.known.filter((r) => fires(r, t) && r.predicted === r.label).length / small.known.length : null,
    unknownAccepted: small.unknown.length ? small.unknown.filter((r) => fires(r, t)).length / small.unknown.length : null,
  }));
  const sm = (x: number | null) => (x === null ? 'n/a' : pct(x));
  console.log(`\nthreshold  ${tabs.map((t) => `${t.split} (${t.rows[0].nSentence} sentence, ${t.rows[0].nNone} none)`.padEnd(30)).join('')}small models (${small.known.length} known, ${small.unknown.length} unknown)`);
  console.log(`           ${tabs.map(() => 'correct  wrong  noneFA'.padEnd(30)).join('')}known  unknown accepted`);
  THRESHOLDS.forEach((t, i) => {
    const cells = tabs.map(({ rows }) => {
      const r = rows[i];
      return `${pad(pct(r.correctAccepted), 7)} ${pad(pct(r.wrongAccepted), 6)} ${pad(r.noneFalseAccept === null ? 'n/a' : pct(r.noneFalseAccept), 7)}`.padEnd(30);
    });
    console.log(`${pad(t.toFixed(2), 9)}  ${cells.join('')}${pad(sm(smallRows[i].knownCorrectAccepted), 6)} ${pad(sm(smallRows[i].unknownAccepted), 8)}`);
  });
  return { splits: tabs, small: smallRows };
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const files = args.files.length ? args.files : [resolve(ROOT, 'shared/fixtures/dataset.synthetic.json')];
  const quiet = !!args.shard; // a --jobs child: only progress lines and the JSON file
  const log = (s: string) => { if (!quiet) console.log(s); };
  if (!args.files.length) log('No dataset given, using shared/fixtures/dataset.synthetic.json');
  const { clips, duplicates, excluded, sources } = loadClips(files, args.exclude);
  const nSessions = new Set(clips.map((c) => c.session)).size;
  log(`${files.length} file(s), ${clips.length} clips${duplicates ? ` (${duplicates} duplicate ids dropped)` : ''}${args.exclude ? `, ${excluded} excluded by ${basename(args.exclude)}` : ''}, ${nSessions} session(s)`);
  const datasets = files.map((f) => basename(f));

  if (args.sweep) {
    const sp = splitsOf(clips);
    const total = sweepGrid(args.opts).length;
    if (args.shard) {
      sweepShard(sp, args.opts, args.shard, args.json!, () => console.log('@step'));
      return;
    }
    log(sp.describe);
    let done = 0;
    const rows = args.jobs > 1 ? await sweepParallel(argv, args.jobs, total, args.workDir)
      : sweepShard(sp, args.opts, [0, 1], args.workDir ? join(args.workDir, '0of1.jsonl') : null, () => process.stderr.write(`\r${++done}/${total} configs x 2 budNorm   `));
    if (args.jobs === 1) process.stderr.write('\n');
    rows.sort(byRank);
    console.log(`\nSweep: ${rows.length} configs, ranked by LOSO all (tie break: xbud, macro F1, none false accepts)`);
    printSweep(rows, args.top);
    if (args.json) {
      // one row per line: chans, options, then accuracy / macro F1 / none false accepts for all, same, xbud
      const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
      const brief = (x: Summary | null) => x && { acc: r4(x.acc), macroF1: r4(x.macroF1), noneFA: r4(x.noneFA), n: x.n };
      const lines = rows.map((r) => JSON.stringify({ chans: r.chans, L: r.opts.L, band: r.opts.band, norm: r.opts.norm, k: r.opts.k, budNorm: r.opts.budNorm, all: brief(r.all), same: brief(r.same), xbud: brief(r.xbud) }));
      const head = JSON.stringify({ datasets, exclude: args.exclude ? basename(args.exclude) : null, splits: sp.describe.split('\n'), base: resolveOpts(args.opts), rankedBy: 'all.acc, then xbud.acc, all.macroF1, all.noneFA' }).slice(0, -1);
      writeFileSync(args.json, `${head},"rows":[\n${lines.join(',\n')}\n]}\n`);
      console.log(`wrote ${args.json}`);
    }
    return;
  }

  if (args.thresholds) {
    const sp = splitsOf(clips);
    const o = resolveOpts(args.opts);
    log(sp.describe);
    log(`opts ${JSON.stringify(o)}`);
    const f = runFolds(sp, o);
    for (const [k, r] of Object.entries(f) as [string, FoldResult[] | null][]) if (r) log(`${k}: accuracy ${pct(summarize(r).acc)} (${r.filter((x) => x.label === x.predicted).length}/${r.length})`);
    log('correct / wrong = accepted and right / accepted and wrong, as a share of sentence (non none) clips; noneFA = share of none clips accepted');
    log('small models = 2 to 4 class models on other sessions: known = own sentences accepted and right, unknown = other sentences accepted');
    const tabs = printThresholds(f, smallModels(clips, o));
    if (args.json) { writeFileSync(args.json, prettyJson({ datasets, opts: o, tables: tabs }) + '\n'); console.log(`wrote ${args.json}`); }
    return;
  }

  const protocols: Protocol[] = args.protocol && args.protocol !== 'both' ? [args.protocol] : ['loo', 'loso'];
  for (const p of protocols) {
    if (p === 'loso' && nSessions < 2) { console.log('\nLOSO skipped: needs at least 2 sessions'); continue; }
    const m = evaluate(clips, args.opts, p);
    m.params = { ...m.params, datasets, sources, ...(args.exclude ? { exclude: basename(args.exclude), nExcluded: excluded } : {}) };
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

void main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

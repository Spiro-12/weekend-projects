// Train the DTW + kNN model on dataset files and write it for the web app.
//   npx tsx scripts/export-model.ts <dataset.json...> [--exclude data/raw/exclude.json] [--opts '{"k":3}'] [--decimals 4]
//       [--held-out s3] [--check <dataset.json>...] [--note text] [--out web/public/models/templates.json]
// Clips are merged across files (clip.loc filled in from device.loc), deduped by id, and --exclude ids dropped.
// Templates are stored preprocessed and already bud normalized (DtwKnnModelJSON, left bud frame). A sidecar
// <out>.meta.json says what the model was trained on: { trainedOn, heldOut, opts, nTemplates, createdAt, ... }.
// --decimals N rounds template values to N decimals (a smaller file). --check predicts the clips of other dataset
// files (the held out session) with the exact model and the written one: it fails if any label or accept decision
// differs, and puts the held out accuracy in the meta file. --held-out fails if that session is in the training files.
// --note adds a free text note to the meta file (e.g. how honest the held out score is).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip, Dataset, DtwKnnModelJSON, DtwKnnOptions, Prediction } from '../web/src/core/contracts';
import { NONE } from '../web/src/core/contracts';
import { validateDataset } from '../web/src/core/validate';
import { applyExclude, mergeDatasets, parseExclude } from '../web/src/ml/data';
import { loadModel, train, type DtwKnnModel } from '../web/src/ml/index';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Dataset files (an ss-exclude file in the list is skipped), merged, exclusions dropped. */
function loadClips(files: string[], exclude: Set<string> | null) {
  const used: string[] = [];
  const ds: Dataset[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if ((d as { format?: unknown } | null)?.format === 'ss-exclude') { console.log(`skipped ${basename(f)} (an exclusion list, not a dataset)`); continue; }
    const errs = validateDataset(d);
    if (errs.length) throw new Error(`${f}: not a valid ss-dataset: ${errs.slice(0, 3).join('; ')}`);
    ds.push(d as Dataset);
    used.push(f);
  }
  if (!ds.length) throw new Error('no ss-dataset files given');
  const { clips, duplicates } = mergeDatasets(ds);
  const kept = exclude ? applyExclude(clips, exclude) : { clips, excluded: 0, missing: [] as string[] };
  return { clips: kept.clips, used, duplicates, excluded: kept.excluded, missing: kept.missing, sessions: [...new Set(kept.clips.map((c) => c.session ?? ''))].sort() };
}

/** Rounds every template value to `decimals` (norm stats and options stay exact). */
function roundTemplates(json: DtwKnnModelJSON, decimals: number): DtwKnnModelJSON {
  const f = 10 ** decimals;
  return { ...json, templates: json.templates.map((t) => ({ label: t.label, x: t.x.map((r) => r.map((v) => Math.round(v * f) / f || 0)) })) };
}

function score(preds: Prediction[], clips: Clip[]) {
  const S = clips.filter((c) => c.label !== NONE).length, N = clips.length - S;
  const ok = preds.filter((p, i) => p.label === clips[i].label).length;
  const fired = (p: Prediction, i: number, right: boolean) => p.accepted && clips[i].label !== NONE && (p.label === clips[i].label) === right;
  return {
    nClips: clips.length,
    accuracy: ok / clips.length,
    correctAccepted: S ? preds.filter((p, i) => fired(p, i, true)).length / S : 0,
    wrongAccepted: S ? preds.filter((p, i) => fired(p, i, false)).length / S : 0,
    noneFalseAccept: N ? preds.filter((p, i) => p.accepted && clips[i].label === NONE).length / N : null,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const files: string[] = [], checkFiles: string[] = [];
  let opts: DtwKnnOptions = {};
  let out = resolve(ROOT, 'web/public/models/templates.json');
  let exclude: string | undefined, heldOut: string | undefined, decimals: number | undefined, note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--opts') opts = JSON.parse(argv[++i]) as DtwKnnOptions;
    else if (a === '--out') out = resolve(argv[++i]);
    else if (a === '--exclude') exclude = argv[++i];
    else if (a === '--held-out') heldOut = argv[++i];
    else if (a === '--check') checkFiles.push(argv[++i]);
    else if (a === '--decimals') decimals = Number(argv[++i]);
    else if (a === '--note') note = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  if (!files.length) throw new Error('usage: npx tsx scripts/export-model.ts <dataset.json...> [--exclude file] [--opts JSON] [--decimals N] [--held-out s3] [--check file] [--out file]');
  if (decimals !== undefined && !(Number.isInteger(decimals) && decimals >= 1 && decimals <= 8)) throw new Error('--decimals must be 1..8');
  const ex = exclude ? parseExclude(JSON.parse(readFileSync(exclude, 'utf8')) as unknown) : null;
  const { clips, used, duplicates, excluded, missing, sessions } = loadClips(files, ex);
  if (heldOut && sessions.includes(heldOut)) throw new Error(`--held-out ${heldOut}: that session is in the training files`);
  const test = checkFiles.length ? loadClips(checkFiles, ex) : null;
  const unmatched = test ? missing.filter((id) => test.missing.includes(id)) : missing; // in no loaded file at all
  if (unmatched.length) console.warn(`warning: ${unmatched.length} id(s) in ${basename(exclude!)} match no clip in these files: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ', ...' : ''}`);
  const model = train(clips, opts);
  const exact = model.toJSON();
  const json = decimals === undefined ? exact : roundTemplates(exact, decimals);
  const written: DtwKnnModel = loadModel(JSON.parse(JSON.stringify(json)) as DtwKnnModelJSON); // sanity: it loads back

  let check: (ReturnType<typeof score> & { files: string[]; sessions: string[]; threshold: number }) | undefined;
  if (test) {
    if (heldOut && test.sessions.some((x) => x !== heldOut)) console.warn(`warning: --check files hold sessions ${test.sessions.join(', ')}, not only the held out ${heldOut}`);
    const ids = new Set(clips.map((c) => c.id));
    if (test.clips.some((c) => ids.has(c.id))) throw new Error('--check: some check clips are also training clips');
    const a = test.clips.map((c) => model.predict(c.samples, { loc: c.loc }));
    const b = test.clips.map((c) => written.predict(c.samples, { loc: c.loc }));
    const diff = a.filter((p, i) => p.label !== b[i].label || p.accepted !== b[i].accepted).length;
    const dConf = Math.max(0, ...a.map((p, i) => Math.abs(p.confidence - b[i].confidence)));
    const sa = score(a, test.clips), sb = score(b, test.clips);
    console.log(`check on ${test.clips.length} clips (${test.sessions.join(', ')}): accuracy ${(100 * sa.accuracy).toFixed(1)}% exact, ${(100 * sb.accuracy).toFixed(1)}% as written; ` +
      `${diff} label/accept differences, max confidence change ${dConf.toFixed(5)}`);
    if (diff) throw new Error(`--check: the written model disagrees with the exact one on ${diff} clips (use more --decimals)`);
    check = { ...sb, files: checkFiles.map((f) => basename(f)), sessions: test.sessions, threshold: written.threshold };
  }

  const text = JSON.stringify(json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text + '\n');
  const counts = Object.fromEntries(json.labels.map((l) => [l, json.templates.filter((t) => t.label === l).length]));
  const meta = {
    trainedOn: used.map((f) => basename(f)),
    sessions,
    heldOut: heldOut ?? null,
    exclude: exclude ? basename(exclude) : null,
    nExcluded: excluded,
    opts: json.opts,
    nTemplates: json.templates.length,
    perLabel: counts,
    decimals: decimals ?? null,
    ...(check ? { check } : {}),
    ...(note ? { note } : {}),
    createdAt: new Date().toISOString(),
  };
  const metaOut = out.replace(/\.json$/, '') + '.meta.json';
  writeFileSync(metaOut, JSON.stringify(meta, null, 2) + '\n');
  console.log(`${json.templates.length} templates from ${sessions.join(', ')}${duplicates ? ` (${duplicates} duplicate ids dropped)` : ''}${exclude ? `, ${excluded} excluded` : ''}: ` +
    Object.entries(counts).map(([l, n]) => `${l} ${n}`).join(', '));
  console.log(`opts ${JSON.stringify(json.opts)}`);
  console.log(`wrote ${out} (${(text.length / 1024).toFixed(0)} KB) and ${metaOut}`);
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }

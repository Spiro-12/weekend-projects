// Builds the visitor replay `web/public/replay/demo-session.json` (ss-session v1, PROTOCOL §4) from real takes.
//   npx tsx scripts/build-replay.ts [--dataset data/raw/ss-dataset-s3-*.json] [--exclude data/raw/exclude.json]
//                                   [--session s3] [--seed 20261031] [--out web/public/replay/demo-session.json]
//
// Honesty rules:
// - Only session s3, which is held out from the public model (Track F trains it on s1 + s2). So the replay's
//   score is what a visitor would get on recordings the model never saw.
// - Takes are picked AT RANDOM with a fixed seed (never re-rolled to make the score look better), and ids in
//   exclude.json are skipped.
// - Each take's samples are copied exactly (only `t` is shifted and `seq` renumbered), and the push to talk
//   window is placed so the shell cuts exactly the recorded clip. Only the gaps between takes are made up:
//   quiet motion from the takes' own padding, with the head attitude eased from one take to the next.
// Also writes `demo-session.meta.json` next to it (who, which device, where the takes came from) for the banner.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAD_SEC } from '../web/src/core/app';
import type { Dataset, DatasetClip, HelloMsg, MotionSample, Quat, Session, SessionEvent, StatusMsg } from '../web/src/core/contracts';
import { NONE } from '../web/src/core/contracts';
import { mulberry32, range, shuffle, type Rng } from '../web/src/core/rng';
import { gapPct } from '../web/src/core/synth';
import { validateDataset, validateSession } from '../web/src/core/validate';
import type { ReplayMeta } from '../web/src/sources/replay';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SEED = 20261031;
/** The Mac app version these takes were recorded with (mac/project.yml MARKETING_VERSION). */
const APP_VERSION = '0.1.0';
const EDGE = 0.005; // gap filler stays this far (s) outside every push to talk window
const MARGIN = 1e-5; // decimal margin so float rounding never drops a clip's edge sample (one 5 decimal step)

export interface BuildReplayOpts {
  seed?: number;
  session?: string; // only clips of this session (clip.session ?? dataset.session); default 's3'
  exclude?: string[]; // clip ids to skip
  perClass?: number; // takes per sentence, default 2
  nNone?: number; // `none` takes, default 2
  gap?: [number, number]; // seconds between takes (window to window), default [1.5, 2.5]
  lead?: number; // quiet seconds before the first take, default 1.0
  tail?: number; // quiet seconds after the last take, default 1.0
}

export interface BuildReplayResult {
  session: Session;
  takes: { id: string; label: string; t0: number; t1: number; n: number }[];
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

function normQ(q: number[]): Quat {
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n) as Quat;
}

/** Spherical interpolation between two attitudes (shortest way round). */
export function slerp(a: Quat, b: Quat, u: number): Quat {
  const qa = normQ(a);
  let qb = normQ(b);
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) { qb = qb.map((v) => -v) as Quat; dot = -dot; }
  if (dot > 0.9995) return normQ(qa.map((v, i) => v + (qb[i] - v) * u));
  const th = Math.acos(Math.min(1, dot));
  const s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
  return normQ(qa.map((v, i) => wa * v + wb * qb[i]));
}

const ease = (u: number) => u * u * (3 - 2 * u);

/** Bounces 1, 2, ..., L-1, L-2, ..., 0, 1, ... (index 0 = the sample right next to the take). */
function bounce(j: number, L: number): number {
  if (L <= 1) return 0;
  const P = 2 * (L - 1);
  const x = j % P;
  return x <= L - 1 ? x : P - x;
}

type Motion = Omit<MotionSample, 'seq'>;
const strip = (s: MotionSample): Motion => ({ t: s.t, q: s.q, rr: s.rr, ua: s.ua }); // gravity isn't used: smaller file

/**
 * `n` filler samples at e + DT, e + 2 DT, ... Motion (rr, ua) comes from `after` (A's padding after release,
 * starting next to A) for the first half and `before` (B's padding before press, ending next to B) for the
 * second half; the attitude eases from qa to qb.
 */
function filler(e: number, dt: number, n: number, qa: Quat, qb: Quat, after: MotionSample[], before: MotionSample[]): Motion[] {
  const out: Motion[] = [];
  for (let j = 1; j <= n; j++) {
    const firstHalf = after.length > 0 && (before.length === 0 || j <= n / 2);
    const src = firstHalf
      ? after[after.length - 1 - bounce(j, after.length)]
      : before[bounce(n - j + 1, before.length)];
    out.push({ t: r5(e + j * dt), q: slerp(qa, qb, ease(j / (n + 1))).map(r5) as Quat, rr: src.rr, ua: src.ua });
  }
  return out;
}

/** Picks the takes (seeded, at random) and the order (shuffled, no sentence twice in a row, also across the loop). */
export function pickTakes(clips: DatasetClip[], labels: string[], o: { perClass: number; nNone: number }, rng: Rng): DatasetClip[] {
  const picked: DatasetClip[] = [];
  for (const label of labels) {
    const want = label === NONE ? o.nNone : o.perClass;
    const pool = clips.filter((c) => c.label === label);
    if (pool.length < want) throw new Error(`build-replay: need ${want} takes of ${label}, found ${pool.length}`);
    picked.push(...shuffle(pool, rng).slice(0, want));
  }
  let order = shuffle(picked, rng);
  const ok = (a: DatasetClip[]) => a.every((c, i) => c.label !== a[(i + 1) % a.length].label);
  for (let tries = 0; tries < 1000 && !ok(order); tries++) order = shuffle(picked, rng);
  if (!ok(order)) throw new Error('build-replay: could not order the takes without repeats');
  return order;
}

export function buildReplay(ds: Dataset, opts: BuildReplayOpts = {}): BuildReplayResult {
  const o = {
    seed: DEFAULT_SEED, session: 's3', exclude: [] as string[], perClass: 2, nNone: 2,
    gap: [1.5, 2.5] as [number, number], lead: 1.0, tail: 1.0, ...opts,
  };
  const skip = new Set(o.exclude);
  const clips = ds.clips.filter((c) => (c.session ?? ds.session) === o.session && !skip.has(c.id));
  for (const c of clips) {
    if (c.padSec < PAD_SEC) throw new Error(`build-replay: ${c.id} has padSec ${c.padSec} < ${PAD_SEC}`);
    if (c.samples.length < 10) throw new Error(`build-replay: ${c.id} has only ${c.samples.length} samples`);
  }
  const rng = mulberry32(o.seed);
  const labels = ds.classes.map((c) => c.id);
  const takes = pickTakes(clips, labels, o, rng);
  const locs = new Set(takes.map((c) => c.loc ?? ds.device.loc));
  if (locs.size !== 1) throw new Error('build-replay: takes come from different buds; one session can only have one status.loc');
  const dt = 1 / ds.hz;
  const sorted = (c: DatasetClip) => [...c.samples].sort((a, b) => a.t - b.t);
  const S = takes.map(sorted);
  const after = (k: number) => S[k].filter((s) => s.t > takes[k].releaseT);
  const before = (k: number) => S[k].filter((s) => s.t < takes[k].pressT);
  const qFirst = S[0][0].q, qLast = S[S.length - 1][S[S.length - 1].length - 1].q;
  const qMid = slerp(qLast, qFirst, 0.5).map(r5) as Quat; // the loop seam: tail ends here, lead starts here

  const motion: Motion[] = [];
  const events: SessionEvent[] = [];
  const truth: Session['truth'] = [];
  const out: BuildReplayResult['takes'] = [];
  let e = -dt; // end of the previous push to talk window (the stream starts at t = 0)
  for (let k = 0; k < takes.length; k++) {
    const c = takes[k], s = S[k];
    const G = k === 0 ? o.lead + dt : range(rng, o.gap[0], o.gap[1]);
    const n = Math.floor((G - EDGE) / dt);
    const qa = k === 0 ? qMid : S[k - 1][S[k - 1].length - 1].q;
    motion.push(...filler(e, dt, n, qa, s[0].q, k === 0 ? [] : after(k - 1), before(k)));
    // Window start (press - PAD) lands at w0; the take's own samples keep their exact spacing.
    const w0 = r5(e + G);
    const shift = w0 - (c.pressT - PAD_SEC);
    const moved = s.map((x) => ({ ...strip(x), t: r5(x.t + shift) }));
    let press = r5(c.pressT + shift), release = r5(c.releaseT + shift);
    const first = moved[0].t, last = moved[moved.length - 1].t;
    // The shell cuts [press - PAD, release + PAD]. Keep the edge samples a decimal step inside it.
    if (first - (press - PAD_SEC) < MARGIN / 2) press = r5(first + PAD_SEC - MARGIN);
    if ((release + PAD_SEC) - last < MARGIN / 2) release = r5(last - PAD_SEC + MARGIN);
    if (moved.length && motion.length && moved[0].t <= motion[motion.length - 1].t) throw new Error('build-replay: time went backwards');
    motion.push(...moved);
    events.push({ t: press, kind: 'ptt', down: true }, { t: release, kind: 'ptt', down: false });
    truth.push({ t0: press, t1: release, label: c.label });
    out.push({ id: c.id, label: c.label, t0: press, t1: release, n: moved.length });
    e = r5(release + PAD_SEC);
  }
  const lastTake = takes.length - 1;
  motion.push(...filler(e, dt, Math.floor((o.tail - EDGE) / dt), qLast, qMid, after(lastTake), []));

  const samples: MotionSample[] = motion.map((m, seq) => ({ seq, ...m }));
  const actions = ds.classes.filter((c) => c.action).map((c) => c.action as string);
  const hello: HelloMsg = { type: 'hello', v: 1, app: 'SilentSpeechBridge', version: APP_VERSION, actions, armed: false };
  const status: StatusMsg = {
    type: 'status', headphones: 'connected', auth: 'authorized', loc: [...locs][0], hz: ds.hz,
    gapPct: Math.round(gapPct(samples) * 100) / 100, clients: 1, armed: false, simulated: ds.source !== 'airpods',
  };
  const recordedAt = takes.map((c) => c.startedAt).sort()[0];
  const session: Session = { format: 'ss-session', v: 1, recordedAt, hello, status, samples, events, truth };

  // Self checks: valid file, time always moves forward, each window holds exactly its take.
  const errs = validateSession(session);
  if (errs.length) throw new Error(`build-replay: invalid session: ${errs.join('; ')}`);
  for (let i = 1; i < samples.length; i++) if (!(samples[i].t > samples[i - 1].t)) throw new Error(`build-replay: t not increasing at ${i}`);
  out.forEach((tk, k) => {
    const inWin = samples.filter((x) => x.t >= tk.t0 - PAD_SEC && x.t <= tk.t1 + PAD_SEC);
    if (inWin.length !== tk.n) throw new Error(`build-replay: window ${k} holds ${inWin.length} samples, take ${tk.id} has ${tk.n}`);
  });
  return { session, takes: out };
}

export function metaFor(r: BuildReplayResult, ds: Dataset, from: string, o: Required<Pick<BuildReplayOpts, 'seed' | 'session'>>): ReplayMeta {
  const s = r.session;
  return {
    format: 'ss-session-meta', v: 1,
    matches: { recordedAt: s.recordedAt, nSamples: s.samples.length, nTruth: s.truth.length },
    real: ds.source === 'airpods',
    subject: ds.subject === 'spiro' ? 'Spiro' : ds.subject,
    device: ds.device.model,
    heldOut: true,
    note: `${r.takes.length} takes from recording session ${o.session}, which the public model never trained on, `
      + 'picked at random and stitched into one stream.',
    builtBy: 'scripts/build-replay.ts',
    from, session: o.session, seed: o.seed, takes: r.takes.map((t) => t.id),
  };
}

function findDataset(session: string): string {
  const dir = resolve(ROOT, 'data/raw');
  const hits = readdirSync(dir).filter((f) => f.startsWith(`ss-dataset-${session}-`) && f.endsWith('.json'));
  if (hits.length !== 1) throw new Error(`build-replay: expected one data/raw/ss-dataset-${session}-*.json, found ${hits.length}`);
  return resolve(dir, hits[0]);
}

function main() {
  const argv = process.argv.slice(2);
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  for (const a of argv) if (a.startsWith('--') && !['--dataset', '--exclude', '--session', '--seed', '--out'].includes(a)) throw new Error(`unknown flag ${a}`);
  const session = val('--session') ?? 's3';
  const seed = Number(val('--seed') ?? DEFAULT_SEED);
  const file = resolve(val('--dataset') ?? findDataset(session));
  const exFile = resolve(val('--exclude') ?? resolve(ROOT, 'data/raw/exclude.json'));
  const out = resolve(val('--out') ?? resolve(ROOT, 'web/public/replay/demo-session.json'));
  const ds = JSON.parse(readFileSync(file, 'utf8')) as Dataset;
  const dErr = validateDataset(ds);
  if (dErr.length) throw new Error(`${file}: not a valid ss-dataset: ${dErr.slice(0, 3).join('; ')}`);
  const ex = JSON.parse(readFileSync(exFile, 'utf8')) as { format: string; ids: string[] };
  if (ex.format !== 'ss-exclude' || !Array.isArray(ex.ids)) throw new Error(`${exFile}: not an ss-exclude file`);

  const r = buildReplay(ds, { seed, session, exclude: ex.ids });
  const text = JSON.stringify(r.session) + '\n';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const from = relative(ROOT, file);
  const metaOut = out.replace(/\.json$/, '.meta.json');
  writeFileSync(metaOut, JSON.stringify(metaFor(r, ds, from, { seed, session }), null, 1) + '\n');

  const s = r.session;
  const dur = s.samples[s.samples.length - 1].t - s.samples[0].t;
  for (const [i, tk] of r.takes.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${tk.label.padEnd(12)} ${tk.id}  ${tk.t0.toFixed(2)}–${tk.t1.toFixed(2)} s`);
  }
  console.log(`${r.takes.length} takes from ${basename(file)} (session ${session}, seed ${seed}), ${s.samples.length} samples, ${dur.toFixed(1)} s`);
  console.log(`wrote ${relative(ROOT, out)} (${(text.length / 1024).toFixed(0)} KB) and ${relative(ROOT, metaOut)}`);
  if (text.length > 1024 * 1024) throw new Error('build-replay: replay file is over 1 MB');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

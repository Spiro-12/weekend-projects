// Pure helpers for the enroll panel (no DOM), so they can be unit tested.
import type { ClipEvent } from '../../core/app';
import type { Dataset, DatasetClip, MotionSample, StatusMsg } from '../../core/contracts';
import { NONE } from '../../core/contracts';
import { shuffle, type Rng } from '../../core/rng';

// ---------- clip quality (PROTOCOL §5: clips under 10 samples are rejected at recording) ----------
export const MAX_GAP_PCT = 20;
export const MIN_SAMPLES = 10;
export const MAX_STALL_SEC = 0.5;
export const MAX_CLIP_SEC = 10;

export type RejectCode = 'short' | 'long' | 'stall' | 'gaps' | 'nosignal' | 'early';
export interface Reject { code: RejectCode; message: string }

/** Why a clip can't be used (plain English for the person recording), or null if it is fine. */
export function rejectReason(c: Pick<ClipEvent, 'samples' | 'gapPct'>): Reject | null {
  const s = c.samples;
  if (s.length < MIN_SAMPLES) {
    return { code: 'short', message: 'Too short. Keep holding Space the whole time you mouth the sentence.' };
  }
  const len = s[s.length - 1].t - s[0].t;
  if (len > MAX_CLIP_SEC) {
    return { code: 'long', message: `Too long (${len.toFixed(1)} s). Let go of Space as soon as you finish.` };
  }
  const stall = maxInterval(s);
  if (stall > MAX_STALL_SEC) {
    return { code: 'stall', message: `The AirPods signal froze for ${stall.toFixed(1)} s. Please try again.` };
  }
  if (c.gapPct > MAX_GAP_PCT) {
    return { code: 'gaps', message: `The AirPods signal was patchy (${Math.round(c.gapPct)}% gaps). Keep the Mac close and try again.` };
  }
  return null;
}

// ---------- signal checks (a stalled stream must never be saved as a new take) ----------
export const MAX_CLOCK_SKEW_SEC = 0.5; // wall clock hold vs sample clock hold
export const STALE_AT_RELEASE_MS = 500; // a sample must have arrived this recently when Space is let go
export const COVER_TOL_SEC = 0.1; // samples must reach pressT - pad and releaseT + pad within this

export const NO_SIGNAL = "No signal from the AirPods, check they're in your ears.";

/** What we saw around one push to talk (wall clock), to compare with what the samples say. */
export interface PressFacts {
  wallHoldSec: number; // wall clock time between press and release
  msSinceMotionAtRelease: number; // how old the newest sample was when Space was let go
}

/**
 * Catches a stalled or dead stream: the shell cuts clips by the sample clock, which stops when the
 * AirPods drop out, so a dead stream gives "valid" looking clips made of old samples.
 */
export function signalReject(p: PressFacts, c: Pick<ClipEvent, 'samples' | 'pressT' | 'releaseT' | 'padSec'>): Reject | null {
  const s = c.samples;
  if (!s.length) return { code: 'nosignal', message: NO_SIGNAL };
  if (Math.abs(p.wallHoldSec - (c.releaseT - c.pressT)) > MAX_CLOCK_SKEW_SEC) return { code: 'nosignal', message: NO_SIGNAL };
  if (p.msSinceMotionAtRelease > STALE_AT_RELEASE_MS) return { code: 'nosignal', message: NO_SIGNAL };
  if (s[s.length - 1].t < c.releaseT + c.padSec - COVER_TOL_SEC) return { code: 'nosignal', message: NO_SIGNAL };
  if (s[0].t > c.pressT - c.padSec + COVER_TOL_SEC) {
    return { code: 'early', message: 'Pressed too early: wait a second after the sentence shows, then hold Space.' };
  }
  return null;
}

/** Recording real training data needs the live bridge with real (not simulated) AirPods in. */
export type RecKind = 'real' | 'practice';
export function recKind(source: string | undefined, conn: string, status: StatusMsg | null): RecKind | null {
  if (source === 'fake') return 'practice';
  if (source !== 'live' || conn !== 'open' || !status) return null;
  if (status.headphones !== 'connected' || status.auth !== 'authorized') return null;
  return status.simulated ? 'practice' : 'real';
}
export const PRACTICE_PREFIX = 'fake-';
export const REAL_PREFIX = 's';

export function maxInterval(s: MotionSample[]): number {
  let m = 0;
  for (let i = 1; i < s.length; i++) m = Math.max(m, s[i].t - s[i - 1].t);
  return m;
}

// ---------- prompt order: shuffled blocks, every class once per block ----------
export function makeBlock(ids: string[], avoidFirst: string | null, rng: Rng = Math.random): string[] {
  const b = shuffle(ids, rng);
  if (b.length > 1 && b[0] === avoidFirst) {
    const j = 1 + Math.floor(rng() * (b.length - 1));
    [b[0], b[j]] = [b[j], b[0]];
  }
  return b;
}

/** Hands out prompts. `needed` = classes (in class order) that still need recordings this session. */
export class Prompter {
  private queue: string[] = [];
  private last: string | null = null;
  constructor(private rng: Rng = Math.random) {}

  /** Current prompt, or null when nothing is needed (session done). */
  current(needed: string[]): string | null {
    this.queue = this.queue.filter((id) => needed.includes(id));
    if (!this.queue.length && needed.length) this.queue = makeBlock(needed, this.last, this.rng);
    return this.queue[0] ?? null;
  }

  /** `id` was recorded (or skipped): take it out of the current block. */
  done(id: string) {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
    this.last = id; // the next block won't start with it
  }

  /** Put a class back at the front (redo last). */
  pushFront(id: string) {
    this.queue = [id, ...this.queue.filter((x) => x !== id)];
  }

  reset() { this.queue = []; this.last = null; }
}

// ---------- names ----------
/** Next free `sN` (or `fake-N`) session name. */
export function nextSessionName(existing: Iterable<string>, prefix = REAL_PREFIX): string {
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`);
  let max = 0;
  for (const s of existing) {
    const m = re.exec(s);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/** Safe for file names and ids: letters, digits, - and _. Empty string if nothing is left. */
export function cleanSessionName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/** `ss-dataset-<session>-<yyyymmdd-hhmm>.json`, local time. */
export function exportFileName(session: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const safe = session.replace(/[^A-Za-z0-9_-]+/g, '-') || 'session';
  return `ss-dataset-${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** Short label for the confusion matrix: `text_mom` → `text`, `calendar` → `calen`. */
export const shortLabel = (id: string) => id.split('_')[0].slice(0, 5);

/** What the person should see as the prompt for a class. */
export function promptText(id: string, sentence: string): string {
  return id === NONE ? 'Stay still. Maybe swallow or nod.' : sentence;
}

// ---------- dataset helpers ----------
/** Input rate of one clip: 1 / median sample interval, rounded (dropped samples don't lower it). */
export function clipHz(s: MotionSample[], fallback: number): number {
  const dts: number[] = [];
  for (let i = 1; i < s.length; i++) { const d = s[i].t - s[i - 1].t; if (d > 0) dts.push(d); }
  if (!dts.length) return fallback;
  dts.sort((a, b) => a - b);
  return Math.round(1 / dts[dts.length >> 1]);
}

// ---------- import: never merge someone else's (or fake) data into a local session by name ----------
export interface ImportPlan {
  clips: DatasetClip[]; // with their target session set
  renames: [from: string, to: string][];
  unknown: number; // clips with labels this page doesn't know (dropped)
}

/**
 * Picks a target session per session in the file. A file session goes in as is only if it is the
 * same session (shares clip ids with the local one), or it is new here and is real AirPods data of
 * the same person. Otherwise it is namespaced `<subject>-<session>` (plus `-2`, `-3` if taken).
 * `local` = session name -> clip ids already stored.
 */
export function planImport(ds: Dataset, local: Map<string, Set<string>>, subject: string, known: Set<string>): ImportPlan {
  const keep = ds.clips.filter((c) => known.has(c.label));
  const bySession = new Map<string, DatasetClip[]>();
  for (const c of keep) {
    const s = c.session ?? ds.session;
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s)!.push(c);
  }
  const taken = new Map<string, string>(); // target -> file session, within this import
  const exists = (n: string) => (local.get(n)?.size ?? 0) > 0;
  const renames: [string, string][] = [];
  const out: DatasetClip[] = [];
  const sameSubject = ds.subject.trim().toLowerCase() === subject.trim().toLowerCase();
  for (const [s, cs] of bySession) {
    const overlaps = (n: string) => { const l = local.get(n); return !!l && cs.some((c) => l.has(c.id)); };
    const free = (n: string) => (overlaps(n) || !exists(n)) && (!taken.has(n) || taken.get(n) === s);
    let target = s;
    if (!(overlaps(s) || (sameSubject && ds.source === 'airpods' && free(s)))) {
      const prefix = `${ds.subject.replace(/[^A-Za-z0-9_-]+/g, '-') || 'import'}-`;
      const base = s.startsWith(prefix) ? s : prefix + s;
      target = base;
      for (let n = 2; !free(target); n++) target = `${base}-${n}`;
    }
    taken.set(target, s);
    if (target !== s) renames.push([s, target]);
    for (const c of cs) out.push({ ...c, session: target });
  }
  return { clips: out, renames, unknown: ds.clips.length - keep.length };
}

export const MIN_PER_CLASS = 2;
export const MIN_CLASSES = 2;

/**
 * Clips to score for live accuracy: those of the chosen classes that have at least 2 clips,
 * once at least 2 classes qualify. A class with a single clip can never be guessed right in
 * leave one out, so it would only drag the number down while you are still recording.
 */
export function evalSet(clips: DatasetClip[], labels: string[]): { clips: DatasetClip[]; labels: string[]; sessions: string[] } | null {
  const n = new Map<string, number>();
  for (const c of clips) if (labels.includes(c.label)) n.set(c.label, (n.get(c.label) ?? 0) + 1);
  const ok = labels.filter((l) => (n.get(l) ?? 0) >= MIN_PER_CLASS);
  if (ok.length < MIN_CLASSES) return null;
  const use = clips.filter((c) => ok.includes(c.label));
  const sessions = [...new Set(use.map((c) => c.session ?? ''))];
  return { clips: use, labels: ok, sessions };
}

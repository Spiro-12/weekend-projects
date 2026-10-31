// Pure helpers for the enroll panel (no DOM), so they can be unit tested.
import type { ClipEvent } from '../../core/app';
import type { Clip, DatasetClip, MotionSample } from '../../core/contracts';
import { NONE } from '../../core/contracts';
import { shuffle, type Rng } from '../../core/rng';

// ---------- clip quality (PROTOCOL §5: clips under 10 samples are rejected at recording) ----------
export const MAX_GAP_PCT = 20;
export const MIN_SAMPLES = 10;
export const MAX_STALL_SEC = 0.5;
export const MAX_CLIP_SEC = 10;

export type RejectCode = 'short' | 'long' | 'stall' | 'gaps';
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
/** Next free `sN` session name. */
export function nextSessionName(existing: Iterable<string>): string {
  let max = 0;
  for (const s of existing) {
    const m = /^s(\d+)$/.exec(s);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

/** Safe for file names and ids: letters, digits, - and _. Empty string if nothing is left. */
export function cleanSessionName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/** `ss-dataset-<session>-<yyyymmdd-hhmm>.json`, local time. */
export function exportFileName(session: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ss-dataset-${session}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** Short label for the confusion matrix: `text_mom` → `text`, `calendar` → `calen`. */
export const shortLabel = (id: string) => id.split('_')[0].slice(0, 5);

/** What the person should see as the prompt for a class. */
export function promptText(id: string, sentence: string): string {
  return id === NONE ? 'Stay still. Maybe swallow or nod.' : sentence;
}

// ---------- dataset helpers ----------
/** Measured input rate of the clips (median samples per second, rounded), or `fallback`. */
export function estimateHz(clips: Pick<Clip, 'samples'>[], fallback: number): number {
  const rates = clips
    .map((c) => {
      const s = c.samples;
      const span = s.length > 1 ? s[s.length - 1].t - s[0].t : 0;
      return span > 0 ? (s.length - 1) / span : NaN;
    })
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  if (!rates.length) return fallback;
  const mid = rates.length >> 1;
  const med = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  return Math.round(med);
}

/** Per brief: real AirPods only when the live bridge says it is not simulating. */
export function sourceNow(kind: string | undefined, simulated: boolean | undefined): 'airpods' | 'fake' {
  return kind === 'live' && simulated === false ? 'airpods' : 'fake';
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

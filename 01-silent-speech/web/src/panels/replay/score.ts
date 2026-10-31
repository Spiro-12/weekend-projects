// Replay scoring: which push to talk window a clip belongs to, and whether the model got it right.
// Pure, no DOM. Matching is by clip time (PROTOCOL §4): a clip belongs to a truth window when they overlap by
// most of both lengths, so a visitor's own Space press (or a window cut short by switching tabs) is never
// scored as if it were one of Spiro's takes.
import { PAD_SEC } from '../../core/app';
import { NONE } from '../../core/contracts';

export interface TruthWindow { t0: number; t1: number; label: string }
export type Verdict = 'right' | 'wrong' | 'unsure';
/** upcoming → now → waiting → right / wrong / unsure; or skipped (no clip came) / unscored (no model ran). */
export type WindowState = 'upcoming' | 'now' | 'waiting' | Verdict | 'skipped' | 'unscored';
export const MIN_OVERLAP = 0.8;
/** No clip this long after a window's release (stream seconds): it was interrupted. The shell cuts at release + PAD. */
const SKIP_AFTER = PAD_SEC + 1;

/**
 * Right = what a visitor should see happen. A sentence must be accepted with the right label; for `none`,
 * nothing may be accepted. A sentence that isn't accepted is "not sure" (the app asks to try again): not right.
 */
export function verdict(truth: string, p: { label: string; accepted: boolean }): Verdict {
  if (truth === NONE) return p.accepted ? 'wrong' : 'right';
  if (!p.accepted) return 'unsure';
  return p.label === truth ? 'right' : 'wrong';
}

export function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Index of the window the clip [pressT, releaseT] belongs to, or -1. Needs `minFrac` of both lengths to overlap. */
export function matchWindow(windows: readonly TruthWindow[], pressT: number, releaseT: number, minFrac = MIN_OVERLAP): number {
  let best = -1, bestOv = 0;
  const lc = releaseT - pressT;
  windows.forEach((w, i) => {
    const ov = overlap(pressT, releaseT, w.t0, w.t1);
    const lw = w.t1 - w.t0;
    if (lc <= 0 || lw <= 0) {
      // Zero length window or clip: only an exact hit counts.
      if (Math.abs(pressT - w.t0) < 1e-6 && Math.abs(releaseT - w.t1) < 1e-6 && best < 0) best = i;
      return;
    }
    if (ov >= minFrac * lc && ov >= minFrac * lw && ov > bestOv) { best = i; bestOv = ov; }
  });
  return best;
}

export interface ScoredWindow extends TruthWindow {
  pass: number;
  idx: number;
  state: WindowState;
  clipId?: string;
  predicted?: string;
  confidence?: number;
  accepted?: boolean;
}

export interface Summary { right: number; wrong: number; unsure: number; scored: number; total: number; done: boolean }

/** Windows of the current loop (and the one before, for clips that land after the loop seam and "last loop"). */
export class Scoreboard {
  windows: ScoredWindow[] = [];
  pass = -1;

  /** A new loop started: add its windows (stream times), forget loops older than the previous one. */
  setPass(pass: number, truth: readonly TruthWindow[]) {
    if (pass <= this.pass) return;
    this.pass = pass;
    this.windows = this.windows.filter((w) => w.pass >= pass - 1);
    truth.forEach((w, idx) => this.windows.push({ ...w, pass, idx, state: 'upcoming' }));
  }

  of(pass: number): ScoredWindow[] { return this.windows.filter((w) => w.pass === pass); }

  /** A clip was cut. `willPredict`: the shell is in Recognize mode with a model, so a prediction follows. */
  clip(clipId: string, pressT: number, releaseT: number, willPredict: boolean): ScoredWindow | null {
    const open = this.windows.filter((w) => w.state === 'upcoming' || w.state === 'now');
    const i = matchWindow(open, pressT, releaseT);
    if (i < 0) return null;
    const w = open[i];
    w.clipId = clipId;
    w.state = willPredict ? 'waiting' : 'unscored';
    return w;
  }

  prediction(clipId: string, p: { label: string; confidence: number; accepted: boolean }): ScoredWindow | null {
    const w = this.windows.find((x) => x.clipId === clipId);
    if (!w || (w.state !== 'waiting' && w.state !== 'unscored')) return null;
    w.predicted = p.label;
    w.confidence = p.confidence;
    w.accepted = p.accepted;
    w.state = verdict(w.label, p);
    return w;
  }

  /** The prediction never came (the model threw): don't score it. */
  noPrediction(clipId: string) {
    const w = this.windows.find((x) => x.clipId === clipId);
    if (w && w.state === 'waiting') w.state = 'unscored';
  }

  /** Moves windows along with the playhead (stream time of the newest sample). */
  update(headT: number) {
    for (const w of this.windows) {
      if (w.state === 'upcoming' && headT >= w.t0) w.state = 'now';
      if ((w.state === 'now' || w.state === 'upcoming') && headT > w.t1 + SKIP_AFTER) w.state = 'skipped';
    }
  }

  summary(pass = this.pass): Summary {
    const ws = this.of(pass);
    const n = (s: WindowState) => ws.filter((w) => w.state === s).length;
    const right = n('right'), wrong = n('wrong'), unsure = n('unsure');
    const open = ws.filter((w) => w.state === 'upcoming' || w.state === 'now' || w.state === 'waiting').length;
    return { right, wrong, unsure, scored: right + wrong + unsure, total: ws.length, done: ws.length > 0 && open === 0 };
  }

  /** The window being said now, else the latest one that finished. */
  focus(pass = this.pass): ScoredWindow | null {
    const ws = this.windows.filter((w) => w.pass <= pass);
    const live = ws.find((w) => w.state === 'now' || w.state === 'waiting');
    if (live) return live;
    for (let i = ws.length - 1; i >= 0; i--) if (ws[i].state !== 'upcoming') return ws[i];
    return null;
  }
}

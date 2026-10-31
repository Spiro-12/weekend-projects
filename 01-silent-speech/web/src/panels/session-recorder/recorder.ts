// Session recorder logic (no DOM): captures a live run into an ss-session file (PROTOCOL §4) that the replay
// source can play for visitors: motion, push to talk, predictions and action results, plus `truth` windows
// labelled with the sentence the recorder asked for at press time (that's what the replay scores against).
import type { ClassDef, HelloMsg, MotionSample, Session, SessionEvent, StatusMsg } from '../../core/contracts';
import { NONE } from '../../core/contracts';
import { shuffle, type Rng } from '../../core/rng';
import { validateSession } from '../../core/validate';

/** Stops by itself after this long (about 4 MB at 50 Hz), so a forgotten recording can't eat the tab's memory. */
export const MAX_SEC = 600;

interface Take { t0: number; t1: number; label: string | null; ev: number }

export class SessionRecorder {
  recording = false;
  samples: MotionSample[] = [];
  events: SessionEvent[] = [];
  hello: HelloMsg | null = null;
  status: StatusMsg | null = null;
  recordedAt = '';
  /** Status changed in a way one ss-session can't hold (bud switched, simulate toggled) during the recording. */
  statusChanged = false;
  private takes: Take[] = [];
  private open: { t: number; label: string | null; ev: number } | null = null;

  get nTakes() { return this.takes.length; }
  get nPredictions() { return this.events.filter((e) => e.kind === 'prediction').length; }
  get nActions() { return this.events.filter((e) => e.kind === 'action').length; }
  get seconds() { return this.samples.length > 1 ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0; }
  get hasData() { return this.samples.length > 0; }
  get pttOpen() { return this.open !== null; }

  start(hello: HelloMsg, status: StatusMsg, at = new Date()) {
    this.recording = true;
    this.samples = [];
    this.events = [];
    this.takes = [];
    this.open = null;
    this.hello = { ...hello };
    this.status = { ...status };
    this.statusChanged = false;
    this.recordedAt = at.toISOString();
  }

  /** Ends the recording. A push to talk still held is dropped (its release never came). */
  stop() {
    if (!this.recording) return;
    this.recording = false;
    if (this.open) { this.events.splice(this.open.ev); this.open = null; }
  }

  /** Returns false when the time limit stopped the recording. */
  motion(s: MotionSample): boolean {
    if (!this.recording) return true;
    // Gravity isn't needed to replay or classify: leave it out to keep the file small.
    this.samples.push({ seq: s.seq, t: s.t, q: s.q, rr: s.rr, ua: s.ua });
    if (this.seconds > MAX_SEC) { this.stop(); return false; }
    return true;
  }

  onStatus(s: StatusMsg) {
    if (!this.recording || !this.status) return;
    if (s.loc !== this.status.loc || s.simulated !== this.status.simulated) this.statusChanged = true;
  }

  /** `label`: the sentence on screen when push to talk went down (null = no prompt, not scored on replay). */
  ptt(down: boolean, t: number, label: string | null = null) {
    if (!this.recording) return;
    if (down) {
      if (this.open) return;
      this.open = { t, label, ev: this.events.length };
      this.events.push({ t, kind: 'ptt', down: true });
      return;
    }
    if (!this.open) return; // pressed before Record: not a take
    this.events.push({ t, kind: 'ptt', down: false });
    this.takes.push({ t0: this.open.t, t1: t, label: this.open.label, ev: this.open.ev });
    this.open = null;
  }

  prediction(label: string, confidence: number, t: number) {
    if (this.recording) this.events.push({ t, kind: 'prediction', label, confidence });
  }

  action(action: string, ok: boolean, t: number) {
    if (this.recording) this.events.push({ t, kind: 'action', action, ok });
  }

  /** Forgets the last finished take (its push to talk, prediction and action). Returns it, or null. */
  undoLast(): { label: string | null } | null {
    if (this.open) return null;
    const tk = this.takes.pop();
    if (!tk) return null;
    this.events.splice(tk.ev);
    return { label: tk.label };
  }

  toSession(): Session {
    if (!this.hello || !this.status) throw new Error('nothing recorded yet');
    return {
      format: 'ss-session', v: 1, recordedAt: this.recordedAt,
      hello: this.hello, status: this.status,
      samples: this.samples,
      events: [...this.events].sort((a, b) => a.t - b.t),
      truth: this.takes.filter((t) => t.label !== null).map((t) => ({ t0: t.t0, t1: t.t1, label: t.label as string })),
    };
  }

  /** The file, or the problems that make it unusable. */
  export(): { ok: true; text: string; session: Session } | { ok: false; errors: string[] } {
    if (this.samples.length < 2) return { ok: false, errors: ['no motion recorded'] };
    const session = this.toSession();
    const errors = validateSession(session);
    return errors.length ? { ok: false, errors } : { ok: true, text: JSON.stringify(session) + '\n', session };
  }
}

/**
 * What to say, in order: every sentence `reps` times plus `nNone` "say nothing" takes, shuffled with no
 * sentence twice in a row, ending on `last` (the demo ends on "I created this demo in 48 hours").
 */
export function demoScript(classes: ClassDef[], rng: Rng = Math.random, reps = 2, nNone = 2, last = 'demo_48h'): string[] {
  const ids = classes.map((c) => c.id);
  const all = ids.flatMap((id) => Array.from({ length: id === NONE ? nNone : reps }, () => id));
  const lastOk = ids.includes(last) && all.includes(last);
  const pool = lastOk ? (all.splice(all.indexOf(last), 1), all) : all;
  const tail = lastOk ? [last] : [];
  const ok = (a: string[]) => a.every((x, i) => i === 0 || x !== a[i - 1]);
  let order = [...shuffle(pool, rng), ...tail];
  for (let i = 0; i < 500 && !ok(order); i++) order = [...shuffle(pool, rng), ...tail];
  return order;
}

/** ss-session-YYYYMMDD-HHMM.json (local time). */
export function sessionFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ss-session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

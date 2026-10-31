// Fake AirPods motion. Each sentence becomes a train of "jaw bursts" (one per syllable)
// that tilt the head a tiny bit. Seeded, so tests are reproducible.
// Pure TS, no DOM: used by the browser fake source, the mock bridge, and fixture scripts.
import type {
  ClassDef, Dataset, DatasetClip, HelloMsg, MotionSample, Quat, Session, SessionEvent, StatusMsg, Vec3,
} from './contracts';
import { NONE } from './contracts';
import { gauss, hashString, mulberry32, range, shuffle, type Rng } from './rng';

const NUMBER_WORDS: Record<string, string> = { '48': 'forty eight' };

/** Rough syllable count (vowel groups per word). Good enough for fake data. */
export function countSyllables(sentence: string): number {
  const words = sentence.toLowerCase().replace(/\d+/g, (d) => NUMBER_WORDS[d] ?? 'number').match(/[a-z']+/g) ?? [];
  let n = 0;
  for (const w of words) {
    const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
    n += Math.max(1, groups ? groups.length : 0);
  }
  return Math.max(1, n);
}

interface Syllable { dt: number; a: number; w: number; mix: Vec3; amix: Vec3 }
export interface ClassPattern { id: string; syllables: Syllable[] }

/** Deterministic per class "fingerprint": syllable count from the sentence, timing and shape from the id. */
export function patternFor(cls: ClassDef): ClassPattern {
  const rng = mulberry32(hashString(cls.id));
  const n = cls.id === NONE ? 0 : countSyllables(cls.sentence);
  const syllables: Syllable[] = [];
  for (let i = 0; i < n; i++) {
    syllables.push({
      dt: i === 0 ? 0 : range(rng, 0.17, 0.32),
      a: range(rng, 0.4, 1.0),
      w: range(rng, 0.05, 0.09),
      mix: [1, range(rng, -0.5, 0.5), range(rng, -0.3, 0.3)],
      amix: [range(rng, -0.3, 0.3), range(rng, 0.2, 0.7), range(rng, 0.4, 1.0)],
    });
  }
  return { id: cls.id, syllables };
}

interface Burst { c: number; w: number; a: number; mix: Vec3; amix: Vec3 }

export interface SynthOpts {
  hz?: number; // default 25
  noise?: number; // multiplier, default 1
  gain?: number; // amplitude multiplier (per session variation), default 1
  dropRate?: number; // probability a sample is dropped, default 0
  jitterMs?: number; // timestamp jitter std, default 2
}

const PITCH_AMP = 0.02; // rad per unit burst
const ACC_GAIN = 0.01; // g per rad/s^2
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

function eulerToQuat(pitch: number, roll: number, yaw: number): Quat {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

/** Continuous fake motion stream. Call utter() to schedule a sentence, then sampleAt()/range(). */
export class MotionSynth {
  readonly hz: number;
  private rng: Rng;
  private bursts: Burst[] = [];
  private seq = 0;
  private sway: { f: number; ph: number; amp: number }[];
  private o: Required<SynthOpts>;

  constructor(seed: number, opts: SynthOpts = {}) {
    this.o = { hz: 25, noise: 1, gain: 1, dropRate: 0, jitterMs: 2, ...opts };
    this.hz = this.o.hz;
    this.rng = mulberry32(seed);
    this.sway = [0, 1, 2].map(() => ({ f: range(this.rng, 0.08, 0.3), ph: range(this.rng, 0, 6.28), amp: range(this.rng, 0.01, 0.03) }));
  }

  /** Schedules a sentence starting at startT. Returns when it starts and ends. */
  utter(cls: ClassDef, startT: number): { t0: number; t1: number } {
    const rng = this.rng;
    if (cls.id === NONE) return this.distractor(startT);
    const warp = range(rng, 0.85, 1.15);
    const amp = range(rng, 0.8, 1.2) * this.o.gain;
    let c = startT;
    let last = startT;
    for (const s of patternFor(cls).syllables) {
      c += s.dt * warp * range(rng, 0.92, 1.08);
      this.bursts.push({
        c,
        w: s.w * warp,
        a: s.a * amp * range(rng, 0.85, 1.15),
        mix: s.mix.map((m) => m + gauss(rng) * 0.05) as Vec3,
        amix: s.amix.map((m) => m + gauss(rng) * 0.05) as Vec3,
      });
      last = c;
    }
    return { t0: startT, t1: last + 0.15 };
  }

  /** "none": a swallow (one bump), a nod (slow big tilt), or nothing. */
  private distractor(startT: number): { t0: number; t1: number } {
    const rng = this.rng;
    const kind = rng();
    if (kind < 0.35) {
      this.bursts.push({ c: startT + range(rng, 0.2, 0.6), w: 0.12, a: range(rng, 0.3, 0.7), mix: [1, 0, 0], amix: [0, 0.3, 0.5] });
    } else if (kind < 0.65) {
      this.bursts.push({ c: startT + 0.4, w: 0.35, a: range(rng, 1.5, 3), mix: [1, gauss(rng) * 0.3, 0], amix: [0, 0.2, 0.2] });
    }
    return { t0: startT, t1: startT + range(rng, 0.8, 1.6) };
  }

  /** Motion at time t. Returns null if this sample is "dropped" (seq still advances). */
  sampleAt(t: number): MotionSample | null {
    const seq = this.seq++;
    if (this.o.dropRate > 0 && this.rng() < this.o.dropRate) return null;
    const n = this.o.noise;
    let pitch = 0;
    const rrB: Vec3 = [0, 0, 0], uaB: Vec3 = [0, 0, 0];
    for (const b of this.bursts) {
      const u = (t - b.c) / b.w;
      if (Math.abs(u) > 5) continue;
      const e = Math.exp(-0.5 * u * u) * b.a * PITCH_AMP;
      const dp = (-u / b.w) * e;
      const d2p = ((u * u - 1) / (b.w * b.w)) * e;
      pitch += e;
      for (let i = 0; i < 3; i++) { rrB[i] += b.mix[i] * dp; uaB[i] += b.amix[i] * d2p * ACC_GAIN; }
    }
    const [s0, s1, s2] = this.sway;
    const sw = (s: typeof s0) => s.amp * Math.sin(2 * Math.PI * s.f * t + s.ph);
    const swd = (s: typeof s0) => s.amp * 2 * Math.PI * s.f * Math.cos(2 * Math.PI * s.f * t + s.ph);
    const rng = this.rng;
    const rr: Vec3 = [
      rrB[0] + swd(s0) + gauss(rng) * 0.02 * n,
      rrB[1] + swd(s1) + gauss(rng) * 0.02 * n,
      rrB[2] + swd(s2) + gauss(rng) * 0.02 * n,
    ];
    const ua: Vec3 = [uaB[0] + gauss(rng) * 0.004 * n, uaB[1] + gauss(rng) * 0.004 * n, uaB[2] + gauss(rng) * 0.004 * n];
    const q = eulerToQuat(pitch + sw(s0), sw(s1), sw(s2));
    const tj = t + gauss(rng) * (this.o.jitterMs / 1000);
    return { seq, t: r5(tj), q: q.map(r5) as Quat, rr: rr.map(r5) as Vec3, ua: ua.map(r5) as Vec3 };
  }

  /** All samples on the hz grid in [t0, t1). */
  range(t0: number, t1: number): MotionSample[] {
    const out: MotionSample[] = [];
    const dt = 1 / this.hz;
    for (let k = Math.ceil(t0 / dt); k * dt < t1; k++) {
      const s = this.sampleAt(k * dt);
      if (s) out.push(s);
    }
    return out;
  }

  /** Forget bursts that ended before t (keeps long streams fast). */
  prune(t: number) {
    this.bursts = this.bursts.filter((b) => b.c + 5 * b.w > t);
  }
}

export function gapPct(samples: MotionSample[], hz = 25): number {
  if (samples.length < 2) return 0;
  let gaps = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].t - samples[i - 1].t > 1.5 / hz) gaps++;
  return r5((100 * gaps) / (samples.length - 1));
}

export interface SynthClipOpts extends SynthOpts { padSec?: number; session?: string; rep?: number; id?: string }

/** One push to talk clip, like the enroll panel would record. */
export function synthClip(cls: ClassDef, seed: number, o: SynthClipOpts = {}): DatasetClip {
  const padSec = o.padSec ?? 0.3;
  const synth = new MotionSynth(seed, o);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const pressT = 10;
  const { t1 } = synth.utter(cls, pressT + range(rng, 0.1, 0.3));
  const releaseT = r5(t1 + range(rng, 0.1, 0.3));
  const samples = synth.range(pressT - padSec, releaseT + padSec);
  return {
    id: o.id ?? `${o.session ?? 'x'}-${cls.id}-${o.rep ?? 0}`,
    label: cls.id,
    rep: o.rep ?? 0,
    session: o.session,
    startedAt: new Date(Date.UTC(2026, 9, 31, 12, 0, 0) + seed).toISOString(),
    pressT,
    releaseT,
    padSec,
    quality: { gapPct: gapPct(samples, synth.hz), nSamples: samples.length },
    samples,
  };
}

export interface SynthDatasetOpts { classes: ClassDef[]; reps: number; sessions: number; seed: number; subject?: string; dropRate?: number }

/** Synthetic dataset with several "sessions" (different gain/noise each), clips tagged with clip.session. */
export function synthDataset(o: SynthDatasetOpts): Dataset {
  const rng = mulberry32(o.seed);
  const clips: DatasetClip[] = [];
  for (let s = 1; s <= o.sessions; s++) {
    const gain = range(rng, 0.85, 1.15);
    const noise = range(rng, 0.8, 1.3);
    const order = shuffle(o.classes.flatMap((c) => Array.from({ length: o.reps }, (_, r) => ({ c, r }))), rng);
    for (const { c, r } of order) {
      clips.push(synthClip(c, Math.floor(rng() * 2 ** 31), { gain, noise, session: `s${s}`, rep: r, dropRate: o.dropRate }));
    }
  }
  return {
    format: 'ss-dataset', v: 1, createdAt: '2026-10-31T12:00:00.000Z', session: 'synthetic',
    subject: o.subject ?? 'synthetic', source: 'fake', device: { model: 'synth', loc: 'left' }, hz: 25,
    classes: o.classes, clips,
  };
}

export function fakeHello(actions: string[], armed = false): HelloMsg {
  return { type: 'hello', v: 1, app: 'SilentSpeechBridge', version: '0.0.0-fake', actions, armed };
}

export function fakeStatus(p: Partial<StatusMsg> = {}): StatusMsg {
  return {
    type: 'status', headphones: 'connected', auth: 'authorized', loc: 'left', hz: 25, gapPct: 0,
    clients: 1, armed: false, simulated: true, ...p,
  };
}

/** Continuous replay session: each non-none class `reps` times plus some none, in shuffled order. */
export function synthSession(classes: ClassDef[], seed: number, reps = 2): Session {
  const rng = mulberry32(seed);
  const synth = new MotionSynth(seed + 1);
  const order = shuffle(classes.flatMap((c) => Array.from({ length: c.id === NONE ? 1 : reps }, () => c)), rng);
  const events: SessionEvent[] = [];
  const truth: Session['truth'] = [];
  let t = 1.5;
  for (const c of order) {
    const down = r5(t);
    const { t1 } = synth.utter(c, t + range(rng, 0.1, 0.25));
    const up = r5(t1 + range(rng, 0.1, 0.25));
    events.push({ t: down, kind: 'ptt', down: true }, { t: up, kind: 'ptt', down: false });
    truth.push({ t0: down, t1: up, label: c.id });
    t = up + range(rng, 1.5, 2.5);
  }
  const samples = synth.range(0, t + 1);
  const actions = classes.filter((c) => c.action).map((c) => c.action as string);
  return {
    format: 'ss-session', v: 1, recordedAt: '2026-10-31T12:00:00.000Z',
    hello: fakeHello(actions), status: fakeStatus(), samples, events, truth,
  };
}

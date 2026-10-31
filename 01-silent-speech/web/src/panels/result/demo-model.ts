// Demo model for fake mode: trained in the browser on made-up motion from the same generator the fake
// source uses (core/synth), cut the way the shell cuts a push to talk. Spiro's public model is trained on
// real AirPods data and doesn't know fake motion at all (offline: 0 of 160 fake clips accepted).
// Never "your model": it can never run actions. No DOM here.
import { PAD_SEC } from '../../core/app';
import type { ClassDef, Clip } from '../../core/contracts';
import { mulberry32, range } from '../../core/rng';
import { MotionSynth } from '../../core/synth';

/** The fake source starts the sentence this long after Space goes down (sources/fake.ts). */
export const FAKE_SPEAK_DELAY = 0.15;
/** Takes per sentence. With the slack below: about 95% right on fake holds, no wrong accepts, ~90 ms to train. */
export const DEMO_REPS = 14;
/** People let go 0 to 1.4 s after the sentence ends; templates spread evenly over that, so any hold works. */
export const DEMO_SLACK: [number, number] = [0, 1.4];
export const DEMO_SEED = 4242;

/** Deterministic demo clips: every class (including 'none') DEMO_REPS times. */
export function demoClips(classes: ClassDef[], reps = DEMO_REPS, seed = DEMO_SEED): Clip[] {
  const rng = mulberry32(seed);
  const [lo, hi] = DEMO_SLACK;
  const out: Clip[] = [];
  for (const c of classes) {
    for (let r = 0; r < reps; r++) {
      // Per take variation like a new sitting (gain, noise), as synthDataset does per session.
      const synth = new MotionSynth(Math.floor(rng() * 2 ** 31), { gain: range(rng, 0.85, 1.15), noise: range(rng, 0.8, 1.3) });
      const press = 10;
      const { t1 } = synth.utter(c, press + FAKE_SPEAK_DELAY);
      const release = t1 + lo + ((hi - lo) * (r + rng())) / reps;
      out.push({ id: `demo-${c.id}-${r}`, label: c.id, session: 'demo', samples: synth.range(press - PAD_SEC, release + PAD_SEC) });
    }
  }
  return out;
}

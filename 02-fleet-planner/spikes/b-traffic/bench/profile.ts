import { createSim, makeOpts } from '../src/index.ts';

const mode = (process.argv[2] ?? 'central') as 'central' | 'siloed';
const layout = process.argv[3] ?? 'default';
const sim = createSim(makeOpts(mode, { robots: 150, checks: false }), layout);
sim.run(4 * 7200);
// time-split: jams + deadlocks vs everything else, by monkey-patching the trackers
const s = sim as unknown as { jams: { update: (...a: unknown[]) => void }; deadlocks: { update: (...a: unknown[]) => void }; controller: { plan: (...a: unknown[]) => void } };
let tj = 0;
let td = 0;
let tp = 0;
const wrap = (o: { update?: (...a: unknown[]) => void; plan?: (...a: unknown[]) => void }, k: 'update' | 'plan', add: (ms: number) => void) => {
  const f = o[k]!.bind(o);
  o[k] = (...a: unknown[]) => {
    const t0 = performance.now();
    f(...a);
    add(performance.now() - t0);
  };
};
wrap(s.jams, 'update', (x) => (tj += x));
wrap(s.deadlocks, 'update', (x) => (td += x));
wrap(s.controller, 'plan', (x) => (tp += x));
const N = 2 * 7200;
const t0 = performance.now();
sim.run(N);
const tot = performance.now() - t0;
console.log(`${mode} ${layout} 150 robots: total ${(tot / N).toFixed(4)} ms/tick; traffic controller ${(tp / N).toFixed(4)}; jam detect ${(tj / N).toFixed(4)}; deadlock detect ${(td / N).toFixed(4)}; rest (people, motion, bookkeeping) ${((tot - tp - tj - td) / N).toFixed(4)}`);

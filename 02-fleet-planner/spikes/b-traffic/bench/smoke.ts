// Quick look: npx tsx spikes/b-traffic/bench/smoke.ts [hours] [robots] [seed]
import { createSim, makeOpts, TICKS_PER_HOUR } from '../src/index.ts';

const hours = Number(process.argv[2] ?? 2);
const robots = Number(process.argv[3] ?? 0);
const seed = Number(process.argv[4] ?? 42);
for (const mode of ['central', 'siloed'] as const) {
  const opts = makeOpts(mode, { robots: robots || undefined, seed });
  const sim = createSim(opts);
  const t0 = performance.now();
  sim.run(hours * TICKS_PER_HOUR);
  const ms = performance.now() - t0;
  const r = sim.result();
  console.log(mode, `${(ms / (hours * TICKS_PER_HOUR)).toFixed(4)} ms/tick`, JSON.stringify({ fleet: r.fleet, tph: r.tasksPerHour, states: r.robotStates, dl: r.deadlocks, jams: r.jams, resets: r.resets, ladder: r.ladder, people: r.people, cw: r.chargeWaits, ch: r.charges, v: r.violations, hash: r.hash }));
}

// Browser entry for the cross-engine hash test: bundled to an IIFE that defines globalThis.fpSpikeB.
import { createSim, makeOpts, TICKS_PER_HOUR, type Mode } from '../src/index.ts';

export function run(mode: Mode, hours: number, seed = 42) {
  const sim = createSim(makeOpts(mode, { seed, checks: true }));
  const t0 = Date.now(); // wall time only, outside the sim
  sim.run(hours * TICKS_PER_HOUR);
  const ms = Date.now() - t0;
  const words = sim.stateWords(); // throws if any state number is not an integer
  const r = sim.result();
  return {
    mode,
    hash: sim.hash(),
    words: words.length,
    allIntegers: words.every((x) => Number.isSafeInteger(x)),
    tasks: r.tasksPerHour.all,
    violations: r.violations,
    ms,
  };
}

(globalThis as unknown as { fpSpikeB: unknown }).fpSpikeB = { run };

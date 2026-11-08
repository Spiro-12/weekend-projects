// Spike b entry: build run options from the default scenario and run shifts. Pure (no timers), so the same code runs
// in Node and in browsers for the cross-engine hash test.
import type { LayoutFile, Scenario } from '../../../src/contracts/types.ts';
import defaultLayout from '../../../data/layouts/default.json';
import largeLayout from '../../../data/layouts/large.json';
import defaultScenario from '../../../data/scenarios/default.json';
import { DEFAULT_SILO, DEFAULT_WORK, TICKS_PER_HOUR, scaleFleet, type Fleet, type Mode, type RunOpts, type SiloKnobs } from './config.ts';
import { TrafficSim, type RunResult } from './sim.ts';

export { TrafficSim } from './sim.ts';
export type { RunResult } from './sim.ts';
export * from './config.ts';

export const SCENARIO = defaultScenario as unknown as Scenario;
export const LAYOUTS: Record<string, LayoutFile> = {
  default: defaultLayout as unknown as LayoutFile,
  large: largeLayout as unknown as LayoutFile,
};

export interface OptsOverride {
  seed?: number;
  fleet?: Fleet;
  robots?: number;
  silo?: Partial<SiloKnobs>;
  work?: Partial<RunOpts['work']>;
  warmupTicks?: number;
  checks?: boolean;
}

export function makeOpts(mode: Mode, o: OptsOverride = {}): RunOpts {
  const base = SCENARIO.fleet;
  const fleet = o.fleet ?? (o.robots ? scaleFleet(base, o.robots) : { ...base });
  return {
    mode,
    seed: o.seed ?? SCENARIO.seed,
    fleet,
    vendors: SCENARIO.vendors,
    silo: { ...DEFAULT_SILO, ...SCENARIO.traffic.silo, ...o.silo },
    work: { ...DEFAULT_WORK, ...o.work },
    warmupTicks: o.warmupTicks ?? 30 * 120,
    checks: o.checks ?? true,
  };
}

export function createSim(opts: RunOpts, layout = 'default'): TrafficSim {
  return new TrafficSim(opts, LAYOUTS[layout]);
}

export function runShift(opts: RunOpts, hours: number, layout = 'default'): RunResult {
  const sim = createSim(opts, layout);
  sim.run(hours * TICKS_PER_HOUR);
  return sim.result();
}

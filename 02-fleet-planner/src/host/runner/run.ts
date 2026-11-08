// One headless run: warm-up, then the measure window with the KPI recorder (PROTOCOL §6). Used inline in Node
// (golden tests, CLI sweeps) and inside the Web Worker pool in the browser.
import { TICKS_PER_MIN, type KpiRecorderFactory, type RunResult, type Scenario } from '../../contracts/types.ts';
import { createSim, type SimData, type SimImpl } from '../../sim/index.ts';
import { runKey } from '../settings.ts';
import type { EvaluateOptions } from './types.ts';

export const SAMPLE_EVERY = 60;

export function runScenario(s: Scenario, data: SimData, recorder: KpiRecorderFactory, opts: EvaluateOptions & { impl?: SimImpl } = {}): RunResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const scenario: Scenario = opts.saturate ? { ...s, orders: { ...s.orders, mode: 'saturate' } } : s;
  const sim = createSim(scenario, data, opts.impl);
  const warmupTick = s.run.warmupMin * TICKS_PER_MIN;
  const endTick = warmupTick + s.run.measureMin * TICKS_PER_MIN;
  sim.step(warmupTick);
  // Deadlocks that began during warm-up and are still open: the recorder gets their start events right after
  // start() (tick < warmupTick), so a gridlock that never clears still counts as a long deadlock (PROTOCOL §6).
  const ended = new Set<number>();
  const warm = sim.drainEvents();
  for (const e of warm) if (e.t === 'deadlockEnd') ended.add(e.deadlock);
  const openDeadlocks = warm.filter((e) => e.t === 'deadlockStart' && !ended.has(e.deadlock));
  const rec = recorder(scenario, { warmupTick, endTick });
  rec.start(sim.stats());
  if (openDeadlocks.length) rec.events(openDeadlocks);
  while (sim.tick < endTick) {
    sim.step(Math.min(SAMPLE_EVERY, endTick - sim.tick));
    rec.events(sim.drainEvents());
    rec.sample(sim.stats());
  }
  const kpis = rec.finish(sim.stats());
  if (opts.saturate) kpis.capacityOph = kpis.oph;
  return {
    scenarioId: s.id,
    settingsHash: runKey(s) + (opts.saturate ? '-sat' : ''),
    kpis,
    fleet: { ...s.fleet },
    traffic: s.traffic.mode,
    hash: sim.hash(),
    ticks: endTick,
    simMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
  };
}

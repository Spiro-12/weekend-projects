// Shared test data for the sim-core tests.
import agents from '../../../../data/agents.json';
import defaultLayout from '../../../../data/layouts/default.json';
import largeLayout from '../../../../data/layouts/large.json';
import smallLayout from '../../../../data/layouts/small.json';
import defaultScenario from '../../../../data/scenarios/default.json';
import type { AgentsFile, LayoutFile, Scenario, SimEvent } from '../../../../src/contracts/types.ts';
import { createCoreSim, type CoreSim, type CoreSimOptions } from '../../../../src/sim/core/index.ts';
import { CentralController } from '../../../../src/sim/traffic/central/index.ts';
import { TestPibtController } from './test-controller.ts';

export const AGENTS = agents as AgentsFile;
export const LAYOUTS: Record<string, LayoutFile> = {
  default: defaultLayout as LayoutFile,
  small: smallLayout as LayoutFile,
  large: largeLayout as LayoutFile,
};
export const BASE = defaultScenario as Scenario;

export type ScenarioPatch = Partial<Omit<Scenario, 'orders' | 'fleet' | 'pallets'>> & {
  orders?: Partial<Scenario['orders']>;
  fleet?: Partial<Scenario['fleet']>;
  pallets?: Partial<Scenario['pallets']>;
};

export function scenario(patch: ScenarioPatch = {}): Scenario {
  return {
    ...BASE,
    ...patch,
    orders: { ...BASE.orders, ...patch.orders },
    fleet: { ...BASE.fleet, ...patch.fleet },
    pallets: { ...BASE.pallets, ...patch.pallets },
    events: patch.events ?? [],
  };
}

/** A core sim. `pibt: true` uses Track B's one-brain CentralController (the real planner), `testPibt: true` Track A's
 *  small test PIBT; the default is the lead's NaiveController. */
export function makeSim(s: Scenario, opts: CoreSimOptions & { pibt?: boolean; testPibt?: boolean; layout?: string } = {}): CoreSim {
  const traffic = opts.traffic ?? (opts.pibt ? () => new CentralController() : opts.testPibt ? (m) => new TestPibtController(m) : undefined);
  return createCoreSim(s, { agents: AGENTS, layout: LAYOUTS[opts.layout ?? s.layout] }, { checks: opts.checks, traffic });
}

/** Step in chunks, collecting every event. */
export function run(sim: CoreSim, ticks: number, events: SimEvent[] = [], chunk = 600): SimEvent[] {
  let left = ticks;
  while (left > 0) {
    const n = Math.min(chunk, left);
    sim.step(n);
    for (const e of sim.drainEvents()) events.push(e);
    left -= n;
  }
  return events;
}

export const count = (ev: SimEvent[], t: SimEvent['t']) => ev.filter((e) => e.t === t).length;

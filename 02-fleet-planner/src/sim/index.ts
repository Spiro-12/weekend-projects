// Sim entry point (lead-owned). Phase 0 ships FakeSim; Phase 1 integration switches the default to the real core.
import type { Scenario, Sim } from '../contracts/types.ts';
import { createFakeSim, type SimData } from './fake.ts';

export type { SimData } from './fake.ts';
export type SimImpl = 'fake' | 'core';

/** The implementation used when none is asked for. */
export const DEFAULT_IMPL: SimImpl = 'fake';

export function createSim(scenario: Scenario, data: SimData, impl: SimImpl = DEFAULT_IMPL): Sim {
  if (impl === 'core') throw new Error('The real sim core lands in Phase 1 (Track A).');
  return createFakeSim(scenario, data);
}

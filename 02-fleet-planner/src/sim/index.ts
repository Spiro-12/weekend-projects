// Sim entry point (lead-owned). The default is the real core (Track A) with the one-brain planner (Track B).
// FakeSim (src/sim/fake.ts) stays for tests that want planner-free motion: pass `createFakeSim` as the SimImpl.
import type { Scenario, Sim, TrafficMode } from '../contracts/types.ts';
import { createCoreSim } from './core/index.ts';
import type { SimData } from './fake.ts';
import { CentralController } from './traffic/central/index.ts';
import type { TrafficController } from './traffic/types.ts';

export type { SimData } from './fake.ts';
/** Which simulator to build. A factory (not a name), so the app bundle only carries the one it uses. */
export type SimImpl = (scenario: Scenario, data: SimData) => Sim;

/** Traffic controller per mode. Phase 1 has one brain only; many brains (siloed, shared-status) arrive in Phase 2 (Track G). */
export function trafficFor(_mode: TrafficMode): TrafficController {
  return new CentralController();
}

/** The real sim. `impl` swaps in another (FakeSim in tests). */
export function createSim(scenario: Scenario, data: SimData, impl?: SimImpl): Sim {
  return impl ? impl(scenario, data) : createCoreSim(scenario, data, { traffic: trafficFor });
}

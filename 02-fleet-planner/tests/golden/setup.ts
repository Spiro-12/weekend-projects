// Which sim and KPI recorder the golden tests use. Phase 0: FakeSim + the lead's basic recorder (no golden files yet).
// Phase 1 integration switches to the real core and Track C's recorder.
import type { KpiRecorderFactory } from '../../src/contracts/types.ts';
import { basicRecorder } from '../../src/host/runner/basic-recorder.ts';
import type { SimImpl } from '../../src/sim/index.ts';

export const GOLDEN_RECORDER: KpiRecorderFactory = basicRecorder;
export const GOLDEN_IMPL: SimImpl | undefined = undefined;

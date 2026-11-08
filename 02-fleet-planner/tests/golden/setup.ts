// Which sim and KPI recorder the golden tests use: Track C's recorder, and the default sim (src/sim/index.ts).
import type { KpiRecorderFactory } from '../../src/contracts/types.ts';
import { createKpiRecorder } from '../../src/kpi/index.ts';
import type { SimImpl } from '../../src/sim/index.ts';

export const GOLDEN_RECORDER: KpiRecorderFactory = createKpiRecorder;
export const GOLDEN_IMPL: SimImpl | undefined = undefined;

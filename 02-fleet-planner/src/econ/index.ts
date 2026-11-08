// Economics entry point (Track C). The host plugs `econ` in where Phase 0 used `fakeEcon` (src/host/econ-port.ts).
import type { EconPort } from '../host/econ-port.ts';
import { findBaseline } from './baseline.ts';
import { computeMoney } from './money.ts';

export const econ: EconPort = { computeMoney, findBaseline };

export { computeMoney, NOT_MODELED } from './money.ts';
export { findBaseline, baselineScenario, meanLinesPerOrder, palletsPerHour, MAX_BASELINE_EVALS, type Crew } from './baseline.ts';
export { bestMix, rankMixes, type MixOption } from './best-mix.ts';

// Shared test helpers for the economics tests (not a test file itself).
import agentsJson from '../../../data/agents.json';
import sourcesJson from '../../../data/sources.json';
import scenarioJson from '../../../data/scenarios/default.json';
import type { AgentTypeId, AgentsFile, Explained, Kpis, MoneyReport, RunResult, Scenario, SourcesFile } from '../../../src/contracts/types.ts';

export const agents = agentsJson as AgentsFile;
export const sources = sourcesJson as SourcesFile;
export const defaultScenario = scenarioJson as Scenario;
export const sourceIds = new Set(sources.sources.map((s) => s.id));

const ZERO_KPIS: Kpis = {
  oph: 600,
  robotUtilizationPct: 0,
  jamsPerHour: 0,
  deadlocksPerShift: 0,
  avgOrderSec: 0,
  p90OrderSec: 0,
  backlogEnd: 0,
  backlogTrendPerHour: 0,
  keepsUp: true,
  resetsPerHour: 0,
  retasksPerHour: 0,
  deadlocksOver2MinPerShift: 0,
  unitsPerPickerHour: 0,
  byType: {},
};

/** A hand-built RunResult: keeps up at 600 orders/h unless told otherwise. */
export function mkRun(kpis: Partial<Kpis> = {}, fleet: Record<AgentTypeId, number> = defaultScenario.fleet): RunResult {
  return { scenarioId: 'test', settingsHash: 'test', kpis: { ...ZERO_KPIS, ...kpis }, fleet: { ...fleet }, traffic: 'central', hash: 'h', ticks: 18000, simMs: 0 };
}

export function withFleet(s: Scenario, fleet: Partial<Record<AgentTypeId, number>>, financing: 'buy' | 'raas' = s.economics.financing): Scenario {
  return { ...s, fleet: { ...s.fleet, ...fleet }, economics: { ...s.economics, financing } };
}

/** agents.json with some fields changed (deep copy, so tests never touch the shared object). */
export function editAgents(edit: (a: AgentsFile) => void): AgentsFile {
  const copy = JSON.parse(JSON.stringify(agents)) as AgentsFile;
  edit(copy);
  return copy;
}

/** Every Explained in a money report, with a name for error messages. */
export function allExplained(m: MoneyReport): [string, Explained][] {
  const out: [string, Explained][] = [];
  for (const [k, v] of Object.entries(m)) {
    if (v && typeof v === 'object' && 'formula' in v) out.push([k, v as Explained]);
  }
  for (const l of m.lines) out.push([`lines.${l.type}.capex`, l.capex], [`lines.${l.type}.opexYear`, l.opexYear]);
  return out;
}

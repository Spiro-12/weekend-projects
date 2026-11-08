// What an explain popover shows (Track F). Builders turn Explained values, KPIs and agent specs into this one shape,
// so every hover in the app looks and reads the same: headline, how it's worked out, what goes in, what's left out.
import type { AgentSpec, AgentTypeId, Explained, ExplainFrom, ExplainInput, Scenario, SourceRef, Sourced } from '../../contracts/types.ts';
import { num, withUnit } from './format.ts';

/** Plain names per agent type: [one, many]. */
export const TYPE_NAMES: Record<AgentTypeId, [string, string]> = {
  amr: ['cart robot', 'cart robots'],
  forklift: ['autonomous forklift', 'autonomous forklifts'],
  humanoid: ['humanoid robot', 'humanoid robots'],
  picker: ['picker', 'pickers'],
  driver: ['forklift driver', 'forklift drivers'],
};

/** "24 cart robots", "1 humanoid robot"; unknown types fall back to the given label. */
export function typeCount(type: string, n: number, fallback = type): string {
  const names = TYPE_NAMES[type as AgentTypeId];
  return `${num(n)} ${names ? names[n === 1 ? 0 : 1] : fallback}`;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface ExplainRow {
  label: string;
  /** Formatted value with its unit, in words. */
  value: string;
  from: ExplainFrom;
  note?: string;
  /** Resolved source for `source:<id>` (title, publisher, link). */
  source?: SourceRef;
}

export interface ExplainContent {
  title: string;
  /** The number, formatted. Absent when a flag is shown instead. */
  value?: string;
  /** Words shown instead of a number ("Never pays back at these numbers"). */
  flag?: string;
  /** Plain-word paragraphs: what the number means and how it is measured. */
  text?: string[];
  formula?: string;
  /** The formula with the real numbers filled in. */
  worked?: string;
  inputs?: ExplainRow[];
  note?: string;
  /** "Simulated: 30 min warm-up + 2 h measured, same orders every run." */
  run?: string;
  /** Add the "left out of these numbers" line (every money hover). */
  notModeled?: boolean;
  demo?: boolean;
}

export const FLAG_WORDS: Record<NonNullable<Explained['flag']>, string> = {
  never: 'Never pays back at these numbers',
  doesntKeepUp: "Can't keep up with the orders",
};

/** PROTOCOL §7 "Not modeled", in plain words. Shown in every money hover. */
export const NOT_MODELED = 'Left out of these numbers: taxes, depreciation, interest and discounting, resale value, and changes to the building.';

export const BADGE: Record<'source' | 'estimate' | 'sim' | 'user', string> = {
  source: 'source',
  estimate: 'estimate',
  sim: 'simulated',
  user: 'your input',
};

export const badgeOf = (from: ExplainFrom): keyof typeof BADGE => (from.startsWith('source:') ? 'source' : (from as 'estimate' | 'sim' | 'user'));

export function sourceById(sources: SourceRef[], from: ExplainFrom): SourceRef | undefined {
  if (!from.startsWith('source:')) return undefined;
  const id = from.slice('source:'.length);
  return sources.find((s) => s.id === id);
}

export function rowFromInput(i: ExplainInput, sources: SourceRef[]): ExplainRow {
  return { label: i.label, value: withUnit(i.value, i.unit), from: i.from, note: i.note, source: sourceById(sources, i.from) };
}

export function rowFromSourced(label: string, v: Sourced, sources: SourceRef[]): ExplainRow {
  const from: ExplainFrom = v.src === 'estimate' ? 'estimate' : `source:${v.src}`;
  const range = v.src === 'estimate' && v.range ? ` Range: ${withUnit(v.range[0], v.unit)} to ${withUnit(v.range[1], v.unit)}.` : '';
  return { label, value: withUnit(v.value, v.unit), from, note: ((v.note ?? '') + range).trim() || undefined, source: sourceById(sources, from) };
}

/** The Explained note without its own "Not modeled: …" sentence (the popover always adds the plain-words version). */
export function cleanNote(note: string | undefined): string | undefined {
  const n = note?.replace(/\s*Not modell?ed:[^.]*\.?/i, '').trim();
  return n || undefined;
}

export function fromExplained(title: string, ex: Explained, sources: SourceRef[], opts: { value?: string; worked?: string; demo?: boolean } = {}): ExplainContent {
  return {
    title,
    value: ex.flag || ex.value === null ? undefined : (opts.value ?? withUnit(ex.value, ex.unit)),
    flag: ex.flag ? FLAG_WORDS[ex.flag] : ex.value === null ? 'No number for these settings' : undefined,
    formula: ex.formula,
    worked: opts.worked,
    inputs: ex.inputs.map((i) => rowFromInput(i, sources)),
    note: cleanNote(ex.note),
    notModeled: true,
    demo: opts.demo,
  };
}

/** "Simulated: 30 min warm-up + 2 h measured, same orders every run." from the scenario's run window. */
export function runLine(s: Scenario): string {
  const span = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  return `Simulated: ${span(s.run.warmupMin)} warm-up + ${span(s.run.measureMin)} measured, same orders every run.`;
}

const SPEC_LABELS: [string, (a: AgentSpec) => Sourced | undefined][] = [
  ['Speed in shared aisles', (a) => a.speedMps],
  ['Top speed', (a) => a.topSpeedMps],
  ['Payload', (a) => a.payloadKg],
  ['Pick time per order line', (a) => a.pickSecPerLine],
  ['Pallet pick-up or drop', (a) => a.palletSecPerMove],
  ['Hand-off at a station', (a) => a.handoffSec],
  ['Battery lasts', (a) => a.battery?.runtimeH],
  ['Charge time', (a) => a.battery?.chargeH],
  ['Price to buy', (a) => a.cost.buyUsd],
  ['Setup when buying', (a) => a.cost.integrationUsd],
  ['Maintenance when buying', (a) => a.cost.maintPctPerYear],
  ['Fleet software when buying', (a) => a.cost.softwareUsdPerYear],
  ['Rent per robot', (a) => a.cost.raasUsdPerMonth],
  ['Setup when renting', (a) => a.cost.raasSetupUsd],
  ['Pay', (a) => a.cost.wageUsdPerHour],
  ['Forklift truck', (a) => a.cost.equipmentUsd],
];

/** Fleet control hover: what the agent type is based on, and every spec number with its origin. */
export function agentContent(spec: AgentSpec, sources: SourceRef[]): ExplainContent {
  const rows: ExplainRow[] = [];
  for (const [label, get] of SPEC_LABELS) {
    const v = get(spec);
    if (v) rows.push(rowFromSourced(label, v, sources));
  }
  return {
    title: spec.label,
    text: [
      `Based on: ${spec.basedOn.join(', ')}.`,
      spec.kind === 'robot'
        ? 'The numbers come from these products’ public specs and prices. Robots are shown as generic vendors, not brands.'
        : 'Pay is the median wage; benefits are added on top in the money panel.',
    ],
    inputs: rows,
  };
}

/** True when the number a buyer sees first for this type (price or rent, or pay) is an estimate, not a cited source. */
export function headlineIsEstimate(spec: AgentSpec, financing: 'buy' | 'raas'): boolean {
  const c = spec.cost;
  const v = spec.kind === 'human' ? c.wageUsdPerHour : financing === 'raas' ? c.raasUsdPerMonth : c.buyUsd;
  return v?.src === 'estimate';
}

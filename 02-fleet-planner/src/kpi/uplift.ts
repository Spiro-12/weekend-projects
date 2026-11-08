// Picker uplift (PROTOCOL §6): units per picker-hour with this fleet ÷ units per picker-hour without picking robots
// (`withoutPickingRobots`: cart robots and humanoids 0, forklifts unchanged), both measured at capacity. It is an
// OUTPUT of the sim (walk speed, pick seconds per line, zones), never an input.
import type { ExplainInput, Explained, RunResult } from '../contracts/types.ts';
import { fixed, num } from '../econ/format.ts';

function assertCapacity(r: RunResult, which: string): void {
  // The runner sets capacityOph only on saturate runs. A demand run would understate both rates (pickers wait for
  // orders), so the ratio would mean nothing.
  if (r.kpis.capacityOph === undefined) throw new Error(`pickerUplift: the ${which} run is not a capacity run (evaluate it with {saturate: true})`);
}

/** Units per picker-hour ratio, or undefined when either run has no picking by people to compare. */
export function pickerUplift(withRobots: RunResult, withoutPickingRobots: RunResult): number | undefined {
  assertCapacity(withRobots, 'with-robots');
  assertCapacity(withoutPickingRobots, 'without-picking-robots');
  const a = withRobots.kpis.unitsPerPickerHour;
  const b = withoutPickingRobots.kpis.unitsPerPickerHour;
  return a > 0 && b > 0 ? a / b : undefined;
}

/** Published before/after numbers to show next to ours (vendor case studies; vendors claim 2 to 3 times). */
const CASE_STUDIES: { label: string; before: number; after: number; src: string }[] = [
  { label: 'MyPillow with cart robots (vendor case study)', before: 119, after: 210, src: 'locus-mypillow' },
  { label: 'Verst with cart robots (vendor case study)', before: 71, after: 155, src: 'locus-verst' },
  { label: 'DHL with cart robots', before: 78, after: 150, src: 'prologis-dhl' },
];

/** The uplift hover: our simulated ratio with its two inputs, and the published case studies for comparison.
 *  Null when there is nothing to compare (no picking by people in one of the runs). */
export function explainPickerUplift(withRobots: RunResult, withoutPickingRobots: RunResult): Explained | null {
  const v = pickerUplift(withRobots, withoutPickingRobots);
  if (v === undefined) return null;
  const a = withRobots.kpis.unitsPerPickerHour;
  const b = withoutPickingRobots.kpis.unitsPerPickerHour;
  const inputs: ExplainInput[] = [
    { label: 'Units per picker-hour with this fleet, at capacity', value: a, unit: 'units/h', from: 'sim' },
    { label: 'Units per picker-hour without cart robots or humanoids, at capacity', value: b, unit: 'units/h', from: 'sim', note: 'Same building, orders and forklifts; pickers push carts.' },
    ...CASE_STUDIES.map(
      (c): ExplainInput => ({ label: `For comparison: ${c.label}`, value: c.after / c.before, unit: 'x', from: `source:${c.src}`, note: `${c.before} → ${c.after} units per picker-hour.` }),
    ),
  ];
  const note =
    'An output of the simulation (walking speed, seconds per pick and pick zones), not an input. Vendors claim 2 to 3 times; the published case studies show 1.8 to 2.2 times.';
  return {
    value: v,
    unit: 'x',
    formula: `uplift = ${num(a, 1)} units per picker-hour with this fleet ÷ ${num(b, 1)} without cart robots or humanoids = ${fixed(v, 2)}×`,
    inputs,
    note,
  };
}

// Writes fixtures/ (PROTOCOL §11) so render and UI tracks can work without the real sim.
// Usage: npx tsx scripts/make-fixtures.ts
import { writeFileSync } from 'node:fs';
import agents from '../data/agents.json' with { type: 'json' };
import layout from '../data/layouts/default.json' with { type: 'json' };
import scenarioJson from '../fixtures/scenario-mixed.json' with { type: 'json' }; // every agent type, as the UI tests expect
import type { AgentsFile, Explained, LayoutFile, Scenario, SweepFile } from '../src/contracts/types.ts';
import { fakeEvaluate } from '../src/host/runner/fake.ts';
import { withFleet } from '../src/host/settings.ts';
import { createFakeSim } from '../src/sim/fake.ts';

const scenario = scenarioJson as Scenario;
const out = (name: string, v: unknown) => writeFileSync(new URL(`../fixtures/${name}`, import.meta.url), JSON.stringify(v) + '\n');

// 60 s of FakeSim, one snapshot per tick (heat only on the last one to keep the file small).
const sim = createFakeSim(scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
sim.step(600); // let agents spread out first
sim.drainEvents();
const snaps = [];
for (let t = 0; t < 60; t++) {
  sim.step(1);
  const s = sim.snapshot();
  snaps.push(t === 59 ? s : { ...s, heat: [] });
}
out('snapshots-default.json', { note: 'FakeSim, default scenario, ticks 601-660 (30 s). Not a model.', snapshots: snaps });
sim.step(3600);
out('events-default.json', { note: 'FakeSim events for 30 simulated minutes after warm-up. Not a model.', events: sim.drainEvents() });

out('runresult.json', { note: 'Fake runner output (toy model) for the default scenario.', result: fakeEvaluate(scenario), capacity: fakeEvaluate(scenario, { saturate: true }) });

const econ: Record<string, Explained> = {
  paybackMonths: {
    value: 19.4, unit: 'months', formula: 'payback = upfront cost ÷ (yearly savings ÷ 12)',
    inputs: [
      { label: 'Upfront cost (robots + setup)', value: 1_092_000, unit: 'USD', from: 'estimate', note: '24 cart robots at $35,000 + $10,500 setup; 4 forklifts at $150,000 + $45,000' },
      { label: 'Yearly savings', value: 675_000, unit: 'USD/yr', from: 'sim', note: 'People-only cost minus this fleet’s cost, same orders' },
    ],
    note: 'Simple payback. Not modeled: taxes, depreciation, discounting, interest, residual value.',
  },
  laborPerYear: {
    value: 1_234_000, unit: 'USD/yr', formula: 'labor = Σ people × hours/yr × wage × (1 + benefits load)',
    inputs: [
      { label: 'Pickers', value: 14, unit: 'people/shift', from: 'user' },
      { label: 'Hours per year', value: 4160, unit: 'h', from: 'user', note: '8 h × 2 shifts × 260 days' },
      { label: 'Picker wage', value: 17.95, unit: 'USD/h', from: 'source:bls-hand-laborers' },
      { label: 'Benefits load', value: 0.46, unit: 'x', from: 'source:bls-ecec' },
    ],
  },
  paybackNever: { value: Number.POSITIVE_INFINITY, unit: 'months', formula: 'payback = upfront ÷ (savings ÷ 12)', inputs: [{ label: 'Yearly savings', value: -12_000, unit: 'USD/yr', from: 'sim' }], flag: 'never', note: 'This fleet costs more per year than doing it with people.' },
};
out('econ.json', { note: 'Example Explained values for UI work (numbers are illustrative).', econ });

const values = [0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 52, 60];
const sweep: SweepFile = { format: 'fp-sweep', v: 1, axes: [{ type: 'amr', values }], base: 'default', results: values.map((n) => fakeEvaluate(withFleet(scenario, 'amr', n), { saturate: true })) };
out('sweep.json', { note: 'Fake runner sweep over cart robot count (toy model).', ...sweep });
console.log('fixtures written');

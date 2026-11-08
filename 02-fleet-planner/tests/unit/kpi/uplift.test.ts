import { describe, expect, it } from 'vitest';
import scenarioJson from '../../../data/scenarios/default.json';
import sourcesJson from '../../../data/sources.json';
import type { Kpis, RunResult, Scenario, SourcesFile } from '../../../src/contracts/types.ts';
import { createFakeRunner } from '../../../src/host/runner/fake.ts';
import { withoutPickingRobots } from '../../../src/host/settings.ts';
import { explainPickerUplift, pickerUplift } from '../../../src/kpi/uplift.ts';

const scenario = scenarioJson as Scenario;
const sourceIds = new Set((sourcesJson as SourcesFile).sources.map((s) => s.id));
const cap = (unitsPerPickerHour: number, capacityOph: number | null = 500): RunResult => ({
  scenarioId: 't',
  settingsHash: 't-sat',
  kpis: { unitsPerPickerHour, capacityOph: capacityOph ?? undefined } as Kpis,
  fleet: scenario.fleet,
  traffic: 'central',
  hash: 'h',
  ticks: 0,
  simMs: 0,
});

describe('picker uplift', () => {
  it('= units per picker-hour with robots ÷ without picking robots', () => {
    expect(pickerUplift(cap(135), cap(75))).toBe(1.8);
  });
  it('only from capacity runs (a demand run would understate both rates)', () => {
    expect(() => pickerUplift(cap(135, null), cap(75))).toThrow(/not a capacity run/);
    expect(() => pickerUplift(cap(135), cap(75, null))).toThrow(/not a capacity run/);
  });
  it('undefined when there is no picking by people to compare', () => {
    expect(pickerUplift(cap(0), cap(75))).toBeUndefined();
    expect(pickerUplift(cap(135), cap(0))).toBeUndefined();
    expect(explainPickerUplift(cap(135), cap(0))).toBeNull();
  });
  it('the hover: our number in plain words, next to the published case studies', () => {
    const e = explainPickerUplift(cap(135.2), cap(75.1))!;
    expect(e.formula).toBe('uplift = 135.2 units per picker-hour with this fleet ÷ 75.1 without cart robots or humanoids = 1.80×');
    expect(e.inputs.slice(0, 2).map((i) => i.from)).toEqual(['sim', 'sim']);
    for (const i of e.inputs) if (i.from.startsWith('source:')) expect(sourceIds.has(i.from.slice(7))).toBe(true);
    expect(e.note).toMatch(/output of the simulation/);
  });
  it('end to end on the fake runner: robots raise units per picker-hour', async () => {
    const runner = createFakeRunner();
    const withRobots = await runner.evaluate(scenario, { saturate: true });
    const without = await runner.evaluate(withoutPickingRobots(scenario), { saturate: true });
    expect(without.fleet).toMatchObject({ amr: 0, humanoid: 0, forklift: scenario.fleet.forklift });
    expect(pickerUplift(withRobots, without)!).toBeGreaterThan(1);
  });
});

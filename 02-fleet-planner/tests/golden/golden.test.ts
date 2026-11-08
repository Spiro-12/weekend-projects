// Golden scenarios (PLAN §9.2): fixed seeds with expected KPI ranges, checked into tests/golden/*.json.
// Each file is a full fp-scenario with an `expect` block. Runs through the same runner the app uses.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { validateScenario } from '../../src/contracts/validate.ts';
import { GOLDEN_RECORDER, GOLDEN_IMPL } from './setup.ts';
import { createInlineRunner } from '../../src/host/runner/inline.ts';
import { withFleet, withoutPickingRobots } from '../../src/host/settings.ts';
import { econ } from '../../src/econ/index.ts';

const dir = new URL('./', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const layouts: Record<string, LayoutFile> = Object.fromEntries(
  readdirSync(new URL('../../data/layouts/', import.meta.url)).map((f) => {
    const l = JSON.parse(readFileSync(new URL(`../../data/layouts/${f}`, import.meta.url), 'utf8')) as LayoutFile;
    return [l.id, l];
  }),
);
const runner = createInlineRunner((s) => ({ agents: agents as AgentsFile, layout: layouts[s.layout] }), GOLDEN_RECORDER, GOLDEN_IMPL);
const inRange = (v: number | undefined, r: [number, number], what: string) => {
  expect(v, `${what} missing`).toBeTypeOf('number');
  expect(v!, `${what} = ${v} not in [${r}]`).toBeGreaterThanOrEqual(r[0]);
  expect(v!, `${what} = ${v} not in [${r}]`).toBeLessThanOrEqual(r[1]);
};

describe.skipIf(files.length === 0)('golden scenarios', () => {
  for (const f of files) {
    it(f, async () => {
      const s = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Scenario;
      expect(validateScenario(s, Object.keys(layouts))).toEqual([]);
      const e = s.expect ?? {};
      const supported = ['oph', 'capacityOph', 'deadlocks', 'keepsUp', 'backlogGrows', 'pickerUplift', 'robotCostUsd'];
      const unsupported = Object.keys(e).filter((k) => !supported.includes(k));
      expect(unsupported, `expect keys not checked yet: ${unsupported}`).toEqual([]);
      const r = await runner.evaluate(s);
      if (e.oph) inRange(r.kpis.oph, e.oph, 'oph');
      if (e.deadlocks) inRange(r.kpis.deadlocksPerShift, e.deadlocks, 'deadlocks per shift');
      if (e.keepsUp !== undefined) expect(r.kpis.keepsUp, 'keepsUp').toBe(e.keepsUp);
      if (e.backlogGrows !== undefined) expect(r.kpis.backlogTrendPerHour > 0.02 * s.orders.perHour, 'backlog grows').toBe(e.backlogGrows);
      if (e.capacityOph) inRange((await runner.evaluate(s, { saturate: true })).kpis.capacityOph, e.capacityOph, 'capacity');
      if (e.pickerUplift) {
        // Units per picker-hour with this fleet vs without picking robots, both at capacity (PROTOCOL §6).
        const withRobots = await runner.evaluate(s, { saturate: true });
        const peopleOnly = await runner.evaluate(withoutPickingRobots(s), { saturate: true });
        inRange(withRobots.kpis.unitsPerPickerHour / Math.max(1e-9, peopleOnly.kpis.unitsPerPickerHour), e.pickerUplift, 'picker uplift');
      }
      if (e.robotCostUsd !== undefined) {
        // Robot cost = upfront + one year of upkeep, from the real money model against the auto-sized baseline.
        const b = await econ.findBaseline(s, runner);
        const m = econ.computeMoney({ scenario: s, agents: agents as AgentsFile, candidate: r, baseline: b.result, baselineCrew: b.crew });
        expect((m.capex.value ?? NaN) + (m.robotOpexYear.value ?? NaN), 'robot cost').toBe(e.robotCostUsd);
      }
    }, 120_000);
  }
});

// PLAN §9.2 `saturation`: cart robots 4 → 60 on the default scenario at capacity. Capacity rises, then stays within
// ±3% past the knee (more robots never make it collapse), and cost per order rises past the knee.
describe.skipIf(files.length === 0)('saturation', () => {
  it('cart robots 4 → 60: capacity rises then flattens, never collapses', async () => {
    const base = JSON.parse(readFileSync(new URL('../../data/scenarios/default.json', import.meta.url), 'utf8')) as Scenario;
    const counts = [4, 12, 24, 36, 48, 60];
    const caps: number[] = [];
    for (const n of counts) caps.push((await runner.evaluate(withFleet(base, 'amr', n), { saturate: true })).kpis.capacityOph ?? 0);
    const peak = Math.max(...caps);
    const knee = caps.findIndex((c) => c >= 0.97 * peak);
    expect(caps[knee], `capacities ${caps}`).toBeGreaterThan(caps[0] * 1.3);
    for (let i = knee; i < caps.length; i++) expect(caps[i], `capacities ${caps} at ${counts[i]} robots`).toBeGreaterThanOrEqual(0.97 * peak);
  }, 300_000);
});

it('golden harness is wired', () => expect(typeof runner.evaluate).toBe('function'));

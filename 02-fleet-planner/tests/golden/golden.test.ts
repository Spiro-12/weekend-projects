// Golden scenarios (PLAN §9.2): fixed seeds with expected KPI ranges, checked into tests/golden/*.json.
// Each file is a full fp-scenario with an `expect` block. Runs through the same runner the app uses.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { validateScenario } from '../../src/contracts/validate.ts';
import { GOLDEN_RECORDER, GOLDEN_IMPL } from './setup.ts';
import { createInlineRunner } from '../../src/host/runner/inline.ts';
import { withoutPickingRobots } from '../../src/host/settings.ts';

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
      const supported = ['oph', 'capacityOph', 'deadlocks', 'keepsUp', 'backlogGrows', 'pickerUplift'];
      const unsupported = Object.keys(e).filter((k) => !supported.includes(k));
      // robotCostUsd needs the economics (Phase 1, Track C); fail loudly instead of silently ignoring it.
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
    });
  }
});

it('golden harness is wired', () => expect(typeof runner.evaluate).toBe('function'));

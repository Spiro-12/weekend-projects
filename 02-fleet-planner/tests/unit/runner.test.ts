import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import layout from '../../data/layouts/default.json';
import scenarioJson from '../../data/scenarios/default.json';
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { basicRecorder } from '../../src/host/runner/basic-recorder.ts';
import { createInlineRunner } from '../../src/host/runner/inline.ts';

const scenario = scenarioJson as Scenario;
const runner = createInlineRunner(() => ({ agents: agents as AgentsFile, layout: layout as LayoutFile }), basicRecorder);

describe('inline runner (FakeSim in Phase 0)', () => {
  it('runs warm-up + window, is deterministic and cached', async () => {
    const a = await runner.evaluate(scenario);
    expect(a.ticks).toBe((30 + 120) * 120);
    expect(a.kpis.oph).toBeGreaterThan(0);
    const b = await runner.evaluate(scenario);
    expect(b).toBe(a);
    const fresh = createInlineRunner(() => ({ agents: agents as AgentsFile, layout: layout as LayoutFile }), basicRecorder);
    expect((await fresh.evaluate(scenario)).hash).toBe(a.hash);
  });
  it('saturate mode measures capacity', async () => {
    const c = await runner.evaluate(scenario, { saturate: true });
    expect(c.kpis.capacityOph).toBe(c.kpis.oph);
    expect(c.settingsHash.endsWith('-sat')).toBe(true);
  });
});

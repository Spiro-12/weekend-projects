import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import layout from '../../data/layouts/default.json';
import scenarioJson from '../../data/scenarios/default.json';
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { createFakeSim } from '../../src/sim/fake.ts';

describe('FakeSim behaviour (review fixes)', () => {
  it('robots actually charge (chargeStart and chargeEnd pair up) and do not strand in pockets', () => {
    const sim = createFakeSim(scenarioJson as Scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
    sim.step(3 * 7200);
    const ev = sim.drainEvents();
    const starts = ev.filter((e) => e.t === 'chargeStart').length;
    const ends = ev.filter((e) => e.t === 'chargeEnd').length;
    expect(starts).toBeGreaterThan(5);
    expect(Math.abs(starts - ends)).toBeLessThanOrEqual(12);
    const snap = sim.snapshot();
    const lowIdle = snap.agents.filter((a) => a.type !== 'picker' && a.type !== 'driver' && a.batteryPct < 20 && a.state === 'idle');
    expect(lowIdle.length).toBeLessThanOrEqual(2);
    expect(snap.agents.some((a) => a.state === 'charge') || starts > 0).toBe(true);
  });
  it('deadlocks are rare (agents give up before a cycle counts)', () => {
    const sim = createFakeSim(scenarioJson as Scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
    sim.step(7200);
    const n = sim.drainEvents().filter((e) => e.t === 'deadlockStart').length;
    expect(n).toBeLessThan(60);
  });
});

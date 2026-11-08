import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import layout from '../../data/layouts/default.json';
import scenarioJson from '../../data/scenarios/default.json';
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { createFakeSim } from '../../src/sim/fake.ts';

const data = { agents: agents as AgentsFile, layout: layout as LayoutFile };
const scenario = scenarioJson as Scenario;

describe('FakeSim', () => {
  it('is deterministic: same seed, same hash', () => {
    const a = createFakeSim(scenario, data);
    const b = createFakeSim(scenario, data);
    a.step(600);
    b.step(600);
    expect(a.hash()).toBe(b.hash());
    const c = createFakeSim({ ...scenario, seed: 7 }, data);
    c.step(600);
    expect(c.hash()).not.toBe(a.hash());
  });
  it('never puts two agents in one cell, and agents move', () => {
    const sim = createFakeSim(scenario, data);
    const first = sim.snapshot().agents.map((a) => a.cell);
    for (let t = 0; t < 300; t++) {
      sim.step();
      const held = new Map<number, number>();
      for (const a of sim.snapshot().agents) {
        for (const c of a.to >= 0 ? [a.cell, a.to] : [a.cell]) {
          expect(held.has(c), `cell ${c} held twice at tick ${sim.tick}`).toBe(false);
          held.set(c, a.id);
        }
      }
    }
    const moved = sim.snapshot().agents.filter((a, i) => a.cell !== first[i]).length;
    expect(moved).toBeGreaterThan(20);
  });
  it('has the default fleet and produces orders and events', () => {
    const sim = createFakeSim(scenario, data);
    const s0 = sim.snapshot();
    const count = (t: string) => s0.agents.filter((a) => a.type === t).length;
    expect([count('amr'), count('forklift'), count('humanoid'), count('picker'), count('driver')]).toEqual([24, 4, 2, 14, 2]);
    expect(s0.agents.filter((a) => a.type === 'amr' && a.vendor === 'A').length).toBe(14);
    sim.step(7200);
    const ev = sim.drainEvents();
    const arrived = ev.filter((e) => e.t === 'orderArrived').length;
    expect(arrived).toBeGreaterThan(500);
    expect(arrived).toBeLessThan(700);
    expect(ev.some((e) => e.t === 'orderShipped')).toBe(true);
  });
  it('setFleet adds and removes agents live and is logged', () => {
    const sim = createFakeSim(scenario, data);
    sim.command({ t: 'setFleet', type: 'amr', count: 40 });
    sim.step(1);
    expect(sim.snapshot().agents.filter((a) => a.type === 'amr').length).toBe(40);
    sim.command({ t: 'setFleet', type: 'amr', count: 0 });
    sim.step(200);
    expect(sim.snapshot().agents.filter((a) => a.type === 'amr').length).toBe(0);
    expect(sim.commandLog().map((l) => l.tick)).toEqual([0, 1]);
  });
});

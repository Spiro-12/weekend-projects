import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import sources from '../../data/sources.json';
import defaultLayout from '../../data/layouts/default.json';
import scenarioJson from '../../fixtures/scenario-mixed.json';
import type { AgentsFile, LayoutFile, Scenario, SourcesFile } from '../../src/contracts/types.ts';
import { createHost } from '../../src/host/index.ts';
import { createFakeRunner } from '../../src/host/runner/fake.ts';

const data = {
  agents: agents as AgentsFile,
  sources: sources as SourcesFile,
  layouts: { default: defaultLayout as LayoutFile },
  scenarios: { default: scenarioJson as Scenario },
};
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('host', () => {
  it('computes a result, a baseline and a money report; People only ⇒ $0 robot cost', async () => {
    const host = createHost(data, createFakeRunner());
    await settle();
    expect(host.result.value?.kpis.oph).toBeGreaterThan(0);
    expect(host.money.value?.capex.value).toBeGreaterThan(0);
    expect(host.baseline.value?.crew.picker).toBeGreaterThan(0);
    host.peopleOnly();
    await settle();
    expect(host.settings.value.fleet.amr).toBe(0);
    expect(host.money.value?.capex.value).toBe(0);
    expect(host.money.value?.robotOpexYear.value).toBe(0);
  });
  it('fleet changes go to the live sim as commands (logged at the next tick)', async () => {
    const host = createHost(data, createFakeRunner());
    host.setFleet('amr', 30);
    host.live.stepTicks(1);
    expect(host.live.sim.commandLog().at(-1)?.c).toEqual({ t: 'setFleet', type: 'amr', count: 30 });
    expect(host.live.snapshot.agents.filter((a) => a.type === 'amr').length).toBe(30);
  });
});

describe('host scenario switching', () => {
  it('switches layout in place: the same LiveSim object, listeners kept, selection cleared', async () => {
    const small = (await import('../../data/scenarios/small.json')).default as Scenario;
    const smallLayout = (await import('../../data/layouts/small.json')).default as LayoutFile;
    const host = createHost(
      { ...data, layouts: { ...data.layouts, small: smallLayout }, scenarios: { ...data.scenarios, small } },
      createFakeRunner(),
    );
    const live = host.live;
    let updates = 0;
    live.onUpdate(() => updates++);
    host.select(0, 3);
    host.setScenario('small');
    expect(host.live).toBe(live);
    expect(host.selected.value).toBeNull();
    expect(host.live.snapshot.width).toBe(smallLayout.grid[0].length);
    host.live.stepTicks(1);
    expect(updates).toBeGreaterThan(0);
  });
});

describe('host money', () => {
  it('buy/rent toggles reuse the cached run (no new sim) and cite sources', async () => {
    let calls = 0;
    const base = createFakeRunner();
    const runner = { ...base, evaluate: (s: Scenario, o?: { saturate?: boolean }) => (calls++, base.evaluate(s, o)) };
    const host = createHost(data, runner);
    await settle();
    const before = calls;
    host.setFinancing('raas');
    await settle();
    expect(calls).toBe(before); // peek hit: no evaluate
    expect(host.money.value?.financing).toBe('raas');
    expect(host.moneyPending.value).toBe(false);
    const froms = host.money.value!.lines[0].capex.inputs.map((i) => i.from);
    expect(froms.some((f) => f.startsWith('source:') || f === 'estimate')).toBe(true);
    expect(host.money.value!.laborYear.inputs.some((i) => i.from === 'source:bls-hand-laborers')).toBe(true);
  });
});

describe('host money pending and failures', () => {
  it('moneyPending turns true right after a fleet change and false when money is ready', async () => {
    const host = createHost(data, createFakeRunner());
    await settle();
    expect(host.moneyPending.value).toBe(false);
    host.setFleet('amr', 31);
    expect(host.moneyPending.value).toBe(true);
    await settle();
    expect(host.moneyPending.value).toBe(false);
    expect(host.money.value?.lines.find((l) => l.type === 'amr')?.count).toBe(31);
  });
  it('a baseline search that fails once is retried, and old money is never shown as current', async () => {
    const { fakeEcon } = await import('../../src/host/econ-port.ts');
    let fails = 1;
    let calls = 0;
    const econ = {
      ...fakeEcon,
      findBaseline: (s: Scenario, r: Parameters<typeof fakeEcon.findBaseline>[1]) => {
        calls++;
        if (fails-- > 0) return Promise.reject(new Error('boom'));
        return fakeEcon.findBaseline(s, r);
      },
    };
    const err = console.error;
    console.error = () => {};
    const host = createHost(data, createFakeRunner(), { econ });
    await settle();
    expect(host.money.value).toBeNull();
    expect(host.moneyPending.value).toBe(false);
    host.setOrderRate(650);
    await settle();
    console.error = err;
    expect(calls).toBe(2);
    expect(host.money.value).not.toBeNull();
    expect(host.moneyPending.value).toBe(false);
  });
});

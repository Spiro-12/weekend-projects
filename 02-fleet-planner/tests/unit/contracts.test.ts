import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import agents from '../../data/agents.json';
import sources from '../../data/sources.json';
import type { AgentsFile, LayoutFile, Scenario, SourcesFile } from '../../src/contracts/types.ts';
import { validateAgents, validateLayout, validateScenario, validateSources, collectSourced } from '../../src/contracts/validate.ts';

const dataDir = new URL('../../data/', import.meta.url);
const load = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, dataDir), 'utf8')) as T;
const layoutIds = readdirSync(new URL('layouts/', dataDir)).map((f) => f.replace(/\.json$/, ''));

describe('data files', () => {
  it('every spec and price has a source, or is an estimate with its reasoning', () => {
    expect(validateSources(agents as AgentsFile, sources as SourcesFile)).toEqual([]);
    expect(collectSourced(agents).length).toBeGreaterThan(40);
  });
  it('agents.json is complete', () => {
    expect(validateAgents(agents as AgentsFile)).toEqual([]);
  });
  it.each(layoutIds)('layout %s is valid', (id) => {
    expect(validateLayout(load<LayoutFile>(`layouts/${id}.json`))).toEqual([]);
  });
  const scenarioFiles = readdirSync(new URL('scenarios/', dataDir));
  it.each(scenarioFiles)('scenario %s is valid', (f) => {
    expect(validateScenario(load<Scenario>(`scenarios/${f}`), layoutIds)).toEqual([]);
  });
  it('the validator catches mistakes', () => {
    const bad = { ...(load<Scenario>('scenarios/default.json')) };
    bad.vendors = { ...bad.vendors, amr: [{ id: 'A', pct: 50 }] };
    bad.fleet = { ...bad.fleet, amr: 2.5 };
    const errs = validateScenario(bad, layoutIds);
    expect(errs.join('\n')).toMatch(/add up to 50/);
    expect(errs.join('\n')).toMatch(/fleet.amr/);
  });
});

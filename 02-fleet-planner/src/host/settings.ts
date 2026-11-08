// Settings = a full Scenario. The runner caches results by a stable hash of the settings.
import type { AgentTypeId, Scenario } from '../contracts/types.ts';
import { fnv1a32 } from '../sim/rng.ts';

/** JSON with sorted keys, so equal settings always hash the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && k !== 'expect' && k !== 'name')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Cache key for runs: everything that changes the simulation (economics only changes the money, not the run). */
export function runKey(s: Scenario): string {
  const rest: Partial<Scenario> = { ...s };
  delete rest.economics;
  return settingsHash(rest as Scenario);
}

export function settingsHash(s: Scenario): string {
  const j = canonicalJson(s);
  return fnv1a32(j).toString(16).padStart(8, '0') + fnv1a32(j.split('').reverse().join('')).toString(16).padStart(8, '0');
}

export function withFleet(s: Scenario, type: AgentTypeId, count: number): Scenario {
  return { ...s, fleet: { ...s.fleet, [type]: Math.max(0, Math.floor(count)) } };
}

/** The same operation without picking robots (cart robots and humanoids); forklifts unchanged. Picker uplift
 *  compares capacity runs with and without them (PROTOCOL §6). */
export function withoutPickingRobots(s: Scenario): Scenario {
  return { ...s, fleet: { ...s.fleet, amr: 0, humanoid: 0 } };
}

/** Every robot count set to zero ("People only"). */
export function peopleOnly(s: Scenario): Scenario {
  return { ...s, fleet: { ...s.fleet, amr: 0, forklift: 0, humanoid: 0 } };
}

// Sim-only test page (sim.html): the real sim and its data, no renderer, no UI. The cross-engine determinism test
// (PROTOCOL §8) hashes the same scenario here and in Node, in Chromium, Firefox and WebKit, without paying for the
// 3D app's start-up (a cold Firefox on a CI runner took over 90 s to get there through the full page).
import agents from '../../data/agents.json';
import type { AgentsFile, LayoutFile, Scenario } from '../contracts/types.ts';
import { createSim } from '../sim/index.ts';

const byId = <T extends { id: string }>(mods: Record<string, { default: T }>) =>
  Object.fromEntries(Object.values(mods).map((m) => [m.default.id, m.default])) as Record<string, T>;
const layouts = byId(import.meta.glob<{ default: LayoutFile }>('../../data/layouts/*.json', { eager: true }));
const scenarios = byId(import.meta.glob<{ default: Scenario }>('../../data/scenarios/*.json', { eager: true }));

window.__fpSim = {
  /** A scenario id, or a whole scenario (the test passes the mixed-fleet fixture so every agent type is hashed). */
  runHash(scenario, ticks) {
    const sc = typeof scenario === 'string' ? scenarios[scenario] : scenario;
    const sim = createSim(sc, { agents: agents as AgentsFile, layout: layouts[sc.layout] });
    sim.step(ticks);
    return sim.hash();
  },
};

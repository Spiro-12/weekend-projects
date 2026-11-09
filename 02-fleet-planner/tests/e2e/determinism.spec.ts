// PROTOCOL §8: same scenario + seed ⇒ the same state hash in Node, Chromium, Firefox and WebKit.
import { expect, test } from '@playwright/test';
import agents from '../../data/agents.json' with { type: 'json' };
import layout from '../../data/layouts/default.json' with { type: 'json' };
import scenario from '../../data/scenarios/default.json' with { type: 'json' };
import mixed from '../../fixtures/scenario-mixed.json' with { type: 'json' };
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { createSim } from '../../src/sim/index.ts';

const TICKS = 7200; // one simulated hour
// sim.html loads only the sim and its data (no 3D). Firefox on the CI runner can take a minute for an hour of sim.
test.describe.configure({ timeout: 180_000 });

for (const [name, sc] of [['default', scenario], ['mixed fleet (every agent type)', mixed]] as const) {
  test(`the browser sim hash equals the Node hash: ${name}`, async ({ page }) => {
    const sim = createSim(sc as Scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
    sim.step(TICKS);
    const nodeHash = sim.hash();
    await page.goto('./sim.html');
    await page.waitForFunction(() => window.__fpSim !== undefined, null, { timeout: 90_000 });
    const browserHash = await page.evaluate(([s, t]) => window.__fpSim!.runHash(s as Scenario, t), [sc, TICKS] as const);
    expect(browserHash).toBe(nodeHash);
  });
}

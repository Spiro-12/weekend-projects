// PROTOCOL §8: same scenario + seed ⇒ the same state hash in Node, Chromium, Firefox and WebKit.
import { expect, test } from '@playwright/test';
import agents from '../../data/agents.json' with { type: 'json' };
import layout from '../../data/layouts/default.json' with { type: 'json' };
import scenario from '../../data/scenarios/default.json' with { type: 'json' };
import type { AgentsFile, LayoutFile, Scenario } from '../../src/contracts/types.ts';
import { createSim } from '../../src/sim/index.ts';

const TICKS = 7200; // one simulated hour

test('the browser sim hash equals the Node hash', async ({ page }) => {
  const sim = createSim(scenario as Scenario, { agents: agents as AgentsFile, layout: layout as LayoutFile });
  sim.step(TICKS);
  const nodeHash = sim.hash();
  await page.goto('./?tier=lite&freeze=1');
  await page.waitForFunction(() => window.__fpSim !== undefined, null, { timeout: 30_000 });
  const browserHash = await page.evaluate((t) => window.__fpSim!.runHash('default', t), TICKS);
  expect(browserHash).toBe(nodeHash);
});

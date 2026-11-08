// Track E: the agent layer (models, ribbons, markers, picking, follow camera, budgets). Uses __fp.render.layers.agents
// debug() / inject() (PROTOCOL §10).
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { expectNoErrors, openApp } from './helpers.ts';

type Dbg = {
  instances: Record<string, number>;
  models: Record<string, string>;
  hero: boolean;
  ribbons: number;
  deadlockRings: number;
  deadlockArrows: number;
  deadlockLabels: number;
  deadlockLabelAnchors: number;
  deadlockArrowSegs: number[];
  heroYaw: number | null;
  selectionRings: number;
  drawCalls: number;
  bloom: boolean;
  injected: boolean;
};

const dbg = (page: Page) => page.evaluate(() => window.__fp!.render.layers.agents.debug!() as unknown as Dbg);
const frames = (page: Page, n = 3) =>
  page.evaluate((k) => new Promise<void>((done) => {
    let i = 0;
    const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/** Wait until the forklift GLBs have replaced the placeholders. */
async function waitModels(page: Page) {
  await page.waitForFunction(() => {
    const d = window.__fp!.render.layers.agents.debug!() as { models: Record<string, string> };
    return d.models.forklift.startsWith('glb') && d.models.driver.startsWith('glb');
  }, null, { timeout: 30_000 });
}

test('every agent type renders as instances, with the GLB forklifts', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await waitModels(page);
  await page.evaluate(() => window.__fp!.freeze(true));
  await frames(page);
  const counts = await page.evaluate(() => {
    const c: Record<string, number> = {};
    for (const a of window.__fp!.host.live.snapshot.agents) c[a.type] = (c[a.type] ?? 0) + 1;
    return c;
  });
  const d = await dbg(page);
  for (const t of ['amr', 'forklift', 'driver', 'humanoid', 'picker']) {
    expect(counts[t] ?? 0, `${t} in the default scenario`).toBeGreaterThan(0);
    expect(d.instances[t], `${t} instances`).toBe(counts[t]);
  }
  await expectNoErrors(errors);
});

test('ribbons: one per robot with a route', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => {
    window.__fp!.freeze(true);
    window.__fp!.host.live.stepTicks(60);
  });
  await frames(page);
  const want = await page.evaluate(() =>
    window.__fp!.host.live.snapshot.agents.filter((a) => (a.type === 'amr' || a.type === 'forklift' || a.type === 'humanoid') && a.route.some((c) => c !== a.cell)).length,
  );
  expect(want).toBeGreaterThan(5);
  expect((await dbg(page)).ribbons).toBe(want);
  await expectNoErrors(errors);
});

test('lite drops ribbons; low keeps every other robot', async ({ page }) => {
  const errors = await openApp(page, '?tier=lite');
  await page.evaluate(() => {
    window.__fp!.freeze(true);
    window.__fp!.host.live.stepTicks(60);
  });
  await frames(page);
  expect((await dbg(page)).ribbons).toBe(0);
  await page.evaluate(() => window.__fp!.render.layers.agents.setTier('low'));
  await frames(page);
  const robots = await page.evaluate(() =>
    window.__fp!.host.live.snapshot.agents.filter((a) => (a.type === 'amr' || a.type === 'forklift' || a.type === 'humanoid') && a.route.some((c) => c !== a.cell)).length,
  );
  const low = (await dbg(page)).ribbons;
  expect(low).toBeGreaterThan(0);
  expect(low).toBeLessThanOrEqual(Math.ceil(robots / 2) + 1);
  await expectNoErrors(errors);
});

test('deadlock markers: pulsing rings, arrows along the wait-for cycle and a label', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => window.__fp!.freeze(true));
  const centres = await page.evaluate(() => {
    const fp = window.__fp!;
    const s = structuredClone(fp.host.live.snapshot);
    const at = (x: number, y: number) => y * s.width + x;
    const [a, b] = s.agents.filter((x) => x.type === 'amr');
    for (const [g, y, h] of [[a, 14, 1], [b, 15, 3]] as const) {
      g.cell = at(20, y);
      g.to = -1;
      g.heading = h;
      g.state = 'blocked';
      g.blockedTicks = 90;
    }
    a.waitOn = b.id;
    b.waitOn = a.id;
    s.deadlocks = [{ ids: [a.id, b.id], sinceTick: s.tick - 84 }];
    fp.render.layers.agents.inject!(s);
    return [a.id, b.id];
  });
  await frames(page);
  const d = await dbg(page);
  // Visible arrows: nose to nose, each arrow runs in its own lane beside the bodies (not under them), on opposite
  // sides of the centre line, pointing opposite ways, and at least a metre long.
  const pos = await page.evaluate((ids) => ids.map((i) => {
    const p = window.__fp!.render.layers.agents.positionOf(i)!;
    return [p.x, p.z];
  }), centres);
  const [ax, az] = pos[0];
  const [bx, bz] = pos[1];
  const len = Math.hypot(bx - ax, bz - az);
  const side = (x: number, z: number) => ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / len; // signed distance off the line
  expect(d.deadlockArrowSegs.length).toBe(8);
  const offs: number[] = [];
  for (let i = 0; i < 8; i += 4) {
    const [x0, z0, x1, z1] = d.deadlockArrowSegs.slice(i, i + 4);
    expect(Math.hypot(x1 - x0, z1 - z0)).toBeGreaterThan(1);
    const off = side((x0 + x1) / 2, (z0 + z1) / 2);
    expect(Math.abs(off), 'arrow clear of the 0.56 m wide robot bodies').toBeGreaterThan(0.35);
    expect(Math.abs(side(x0, z0) - side(x1, z1))).toBeLessThan(0.01);
    offs.push(off);
  }
  expect(Math.sign(offs[0])).toBe(-Math.sign(offs[1]));
  expect(d.injected).toBe(true);
  expect(d.deadlockRings).toBe(2);
  expect(d.deadlockArrows).toBe(2);
  expect(d.deadlockLabelAnchors).toBe(1);
  expect(d.deadlockLabels).toBe(1);
  await expect(page.getByTestId('deadlock-label')).toHaveText('DEADLOCK 0:42');
  await page.evaluate(() => window.__fp!.render.layers.agents.inject!(null));
  await frames(page);
  const after = await dbg(page);
  expect(after.injected).toBe(false);
  expect(after.deadlockRings).toBe(0);
  await expect(page.getByTestId('deadlock-label')).toBeHidden();
  await expectNoErrors(errors);
});

test('click an agent (via render.project) to follow it, Escape returns to the overview', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => window.__fp!.freeze(true));
  await frames(page);
  // The agent nearest the middle of the screen (away from the panels).
  const target = await page.evaluate(() => {
    const fp = window.__fp!;
    let best: { id: number; x: number; y: number; d: number } | null = null;
    for (const a of fp.host.live.snapshot.agents) {
      const p = fp.render.project(a.id);
      if (!p) continue;
      const d = Math.hypot(p.x - innerWidth / 2, p.y - innerHeight * 0.6);
      if (!best || d < best.d) best = { id: a.id, x: p.x, y: p.y, d };
    }
    return best!;
  });
  expect(await page.evaluate(([x, y]) => window.__fp!.render.pick(x, y), [target.x, target.y])).toBe(target.id);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => window.__fp!.render.following());
  expect((await page.evaluate(() => window.__fp!.host.selected.value))?.agentId).toBe(target.id);
  expect(await page.evaluate(() => window.__fp!.render.following())).toBe(true);
  expect((await dbg(page)).selectionRings).toBe(1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__fp!.render.following());
  expect(await page.evaluate(() => window.__fp!.host.selected.value)).toBeNull();
  expect(await page.evaluate(() => window.__fp!.render.following())).toBe(false);
  await expectNoErrors(errors);
});

test('picking: most agents at the overview pick back to themselves', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => window.__fp!.freeze(true));
  await frames(page);
  const r = await page.evaluate(() => {
    const fp = window.__fp!;
    let tried = 0;
    let hit = 0;
    for (const a of fp.host.live.snapshot.agents) {
      const p = fp.render.project(a.id);
      if (!p || p.x < 20 || p.y < 160 || p.x > innerWidth - 20 || p.y > innerHeight - 20) continue;
      tried++;
      if (fp.render.pick(p.x, p.y) === a.id) hit++;
    }
    return { tried, hit };
  });
  expect(r.tried).toBeGreaterThan(20);
  expect(r.hit / r.tried).toBeGreaterThanOrEqual(0.85);
  await expectNoErrors(errors);
});

test('following a picker swaps in the skinned hero worker, facing where the picker walks', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  // A picker that is walking (so its heading is its travel direction).
  const id = await page.evaluate(() => {
    const live = window.__fp!.host.live;
    for (let t = 0; t < 2000; t++) {
      const p = live.snapshot.agents.find((a) => a.type === 'picker' && a.to >= 0 && a.route.length > 3);
      if (p) return p.id;
      live.stepTicks(1);
    }
    return live.snapshot.agents.find((a) => a.type === 'picker')!.id;
  });
  await page.evaluate((i) => window.__fp!.host.select(0, i), id);
  await page.waitForFunction(() => (window.__fp!.render.layers.agents.debug!() as { hero: boolean }).hero, null, { timeout: 20_000 });
  // The hero's feet must point the way the followed picker faces (the chase camera sits behind that).
  const diffs: number[] = [];
  for (let k = 0; k < 6; k++) {
    await frames(page, 6);
    const r = await page.evaluate((i) => {
      const layer = window.__fp!.render.layers.agents;
      const d = layer.debug!() as { heroYaw: number | null };
      const t = layer.followTarget(i);
      return { hero: d.heroYaw, yaw: t?.yaw ?? null };
    }, id);
    if (r.hero === null || r.yaw === null) continue;
    let dy = r.hero - r.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    diffs.push(Math.abs(dy));
  }
  expect(diffs.length).toBeGreaterThan(3);
  diffs.sort((a, b) => a - b);
  expect(diffs[Math.floor(diffs.length / 2)], 'median |hero yaw − followed yaw| (rad)').toBeLessThan(0.5);
  await page.evaluate(() => window.__fp!.host.select(0, null));
  await frames(page);
  expect((await dbg(page)).hero).toBe(false);
  await expectNoErrors(errors);
});

test('agents + effects stay within 20 draw calls at the overview with 150 robots', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium&agents=150');
  await waitModels(page);
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  await page.waitForTimeout(600);
  const all = await page.evaluate(() => window.__fp!.render.info().calls);
  await page.evaluate(() => (window.__fp!.render.roots.agents.visible = false));
  await frames(page, 4);
  const world = await page.evaluate(() => window.__fp!.render.info().calls);
  await page.evaluate(() => (window.__fp!.render.roots.agents.visible = true));
  const d = await dbg(page);
  console.log(`150 robots, medium overview: ${all} draw calls total, ${world} world, ${all - world} agents + fx (layer reports ${d.drawCalls}); amr instances ${d.instances.amr}`);
  expect(d.instances.amr).toBe(150);
  expect(all - world).toBeLessThanOrEqual(20);
  expect(d.drawCalls).toBeLessThanOrEqual(20);
  await expectNoErrors(errors);
});

/** Mean brightness (0..255) of the 3D view below the KPI tiles, at the frozen first frame and the overview. */
async function viewMean(page: Page): Promise<number> {
  const buf = await page.screenshot({ clip: { x: 0, y: 160, width: 1440, height: 700 } });
  const st = await sharp(buf).removeAlpha().stats();
  return (st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3;
}

test('high tier turns bloom on, and only emissive things glow (the floor and racks stay as dark as medium)', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium&freeze=1');
  await waitModels(page);
  await frames(page, 10);
  const medium = await viewMean(page);
  await page.goto('./?tier=high&freeze=1');
  await page.waitForFunction(() => (window.__fp?.render.layers.agents.debug?.() as { bloom?: boolean } | undefined)?.bloom === true, null, { timeout: 20_000 });
  await waitModels(page);
  await frames(page, 10);
  const high = await viewMean(page);
  console.log(`view mean brightness: medium ${medium.toFixed(1)}, high (bloom) ${high.toFixed(1)}`);
  // A bloom veil over lit surfaces lifts the whole frame (it did by ~20% with the threshold at 1.25).
  expect(high).toBeLessThanOrEqual(medium * 1.06 + 2);
  await expectNoErrors(errors);
});

test('hover shows name · type · state over an agent (desktop)', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => {
    window.__fp!.freeze(true);
    window.__fp!.host.live.stepTicks(20);
  });
  await frames(page);
  const t = await page.evaluate(() => {
    const fp = window.__fp!;
    let best: { name: string; x: number; y: number; d: number } | null = null;
    for (const a of fp.host.live.snapshot.agents) {
      if (a.type !== 'humanoid' && a.type !== 'amr') continue;
      const p = fp.render.project(a.id);
      if (!p) continue;
      const d = Math.hypot(p.x - innerWidth / 2, p.y - innerHeight * 0.6);
      if (!best || d < best.d) best = { name: a.name, x: p.x, y: p.y, d };
    }
    return best!;
  });
  await page.mouse.move(t.x - 30, t.y - 30);
  await page.mouse.move(t.x, t.y, { steps: 4 });
  const label = page.getByTestId('agent-hover');
  await expect(label).toBeVisible();
  await expect(label).toContainText(`${t.name} · `);
  await expectNoErrors(errors);
});

test('switching to another layout rebuilds the agent layer cleanly', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.evaluate(() => {
    (window as unknown as { __oldLayer: unknown }).__oldLayer = window.__fp!.render.layers.agents;
    window.__fp!.host.setScenario('small');
  });
  // Wait for the new layer to draw every agent of the new scenario.
  await page.waitForFunction(() => {
    const fp = window.__fp!;
    const layer = fp.render.layers.agents;
    if (layer === (window as unknown as { __oldLayer: unknown }).__oldLayer) return false;
    const d = layer.debug!() as { instances: Record<string, number> };
    const total = Object.values(d.instances).reduce((a, b) => a + b, 0);
    return total > 0 && total === fp.host.live.snapshot.agents.length;
  }, null, { timeout: 20_000 });
  const r = await page.evaluate(() => {
    const fp = window.__fp!;
    const d = fp.render.layers.agents.debug!() as { instances: Record<string, number> };
    const total = Object.values(d.instances).reduce((a, b) => a + b, 0);
    return { total, agents: fp.host.live.snapshot.agents.length, overlays: document.querySelectorAll('[data-testid="agent-labels"]').length };
  });
  expect(r.total).toBe(r.agents);
  expect(r.overlays).toBe(1);
  await expectNoErrors(errors);
});

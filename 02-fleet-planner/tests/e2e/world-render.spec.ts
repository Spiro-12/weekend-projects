// Track D: the world layer loads cleanly, swaps in the SimReady models, and stays inside its draw-call and triangle
// budget (≤ 35 draw calls, ≤ 600k triangles per view at medium, world alone) at the overview and in an aisle.
import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, openApp } from './helpers.ts';

const WORLD_CALLS = 35;
const WORLD_TRIS = 600_000;

async function worldOnly(page: Page) {
  await page.evaluate(() => {
    window.__fp!.render.roots.agents.visible = false;
    window.__fp!.render.roots.fx.visible = false;
  });
  await page.waitForTimeout(500);
  return page.evaluate(() => window.__fp!.render.info());
}

test('world loads, the SimReady models replace the stand-ins, no errors', async ({ page }) => {
  // Hold the GLBs back a little so the first (procedural) view is measurable on its own.
  await page.route('**/assets/*.glb', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const errors = await openApp(page, '?tier=medium');
  const before = await worldOnly(page);
  const dbg0 = await page.evaluate(() => window.__fp!.render.layers.world.debug?.() as { models: Record<string, string> });
  expect(Object.keys(dbg0.models)).toHaveLength(0);
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.__fp!.render.info());
  const dbg = await page.evaluate(() => window.__fp!.render.layers.world.debug?.() as { models: Record<string, string>; failed: string[]; racks: { fillPct: number; faces: number } });
  console.log(`world (medium overview): first view ${before.views[0].calls} calls / ${before.triangles} tris; full look ${after.views[0].calls} calls / ${after.triangles} tris`);
  console.log(`models: ${Object.keys(dbg.models).join(', ')}`);
  expect(after.triangles).toBeGreaterThan(before.triangles * 1.5);
  for (const k of ['pallet_loaded', 'pallet_wrapped', 'column', 'light_panel', 'dock_gate', 'pack_table', 'conveyor', 'guard_rail'])
    expect(dbg.models, `model ${k}`).toHaveProperty(k);
  expect(dbg.failed).toEqual([]);
  // Racks are 65 to 80% full and every rack cell has its slot list (Phase 2 stock changes).
  expect(dbg.racks.fillPct).toBeGreaterThanOrEqual(65);
  expect(dbg.racks.fillPct).toBeLessThanOrEqual(80);
  expect(dbg.racks.faces).toBeGreaterThan(100);
  await expectNoErrors(errors);
});

test('world alone stays inside its budget: overview and an aisle (near SimReady loads)', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  await page.waitForFunction(() => window.__fp!.perf.fullLookMs != null, null, { timeout: 30_000 });
  const ov = await worldOnly(page);
  console.log(`world overview (medium): ${ov.views[0].calls} draw calls, ${ov.views[0].triangles} triangles`);
  expect(ov.views[0].calls).toBeLessThanOrEqual(WORLD_CALLS);
  expect(ov.views[0].triangles).toBeLessThanOrEqual(WORLD_TRIS);
  // The 'aisle' tour starts at the south end of the middle aisle, at robot height, looking down it.
  await page.evaluate(() => {
    void window.__fp!.tour('aisle', 600);
  });
  // Wait for the camera to arrive and the near set to be re-picked (slow software GL in CI gets more time).
  await page.waitForFunction(() => (window.__fp!.render.layers.world.debug?.() as { racks: { nearPallets: number } }).racks.nearPallets > 20, null, { timeout: 15_000 });
  const near = await page.evaluate(() => (window.__fp!.render.layers.world.debug?.() as { racks: { nearPallets: number } }).racks.nearPallets);
  const aisle = await worldOnly(page);
  console.log(`world aisle (medium): ${aisle.views[0].calls} draw calls, ${aisle.views[0].triangles} triangles, ${near} SimReady pallets`);
  expect(near).toBeGreaterThan(20);
  expect(aisle.views[0].calls).toBeLessThanOrEqual(WORLD_CALLS);
  expect(aisle.views[0].triangles).toBeLessThanOrEqual(WORLD_TRIS);
  await expectNoErrors(errors);
});

test('a rack face can be emptied and refilled (Phase 2 stock hook), loose top cartons included', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  const r = await page.evaluate(() => {
    const w = window.__fp!.render.layers.world as unknown as {
      setFaceFill(cell: number, fill: number): number;
      faceBlocksDrawn(cell: number): { blocks: number; drawn: number };
      debug(): { racks: { stocked: number }; sampleFace: number };
    };
    const before = w.debug().racks.stocked;
    // Empty every stocked face once: no block (pallet or loose top layer) of an emptied face may stay drawn.
    const faces = [w.debug().sampleFace];
    const drawnBefore = w.faceBlocksDrawn(faces[0]);
    const emptied = w.setFaceFill(faces[0], 0);
    const drawnEmpty = w.faceBlocksDrawn(faces[0]);
    const mid = w.debug().racks.stocked;
    w.setFaceFill(faces[0], 1);
    const drawnFull = w.faceBlocksDrawn(faces[0]);
    const after = w.debug().racks.stocked;
    return { before, mid, after, emptied, drawnBefore, drawnEmpty, drawnFull };
  });
  expect(r.emptied).toBe(0);
  expect(r.mid).toBeLessThan(r.before);
  expect(r.after).toBeGreaterThanOrEqual(r.before);
  expect(r.drawnBefore.blocks).toBeGreaterThan(0);
  expect(r.drawnEmpty.drawn).toBe(0);
  expect(r.drawnFull.drawn).toBe(r.drawnFull.blocks);
  // Every face of the hall: emptying leaves nothing floating.
  const all = await page.evaluate(() => {
    const w = window.__fp!.render.layers.world as unknown as {
      setFaceFill(cell: number, fill: number): number;
      faceBlocksDrawn(cell: number): { blocks: number; drawn: number };
      debug(): { grid: [number, number] };
    };
    const [W, H] = w.debug().grid;
    let left = 0;
    let faces = 0;
    for (let c = 0; c < W * H; c++) {
      const d = w.faceBlocksDrawn(c);
      if (!d.blocks) continue;
      faces++;
      w.setFaceFill(c, 0);
      left += w.faceBlocksDrawn(c).drawn;
    }
    return { faces, left };
  });
  expect(all.faces).toBeGreaterThan(100);
  expect(all.left).toBe(0);
  await expectNoErrors(errors);
});

test('switching layouts twice frees the old world (GPU geometries and textures come back to the same counts)', async ({ page }) => {
  const errors = await openApp(page, '?tier=medium');
  type Dbg = { fullLookDone: boolean; gpu: { geometries: number; textures: number }; size: number[] };
  const settle = async (id: string) => {
    await page.evaluate((id) => window.__fp!.host.setScenario(id), id);
    await page.waitForFunction(
      (id) => {
        const d = window.__fp!.render.layers.world.debug?.() as Dbg;
        return d.fullLookDone && window.__fp!.host.settings.value.layout === id;
      },
      id,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(800);
    return (await page.evaluate(() => window.__fp!.render.layers.world.debug?.() as Dbg)).gpu;
  };
  await page.waitForFunction(() => (window.__fp!.render.layers.world.debug?.() as Dbg).fullLookDone, null, { timeout: 30_000 });
  await settle('small');
  const first = await settle('default');
  await settle('small');
  const second = await settle('default');
  console.log(`GPU objects after default → small → default: ${JSON.stringify(first)}, again: ${JSON.stringify(second)}`);
  expect(second.geometries).toBe(first.geometries);
  expect(second.textures).toBe(first.textures);
  await expectNoErrors(errors);
});

import { describe, expect, it } from 'vitest';
import defaultLayout from '../../data/layouts/default.json';
import small from '../../data/layouts/small.json';
import large from '../../data/layouts/large.json';
import type { LayoutFile } from '../../src/contracts/types.ts';
import { buildWorld, DistanceCache, multiSourceBfs, UNREACHABLE, cx, cy } from '../../src/sim/world.ts';
import { PRESETS, generateLayout } from '../../src/sim/layout-gen.ts';

const layouts = [defaultLayout, small, large] as LayoutFile[];

describe('layouts', () => {
  it('checked-in layouts match the generator (run npm run layouts after changing it)', () => {
    for (const p of PRESETS) {
      const file = layouts.find((l) => l.id === p.id)!;
      expect(file.grid).toEqual(generateLayout(p).grid);
    }
  });

  for (const layout of layouts) {
    describe(layout.id, () => {
      const w = buildWorld(layout);
      it('has faces, stations, docks, chargers and parking', () => {
        expect(w.faces.length).toBeGreaterThan(100);
        expect(w.packStations.length).toBeGreaterThan(0);
        expect(w.docks.length).toBeGreaterThan(0);
        expect(w.chargers.filter((c) => c.forClass === 'small').length).toBeGreaterThanOrEqual(4);
        expect(w.chargers.filter((c) => c.forClass === 'forklift').length).toBeGreaterThanOrEqual(1);
        expect(w.parking.length).toBeGreaterThan(0);
        expect(w.humanHome.length).toBeGreaterThan(0);
      });
      it('every pick face is reachable by robots and people from the pack stations', () => {
        const sources = w.packStations.map((s) => s.service);
        for (const cls of ['small', 'human'] as const) {
          const d = multiSourceBfs(w, cls, sources);
          for (const f of w.faces) expect(d[f.cell], `${cls} face ${cx(w, f.cell)},${cy(w, f.cell)}`).not.toBe(UNREACHABLE);
        }
      });
      it('forklifts reach every dock, every pick face (replenishment) and their chargers', () => {
        const dist = new DistanceCache(w);
        const start = w.docks[0].service;
        for (const dk of w.docks) expect(dist.to('forklift', dk.service)[start]).not.toBe(UNREACHABLE);
        for (const f of w.faces) expect(dist.to('forklift', f.cell)[start]).not.toBe(UNREACHABLE);
        for (const c of w.chargers.filter((c) => c.forClass === 'forklift')) expect(dist.to('forklift', c.cell)[start]).not.toBe(UNREACHABLE);
      });
      it('robots can leave a charger pocket and routes never pass through another pocket', () => {
        const dist = new DistanceCache(w);
        const c = w.chargers.find((p) => p.forClass === 'small')!;
        const goal = w.faces[0].cell;
        const route = dist.route('small', c.cell, goal, 10_000);
        expect(route.at(-1)).toBe(goal);
        for (const cell of route) expect(w.isPocket[cell]).toBe(0);
      });
    });
  }
});

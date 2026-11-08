import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createSim, makeOpts, TICKS_PER_HOUR, type Fleet, type Mode } from '../src/index.ts';
import { assignGreedy, assignOptimal, HungarianScratch } from '../src/assign.ts';
import { stream } from '../../../src/sim/rng.ts';

const W = 62; // default layout width
const at = (x: number, y: number) => y * W + x;
const NONE: Fleet = { amr: 0, forklift: 0, humanoid: 0, picker: 0, driver: 0 };

/** Place agents by hand (id order = robots first, then people) and run until each has reached its goal. */
function crossing(mode: Mode, fleet: Fleet, places: [number, number][], maxTicks: number) {
  const sim = createSim(makeOpts(mode, { fleet, warmupTicks: 0 }));
  // park everyone first on free cells of the top cross aisle, so the real placement never collides
  let x = 10;
  for (const a of sim.agents) {
    while (sim.occ[at(x, 3)] >= 0 && sim.occ[at(x, 3)] !== a.id) x++;
    sim.placeForTest(a, at(x, 3), at(x, 3));
    x++;
  }
  sim.agents.forEach((a, i) => sim.placeForTest(a, places[i][0], places[i][1]));
  const reached = sim.agents.map(() => -1);
  for (let t = 1; t <= maxTicks && reached.some((r) => r < 0); t++) {
    sim.step();
    sim.agents.forEach((a, i) => {
      if (reached[i] < 0 && a.cell === places[i][1]) reached[i] = t;
    });
  }
  return { sim, reached, r: sim.result() };
}

const zeroViolations = { overlap: 0, occMismatch: 0, robotIntoPerson: 0, personIntoRobot: 0, moveIntoHeld: 0 };

describe('spike b traffic', () => {
  it('is deterministic: same seed, same hash; different seed, different hash', () => {
    for (const mode of ['central', 'siloed'] as const) {
      const h = (seed: number) => {
        const sim = createSim(makeOpts(mode, { seed }));
        sim.run(30 * 120);
        return sim.hash();
      };
      expect(h(42)).toBe(h(42));
      expect(h(42)).not.toBe(h(43));
    }
  });

  it('every number in the canonical state is an integer', () => {
    const sim = createSim(makeOpts('siloed'));
    sim.run(600);
    const words = sim.stateWords();
    expect(words.length).toBeGreaterThan(1000);
    for (const x of words) expect(Number.isSafeInteger(x)).toBe(true);
  });

  for (const mode of ['central', 'siloed'] as const) {
    it(`${mode}: 8 h default fleet, checked every tick: no overlaps, no robot into a person, no permanent gridlock`, () => {
      const sim = createSim(makeOpts(mode, { checks: true }));
      sim.run(8 * TICKS_PER_HOUR);
      const r = sim.result();
      expect(r.violations).toEqual(zeroViolations);
      expect(r.deadlocks.activeAtEndTicks).toBeLessThan(240); // nothing stuck at the end: no permanent gridlock
      if (mode === 'central') expect(r.deadlocks.maxTicks).toBeLessThanOrEqual(240); // one brain: all clear in 2 min
      else {
        // many brains: almost all self-clear in 2 min; the rare rest end by the 5 min manual reset at the latest
        expect(r.deadlocks.over2min).toBeLessThanOrEqual(3);
        expect(r.deadlocks.maxTicks).toBeLessThanOrEqual(5 * 120 + 120);
      }
      expect(r.tasksPerHour.pickRobots).toBeGreaterThan(300);
      expect(r.people.stepAsides).toBeGreaterThan(0);
    });
  }

  it('one robot and one person head-on in a 2-cell aisle pass each other', () => {
    for (const mode of ['central', 'siloed'] as const) {
      const { reached, r } = crossing(mode, { ...NONE, amr: 1, picker: 1 }, [
        [at(4, 6), at(4, 24)],
        [at(4, 24), at(4, 6)],
      ], 400);
      expect(reached.every((t) => t > 0), `${mode} ${reached}`).toBe(true);
      expect(Math.max(...reached)).toBeLessThan(120); // 18 cells at 3 ticks/cell is 54 ticks
      expect(r.violations).toEqual(zeroViolations);
    }
  });

  it('three robots and three people crossing in one aisle all get through', () => {
    for (const mode of ['central', 'siloed'] as const) {
      const { reached, r } = crossing(mode, { ...NONE, amr: 3, picker: 3 }, [
        [at(4, 6), at(4, 24)],
        [at(5, 8), at(5, 22)],
        [at(4, 10), at(5, 25)],
        [at(4, 24), at(4, 6)],
        [at(5, 21), at(5, 7)],
        [at(4, 19), at(4, 9)],
      ], 800);
      expect(reached.every((t) => t > 0), `${mode} ${reached}`).toBe(true);
      expect(r.violations).toEqual(zeroViolations);
    }
  });

  it('two vendors head-on: one brain pushes, many brains needs the ladder and is slower', () => {
    const run = (mode: Mode) =>
      crossing(mode, { ...NONE, amr: 2 }, [
        [at(4, 8), at(4, 22)],
        [at(4, 22), at(4, 8)],
      ], 1200);
    const one = run('central');
    const many = run('siloed');
    expect(one.sim.agents[0].vendor).not.toBe(one.sim.agents[1].vendor);
    expect(one.reached.every((t) => t > 0)).toBe(true);
    expect(many.reached.every((t) => t > 0)).toBe(true);
    expect(Math.max(...many.reached)).toBeGreaterThan(Math.max(...one.reached));
    expect(many.r.ladder.detours + many.r.ladder.randomSteps).toBeGreaterThan(0);
  });

  it('optimal assignment never costs more than greedy and matches brute force on small cases', () => {
    const rng = stream(1, 'assign-test');
    const n = 6;
    const perms: number[][] = [];
    const permute = (a: number[], k: number) => {
      if (k === a.length) return void perms.push([...a]);
      for (let i = k; i < a.length; i++) {
        [a[k], a[i]] = [a[i], a[k]];
        permute(a, k + 1);
        [a[k], a[i]] = [a[i], a[k]];
      }
    };
    permute([0, 1, 2, 3, 4, 5], 0);
    const out = new Int32Array(n);
    const used = new Uint8Array(n);
    const s = new HungarianScratch(n, n);
    for (let trial = 0; trial < 50; trial++) {
      const c = new Int32Array(n * n).map(() => rng.int(100));
      const best = Math.min(...perms.map((p) => p.reduce((sum, j, i) => sum + c[i * n + j], 0)));
      const opt = assignOptimal(c, n, n, out, s);
      expect(new Set(out).size).toBe(n);
      expect(opt).toBe(best);
      expect(assignGreedy(c, n, n, out, used)).toBeGreaterThanOrEqual(opt);
    }
  });

  it('spike sim code uses no banned APIs (PROTOCOL §8)', () => {
    const dir = new URL('../src/', import.meta.url);
    const banned = /Math\.random|Date\.|Date\(|performance\.now|Math\.(sin|cos|tan|exp|log|pow|atan2|hypot|sqrt)\b|\*\*/;
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(banned.test(src), f).toBe(false);
    }
  });
});

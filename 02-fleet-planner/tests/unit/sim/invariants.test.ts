// Invariants checked every tick for 2 h on the default scenario, with NaiveController and with a test controller:
// never two agents in one cell (counting move targets and safety cells), no forklift or driver on a '.' cell, no robot
// enters a person's cell, pockets entered only as a goal, battery never negative.
import { describe, expect, it } from 'vitest';
import { Cell } from '../../../src/sim/world.ts';
import { makeSim, scenario } from './helpers/data.ts';

const TICKS = 2 * 7200;

for (const pibt of [false, true]) {
  describe(`invariants every tick for 2 h (${pibt ? 'one-brain CentralController' : 'NaiveController'})`, () => {
    const sim = makeSim(scenario(), { pibt, checks: true });
    const w = sim.world;
    const found = { overlap: 0, occ: 0, forkOnNarrow: 0, pocketNotGoal: 0, robotIntoPerson: 0, negativeBattery: 0, moves: 0, robotMoves: 0 };
    const seen = new Int32Array(w.n).fill(-1);
    // A robot move starts this tick into a cell a person held at the start of the tick: compare with last tick's cells.
    let personCells = new Set<number>();
    for (let t = 0; t < TICKS; t++) {
      sim.step(1);
      const tick = sim.tick - 1;
      const now = new Set<number>();
      let held = 0;
      for (const a of sim.agents) {
        for (const c of [a.cell, a.to, a.safety]) {
          if (c < 0) continue;
          held++;
          if (seen[c] === tick) found.overlap++;
          seen[c] = tick;
          if (sim.occ[c] !== a.id) found.occ++;
        }
        if ((a.typeId === 'forklift' || a.typeId === 'driver') && (w.code[a.cell] === Cell.Narrow || (a.to >= 0 && w.code[a.to] === Cell.Narrow))) found.forkOnNarrow++;
        if (a.robot && a.to >= 0 && a.moveStart === tick) {
          found.robotMoves++;
          if (w.isPocket[a.to] && a.to !== a.goal) found.pocketNotGoal++;
          if (personCells.has(a.to)) found.robotIntoPerson++;
        }
        if (a.to >= 0 && a.moveStart === tick) found.moves++;
        if (a.battery < 0) found.negativeBattery++;
        if (!a.robot) {
          // a person whose move ends at the next tick boundary has left its old cell by then (it lands first)
          if (!(a.to >= 0 && a.moveEnd <= tick + 1)) now.add(a.cell);
          if (a.to >= 0) now.add(a.to);
        }
      }
      let used = 0;
      for (let c = 0; c < w.n; c++) if (sim.occ[c] >= 0) used++;
      if (used !== held) found.occ++;
      personCells = now;
    }

    it('never two agents in one cell, and occ matches every agent', () => {
      expect(found.overlap).toBe(0);
      expect(found.occ).toBe(0);
    });
    it('no forklift or driver on a narrow cell', () => expect(found.forkOnNarrow).toBe(0));
    it('no robot enters a person’s cell', () => expect(found.robotIntoPerson).toBe(0));
    it('pockets are entered only as a goal', () => expect(found.pocketNotGoal).toBe(0));
    it('battery never negative', () => expect(found.negativeBattery).toBe(0));
    it('the core’s own per-tick checks agree (no refused or invalid moves)', () => {
      expect(sim.debug().violations).toEqual({
        overlap: 0, occMismatch: 0, moveIntoHeld: 0, robotIntoPerson: 0, forkOnNarrow: 0, pocketNotGoal: 0, badMove: 0, negativeBattery: 0,
      });
    });
    it('agents actually move (the check is not vacuous)', () => {
      expect(found.robotMoves).toBeGreaterThan(500);
      expect(found.moves).toBeGreaterThan(found.robotMoves);
    });
  });
}

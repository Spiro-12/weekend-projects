// Work-model rules from calibration: manual cart setup, put-to-cart, per-tote hand-off, people's patience with robot
// claims, and the state of robots queued for a charger.
import { describe, expect, it } from 'vitest';
import { CART_SETUP_SEC, PEOPLE_PATIENCE_TICKS, PUT_TO_CART_SEC, TOTE_HANDOFF_SEC } from '../../../src/sim/core/constants.ts';
import { secToTicks } from '../../../src/sim/motion.ts';
import { makeSim, scenario } from './helpers/data.ts';

const J_PICK = 1;
const PK_AT_STOP = 1;
const PK_HANDOFF = 3;
const PK_SETUP = 4;
const ST_WAIT = 3;

type TaskRef = { orders: number[]; amr: boolean };
const taskOf = (sim: ReturnType<typeof makeSim>, id: number) => (sim as unknown as { taskById: Map<number, TaskRef> }).taskById.get(id)!;

describe('manual cart picking costs', () => {
  // people only at a low rate, so carts leave with one order as well as with several
  const sim = makeSim(scenario({ fleet: { amr: 0, humanoid: 0, forklift: 0 }, orders: { mode: 'demand', perHour: 120 } }), { pibt: true });
  const setups: { ticks: number; still: boolean }[] = [];
  const picks: { orders: number; units: number; ticks: number; pickTicks: number }[] = [];
  const handoffs: { orders: number; ticks: number }[] = [];
  const setupCell = new Map<number, number>();
  const current = new Map<number, { ticks: number; still: boolean }>();
  for (let k = 0; k < 4 * 7200; k++) {
    sim.step(1);
    const t = sim.tick - 1;
    for (const p of sim.people) {
      if (p.typeId !== 'picker' || p.job !== J_PICK || p.dwellUntil === 0) continue;
      if (p.stage === PK_SETUP) {
        if (p.dwellStart === t) {
          setupCell.set(p.id, p.cell);
          const rec = { ticks: p.dwellUntil - p.dwellStart, still: true };
          setups.push(rec);
          current.set(p.id, rec);
        } else if (setupCell.get(p.id) !== p.cell || p.to >= 0) current.get(p.id)!.still = false;
      } else if (p.dwellStart === t) {
        const task = taskOf(sim, p.taskId);
        if (p.stage === PK_AT_STOP) picks.push({ orders: task.orders.length, units: p.dwellUnits, ticks: p.dwellUntil - p.dwellStart, pickTicks: p.pickTicks });
        if (p.stage === PK_HANDOFF) handoffs.push({ orders: task.orders.length, ticks: p.dwellUntil - p.dwellStart });
      }
    }
  }

  it('every cart trip starts with the cart setup, standing still', () => {
    expect(setups.length).toBeGreaterThan(20);
    for (const s of setups) {
      expect(s.ticks).toBe(secToTicks(CART_SETUP_SEC));
      expect(s.still).toBe(true);
    }
  });
  it('put-to-cart adds its ticks per unit only on a multi-order cart', () => {
    const put = secToTicks(PUT_TO_CART_SEC);
    const single = picks.filter((p) => p.orders === 1);
    const multi = picks.filter((p) => p.orders > 1);
    expect(single.length).toBeGreaterThan(10);
    expect(multi.length).toBeGreaterThan(10);
    for (const p of single) expect(p.ticks).toBe(p.units * p.pickTicks);
    for (const p of multi) expect(p.ticks).toBe(p.units * (p.pickTicks + put));
  });
  it('a cart is handed off tote by tote: orders × TOTE_HANDOFF_SEC', () => {
    expect(handoffs.length).toBeGreaterThan(20);
    for (const h of handoffs) expect(h.ticks).toBe(h.orders * secToTicks(TOTE_HANDOFF_SEC));
    expect(secToTicks(TOTE_HANDOFF_SEC)).toBe(20);
  });
});

describe('cart robots hand off in one go', () => {
  it('a cart robot’s hand-off is its spec handoffSec, however many totes it carries', () => {
    const sim = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    const seen: number[] = [];
    for (let k = 0; k < 3600; k++) {
      sim.step(1);
      for (const r of sim.robots)
        if (r.typeId === 'amr' && r.job === J_PICK && r.stage === PK_HANDOFF && r.dwellStart === sim.tick - 1) seen.push(r.dwellUntil - r.dwellStart);
    }
    expect(seen.length).toBeGreaterThan(20);
    expect(new Set(seen)).toEqual(new Set([20]));
  });
});

describe('people’s patience with robot claims', () => {
  it('a person walled in by cells a robot keeps claiming stays put, then passes after PEOPLE_PATIENCE_TICKS blocked ticks', () => {
    const sim = makeSim(scenario({ fleet: { amr: 0, humanoid: 0, forklift: 0, driver: 0 }, orders: { mode: 'saturate' } }), { pibt: true });
    sim.step(400);
    // a walking picker at a cell boundary
    let p = sim.people.find((x) => x.goal >= 0 && x.to < 0 && x.dwellUntil === 0 && !sim.atGoal(x));
    while (!p) {
      sim.step(1);
      p = sim.people.find((x) => x.goal >= 0 && x.to < 0 && x.dwellUntil === 0 && !sim.atGoal(x));
    }
    const start = p.cell;
    let movedAfter = -1;
    for (let k = 0; k < 200; k++) {
      // a robot "claims" every free neighbour of the person, every tick
      for (let d = 0; d < 4; d++) {
        const j = sim.world.nbr[p.cell * 4 + d];
        if (j >= 0) sim.claim[j] = sim.tick;
      }
      sim.step(1);
      if (p.cell !== start || p.to >= 0) {
        movedAfter = k;
        break;
      }
    }
    expect(movedAfter).toBeGreaterThanOrEqual(PEOPLE_PATIENCE_TICKS - 1);
    expect(movedAfter).toBeLessThan(PEOPLE_PATIENCE_TICKS + 10);
  });
});

describe('robots queued for a charger', () => {
  it('show as waiting, not idle', () => {
    const s = scenario({ fleet: { amr: 0, humanoid: 20, picker: 0, forklift: 0, driver: 2 }, run: { warmupMin: 30, measureMin: 120, batterySpread: false }, orders: { mode: 'saturate' } });
    const sim = makeSim(s, { pibt: true });
    let queued = 0;
    for (let k = 0; k < 4 * 7200; k += 10) {
      sim.step(10);
      for (const r of sim.robots)
        if (r.chargeQueuedAt >= 0 && r.job !== 4 && r.blockedAt !== sim.tick - 1) {
          queued++;
          expect(r.state).toBe(ST_WAIT);
        }
    }
    expect(queued).toBeGreaterThan(10);
  });
});

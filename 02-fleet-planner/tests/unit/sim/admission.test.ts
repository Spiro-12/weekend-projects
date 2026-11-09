// WMS release control: batch release, zone admission with holds, pack admission. And the over-fleet regression: with
// more cart robots than the pick zones and pack stations can take, throughput stays at the pack cap (no lock-up).
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/contracts/types.ts';
import { BATCH_MAX_WAIT_SEC, PACK_QUEUE_SLOTS, TOTES_PER_AMR, ZONE_MAX_AMRS } from '../../../src/sim/core/constants.ts';
import { secToTicks } from '../../../src/sim/motion.ts';
import { makeSim, run, scenario } from './helpers/data.ts';

const J_PICK = 1;
const PK_TO_STOP = 0;
const PK_AT_STOP = 1;
const PK_TO_PACK = 2;
const PK_HANDOFF = 3;
const PK_HOLD = 5;
const PK_ZONE_HOLD = 6;
const ST_WAIT = 3;
type TaskRef = { orders: number[]; amr: boolean; station: number; stops: { face: number }[]; stop: number };
const tasks = (sim: ReturnType<typeof makeSim>) => (sim as unknown as { taskById: Map<number, TaskRef> }).taskById;

describe('batch release', () => {
  it('a cart robot leaves with a full batch, or once the oldest order has waited BATCH_MAX_WAIT_SEC', () => {
    const sim = makeSim(scenario({ orders: { mode: 'demand', perHour: 600 } }), { pibt: true });
    const arrived = new Map<number, number>();
    let full = 0;
    let partial = 0;
    for (let k = 0; k < 7200; k += 60) {
      sim.step(60);
      for (const e of sim.drainEvents()) {
        if (e.t === 'orderArrived') arrived.set(e.order, e.tick);
        if (e.t === 'taskAssigned' && e.kind === 'pick') {
          const t = tasks(sim).get(e.task);
          if (!t) continue;
          if (t.orders.length === TOTES_PER_AMR) full++;
          else {
            partial++;
            expect(e.tick - arrived.get(Math.min(...t.orders))!).toBeGreaterThanOrEqual(secToTicks(BATCH_MAX_WAIT_SEC));
          }
        }
      }
    }
    expect(full).toBeGreaterThan(50);
    expect(partial).toBeLessThan(full / 10);
  });
});

describe('zone admission with holds', () => {
  it('robots past the zone limit hold (state wait) and zone loads stay within the limit', () => {
    const sim = makeSim(scenario({ fleet: { amr: 56 }, orders: { mode: 'saturate' } }), { pibt: true });
    let held = 0;
    let over = 0;
    for (let k = 0; k < 2 * 7200; k += 20) {
      sim.step(20);
      const zs = sim.debug().zones!;
      const load = new Map<number, number>();
      for (const r of sim.robots) {
        if (r.typeId !== 'amr' || r.job !== J_PICK) continue;
        if (r.stage === PK_ZONE_HOLD) {
          held++;
          if (r.to < 0 && r.blockedAt !== sim.tick - 1) expect(r.state).toBe(ST_WAIT);
        }
        if (r.stage === PK_TO_STOP || r.stage === PK_AT_STOP) {
          const t = tasks(sim).get(r.taskId)!;
          const z = zs.faceZone[t.stops[t.stop].face];
          load.set(z, (load.get(z) ?? 0) + 1);
        }
      }
      for (const [z, n] of load) if (z >= 0 && n > ZONE_MAX_AMRS * zs.members[z].length + 1) over++;
    }
    expect(held).toBeGreaterThan(0);
    expect(over).toBe(0); // (+1: a re-task may rotate a robot onto a full zone's stop)
  });
});

describe('pack admission', () => {
  it('with one pack station, at most PACK_QUEUE_SLOTS carriers head to it or hand off; the rest hold first in, first out', () => {
    const sim = makeSim(scenario({ pack: { stations: 1, secPerOrder: 30 }, orders: { mode: 'saturate' } }), { pibt: true });
    let held = 0;
    const releases: { tick: number; key: number }[] = [];
    const holdSince = new Map<number, number>();
    for (let k = 0; k < 7200; k++) {
      sim.step(1);
      let atPack = 0;
      for (const a of sim.agents) {
        if (a.job !== J_PICK) {
          holdSince.delete(a.id);
          continue;
        }
        if (a.stage === PK_TO_PACK || a.stage === PK_HANDOFF) {
          atPack++;
          if (holdSince.has(a.id)) {
            releases.push({ tick: k, key: holdSince.get(a.id)! });
            holdSince.delete(a.id);
          }
        }
        if (a.stage === PK_HOLD) {
          held++;
          if (!holdSince.has(a.id)) holdSince.set(a.id, a.waitSince * 1000 + a.id);
        }
      }
      expect(atPack).toBeLessThanOrEqual(PACK_QUEUE_SLOTS);
    }
    expect(held).toBeGreaterThan(100);
    expect(releases.length).toBeGreaterThan(5);
    // released in the order they started holding (hold tick, then id): everything released in a later tick held
    // after everything released earlier
    for (let i = 1; i < releases.length; i++) {
      const before = releases.filter((r) => r.tick < releases[i].tick);
      if (before.length) expect(releases[i].key).toBeGreaterThan(Math.max(...before.map((r) => r.key)));
    }
  });
});

describe('over-fleet regression (70 cart robots, 14 pickers, saturate, seed 42)', () => {
  it('every 15-minute bucket ships ≥ 60% of the pack cap, with ≤ 5 manual resets (no lock-up)', () => {
    const sim = makeSim(scenario({ seed: 42, fleet: { amr: 70 }, orders: { mode: 'saturate' } }), { pibt: true });
    run(sim, 3600);
    const cap = (6 * 3600) / 30 / 4; // 6 stations × 120 orders/h, per 15 min
    let resets = 0;
    const buckets: number[] = [];
    for (let k = 0; k < 8; k++) {
      const ev: SimEvent[] = run(sim, 1800);
      buckets.push(ev.filter((e) => e.t === 'orderShipped').length);
      resets += ev.filter((e) => e.t === 'manualReset').length;
    }
    console.log(`[track A] 70 cart robots, seed 42: shipped per 15 min ${buckets.join(' ')}, manual resets ${resets}`);
    // measured: 117–177 per 15 min (65–98% of the cap); zone caps and holds keep extra robots back, so at 5 robots per
    // picker capacity eases below the pack cap instead of locking up
    for (const b of buckets) expect(b).toBeGreaterThanOrEqual(0.6 * cap);
    expect(resets).toBeLessThanOrEqual(5);
  });
});

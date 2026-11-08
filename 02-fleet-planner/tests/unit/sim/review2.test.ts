// Second review round: fleet shrink while robots are held, wait-age credit, no re-pairing after a given-up meeting,
// zone holds off the main aisles, re-tasks under admission, held carts give way, exact zone caps, assisted pick time,
// humanoid zone sizing, stock returned on a dropped pick.
import { describe, expect, it } from 'vitest';
import { ASSISTED_PICK_PCT, MEET_GIVEUP_TICKS, PACK_QUEUE_SLOTS, ZONE_FACES_PER_AMR, ZONE_MAX_AMRS } from '../../../src/sim/core/constants.ts';
import { secToTicks } from '../../../src/sim/motion.ts';
import { faceWeights } from '../../../src/sim/core/zones.ts';
import { makeSim, run, scenario } from './helpers/data.ts';
import { ScriptedController } from './helpers/test-controller.ts';
import { CentralController } from '../../../src/sim/traffic/central/index.ts';

const J_PICK = 1;
const J_SERVE = 2;
const PK_TO_STOP = 0;
const PK_AT_STOP = 1;
const PK_TO_PACK = 2;
const PK_HANDOFF = 3;
const PK_HOLD = 5;
const PK_ZONE_HOLD = 6;
const SV_TO_AMR = 0;
const SV_PICKING = 2;
const SV_WAIT_AMR = 3;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('fleet shrink from an over-fleet while robots are held', () => {
  it('70 → 20 cart robots at 2 h: the fleet reaches 20, shipping recovers, resets stay small', () => {
    const sim = makeSim(scenario({ fleet: { amr: 70 }, orders: { mode: 'saturate' } }), { pibt: true });
    run(sim, 2 * 7200 - 600);
    const held = sim.robots.filter((r) => r.job === J_PICK && (r.stage === PK_HOLD || r.stage === PK_ZONE_HOLD)).length;
    run(sim, 600);
    sim.command({ t: 'setFleet', type: 'amr', count: 20 });
    let resets = 0;
    const buckets: number[] = [];
    for (let k = 0; k < 8; k++) {
      const ev = run(sim, 1800);
      buckets.push(ev.filter((e) => e.t === 'orderShipped').length);
      resets += ev.filter((e) => e.t === 'manualReset').length;
    }
    expect(held).toBeGreaterThan(0); // robots were held when the shrink came
    expect(sim.stats().fleet.amr).toBe(20);
    expect(Math.min(...buckets.slice(2))).toBeGreaterThan(100);
    expect(resets).toBeLessThanOrEqual(10);
  });
});

describe('picker choice', () => {
  it('the wait-age credit never makes a picker drop the robot it is walking to', () => {
    const sim: Any = makeSim(scenario({ fleet: { amr: 42 }, orders: { mode: 'saturate' } }), { pibt: true });
    const orig = sim.matchZones.bind(sim);
    let credited = 0;
    let dropped = 0;
    sim.matchZones = (t: number) => {
      const watch: [Any, number][] = [];
      for (const w of sim.people)
        if (w.job === J_SERVE && (w.stage === SV_TO_AMR || w.stage === SV_WAIT_AMR) && w.to < 0 && w.partner >= 0) {
          const r = sim.byId[w.partner];
          const k0 = sim.meetKey(w, r);
          if (k0 >= 0 && k0 - sim.waitCredit(r, t) < 0) watch.push([w, r.id]);
        }
      orig(t);
      for (const [w, rid] of watch) {
        credited++;
        if (w.partner !== rid) dropped++;
      }
    };
    sim.step(2 * 7200);
    expect(credited).toBeGreaterThan(20);
    expect(dropped).toBe(0);
  });

  it('a picker that gives up a meeting stands down and is not paired with the same blocked robot again', () => {
    const sim: Any = makeSim(scenario({ fleet: { amr: 56 }, orders: { mode: 'saturate' } }), { pibt: true });
    let repaired = 0;
    for (let k = 0; k < 3 * 7200; k++) {
      const pairs = new Map<number, number>();
      for (const p of sim.people) if (p.job === J_SERVE && p.stage === SV_WAIT_AMR) pairs.set(p.id, p.partner);
      const before = sim.counters.meetsGivenUp;
      sim.step(1);
      if (sim.counters.meetsGivenUp === before) continue;
      for (const [pid, rid] of pairs) {
        const p = sim.byId[pid];
        const r = sim.byId[rid];
        // a robot that reached its stop in the same tick may rightly get its picker back
        if (p && r && p.job === J_SERVE && p.partner === rid && r.stage === PK_TO_STOP && r.blockedTicks >= MEET_GIVEUP_TICKS) repaired++;
      }
    }
    expect(sim.counters.meetsGivenUp).toBeGreaterThan(0);
    expect(repaired).toBe(0);
  });
});

describe('zone admission', () => {
  it('zone caps are exactly min(ZONE_MAX_AMRS per worker, faces ÷ ZONE_FACES_PER_AMR), at least 2', () => {
    const sim: Any = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    sim.step(10);
    const zs = sim.zones;
    const faces = zs.members.map((_: number[], z: number) => Array.from(zs.faceZone as Int32Array).filter((x) => x === z).length);
    expect(sim.zoneCap).toEqual(zs.members.map((m: number[], z: number) => Math.max(2, Math.min(ZONE_MAX_AMRS * m.length, Math.floor(faces[z] / ZONE_FACES_PER_AMR)))));
    expect(sim.zoneCap.some((c: number, z: number) => c < ZONE_MAX_AMRS * zs.members[z].length)).toBe(true); // small hot zones are capped by size
  });

  it('zone loads never exceed the zone cap, and held robots wait on pick-aisle cells', () => {
    const sim: Any = makeSim(scenario({ fleet: { amr: 56 }, orders: { mode: 'saturate' } }), { pibt: true });
    let over = 0;
    let atRest = 0;
    let onFace = 0;
    for (let k = 0; k < 2 * 7200; k += 10) {
      sim.step(10);
      const loads = new Map<number, number>();
      for (const r of sim.robots) {
        if (r.typeId !== 'amr' || r.job !== J_PICK) continue;
        if ((r.stage === PK_ZONE_HOLD || r.stage === PK_HOLD) && r.goal < 0 && r.to < 0) {
          atRest++;
          if (sim.world.faceAt[r.cell] >= 0) onFace++;
        }
        if (r.stage === PK_TO_STOP || r.stage === PK_AT_STOP) {
          const t = sim.taskById.get(r.taskId);
          const z = sim.zones.faceZone[t.stops[t.stop].face];
          loads.set(z, (loads.get(z) ?? 0) + 1);
        }
      }
      for (const [z, n] of loads) if (z >= 0 && n > sim.zoneCap[z]) over++;
    }
    expect(over).toBe(0);
    expect(atRest).toBeGreaterThan(50);
    // held robots wait on pick-aisle cells; the rest (about 18%) were pushed aside by the planner and wait there
    expect(onFace / atRest).toBeGreaterThan(0.8);
  });
});

describe('re-tasks go through admission', () => {
  it('with 2 pack stations, re-tasked carriers never put more than PACK_QUEUE_SLOTS at a station, nor a zone over its cap', () => {
    let tick = 0;
    const central = new CentralController();
    const sim: Any = makeSim(scenario({ fleet: { amr: 42 }, pack: { stations: 2, secPerOrder: 30 }, orders: { mode: 'saturate' } }), {
      traffic: () =>
        new ScriptedController({
          // every 50 ticks, re-task every robot on its way to pack or to a stop
          retasks: (input) => {
            tick = input.tick;
            if (input.tick % 50 !== 0) return [];
            return sim.robots.filter((r: Any) => r.job === J_PICK && (r.stage === PK_TO_PACK || r.stage === PK_TO_STOP) && input.ready[r.id] === input.tick).map((r: Any) => r.id);
          },
        }),
    });
    // drive the real planner for movement, the scripted one only for re-tasks
    sim.traffic.plan = (input: Any, out: Any) => central.plan(input, out);
    let over = 0;
    let retasks = 0;
    for (let k = 0; k < 7200; k++) {
      sim.step(1);
      retasks += sim.drainEvents().filter((e: Any) => e.t === 'retask').length;
      const atPack = [0, 0];
      const loads = new Map<number, number>();
      for (const a of sim.agents) {
        if (a.job !== J_PICK) continue;
        const t = sim.taskById.get(a.taskId);
        if (a.stage === PK_TO_PACK || a.stage === PK_HANDOFF) atPack[t.station]++;
        if (a.typeId === 'amr' && (a.stage === PK_TO_STOP || a.stage === PK_AT_STOP)) {
          const z = sim.zones.faceZone[t.stops[t.stop].face];
          loads.set(z, (loads.get(z) ?? 0) + 1);
        }
      }
      if (atPack.some((n) => n > PACK_QUEUE_SLOTS)) over++;
      for (const [z, n] of loads) if (z >= 0 && n > sim.zoneCap[z]) over++;
    }
    expect(tick).toBeGreaterThan(0);
    expect(retasks).toBeGreaterThan(20);
    expect(over).toBe(0);
  });
});

describe('a held manual cart gives way', () => {
  it('a picker holding a full cart for a pack slot steps off a cell a robot claims', () => {
    const sim: Any = makeSim(scenario({ fleet: { amr: 0, humanoid: 0, forklift: 0 }, pack: { stations: 1, secPerOrder: 30 }, orders: { mode: 'saturate' } }), { pibt: true });
    let p: Any = null;
    for (let k = 0; k < 7200 && !p; k++) {
      sim.step(1);
      p = sim.people.find((x: Any) => x.job === J_PICK && x.stage === PK_HOLD && x.goal < 0 && x.to < 0);
    }
    expect(p).toBeTruthy();
    const cell = p.cell;
    let moved = false;
    for (let k = 0; k < 10 && !moved; k++) {
      sim.claim[p.cell] = sim.tick;
      sim.step(1);
      moved = p.cell !== cell || p.to >= 0;
    }
    expect(moved).toBe(true);
    expect(p.stage).toBe(PK_HOLD); // still holding, just one cell over
  });
});

describe('assisted picks and humanoid zones', () => {
  it('a person picking into a cart robot takes ASSISTED_PICK_PCT of pickSecPerLine per unit; a humanoid its own rate', () => {
    const sim: Any = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    const person: number[] = [];
    const humanoid: number[] = [];
    for (let k = 0; k < 3600; k++) {
      sim.step(1);
      for (const w of sim.agents)
        if (w.job === J_SERVE && w.stage === SV_PICKING && w.dwellStart === sim.tick - 1) {
          const perUnit = (w.dwellUntil - w.dwellStart) / w.dwellUnits;
          (w.typeId === 'picker' ? person : humanoid).push(perUnit);
        }
    }
    const pickSec = sim.specs[3].pickSecPerLine.value;
    expect(person.length).toBeGreaterThan(100);
    expect(new Set(person)).toEqual(new Set([secToTicks((pickSec * ASSISTED_PICK_PCT) / 100)]));
    if (humanoid.length) expect(new Set(humanoid)).toEqual(new Set([secToTicks(sim.specs[2].pickSecPerLine.value)]));
  });

  it('a humanoid zone is sized by its pick rate times its share of time not charging', () => {
    const sim: Any = makeSim(scenario(), { pibt: true });
    sim.step(10);
    const zs = sim.zones;
    const hz = zs.members.findIndex((m: number[]) => m.every((id) => sim.byId[id].typeId === 'humanoid'));
    expect(hz).toBeGreaterThanOrEqual(0);
    const w = faceWeights(sim.world.faces.length, sim.orders.aFaces, sim.scenario.orders.sku.aPicksPct);
    const total = w.reduce((a: number, b: number) => a + b, 0);
    const share = Array.from(zs.faceZone as Int32Array).reduce((a: number, z: number, f: number) => a + (z === hz ? w[f] : 0), 0) / total;
    const weight = (a: Any) => Math.floor((1_000_000 / a.assistTicks) * (a.batteryMax > 0 ? a.batteryMax / (a.batteryMax + a.chargeC) : 1));
    const workers = zs.workers.map((id: number) => sim.byId[id]);
    const expected = zs.members[hz].reduce((a: number, id: number) => a + weight(sim.byId[id]), 0) / workers.reduce((a: number, x: Any) => a + weight(x), 0);
    expect(Math.abs(share - expected)).toBeLessThan(0.01);
  });
});

describe('stock on a dropped pick', () => {
  it('a picker that breaks mid-pick puts the units it took back on the face', () => {
    const sim: Any = makeSim(scenario({ orders: { mode: 'saturate' } }), { pibt: true });
    let w: Any = null;
    for (let k = 0; k < 7200 && !w; k++) {
      sim.step(1);
      w = sim.people.find((x: Any) => x.typeId === 'picker' && x.job === J_SERVE && x.stage === SV_PICKING && x.dwellUnits > 0 && x.dwellUntil - sim.tick > 4);
    }
    expect(w).toBeTruthy();
    const amr = sim.byId[w.partner];
    const face = sim.taskById.get(amr.taskId).stops[sim.taskById.get(amr.taskId).stop].face;
    const before = sim.stock[face];
    const units = w.dwellUnits;
    sim.command({ t: 'inject', event: { type: 'breakdown', atMin: 0, agent: `picker:${w.spawnIndex}`, forMin: 2 } });
    sim.step(1);
    expect(w.brokenUntil).toBeGreaterThan(0);
    expect(w.dwellUnits).toBe(0);
    expect(sim.stock[face]).toBeGreaterThanOrEqual(Math.min(80, before + units) - 1); // another picker may take one the same tick
  });
});

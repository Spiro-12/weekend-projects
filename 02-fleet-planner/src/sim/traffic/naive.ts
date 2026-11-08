// Naive traffic (lead stub, PROTOCOL §5): each ready robot steps along its distance gradient into a free cell, in
// priority order. No pushing, no detours, no recovery. Lets Track A run before Track B's PIBT lands. Deterministic.
import type { TrafficMode } from '../../contracts/types.ts';
import { headingOf } from '../motion.ts';
import type { Recovery, TrafficController, TrafficInput, TrafficPlan } from './types.ts';

export class NaiveController implements TrafficController {
  constructor(readonly mode: TrafficMode = 'central') {}

  recover(): Recovery {
    return { resets: [], retasks: [] };
  }

  plan(input: TrafficInput, out: TrafficPlan): void {
    const taken = new Set<number>();
    for (const id of input.order) {
      const a = input.agents[id];
      if (!a || input.ready[id] !== input.tick || a.goal < 0) continue;
      const next = input.dist.next(a.passClass, a.cell, a.goal);
      out.want[id] = next;
      if (next < 0 || input.occ[next] >= 0 || taken.has(next)) continue;
      taken.add(next);
      out.moveTo[id] = next;
      out.dir[id] = headingOf(a.cell, next, input.world.width);
    }
  }

  stateWords(): number[] {
    return [];
  }
}

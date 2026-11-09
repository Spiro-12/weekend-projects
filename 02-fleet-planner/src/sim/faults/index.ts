// Fault schedule (the brief §9, PROTOCOL §4 events). Phase 1 supports one fault: `breakdown {atMin, agent, forMin}`,
// where agent is '<type>:<n>' = the n-th agent of that type in spawn order (0-based). The other event types
// (personInAisle, chargers, orderSurge) are Phase 2: they are accepted and ignored, without logging anything.
// Deterministic: due faults come out in (tick, insertion) order.
import { AGENT_TYPES, TICKS_PER_MIN, type AgentTypeId, type ScenarioEvent } from '../../contracts/types.ts';

export interface Breakdown {
  /** Tick it fires. */
  tick: number;
  type: AgentTypeId;
  /** Spawn index within the type. */
  n: number;
  forTicks: number;
  seq: number;
}

/** '<type>:<n>' → {type, n}, or null if it is not a valid reference. */
export function parseAgentRef(ref: string): { type: AgentTypeId; n: number } | null {
  const m = /^([a-z]+):(\d+)$/.exec(ref);
  if (!m) return null;
  const type = m[1] as AgentTypeId;
  if (!AGENT_TYPES.includes(type)) return null;
  return { type, n: Number(m[2]) };
}

export class FaultSchedule {
  private list: Breakdown[] = [];
  private seq = 0;

  constructor(events: readonly ScenarioEvent[] = []) {
    for (const e of events) this.add(e, 0);
  }

  /**
   * Schedule an event. A breakdown fires at max(now, atMin) (an injected event whose time has passed fires at once).
   * Returns false for Phase 2 event types and bad references (ignored).
   */
  add(e: ScenarioEvent, now: number): boolean {
    if (e.type !== 'breakdown') return false;
    const ref = parseAgentRef(e.agent);
    if (!ref) return false;
    const at = Math.max(now, Math.round(e.atMin * TICKS_PER_MIN));
    const forTicks = Math.max(1, Math.round(e.forMin * TICKS_PER_MIN));
    const b: Breakdown = { tick: at, type: ref.type, n: ref.n, forTicks, seq: this.seq++ };
    let i = this.list.length;
    while (i > 0 && (this.list[i - 1].tick > b.tick || (this.list[i - 1].tick === b.tick && this.list[i - 1].seq > b.seq))) i--;
    this.list.splice(i, 0, b);
    return true;
  }

  /** Remove and return every fault due at or before `tick`. */
  due(tick: number): Breakdown[] {
    let k = 0;
    while (k < this.list.length && this.list[k].tick <= tick) k++;
    return k === 0 ? NONE : this.list.splice(0, k);
  }

  get pending(): number {
    return this.list.length;
  }

  stateWords(out: number[]): void {
    out.push(this.seq, this.list.length);
    for (const b of this.list) out.push(b.tick, AGENT_TYPES.indexOf(b.type), b.n, b.forTicks, b.seq);
  }
}

const NONE: Breakdown[] = [];

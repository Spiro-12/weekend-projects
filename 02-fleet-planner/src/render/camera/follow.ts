// Follow-camera behaviour built on the lead's rig (render/core/camera.ts): the agent layer returns a chase
// `distance` / `height` per agent type from followTarget(), and eases them out to a wider shot when the followed
// agent stops for a long dwell (so the camera doesn't stare at a rack face), then back in when it moves again.
import type { AgentTypeId } from '../../contracts/types.ts';

/** Chase framing per type (Gate 0: 3 to 3.5 m behind, 1.8 to 2.2 m up for a person-sized subject). */
export const CHASE: Record<AgentTypeId, { distance: number; height: number }> = {
  amr: { distance: 3.2, height: 2.0 },
  humanoid: { distance: 3.3, height: 2.1 },
  picker: { distance: 3.3, height: 2.1 },
  forklift: { distance: 5.2, height: 3.0 },
  driver: { distance: 6.0, height: 3.2 },
};

/** The wider shot during a long dwell. */
const PULLED = { distance: 7.5, height: 5.2 };
/** A stop longer than this (sim ticks, 0.5 s each) counts as a dwell. */
export const DWELL_TICKS = 10;

export class FollowFraming {
  private id: number | null = null;
  private k = 0;

  /**
   * Framing for the followed agent. `stillTicks` = sim ticks it has been standing; `dtMs` real time since the last
   * call. Eases in about 1.5 s, out about 0.8 s.
   */
  framing(id: number, type: AgentTypeId, stillTicks: number, dtMs: number): { distance: number; height: number; pulled: boolean } {
    if (id !== this.id) {
      this.id = id;
      this.k = 0;
    }
    const want = stillTicks >= DWELL_TICKS ? 1 : 0;
    const rate = want > this.k ? dtMs / 1500 : dtMs / 800;
    this.k = want > this.k ? Math.min(want, this.k + rate) : Math.max(want, this.k - rate);
    const e = this.k * this.k * (3 - 2 * this.k);
    const base = CHASE[type] ?? CHASE.amr;
    return {
      distance: base.distance + (Math.max(PULLED.distance, base.distance * 1.4) - base.distance) * e,
      height: base.height + (Math.max(PULLED.height, base.height * 1.5) - base.height) * e,
      pulled: this.k > 0.5,
    };
  }
}

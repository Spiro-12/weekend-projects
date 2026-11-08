// Follow-camera behaviour built on the lead's rig (render/core/camera.ts): the agent layer returns a chase
// `distance` / `height` per agent type from followTarget(), and eases them out to a wider shot when the followed
// agent stops for a long dwell (so the camera doesn't stare at a rack face), then back in when it moves again.
import type { AgentTypeId } from '../../contracts/types.ts';

/**
 * Chase framing per type. Gate 0 asked for 3 to 3.5 m behind AND a subject filling 25 to 30% of the frame height;
 * with the rig's 38° lens a 1.7 m subject at 3.2 m fills about 75%, so these sit in between (about 40 to 50% for
 * people-sized agents, in the lower half) without the racks swallowing the frame.
 */
export const CHASE: Record<AgentTypeId, { distance: number; height: number }> = {
  amr: { distance: 4.4, height: 2.4 },
  humanoid: { distance: 4.4, height: 2.4 },
  picker: { distance: 4.4, height: 2.4 },
  forklift: { distance: 6.2, height: 3.3 },
  driver: { distance: 7.0, height: 3.5 },
};

/** The wider shot during a long dwell. */
const PULLED = { distance: 7.5, height: 5.2 };
/** A stop longer than this many real seconds counts as a dwell (real time, so 60x speed doesn't pull out at every
 *  short stop). */
export const DWELL_SEC = 5;

export interface Framing {
  id: number;
  distance: number;
  height: number;
  pulled: boolean;
}

export class FollowFraming {
  private id: number | null = null;
  private k = 0;

  /**
   * Framing for the followed agent, written into `out`. `stillSec` = real seconds it has been standing; `dtMs` real
   * time since the last call. Eases out over about 1.5 s, back in over about 0.8 s.
   */
  framing(id: number, type: AgentTypeId, stillSec: number, dtMs: number, out: Framing): Framing {
    if (id !== this.id) {
      this.id = id;
      this.k = 0;
    }
    const want = stillSec >= DWELL_SEC ? 1 : 0;
    const rate = want > this.k ? dtMs / 1500 : dtMs / 800;
    this.k = want > this.k ? Math.min(want, this.k + rate) : Math.max(want, this.k - rate);
    const e = this.k * this.k * (3 - 2 * this.k);
    const base = CHASE[type] ?? CHASE.amr;
    out.id = id;
    out.distance = base.distance + (Math.max(PULLED.distance, base.distance * 1.4) - base.distance) * e;
    out.height = base.height + (Math.max(PULLED.height, base.height * 1.5) - base.height) * e;
    out.pulled = this.k > 0.5;
    return out;
  }
}

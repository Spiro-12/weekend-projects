// Live-view subscription for the panels (Track F): the latest snapshot, re-rendered at most `hz` times a second.
// `onEach` sees every update (with its events) so panels can keep small histories without re-rendering each tick.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SimEvent, Snapshot } from '../../../contracts/types.ts';
import type { Host } from '../../../host/index.ts';

export function useLiveSnapshot(host: Host, hz = 4, onEach?: (s: Snapshot, events: SimEvent[]) => void): Snapshot {
  const [snap, setSnap] = useState(host.live.snapshot);
  const each = useRef(onEach);
  each.current = onEach;
  useEffect(() => {
    const gap = 1000 / hz;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = host.live.snapshot;
    const flush = () => {
      timer = undefined;
      last = performance.now();
      setSnap(latest);
    };
    const off = host.live.onUpdate((s, events) => {
      latest = s;
      each.current?.(s, events);
      if (timer) return;
      const wait = last + gap - performance.now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [host, hz]);
  return snap;
}

/** Active jams in the live view, from jamStart/jamEnd events (jams aren't in the snapshot). Cleared on a reset. */
export class JamWatch {
  private active = new Set<number>();
  private lastTick = -1;
  update(s: Snapshot, events: SimEvent[]): void {
    if (s.tick < this.lastTick) this.active.clear();
    this.lastTick = s.tick;
    for (const e of events) {
      if (e.t === 'jamStart') this.active.add(e.jam);
      else if (e.t === 'jamEnd') this.active.delete(e.jam);
    }
  }
  get count(): number {
    return this.active.size;
  }
}

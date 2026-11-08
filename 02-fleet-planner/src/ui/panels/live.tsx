// Live strip (Track F, slot `bottom`): counters from the live 3D view (shipped, open orders, jams and deadlocks right
// now), so you can see the view and the tiles tell the same story. Labeled "live view": the tiles come from the runner.
import { useRef } from 'preact/hooks';
import type { Host } from '../../host/index.ts';
import type { ExplainContent } from '../explain/content.ts';
import { num } from '../explain/format.ts';
import { Explain } from '../explain/popover.tsx';
import { definePanel } from '../panel.ts';
import '../panels.css';
import { JamWatch, useLiveSnapshot } from './live/use-live.ts';

function LiveStrip({ host }: { host: Host }) {
  const jamsRef = useRef<JamWatch | null>(null);
  const jams = (jamsRef.current ??= new JamWatch());
  const snap = useLiveSnapshot(host, 4, (s, events) => jams.update(s, events));
  const content = (): ExplainContent => ({
    title: 'Live view',
    text: [
      'The 3D view plays the same plan as it happens. These counters count from when the view started.',
      'The tiles at the top come from a full simulated run of the same plan and orders, so they don’t jump around while you watch.',
    ],
    note: host.demoData ? 'Demo data: the live view runs a placeholder model until the real simulator is plugged in.' : undefined,
  });
  const items = [
    { id: 'live-shipped', label: 'Shipped', v: snap.shippedOrders },
    { id: 'live-open', label: 'Open orders', v: snap.openOrders },
    { id: 'live-jams', label: 'Jams now', v: jams.count, warn: jams.count > 0 },
    { id: 'live-deadlocks', label: 'Deadlocks now', v: snap.deadlocks.length, bad: snap.deadlocks.length > 0 },
  ];
  return (
    <div class="card livestrip" data-testid="live-strip">
      <Explain id="live-info" class="live-tag" content={content}>
        <i class="dot" aria-hidden="true" />
        live view
      </Explain>
      {items.map((it) => (
        <div class={`live-item${it.warn ? ' warn' : ''}${it.bad ? ' bad' : ''}`} key={it.id}>
          <span class="live-v" data-testid={it.id}>
            {num(it.v)}
          </span>
          <span class="live-l">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

export default definePanel({ id: 'live', slot: 'bottom', order: 10, title: 'Live counters', Component: LiveStrip });

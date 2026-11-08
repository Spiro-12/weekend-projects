// App shell (lead-owned): mounts every panel from src/ui/panels/ into its slot. Phones get a bottom sheet with tabs.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { Host } from '../host/index.ts';
import type { Panel, Slot } from './panel.ts';
import { PerfOverlay } from './perf-overlay.tsx';
import type { Params } from './params.ts';

const modules = import.meta.glob<{ default: Panel }>('./panels/*.tsx', { eager: true });
export const PANELS: Panel[] = Object.values(modules)
  .map((m) => m.default)
  .filter(Boolean)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

const SHEET_SLOTS: Slot[] = ['left', 'right', 'bottom'];

function Shell({ host, params }: { host: Host; params: Params }) {
  const [open, setOpen] = useState<Slot | null>(null);
  const view = params.view;
  const inSlot = (slot: Slot) => PANELS.filter((p) => p.slot === slot && (!p.when || p.when(view)));
  const box = (slot: Slot) => (
    <div class={`slot-${slot}${open === slot ? ' open' : ''}`} data-slot={slot}>
      {inSlot(slot).map((p) => (
        <section key={p.id} data-panel={p.id} aria-label={p.title}>
          <p.Component host={host} />
        </section>
      ))}
    </div>
  );
  const tabs = SHEET_SLOTS.filter((s) => inSlot(s).length > 0);
  return (
    <>
      {box('kpi')}
      {box('left')}
      {box('right')}
      {box('bottom')}
      {box('overlay')}
      {tabs.length > 0 && (
        <div class="sheet-tabs">
          {tabs.map((s) => (
            <button key={s} class={open === s ? 'primary' : ''} onClick={() => setOpen(open === s ? null : s)}>
              {inSlot(s)[0].title}
            </button>
          ))}
        </div>
      )}
      {params.perf && <PerfOverlay />}
    </>
  );
}

export function mountShell(el: HTMLElement, host: Host, params: Params): void {
  render(<Shell host={host} params={params} />, el);
}

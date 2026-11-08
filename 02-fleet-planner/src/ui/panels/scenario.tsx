// Scenario picker (Track F, top of slot `left`): small, mid-size or large building. Switching restarts the live view
// in place and recalculates the numbers (host.setScenario). Its title names the phone tab for the left slot.
import type { Host } from '../../host/index.ts';
import { num } from '../explain/format.ts';
import { definePanel } from '../panel.ts';
import '../panels.css';

const ORDER = ['small', 'default', 'large'];
const SHORT: Record<string, string> = { small: 'Small', default: 'Mid-size', large: 'Large' };

function ScenarioPicker({ host }: { host: Host }) {
  const s = host.settings.value;
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  const ids = Object.keys(host.data.scenarios).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const layout = host.data.layouts[s.layout];
  const w = layout ? (layout.grid[0].length * layout.cellMm) / 1000 : 0;
  const h = layout ? (layout.grid.length * layout.cellMm) / 1000 : 0;
  return (
    <div class="card scenario">
      <div class="panel-head">
        <h2>Building</h2>
        <span class="hint" data-testid="scenario-size">
          {layout ? `${num(w)} × ${num(h)} m` : ''}
        </span>
      </div>
      <div class="seg seg-wide" role="group" aria-label="Building size">
        {ids.map((id) => {
          const sc = host.data.scenarios[id];
          const l = host.data.layouts[sc.layout];
          return (
            <button type="button" key={id} aria-pressed={s.id === id} data-testid={`scenario-${id}`} onClick={() => s.id !== id && host.setScenario(id)} title={sc.name}>
              <b>{SHORT[id] ?? sc.name}</b>
              <small>{l ? `${l.aisles} aisles` : ''}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default definePanel({ id: 'scenario', slot: 'left', order: 0, title: 'Setup', Component: ScenarioPicker });

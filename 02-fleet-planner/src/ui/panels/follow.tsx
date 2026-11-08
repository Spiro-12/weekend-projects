// Follow card (Track F, slot `overlay`): the robot or person you clicked. Bottom-right on desktop, a compact card
// above the tabs on phones. Updates from the live view at most 4 times a second. Close = stop following.
import { useRef } from 'preact/hooks';
import { TICK_MS } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import { duration, num, plural } from '../explain/format.ts';
import { definePanel } from '../panel.ts';
import '../panels.css';
import { FollowHistory, STATE_WORDS, stopWords, TASK_WORDS } from './follow/history.ts';
import { useLiveSnapshot } from './live/use-live.ts';

function FollowCard({ host }: { host: Host }) {
  const sel = host.selected.value;
  if (!sel) return null;
  return <FollowInner key={sel.agentId} host={host} agentId={sel.agentId} />;
}

function FollowInner({ host, agentId }: { host: Host; agentId: number }) {
  const hist = useRef<FollowHistory | null>(null);
  if (!hist.current) {
    hist.current = new FollowHistory(agentId);
    hist.current.update(host.live.snapshot);
  }
  const h = hist.current;
  const snap = useLiveSnapshot(host, 4, (s) => h.update(s));
  const a = snap.agents.find((x) => x.id === agentId);
  const close = () => host.select(0, null);
  if (!a) {
    return (
      <div class="card follow-card" data-testid="follow-card">
        <div class="fc-head">
          <div class="fc-name">Not on the floor</div>
          <button type="button" class="fc-x" aria-label="Stop following" data-testid="follow-close" onClick={close}>
            ×
          </button>
        </div>
        <p class="fc-gone">This one left the floor (the fleet was made smaller, or the building changed).</p>
      </div>
    );
  }
  const spec = host.data.agents.agents.find((s) => s.id === a.type);
  const robot = spec?.kind === 'robot';
  const task = a.taskId >= 0 ? snap.tasks.find((t) => t.id === a.taskId) : undefined;
  const stop = stopWords(task?.stage);
  const moving = a.to >= 0 && a.to !== a.cell;
  const mps = spec?.speedMps.value ?? 0;
  const batt = Math.max(0, Math.min(100, a.batteryPct));
  const sec = (ticks: number) => (ticks * TICK_MS) / 1000;
  const typeName = spec?.label ?? a.type;
  return (
    <div class="card follow-card" data-testid="follow-card" aria-label={`Following ${a.name}`}>
      <div class="fc-head">
        <div>
          <div class="fc-name" data-testid="follow-name">
            {a.name}
          </div>
          <div class="fc-type">
            {typeName}
            {robot && a.vendor && a.vendor !== '-' ? ` · Vendor ${a.vendor}` : ''}
          </div>
        </div>
        <span class={`fc-state st-${a.state}`} data-testid="follow-state">
          {STATE_WORDS[a.state] ?? a.state}
        </span>
        <button type="button" class="fc-x" aria-label="Stop following" data-testid="follow-close" onClick={close}>
          ×
        </button>
      </div>
      <dl class="fc-grid">
        <div>
          <dt>Task</dt>
          <dd data-testid="follow-task">
            {task ? (
              <>
                {TASK_WORDS[task.kind] ?? task.kind}
                {task.lines > 0 ? ` · ${plural(task.lines, 'line')}` : ''}
                <span class="muted"> · {duration(sec(snap.tick - task.createdTick))}</span>
              </>
            ) : (
              <span class="muted">none</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Next stop</dt>
          <dd data-testid="follow-next">{stop ? stop.replace(/^a /, '').replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()) : <span class="muted">—</span>}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd data-testid="follow-speed">
            {moving ? (
              <>
                {num(mps, 1)} m/s <span class="muted">· {num(mps * 2.23694, 1)} mph</span>
              </>
            ) : (
              <span class="muted">stopped</span>
            )}
          </dd>
        </div>
        {robot && (
          <div>
            <dt>Battery</dt>
            <dd>
              <span class="fc-batt" data-testid="follow-battery">
                <i class={batt < 20 ? 'low' : batt < 50 ? 'mid' : ''} style={{ width: `${batt}%` }} />
              </span>
              <span class="fc-batt-n">{num(batt)}%</span>
            </dd>
          </div>
        )}
      </dl>
      {h.steps.length > 0 && (
        <ol class="fc-timeline" data-testid="follow-timeline" aria-label="Recent changes">
          {h.steps.map((st, i) => (
            <li key={`${st.tick}-${i}`} class={i === 0 ? 'now' : ''}>
              <span class="fc-t">{i === 0 ? 'now' : `${duration(sec(snap.tick - st.tick))} ago`}</span>
              <span>{st.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default definePanel({ id: 'follow', slot: 'overlay', order: 0, title: 'Following', Component: FollowCard });

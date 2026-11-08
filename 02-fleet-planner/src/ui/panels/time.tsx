// Time controls (Track F, slot `bottom`): pause/play, 1x / 10x / 60x and the warehouse clock of the live view.
// Its title names the phone tab for the bottom slot.
import { TICK_MS } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import { SPEEDS } from '../../host/live.ts';
import { clock } from '../explain/format.ts';
import { definePanel } from '../panel.ts';
import '../panels.css';
import { useLiveSnapshot } from './live/use-live.ts';

function TimeControls({ host }: { host: Host }) {
  const snap = useLiveSnapshot(host, 4);
  const paused = host.paused.value;
  const speed = host.speed.value;
  return (
    <div class="card timebar">
      <button type="button" class="play" data-testid="pause" aria-label={paused ? 'Play' : 'Pause'} aria-pressed={paused} onClick={() => host.setPaused(!paused)}>
        {paused ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        )}
      </button>
      <div class="seg" role="group" aria-label="Playback speed">
        {SPEEDS.map((x) => (
          <button type="button" key={x} aria-pressed={speed === x} data-testid={`speed-${x}`} onClick={() => host.setSpeed(x)}>
            {x}x
          </button>
        ))}
      </div>
      <div class="clock" title="Warehouse time since the live view started">
        <span>
          <span data-testid="sim-clock">{clock(snap.tick)}</span>
          <span class="clock-s">:{String(Math.floor((snap.tick * TICK_MS) / 1000) % 60).padStart(2, '0')}</span>
        </span>
        <small>{paused ? 'paused' : 'warehouse time'}</small>
      </div>
    </div>
  );
}

export default definePanel({ id: 'time', slot: 'bottom', order: 0, title: 'Live', Component: TimeControls });

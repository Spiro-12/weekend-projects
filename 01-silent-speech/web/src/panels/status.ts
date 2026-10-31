// Status panel: is the Mac bridge connected, are the AirPods streaming, and how healthy is the signal.
import type { App, Panel } from '../core/app';
import type { StatusMsg } from '../core/contracts';

type Tone = 'good' | 'warn' | 'bad' | 'idle';

const CSS = `
.ss-status { display: flex; flex-direction: column; gap: 14px; }
.ss-status .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.ss-status [data-tone=good] > .dot, .ss-status .dot[data-tone=good] { background: var(--good); box-shadow: 0 0 10px #3ddc9755; }
.ss-status [data-tone=warn] > .dot, .ss-status .dot[data-tone=warn] { background: var(--warn); }
.ss-status [data-tone=bad] > .dot, .ss-status .dot[data-tone=bad] { background: var(--bad); }
.ss-status .head { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 12px;
  background: #ffffff06; border: 1px solid var(--line); }
.ss-status .head .dot { width: 12px; height: 12px; }
.ss-status .head[data-tone=good] .dot { animation: ss-pulse 2s ease-in-out infinite; }
.ss-status .headline { font-size: 16px; font-weight: 600; }
.ss-status .conn { font-size: 12px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.ss-status .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ss-status .tile { padding: 10px 12px; border-radius: 10px; background: #ffffff05; border: 1px solid var(--line); min-width: 0; }
.ss-status .tile .lab { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.ss-status .tile .val { font-size: 22px; font-weight: 600; margin-top: 4px; white-space: nowrap; }
.ss-status .tile .val small { font-size: 13px; font-weight: 500; color: var(--muted); margin-left: 3px; }
.ss-status .tile .sub { font-size: 12px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-status .tile .word { margin-left: auto; font-size: 11px; color: var(--muted); }
.ss-status dl { display: grid; grid-template-columns: auto 1fr; gap: 0; margin: 0; font-size: 13px; }
.ss-status dt, .ss-status dd { padding: 7px 0; border-top: 1px solid var(--line); }
.ss-status dt { color: var(--muted); padding-right: 16px; }
.ss-status dd { margin: 0; display: flex; align-items: center; gap: 8px; justify-content: flex-end; text-align: right; }
@keyframes ss-pulse { 0%, 100% { box-shadow: 0 0 0 0 #3ddc9766; } 50% { box-shadow: 0 0 0 6px #3ddc9700; } }
@media (prefers-reduced-motion: reduce) { .ss-status .head .dot { animation: none !important; } }
`;

function injectCss(id: string, css: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.append(s);
}

/** 23 to 27 Hz (AirPods Pro 2 style) or 45 to 55 Hz (AirPods Pro 3 may stream at 50). */
export const rateOk = (hz: number) => (hz >= 23 && hz <= 27) || (hz >= 45 && hz <= 55);
const rateTone = (hz: number | null): Tone => (hz === null ? 'idle' : hz <= 0 ? 'bad' : rateOk(hz) ? 'good' : 'warn');
const rateWord = (hz: number | null) => (hz === null ? '' : hz <= 0 ? 'none' : rateOk(hz) ? 'ok' : hz < 23 ? 'low' : hz > 55 ? 'high' : 'off');

const HEADPHONES: Record<StatusMsg['headphones'], [string, Tone]> = {
  connected: ['Connected', 'good'], disconnected: ['Not connected', 'bad'], unavailable: ['Not supported on this Mac', 'bad'],
};
const AUTH: Record<StatusMsg['auth'], [string, Tone]> = {
  authorized: ['Allowed', 'good'], denied: ['Denied (System Settings › Privacy)', 'bad'],
  notDetermined: ['Not asked yet', 'warn'], restricted: ['Restricted', 'bad'],
};
const LOC: Record<StatusMsg['loc'], string> = { left: 'Left', right: 'Right', default: 'Default', unknown: 'Unknown' };

const panel: Panel = {
  id: 'status',
  order: 10,
  title: 'Connection',
  mount(el: HTMLElement, app: App) {
    injectCss('ss-status-css', CSS);
    el.innerHTML = `
      <div class="ss-status">
        <div class="head" data-tone="idle">
          <span class="dot"></span>
          <div><div class="headline">Starting…</div><div class="conn" data-testid="status-conn">connecting</div></div>
        </div>
        <div class="tiles">
          <div class="tile" data-k="bridge"><div class="lab"><span class="dot"></span>Mac sends<span class="word"></span></div>
            <div class="val" data-testid="status-bridge-hz">–</div><div class="sub">per second</div></div>
          <div class="tile" data-k="browser"><div class="lab"><span class="dot"></span>Browser gets<span class="word"></span></div>
            <div class="val" data-testid="status-browser-hz">–</div><div class="sub">measured over 2 s</div></div>
          <div class="tile" data-k="gaps"><div class="lab"><span class="dot"></span>Dropped<span class="word"></span></div>
            <div class="val" data-testid="status-gaps"><span data-k="gap">–</span><small data-k="missed"></small></div><div class="sub" title="Mac: % of gaps over 60 ms. Browser: samples missing from the sequence. Last 10 s.">last 10 s</div></div>
          <div class="tile" data-k="invalid"><div class="lab"><span class="dot"></span>Bad messages<span class="word"></span></div>
            <div class="val" data-testid="status-invalid">0</div><div class="sub">failed to parse</div></div>
        </div>
        <dl>
          <dt>AirPods</dt><dd data-k="headphones"><span class="dot"></span><span data-testid="status-headphones">–</span></dd>
          <dt>Motion access</dt><dd data-k="auth"><span class="dot"></span><span>–</span></dd>
          <dt>Sensor bud</dt><dd data-k="loc"><span>–</span></dd>
          <dt>Motion data</dt><dd data-k="simulated"><span>–</span></dd>
          <dt>Actions</dt><dd data-k="armed"><span class="dot"></span><span>–</span></dd>
        </dl>
      </div>`;

    const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const head = q('.head'), headline = q('.headline'), connEl = q('[data-testid=status-conn]');
    const tile = (k: string) => q(`.tile[data-k=${k}]`);
    const row = (k: string) => q(`dd[data-k=${k}]`);
    const setTone = (node: HTMLElement, tone: Tone) => { if (node.dataset.tone !== tone) node.dataset.tone = tone; };
    const setText = (node: Element, text: string) => { if (node.textContent !== text) node.textContent = text; };
    const setTile = (k: string, tone: Tone, word: string) => {
      const t = tile(k);
      setTone(t.querySelector('.lab') as HTMLElement, tone);
      setText(t.querySelector('.word')!, word);
    };
    const setRow = (k: string, text: string, tone?: Tone) => {
      const r = row(k);
      setText(r.querySelector('span:last-child')!, text);
      if (tone) setTone(r, tone);
    };

    // ---- state fed by the bus ----
    let conn: { state: string; url: string } = { state: 'connecting', url: '' };
    let status: StatusMsg | null = null;
    let invalid = 0;
    const arrivals: number[] = []; // performance.now() of each motion sample, last 10 s
    const misses: { at: number; n: number }[] = []; // seq jumps seen by the browser, last 10 s
    let lastSeq: number | null = null;

    app.bus.on('conn', (c) => { conn = c; render(); });
    app.bus.on('status', (s) => { status = s; render(); });
    app.bus.on('invalid', () => { invalid++; render(); });
    app.bus.on('source', () => {
      status = null; invalid = 0; lastSeq = null;
      arrivals.length = 0; misses.length = 0;
      render();
    });
    app.bus.on('motion', (s) => {
      const now = performance.now();
      arrivals.push(now);
      // seq goes up by 1 per sample; a jump means the browser missed samples. Going back = new stream.
      if (lastSeq !== null && s.seq > lastSeq + 1) misses.push({ at: now, n: s.seq - lastSeq - 1 });
      lastSeq = s.seq;
    });

    function render() {
      const now = performance.now();
      while (arrivals.length && arrivals[0] < now - 10_000) arrivals.shift();
      while (misses.length && misses[0].at < now - 10_000) misses.shift();
      const open = conn.state === 'open';
      let last2s = 0;
      for (let i = arrivals.length - 1; i >= 0 && arrivals[i] >= now - 2000; i--) last2s++;
      const browserHz = last2s / 2;
      const bridgeHz = status && open ? status.hz : null;
      const missed = misses.reduce((a, m) => a + m.n, 0);
      const browserGapPct = missed ? (100 * missed) / (missed + arrivals.length) : 0;

      // tiles
      setText(q('[data-testid=status-bridge-hz]'), bridgeHz === null ? '–' : `${bridgeHz.toFixed(1)} Hz`);
      setTile('bridge', rateTone(bridgeHz), rateWord(bridgeHz));
      setText(q('[data-testid=status-browser-hz]'), `${browserHz.toFixed(1)} Hz`);
      const bTone = !open && browserHz === 0 ? 'idle' : rateTone(browserHz);
      setTile('browser', bTone, bTone === 'idle' ? '' : rateWord(browserHz));
      const gap = status && open ? status.gapPct : null;
      setText(q('[data-k=gap]'), gap === null ? '–' : `${gap.toFixed(1)}%`);
      setText(q('[data-k=missed]'), gap === null && !arrivals.length ? '' : ` · ${missed} missed`);
      const worstGap = Math.max(gap ?? 0, browserGapPct);
      const gapTone: Tone = gap === null && !missed ? 'idle' : worstGap < 5 ? 'good' : worstGap < 20 ? 'warn' : 'bad';
      setTile('gaps', gapTone, gapTone === 'good' ? 'ok' : gapTone === 'idle' ? '' : 'high');

      setText(q('[data-testid=status-invalid]'), String(invalid));
      setTile('invalid', invalid ? 'warn' : 'good', invalid ? 'check' : 'ok');

      // device rows
      if (status) {
        const [hText, hTone] = HEADPHONES[status.headphones] ?? [status.headphones, 'warn'];
        setRow('headphones', hText, hTone);
        const [aText, aTone] = AUTH[status.auth] ?? [status.auth, 'warn'];
        setRow('auth', aText, aTone);
        setRow('loc', LOC[status.loc] ?? status.loc);
        setRow('simulated', status.simulated ? 'Simulated (no AirPods needed)' : 'Real AirPods');
        setRow('armed', status.armed ? 'Armed: actions run for real' : 'Safe mode: dry run only', status.armed ? 'warn' : 'good');
      } else {
        for (const k of ['headphones', 'auth', 'loc', 'simulated', 'armed']) setRow(k, '–', 'idle');
      }

      // headline
      const kind = app.source?.kind ?? '…';
      const where = conn.url && conn.url !== kind ? ` · ${conn.url}` : '';
      setText(connEl, `${kind} · ${conn.state}${where}${conn.state === 'closed' && kind === 'live' ? ' · retrying' : ''}`);
      let tone: Tone, text: string;
      if (conn.state === 'connecting') [tone, text] = ['warn', 'Connecting to the Mac…'];
      else if (!open) [tone, text] = ['bad', kind === 'live' ? 'Mac app not reachable' : 'Stopped'];
      else if (status && status.headphones !== 'connected') [tone, text] = ['warn', 'Put in your AirPods'];
      else if (status && status.auth !== 'authorized') [tone, text] = ['warn', 'Motion access needed'];
      else if (browserHz === 0) [tone, text] = ['bad', 'No motion data yet'];
      else if (!rateOk(browserHz) || worstGap >= 5) [tone, text] = ['warn', 'Signal is choppy'];
      else [tone, text] = ['good', kind === 'live' ? (status?.simulated ? 'Streaming (simulated)' : 'Streaming from AirPods') : `Streaming ${kind} data`];
      setTone(head, tone);
      setText(headline, text);
    }

    render();
    setInterval(render, 250);
  },
};
export default panel;

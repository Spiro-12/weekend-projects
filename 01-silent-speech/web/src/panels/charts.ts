// Live strip chart: the last 10 s of rotation rate and acceleration (x, y, z each), push to talk
// windows shaded, plus a "jaw energy" meter. Plain canvas, DPR aware, drawn with requestAnimationFrame.
import type { App, Panel } from '../core/app';
import type { MotionSample } from '../core/contracts';

const WINDOW_SEC = 10;
const GAP_SEC = 0.25; // break the line when samples are further apart than this (dropped data)
const JAW_SEC = 0.3; // jaw energy = RMS of high passed rotation rate over this window
const JAW_HP_HZ = 1.0;
const STALE_SEC = 1.5; // no new sample for this long: dim the chart, stop scrolling, go idle
const MAX_ABS = 1e4; // values beyond this (or not finite) are treated as missing, never drawn or scaled

// Axis colors: categorical slots 1 to 3 (blue, orange, aqua), validated for CVD separation on the dark card.
const AXES = [
  { name: 'x', color: '#3987e5' },
  { name: 'y', color: '#d95926' },
  { name: 'z', color: '#199e70' },
] as const;
const GROUPS = [
  { key: 'rr', title: 'Rotation rate', unit: 'rad/s', floor: 0.05 },
  { key: 'ua', title: 'Acceleration', unit: 'g', floor: 0.008 },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];

const INK = { primary: '#e8ebf2', secondary: '#b4bccb', muted: '#8a93a6', grid: '#1a1f2b', zero: '#2b3244', talk: '#ff5d6c' };
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const CSS = `
.ss-chart { position: relative; }
.ss-chart .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: -4px 0 10px; font-size: 12px; color: var(--muted); }
.ss-chart .legend { display: flex; gap: 14px; align-items: center; }
.ss-chart .key { display: inline-flex; align-items: center; gap: 6px; color: #b4bccb; }
.ss-chart .key i { display: inline-block; width: 14px; height: 2px; border-radius: 2px; }
.ss-chart .key.talk i { width: 12px; height: 12px; border-radius: 3px; background: #ff5d6c1f; box-shadow: inset 0 2px 0 #ff5d6ccc; }
.ss-chart .jaw { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 260px; }
.ss-chart .jaw .lab { color: #b4bccb; white-space: nowrap; }
.ss-chart .jaw .track { position: relative; flex: 1; height: 8px; border-radius: 999px; background: #7c9cff1f; overflow: hidden; }
.ss-chart .jaw .fill { position: absolute; inset: 0; border-radius: 999px; transform-origin: left center; transform: scaleX(0);
  background: linear-gradient(90deg, #5b7cf0, #9db4ff); }
.ss-chart .jaw .peak { position: absolute; inset: 0; transform: translateX(0); }
.ss-chart .jaw .peak::before { content: ''; position: absolute; left: -2px; top: 0; bottom: 0; width: 2px; border-radius: 2px; background: #c9d6ff; opacity: .8; }
.ss-chart .jaw .num { font-variant-numeric: tabular-nums; color: var(--text); min-width: 74px; text-align: right; white-space: nowrap; }
.ss-chart .jaw .num small { color: var(--muted); }
.ss-chart canvas { display: block; width: 100%; height: 340px; touch-action: pan-y; cursor: crosshair; }
.ss-chart .tip { position: absolute; pointer-events: none; z-index: 2; min-width: 168px; padding: 8px 10px; border-radius: 10px;
  background: #0b0d12f0; border: 1px solid #2a3142; box-shadow: 0 8px 24px #0008; font-size: 12px; color: var(--muted);
  font-variant-numeric: tabular-nums; }
.ss-chart .tip[hidden] { display: none; }
.ss-chart .tip .when { color: var(--text); font-weight: 600; margin-bottom: 4px; }
.ss-chart .tip .grp { margin-top: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.ss-chart .tip .row { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.ss-chart .tip .row i { width: 10px; height: 2px; border-radius: 2px; flex: none; }
.ss-chart .tip .row b { color: var(--text); font-weight: 600; margin-left: auto; }
@media (max-width: 640px) { .ss-chart .jaw { margin-left: 0; min-width: 0; width: 100%; } .ss-chart canvas { height: 300px; } }
`;

function injectCss(id: string, css: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.append(s);
}

/** Largest 1/2/5 × 10^k step that fits inside `max`. */
function niceStep(max: number): number {
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [5, 2, 1]) if (m * p <= max) return m * p;
  return p / 2;
}

const fmtTick = (v: number, step: number) => {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
};
const ok = (v: number) => Number.isFinite(v) && Math.abs(v) <= MAX_ABS;
const fmtVal = (v: number) => (ok(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)}` : '–');
const chan = (s: MotionSample, g: GroupKey, i: number) => s[g][i];
/** A sample can be drawn for a group only if its time and all 3 channels are sane. */
const okGroup = (s: MotionSample, g: GroupKey) => Number.isFinite(s.t) && ok(s[g][0]) && ok(s[g][1]) && ok(s[g][2]);

/** First index with ring[i].t >= t (ring is time ordered). */
function lowerBound(ring: MotionSample[], t: number): number {
  let lo = 0, hi = ring.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

interface TalkWindow { t0: number; t1: number | null; pressT: number; clipId?: string; label?: string }

/** Jaw energy: 1st order high pass (1 Hz) per rotation axis, then vector RMS over the last 0.3 s. */
class JawEnergy {
  rms = 0;
  level = 0; // 0..1, relative to an adaptive resting floor and recent peak
  private prev: MotionSample | null = null;
  private hp = [0, 0, 0];
  private win: { t: number; e: number }[] = [];
  private floor = -1;
  private peak = 0;

  reset() {
    this.prev = null; this.hp = [0, 0, 0]; this.win = []; this.rms = 0; this.level = 0;
    this.floor = -1; this.peak = 0;
  }

  push(s: MotionSample) {
    if (!okGroup(s, 'rr')) return; // a broken sample is skipped, it never poisons the state
    const p = this.prev;
    this.prev = s;
    if (!p) return;
    const dt = s.t - p.t;
    if (dt <= 0 || dt > 0.5) { this.reset(); this.prev = s; return; } // clock jump or long gap: start over
    const rc = 1 / (2 * Math.PI * JAW_HP_HZ);
    const a = rc / (rc + dt);
    let e = 0;
    for (let i = 0; i < 3; i++) {
      this.hp[i] = a * (this.hp[i] + s.rr[i] - p.rr[i]);
      e += this.hp[i] * this.hp[i];
    }
    this.win.push({ t: s.t, e });
    while (this.win.length && this.win[0].t <= s.t - JAW_SEC) this.win.shift();
    let sum = 0; // recomputed from the window (a dozen samples), so rounding never accumulates
    for (const w of this.win) sum += w.e;
    this.rms = Math.sqrt(sum / Math.max(1, this.win.length));
    if (!Number.isFinite(this.rms)) { this.reset(); return; }
    // Floor follows the quiet level (falls fast, rises slowly); peak decays over a few seconds.
    if (this.floor < 0) this.floor = this.rms;
    this.floor += (this.rms - this.floor) * (this.rms < this.floor ? 0.3 : Math.min(1, dt / 8));
    this.peak = Math.max(this.rms, this.peak * Math.exp(-dt / 6));
    const top = Math.max(this.floor * 2.5, this.peak, 1e-6);
    this.level = Math.min(1, Math.max(0, (this.rms - this.floor) / Math.max(1e-6, top - this.floor)));
    if (!Number.isFinite(this.level)) this.reset();
  }
}

const panel: Panel = {
  id: 'charts',
  order: 20,
  title: 'Live motion · last 10 seconds',
  mount(el: HTMLElement, app: App) {
    injectCss('ss-chart-css', CSS);
    el.closest('.card')?.classList.add('wide');
    el.innerHTML = `
      <div class="ss-chart">
        <div class="bar">
          <div class="legend">
            ${AXES.map((a) => `<span class="key"><i style="background:${a.color}"></i>${a.name}</span>`).join('')}
            <span class="key talk"><i></i>push to talk</span>
          </div>
          <div class="jaw" data-testid="jaw-energy" title="How much your jaw is moving right now (rotation rate, high passed, RMS over 0.3 s)">
            <span class="lab">Jaw energy</span>
            <div class="track"><div class="fill"></div><div class="peak"></div></div>
            <span class="num">–</span>
          </div>
        </div>
        <canvas data-testid="chart-canvas" role="img"
          aria-label="Live chart of AirPods rotation rate and acceleration on the x, y and z axes over the last 10 seconds"></canvas>
        <div class="tip" hidden></div>
      </div>`;

    const root = el.querySelector('.ss-chart') as HTMLElement;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    const tip = el.querySelector('.tip') as HTMLElement;
    const jawEl = el.querySelector('.jaw') as HTMLElement;
    const jawFill = el.querySelector('.jaw .fill') as HTMLElement;
    const jawPeak = el.querySelector('.jaw .peak') as HTMLElement;
    const jawNum = el.querySelector('.jaw .num') as HTMLElement;
    if (!ctx) { canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Canvas is not available in this browser.' })); return; }
    const cssCard = getComputedStyle(document.documentElement).getPropertyValue('--card').trim();
    const card = /^#[0-9a-f]{6}$/i.test(cssCard) ? cssCard : '#12151d'; // must be #rrggbb: we append alpha below

    // ---------- state ----------
    const jaw = new JawEnergy();
    let windows: TalkWindow[] = [];
    let conn = 'connecting';
    let offset: number | null = null; // sample clock minus page clock (s), smoothed
    let lastArrival = 0;
    let lastT = -Infinity;
    const ranges: Record<GroupKey, number> = { rr: GROUPS[0].floor, ua: GROUPS[1].floor };
    let hoverX: number | null = null;
    let jawShown = 0, peakShown = 0;

    const resetAll = () => {
      windows = []; offset = null; lastT = -Infinity; jaw.reset();
      ranges.rr = GROUPS[0].floor; ranges.ua = GROUPS[1].floor;
    };
    // Drawing runs on requestAnimationFrame while data flows, and goes idle when it is stale.
    let raf = 0, needsDraw = true;
    const wake = () => { needsDraw = true; if (!raf) raf = requestAnimationFrame(frame); };
    app.bus.on('source', () => { resetAll(); wake(); });
    app.bus.on('conn', (c) => { conn = c.state; wake(); });
    app.bus.on('motion', (s) => {
      const now = performance.now() / 1000;
      if (s.t < lastT - 1) resetAll(); // clock went backwards (simulate toggled, replay looped)
      lastT = Math.max(lastT, s.t);
      lastArrival = now;
      const est = s.t - now;
      // Track the newest-sample clock: jump on big changes, otherwise drift slowly (smooth scrolling).
      if (offset === null || Math.abs(est - offset) > 0.5) offset = est;
      else offset += (est - offset) * (est > offset ? 0.2 : 0.02);
      jaw.push(s);
      for (const w of windows) if (Number.isNaN(w.t0)) { w.t0 = s.t; w.pressT = s.t; } // pressed before any data
      wake();
    });
    app.bus.on('ptt', ({ down, t }) => {
      const open = windows.at(-1);
      if (down) {
        const t0 = app.ring.length ? t : NaN;
        windows.push({ t0, t1: null, pressT: t0 });
      } else if (open && open.t1 === null) {
        open.t1 = Number.isNaN(open.t0) ? null : t;
        if (open.t1 === null) windows.pop();
      }
      if (windows.length > 40) windows = windows.slice(-40);
      canvas.dataset.pttWindows = String(windows.length);
      wake();
    });
    app.bus.on('clip', (c) => {
      const w = windows.find((x) => Math.abs(x.pressT - c.pressT) < 1e-6 && x.t1 !== null);
      if (w) w.clipId = c.id;
      wake();
    });
    app.bus.on('prediction', (p) => {
      const w = windows.find((x) => x.clipId === p.clipId);
      if (!w) return;
      const sentence = app.classes.find((c) => c.id === p.label)?.sentence ?? p.label;
      w.label = p.label === 'none' ? `no sentence · ${Math.round(p.confidence * 100)}%` : `“${sentence}” · ${Math.round(p.confidence * 100)}%`;
      wake();
    });

    // ---------- size ----------
    let cssW = 0, cssH = 0, dpr = 1;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const d = Math.min(3, window.devicePixelRatio || 1);
      if (r.width === cssW && r.height === cssH && d === dpr) return;
      cssW = r.width; cssH = r.height; dpr = d;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
    };
    new ResizeObserver(() => { fit(); wake(); }).observe(canvas);

    // ---------- tooltip (built once; values lead, names follow; text via textContent only) ----------
    const tipWhen = document.createElement('div');
    tipWhen.className = 'when';
    tip.append(tipWhen);
    const tipVals: Record<GroupKey, HTMLElement[]> = { rr: [], ua: [] };
    for (const g of GROUPS) {
      const head = document.createElement('div');
      head.className = 'grp';
      head.textContent = `${g.title} · ${g.unit}`;
      tip.append(head);
      AXES.forEach((a) => {
        const row = document.createElement('div');
        row.className = 'row';
        const key = document.createElement('i');
        key.style.background = a.color;
        const name = document.createElement('span');
        name.textContent = a.name;
        const val = document.createElement('b');
        row.append(key, name, val);
        tip.append(row);
        tipVals[g.key].push(val);
      });
    }

    // ---------- hover ----------
    canvas.addEventListener('pointermove', (e) => { hoverX = e.clientX - canvas.getBoundingClientRect().left; wake(); });
    canvas.addEventListener('pointerleave', () => { hoverX = null; tip.hidden = true; wake(); });

    // ---------- draw ----------
    const PAD = { l: 52, r: 14, top: 22, gap: 34, bottom: 24 };
    let prevFrame = performance.now() / 1000;

    let drawnStale = false;
    function frame() {
      raf = 0;
      fit();
      if (!ctx || cssW < 10 || cssH < 10) return; // hidden: the ResizeObserver wakes us when it shows
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, Math.max(0, now - prevFrame));
      prevFrame = now;

      const ring = app.ring;
      const newest = ring.length ? ring[ring.length - 1].t : null;
      const stale = newest === null || now - lastArrival > STALE_SEC;
      // Idle: data is stale, the stale frame is on screen, nobody hovers, the meter has settled.
      if (stale && drawnStale && !needsDraw && hoverX === null && jawShown < 0.002 && peakShown < 0.002) return;
      needsDraw = false;
      drawnStale = stale;
      raf = requestAnimationFrame(frame);

      // Right edge = "now" on the sample clock (keeps scrolling smoothly between 25/50 Hz samples),
      // stopping STALE_SEC after the newest sample so a stale chart holds still.
      const tR = offset !== null && newest !== null ? Math.min(now + offset, newest + STALE_SEC) : (newest ?? 0);
      const tL = tR - WINDOW_SEC;
      const i0 = Math.max(0, lowerBound(ring, tL - 0.2) - 1);
      const vis = ring.slice(i0);

      // Auto scale per group: fast attack, slow release.
      for (const g of GROUPS) {
        let m = 0;
        for (const s of vis) if (okGroup(s, g.key)) for (let i = 0; i < 3; i++) m = Math.max(m, Math.abs(chan(s, g.key, i)));
        const target = Math.max(g.floor, m * 1.18);
        const cur = Number.isFinite(ranges[g.key]) ? ranges[g.key] : g.floor;
        const tau = target > cur ? 0.12 : 1.4;
        const next = cur + (target - cur) * (1 - Math.exp(-dt / tau));
        ranges[g.key] = Number.isFinite(next) && next > 0 ? next : g.floor;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const x0 = PAD.l, x1 = cssW - PAD.r, pw = x1 - x0;
      const plotH = (cssH - PAD.top - PAD.gap - PAD.bottom) / 2;
      const rects = GROUPS.map((g, gi) => ({ g, top: PAD.top + gi * (plotH + PAD.gap), h: plotH }));
      const xOf = (t: number) => x1 - ((tR - t) / WINDOW_SEC) * pw;

      // Push to talk windows (behind everything), with a small tab label in the title row when it fits.
      const top = rects[0].top - 4, bottom = rects[1].top + rects[1].h;
      ctx.font = `600 12px ${FONT}`;
      let labelMin = x0 + ctx.measureText(GROUPS[0].title).width + 60; // keep clear of the group title
      for (const w of windows) {
        if (Number.isNaN(w.t0)) continue;
        const a = Math.max(x0, xOf(w.t0)), b = Math.min(x1, w.t1 === null ? x1 : xOf(w.t1));
        if (b <= x0 || a >= x1 || b - a < 0.5) continue;
        const grad = ctx.createLinearGradient(0, top, 0, bottom);
        grad.addColorStop(0, '#ff5d6c1c');
        grad.addColorStop(1, '#ff5d6c05');
        ctx.fillStyle = grad;
        ctx.fillRect(a, top, b - a, bottom - top);
        ctx.fillStyle = w.t1 === null ? INK.talk : '#ff5d6ca8';
        ctx.fillRect(a, top, b - a, 2);
        const pct = w.label?.match(/\d+%$/)?.[0];
        const options = w.label ? [w.label, pct ?? ''] : w.t1 === null ? ['listening…'] : [];
        ctx.font = `600 11px ${FONT}`;
        for (const text of options) {
          if (!text) continue;
          const tw = ctx.measureText(text).width;
          const lx = a + 2;
          if (lx < labelMin || lx + tw > x1) continue;
          ctx.fillStyle = INK.secondary;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(text, lx, rects[0].top - 9);
          labelMin = lx + tw + 10;
          break;
        }
      }

      // Time grid + axis labels.
      ctx.font = `11px ${FONT}`;
      ctx.textBaseline = 'alphabetic';
      const labelEvery = pw / (WINDOW_SEC / 2) < 48 ? 4 : 2; // narrow screens: label every other line
      for (let k = 0; k <= WINDOW_SEC; k += 2) {
        const x = x1 - (k / WINDOW_SEC) * pw;
        ctx.fillStyle = INK.grid;
        for (const r of rects) ctx.fillRect(Math.round(x) - 0.5, r.top, 1, r.h);
        if (k % labelEvery !== 0) continue;
        ctx.fillStyle = INK.muted;
        ctx.textAlign = k === 0 ? 'right' : k === WINDOW_SEC ? 'left' : 'center';
        ctx.fillText(k === 0 ? 'now' : `−${k} s`, k === WINDOW_SEC ? Math.max(x, x0) : x, cssH - 7);
      }

      // Groups.
      for (const { g, top: gt, h } of rects) {
        const R = ranges[g.key];
        const mid = gt + h / 2;
        const yOf = (v: number) => mid - (v / R) * (h / 2);
        const step = niceStep(R * 0.92);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of [step, 0, -step]) {
          const y = Math.round(yOf(v)) + 0.5;
          ctx.fillStyle = v === 0 ? INK.zero : INK.grid;
          ctx.fillRect(x0, y - 0.5, pw, 1);
          ctx.fillStyle = INK.muted;
          ctx.fillText(fmtTick(v, step), x0 - 8, y);
        }
        // Title above the plot.
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `600 12px ${FONT}`;
        ctx.fillStyle = INK.primary;
        ctx.fillText(g.title, x0, gt - 9);
        const tw = ctx.measureText(g.title).width;
        ctx.font = `11px ${FONT}`;
        ctx.fillStyle = INK.muted;
        ctx.fillText(g.unit, x0 + tw + 6, gt - 9);
        ctx.font = `11px ${FONT}`;

        // Lines: midpoint quadratic smoothing, broken where samples are missing.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, gt - 2, pw + 2, h + 4);
        ctx.clip();
        ctx.lineWidth = pw < 520 ? 1.5 : 2; // phones squeeze 10 s into ~250 px
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = stale ? 0.45 : 1;
        for (let ai = AXES.length - 1; ai >= 0; ai--) {
          ctx.strokeStyle = AXES[ai].color;
          ctx.beginPath();
          let px = 0, py = 0, prevT = -Infinity, open = false;
          for (const s of vis) {
            if (!okGroup(s, g.key)) { // broken sample: treat like a gap
              if (open) ctx.lineTo(px, py);
              open = false;
              continue;
            }
            const x = xOf(s.t), y = yOf(chan(s, g.key, ai));
            if (!open || s.t - prevT > GAP_SEC) {
              if (open) ctx.lineTo(px, py);
              ctx.moveTo(x, y);
              open = true;
            } else {
              ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
            }
            px = x; py = y; prevT = s.t;
          }
          if (open) ctx.lineTo(px, py);
          ctx.stroke();
        }
        ctx.restore();

        // Live end dots with a ring in the card color.
        if (!stale && vis.length && okGroup(vis[vis.length - 1], g.key)) {
          const s = vis[vis.length - 1];
          const x = Math.min(x1, xOf(s.t));
          for (let ai = 0; ai < AXES.length; ai++) {
            const y = yOf(chan(s, g.key, ai));
            if (y < gt - 2 || y > gt + h + 2) continue;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = AXES[ai].color;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = card;
            ctx.stroke();
          }
        }
      }

      // Soft fade into the past on the left edge.
      const fade = ctx.createLinearGradient(x0, 0, x0 + 36, 0);
      fade.addColorStop(0, card);
      fade.addColorStop(1, `${card}00`);
      ctx.fillStyle = fade;
      for (const r of rects) ctx.fillRect(x0, r.top - 2, 36, r.h + 4);

      // Empty / stale message.
      if (stale) {
        const msg = app.source?.kind === 'live' && conn !== 'open' ? 'Not connected to the Mac app yet'
          : newest === null ? 'Waiting for motion data…' : 'No new motion data';
        ctx.font = `500 13px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(msg).width + 28;
        const cx = x0 + pw / 2, cy = PAD.top + (cssH - PAD.top - PAD.bottom) / 2 - 4;
        ctx.fillStyle = '#0b0d12d9';
        ctx.beginPath();
        ctx.roundRect(cx - w / 2, cy - 16, w, 32, 16);
        ctx.fill();
        ctx.strokeStyle = '#2a3142';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = INK.secondary;
        ctx.fillText(msg, cx, cy + 0.5);
      }

      // Crosshair + tooltip.
      drawHover(vis, rects, xOf, tR, x0, x1, pw);

      // Jaw energy meter.
      const target = stale ? 0 : jaw.level;
      jawShown += (target - jawShown) * (1 - Math.exp(-dt / (target > jawShown ? 0.05 : 0.25)));
      peakShown = Math.max(jawShown, peakShown - dt * 0.35);
      const fillT = `scaleX(${jawShown.toFixed(3)})`, peakT = `translateX(${(peakShown * 100).toFixed(1)}%)`;
      if (jawFill.style.transform !== fillT) jawFill.style.transform = fillT;
      if (jawPeak.style.transform !== peakT) jawPeak.style.transform = peakT;
      const num = stale ? '–' : jaw.rms.toFixed(3);
      if (jawEl.dataset.value !== num) {
        jawEl.dataset.value = num;
        jawNum.innerHTML = stale ? '–' : `${num} <small>rad/s</small>`;
      }
    }

    function drawHover(
      vis: MotionSample[], rects: { g: (typeof GROUPS)[number]; top: number; h: number }[],
      xOf: (t: number) => number, tR: number, x0: number, x1: number, pw: number,
    ) {
      if (!ctx) return;
      if (hoverX === null || hoverX < x0 || hoverX > x1 || !vis.length) { tip.hidden = true; return; }
      const tc = tR - ((x1 - hoverX) / pw) * WINDOW_SEC;
      let best: MotionSample | null = null;
      for (const s of vis) if (Number.isFinite(s.t) && (!best || Math.abs(s.t - tc) < Math.abs(best.t - tc))) best = s;
      if (!best) { tip.hidden = true; return; }
      const x = xOf(best.t);
      if (x < x0 || x > x1) { tip.hidden = true; return; }
      ctx.fillStyle = '#8a93a680';
      ctx.fillRect(Math.round(x) - 0.5, rects[0].top, 1, rects[1].top + rects[1].h - rects[0].top);
      for (const { g, top, h } of rects) {
        const R = ranges[g.key], mid = top + h / 2;
        if (!okGroup(best, g.key)) continue;
        for (let ai = 0; ai < AXES.length; ai++) {
          const y = mid - (chan(best, g.key, ai) / R) * (h / 2);
          if (y < top - 2 || y > top + h + 2) continue;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = AXES[ai].color;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = card;
          ctx.stroke();
        }
      }
      const ago = tR - best.t;
      tipWhen.textContent = ago < 0.05 ? 'now' : `${ago.toFixed(1)} s ago`;
      for (const g of GROUPS) tipVals[g.key].forEach((v, ai) => { v.textContent = fmtVal(chan(best!, g.key, ai)); });
      tip.hidden = false;
      const cw = canvas.offsetLeft, ct = canvas.offsetTop;
      const tw = tip.offsetWidth;
      const left = x + 16 + tw > root.clientWidth ? x - 16 - tw : x + 16;
      tip.style.left = `${cw + left}px`;
      tip.style.top = `${ct + rects[0].top}px`;
    }

    wake();
  },
};
export default panel;

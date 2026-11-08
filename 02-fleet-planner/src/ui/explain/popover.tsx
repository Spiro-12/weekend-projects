// ExplainPopover (Track F): every number in the panels hovers (or taps, on phones) to how it's worked out.
// One popover for the whole app, rendered into its own root on <body> so no panel's scroll box, blur or transform
// can clip it. Desktop: a floating card beside the panel. Phones: a bottom sheet with a backdrop.
// Keyboard: numbers are buttons (Tab shows the popover, Enter pins it and moves focus inside, Esc closes).
import { render, type ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import '../panels.css';
import { BADGE, badgeOf, NOT_MODELED, type ExplainContent, type ExplainRow } from './content.ts';

interface OpenState {
  anchor: HTMLElement;
  content: () => ExplainContent;
  /** Opened by a click or tap: stays until closed. Hover/focus popovers close when the pointer or focus leaves. */
  pinned: boolean;
  /** Move keyboard focus into the popover (opened with Enter/Space). */
  focus: boolean;
}

export const explainOpen = signal<OpenState | null>(null);
export const PHONE_MQ = '(max-width: 760px), (pointer: coarse) and (max-height: 520px)';

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
const popEl = () => document.getElementById('fp-explain-pop');
/** True while closeExplain hands focus back to the anchor (so its focus handler doesn't reopen the popover). */
let returningFocus = false;

function clearTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  stopTravel();
}

export function openExplain(anchor: HTMLElement, content: () => ExplainContent, pinned: boolean, focus = false): void {
  clearTimers();
  explainOpen.value = { anchor, content, pinned, focus };
}

export function closeExplain(returnFocus = false): void {
  clearTimers();
  const st = explainOpen.value;
  if (!st) return;
  explainOpen.value = null;
  if (returnFocus && st.anchor.isConnected) {
    returningFocus = true;
    st.anchor.focus({ preventScroll: true });
    returningFocus = false;
  }
}

function scheduleClose(ms: number) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (explainOpen.value && !explainOpen.value.pinned) closeExplain();
  }, ms);
}

/** Grace and hover intent: after the pointer leaves a number, its popover (often 300 px away, beside the panel) stays
 *  open for 500 ms, and keeps extending while the pointer is still heading toward it. */
const GRACE_MS = 500;
const TRAVEL_MS = 350;
let travel: ((e: PointerEvent) => void) | null = null;
function stopTravel() {
  if (travel) document.removeEventListener('pointermove', travel);
  travel = null;
}
function distanceToPop(x: number, y: number): number {
  const r = popEl()?.getBoundingClientRect();
  if (!r) return Infinity;
  return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
}
function leaveAnchor(e: PointerEvent) {
  stopTravel();
  scheduleClose(GRACE_MS);
  let last = distanceToPop(e.clientX, e.clientY);
  travel = (ev) => {
    const d = distanceToPop(ev.clientX, ev.clientY);
    if (d < last - 0.5) scheduleClose(TRAVEL_MS);
    last = d;
  };
  document.addEventListener('pointermove', travel);
}

let mounted = false;
function ensureLayer() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const el = document.createElement('div');
  el.id = 'fp-explain';
  document.body.appendChild(el);
  render(<Layer />, el);
  // Registered once (not per open popover), so an Esc or a click right after a popover opens is never missed.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !explainOpen.value) return;
      // Esc closes the popover only (the app's Esc, which stops following a robot, waits for the next press).
      e.stopPropagation();
      e.preventDefault();
      closeExplain(true);
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      const st = explainOpen.value;
      const t = e.target as Node;
      if (!st || popEl()?.contains(t) || st.anchor.contains(t)) return;
      // The phone backdrop closes on its own click, so the tap can't fall through to the 3D view underneath.
      if ((t as Element).closest?.('.xp-backdrop')) return;
      closeExplain();
    },
    true,
  );
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(PHONE_MQ).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE_MQ);
    const fn = () => setPhone(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return phone;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Desktop placement: beside the anchor's card (left of right-side panels), below KPI tiles, above the bottom bar. */
function place(anchor: HTMLElement, pop: HTMLElement): { left: number; top: number } {
  const m = 12;
  const a = anchor.getBoundingClientRect();
  const c = ((anchor.closest('.card') as HTMLElement | null) ?? anchor).getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left: number;
  let top: number;
  if (anchor.closest('[data-slot="kpi"]')) {
    left = a.left;
    top = c.bottom + 8;
  } else if (anchor.closest('[data-slot="bottom"]')) {
    left = a.left + a.width / 2 - pw / 2;
    top = c.top - 8 - ph;
  } else if (c.left + c.width / 2 > innerWidth / 2) {
    left = c.left - 10 - pw;
    top = a.top - 14;
  } else {
    left = c.right + 10;
    top = a.top - 14;
  }
  return { left: clamp(left, m, innerWidth - m - pw), top: clamp(top, m, innerHeight - m - ph) };
}

function Layer() {
  const st = explainOpen.value;
  const phone = usePhone();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [, bump] = useState(0);

  useLayoutEffect(() => {
    if (!st) return;
    if (!st.anchor.isConnected) {
      closeExplain();
      return;
    }
    if (st.focus) ref.current?.focus({ preventScroll: true });
    // Follow the anchor when a panel scrolls or the window resizes.
    const move = () => bump((n) => n + 1);
    window.addEventListener('resize', move);
    document.addEventListener('scroll', move, true);
    return () => {
      window.removeEventListener('resize', move);
      document.removeEventListener('scroll', move, true);
    };
  }, [st]);

  // Measure and place after every render (content can change size while open); only store real changes.
  useLayoutEffect(() => {
    if (!st || phone || !ref.current) return;
    const p = place(st.anchor, ref.current);
    if (!pos || Math.abs(p.left - pos.left) > 0.5 || Math.abs(p.top - pos.top) > 0.5) setPos(p);
  });

  if (!st) return null;
  const c = st.content();
  const body = <Body c={c} pinned={st.pinned || phone} />;

  const common = {
    ref,
    id: 'fp-explain-pop',
    role: 'dialog' as const,
    'aria-labelledby': 'fp-explain-title',
    tabIndex: -1,
    'data-testid': 'explain-popover',
    onPointerEnter: () => {
      clearTimeout(closeTimer);
      stopTravel();
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') scheduleClose(300);
    },
    // Keyboard: Tab past the last link (or Shift+Tab before the first) closes the popover and hands focus back to its
    // number, so the next Tab carries on through the panel instead of leaving the page.
    onKeyDown: (e: KeyboardEvent) => {
      const pop = ref.current;
      if (e.key !== 'Tab' || !pop) return;
      const items = [...pop.querySelectorAll<HTMLElement>('a[href], button')];
      const active = document.activeElement;
      const out = e.shiftKey ? active === pop || active === items[0] : items.length === 0 || active === items[items.length - 1];
      if (!out) return;
      e.preventDefault();
      closeExplain(true);
    },
    // Focus leaving a popover any other way closes it too; leaving to nowhere hands focus back to its number.
    onFocusOut: (e: FocusEvent) => {
      const cur = explainOpen.value;
      const to = e.relatedTarget as Node | null;
      if (!cur || (to && (popEl()?.contains(to) || cur.anchor.contains(to)))) return;
      closeExplain(!to);
    },
  };
  if (phone)
    return (
      <>
        <div class="xp-backdrop" onClick={() => closeExplain()} />
        <div {...common} class="xp-pop xp-sheet">
          {body}
        </div>
      </>
    );
  return (
    <div {...common} class="xp-pop" style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '-9999px', top: '0px' }}>
      {body}
    </div>
  );
}

function Row({ r }: { r: ExplainRow }) {
  const b = badgeOf(r.from);
  return (
    <li class="xp-row" data-from={b}>
      <div class="xp-row-main">
        <span class="xp-label">
          {r.label} <span class={`xp-badge b-${b}`}>{BADGE[b]}</span>
        </span>
        <span class="xp-val">{r.value}</span>
      </div>
      {r.source ? (
        <a class="xp-src" href={r.source.url} target="_blank" rel="noopener noreferrer" data-testid="explain-source">
          {r.source.title} · {r.source.publisher}
        </a>
      ) : b === 'source' ? (
        <span class="xp-src">{r.from.slice('source:'.length)}</span>
      ) : null}
      {r.note && <div class="xp-row-note">{r.note}</div>}
    </li>
  );
}

function Body({ c, pinned }: { c: ExplainContent; pinned: boolean }) {
  return (
    <>
      <div class="xp-head">
        <div class="xp-title" id="fp-explain-title">
          {c.title}
        </div>
        {pinned ? (
          <button type="button" class="xp-x" aria-label="Close" data-testid="explain-close" onClick={() => closeExplain(true)}>
            ×
          </button>
        ) : (
          <span class="xp-hint" data-testid="explain-hint">
            click to keep open
          </span>
        )}
      </div>
      {c.stale && (
        <p class="xp-stale" data-testid="explain-stale">
          Recalculating… these numbers are for the previous settings.
        </p>
      )}
      {c.flag ? (
        <div class="xp-flag" data-testid="explain-flag">
          {c.flag}
        </div>
      ) : c.value ? (
        <div class="xp-value">{c.value}</div>
      ) : null}
      {c.reference && (
        <div class="xp-ref" data-testid="explain-reference">
          {c.reference}
        </div>
      )}
      {c.text?.map((t) => (
        <p class="xp-text" key={t}>
          {t}
        </p>
      ))}
      {c.formula && (
        <div class="xp-sec">
          <div class="xp-h">How it’s worked out</div>
          <div class="xp-formula" data-testid="explain-formula">
            {c.formula}
          </div>
          {c.worked && (
            <div class="xp-worked" data-testid="explain-worked">
              {c.worked}
            </div>
          )}
        </div>
      )}
      {c.inputs && c.inputs.length > 0 && (
        <div class="xp-sec">
          <div class="xp-h">What goes in</div>
          <ul class="xp-inputs">
            {c.inputs.map((r, i) => (
              <Row key={i} r={r} />
            ))}
          </ul>
        </div>
      )}
      {c.note && <p class="xp-note">{c.note}</p>}
      {c.run && <p class="xp-run">{c.run}</p>}
      {c.notModeled && <p class="xp-left-out">{NOT_MODELED}</p>}
      {c.demo && !/demo/i.test(c.note ?? '') && <p class="xp-demo">Demo data: placeholder numbers until the real model is plugged in.</p>}
    </>
  );
}

/**
 * A number (or label) that explains itself. Renders a button: hover or keyboard focus shows the popover, a click or
 * tap pins it open, Esc closes it. `content` is called while the popover is open, so read signals inside it.
 */
export function Explain(props: { id?: string; content: () => ExplainContent; class?: string; label?: string; children: ComponentChildren }) {
  const ref = useRef<HTMLButtonElement>(null);
  const content = useRef(props.content);
  content.current = props.content;
  const get = useRef(() => content.current()).current;
  useEffect(() => {
    ensureLayer();
    return () => {
      if (explainOpen.value?.anchor === ref.current) closeExplain();
    };
  }, []);
  const st = explainOpen.value;
  const open = !!st && !!ref.current && st.anchor === ref.current;
  return (
    <button
      ref={ref}
      type="button"
      class={`xp-anchor${open ? ' xp-open' : ''}${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.id}
      aria-label={props.label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? 'fp-explain-pop' : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        const cur = explainOpen.value;
        clearTimeout(closeTimer);
        if (cur?.anchor === ref.current || cur?.pinned) return;
        clearTimeout(openTimer);
        // Hover intent: the pointer has to rest briefly, so crossing another number on the way doesn't switch.
        openTimer = setTimeout(() => ref.current && openExplain(ref.current, get, false), 140);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(openTimer);
        if (explainOpen.value?.anchor === ref.current) leaveAnchor(e);
      }}
      onFocus={() => {
        const el = ref.current;
        if (!el || returningFocus || !el.matches(':focus-visible') || explainOpen.value?.pinned) return;
        openExplain(el, get, false);
      }}
      onBlur={(e) => {
        const cur = explainOpen.value;
        if (!cur || cur.anchor !== ref.current) return;
        const to = e.relatedTarget as Node | null;
        if (to && popEl()?.contains(to)) return;
        // A pinned popover stays when focus just drops (a tap on plain text); it closes when focus moves to a control.
        if (cur.pinned && !to) return;
        closeExplain();
      }}
      onClick={(e) => {
        const cur = explainOpen.value;
        if (cur?.anchor === ref.current && cur.pinned) closeExplain();
        else if (ref.current) openExplain(ref.current, get, true, e.detail === 0);
      }}
    >
      {props.children}
    </button>
  );
}

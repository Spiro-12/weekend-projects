// Screen labels as plain DOM over the canvas (no draw calls): the hover label (name · type · state, desktop only)
// and up to 20 "DEADLOCK 0:42" labels. The overlay never takes pointer events.
const MAX_LABELS = 20;

const BASE = 'position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;font:600 12px/1.2 system-ui,-apple-system,sans-serif;'
  + 'padding:4px 8px;border-radius:8px;transform:translate(-50%,-100%);will-change:transform;';

export class Labels {
  readonly root: HTMLDivElement;
  private hover: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private shown = 0;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.setAttribute('data-testid', 'agent-labels');
    this.root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    container.appendChild(this.root);
    this.hover = document.createElement('div');
    this.hover.setAttribute('data-testid', 'agent-hover');
    this.hover.style.cssText = BASE + 'display:none;color:#e8edf4;background:rgba(15,18,24,.82);border:1px solid rgba(255,255,255,.12);font-weight:500;';
    this.root.appendChild(this.hover);
  }

  setHover(text: string | null, x = 0, y = 0) {
    if (text === null) {
      this.hover.style.display = 'none';
      return;
    }
    if (this.hover.textContent !== text) this.hover.textContent = text;
    this.hover.style.display = 'block';
    this.hover.style.transform = `translate(${Math.round(x)}px,${Math.round(y - 12)}px) translate(-50%,-100%)`;
  }

  /** Deadlock labels at screen positions (CSS px): the first `count` items (default all). At most 20 are shown. */
  setDeadlocks(items: { text: string; x: number; y: number }[], count = items.length) {
    const n = Math.min(MAX_LABELS, count);
    while (this.pool.length < n) {
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'deadlock-label');
      el.style.cssText = BASE + 'color:#fff;background:rgba(200,30,30,.88);border:1px solid rgba(255,140,140,.6);letter-spacing:.04em;box-shadow:0 0 14px rgba(255,50,50,.55);';
      this.root.appendChild(el);
      this.pool.push(el);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i];
      if (i < n) {
        const it = items[i];
        if (el.textContent !== it.text) el.textContent = it.text;
        el.style.display = 'block';
        el.style.transform = `translate(${Math.round(it.x)}px,${Math.round(it.y)}px) translate(-50%,-100%)`;
      } else el.style.display = 'none';
    }
    this.shown = n;
  }

  get deadlockLabels(): number {
    return this.shown;
  }

  dispose() {
    this.root.remove();
  }
}

/** "0:42" from seconds. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

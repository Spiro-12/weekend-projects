// Demo screen: the Recognize screen full screen, for filming. Only the sentence shows, and texts NEVER
// go out from it: the action rule (rule.ts) decides exactly as always, but when the predicted sentence's
// action is one that could message a person, the panel only asks the rule (decide) and never hands it a
// way to send (run). It shows what would have gone out instead. Pure helpers here, plus the alarm beep.
import { LOOSE_ACTIONS, MESSAGING_ACTIONS } from './rule';

/**
 * Does the demo screen hold this action back (never sends it)? Every action that messages a person, and,
 * to be safe, any action that isn't on the harmless allowlist (so one added later is held too).
 * The harmless ones (volume, music, calendar, the demo line) still run on the Mac when every gate passes.
 */
export function demoHolds(action: string | null | undefined): boolean {
  if (typeof action !== 'string' || action === '') return false; // no action: nothing to hold
  return MESSAGING_ACTIONS.includes(action) || !LOOSE_ACTIONS.includes(action);
}

/** The text bubble the demo screen shows instead of sending (help shows the red alert instead). */
const DEMO_TEXTS: Record<string, { to: string; text: string }> = {
  text_mom: { to: 'Mom', text: 'On my way!' },
  call_back: { to: 'Mom', text: 'Can’t talk now, call me back later' },
};

/** The bubble for a held action, or null when it has none (help: the alert is its moment). */
export function demoBubble(action: string): { to: string; text: string } | null {
  if (action === 'help') return null;
  return DEMO_TEXTS[action] ?? { to: 'Contact', text: 'A message' };
}

export const DEMO_NOT_SENT = 'Demo: not sent';
export const DEMO_NO_TEXT = 'Demo: no text sent';
export const DEMO_BUBBLE_MS = 5000;

/** About 1 s of alarm beeps (Web Audio, no files). Never throws. */
export function playAlarm(ctx: AudioContext | null): boolean {
  if (!ctx) return false;
  try {
    const t0 = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = 0.14;
    out.connect(ctx.destination);
    for (let i = 0; i < 4; i++) {
      const s = t0 + i * 0.25;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(i % 2 ? 660 : 880, s);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(1, s + 0.012);
      g.gain.setValueAtTime(1, s + 0.17);
      g.gain.linearRampToValueAtTime(0, s + 0.2);
      o.connect(g).connect(out);
      o.start(s);
      o.stop(s + 0.22);
    }
    return true;
  } catch (e) {
    console.warn('[result] alarm sound failed', e);
    return false;
  }
}

// Plain English words for the Recognize screen (7th grade, no jargon). Pure, no DOM, unit tested.
import type { SourceKind } from '../../core/app';
import type { ActionResultMsg } from '../../core/contracts';
import type { BlockReason } from './rule';

/** What each action does on the Mac (Track I). Unknown actions get a generic line. */
const ACTION_TEXT: Record<string, string> = {
  text_mom: 'Text Mom “I’m on my way”',
  volume_up: 'Turn the Mac’s volume up',
  call_back: 'Text back “Call me back later”',
  demo_48h: 'Say “I created this demo in 48 hours” out loud',
  help: 'Text your emergency contact for help',
  calendar: 'Read out today’s calendar',
  focus_music: 'Play focus music on Spotify',
};

export const describeAction = (action: string): string => ACTION_TEXT[action] ?? `Run “${action}”`;

/** Why the ghost chip says "Would" instead of doing it. */
export function ghostReason(reason: BlockReason, source: SourceKind | null): string {
  switch (reason) {
    case 'not-live':
      return source === 'replay' ? 'Replay, so just a preview'
        : source === 'fake' ? 'Fake data, so just a preview' : 'No Mac app connected, so just a preview';
    case 'not-connected': return 'The Mac app isn’t connected';
    case 'simulated': return 'The Mac app is in Simulate mode';
    case 'not-armed': return 'Safe mode: turn on Armed in the Mac app';
    case 'not-own-model': return 'Only your own model can run actions';
    case 'not-offered': return 'The Mac app can’t do this one yet';
    case 'unpaired': return 'Not paired with your Mac app';
    case 'busy': return 'Waiting for the Mac to answer';
    case 'too-soon': return 'Just did one. Wait 3 seconds';
    case 'not-recognize': return 'Recognize mode is off';
    case 'not-accepted': return 'Not sure what you said';
    case 'no-action': return 'This one doesn’t do anything';
  }
}

export const UNPAIRED_TEXT = "This dashboard isn't paired with your Mac app. Open it from the Mac app's link.";

export type ToastKind = 'ok' | 'dry' | 'bad' | 'unknown';
export interface ToastText { kind: ToastKind; title: string; body: string }

/** Errors that mean "we don't know if it ran" (live.ts). Never retried. */
export const OUTCOME_UNKNOWN = ['timeout', 'disconnected', 'stopped'];

/** The toast for an action's answer. */
export function toastFor(r: Pick<ActionResultMsg, 'action' | 'ok' | 'dryRun' | 'message' | 'error'>): ToastText {
  const what = describeAction(r.action);
  if (r.ok) {
    if (r.dryRun) return { kind: 'dry', title: 'Dry run', body: `Safe mode is on in the Mac app, so nothing happened. (${what})` };
    return { kind: 'ok', title: 'Done on your Mac', body: r.message || what };
  }
  const err = r.error ?? '';
  if (err === 'unpaired') return { kind: 'bad', title: 'Not paired', body: UNPAIRED_TEXT };
  if (OUTCOME_UNKNOWN.includes(err)) {
    return { kind: 'unknown', title: 'No answer from the Mac', body: 'It may have run anyway, so it won’t try again.' };
  }
  if (err === 'cooldown') return { kind: 'bad', title: 'Too soon', body: 'The Mac waits a bit between actions (30 s for texts). Try again in a moment.' };
  if (err === 'unknown_action') return { kind: 'bad', title: 'Not sent', body: 'The Mac app doesn’t know this action yet.' };
  if (err === 'not_connected') return { kind: 'bad', title: 'Not sent', body: 'Not connected to the Mac app, so nothing happened.' };
  return { kind: 'bad', title: 'It didn’t work', body: r.message || 'The Mac app said no.' };
}

/** "N recordings" with the right plural. */
export const recordings = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;

/** The sentence to show big for a class id (unknown ids show as is). */
export function sentenceOf(classes: { id: string; sentence: string }[], id: string): string {
  if (id === 'none') return 'Nothing (mouth still)';
  return classes.find((c) => c.id === id)?.sentence ?? id;
}

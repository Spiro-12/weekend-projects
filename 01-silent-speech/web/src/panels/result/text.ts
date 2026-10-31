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
    case 'unpaired': return 'Not paired. Open this page from the Mac app’s link';
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

/**
 * Plain English for the Mac app's error codes (PROTOCOL §2, live.ts and Track I's ActionRunner). The codes
 * themselves, and the Mac's raw messages (they can name action ids), are never shown for these.
 */
const ERROR_TEXT: Record<string, [title: string, body: string]> = {
  cooldown: ['Too soon', 'The Mac waits a bit between actions (30 seconds for texts). Try again in a moment.'],
  busy: ['One moment', 'Your Mac is still doing the last one. Try again in a moment.'],
  unknown_action: ['Not sent', 'The Mac app doesn’t know how to do this one yet.'],
  not_connected: ['Not sent', 'Not connected to the Mac app, so nothing happened.'],
  send_failed: ['Not sent', 'Couldn’t reach the Mac app, so nothing happened.'],
  duplicate_id: ['Not sent', 'That one was already on its way, so it wasn’t sent twice.'],
  bad_json: ['Not sent', 'The Mac app didn’t understand the request, so nothing happened.'],
  no_contact: ['No contact set', 'The Mac app doesn’t have anyone to text for this yet, so nothing was sent.'],
  bad_contact: ['Contact problem', 'The phone number saved for this doesn’t look right, so nothing was sent.'],
  no_spotify: ['Spotify is missing', 'Spotify isn’t installed on this Mac, so no music played.'],
  bad_uri: ['Music link problem', 'The playlist saved for this doesn’t work, so no music played.'],
  script_failed: ['It didn’t work', 'Your Mac tried but couldn’t do it. It may need permission in System Settings › Privacy & Security › Automation.'],
};

/** The toast for an action's answer. */
export function toastFor(r: Pick<ActionResultMsg, 'action' | 'ok' | 'dryRun' | 'message' | 'error'>): ToastText {
  const what = describeAction(r.action);
  if (r.ok) {
    if (r.dryRun) return { kind: 'dry', title: 'Dry run', body: `Safe mode is on in the Mac app, so nothing happened. (${what})` };
    // Long actions (calendar) answer "Working on it" right away and finish in the background.
    if (/working on it/i.test(r.message)) return { kind: 'ok', title: 'Your Mac is on it', body: what };
    return { kind: 'ok', title: 'Done on your Mac', body: r.message || what };
  }
  const err = r.error ?? '';
  if (err === 'unpaired') return { kind: 'bad', title: 'Not paired', body: UNPAIRED_TEXT };
  if (OUTCOME_UNKNOWN.includes(err)) {
    return { kind: 'unknown', title: 'No answer from the Mac', body: 'It may have run anyway, so it won’t try again.' };
  }
  const known = ERROR_TEXT[err];
  if (known) return { kind: 'bad', title: known[0], body: known[1] };
  return { kind: 'bad', title: 'It didn’t work', body: r.message || 'The Mac app couldn’t do it.' };
}

/** "N recordings" with the right plural. */
export const recordings = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;

/** The sentence to show big for a class id (unknown ids show as is). */
export function sentenceOf(classes: { id: string; sentence: string }[], id: string): string {
  if (id === 'none') return 'Nothing (mouth still)';
  return classes.find((c) => c.id === id)?.sentence ?? id;
}

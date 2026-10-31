// Generates shared/fixtures/* from the seeded synth. Run: npm run gen
import { writeFileSync, mkdirSync } from 'node:fs';
import classesJson from '../shared/classes.json' with { type: 'json' };
import type { ActionRequestMsg, ActionResultMsg, ClassDef, ErrorMsg, MotionMsg, ServerMsg } from '../web/src/core/contracts';
import { MotionSynth, fakeHello, fakeStatus, synthDataset, synthSession } from '../web/src/core/synth';

const classes = classesJson as ClassDef[];
const out = new URL('../shared/fixtures/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name: string, data: string) => { writeFileSync(new URL(name, out), data); console.log('wrote', name, `${(data.length / 1024).toFixed(0)} KB`); };

// One of every WebSocket message, both directions.
const actions = classes.filter((c) => c.action).map((c) => c.action as string);
const synth = new MotionSynth(1);
synth.utter(classes[0], 0.2);
const motion: MotionMsg[] = synth.range(0, 0.2).map((s) => ({ type: 'motion', ...s }));
const msgs: (ServerMsg | ActionRequestMsg)[] = [
  fakeHello(actions, false),
  fakeStatus({ simulated: false }),
  ...motion,
  { type: 'action', id: 'act-1', action: 'volume_up', label: 'volume_up', confidence: 0.91, token: '0123456789abcdef0123456789abcdef' } satisfies ActionRequestMsg,
  { type: 'actionResult', id: 'act-1', action: 'volume_up', ok: true, dryRun: true, message: 'Dry run: volume_up', ms: 3 } satisfies ActionResultMsg,
  { type: 'error', code: 'cooldown', message: 'too soon', id: 'act-2' } satisfies ErrorMsg,
  { type: 'error', code: 'unpaired', message: 'wrong or missing pairing token', id: 'act-3' } satisfies ErrorMsg,
];
write('ws-messages.jsonl', msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');

const tiny = synthDataset({ classes: classes.filter((c) => ['text_mom', 'volume_up', 'none'].includes(c.id)), reps: 2, sessions: 1, seed: 11 });
write('dataset.tiny.json', JSON.stringify(tiny));
write('dataset.synthetic.json', JSON.stringify(synthDataset({ classes, reps: 5, sessions: 3, seed: 12, dropRate: 0.02 })));
write('session.synthetic.json', JSON.stringify(synthSession(classes, 13)));

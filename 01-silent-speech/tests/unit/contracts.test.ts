import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import classes from '../../shared/classes.json';
import { parseClientMsg, parseServerFrame, parseServerMsg, validateDataset, validateSession } from '../../web/src/core/validate';

const fx = (name: string) => readFileSync(new URL(`../../shared/fixtures/${name}`, import.meta.url), 'utf8');

describe('fixtures follow the contracts', () => {
  it('every ws message parses as a server or client message', () => {
    const lines = fx('ws-messages.jsonl').trim().split('\n');
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(parseServerMsg(l) ?? parseClientMsg(l), l).not.toBeNull();
    const types = new Set(lines.map((l) => JSON.parse(l).type));
    expect([...types].sort()).toEqual(['action', 'actionResult', 'error', 'hello', 'motion', 'status']);
  });

  it('datasets validate', () => {
    for (const f of ['dataset.tiny.json', 'dataset.synthetic.json']) expect(validateDataset(JSON.parse(fx(f))), f).toEqual([]);
  });

  it('session validates', () => {
    expect(validateSession(JSON.parse(fx('session.synthetic.json')))).toEqual([]);
  });

  it('classes.json has unique ids and a none class', () => {
    const ids = classes.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('none');
  });
});

describe('validators reject junk', () => {
  it('bad motion', () => {
    expect(parseServerMsg('{"type":"motion","seq":"oops"}')).toBeNull();
    expect(parseServerMsg('not json')).toBeNull();
    expect(parseServerMsg({ type: 'whatever' })).toBeNull();
  });
  it('frames: unknown types are ignored, broken ones are invalid', () => {
    expect(parseServerFrame('{"type":"future_thing"}')).toEqual({ kind: 'unknown', type: 'future_thing' });
    expect(parseServerFrame('{"type":"motion","seq":"oops"}')).toEqual({ kind: 'invalid' });
    expect(parseServerFrame('nope')).toEqual({ kind: 'invalid' });
    expect(parseServerFrame(JSON.stringify({ type: 'error', code: 'cooldown', message: 'x' })).kind).toBe('msg');
  });
  it('bad dataset', () => {
    expect(validateDataset({ format: 'ss-dataset' }).length).toBeGreaterThan(0);
    const ds = JSON.parse(fx('dataset.tiny.json'));
    ds.clips[0].label = 'nope';
    expect(validateDataset(ds).join()).toMatch(/unknown label/);
  });
});

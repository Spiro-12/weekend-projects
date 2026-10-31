import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import classesJson from '../../shared/classes.json';
import type { ClassDef, Dataset, DatasetClip } from '../../web/src/core/contracts';
import { synthClip } from '../../web/src/core/synth';
import { validateDataset } from '../../web/src/core/validate';
import {
  MemoryClipStore, PersistentClipStore, aggregateMeta, createStore, memoryBackend,
  type ClipBackend, type ClipMeta, type DatasetMeta, type StoredClip,
} from '../../web/src/store';

const classes = classesJson as ClassDef[];
const cls = (id: string) => classes.find((c) => c.id === id)!;
const tiny = JSON.parse(readFileSync(new URL('../../shared/fixtures/dataset.tiny.json', import.meta.url), 'utf8')) as Dataset;

let n = 0;
function clip(label: string, session = 's1', o: Partial<DatasetClip> = {}): DatasetClip {
  const i = n++;
  const c = synthClip(cls(label), 1000 + i, { session, rep: i, id: `${session}-${label}-${i}` });
  return { ...c, startedAt: new Date(Date.UTC(2026, 9, 31, 12, 0, i)).toISOString(), ...o };
}
const meta = (session = 's1'): DatasetMeta => ({
  session, subject: 'spiro', source: 'fake', device: { model: 'AirPods Pro 3', loc: 'left' }, hz: 25, classes,
});

describe('MemoryClipStore', () => {
  it('adds, removes, clears and notifies', () => {
    const s = new MemoryClipStore();
    const fn = vi.fn();
    const off = s.onChange(fn);
    const a = clip('text_mom'), b = clip('volume_up'), c = clip('none');
    s.add(a); s.add(b); s.add(c);
    expect(s.all().map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    s.remove(b.id);
    expect(s.all().map((x) => x.id)).toEqual([a.id, c.id]);
    s.removeMany([a.id, 'nope']);
    expect(s.all().map((x) => x.id)).toEqual([c.id]);
    s.clear();
    expect(s.all()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(6);
    s.remove('nope'); // nothing removed: no event
    expect(fn).toHaveBeenCalledTimes(6);
    off();
    s.add(a);
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('adding the same id twice replaces instead of duplicating', () => {
    const s = new MemoryClipStore();
    const a = clip('help');
    s.add(a);
    s.add({ ...a, rep: 9 });
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].rep).toBe(9);
  });

  it('all() is a copy', () => {
    const s = new MemoryClipStore();
    s.add(clip('help'));
    s.all().pop();
    expect(s.all()).toHaveLength(1);
  });

  it('load dedupes by clip id, also inside one file, and fills in the session', () => {
    const s = new MemoryClipStore();
    expect(s.load(tiny)).toBe(6);
    expect(s.load(tiny)).toBe(0); // importing the same file twice adds nothing
    expect(s.all()).toHaveLength(6);
    const noSession = { ...tiny, session: 'imported', clips: [{ ...tiny.clips[0], id: 'x1', session: undefined }, { ...tiny.clips[0], id: 'x1', session: undefined }] };
    expect(s.load(noSession)).toBe(1);
    expect(s.all().find((c) => c.id === 'x1')!.session).toBe('imported');
  });

  it('toDataset → validateDataset is clean, and round trips through load', () => {
    const s = new MemoryClipStore();
    for (const l of ['text_mom', 'volume_up', 'none', 'text_mom']) s.add(clip(l, 's1'));
    s.add(clip('help', 's2'));
    const ds = s.toDataset(meta('s1'), (c) => c.session === 's1');
    expect(validateDataset(ds)).toEqual([]);
    expect(ds).toMatchObject({ format: 'ss-dataset', v: 1, session: 's1', source: 'fake', hz: 25, device: { model: 'AirPods Pro 3', loc: 'left' } });
    expect(ds.clips.map((c) => c.label)).toEqual(['text_mom', 'volume_up', 'none', 'text_mom']);
    expect(ds.classes).toEqual(classes);
    expect(new Date(ds.createdAt).toString()).not.toBe('Invalid Date');

    const json = JSON.parse(JSON.stringify(ds)) as Dataset;
    const t = new MemoryClipStore();
    expect(t.load(json)).toBe(4);
    expect(t.all()).toEqual(s.all().filter((c) => c.session === 's1'));
    expect(validateDataset(t.toDataset(meta('s1')))).toEqual([]);
  });

  it('toDataset without a filter exports every clip; clips without a session get the file session', () => {
    const s = new MemoryClipStore();
    s.add(clip('help', 's1'));
    s.add({ ...clip('none', 's2'), session: undefined });
    const ds = s.toDataset({ ...meta('s9'), createdAt: '2026-10-31T00:00:00.000Z' });
    expect(ds.createdAt).toBe('2026-10-31T00:00:00.000Z');
    expect(ds.clips.map((c) => c.session)).toEqual(['s1', 's9']);
    expect(validateDataset(ds)).toEqual([]);
  });

  it('is memory only and ready right away', async () => {
    const s = new MemoryClipStore();
    await expect(s.ready).resolves.toBeUndefined();
    await expect(s.flush()).resolves.toBeUndefined();
    expect(s.health()).toEqual({ kind: 'memory', error: null });
  });
});

describe('PersistentClipStore', () => {
  it('persists add/remove/clear and restores them in a new store (page reload)', async () => {
    const disk = new Map<string, StoredClip>();
    const a = new PersistentClipStore(memoryBackend(disk));
    await a.ready;
    const c1 = clip('text_mom'), c2 = clip('volume_up'), c3 = clip('none');
    a.add(c1); a.add(c2); a.add(c3);
    a.remove(c2.id);
    await a.flush();
    expect([...disk.keys()].sort()).toEqual([c1.id, c3.id].sort());

    const b = new PersistentClipStore(memoryBackend(disk));
    const fn = vi.fn();
    b.onChange(fn);
    await b.ready;
    expect(b.all()).toEqual([c1, c3]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.health()).toEqual({ kind: 'indexeddb', error: null });

    b.load(tiny);
    await b.flush();
    expect(disk.size).toBe(8);
    b.clear();
    await b.flush();
    expect(disk.size).toBe(0);
  });

  it('restores in recording order (startedAt), whatever order the backend returns', async () => {
    const disk = new Map<string, StoredClip>();
    const late = clip('help', 's1', { id: 'a-late', startedAt: '2026-10-31T12:00:09.000Z' });
    const early = clip('none', 's1', { id: 'z-early', startedAt: '2026-10-31T12:00:01.000Z' });
    disk.set(late.id, { clip: late });
    disk.set(early.id, { clip: early });
    const s = new PersistentClipStore(memoryBackend(disk));
    await s.ready;
    expect(s.all().map((c) => c.id)).toEqual(['z-early', 'a-late']);
  });

  it('clips added or removed while restoring are kept / stay removed', async () => {
    const disk = new Map<string, StoredClip>();
    const old1 = clip('text_mom'), old2 = clip('volume_up');
    disk.set(old1.id, { clip: old1 });
    disk.set(old2.id, { clip: old2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = memoryBackend(disk);
    const slow: ClipBackend = { ...inner, getAll: async () => { await gate; return inner.getAll(); } };
    const s = new PersistentClipStore(slow);
    const fresh = clip('help');
    s.add(fresh); // before the restore finished
    s.remove(old2.id);
    release();
    await s.ready;
    await s.flush();
    expect(s.all().map((c) => c.id).sort()).toEqual([old1.id, fresh.id].sort());
    expect([...disk.keys()].sort()).toEqual([old1.id, fresh.id].sort());
  });

  it('clear while restoring wins over the saved clips', async () => {
    const disk = new Map<string, StoredClip>();
    const old = clip('text_mom');
    disk.set(old.id, { clip: old });
    const s = new PersistentClipStore(memoryBackend(disk));
    s.clear();
    await s.ready;
    await s.flush();
    expect(s.all()).toEqual([]);
    expect(disk.size).toBe(0);
  });

  it('a failing backend keeps working in memory and reports the problem', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: ClipBackend = {
      getAll: async () => { throw new Error('no IndexedDB'); },
      put: async () => { throw new Error('quota exceeded'); },
      delete: async () => {},
      clear: async () => {},
    };
    const s = new PersistentClipStore(broken);
    await s.ready; // never rejects
    expect(s.health().error).toMatch(/restore failed: no IndexedDB/);
    const fn = vi.fn();
    s.onChange(fn);
    s.add(clip('help'));
    await s.flush();
    expect(s.all()).toHaveLength(1);
    expect(s.health()).toEqual({ kind: 'indexeddb', error: 'save failed: quota exceeded' });
    expect(fn).toHaveBeenCalledTimes(2); // the add, then the error
    err.mockRestore();
  });

  it('writes reach the backend in order (add then remove of the same clip)', async () => {
    const disk = new Map<string, StoredClip>();
    const s = new PersistentClipStore(memoryBackend(disk));
    const c = clip('none');
    s.add(c);
    s.remove(c.id);
    s.add(c);
    await s.flush();
    expect([...disk.keys()]).toEqual([c.id]);
  });
});

const AIR: ClipMeta = { source: 'airpods', subject: 'spiro', device: { model: 'AirPods Pro 3', loc: 'right' }, hz: 50 };
const FAKE: ClipMeta = { source: 'fake', subject: 'spiro', device: { model: 'AirPods Pro 3', loc: 'left' }, hz: 25 };

describe('per clip meta (source, subject, device, hz saved at record time)', () => {
  it('is saved with the clip, restored after a reload, and dropped with it', async () => {
    const disk = new Map<string, StoredClip>();
    const a = new PersistentClipStore(memoryBackend(disk));
    const c1 = clip('help', 's1'), c2 = clip('none', 's1');
    a.add(c1, AIR); a.add(c2, AIR);
    await a.flush();
    expect(disk.get(c1.id)).toEqual({ clip: c1, meta: AIR });
    const b = new PersistentClipStore(memoryBackend(disk));
    await b.ready;
    expect(b.meta(c1.id)).toEqual(AIR);
    expect(b.sessionMeta('s1')).toEqual({ source: 'airpods', subject: 'spiro', device: { model: 'AirPods Pro 3', loc: 'right' }, hz: 50 });
    b.remove(c1.id);
    expect(b.meta(c1.id)).toBeUndefined();
    expect(b.sessionMeta('nope')).toBeNull();
  });

  it('import takes the meta from the file header', () => {
    const s = new MemoryClipStore();
    s.load(tiny);
    expect(s.meta(tiny.clips[0].id)).toEqual({ source: 'fake', subject: 'synthetic', device: tiny.device, hz: 25 });
  });

  it('export aggregates it into the header and keeps it out of the clips', () => {
    const s = new MemoryClipStore();
    s.add(clip('help', 's1'), AIR);
    s.add(clip('none', 's1'), { ...AIR, hz: 48 });
    s.add(clip('text_mom', 's1'), { ...AIR, hz: 50 });
    const ds = s.toDataset({ session: 's1', classes, ...s.sessionMeta('s1')! }, (c) => c.session === 's1');
    expect(ds).toMatchObject({ source: 'airpods', subject: 'spiro', device: { loc: 'right' }, hz: 50 });
    expect(ds.clips.every((c) => !('meta' in c))).toBe(true);
    expect(validateDataset(ds)).toEqual([]);
  });

  it('a session is real AirPods data only if every clip is', () => {
    expect(aggregateMeta([AIR, AIR])!.source).toBe('airpods');
    expect(aggregateMeta([AIR, FAKE])!.source).toBe('fake');
    expect(aggregateMeta([AIR, undefined])!.source).toBe('fake');
    expect(aggregateMeta([undefined])!).toMatchObject({ source: 'fake', subject: 'unknown' });
    expect(aggregateMeta([])).toBeNull();
    expect(aggregateMeta([FAKE, AIR, AIR])!.device.loc).toBe('right'); // most common
  });

  it('restores records saved before meta existed (bare clips)', async () => {
    const disk = new Map<string, StoredClip>();
    const c = clip('help', 's1');
    disk.set(c.id, { clip: c });
    const s = new PersistentClipStore(memoryBackend(disk));
    await s.ready;
    expect(s.all()).toEqual([c]);
    expect(s.sessionMeta('s1')!.source).toBe('fake');
  });
});

describe('IndexedDB that never answers (round 2, finding 6)', () => {
  it('falls back to memory only after the timeout instead of loading forever', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writes: string[] = [];
    const stuck: ClipBackend = {
      getAll: () => new Promise(() => {}), // never answers
      put: async (rs) => { writes.push(...rs.map((r) => r.clip.id)); },
      delete: async () => {},
      clear: async () => {},
    };
    const s = new PersistentClipStore(stuck, 'indexeddb', 30);
    const early = clip('help');
    s.add(early); // before the timeout
    await s.ready;
    expect(s.health()).toMatchObject({ kind: 'memory', error: null, fallback: expect.stringContaining('did not answer') });
    s.add(clip('none'));
    await s.flush(); // doesn't hang
    expect(s.all()).toHaveLength(2);
    expect(writes).toEqual([]); // nothing is written to the stuck backend
    err.mockRestore();
  });
  it('a slow but working backend is not affected', async () => {
    const disk = new Map<string, StoredClip>();
    const inner = memoryBackend(disk);
    const s = new PersistentClipStore({ ...inner, getAll: async () => { await new Promise((r) => setTimeout(r, 10)); return inner.getAll(); } }, 'indexeddb', 200);
    await s.ready;
    s.add(clip('help'));
    await s.flush();
    expect(s.health()).toMatchObject({ kind: 'indexeddb', error: null });
    expect(disk.size).toBe(1);
  });
});

describe('createStore', () => {
  it('falls back to memory without IndexedDB (node)', async () => {
    const s = createStore();
    await s.ready;
    expect(s.health().kind).toBe('memory');
    s.add(clip('help'));
    expect(s.all()).toHaveLength(1);
  });
});

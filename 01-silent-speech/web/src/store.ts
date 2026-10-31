// Clip store: every recorded clip, autosaved to IndexedDB (one record per clip) and restored on load.
// Not localStorage: that is shared by every site on spiro-12.github.io and only holds ~5 MB.
// Without IndexedDB (unit tests in node, very locked down browsers) it keeps clips in memory only.
//
// Each clip also keeps where it came from (ClipMeta: source, subject, device, input rate), decided
// when it was recorded or imported, never at export time. Exports aggregate it per session.
import type { Dataset, DatasetClip } from './core/contracts';

/** Everything in a Dataset file except the clips. `createdAt` defaults to now. */
export type DatasetMeta = Omit<Dataset, 'format' | 'v' | 'createdAt' | 'clips'> & { createdAt?: string };

/** Where one clip came from. Saved with the clip; not part of the exported clip. */
export interface ClipMeta {
  source: Dataset['source'];
  subject: string;
  device: Dataset['device'];
  hz: number; // measured input rate
}

/** The per session part of a Dataset header, aggregated from its clips' ClipMeta. */
export type SessionMeta = Pick<Dataset, 'source' | 'subject' | 'device' | 'hz'>;

export interface StoreHealth {
  kind: 'indexeddb' | 'memory'; // where clips are kept
  error: string | null; // last save or restore problem (sticky: some clips may be unsaved)
}

export interface ClipStore {
  all(): DatasetClip[];
  /** Adds a clip (a clip with the same id is replaced). */
  add(c: DatasetClip, meta?: ClipMeta): void;
  remove(id: string): void;
  clear(): void;
  onChange(fn: () => void): () => void;
  /** Imports a dataset file. Dedupes by clip `id` (importing the same file twice adds nothing). Returns how many clips were new. */
  load(ds: Dataset): number;
  /** Resolves once saved clips are restored (right away for the memory store). Never rejects. */
  readonly ready: Promise<void>;
  /** Resolves when every write so far has finished or failed (check health() after). Never rejects. */
  flush(): Promise<void>;
  removeMany(ids: string[]): void;
  meta(id: string): ClipMeta | undefined;
  /** Source / subject / device / hz of a session, aggregated from its clips (null if it has none). */
  sessionMeta(session: string): SessionMeta | null;
  /** Builds an `ss-dataset` v1 file from the stored clips, optionally only those matching `filter`. */
  toDataset(meta: DatasetMeta, filter?: (c: DatasetClip) => boolean): Dataset;
  health(): StoreHealth;
}

/** Oldest first; ties broken by id so the order is stable after a restore. */
const byTime = (a: DatasetClip, b: DatasetClip) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const mostCommon = <T>(xs: T[]): T => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0][0];
};

/** Aggregates clip metas into a session header. Real AirPods only if every clip is. Unknown meta counts as fake. */
export function aggregateMeta(metas: (ClipMeta | undefined)[]): SessionMeta | null {
  if (!metas.length) return null;
  const known = metas.filter((m): m is ClipMeta => !!m);
  const source = known.length === metas.length && known.every((m) => m.source === 'airpods') ? 'airpods' : 'fake';
  if (!known.length) return { source, subject: 'unknown', device: { model: 'unknown', loc: 'unknown' }, hz: 25 };
  const hz = known.map((m) => m.hz).sort((a, b) => a - b);
  const mid = hz.length >> 1;
  return {
    source,
    subject: mostCommon(known.map((m) => m.subject)),
    device: { model: mostCommon(known.map((m) => m.device.model)), loc: mostCommon(known.map((m) => m.device.loc)) },
    hz: Math.round(hz.length % 2 ? hz[mid] : (hz[mid - 1] + hz[mid]) / 2),
  };
}

/** One saved record. */
export interface StoredClip { clip: DatasetClip; meta?: ClipMeta }

export class MemoryClipStore implements ClipStore {
  protected clips: DatasetClip[] = [];
  protected metas = new Map<string, ClipMeta>();
  protected kind: StoreHealth['kind'] = 'memory';
  protected error: string | null = null;
  ready: Promise<void> = Promise.resolve();
  private fns = new Set<() => void>();

  all() { return this.clips.slice(); }
  add(c: DatasetClip, meta?: ClipMeta) { this.put([{ clip: c, meta }]); this.changed(); }
  remove(id: string) { this.removeMany([id]); }
  removeMany(ids: string[]) {
    const drop = new Set(ids);
    const gone = this.clips.filter((c) => drop.has(c.id)).map((c) => c.id);
    if (!gone.length) return;
    this.clips = this.clips.filter((c) => !drop.has(c.id));
    for (const id of gone) this.metas.delete(id);
    this.persistDelete(gone);
    this.changed();
  }
  clear() { this.clips = []; this.metas.clear(); this.persistClear(); this.changed(); }
  flush(): Promise<void> { return Promise.resolve(); }
  meta(id: string) { return this.metas.get(id); }
  sessionMeta(session: string): SessionMeta | null {
    return aggregateMeta(this.clips.filter((c) => c.session === session).map((c) => this.metas.get(c.id)));
  }

  load(ds: Dataset): number {
    const have = new Set(this.clips.map((c) => c.id));
    const meta: ClipMeta = { source: ds.source, subject: ds.subject, device: { ...ds.device }, hz: ds.hz };
    const fresh: StoredClip[] = [];
    for (const c of ds.clips) {
      if (have.has(c.id)) continue; // also dedupes repeats inside one file
      have.add(c.id);
      fresh.push({ clip: { ...c, session: c.session ?? ds.session }, meta });
    }
    if (fresh.length) { this.put(fresh); this.changed(); }
    return fresh.length;
  }

  toDataset(meta: DatasetMeta, filter: (c: DatasetClip) => boolean = () => true): Dataset {
    return {
      format: 'ss-dataset',
      v: 1,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      session: meta.session,
      subject: meta.subject,
      source: meta.source,
      device: { ...meta.device },
      hz: meta.hz,
      classes: meta.classes.map((c) => ({ ...c })),
      clips: this.clips.filter(filter).map((c) => ({ ...c, session: c.session ?? meta.session })),
    };
  }

  health(): StoreHealth { return { kind: this.kind, error: this.error }; }
  onChange(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  protected changed() { for (const f of this.fns) f(); }

  /** Adds or replaces (same id) in memory, then persists. */
  protected put(rs: StoredClip[]) {
    const at = new Map(this.clips.map((c, i) => [c.id, i]));
    for (const { clip, meta } of rs) {
      const i = at.get(clip.id);
      if (i === undefined) { at.set(clip.id, this.clips.length); this.clips.push(clip); } else this.clips[i] = clip;
      if (meta) this.metas.set(clip.id, meta); else this.metas.delete(clip.id);
    }
    this.persistPut(rs);
  }
  // Memory only: nothing to persist.
  protected persistPut(rs: StoredClip[]) { void rs; }
  protected persistDelete(ids: string[]) { void ids; }
  protected persistClear() {}
}

/** Where a PersistentClipStore keeps clips. IndexedDB in the browser, a Map in tests. */
export interface ClipBackend {
  getAll(): Promise<StoredClip[]>;
  put(rs: StoredClip[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Memory first (every call is synchronous, like MemoryClipStore), then written to the backend in
 * order. Saved clips are restored on start and merged with anything added in the meantime.
 */
export class PersistentClipStore extends MemoryClipStore {
  private backend: ClipBackend;
  private queue: Promise<void>;
  private restoring = true;
  private touched = new Set<string>(); // ids added or removed before the restore finished: memory wins
  private clearedEarly = false;

  constructor(backend: ClipBackend, kind: StoreHealth['kind'] = 'indexeddb') {
    super();
    this.backend = backend;
    this.kind = kind;
    this.queue = backend.getAll().then(
      (saved) => {
        this.restoring = false;
        if (this.clearedEarly) return;
        const extra = saved.filter((r) => !this.touched.has(r.clip.id));
        if (!extra.length) return;
        for (const r of extra) if (r.meta) this.metas.set(r.clip.id, r.meta);
        this.clips = [...extra.map((r) => r.clip), ...this.clips].sort(byTime);
        this.changed();
      },
      (e) => { this.restoring = false; this.fail('restore', e); },
    );
    this.ready = this.queue;
  }

  flush(): Promise<void> { return this.queue; }

  removeMany(ids: string[]) {
    if (this.restoring) { // saved but not restored yet: make sure it stays gone
      const have = new Set(this.clips.map((c) => c.id));
      const unseen = ids.filter((id) => !have.has(id) && !this.touched.has(id));
      if (unseen.length) {
        unseen.forEach((id) => this.touched.add(id));
        this.enqueue('delete', () => this.backend.delete(unseen));
      }
    }
    super.removeMany(ids);
  }

  protected persistPut(rs: StoredClip[]) {
    if (this.restoring) rs.forEach((r) => this.touched.add(r.clip.id));
    this.enqueue('save', () => this.backend.put(rs));
  }
  protected persistDelete(ids: string[]) {
    if (this.restoring) ids.forEach((id) => this.touched.add(id));
    this.enqueue('delete', () => this.backend.delete(ids));
  }
  protected persistClear() {
    if (this.restoring) this.clearedEarly = true;
    this.enqueue('clear', () => this.backend.clear());
  }

  private enqueue(what: string, op: () => Promise<void>) {
    this.queue = this.queue.then(op).catch((e) => this.fail(what, e));
  }

  private fail(what: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[store] ${what} failed`, e);
    this.error = `${what} failed: ${msg}`;
    this.changed();
  }
}

/** Map backed ClipBackend (tests). Pass the same map to two stores to simulate a page reload. */
export function memoryBackend(map = new Map<string, StoredClip>()): ClipBackend {
  const copy = <T>(x: T): T => structuredClone(x);
  return {
    getAll: async () => [...map.values()].map(copy),
    put: async (rs) => { for (const r of rs) map.set(r.clip.id, copy(r)); },
    delete: async (ids) => { for (const id of ids) map.delete(id); },
    clear: async () => { map.clear(); },
  };
}

const DB_NAME = 'silent-speech';
const DB_VERSION = 1;
const CLIPS = 'clips';

/** IDB record: `{ id, clip, meta }` keyed by clip id. */
interface IdbRecord { id: string; clip: DatasetClip; meta?: ClipMeta }
const fromRecord = (r: IdbRecord | DatasetClip): StoredClip =>
  'clip' in r && r.clip ? { clip: r.clip, meta: r.meta } : { clip: r as DatasetClip }; // a bare clip: early dev format

/** IndexedDB backend: database `silent-speech`, object store `clips` keyed by clip `id`. */
export function idbBackend(idb: IDBFactory, name = DB_NAME): ClipBackend {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(CLIPS)) r.result.createObjectStore(CLIPS, { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbp = null; }; // a newer version in another tab: let it upgrade, reopen later
      db.onclose = () => { dbp = null; }; // closed by the browser: reopen next time
      res(db);
    };
    r.onblocked = () => { dbp = null; rej(new Error('another tab with this page is blocking the database; close it')); };
    r.onerror = () => { dbp = null; rej(r.error ?? new Error('could not open IndexedDB')); };
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open();
    return new Promise<T | undefined>((res, rej) => {
      const tx = db.transaction(CLIPS, mode);
      const req = fn(tx.objectStore(CLIPS));
      tx.oncomplete = () => res(req ? req.result : undefined);
      tx.onerror = () => rej(tx.error ?? new Error('IndexedDB error'));
      tx.onabort = () => rej(tx.error ?? new Error('IndexedDB write aborted'));
    });
  };
  return {
    getAll: async () => ((await run<(IdbRecord | DatasetClip)[]>('readonly', (s) => s.getAll())) ?? []).map(fromRecord),
    put: async (rs) => {
      await run('readwrite', (s) => { for (const r of rs) s.put({ id: r.clip.id, clip: r.clip, meta: r.meta } satisfies IdbRecord); });
    },
    delete: async (ids) => { await run('readwrite', (s) => { for (const id of ids) s.delete(id); }); },
    clear: async () => { await run('readwrite', (s) => { s.clear(); }); },
  };
}

export function createStore(): ClipStore {
  let idb: IDBFactory | undefined;
  try { idb = globalThis.indexedDB; } catch { idb = undefined; } // can throw in sandboxed frames
  return idb ? new PersistentClipStore(idbBackend(idb)) : new MemoryClipStore();
}

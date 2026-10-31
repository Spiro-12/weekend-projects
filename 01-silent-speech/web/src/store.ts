// Clip store: every recorded clip, autosaved to IndexedDB (one record per clip) and restored on load.
// Not localStorage: that is shared by every site on spiro-12.github.io and only holds ~5 MB.
// Without IndexedDB (unit tests in node, very locked down browsers) it keeps clips in memory only.
import type { Dataset, DatasetClip } from './core/contracts';

/** Everything in a Dataset file except the clips. `createdAt` defaults to now. */
export type DatasetMeta = Omit<Dataset, 'format' | 'v' | 'createdAt' | 'clips'> & { createdAt?: string };

export interface StoreHealth {
  kind: 'indexeddb' | 'memory'; // where clips are kept
  error: string | null; // last save or restore problem (sticky: some clips may be unsaved)
}

export interface ClipStore {
  all(): DatasetClip[];
  /** Adds a clip (a clip with the same id is replaced). */
  add(c: DatasetClip): void;
  remove(id: string): void;
  clear(): void;
  onChange(fn: () => void): () => void;
  /** Imports a dataset file. Dedupes by clip `id` (importing the same file twice adds nothing). Returns how many clips were new. */
  load(ds: Dataset): number;
  /** Resolves once saved clips are restored (right away for the memory store). Never rejects. */
  readonly ready: Promise<void>;
  removeMany(ids: string[]): void;
  /** Builds an `ss-dataset` v1 file from the stored clips, optionally only those matching `filter`. */
  toDataset(meta: DatasetMeta, filter?: (c: DatasetClip) => boolean): Dataset;
  health(): StoreHealth;
}

/** Oldest first; ties broken by id so the order is stable after a restore. */
const byTime = (a: DatasetClip, b: DatasetClip) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export class MemoryClipStore implements ClipStore {
  protected clips: DatasetClip[] = [];
  protected kind: StoreHealth['kind'] = 'memory';
  protected error: string | null = null;
  ready: Promise<void> = Promise.resolve();
  private fns = new Set<() => void>();

  all() { return this.clips.slice(); }
  add(c: DatasetClip) { this.put([c]); this.changed(); }
  remove(id: string) { this.removeMany([id]); }
  removeMany(ids: string[]) {
    const drop = new Set(ids);
    const gone = this.clips.filter((c) => drop.has(c.id)).map((c) => c.id);
    if (!gone.length) return;
    this.clips = this.clips.filter((c) => !drop.has(c.id));
    this.persistDelete(gone);
    this.changed();
  }
  clear() { this.clips = []; this.persistClear(); this.changed(); }

  load(ds: Dataset): number {
    const have = new Set(this.clips.map((c) => c.id));
    const fresh: DatasetClip[] = [];
    for (const c of ds.clips) {
      if (have.has(c.id)) continue; // also dedupes repeats inside one file
      have.add(c.id);
      fresh.push({ ...c, session: c.session ?? ds.session });
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
  protected put(cs: DatasetClip[]) {
    const at = new Map(this.clips.map((c, i) => [c.id, i]));
    for (const c of cs) {
      const i = at.get(c.id);
      if (i === undefined) { at.set(c.id, this.clips.length); this.clips.push(c); } else this.clips[i] = c;
    }
    this.persistPut(cs);
  }
  // Memory only: nothing to persist.
  protected persistPut(cs: DatasetClip[]) { void cs; }
  protected persistDelete(ids: string[]) { void ids; }
  protected persistClear() {}
}

/** Where a PersistentClipStore keeps clips. IndexedDB in the browser, a Map in tests. */
export interface ClipBackend {
  getAll(): Promise<DatasetClip[]>;
  put(clips: DatasetClip[]): Promise<void>;
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
        const extra = saved.filter((c) => !this.touched.has(c.id));
        if (!extra.length) return;
        this.clips = [...extra, ...this.clips].sort(byTime);
        this.changed();
      },
      (e) => { this.restoring = false; this.fail('restore', e); },
    );
    this.ready = this.queue;
  }

  /** Resolves when every write so far has finished (or failed). */
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

  protected persistPut(cs: DatasetClip[]) {
    if (this.restoring) cs.forEach((c) => this.touched.add(c.id));
    this.enqueue('save', () => this.backend.put(cs));
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
export function memoryBackend(map = new Map<string, DatasetClip>()): ClipBackend {
  const copy = <T>(x: T): T => structuredClone(x);
  return {
    getAll: async () => [...map.values()].map(copy),
    put: async (cs) => { for (const c of cs) map.set(c.id, copy(c)); },
    delete: async (ids) => { for (const id of ids) map.delete(id); },
    clear: async () => { map.clear(); },
  };
}

const DB_NAME = 'silent-speech';
const DB_VERSION = 1;
const CLIPS = 'clips';

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
      db.onversionchange = () => db.close(); // a newer version in another tab: let it upgrade
      db.onclose = () => { dbp = null; }; // closed by the browser: reopen next time
      res(db);
    };
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
    getAll: async () => (await run<DatasetClip[]>('readonly', (s) => s.getAll())) ?? [],
    put: async (cs) => { await run('readwrite', (s) => { for (const c of cs) s.put(c); }); },
    delete: async (ids) => { await run('readwrite', (s) => { for (const id of ids) s.delete(id); }); },
    clear: async () => { await run('readwrite', (s) => { s.clear(); }); },
  };
}

export function createStore(): ClipStore {
  let idb: IDBFactory | undefined;
  try { idb = globalThis.indexedDB; } catch { idb = undefined; } // can throw in sandboxed frames
  return idb ? new PersistentClipStore(idbBackend(idb)) : new MemoryClipStore();
}

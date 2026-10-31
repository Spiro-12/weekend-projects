// Clip store. Phase 0: in memory only. Track C (enroll) adds autosave + import/export here.
import type { Dataset, DatasetClip } from './core/contracts';

export interface ClipStore {
  all(): DatasetClip[];
  add(c: DatasetClip): void;
  remove(id: string): void;
  clear(): void;
  onChange(fn: () => void): () => void;
  load(ds: Dataset): void;
}

export class MemoryClipStore implements ClipStore {
  protected clips: DatasetClip[] = [];
  private fns = new Set<() => void>();
  all() { return this.clips.slice(); }
  add(c: DatasetClip) { this.clips.push(c); this.changed(); }
  remove(id: string) { this.clips = this.clips.filter((c) => c.id !== id); this.changed(); }
  clear() { this.clips = []; this.changed(); }
  load(ds: Dataset) {
    this.clips.push(...ds.clips.map((c) => ({ ...c, session: c.session ?? ds.session })));
    this.changed();
  }
  onChange(fn: () => void) { this.fns.add(fn); return () => this.fns.delete(fn); }
  protected changed() { for (const f of this.fns) f(); }
}

export function createStore(): ClipStore { return new MemoryClipStore(); }

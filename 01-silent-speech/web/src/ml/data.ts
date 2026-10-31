// Merging dataset files (PROTOCOL.md §3, §6): clip.session and clip.loc override the file's session and
// device.loc, then dedupe by id. Exclusion lists (`ss-exclude`, PROTOCOL §3) drop clip ids before training or
// evaluation; raw recordings are never edited.
import type { Clip, Dataset, DatasetClip } from '../core/contracts';
import { dedupeById } from './knn';

export { dedupeById };

/**
 * All clips of all files, deduped by id (first wins). Filled in from the file when the clip has none:
 * `session` (from `session`) and `loc` (from `device.loc`: the bud that recorded it, used by step 0 of preprocessing).
 */
export function mergeDatasets(ds: Dataset[]): { clips: (Clip & Partial<DatasetClip>)[]; duplicates: number } {
  const all = ds.flatMap((d) => d.clips.map((c) => ({ ...c, session: c.session ?? d.session, loc: c.loc ?? d.device?.loc })));
  const clips = dedupeById(all);
  return { clips, duplicates: all.length - clips.length };
}

export interface ExcludeList { format: 'ss-exclude'; v: 1; reason?: string; ids: string[] }

/** Checks an `ss-exclude` v1 file (already JSON parsed) and returns its ids. Throws with a clear message otherwise. */
export function parseExclude(x: unknown): Set<string> {
  const e = x as Partial<ExcludeList> | null;
  if (!e || typeof e !== 'object' || e.format !== 'ss-exclude' || e.v !== 1) throw new Error('not an ss-exclude v1 file');
  if (!Array.isArray(e.ids) || !e.ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('ss-exclude: ids must be a list of clip ids');
  }
  return new Set(e.ids);
}

/** Drops excluded clips. `missing` = excluded ids that matched no clip (a typo, or a file that wasn't loaded). */
export function applyExclude<T extends { id: string }>(clips: T[], ids: Set<string>): { clips: T[]; excluded: number; missing: string[] } {
  const kept = clips.filter((c) => !ids.has(c.id));
  const present = new Set(clips.map((c) => c.id));
  return { clips: kept, excluded: clips.length - kept.length, missing: [...ids].filter((id) => !present.has(id)) };
}

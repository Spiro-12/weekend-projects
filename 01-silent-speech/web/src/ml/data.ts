// Merging dataset files (PROTOCOL.md §3, §6): clip.session overrides the file's session, then dedupe by id.
import type { Clip, Dataset, DatasetClip } from '../core/contracts';
import { dedupeById } from './knn';

export { dedupeById };

/** All clips of all files, session filled in from the file when the clip has none, deduped by id (first wins). */
export function mergeDatasets(ds: Dataset[]): { clips: (Clip & Partial<DatasetClip>)[]; duplicates: number } {
  const all = ds.flatMap((d) => d.clips.map((c) => ({ ...c, session: c.session ?? d.session })));
  const clips = dedupeById(all);
  return { clips, duplicates: all.length - clips.length };
}

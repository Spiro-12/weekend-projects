// Where the Recognize screen's model comes from (Track J brief, step 1). Pure helpers, no DOM.
//
// - The store has real (airpods) clips for at least 2 classes: train on them. That is "your model",
//   the only kind that may run actions. Fake practice clips never train it.
// - Otherwise: Spiro's public model (`models/templates.json`, Track F). Missing file: "No public model yet".
// - A model another panel set (Record's "Train & use it" on practice data) is kept when there is no
//   real data, but it never counts as yours.
import excludeJson from '../../../../data/raw/exclude.json';
import type { Clip, DatasetClip, DtwKnnModelJSON } from '../../core/contracts';
import type { ClipMeta } from '../../store';

/** Clip ids every training script skips (PROTOCOL §3, data/raw/exclude.json). */
export const EXCLUDED: ReadonlySet<string> = new Set((excludeJson as { ids: string[] }).ids);

/** PROTOCOL §5: input clips have at least 10 samples. */
export const MIN_SAMPLES = 10;

/**
 * The user's real AirPods clips, ready for ml.train: source 'airpods' only (unknown source counts as
 * fake), known labels only, not excluded, long enough. `loc` filled from the clip's meta when missing.
 */
export function realClips(
  all: DatasetClip[], meta: (id: string) => ClipMeta | undefined, known: Iterable<string>,
  exclude: ReadonlySet<string> = EXCLUDED,
): Clip[] {
  const labels = new Set(known);
  const out: Clip[] = [];
  for (const c of all) {
    const m = meta(c.id);
    if (m?.source !== 'airpods' || !labels.has(c.label) || exclude.has(c.id)) continue;
    if (!Array.isArray(c.samples) || c.samples.length < MIN_SAMPLES) continue;
    const loc = c.loc ?? m.device?.loc;
    out.push({ id: c.id, label: c.label, samples: c.samples, session: c.session, ...(loc ? { loc } : {}) });
  }
  return out;
}

export const classCount = (clips: { label: string }[]) => new Set(clips.map((c) => c.label)).size;

/** Identifies a training set (which clips), to tell if "your model" is out of date. */
export const fingerprint = (clips: { id: string }[]) => clips.map((c) => c.id).sort().join('\n');

export type Provenance = 'own' | 'public' | 'other';
export type Plan = 'train' | 'keep' | 'public';

/** Minimum number of classes with real clips before we train "your model". */
export const MIN_REAL_CLASSES = 2;

/**
 * What to do when Recognize mode starts (or Re-train is pressed).
 * `fresh`: the current model is ours and was trained on exactly today's real clips.
 */
export function planModel(o: { realClasses: number; current: Provenance | null; fresh: boolean; force: boolean }): Plan {
  if (o.realClasses >= MIN_REAL_CLASSES) return o.current === 'own' && o.fresh && !o.force ? 'keep' : 'train';
  if (!o.force && (o.current === 'other' || o.current === 'public')) return 'keep';
  return 'public';
}

export type PublicModel =
  | { ok: true; json: DtwKnnModelJSON }
  | { ok: false; why: 'missing' | 'error'; message: string };

/**
 * Fetches the public model. Never rejects. A 404, or an HTML page in its place (a dev server's
 * fallback), means there is no public model yet; anything else wrong is an error.
 */
export async function fetchPublicModel(
  url: string, fetchFn: typeof fetch = fetch, timeoutMs = 15_000,
): Promise<PublicModel> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { cache: 'no-cache', signal: ctl?.signal });
    if (res.status === 404 || res.status === 410) return { ok: false, why: 'missing', message: 'No public model yet' };
    if (!res.ok) return { ok: false, why: 'error', message: `The public model didn't load (HTTP ${res.status})` };
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) return { ok: false, why: 'missing', message: 'No public model yet' };
    let json: unknown;
    try { json = JSON.parse(text); } catch { return { ok: false, why: 'error', message: 'The public model file is broken' }; }
    const m = json as Partial<DtwKnnModelJSON> | null;
    if (!m || m.kind !== 'dtw-knn' || m.v !== 1 || !Array.isArray(m.templates)) {
      return { ok: false, why: 'error', message: 'The public model file is not a model this page knows' };
    }
    return { ok: true, json: m as DtwKnnModelJSON };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    return { ok: false, why: 'error', message: aborted ? 'The public model took too long to load' : 'The public model didn’t load (network)' };
  } finally {
    clearTimeout(timer);
  }
}

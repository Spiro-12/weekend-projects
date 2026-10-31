// Where the Recognize screen's model comes from (Track J brief, step 1). Pure helpers, no DOM.
//
// - Fake source: the demo model (demo-model.ts), trained in the browser on made-up motion like the fake
//   source's. Spiro's public model is trained on real AirPods data and doesn't know fake motion.
// - Replay: always Spiro's public model (never your clips), so the replay's held out score stays honest.
// - Live:
//   * "Your model" (the ONLY kind that may run actions): clips recorded in this browser (origin
//     'recorded') with real AirPods, covering EVERY sentence in classes.json, 'none' included, at least
//     5 times each. A model that knows only a few sentences calls everything one of them (real data: a
//     none + text_mom model accepted 70 of 90 other sentences as text_mom), so it must never act.
//   * Otherwise, real AirPods clips (recorded or imported) for 2+ sentences: a preview model, display only.
//   * Otherwise: Spiro's public model (`models/templates.json`, Track F). Missing file: "No public model yet".
//   Fake practice clips never train either.
// - A model another panel set (Record's "Train & use it" on practice data) is kept when there is no
//   real data (or in fake mode), but it never counts as yours.
import excludeJson from '../../../../data/raw/exclude.json';
import type { SourceKind } from '../../core/app';
import type { Clip, DatasetClip, DtwKnnModelJSON } from '../../core/contracts';
import type { ClipMeta } from '../../store';

/** Clip ids every training script skips (PROTOCOL §3, data/raw/exclude.json). */
export const EXCLUDED: ReadonlySet<string> = new Set((excludeJson as { ids: string[] }).ids);

/** PROTOCOL §5: input clips have at least 10 samples. */
export const MIN_SAMPLES = 10;

/**
 * The user's real AirPods clips, ready for ml.train: source 'airpods' only (unknown source counts as
 * fake), known labels only, not excluded, long enough. `loc` filled from the clip's meta when missing.
 * `recordedOnly`: only clips recorded in this browser (meta.origin 'recorded').
 */
export function realClips(
  all: DatasetClip[], meta: (id: string) => ClipMeta | undefined, known: Iterable<string>,
  o: { recordedOnly?: boolean; exclude?: ReadonlySet<string> } = {},
): Clip[] {
  const labels = new Set(known);
  const exclude = o.exclude ?? EXCLUDED;
  const out: Clip[] = [];
  for (const c of all) {
    const m = meta(c.id);
    if (m?.source !== 'airpods' || !labels.has(c.label) || exclude.has(c.id)) continue;
    if (o.recordedOnly && m.origin !== 'recorded') continue; // imported or old records (no origin) don't count
    if (!Array.isArray(c.samples) || c.samples.length < MIN_SAMPLES) continue;
    const loc = c.loc ?? m.device?.loc;
    out.push({ id: c.id, label: c.label, samples: c.samples, session: c.session, ...(loc ? { loc } : {}) });
  }
  return out;
}

export const classCount = (clips: { label: string }[]) => new Set(clips.map((c) => c.label)).size;

/** Identifies a training set (which clips), to tell if "your model" is out of date. */
export const fingerprint = (clips: { id: string }[]) => clips.map((c) => c.id).sort().join('\n');

/** Takes per sentence (recorded here, real AirPods) before "your model" may run actions. */
export const MIN_TAKES_FOR_ACTIONS = 5;

export interface Readiness {
  ready: boolean; // every sentence has MIN_TAKES_FOR_ACTIONS recorded takes
  done: number; // sentences that have enough
  total: number; // sentences in classes.json ('none' included)
}

/** Can a model trained on these (recorded, real) clips run actions? Every class id, 5+ takes each. */
export function actionReadiness(recorded: { label: string }[], classIds: string[], min = MIN_TAKES_FOR_ACTIONS): Readiness {
  const n = new Map<string, number>();
  for (const c of recorded) n.set(c.label, (n.get(c.label) ?? 0) + 1);
  const ids = [...new Set(classIds)];
  const done = ids.filter((id) => (n.get(id) ?? 0) >= min).length;
  return { ready: ids.length > 0 && done === ids.length, done, total: ids.length };
}

export type Provenance = 'own' | 'preview' | 'public' | 'demo' | 'other';
export type Plan = 'own' | 'preview' | 'keep' | 'public' | 'demo';

/** Minimum number of classes with real clips before we train a preview model. */
export const MIN_REAL_CLASSES = 2;

/**
 * What to do when Recognize mode starts, the source changes, or Re-train is pressed.
 * `ownReady`: recorded real clips cover every sentence 5+ times. `realClasses`: sentences with any real clips.
 * `fresh`: the current model is ours and was trained on exactly the clips we'd use now.
 */
export function planModel(o: {
  source: SourceKind | null; ownReady: boolean; realClasses: number; current: Provenance | null; fresh: boolean; force: boolean;
}): Plan {
  const { current: cur, force } = o;
  if (o.source === 'fake') return !force && (cur === 'demo' || cur === 'other') ? 'keep' : 'demo';
  if (o.source === 'replay') return !force && cur === 'public' ? 'keep' : 'public';
  if (o.ownReady) return cur === 'own' && o.fresh && !force ? 'keep' : 'own';
  if (o.realClasses >= MIN_REAL_CLASSES) return cur === 'preview' && o.fresh && !force ? 'keep' : 'preview';
  if (!force && (cur === 'other' || cur === 'public')) return 'keep';
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

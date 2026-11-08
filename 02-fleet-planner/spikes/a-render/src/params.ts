// URL params for the spike page.
//   ?tier=high|medium|low   ?view=single|split   ?robots=N (per side)   ?people=N (per side)
//   ?peopleMode=parts|skinned   ?seed=N   ?freeze=SECONDS (fixed sim time, for screenshots)   ?perf=1 (HUD)
//   ?pose=overview|aisle (initial camera)   overrides: ?bloom=0|1 ?shadows=0|1 ?aa=0|1 ?dpr=N ?boxFar=M ?bloomScale=F

export type Tier = 'high' | 'medium' | 'low';
export type PeopleMode = 'parts' | 'skinned';

export interface TierSpec {
  dpr: number;
  bloom: boolean;
  /** One real-time shadow map, agents only. */
  shadowMap: boolean;
  /** Instanced blob shadows under agents. */
  blobs: boolean;
  /** Box chunks farther than this from the camera are hidden (Infinity = never). */
  boxFarM: number;
  antialias: boolean;
  /** Bloom mip chain size relative to the canvas (1 = stock UnrealBloomPass: mips from half size). */
  bloomScale: number;
}

export const TIERS: Record<Tier, TierSpec> = {
  high: { dpr: 2, bloom: true, shadowMap: true, blobs: false, boxFarM: Infinity, antialias: false, bloomScale: 1 },
  medium: { dpr: 1.5, bloom: false, shadowMap: false, blobs: true, boxFarM: Infinity, antialias: true, bloomScale: 1 },
  low: { dpr: 1, bloom: false, shadowMap: false, blobs: true, boxFarM: 30, antialias: true, bloomScale: 1 },
};

export interface Params {
  tier: Tier;
  spec: TierSpec;
  split: boolean;
  robots: number;
  people: number;
  peopleMode: PeopleMode;
  seed: number;
  freeze: number | null;
  hud: boolean;
  pose: string;
}

export function readParams(search: string): Params {
  const q = new URLSearchParams(search);
  const tier = (['high', 'medium', 'low'].includes(q.get('tier') ?? '') ? q.get('tier') : 'medium') as Tier;
  const split = q.get('view') === 'split';
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  };
  const spec = { ...TIERS[tier] };
  if (q.has('bloom')) spec.bloom = q.get('bloom') === '1';
  if (q.has('shadows')) spec.shadowMap = q.get('shadows') === '1';
  if (q.has('aa')) spec.antialias = q.get('aa') === '1';
  if (q.has('dpr') && Number(q.get('dpr')) > 0) spec.dpr = Number(q.get('dpr'));
  if (Number(q.get('bloomScale')) > 0) spec.bloomScale = Number(q.get('bloomScale'));
  if (q.has('boxFar')) spec.boxFarM = Number(q.get('boxFar')) || Infinity;
  return {
    tier,
    spec,
    split,
    robots: Math.min(300, num('robots', 60)),
    people: Math.min(80, num('people', 16)),
    peopleMode: q.get('peopleMode') === 'skinned' ? 'skinned' : 'parts',
    seed: num('seed', 7),
    freeze: q.has('freeze') ? num('freeze', 30) : null,
    hud: q.get('perf') === '1',
    pose: q.get('pose') ?? 'overview',
  };
}

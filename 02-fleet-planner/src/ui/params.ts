// URL parameters (PROTOCOL §10). Read once at boot.
export interface Params {
  scenario?: string;
  seed?: number;
  view: 'single' | 'split';
  demo: boolean;
  perf: boolean;
  tier?: 'high' | 'medium' | 'low' | 'lite';
  capture: boolean;
  /** Test hook: freeze the live sim (screenshots). */
  freeze: boolean;
  /** Set the cart-robot count to this (perf checks, Spiro's phone test). Capped at 300. */
  agents?: number;
  /** Which runner computes the numbers: the worker pool (default) or the toy model (`?runner=fake`). */
  runner?: 'worker' | 'fake';
}

export function readParams(search = typeof location !== 'undefined' ? location.search : ''): Params {
  const q = new URLSearchParams(search);
  const num = (k: string) => (q.has(k) && /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
  const tier = q.get('tier');
  return {
    scenario: q.get('scenario') ?? undefined,
    seed: num('seed'),
    view: q.get('view') === 'split' ? 'split' : 'single',
    demo: q.get('demo') === '1',
    perf: q.get('perf') === '1',
    tier: tier === 'high' || tier === 'medium' || tier === 'low' || tier === 'lite' ? tier : undefined,
    capture: q.get('capture') === '1',
    freeze: q.get('freeze') === '1',
    agents: num('agents') === undefined ? undefined : Math.min(300, num('agents')!),
    runner: q.get('runner') === 'worker' ? 'worker' : q.get('runner') === 'fake' ? 'fake' : undefined,
  };
}

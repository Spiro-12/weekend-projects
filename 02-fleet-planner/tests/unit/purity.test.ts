// PROTOCOL §8: the sim core, KPIs, economics and contracts must be deterministic in every JS engine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/sim', 'src/kpi', 'src/econ', 'src/contracts'];
const BANNED: [RegExp, string][] = [
  [/Math\.random\s*\(/, 'Math.random (use src/sim/rng.ts streams)'],
  [/\bDate\b/, 'Date (sim time is ticks)'],
  [/performance\.now/, 'performance.now (wall time is not sim time)'],
  [/Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|sqrt|cbrt|sinh|cosh|tanh)\b/, 'engine-dependent Math function'],
  [/\*\*/, 'the ** operator (same as Math.pow)'],
  [/from ['"]three['"]/, 'three.js (render code only)'],
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.ts$/.test(e)) out.push(p);
  }
  return out;
}

describe('sim purity (banned APIs)', () => {
  const all = ROOTS.flatMap(files);
  it('finds the sim files', () => expect(all.length).toBeGreaterThan(3));
  it.each(all)('%s uses no banned API', (f) => {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const hits = BANNED.filter(([re]) => re.test(src)).map(([, why]) => why);
    expect(hits).toEqual([]);
  });
});

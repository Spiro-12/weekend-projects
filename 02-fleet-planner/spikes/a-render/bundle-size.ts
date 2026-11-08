// Gzipped JS of the spike build, split into initial (entry + its static imports) and lazy chunks.
// Usage (from 02-fleet-planner/): npx vite build --config spikes/a-render/vite.config.ts && npx tsx spikes/a-render/bundle-size.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = fileURLToPath(new URL('./out/dist/', import.meta.url));
interface Chunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  src?: string;
}
const manifest: Record<string, Chunk> = JSON.parse(readFileSync(`${dist}.vite/manifest.json`, 'utf8'));
const gz = (file: string, level: number) => gzipSync(readFileSync(dist + file), { level }).length;
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

const initial = new Set<string>();
const visit = (key: string) => {
  if (initial.has(key)) return;
  initial.add(key);
  for (const i of manifest[key].imports ?? []) visit(i);
};
for (const [k, c] of Object.entries(manifest)) if (c.isEntry) visit(k);

let initGz = 0;
let lazyGz = 0;
const rows: string[] = [];
for (const [k, c] of Object.entries(manifest)) {
  if (!c.file.endsWith('.js')) continue;
  const raw = readFileSync(dist + c.file).length;
  const g6 = gz(c.file, 6);
  const g9 = gz(c.file, 9);
  const isInit = initial.has(k);
  if (isInit) initGz += g6;
  else lazyGz += g6;
  rows.push(`${isInit ? 'initial' : 'lazy   '}  ${kb(raw).padStart(9)} min  ${kb(g6).padStart(8)} gz6  ${kb(g9).padStart(8)} gz9  ${c.src ?? k}`);
}
console.log(rows.join('\n'));
console.log(`initial JS ${kb(initGz)} gz (level 6, like serve-gz.ts)   lazy ${kb(lazyGz)} gz   total ${kb(initGz + lazyGz)} gz`);

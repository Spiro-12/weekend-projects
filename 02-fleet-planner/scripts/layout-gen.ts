// Writes data/layouts/{small,default,large}.json from the presets in src/sim/layout-gen.ts.
// Usage: npm run layouts   (add --print to show the default grid)
import { writeFileSync } from 'node:fs';
import { PRESETS, generateLayout } from '../src/sim/layout-gen.ts';

for (const p of PRESETS) {
  const layout = generateLayout(p);
  const file = new URL(`../data/layouts/${p.id}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(layout, null, 1) + '\n');
  console.log(`${p.id}: ${layout.grid[0].length} x ${layout.grid.length} cells`);
  if (process.argv.includes('--print') && p.id === 'default') console.log(layout.grid.join('\n'));
}

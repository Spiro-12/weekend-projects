// Prints world bounds of mesh nodes whose name (or parent's) matches a pattern. Used to pick moving parts.
// Usage: tsx scripts/assets/bounds.ts <regex> a.glb [b.glb ...]
import { readFileSync } from 'node:fs';
import { getBounds } from '@gltf-transform/functions';
import { makeIO } from './io.ts';

const [pattern, ...files] = process.argv.slice(2);
const re = new RegExp(pattern, 'i');
const io = await makeIO();
for (const f of files) {
  console.log(f);
  const doc = await io.readBinary(new Uint8Array(readFileSync(f)));
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh()) continue;
    const name = `${n.getParentNode()?.getName() ?? ''}/${n.getName()}`;
    if (!re.test(name)) continue;
    const b = getBounds(n);
    console.log(`  ${name.padEnd(60)} min ${b.min.map((v) => v.toFixed(2)).join(',')}  max ${b.max.map((v) => v.toFixed(2)).join(',')}`);
  }
}

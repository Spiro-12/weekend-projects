// Saves textures whose name matches a pattern as PNG, to look at them (decal / logo check).
// Usage: tsx scripts/assets/dump-textures.ts <outDir> <regex> a.glb [b.glb ...]
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { makeIO } from './io.ts';

const [outDir, pattern, ...files] = process.argv.slice(2);
const re = new RegExp(pattern, 'i');
mkdirSync(outDir, { recursive: true });
const io = await makeIO();
for (const file of files) {
  const doc = await io.readBinary(new Uint8Array(readFileSync(file)));
  for (const t of doc.getRoot().listTextures()) {
    if (!re.test(t.getName())) continue;
    const out = join(outDir, `${basename(file, '.glb')}__${t.getName().replace(/[^\w.-]/g, '_')}.png`);
    await sharp(Buffer.from(t.getImage()!)).png().toFile(out);
    console.log(out, t.getSize());
  }
}

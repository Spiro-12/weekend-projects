// Prints GLB node trees, meshes, materials and textures. Usage: tsx scripts/assets/inspect.ts a.glb [b.glb ...] [--tree]
import { readFileSync } from 'node:fs';
import { makeIO } from './io.ts';
import type { Node } from '@gltf-transform/core';

const args = process.argv.slice(2);
const flag = args.includes('--tree') ? '--tree' : '';
const io = await makeIO();
for (const file of args.filter((a) => !a.startsWith('--'))) {
const doc = file.endsWith(".gltf") ? await io.read(file) : await io.readBinary(new Uint8Array(readFileSync(file)));
const root = doc.getRoot();
let tris = 0;
let prims = 0;
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    prims++;
    const idx = p.getIndices();
    tris += (idx ? idx.getCount() : p.getAttribute('POSITION')!.getCount()) / 3;
  }
}
console.log(`${file}: nodes=${root.listNodes().length} meshes=${root.listMeshes().length} prims=${prims} tris=${tris}`);
console.log('extensions:', root.listExtensionsUsed().map((e) => e.extensionName).join(', '));
for (const m of root.listMaterials()) {
  const tex = [
    ['base', m.getBaseColorTexture()], ['mr', m.getMetallicRoughnessTexture()], ['n', m.getNormalTexture()],
    ['occ', m.getOcclusionTexture()], ['em', m.getEmissiveTexture()],
  ]
    .filter(([, t]) => t)
    .map(([k, t]) => `${k}:${(t as { getName(): string }).getName()}`)
    .join(' ');
  console.log(
    `  mat "${m.getName()}" base=${m.getBaseColorFactor().map((v) => v.toFixed(2))} met=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()} ` +
      `alpha=${m.getAlphaMode()} em=${m.getEmissiveFactor().map((v) => v.toFixed(2))} ext=[${m.listExtensions().map((e) => e.extensionName)}] ${tex}`,
  );
}
for (const t of root.listTextures()) console.log(`  tex "${t.getName()}" ${t.getMimeType()} ${t.getSize()} ${t.getImage()?.byteLength}`);
if (flag === '--tree') {
  const walk = (n: Node, d: number) => {
    const mesh = n.getMesh();
    let info = '';
    if (mesh) {
      const t = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
      info = ` mesh="${mesh.getName()}" prims=${mesh.listPrimitives().length} tris=${t} mats=${mesh.listPrimitives().map((p) => p.getMaterial()?.getName()).join('|')}`;
    }
    const ex = Object.keys(n.getExtras() ?? {}).length ? ` extras=${JSON.stringify(n.getExtras()).slice(0, 80)}` : '';
    console.log(`${'  '.repeat(d)}- ${n.getName()}${info}${ex}`);
    for (const c of n.listChildren()) walk(c, d + 1);
  };
  for (const s of root.listScenes()) for (const n of s.listChildren()) walk(n, 1);
}
}

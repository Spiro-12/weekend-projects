// Fleet Planner asset pipeline: SimReady shortlist (+ the Quaternius worker) → public/assets/*.glb + manifest.json.
// Usage: npx tsx scripts/assets/build-assets.ts [key ...]   (no keys = everything). Idempotent; prints a size table.
//
// Per model and tier: read the pinned source GLB → drop decals / tiny parts → bake world transforms → keep up to
// a few materials textured and bake the rest into vertex colours on shared untextured materials (painted / metal /
// film / emissive) → join per material and per moving part → simplify to the triangle budget → origin on the
// floor at the footprint centre (metres, Y up) → WebP textures at the tier size → meshopt compression.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Accessor, Document, Material, Node, Texture } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { dedup, dequantize, meshopt, prune, textureCompress, transformPrimitive, weldPrimitive } from '@gltf-transform/functions';
import sharp from 'sharp';
import { CACHE, ROOT, checkLicense, sourceGlb } from './fetch.ts';
import {
  applyUvTransform, decodeImage, meanChannels, rebuildWithCreases, sampleLinear, simplifyLog, simplifyTo, triArea, weldPositions,
  type Image, type UvTransform,
} from './geometry.ts';
import { makeIO, MeshoptEncoder } from './io.ts';
import { CODEPAWL_REV, NVIDIA_REV, SHORTLIST, nvidiaPage, type AssetSpec, type TierSpec } from './shortlist.ts';

export const OUT = join(ROOT, 'public/assets');
const io = await makeIO();

export interface ManifestEntry {
  url: string;
  urlLo?: string;
  /** Multiply by this to get metres (always 1: outputs are in metres). */
  scale: number;
  /** Translation applied to the source to put the origin on the floor at the footprint centre (metres). */
  offset: [number, number, number];
  /** Bounding box size in metres [x, y, z]. */
  size: [number, number, number];
  tris: number;
  trisLo?: number;
  drawCalls: number;
  drawCallsLo?: number;
  bytes: number;
  gzBytes: number;
  bytesLo?: number;
  gzBytesLo?: number;
  textures: string[];
  texturesLo?: string[];
  /** Named child nodes that can move on their own (e.g. forks). */
  parts: string[];
  /** Animation clip names (characters only). */
  clips?: string[];
  license: string;
  credit: string;
  source: string;
  firstTier: boolean;
  label: string;
}

export interface Manifest {
  format: 'fp-assets';
  v: 1;
  generated: string;
  source: { codepawlRev: string; nvidiaRev: string };
  decoder: { name: string; gzBytes: number };
  models: Record<string, ManifestEntry>;
}

export const gz = (b: Uint8Array) => gzipSync(b, { level: 6 }).byteLength;

// ───────────────────────────── material analysis ─────────────────────────────

interface MatInfo {
  base: Image | null;
  baseUv: UvTransform | null;
  baseTexCoord: number;
  factor: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  transmission: boolean;
}

const imageCache = new Map<Texture, Promise<Image>>();
const texImage = (t: Texture, edge: number) => {
  let p = imageCache.get(t);
  if (!p) imageCache.set(t, (p = decodeImage(t.getImage()!, edge)));
  return p;
};

function uvTransformOf(info: ReturnType<Material['getBaseColorTextureInfo']>): UvTransform | null {
  const ext = info?.getExtension<import('@gltf-transform/extensions').Transform>('KHR_texture_transform');
  if (!ext) return null;
  return { offset: ext.getOffset() as [number, number], rotation: ext.getRotation(), scale: ext.getScale() as [number, number] };
}

async function analyse(m: Material): Promise<MatInfo> {
  const baseTex = m.getBaseColorTexture();
  const baseInfo = m.getBaseColorTextureInfo();
  const mrTex = m.getMetallicRoughnessTexture();
  let metallic = m.getMetallicFactor();
  let roughness = m.getRoughnessFactor();
  if (mrTex) {
    const mean = meanChannels(await texImage(mrTex, 64));
    roughness *= mean[1];
    metallic *= mean[2];
  }
  let emissive = m.getEmissiveFactor() as [number, number, number];
  const emTex = m.getEmissiveTexture();
  if (emTex) {
    const mean = meanChannels(await texImage(emTex, 64));
    emissive = [emissive[0] * mean[0], emissive[1] * mean[1], emissive[2] * mean[2]];
  }
  return {
    base: baseTex ? await texImage(baseTex, 256) : null,
    baseUv: uvTransformOf(baseInfo),
    baseTexCoord: baseInfo?.getTexCoord() ?? 0,
    factor: m.getBaseColorFactor() as [number, number, number, number],
    metallic,
    roughness,
    emissive,
    transmission: !!m.getExtension('KHR_materials_transmission'),
  };
}

// ───────────────────────────── per-tier build ─────────────────────────────

type Bucket = 'painted' | 'metal' | 'film' | 'emissive';

interface Piece {
  group: string;
  /** Kept textured material, or a bake bucket. */
  mat: Material | Bucket;
  pos: Float32Array;
  nor: Float32Array | null;
  uv: Float32Array | null;
  col: Float32Array | null;
  idx: Uint32Array;
  area: number;
  /** For bucket materials: the source material's PBR numbers, area weighted later. */
  info?: MatInfo;
}

const nameChain = (n: Node): string => {
  const names: string[] = [];
  let p: Node | null = n;
  while (p) {
    names.push(p.getName());
    p = p.getParentNode();
  }
  return names.join('/');
};

const floatArray = (a: Accessor | null): Float32Array | null => {
  if (!a) return null;
  const arr = a.getArray()!;
  return arr instanceof Float32Array ? arr : Float32Array.from(arr as ArrayLike<number>);
};

interface TierResult {
  bytes: Uint8Array;
  tris: number;
  drawCalls: number;
  textures: string[];
  size: [number, number, number];
  offset: [number, number, number];
  parts: string[];
}

async function buildTier(spec: AssetSpec, tier: TierSpec, isLo: boolean): Promise<TierResult> {
  const src = await sourceGlb(spec.src);
  const doc = await io.readBinary(new Uint8Array(src));
  await doc.transform(dequantize());
  const root = doc.getRoot();
  const materials = root.listMaterials();
  const keepRe = spec.keep ?? (materials.length <= 3 ? /.*/ : null);
  const infos = new Map<Material, MatInfo>();
  for (const m of materials) infos.set(m, await analyse(m));

  // 1. Gather pieces in world space.
  const pieces: Piece[] = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const chain = nameChain(node) + '/' + mesh.getName();
    if (spec.drop?.test(chain)) continue;
    const group = Object.entries(spec.parts ?? {}).find(([, re]) => re.test(chain))?.[0] ?? 'body';
    const world = node.getWorldMatrix();
    for (const prim0 of mesh.listPrimitives()) {
      const mat = prim0.getMaterial();
      if (!mat || spec.drop?.test(mat.getName())) continue;
      const prim = prim0.clone();
      for (const sem of prim.listSemantics()) prim.setAttribute(sem, prim.getAttribute(sem)!.clone());
      if (prim.getIndices()) prim.setIndices(prim.getIndices()!.clone());
      transformPrimitive(prim, world);
      const pos = floatArray(prim.getAttribute('POSITION'))!;
      const idx0 = prim.getIndices();
      const idx = idx0 ? Uint32Array.from(idx0.getArray()!) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const info = infos.get(mat)!;
      // Tiny parts (bolts, buttons): drop by bounding-box diagonal.
      if (spec.minPart) {
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) {
          mn[c] = Math.min(mn[c], pos[i + c]);
          mx[c] = Math.max(mx[c], pos[i + c]);
        }
        if (Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) < spec.minPart) continue;
      }
      const film = info.transmission || (spec.film?.test(mat.getName()) ?? false);
      const keep = !film && keepRe?.test(mat.getName());
      let bucket: Bucket = 'painted';
      if (film) bucket = 'film';
      else if (spec.emissive?.test(mat.getName()) && Math.max(...info.emissive) > 0.05) bucket = 'emissive';
      else if (info.metallic >= 0.5) bucket = 'metal';
      const uvSem = `TEXCOORD_${info.baseTexCoord}`;
      const uv = floatArray(prim.getAttribute(keep ? 'TEXCOORD_0' : uvSem));
      let col: Float32Array | null = null;
      if (!keep) {
        // Bake base colour (texture × factor) into linear vertex colours.
        col = new Float32Array(pos.length);
        const tmp = new Float32Array(3);
        for (let i = 0; i < pos.length / 3; i++) {
          if (info.base && uv) {
            const [u, v] = applyUvTransform(info.baseUv, uv[i * 2], uv[i * 2 + 1]);
            sampleLinear(info.base, u, v, tmp, 0);
          } else tmp.fill(1);
          for (let c = 0; c < 3; c++) col[i * 3 + c] = tmp[c] * info.factor[c];
        }
      }
      pieces.push({
        group,
        mat: keep ? mat : bucket,
        pos,
        nor: floatArray(prim.getAttribute('NORMAL')),
        uv: keep ? uv : null,
        col,
        idx,
        area: triArea(pos, idx),
        info,
      });
    }
  }

  // At most 3 materials: fold the baked metal bucket into the painted one if needed (colour stays per vertex).
  const matKey = (m: Piece['mat']) => (typeof m === 'string' ? m : m.getName());
  if (new Set(pieces.map((p) => matKey(p.mat))).size > 3 && pieces.some((p) => p.mat === 'painted')) {
    for (const p of pieces) if (p.mat === 'metal') p.mat = 'painted';
  }

  // 2. Merge pieces by (group, material).
  const merged = new Map<string, Piece[]>();
  for (const p of pieces) {
    const k = `${p.group}|${matKey(p.mat)}`;
    (merged.get(k) ?? merged.set(k, []).get(k)!).push(p);
  }
  // Triangle budget per merged piece: small pieces keep a floor (so forks don't vanish), the rest is proportional.
  const FLOOR = Math.min(isLo ? 60 : 150, tier.tris);
  const orig = new Map<string, number>();
  for (const [k, list] of merged) orig.set(k, list.reduce((s, p) => s + p.idx.length / 3, 0));
  const floors = new Map([...orig].map(([k, n]) => [k, Math.min(n, FLOOR)]));
  const floorSum = [...floors.values()].reduce((a, b) => a + b, 0);
  const restSum = [...orig].reduce((s, [k, n]) => s + n - floors.get(k)!, 0);
  const restRatio = restSum > 0 ? Math.max(0, Math.min(1, (tier.tris - floorSum) / restSum)) : 0;
  const budgetOf = (k: string) => Math.floor(floors.get(k)! + (orig.get(k)! - floors.get(k)!) * restRatio);

  // 3. Bounds → offset (origin on the floor at the footprint centre).
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pieces) for (let i = 0; i < p.pos.length; i += 3) for (let c = 0; c < 3; c++) {
    mn[c] = Math.min(mn[c], p.pos[i + c]);
    mx[c] = Math.max(mx[c], p.pos[i + c]);
  }
  const offset: [number, number, number] = [-(mn[0] + mx[0]) / 2, -mn[1], -(mn[2] + mx[2]) / 2];

  // 4. Build the output document.
  const out = new Document();
  out.createBuffer();
  const scene = out.createScene(spec.key);
  const rootNode = out.createNode(spec.key);
  scene.addChild(rootNode);
  const groupNodes = new Map<string, Node>();
  const bucketMats = new Map<Bucket, Material>();
  const keptMats = new Map<Material, Material>();
  const bucketStats = new Map<Bucket, { area: number; met: number; rough: number; em: number[] }>();
  for (const p of pieces) {
    if (typeof p.mat !== 'string') continue;
    const s = bucketStats.get(p.mat) ?? { area: 0, met: 0, rough: 0, em: [0, 0, 0] };
    s.area += p.area;
    s.met += p.info!.metallic * p.area;
    s.rough += p.info!.roughness * p.area;
    for (let c = 0; c < 3; c++) s.em[c] += p.info!.emissive[c] * p.area;
    bucketStats.set(p.mat, s);
  }
  const bucketMaterial = (b: Bucket): Material => {
    let m = bucketMats.get(b);
    if (m) return m;
    const s = bucketStats.get(b)!;
    m = out.createMaterial(`${spec.key}_${b}`)
      .setMetallicFactor(b === 'metal' ? Math.max(0.6, s.met / s.area) : Math.min(0.2, s.met / s.area))
      .setRoughnessFactor(Math.min(1, Math.max(0.15, s.rough / s.area)));
    if (b === 'film') {
      m.setAlphaMode('BLEND').setBaseColorFactor([0.85, 0.88, 0.9, 0.35]).setRoughnessFactor(0.25).setMetallicFactor(0).setDoubleSided(true);
    }
    if (b === 'emissive') m.setEmissiveFactor(s.em.map((v) => Math.min(1, (v / s.area) * 1.5)) as [number, number, number]);
    bucketMats.set(b, m);
    return m;
  };
  const tex = (t: Texture | null): Texture | null => {
    if (!t) return null;
    return out.createTexture(t.getName()).setImage(t.getImage()!).setMimeType(t.getMimeType());
  };
  const keptMaterial = (m: Material): Material => {
    let o = keptMats.get(m);
    if (o) return o;
    o = out.createMaterial(m.getName())
      .setBaseColorFactor(m.getBaseColorFactor())
      .setMetallicFactor(m.getMetallicFactor())
      .setRoughnessFactor(m.getRoughnessFactor())
      .setBaseColorTexture(tex(m.getBaseColorTexture()));
    const srcUv = uvTransformOf(m.getBaseColorTextureInfo());
    if (!isLo) {
      o.setMetallicRoughnessTexture(tex(m.getMetallicRoughnessTexture()));
      if (m.getOcclusionTexture() && m.getOcclusionTexture() === m.getMetallicRoughnessTexture()) {
        o.setOcclusionTexture(o.getMetallicRoughnessTexture());
      }
      if (tier.normals ?? true) o.setNormalTexture(tex(m.getNormalTexture())).setNormalScale(m.getNormalScale());
    } else {
      // Low tier: base colour only; use the mean roughness / metalness instead of the ORM texture.
      const info = infos.get(m)!;
      o.setMetallicFactor(info.metallic).setRoughnessFactor(info.roughness);
    }
    if (srcUv) {
      const ext = out.createExtension(KHRTextureTransform);
      for (const ti of [o.getBaseColorTextureInfo(), o.getMetallicRoughnessTextureInfo(), o.getNormalTextureInfo(), o.getOcclusionTextureInfo()]) {
        if (ti) ti.setExtension('KHR_texture_transform', ext.createTransform().setOffset(srcUv.offset).setRotation(srcUv.rotation).setScale(srcUv.scale));
      }
    }
    keptMats.set(m, o);
    return o;
  };

  let tris = 0;
  let drawCalls = 0;
  for (const [mkey, list] of merged) {
    const first = list[0];
    // Concatenate.
    const nV = list.reduce((s, p) => s + p.pos.length / 3, 0);
    const nI = list.reduce((s, p) => s + p.idx.length, 0);
    const pos = new Float32Array(nV * 3);
    const nor = new Float32Array(nV * 3);
    const uv = first.uv ? new Float32Array(nV * 2) : null;
    const col = first.col ? new Float32Array(nV * 3) : null;
    const idx = new Uint32Array(nI);
    let vo = 0, io2 = 0;
    for (const p of list) {
      const n = p.pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos[(vo + i) * 3] = p.pos[i * 3] + offset[0];
        pos[(vo + i) * 3 + 1] = p.pos[i * 3 + 1] + offset[1];
        pos[(vo + i) * 3 + 2] = p.pos[i * 3 + 2] + offset[2];
      }
      if (p.nor) nor.set(p.nor, vo * 3);
      if (uv && p.uv) uv.set(p.uv, vo * 2);
      if (col && p.col) col.set(p.col, vo * 3);
      for (let i = 0; i < p.idx.length; i++) idx[io2 + i] = p.idx[i] + vo;
      vo += n;
      io2 += p.idx.length;
    }
    const target = Math.max(12, budgetOf(mkey));
    const prim = out.createPrimitive();
    if (typeof first.mat === 'string') {
      // Baked: weld by position, simplify freely, rebuild crease-aware normals.
      const w = weldPositions(pos);
      const wIdx = idx.map((i) => w.remap[i]);
      const wCol = new Float32Array(w.pos.length);
      for (let i = 0; i < nV; i++) wCol.set(col!.subarray(i * 3, i * 3 + 3), w.remap[i] * 3);
      const sIdx = simplifyTo(wIdx, w.pos, target, `${spec.key}${isLo ? '-lo' : ''} ${mkey}`);
      const r = rebuildWithCreases(w.pos, wCol, sIdx, 40);
      prim
        .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(r.pos)))
        .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(r.nor)))
        .setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setArray(new Float32Array(r.col!)))
        .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(r.idx)))
        .setMaterial(bucketMaterial(first.mat));
    } else {
      // Textured: keep UV seams, simplify with meshopt (seam-aware).
      prim
        .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos))
        .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nor))
        .setIndices(out.createAccessor().setType('SCALAR').setArray(idx))
        .setMaterial(keptMaterial(first.mat));
      if (uv) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uv));
      weldPrimitive(prim);
      const p2 = floatArray(prim.getAttribute('POSITION'))!;
      const i2 = Uint32Array.from(prim.getIndices()!.getArray()!);
      const sIdx = simplifyTo(i2, p2, target, `${spec.key}${isLo ? '-lo' : ''} ${mkey}`);
      prim.getIndices()!.setArray(new Uint32Array(sIdx));
    }
    let g = groupNodes.get(first.group);
    if (!g) {
      g = out.createNode(first.group).setMesh(out.createMesh(`${spec.key}_${first.group}`));
      rootNode.addChild(g);
      groupNodes.set(first.group, g);
    }
    g.getMesh()!.addPrimitive(prim);
  }
  await out.transform(prune());
  for (const m of out.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    tris += p.getIndices()!.getCount() / 3;
    drawCalls++;
  }

  // 5. Textures → WebP at the tier size; geometry → meshopt.
  await out.transform(
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tier.tex, tier.tex], quality: 82 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    prune(),
  );
  const textures = out.getRoot().listTextures().map((t) => `${t.getSize()?.join('x')} ${t.getMimeType().replace('image/', '')}`);
  const bytes = await io.writeBinary(out);
  const size: [number, number, number] = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]].map((v) => +v.toFixed(3)) as [number, number, number];
  return { bytes, tris, drawCalls, textures, size, offset: offset.map((v) => +v.toFixed(4)) as [number, number, number], parts: [...groupNodes.keys()].filter((g) => g !== 'body') };
}

// ───────────────────────────── main ─────────────────────────────

/** Triangles, draw calls, bounds and texture sizes of a written GLB. */
export async function measure(bytes: Uint8Array): Promise<{ tris: number; drawCalls: number; size: [number, number, number]; textures: string[] }> {
  const doc = await io.readBinary(bytes);
  let tris = 0, drawCalls = 0;
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    for (const p of mesh.listPrimitives()) {
      tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
      drawCalls++;
    }
  }
  const { getBounds } = await import('@gltf-transform/functions');
  const b = getBounds(doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]);
  const size = [0, 1, 2].map((i) => +(b.max[i] - b.min[i]).toFixed(3)) as [number, number, number];
  const textures = doc.getRoot().listTextures().map((t) => `${t.getSize()?.join('x')} ${t.getMimeType().replace('image/', '')}`);
  return { tris, drawCalls, size, textures };
}

export const SIMREADY_CREDIT = (src: string) =>
  `"${src}" from NVIDIA SimReady Assets by NVIDIA Corporation (${nvidiaPage(src)}), CC BY 4.0; web conversion by codepawl (SimReady GLB); modified for Fleet Planner (simplified, re-textured, re-compressed).`;

export function loadManifest(): Manifest {
  const file = join(OUT, 'manifest.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  return {
    format: 'fp-assets', v: 1, generated: '', source: { codepawlRev: CODEPAWL_REV, nvidiaRev: NVIDIA_REV },
    decoder: { name: 'three/examples/jsm/libs/meshopt_decoder.module.js', gzBytes: 0 }, models: {},
  };
}

export function saveManifest(m: Manifest): void {
  const decoder = readFileSync(join(ROOT, 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'));
  m.decoder.gzBytes = gz(decoder);
  m.generated = 'scripts/assets/build-assets.ts';
  const sorted: Record<string, ManifestEntry> = {};
  for (const k of Object.keys(m.models).sort()) sorted[k] = m.models[k];
  m.models = sorted;
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
}

export function printTable(m: Manifest): void {
  const kb = (b?: number) => (b === undefined ? '' : (b / 1024).toFixed(1));
  const rows = Object.entries(m.models).map(([k, e]) => ({
    key: k, first: e.firstTier ? 'yes' : '', tris: e.tris, trisLo: e.trisLo ?? '', dc: e.drawCalls,
    'KB': kb(e.bytes), 'gzKB': kb(e.gzBytes), 'loKB': kb(e.bytesLo), 'loGzKB': kb(e.gzBytesLo),
    tex: e.textures.join(', ').slice(0, 40),
  }));
  console.table(rows);
  const models = Object.values(m.models);
  const first = models.filter((e) => e.firstTier).reduce((s, e) => s + e.gzBytes, 0) + m.decoder.gzBytes;
  const all = models.reduce((s, e) => s + e.gzBytes + (e.gzBytesLo ?? 0), 0) + m.decoder.gzBytes;
  const phone = models.filter((e) => e.firstTier).reduce((s, e) => s + (e.gzBytesLo ?? e.gzBytes), 0) + m.decoder.gzBytes;
  const mb = (b: number) => (b / 1048576).toFixed(2) + ' MB';
  console.log(`decoder ${kb(m.decoder.gzBytes)} KB gz`);
  console.log(`first tier (hi, incl. decoder): ${mb(first)} gz   budget 4 MB`);
  console.log(`everything (hi + lo + decoder): ${mb(all)} gz   budget 15 MB`);
  console.log(`phone low tier (lo, else hi):   ${mb(phone)} gz   budget 2 MB`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  const only = process.argv.slice(2);
  const manifest = loadManifest();
  for (const spec of SHORTLIST) {
    if (only.length && !only.includes(spec.key)) continue;
    const lic = await checkLicense(spec.src);
    if (!lic.ok) {
      console.error(`SKIP ${spec.key}: license not CC BY 4.0 / CC0`, lic);
      continue;
    }
    const t0 = Date.now();
    const hi = await buildTier(spec, spec.hi, false);
    writeFileSync(join(OUT, `${spec.key}.glb`), hi.bytes);
    const entry: ManifestEntry = {
      url: `assets/${spec.key}.glb`, scale: 1, offset: hi.offset, size: hi.size, tris: hi.tris, drawCalls: hi.drawCalls,
      bytes: hi.bytes.byteLength, gzBytes: gz(hi.bytes), textures: hi.textures, parts: hi.parts,
      license: 'CC-BY-4.0', credit: SIMREADY_CREDIT(spec.src),
      source: `nvidia/simready-assets/${spec.src} via codepawl/simready-glb@${CODEPAWL_REV.slice(0, 7)} glb/${spec.src}.glb`,
      firstTier: spec.firstTier, label: spec.label,
    };
    if (spec.lo) {
      const lo = await buildTier(spec, spec.lo, true);
      writeFileSync(join(OUT, `${spec.key}-lo.glb`), lo.bytes);
      Object.assign(entry, {
        urlLo: `assets/${spec.key}-lo.glb`, trisLo: lo.tris, drawCallsLo: lo.drawCalls, bytesLo: lo.bytes.byteLength,
        gzBytesLo: gz(lo.bytes), texturesLo: lo.textures,
      });
    }
    manifest.models[spec.key] = entry;
    console.log(`${spec.key}: ${entry.tris} tris (lo ${entry.trisLo ?? '-'}), ${entry.drawCalls} dc, ${(entry.gzBytes / 1024).toFixed(1)} KB gz, ${Date.now() - t0} ms`);
  }
  const { COMPOSED, composeLoad } = await import('./compose.ts');
  for (const c of COMPOSED) {
    if (only.length && !only.includes(c.key)) continue;
    const hi = await composeLoad(c, OUT, false);
    const lo = await composeLoad(c, OUT, true);
    writeFileSync(join(OUT, `${c.key}.glb`), hi);
    writeFileSync(join(OUT, `${c.key}-lo.glb`), lo);
    const [mh, ml] = await Promise.all([measure(hi), measure(lo)]);
    const srcs = [SHORTLIST.find((s) => s.key === c.pallet)!.src, SHORTLIST.find((s) => s.key === c.carton)!.src];
    manifest.models[c.key] = {
      url: `assets/${c.key}.glb`, urlLo: `assets/${c.key}-lo.glb`, scale: 1, offset: [0, 0, 0], size: mh.size,
      tris: mh.tris, trisLo: ml.tris, drawCalls: mh.drawCalls, drawCallsLo: ml.drawCalls,
      bytes: hi.byteLength, gzBytes: gz(hi), bytesLo: lo.byteLength, gzBytesLo: gz(lo), textures: mh.textures, texturesLo: ml.textures,
      parts: [], license: 'CC-BY-4.0', credit: srcs.map(SIMREADY_CREDIT).join(' '),
      source: `composed from ${srcs.join(' + ')} (scripts/assets/compose.ts)`, firstTier: c.firstTier, label: c.label,
    };
    console.log(`${c.key}: ${mh.tris} tris (lo ${ml.tris}), ${mh.drawCalls} dc, ${(gz(hi) / 1024).toFixed(1)} KB gz`);
  }
  if (!only.length || only.includes('worker')) {
    const { buildWorker } = await import('./build-worker.ts');
    const w = await buildWorker({ outDir: OUT, gz, measure });
    if (w) manifest.models.worker = w;
  }
  saveManifest(manifest);
  if (process.env.SIMPLIFY_LOG) console.log(simplifyLog.join('\n'));
  printTable(manifest);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

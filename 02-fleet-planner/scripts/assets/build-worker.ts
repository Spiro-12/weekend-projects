// Human worker: Quaternius Universal Base Characters (Superhero Male body) + clips from the Universal Animation
// Library (same 65-bone rig), both CC0 (License*.txt inside each zip, checked below). The skin texture is replaced by
// vertex colours painted per body region (bone + height): hi-vis vest with reflective bands, navy long-sleeve shirt,
// work trousers, boots, gloves and a white hard hat. One material, no textures.
// Inputs (gitignored cache, see fetch-quaternius.sh): .cache/quaternius/*.zip, extracted under ubc/ and ual/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Accessor, Document, type Node } from '@gltf-transform/core';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { makeIO, MeshoptEncoder } from './io.ts';
import { ROOT } from './fetch.ts';
import type { ManifestEntry } from './build-assets.ts';

const Q = join(ROOT, '.cache/quaternius');
const UBC_ZIP = join(Q, 'Universal Base Characters[Standard].zip');
const UAL_ZIP = join(Q, 'Universal Animation Library[Standard].zip');
const UBC_DIR = join(Q, 'ubc/Universal Base Characters[Standard]/Base Characters/Godot - UE');
const UAL_GLB = join(Q, 'ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb');
const CLIPS: Record<string, string> = { Walk_Loop: 'walk', Idle_Loop: 'idle', Push_Loop: 'push' };

function licenseIsCC0(zip: string, inner: string): boolean {
  // unzip -p prints one member; brackets in names are escaped for unzip's wildcard matching.
  const pattern = inner.replace(/([[\]])/g, '\\$1');
  const txt = execFileSync('unzip', ['-p', zip, pattern]).toString('utf8');
  return /CC0 1\.0 Universal/.test(txt) && !/QAL/i.test(txt);
}

const srgb = (hex: number): [number, number, number] =>
  [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

const COLORS = {
  vest: srgb(0xd4f01e), // fluorescent yellow-green
  band: srgb(0xb9c0c6), // reflective silver
  shirt: srgb(0x26324a), // navy
  trousers: srgb(0x2b2f36), // charcoal
  boots: srgb(0x15161a),
  gloves: srgb(0x3a3d42),
  skin: srgb(0xc68e6b),
  hat: srgb(0xf2f2ee),
};

export interface WorkerHelpers {
  outDir: string;
  gz: (b: Uint8Array) => number;
  measure: (b: Uint8Array) => Promise<{ tris: number; drawCalls: number; size: [number, number, number]; textures: string[] }>;
}

export async function buildWorker({ outDir, gz, measure }: WorkerHelpers): Promise<ManifestEntry | null> {
  if (!existsSync(UBC_ZIP) || !existsSync(UAL_ZIP)) {
    console.warn('worker: Quaternius zips not cached (run scripts/assets/fetch-quaternius.sh); keeping the previous worker entry');
    return null;
  }
  if (!licenseIsCC0(UBC_ZIP, 'Universal Base Characters[Standard]/License_Standard.txt') ||
      !licenseIsCC0(UAL_ZIP, 'Universal Animation Library[Standard]/License.txt')) {
    throw new Error('worker: a Quaternius pack is not CC0; stop and ask the lead');
  }
  if (!existsSync(UBC_DIR) || !existsSync(UAL_GLB)) {
    execFileSync('unzip', ['-o', '-q', UBC_ZIP, 'Universal Base Characters\\[Standard\\]/Base Characters/Godot - UE/*', '-d', join(Q, 'ubc')]);
    execFileSync('unzip', ['-o', '-q', UAL_ZIP, 'Universal Animation Library\\[Standard\\]/Unreal-Godot/UAL1_Standard.glb', '-d', join(Q, 'ual')]);
  }
  const io = await makeIO();

  // Body: read the .gltf JSON, drop images/textures (we paint vertex colours instead; one is missing anyway).
  const json = JSON.parse(readFileSync(join(UBC_DIR, 'Superhero_Male_FullBody.gltf'), 'utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    delete m.extensions;
  }
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const b of json.buffers) resources[b.uri] = new Uint8Array(readFileSync(join(UBC_DIR, b.uri)));
  const doc: Document = await io.readJSON({ json, resources });
  const root = doc.getRoot();

  // Keep only the body mesh (largest); drop eyes/brows.
  const meshNodes = root.listNodes().filter((n) => n.getMesh());
  const tris = (n: Node) => n.getMesh()!.listPrimitives().reduce((s, p) => s + p.getIndices()!.getCount() / 3, 0);
  meshNodes.sort((a, b) => tris(b) - tris(a));
  for (const n of meshNodes.slice(1)) n.dispose();
  const bodyNode = meshNodes[0];
  const skin = bodyNode.getSkin()!;
  const joints = skin.listJoints();
  const jointName = joints.map((j) => j.getName());

  // Paint vertex colours by region.
  const mat = doc.createMaterial('worker').setRoughnessFactor(0.78).setMetallicFactor(0);
  for (const prim of bodyNode.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!;
    const J = prim.getAttribute('JOINTS_0')!;
    const W = prim.getAttribute('WEIGHTS_0')!;
    const n = pos.getCount();
    let minY = Infinity, maxY = -Infinity;
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, p);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    const H = maxY - minY;
    const col = new Float32Array(n * 3);
    const j4 = [0, 0, 0, 0], w4 = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, p);
      J.getElement(i, j4);
      W.getElement(i, w4);
      let best = 0;
      for (let k = 1; k < 4; k++) if (w4[k] > w4[best]) best = k;
      const bone = jointName[j4[best]] ?? '';
      const h = (p[1] - minY) / H; // 0 feet .. 1 top of head
      let c = COLORS.trousers;
      if (/hand|index|middle|ring|pinky|thumb/.test(bone)) c = COLORS.gloves;
      else if (/upperarm|lowerarm/.test(bone)) c = COLORS.shirt;
      else if (/foot|ball/.test(bone) || h < 0.06) c = COLORS.boots;
      else if (/Head/.test(bone) || /neck/.test(bone)) c = h > 0.95 ? COLORS.hat : COLORS.skin;
      else if (/clavicle/.test(bone) && h > 0.8) c = COLORS.shirt;
      else if (h > 0.5 && h < 0.82) {
        // Vest over the torso, with two reflective bands.
        const band = (h > 0.6 && h < 0.625) || (h > 0.69 && h < 0.715);
        c = band ? COLORS.band : COLORS.vest;
      } else if (h >= 0.82) c = COLORS.shirt;
      col.set(c, i * 3);
    }
    prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(root.listBuffers()[0]));
    for (const sem of prim.listSemantics()) if (/TEXCOORD|TANGENT/.test(sem)) prim.setAttribute(sem, null);
    prim.setMaterial(mat);
  }

  // Animations: copy rotation channels (plus pelvis translation) from the library by bone name.
  const lib = await io.readBinary(new Uint8Array(readFileSync(UAL_GLB)));
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const libPelvis = lib.getRoot().listNodes().find((n) => n.getName() === 'pelvis')!;
  const bodyPelvis = byName.get('pelvis')!;
  const ratio = Math.abs(bodyPelvis.getTranslation()[1]) / Math.max(1e-6, Math.abs(libPelvis.getTranslation()[1]));
  const buffer = root.listBuffers()[0];
  const copyAcc = (a: Accessor, scale = 1) => {
    const arr = new Float32Array(a.getArray()!);
    if (scale !== 1) for (let i = 0; i < arr.length; i++) arr[i] *= scale;
    return doc.createAccessor().setType(a.getType()).setArray(arr).setBuffer(buffer);
  };
  for (const clip of lib.getRoot().listAnimations()) {
    const name = CLIPS[clip.getName()];
    if (!name) continue;
    const anim = doc.createAnimation(name);
    for (const ch of clip.listChannels()) {
      const target = ch.getTargetNode();
      const path = ch.getTargetPath();
      const node = target && byName.get(target.getName());
      if (!node) continue;
      if (path !== 'rotation' && !(path === 'translation' && node.getName() === 'pelvis')) continue;
      const s = ch.getSampler()!;
      const sampler = doc.createAnimationSampler()
        .setInput(copyAcc(s.getInput()!))
        .setOutput(copyAcc(s.getOutput()!, path === 'translation' ? ratio : 1))
        .setInterpolation(s.getInterpolation());
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    }
  }
  await doc.transform(resample(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const bytes = await io.writeBinary(doc);
  writeFileSync(join(outDir, 'worker.glb'), bytes);
  const m = await measure(bytes);
  console.log(`worker: ${m.tris} tris, ${m.drawCalls} dc, ${(gz(bytes) / 1024).toFixed(1)} KB gz, clips ${Object.values(CLIPS).join(', ')}`);
  return {
    url: 'assets/worker.glb', scale: 1, offset: [0, 0, 0], size: m.size, tris: m.tris, drawCalls: m.drawCalls,
    bytes: bytes.byteLength, gzBytes: gz(bytes), textures: [], parts: [], clips: Object.values(CLIPS),
    license: 'CC0-1.0',
    credit: 'Worker body from "Universal Base Characters" and clips from "Universal Animation Library" by Quaternius (https://quaternius.com), CC0 1.0; modified for Fleet Planner (hi-vis vest and work clothes painted as vertex colours, re-compressed).',
    source: 'quaternius.itch.io universal-base-characters [Standard] Superhero_Male_FullBody + universal-animation-library [Standard] UAL1_Standard.glb',
    firstTier: true, label: 'Warehouse worker (hi-vis vest), walk / idle / push',
  };
}

// Composed loads: a pallet with a neat grid of cartons (optionally shrink-wrapped), built from our own optimized
// pallet and carton GLBs (both SimReady, CC BY 4.0). The decimated SimReady pallet assemblies look crumpled at
// rack-prop budgets (≤ 2k triangles), while 12-to-50-triangle textured cartons stay crisp, so in-rack loads are
// composed. Output: one GLB per load, 2 to 3 materials (wood, cardboard, film).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, type Material, type Primitive, type Texture } from '@gltf-transform/core';
import { dequantize, meshopt, prune } from '@gltf-transform/functions';
import { makeIO, MeshoptEncoder } from './io.ts';

export interface ComposeSpec {
  key: string;
  label: string;
  /** Source keys of our own outputs (hi or lo is picked by tier). */
  pallet: string;
  carton: string;
  /** Grid of cartons per layer (x, z) and number of layers. */
  grid: [number, number];
  layers: number;
  /** Stack height in metres (cartons are scaled to fit the grid). */
  height: number;
  film?: boolean;
  firstTier: boolean;
}

interface Geo { pos: Float32Array; nor: Float32Array; uv: Float32Array | null; idx: Uint32Array; mat: Material; min: number[]; max: number[] }

async function readGeo(io: Awaited<ReturnType<typeof makeIO>>, file: string): Promise<{ doc: Document; geo: Geo }> {
  const doc = await io.readBinary(new Uint8Array(readFileSync(file)));
  await doc.transform(dequantize());
  const node = doc.getRoot().listNodes().find((n) => n.getMesh())!;
  const prim: Primitive = node.getMesh()!.listPrimitives()[0];
  const m = node.getWorldMatrix();
  const p = prim.getAttribute('POSITION')!.getArray() as Float32Array;
  const n = prim.getAttribute('NORMAL')!.getArray() as Float32Array;
  const pos = new Float32Array(p.length);
  const nor = new Float32Array(n.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let r = 0; r < 3; r++) {
      pos[i + r] = m[r] * p[i] + m[4 + r] * p[i + 1] + m[8 + r] * p[i + 2] + m[12 + r];
      min[r] = Math.min(min[r], pos[i + r]);
      max[r] = Math.max(max[r], pos[i + r]);
      nor[i + r] = n[i + r]; // quantization transforms are uniform scale + translation, so normals are unchanged
    }
  }
  const uvA = prim.getAttribute('TEXCOORD_0');
  return {
    doc,
    geo: { pos, nor, uv: uvA ? Float32Array.from(uvA.getArray()!) : null, idx: Uint32Array.from(prim.getIndices()!.getArray()!), mat: prim.getMaterial()!, min, max },
  };
}

/** Deterministic jitter (no Math.random so the output is identical every run). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export async function composeLoad(spec: ComposeSpec, outDir: string, lo: boolean): Promise<Uint8Array> {
  const io = await makeIO();
  const suffix = lo ? '-lo' : '';
  const pallet = await readGeo(io, join(outDir, `${spec.pallet}${suffix}.glb`));
  // Carton geometry always comes from the 50-triangle low tier (texture carries the detail); the material and
  // textures come from the tier being built.
  const carton = await readGeo(io, join(outDir, `${spec.carton}-lo.glb`));
  const cartonMat = (await readGeo(io, join(outDir, `${spec.carton}${suffix}.glb`))).geo.mat;
  const out = new Document();
  out.createBuffer();
  const copyTex = (t: Texture | null) => (t ? out.createTexture(t.getName()).setImage(t.getImage()!).setMimeType(t.getMimeType()) : null);
  const copyMat = (m: Material) =>
    out.createMaterial(m.getName())
      .setBaseColorFactor(m.getBaseColorFactor()).setMetallicFactor(m.getMetallicFactor()).setRoughnessFactor(m.getRoughnessFactor())
      .setBaseColorTexture(copyTex(m.getBaseColorTexture()))
      .setMetallicRoughnessTexture(copyTex(m.getMetallicRoughnessTexture()))
      .setNormalTexture(copyTex(m.getNormalTexture()));
  const wood = copyMat(pallet.geo.mat);
  const board = copyMat(cartonMat);

  // Pallet: footprint centred at the origin, already on the floor.
  const pTop = pallet.geo.max[1];
  const [gx, gz] = spec.grid;
  const fx = pallet.geo.max[0] - pallet.geo.min[0];
  const fz = pallet.geo.max[2] - pallet.geo.min[2];
  const cellX = fx / gx, cellZ = fz / gz, cellY = spec.height / spec.layers;
  const c = carton.geo;
  const cw = [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]];
  const rnd = lcg(spec.key.length * 977 + (lo ? 1 : 0));

  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (let ly = 0; ly < spec.layers; ly++) {
    for (let ix = 0; ix < gx; ix++) {
      for (let iz = 0; iz < gz; iz++) {
        const turn = (ix + iz + ly) % 2 === 1; // alternate the printed side for variety
        const yaw = (rnd() - 0.5) * 0.05 + (turn ? Math.PI : 0);
        const sx = (cellX * 0.97) / cw[0], sy = (cellY * 0.98) / cw[1], sz = (cellZ * 0.97) / cw[2];
        const ox = pallet.geo.min[0] + cellX * (ix + 0.5) + (rnd() - 0.5) * 0.012;
        const oz = pallet.geo.min[2] + cellZ * (iz + 0.5) + (rnd() - 0.5) * 0.012;
        const oy = pTop + cellY * ly;
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        const base = P.length / 3;
        for (let i = 0; i < c.pos.length; i += 3) {
          const x = (c.pos[i] - (c.min[0] + c.max[0]) / 2) * sx;
          const y = (c.pos[i + 1] - c.min[1]) * sy;
          const z = (c.pos[i + 2] - (c.min[2] + c.max[2]) / 2) * sz;
          P.push(ox + cs * x + sn * z, oy + y, oz - sn * x + cs * z);
          // Normals under non-uniform scale: n' = normalize(S^-1 n), then rotate.
          let nx = c.nor[i] / sx, ny = c.nor[i + 1] / sy, nz = c.nor[i + 2] / sz;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          N.push(cs * nx + sn * nz, ny, -sn * nx + cs * nz);
        }
        if (c.uv) for (const v of c.uv) U.push(v);
        for (const k of c.idx) I.push(base + k);
      }
    }
  }
  const scene = out.createScene(spec.key);
  const root = out.createNode(spec.key);
  scene.addChild(root);
  const mesh = out.createMesh(`${spec.key}_body`);
  root.addChild(out.createNode('body').setMesh(mesh));
  const prim = (pos: ArrayLike<number>, nor: ArrayLike<number>, uv: ArrayLike<number> | null, idx: ArrayLike<number>, mat: Material) => {
    const p = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(Float32Array.from(pos)))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(Float32Array.from(nor)))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(Uint32Array.from(idx)))
      .setMaterial(mat);
    if (uv) p.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(Float32Array.from(uv)));
    mesh.addPrimitive(p);
  };
  prim(pallet.geo.pos, pallet.geo.nor, pallet.geo.uv, pallet.geo.idx, wood);
  prim(P, N, U.length ? U : null, I, board);

  if (spec.film) {
    // Stretch film: an open-bottom box 1.5 cm proud of the stack, see-through.
    const film = out.createMaterial(`${spec.key}_film`).setBaseColorFactor([0.86, 0.9, 0.95, 0.24]).setAlphaMode('BLEND')
      .setRoughnessFactor(0.18).setMetallicFactor(0).setDoubleSided(true);
    const e = 0.015;
    const x0 = pallet.geo.min[0] - e, x1 = pallet.geo.max[0] + e, z0 = pallet.geo.min[2] - e, z1 = pallet.geo.max[2] + e;
    const y0 = pTop * 0.55, y1 = pTop + spec.height + e;
    const quads: number[][][] = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // +z
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // -z
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // +x
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // -x
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], // top
    ];
    const normals = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]];
    const fp: number[] = [], fn: number[] = [], fi: number[] = [];
    quads.forEach((q, qi) => {
      const b = fp.length / 3;
      for (const v of q) {
        fp.push(...v);
        fn.push(...normals[qi]);
      }
      fi.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    prim(fp, fn, null, fi, film);
  }
  await out.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  return io.writeBinary(out);
}

export const COMPOSED: ComposeSpec[] = [
  { key: 'pallet_loaded', label: 'Pallet of cartons (3 x 2 x 3)', pallet: 'pallet', carton: 'carton_a', grid: [3, 2], layers: 3, height: 0.96, firstTier: true },
  { key: 'pallet_wrapped', label: 'Shrink-wrapped pallet of cartons', pallet: 'pallet', carton: 'carton_c', grid: [3, 2], layers: 4, height: 1.0, film: true, firstTier: true },
];

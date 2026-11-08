// Downloads into the gitignored cache (.cache/simready/). Only the pinned revisions in shortlist.ts are used.
// Downloaded files are data: they are parsed by gltf-transform / sharp / JSON.parse only, never executed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codepawlUrl, nvidiaUrl } from './shortlist.ts';

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
export const CACHE = join(ROOT, '.cache/simready');

async function download(url: string, file: string): Promise<Buffer> {
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(file + '.part', buf);
      renameSync(file + '.part', file);
      return buf;
    }
    if (attempt >= 3 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      throw new Error(`GET ${url} -> ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

/** The source GLB (codepawl `glb/` tier: 100% triangles, 1024 px WebP, meshopt). */
export async function sourceGlb(src: string): Promise<Buffer> {
  return download(codepawlUrl(`glb/${src}.glb`), join(CACHE, 'glb', `${src}.glb`));
}

export interface LicenseCheck {
  asset: string;
  /** `license` field of NVIDIA's com.nvidia.simready.packaging.json. */
  packaging: string;
  /** First line of .metadata/LICENSE.txt that names the license. */
  licenseTxt: string;
  /** codepawl manifest.jsonl `license` field. */
  codepawl: string;
  ok: boolean;
}

let codepawlLicenses: Map<string, string> | undefined;

/** Reads NVIDIA's per-asset license files and codepawl's manifest row. Only CC-BY-4.0 or CC0 passes. */
export async function checkLicense(src: string): Promise<LicenseCheck> {
  const dir = join(CACHE, 'licenses', src);
  const pkg = JSON.parse(
    (await download(nvidiaUrl(`${src}/com.nvidia.simready.packaging.json`), join(dir, 'packaging.json'))).toString('utf8'),
  ) as { license?: string };
  const txt = (await download(nvidiaUrl(`${src}/.metadata/LICENSE.txt`), join(dir, 'LICENSE.txt'))).toString('utf8');
  if (!codepawlLicenses) {
    const lines = (await download(codepawlUrl('manifest.jsonl'), join(CACHE, 'manifest.jsonl'))).toString('utf8');
    codepawlLicenses = new Map();
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { asset: string; license: string };
      codepawlLicenses.set(row.asset, row.license);
    }
  }
  const licenseTxt =
    txt.split('\n').map((l) => l.trim()).find((l) => /Attribution 4\.0 International|CC0|Public Domain/i.test(l)) ?? '(none found)';
  const packaging = String(pkg.license ?? '(missing)');
  const codepawl = codepawlLicenses.get(src) ?? '(missing)';
  const okId = (s: string) => /^(CC-BY-4\.0|CC0-1\.0|CC0)$/i.test(s);
  const ok = okId(packaging) && okId(codepawl) && /Attribution 4\.0 International|CC0/i.test(licenseTxt);
  return { asset: src, packaging, licenseTxt, codepawl, ok };
}

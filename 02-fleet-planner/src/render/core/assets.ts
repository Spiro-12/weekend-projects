// Shared asset loader (lead-owned, PROTOCOL §9): one typed manifest fetch, one GLTFLoader with the meshopt decoder,
// a cache per URL, and tier-aware URL choice (low and lite use `urlLo` when a model has one). Tracks D and E both
// load through this so the low tier never fetches high-detail files and nothing is downloaded twice.
import type { Group } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Tier } from '../../host/index.ts';

export interface ManifestModel {
  url: string;
  urlLo?: string;
  scale: number;
  offset: [number, number, number];
  size: [number, number, number];
  tris: number;
  trisLo?: number;
  drawCalls: number;
  drawCallsLo?: number;
  bytes: number;
  bytesLo?: number;
  gzBytes: number;
  gzBytesLo?: number;
  textures: string[];
  texturesLo?: string[];
  /** Named child nodes that move (forks, mast, carriage, tiller…). */
  parts: string[];
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
  source: Record<string, string>;
  decoder: { name: string; gzBytes: number };
  models: Record<string, ManifestModel>;
}

export function useLow(t: Tier): boolean {
  return t === 'low' || t === 'lite';
}

export class AssetLoader {
  private manifestP: Promise<Manifest> | null = null;
  private cache = new Map<string, Promise<GLTF>>();
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  constructor(private baseUrl: string) {}

  manifest(): Promise<Manifest> {
    this.manifestP ??= fetch(`${this.baseUrl}assets/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
      return r.json() as Promise<Manifest>;
    });
    return this.manifestP;
  }

  /** The URL for a model at a tier (low/lite prefer urlLo). */
  async urlFor(key: string, tier: Tier): Promise<string> {
    const m = (await this.manifest()).models[key];
    if (!m) throw new Error(`asset '${key}' is not in the manifest`);
    return this.baseUrl + (useLow(tier) && m.urlLo ? m.urlLo : m.url);
  }

  /** Load (once) and return the parsed glTF. Callers clone `scene` (SkeletonUtils.clone for skinned models). */
  async gltf(key: string, tier: Tier): Promise<GLTF> {
    const url = await this.urlFor(key, tier);
    let p = this.cache.get(url);
    if (!p) {
      p = this.loader.loadAsync(url);
      this.cache.set(url, p);
    }
    return p;
  }

  /** Convenience: the model's root group (shared; clone before adding twice). */
  async scene(key: string, tier: Tier): Promise<Group> {
    return (await this.gltf(key, tier)).scene;
  }
}

let shared: AssetLoader | null = null;
/** The app-wide loader (one per page). */
export function assetLoader(baseUrl: string): AssetLoader {
  shared ??= new AssetLoader(baseUrl);
  return shared;
}

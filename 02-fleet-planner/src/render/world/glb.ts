// GLB → instanced meshes. A model from the shared loader is split into its primitives (one per material), node
// transforms are baked into cloned geometry (the loader's copy is shared and stays untouched), and each primitive becomes
// one InstancedMesh. Swapping to another LOD keeps the instance matrices and extra per-instance attributes.
import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  type BufferGeometry,
  type Group,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';

export interface GlbPart {
  geometry: BufferGeometry;
  material: Material;
  name: string;
}

/** Primitives of a loaded model with node transforms baked in (fresh geometry, cloned materials). */
export function glbParts(root: Group | Object3D, opts: { envMap?: Texture | null; envMapIntensity?: number } = {}): GlbPart[] {
  const parts: GlbPart[] = [];
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const m = new Matrix4();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geo = dequantize((o.geometry as BufferGeometry).clone());
    geo.applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as Material[];
    const mat = mats[0].clone() as MeshStandardMaterial;
    if (opts.envMap !== undefined && 'envMap' in mat) {
      mat.envMap = opts.envMap;
      if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity;
    }
    parts.push({ geometry: geo, material: mat, name: o.name || mat.name });
  });
  return parts;
}

/**
 * The SimReady files use KHR_mesh_quantization (int16/int8 normalised attributes; the node matrix carries the scale).
 * Baking a transform into a quantised attribute overflows it, so convert every attribute to plain floats first.
 */
function dequantize(geo: BufferGeometry): BufferGeometry {
  const get = ['getX', 'getY', 'getZ', 'getW'] as const;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name);
    const plain = a instanceof BufferAttribute && a.array instanceof Float32Array && !a.normalized;
    if (plain) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a[get[k]](i);
    geo.setAttribute(name, new BufferAttribute(out, a.itemSize));
  }
  return geo;
}

export type ExtraAttr = { name: string; size: number; data: Float32Array };

/** One InstancedMesh per GLB primitive, sharing instance matrices and per-instance attributes. */
export class GlbInstances {
  readonly meshes: InstancedMesh[] = [];
  private parts: GlbPart[] = [];
  private matrices: Float32Array;
  private count = 0;

  constructor(
    readonly name: string,
    readonly capacity: number,
    private extras: ExtraAttr[] = [],
    private patch?: (mat: Material, part: GlbPart) => void,
  ) {
    this.matrices = new Float32Array(Math.max(1, capacity) * 16);
  }

  /** Install (or replace) the model's primitives. Matrices and extras carry over. */
  setParts(parts: GlbPart[], parent: Object3D) {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const p of this.parts) {
      p.geometry.dispose();
      p.material.dispose();
    }
    this.meshes.length = 0;
    this.parts = parts;
    for (const p of parts) {
      for (const e of this.extras) p.geometry.setAttribute(e.name, new InstancedBufferAttribute(e.data, e.size));
      this.patch?.(p.material, p);
      const mesh = new InstancedMesh(p.geometry, p.material, Math.max(1, this.capacity));
      mesh.instanceMatrix.array.set(this.matrices);
      mesh.count = this.count;
      mesh.name = `${this.name}:${p.name}`;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      parent.add(mesh);
    }
    this.flush();
  }

  setMatrix(i: number, m: Matrix4 | ArrayLike<number>) {
    const src = m instanceof Matrix4 ? m.elements : m;
    for (let k = 0; k < 16; k++) this.matrices[i * 16 + k] = src[k];
  }

  copyMatrix(i: number, src: Float32Array, j: number) {
    this.matrices.set(src.subarray(j * 16, j * 16 + 16), i * 16);
  }

  setCount(n: number) {
    this.count = Math.min(n, this.capacity);
  }

  get size() {
    return this.count;
  }

  /** Push matrices, count and extras to the GPU. */
  flush() {
    for (const mesh of this.meshes) {
      (mesh.instanceMatrix.array as Float32Array).set(this.matrices);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = this.count;
      for (const e of this.extras) {
        const a = mesh.geometry.getAttribute(e.name) as InstancedBufferAttribute | undefined;
        if (a) a.needsUpdate = true;
      }
    }
  }

  get triangles(): number {
    let t = 0;
    for (const p of this.parts) t += ((p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3) * this.count;
    return t;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const p of this.parts) {
      p.geometry.dispose();
      p.material.dispose();
    }
    this.meshes.length = 0;
    this.parts = [];
  }
}

// A small "inside a bright warehouse" environment for the world's own materials (envMap per material, so the shared
// scene environment stays the lead's): light walls with a bright window band, a dark roof with rows of LED strips and a
// dark floor. The glossy floor and the steel pick up believable reflections (LED streaks, a light horizon) from it.
import { BackSide, BoxGeometry, Color, Mesh, MeshBasicMaterial, PMREMGenerator, Scene, type Texture, type WebGLRenderer } from 'three';

export function buildHallEnv(renderer: WebGLRenderer): { texture: Texture; dispose(): void } {
  const scene = new Scene();
  const geos: BoxGeometry[] = [];
  const mats: MeshBasicMaterial[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: Color, back = false) => {
    const g = new BoxGeometry(w, h, d);
    const m = new MeshBasicMaterial({ color });
    if (back) m.side = BackSide;
    geos.push(g);
    mats.push(m);
    const mesh = new Mesh(g, m);
    mesh.position.set(x, y, z);
    scene.add(mesh);
  };
  const c = (hex: string, k = 1) => new Color(hex).multiplyScalar(k);
  // Room: 60 × 12 × 60 m around the probe at 1.5 m.
  box(60, 12, 60, 0, 4.5, 0, c('#8d939b', 0.55), true);
  // Floor (dark) and roof (dark steel).
  box(60, 0.1, 60, 0, -1.45, 0, c('#202327', 0.6));
  box(60, 0.1, 60, 0, 10.4, 0, c('#3a3f46', 0.5));
  // Window bands on all four walls (bright daylight).
  for (const [w, d, x, z] of [
    [58, 0.2, 0, -29.8],
    [58, 0.2, 0, 29.8],
    [0.2, 58, -29.8, 0],
    [0.2, 58, 29.8, 0],
  ])
    box(w, 2.2, d, x, 6.8, z, c('#dfe9f5', 2.4));
  // Light grey lower walls.
  for (const [w, d, x, z] of [
    [58, 0.2, 0, -29.6],
    [58, 0.2, 0, 29.6],
    [0.2, 58, -29.6, 0],
    [0.2, 58, 29.6, 0],
  ])
    box(w, 5, d, x, 1.6, z, c('#c9ced5', 0.9));
  // Rows of LED fixtures.
  for (let x = -24; x <= 24; x += 6) for (let z = -24; z <= 24; z += 8) box(0.5, 0.08, 4, x, 9.6, z, c('#ffffff', 9));
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02, 0.1, 100);
  pmrem.dispose();
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  return { texture: rt.texture, dispose: () => rt.dispose() };
}

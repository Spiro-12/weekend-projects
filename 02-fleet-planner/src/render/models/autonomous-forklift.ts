// Autonomous forklift: dresses the walk-behind stacker GLB (`stacker` in the manifest) as a driverless pallet
// stacker. Hides the tiller, adds a sensor mast with a lidar puck, a front safety scanner, an amber warning-light
// strip and the blue safety spot projected on the floor ahead of the forks. Pure geometry + materials.
// Named additions for Track E: `sensorMast`, `lidar` (spin it), `warning` (blink it), `safetySpot` (floor decal).
// The stacker's own nodes stay: `body`, `forks` (lift it), `tiller` (hidden here). Forks point to +z.
import * as THREE from 'three';
import { mergedMesh, place } from './util.ts';

const mats = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = mats.get(key);
  if (!m) mats.set(key, (m = make()));
  return m;
}

let spotTexture: THREE.Texture | null = null;
function spot(): THREE.Texture {
  if (spotTexture) return spotTexture;
  // Radial gradient drawn into a small data texture (no DOM needed).
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - d) ** 1.6;
      const i = (y * n + x) * 4;
      data[i] = 40;
      data[i + 1] = 120;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  spotTexture = new THREE.DataTexture(data, n, n);
  spotTexture.needsUpdate = true;
  return spotTexture;
}

/**
 * @param stacker a clone of the loaded `stacker` GLB scene (it is modified and returned inside a new group).
 */
export function dressAutonomousForklift(stacker: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.name = 'autonomous_forklift';
  g.add(stacker);
  const tiller = stacker.getObjectByName('tiller');
  if (tiller) tiller.visible = false;

  const box = new THREE.Box3().setFromObject(stacker);
  const top = box.max.y;
  const backZ = box.min.z;

  const dark = mat('dark', () => new THREE.MeshStandardMaterial({ name: 'af_dark', color: 0x1c1f24, roughness: 0.45, metalness: 0.5 }));
  const pole = mat('pole', () => new THREE.MeshStandardMaterial({ name: 'af_pole', color: 0xb8bec5, roughness: 0.35, metalness: 0.85 }));
  const amber = mat('amber', () => new THREE.MeshStandardMaterial({ name: 'af_amber', color: 0xffa21a, emissive: 0xff8c00, emissiveIntensity: 2.5, roughness: 0.4 }));
  const blue = mat('blue', () => new THREE.MeshStandardMaterial({ name: 'af_blue', color: 0x3c8cff, emissive: 0x2a7bff, emissiveIntensity: 3, roughness: 0.4 }));

  // Sensor mast at the back: pole, lidar puck on top.
  const mastH = top + 0.32;
  const mast = mergedMesh('sensorMast', [
    place(new THREE.CylinderGeometry(0.022, 0.022, mastH - 0.9, 10), 0, 0.9 + (mastH - 0.9) / 2, backZ + 0.08),
    place(new THREE.BoxGeometry(0.12, 0.06, 0.08), 0, 0.92, backZ + 0.08),
  ], pole);
  g.add(mast);
  const lidar = new THREE.Group();
  lidar.name = 'lidar';
  lidar.position.set(0, mastH, backZ + 0.08);
  lidar.add(mergedMesh('lidar_body', [
    place(new THREE.CylinderGeometry(0.055, 0.06, 0.07, 18), 0, 0.035, 0),
    place(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 18), 0, 0.08, 0),
  ], dark));
  g.add(lidar);

  // Safety scanner low on the drive end (the end opposite the forks).
  g.add(mergedMesh('scanner', [place(new THREE.BoxGeometry(0.16, 0.07, 0.08), 0, 0.24, box.min.z + 0.02)], dark));

  // Amber warning strip across the top of the mast frame + blue LED by the spot.
  const warning = mergedMesh('warning', [place(new THREE.BoxGeometry(0.5, 0.035, 0.035), 0, top - 0.02, backZ + 0.13)], amber);
  warning.castShadow = false;
  g.add(warning);
  const blueLed = mergedMesh('blueLight', [place(new THREE.BoxGeometry(0.06, 0.04, 0.04), 0, top + 0.03, backZ + 0.2)], blue);
  blueLed.castShadow = false;
  g.add(blueLed);

  // Blue safety spot on the floor, 1.6 m ahead of the fork tips.
  const spotMesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.42, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ name: 'af_spot', map: spot(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff }),
  );
  spotMesh.name = 'safetySpot';
  spotMesh.position.set(0, 0.006, box.max.z + 1.6);
  spotMesh.renderOrder = 2;
  g.add(spotMesh);
  return g;
}

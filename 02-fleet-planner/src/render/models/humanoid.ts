// Generic warehouse humanoid robot: clean industrial look (light shell panels, graphite joints, a head with a
// dark sensor visor and a cyan sensor strip), about 1.75 m, no branding. Pure geometry + materials.
// Named limb groups pivot at their joints for a procedural walk (see `poseHumanoid`):
//   humanoid > pelvis > { torso > { head, armL > forearmL, armR > forearmR }, legL > shinL, legR > shinR }
// Forward is +z. Origin on the floor between the feet. About 6k triangles.
import * as THREE from 'three';
import { mergedMesh, place, roundedBox } from './util.ts';

export interface HumanoidOptions {
  /** Accent colour (shoulder panels, sensor strip tint) for vendor differences. */
  accent?: THREE.ColorRepresentation;
}

const mats = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = mats.get(key);
  if (!m) mats.set(key, (m = make()));
  return m;
}

export const HUMANOID_HEIGHT = 1.75;

// Joint heights (metres).
const HIP_Y = 0.92;
const KNEE_DROP = 0.44;
const SHIN = 0.42;
const SHOULDER_Y = 1.44; // world
const UPPER_ARM = 0.3;
const FOREARM = 0.28;

export function buildHumanoid(opts: HumanoidOptions = {}): THREE.Group {
  const accent = new THREE.Color(opts.accent ?? 0xf2a33a);
  const shell = mat('shell', () => new THREE.MeshStandardMaterial({ name: 'hum_shell', color: 0xdfe3e7, roughness: 0.3, metalness: 0.05 }));
  const joint = mat('joint', () => new THREE.MeshStandardMaterial({ name: 'hum_joint', color: 0x2a2e34, roughness: 0.5, metalness: 0.4 }));
  const visor = mat('visor', () => new THREE.MeshStandardMaterial({ name: 'hum_visor', color: 0x07090c, roughness: 0.08, metalness: 0.6 }));
  const sensor = mat('sensor', () => new THREE.MeshStandardMaterial({ name: 'hum_sensor', color: 0x6fe8ff, emissive: 0x39d4ff, emissiveIntensity: 2.4, roughness: 0.3 }));
  const acc = mat(`acc_${accent.getHexString()}`, () => new THREE.MeshStandardMaterial({ name: 'hum_accent', color: accent, roughness: 0.4, metalness: 0.1 }));

  const capsule = (r: number, len: number, seg = 10) => new THREE.CapsuleGeometry(r, len, 3, seg);
  const sphere = (r: number) => new THREE.SphereGeometry(r, 12, 8);

  const root = new THREE.Group();
  root.name = 'humanoid';

  const pelvis = new THREE.Group();
  pelvis.name = 'pelvis';
  pelvis.position.y = HIP_Y;
  root.add(pelvis);
  pelvis.add(
    mergedMesh('pelvis_shell', [place(roundedBox(0.3, 0.14, 0.2, 0.06, 3, 0.01), 0, -0.06, 0)], shell),
    mergedMesh('pelvis_joint', [place(capsule(0.05, 0.22, 8), 0, -0.03, 0, 0, 0, Math.PI / 2)], joint),
  );

  // ── torso (pivot at the waist) ──
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.y = 0.06;
  pelvis.add(torso);
  const chestH = SHOULDER_Y - HIP_Y - 0.06 + 0.04;
  torso.add(
    mergedMesh('torso_shell', [
      place(roundedBox(0.36, chestH * 0.62, 0.22, 0.07, 3, 0.015), 0, chestH * 0.36, 0.005),
      place(roundedBox(0.26, chestH * 0.34, 0.18, 0.06, 3, 0.01), 0, 0.03, 0),
    ], shell),
    mergedMesh('torso_joint', [
      place(capsule(0.07, 0.04, 8), 0, 0.02, 0),
      place(roundedBox(0.24, chestH * 0.55, 0.08, 0.03, 2), 0, chestH * 0.3, -0.13), // battery pack
      place(capsule(0.045, 0.06, 8), 0, chestH + 0.03, 0), // neck
    ], joint),
    mergedMesh('torso_accent', [
      place(new THREE.BoxGeometry(0.2, 0.025, 0.012), 0, chestH * 0.8, 0.12),
    ], acc),
  );

  // ── head (pivot at the neck) ──
  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = chestH + 0.07;
  torso.add(head);
  head.add(
    mergedMesh('head_shell', [place(roundedBox(0.2, 0.22, 0.22, 0.08, 4, 0.02), 0, 0, -0.005)], shell),
    mergedMesh('visor', [place(roundedBox(0.19, 0.085, 0.07, 0.03, 3), 0, 0.09, 0.08)], visor),
  );
  const strip = mergedMesh('sensor', [place(new THREE.BoxGeometry(0.15, 0.012, 0.01), 0, 0.135, 0.116)], sensor);
  strip.castShadow = false;
  head.add(strip);

  // ── arms (pivot at the shoulder, forearm pivot at the elbow) ──
  const shoulderLocalY = SHOULDER_Y - HIP_Y - 0.06;
  for (const side of [1, -1] as const) {
    const s = side === 1 ? 'L' : 'R';
    const arm = new THREE.Group();
    arm.name = `arm${s}`;
    arm.position.set(side * 0.235, shoulderLocalY, 0);
    torso.add(arm);
    arm.add(
      mergedMesh(`arm${s}_joint`, [place(sphere(0.06), 0, 0, 0)], joint),
      mergedMesh(`arm${s}_shell`, [place(capsule(0.045, UPPER_ARM - 0.09), side * 0.012, -UPPER_ARM / 2, 0)], shell),
      mergedMesh(`arm${s}_accent`, [place(roundedBox(0.1, 0.06, 0.13, 0.03, 2), side * 0.02, 0.0, 0)], acc),
    );
    const fore = new THREE.Group();
    fore.name = `forearm${s}`;
    fore.position.set(side * 0.012, -UPPER_ARM, 0);
    arm.add(fore);
    fore.add(
      mergedMesh(`forearm${s}_joint`, [place(sphere(0.042), 0, 0, 0), place(roundedBox(0.07, 0.07, 0.09, 0.02, 2), 0, -FOREARM - 0.06, 0.01)], joint),
      mergedMesh(`forearm${s}_shell`, [place(capsule(0.04, FOREARM - 0.08), 0, -FOREARM / 2, 0)], shell),
    );
  }

  // ── legs (pivot at the hip, shin pivot at the knee) ──
  for (const side of [1, -1] as const) {
    const s = side === 1 ? 'L' : 'R';
    const leg = new THREE.Group();
    leg.name = `leg${s}`;
    leg.position.set(side * 0.11, -0.03, 0);
    pelvis.add(leg);
    leg.add(
      mergedMesh(`leg${s}_joint`, [place(sphere(0.065), 0, 0, 0)], joint),
      mergedMesh(`leg${s}_shell`, [place(capsule(0.065, KNEE_DROP - 0.12), 0, -KNEE_DROP / 2, 0.005)], shell),
    );
    const shin = new THREE.Group();
    shin.name = `shin${s}`;
    shin.position.y = -KNEE_DROP;
    leg.add(shin);
    shin.add(
      mergedMesh(`shin${s}_joint`, [place(sphere(0.055), 0, 0, 0), place(roundedBox(0.11, 0.06, 0.24, 0.04, 3), 0, -SHIN - 0.03, 0.045)], joint),
      mergedMesh(`shin${s}_shell`, [place(capsule(0.055, SHIN - 0.12), 0, -SHIN / 2, 0.01)], shell),
    );
  }

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.name !== 'sensor';
  });
  return root;
}

/**
 * Procedural walk. `phase` in cycles (0..1 repeats), `amount` 0 = standing, 1 = full stride.
 * Writes rotations on the named groups only, so it also works on clones.
 */
export function poseHumanoid(h: THREE.Object3D, phase: number, amount = 1): void {
  const a = phase * Math.PI * 2;
  const get = (n: string) => h.getObjectByName(n);
  const swing = 0.42 * amount;
  for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
    const leg = get(`leg${s}`);
    const shin = get(`shin${s}`);
    const arm = get(`arm${s}`);
    const fore = get(`forearm${s}`);
    const t = a + (sign === 1 ? 0 : Math.PI);
    if (leg) leg.rotation.x = -Math.sin(t) * swing;
    if (shin) shin.rotation.x = Math.max(0, Math.sin(t + Math.PI / 2)) * 0.7 * amount;
    if (arm) arm.rotation.x = Math.sin(t) * swing * 0.7;
    if (fore) fore.rotation.x = -0.25 - Math.max(0, Math.sin(t)) * 0.3 * amount;
  }
  const pelvis = get('pelvis');
  if (pelvis) pelvis.position.y = HIP_Y - Math.abs(Math.cos(a)) * 0.02 * amount;
  const torso = get('torso');
  if (torso) torso.rotation.y = Math.sin(a) * 0.06 * amount;
}

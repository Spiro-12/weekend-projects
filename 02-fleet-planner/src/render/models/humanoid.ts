// Generic industrial humanoid (think Apptronik Apollo / Agility Digit silhouettes, no branding), about 1.72 m.
// Two-tone: white shell panels, light-grey secondary panels, graphite joints and actuators; a rounded helmet head
// with a dark glossy face visor and a thin light line (ACCENT, vendor colour), a matching chest light line.
// One merged geometry with moving parts (PART.LEG_*, SHIN_*, ARM_*, FORE_*) that the rig shader swings about the
// pivots below, and a tote (PART.TOTE) carried in front with both arms when the robot carries one.
// Authored facing +Z, origin on the floor between the feet; baked to face +X. About 6k triangles.
import * as THREE from 'three';
import { bakeParts, EMIT, faceX, G, PART, triCount, xf, type BakedModel, type PartSpec, type RigPivots } from './parts.ts';
import { TOTE_COLOR, toteGeometry } from './amr.ts';
import { roundedBox } from './util.ts';

export const HUMANOID_HEIGHT = 1.72;

const WHITE = 0xe9ecef;
const GREY = 0xb8bfc7;
const JOINT = 0x2a2e35;
const DARK = 0x3a3f47;
const VISOR = 0x05070a;

export function buildHumanoid(): BakedModel {
  const specs: PartSpec[] = [];
  const add = (geo: THREE.BufferGeometry, color: number, part: number = PART.BODY, rough = 0.34, metal = 0, emit: number = EMIT.NONE) =>
    specs.push({ geo, color, part, rough, metal, emit });
  const shell = (geo: THREE.BufferGeometry, part: number = PART.BODY) => add(geo, WHITE, part, 0.32, 0);
  const grey = (geo: THREE.BufferGeometry, part: number = PART.BODY) => add(geo, GREY, part, 0.38, 0.05);
  const joint = (geo: THREE.BufferGeometry, part: number = PART.BODY) => add(geo, JOINT, part, 0.42, 0.55);

  const HIP_Y = 0.87;
  const KNEE_Y = 0.48;
  const SHOULDER_Y = 1.4;
  const ELBOW_Y = 1.13;
  const pivots: RigPivots = {};

  for (const side of [1, -1] as const) {
    const L = side === 1;
    const x = side * 0.1;
    const leg = L ? PART.LEG_L : PART.LEG_R;
    const shin = L ? PART.SHIN_L : PART.SHIN_R;
    // Hip actuator and thigh.
    joint(xf(G.axleX(0.062, 0.11, 14), x + side * 0.01, HIP_Y, 0), leg);
    shell(xf(G.limb(0.092, 0.07, 0.34, 14, 0.92), x, HIP_Y - 0.03, 0.005), leg);
    grey(xf(G.limb(0.05, 0.04, 0.22, 10, 0.8), x, HIP_Y - 0.08, -0.055), leg); // rear thigh actuator
    // Knee actuator with a front cap, shin with a calf actuator, ankle, foot.
    joint(xf(G.axleX(0.056, 0.13, 14), x, KNEE_Y, 0), shin);
    shell(xf(G.sphere(0.05, 12, 8), x, KNEE_Y + 0.005, 0.035, 0, 0, 0, 1, 1.15, 0.7), shin);
    shell(xf(G.limb(0.066, 0.048, 0.34, 14, 0.9), x, KNEE_Y - 0.04, 0.008), shin);
    joint(xf(G.limb(0.034, 0.028, 0.26, 8), x, KNEE_Y - 0.06, -0.05), shin);
    joint(xf(G.axleX(0.04, 0.09, 12), x, 0.1, 0), shin);
    joint(xf(roundedBox(0.11, 0.065, 0.25, 0.045, 3), x, 0.0, 0.045), shin);
    grey(xf(roundedBox(0.095, 0.02, 0.15, 0.04, 3), x, 0.062, 0.07), shin);
    pivots[L ? 'hipL' : 'hipR'] = new THREE.Vector3(x, HIP_Y, 0);
    pivots[L ? 'kneeL' : 'kneeR'] = new THREE.Vector3(x, KNEE_Y, 0);
  }

  // Pelvis, waist, hip covers.
  add(xf(roundedBox(0.3, 0.14, 0.19, 0.07, 4, 0.015), 0, HIP_Y - 0.06, 0), DARK, PART.BODY, 0.45, 0.3);
  for (const side of [1, -1]) shell(xf(G.sphere(0.075, 14, 10), side * 0.135, HIP_Y + 0.01, 0, 0, 0, 0, 0.6, 1, 1.1));
  joint(xf(new THREE.CylinderGeometry(0.1, 0.11, 0.12, 16), 0, HIP_Y + 0.1, 0));
  grey(xf(new THREE.CylinderGeometry(0.112, 0.112, 0.02, 16), 0, HIP_Y + 0.08, 0));

  // Torso: rounded chest shell, light-grey chest plate, light line, dark battery pack on the back.
  shell(xf(roundedBox(0.4, 0.44, 0.24, 0.1, 5, 0.04), 0, 1.02, 0));
  shell(xf(roundedBox(0.3, 0.12, 0.2, 0.08, 4, 0.03), 0, 0.96, 0.005));
  grey(xf(roundedBox(0.29, 0.19, 0.03, 0.012, 2, 0.008), 0, 1.22, 0.112));
  add(xf(new THREE.BoxGeometry(0.17, 0.012, 0.012), 0, 1.4, 0.128), 0xffffff, PART.BODY, 0.4, 0, EMIT.ACCENT);
  add(xf(roundedBox(0.26, 0.28, 0.06, 0.025, 3, 0.01), 0, 1.07, -0.135), DARK, PART.BODY, 0.45, 0.3);
  grey(xf(new THREE.BoxGeometry(0.15, 0.012, 0.012), 0, 1.3, -0.167));

  // Neck and helmet head with a dark glossy visor and a thin light line.
  joint(xf(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 12), 0, 1.5, 0));
  const HEAD_Y = 1.615;
  const hs = (g: THREE.BufferGeometry) => xf(g, 0, HEAD_Y, 0, 0, 0, 0, 0.92, 1.06, 1.02);
  shell(hs(G.sphere(0.112, 20, 14)));
  const visor = new THREE.SphereGeometry(0.1165, 20, 8, Math.PI / 2 - 1.05, 2.1, 1.05, 0.78);
  add(hs(visor), VISOR, PART.BODY, 0.06, 0.6);
  const arc = 1.5;
  const line = new THREE.TorusGeometry(0.118, 0.0045, 4, 18, arc).rotateX(Math.PI / 2).rotateY(arc / 2 - Math.PI / 2);
  add(hs(line).translate(0, 0.005, 0), 0xffffff, PART.BODY, 0.4, 0, EMIT.ACCENT);
  joint(xf(G.axleX(0.04, 0.235, 14), 0, HEAD_Y - 0.005, -0.01));
  grey(xf(G.axleX(0.03, 0.245, 12), 0, HEAD_Y - 0.005, -0.01));

  // Arms: shoulder actuator + cap, upper arm, elbow, forearm, hand.
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const x = side * 0.245;
    const arm = L ? PART.ARM_L : PART.ARM_R;
    const fore = L ? PART.FORE_L : PART.FORE_R;
    shell(xf(new THREE.SphereGeometry(0.088, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), x + side * 0.005, SHOULDER_Y + 0.005, 0, 0, 0, 0, 1, 0.75, 1.1));
    joint(xf(G.sphere(0.066, 12, 10), x, SHOULDER_Y, 0), arm);
    shell(xf(G.limb(0.056, 0.047, 0.21, 12, 0.95), x, SHOULDER_Y - 0.04, 0), arm);
    joint(xf(G.axleX(0.046, 0.1, 12), x, ELBOW_Y, 0), fore);
    grey(xf(G.limb(0.046, 0.04, 0.2, 12, 0.95), x, ELBOW_Y - 0.03, 0), fore);
    joint(xf(roundedBox(0.045, 0.1, 0.085, 0.02, 2), x, ELBOW_Y - 0.33, 0.005), fore);
    pivots[L ? 'shoulderL' : 'shoulderR'] = new THREE.Vector3(x, SHOULDER_Y, 0);
    pivots[L ? 'elbowL' : 'elbowR'] = new THREE.Vector3(x, ELBOW_Y, 0);
  }

  // Tote held in front at the hands (shown with FLAG.TOTE; arms go to the HOLD pose).
  for (const g of toteGeometry(0.4, 0.24, 0.36)) add(xf(g, 0, 0.98, 0.36), TOTE_COLOR, PART.TOTE, 0.55, 0);

  const geometry = bakeParts(specs);
  faceX(geometry, pivots);
  return { geometry, pivots, size: { length: 0.42, width: 0.5, height: HUMANOID_HEIGHT }, stride: 1.15, tris: triCount(geometry) };
}

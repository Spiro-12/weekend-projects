// The building: light walls with a plinth, panel seams and a bright window band, the dock wall with roll-up doors,
// hazard-striped jambs and trailers outside, black steel wall columns, roof trusses and purlins.
// Walls, doors and trailers are one merged mesh (vertex colours + a per-vertex glow for the glass): 1 draw call.
// Steel is one InstancedMesh: 1 draw call. Both cut away per view (cutaway.ts).
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three';
import { CELL_M } from '../core/geom.ts';
import { cutUniforms, patchCutaway, type CutUniforms } from './cutaway.ts';
import { YARD_Y } from './floor.ts';
import { rnd, type WorldPlan } from './plan.ts';

const WALL_T = 0.35;

type Cut = [number, number, number, number];
const NONE: Cut = [0, 0, 0, 0];

/** Accumulates boxes and quads into one non-indexed geometry with colour, glow and cut-away attributes. */
class Merger {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  emit: number[] = [];
  cut: number[] = [];
  grp: number[] = [];
  private c = new Color();

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: string | Color, cut: Cut = NONE, glow = 0, skip: string = '') {
    const c = typeof color === 'string' ? this.c.set(color) : color;
    const faces: [string, number[], number[][]][] = [
      ['px', [1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
      ['nx', [-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
      ['py', [0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
      ['ny', [0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      ['pz', [0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      ['nz', [0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    ];
    for (const [name, n, q] of faces) if (!skip.includes(name)) this.quad(q, n, c, cut, glow, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }

  /** A quad from 4 corners, counter-clockwise seen from the side the normal points to. */
  quad(q: number[][], n: number[], c: Color, cut: Cut, glow: number, gx = 0, gy = 0, gz = 0) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.pos.push(q[i][0], q[i][1], q[i][2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(c.r, c.g, c.b);
      this.emit.push(glow);
      this.cut.push(...cut);
      this.grp.push(gx, gy, gz);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aEmit', new Float32BufferAttribute(this.emit, 1));
    g.setAttribute('aCut', new Float32BufferAttribute(this.cut, 4));
    g.setAttribute('aGroup', new Float32BufferAttribute(this.grp, 3));
    g.computeBoundingSphere();
    return g;
  }
}

export interface Shell {
  walls: Mesh;
  /** Wall signs: "SHIPPING & RECEIVING" over the docks and a number plate over each door (1 draw call). */
  signs: Mesh;
  steel: InstancedMesh;
  uniforms: CutUniforms;
  /** Trailer slots for pallets inside open trailers (x, y, z). */
  trailerPallets: { x: number; y: number; z: number }[];
  /** Openings where the conveyor leaves the building. */
  stats(): Record<string, number>;
  dispose(): void;
}

export function buildShell(p: WorldPlan, envMap: Texture | null): Shell {
  const hx = p.sizeX / 2;
  const hz = p.sizeZ / 2;
  const H = p.wallH;
  const u = cutUniforms(p.trussY0 - 0.5);
  const M = new Merger();
  // Outward normals and plane offsets of the four walls (camera beyond the outer face = outside).
  const north: Cut = [0, -1, hz + WALL_T * 0.5, 1];
  const south: Cut = [0, 1, hz + WALL_T * 0.5, 1];
  const west: Cut = [-1, 0, hx + WALL_T * 0.5, 1];
  const east: Cut = [1, 0, hx + WALL_T * 0.5, 1];
  const part = (c: Cut): Cut => [c[0], c[1], c[2], 2];

  const PLINTH = '#a9aeb5';
  const PANEL = '#d6dae0';
  const SEAM = '#c2c7ce';
  const UPPER = '#cfd4da';
  const CAP = '#8c929a';
  const winY0 = H - 5.0;
  const winY1 = H - 1.0;
  const GLASS = new Color('#cfe0f2');
  const MULLION = '#30353c';

  /**
   * One wall along an axis. `axis` 'x': runs along x at z = zc (inner face at zi); 'z': along z at x = xc.
   * `holes` are [a0, a1, top] openings along the wall (doors), in the running coordinate.
   */
  function wall(axis: 'x' | 'z', a0: number, a1: number, inner: number, dir: number, cut: Cut, holes: [number, number, number][] = []) {
    const outer = inner + dir * WALL_T;
    const t0 = Math.min(inner, outer);
    const t1 = Math.max(inner, outer);
    const B = (s0: number, y0: number, s1: number, y1: number, color: string | Color, c: Cut = cut, glow = 0, i0 = t0, i1 = t1) => {
      if (axis === 'x') M.box(s0, y0, i0, s1, y1, i1, color, c, glow);
      else M.box(i0, y0, s0, i1, y1, s1, color, c, glow);
    };
    // Solid parts between holes, from the yard up to the window band.
    const spans: [number, number][] = [];
    let s = a0;
    for (const [h0, h1] of [...holes].sort((x, y) => x[0] - y[0])) {
      if (h0 > s) spans.push([s, h0]);
      s = Math.max(s, h1);
    }
    if (s < a1) spans.push([s, a1]);
    for (const [s0, s1] of spans) {
      B(s0, YARD_Y, s1, 1.2, PLINTH);
      B(s0, 1.2, s1, winY0, PANEL);
    }
    for (const [h0, h1, top] of holes) {
      B(h0, top, h1, winY0, PANEL);
    }
    // Window band: glass set back from the inner face, mullions every 1.5 m, a transom and sills.
    const gi = inner + dir * 0.18;
    B(a0, winY0, a1, winY1, GLASS, part(cut), 1, Math.min(gi, gi + dir * 0.04), Math.max(gi, gi + dir * 0.04));
    for (let m = a0; m <= a1 + 1e-6; m += 1.5) B(m - 0.05, winY0, m + 0.05, winY1, MULLION, part(cut), 0, Math.min(inner, gi), Math.max(inner, gi));
    B(a0, winY0 - 0.12, a1, winY0, MULLION, part(cut));
    for (const f of [1 / 3, 2 / 3]) {
      const y = winY0 + (winY1 - winY0) * f;
      B(a0, y - 0.04, a1, y + 0.04, MULLION, part(cut), 0, Math.min(inner, gi), Math.max(inner, gi));
    }
    B(a0, winY1, a1, winY1 + 0.1, MULLION, part(cut));
    B(a0, winY1 + 0.1, a1, H, UPPER, part(cut));
    B(a0, H, a1, H + 0.25, CAP, part(cut), 0, t0 - 0.05, t1 + 0.05);
    // Panel seams on the inner face (thin raised strips), every 1.2 m, skipped over openings.
    const si = inner - dir * 0.012;
    for (let m = a0 + 0.6; m < a1; m += 1.2) {
      if (holes.some(([h0, h1]) => m > h0 - 0.1 && m < h1 + 0.1)) continue;
      B(m - 0.025, 1.2, m + 0.025, winY0 - 0.12, SEAM, cut, 0, Math.min(inner, si), Math.max(inner, si));
    }
    // Plinth top edge.
    B(a0, 1.17, a1, 1.23, '#9aa0a7', cut, 0, Math.min(inner, si), Math.max(inner, si));
  }

  // Dock wall (north) with door openings.
  const doorTop = 3.9;
  const holes: [number, number, number][] = p.doors.map((d) => [d.x - d.width / 2 + 0.05, d.x + d.width / 2 - 0.05, doorTop]);
  wall('x', -hx - WALL_T, hx + WALL_T, -hz, -1, north, holes);
  // Conveyor exit in the east wall.
  const convHole: [number, number, number][] = p.conveyor ? [[p.conveyor.z - 0.9, p.conveyor.z + 0.9, 1.9]] : [];
  wall('x', -hx - WALL_T, hx + WALL_T, hz, 1, south);
  wall('z', -hz, hz, -hx, -1, west);
  wall('z', -hz, hz, hx, 1, east, convHole);
  if (p.conveyor) {
    // Strip curtain in the conveyor opening.
    for (let k = 0; k < 9; k++) {
      const z = p.conveyor.z - 0.85 + k * 0.2;
      M.box(hx + 0.12, 1.15, z, hx + 0.14, 1.9, z + 0.17, k % 2 ? '#3d4651' : '#4c5764', part(east));
    }
  }

  // Doors: jambs with hazard stripes, roll-up panels (open, half or closed), leveler plates, bumpers, trailers.
  const trailerPallets: Shell['trailerPallets'] = [];
  const zi = -hz;
  const black = new Color('#15171a');
  const yellow = new Color('#f2c230');
  for (const d of p.doors) {
    const a = d.x - d.width / 2 + 0.05;
    const b = d.x + d.width / 2 - 0.05;
    // Jamb guards: hazard bands up to 2 m on the inner face.
    for (const [j0, j1] of [
      [a - 0.18, a],
      [b, b + 0.18],
    ]) {
      for (let y = 0; y < 2.0; y += 0.25) M.box(j0, y, zi - 0.02, j1, Math.min(2.0, y + 0.25), zi + 0.06, Math.round(y / 0.25) % 2 ? black : yellow, part(north));
      M.box(j0, 2.0, zi - 0.02, j1, doorTop, zi + 0.04, '#7d848c', part(north));
    }
    // Header box with the roll-up drum.
    M.box(a - 0.18, doorTop, zi - 0.02, b + 0.18, doorTop + 0.45, zi + 0.35, '#8a9098', part(north));
    // Roll-up door panel: slats down to the open height.
    const bottom = d.open >= 1 ? doorTop : d.open > 0 ? doorTop - (1 - d.open) * doorTop : 0;
    const slat = 0.22;
    let k = 0;
    for (let y = doorTop; y > bottom + 1e-3; y -= slat, k++) {
      const y0 = Math.max(bottom, y - slat);
      M.box(a, y0, zi - 0.12, b, y, zi - 0.06, k % 2 ? '#9aa6b2' : '#aab5c0', part(north));
    }
    if (bottom > 0 && bottom < doorTop) M.box(a, bottom - 0.08, zi - 0.13, b, bottom, zi - 0.05, '#2b2f35', part(north));
    // Leveler plate in the door well (row 0), slightly raised, with its lip.
    M.box(a + 0.1, 0, -hz + 0.02, b - 0.1, 0.03, -hz + CELL_M - 0.15, '#5f666e', NONE);
    // Dock bumpers outside, at the trailer bed.
    for (const x of [a + 0.25, b - 0.25]) M.box(x - 0.13, -0.45, zi - WALL_T - 0.14, x + 0.13, 0.05, zi - WALL_T, '#111315', NONE);
    // Dock shelter (black seal) around the opening, outside.
    M.box(a - 0.35, -0.2, zi - WALL_T - 0.5, a, doorTop + 0.3, zi - WALL_T, '#1b1d20', part(north));
    M.box(b, -0.2, zi - WALL_T - 0.5, b + 0.35, doorTop + 0.3, zi - WALL_T, '#1b1d20', part(north));
    M.box(a - 0.35, doorTop - 0.1, zi - WALL_T - 0.5, b + 0.35, doorTop + 0.45, zi - WALL_T, '#1b1d20', part(north));
    if (d.open > 0) trailer(d.x, zi - WALL_T - 0.08);
  }

  function trailer(x: number, zBack: number) {
    const w = 2.5;
    const hIn = 2.65;
    const len = 13.6;
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z1 = zBack;
    const z0 = zBack - len;
    const yF = 0.0;
    const white = new Color('#e9ecef');
    const inside = new Color('#9aa1a9');
    const insideFloor = new Color('#6d6458');
    // Exterior: sides and roof (outward), the front wall.
    M.box(x0 - 0.04, yF - 0.06, z0, x0, yF + hIn + 0.1, z1, white, NONE, 0, 'px');
    M.box(x1, yF - 0.06, z0, x1 + 0.04, yF + hIn + 0.1, z1, white, NONE, 0, 'nx');
    M.box(x0 - 0.04, yF + hIn, z0, x1 + 0.04, yF + hIn + 0.1, z1, white, NONE, 0, 'ny');
    M.box(x0, yF - 0.06, z0 - 0.04, x1, yF + hIn, z0, white, NONE, 0, 'pz');
    // Interior (inward faces).
    // A little self-light so the inside reads (the dock lights shine in).
    M.quad([[x0, yF, z1], [x0, yF, z0], [x0, yF + hIn, z0], [x0, yF + hIn, z1]], [1, 0, 0], inside, NONE, 0.12);
    M.quad([[x1, yF, z0], [x1, yF, z1], [x1, yF + hIn, z1], [x1, yF + hIn, z0]], [-1, 0, 0], inside, NONE, 0.12);
    M.quad([[x0, yF + hIn, z0], [x1, yF + hIn, z0], [x1, yF + hIn, z1], [x0, yF + hIn, z1]], [0, -1, 0], inside, NONE, 0.08);
    M.quad([[x0, yF, z1], [x1, yF, z1], [x1, yF, z0], [x0, yF, z0]], [0, 1, 0], insideFloor, NONE, 0.1);
    M.quad([[x1, yF, z0], [x0, yF, z0], [x0, yF + hIn, z0], [x1, yF + hIn, z0]], [0, 0, 1], inside, NONE, 0.12);
    // Rear frame, chassis, wheels, landing legs.
    const fr = '#2a2e33';
    M.box(x0 - 0.06, yF - 0.12, z1 - 0.12, x0 + 0.06, yF + hIn + 0.12, z1, fr, NONE);
    M.box(x1 - 0.06, yF - 0.12, z1 - 0.12, x1 + 0.06, yF + hIn + 0.12, z1, fr, NONE);
    M.box(x0 - 0.06, yF + hIn - 0.04, z1 - 0.12, x1 + 0.06, yF + hIn + 0.12, z1, fr, NONE);
    M.box(x0 - 0.06, yF - 0.12, z1 - 0.12, x1 + 0.06, yF + 0.02, z1, fr, NONE);
    M.box(x0 + 0.3, YARD_Y + 0.55, z0 + 0.5, x1 - 0.3, yF - 0.06, z1 - 0.3, '#1e2125', NONE);
    for (const wz of [z1 - 1.6, z1 - 2.9]) for (const wx of [x0 + 0.05, x1 - 0.35]) M.box(wx, YARD_Y, wz - 0.5, wx + 0.3, YARD_Y + 1.0, wz + 0.5, '#0e0f11', NONE);
    for (const wx of [x0 + 0.5, x1 - 0.6]) M.box(wx, YARD_Y, z0 + 3.0, wx + 0.1, yF - 0.06, z0 + 3.1, '#3a3e44', NONE);
    // Pallets already loaded at the nose of the trailer.
    for (let r = 0; r < 3; r++) for (const dx of [-0.6, 0.6]) if (rnd(r, Math.round(x)) < 0.8) trailerPallets.push({ x: x + dx, y: yF, z: z0 + 0.6 + r * 1.25 });
  }

  const wallsGeo = M.geometry();
  const wallsMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05, envMap, envMapIntensity: 0.7 });
  wallsMat.name = 'walls';
  wallsMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmit;\nvarying float vEmit;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEmit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * (vEmit * 1.15 + 0.2);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, vEmit);');
  };
  patchCutaway(wallsMat, u, { instanced: false });
  const walls = new Mesh(wallsGeo, wallsMat);
  walls.name = 'walls';
  walls.frustumCulled = false;

  // ── Steel: wall columns, roof trusses and purlins ──
  type S = { p: Vector3; s: Vector3; q?: Quaternion; cut: Cut; g: Vector3 };
  const steel: S[] = [];
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const zq = (a: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a);
  const colTop = p.trussY1;
  const colW = 0.32;
  const wallCol = (x: number, z: number, cut: Cut) => {
    steel.push({ p: v(x, 0, z), s: v(colW, colTop, colW), cut: part(cut), g: v(x, colTop / 2, z) });
    steel.push({ p: v(x, 0, z), s: v(colW + 0.16, 0.04, colW + 0.16), cut: part(cut), g: v(x, 0, z) });
  };
  const inset = colW / 2 + 0.02;
  for (const z of p.trussZ) {
    wallCol(-hx + inset, z, west);
    wallCol(hx - inset, z, east);
  }
  for (let x = -hx + 6; x < hx - 3; x += 6) {
    if (!p.doors.some((d) => Math.abs(d.x - x) < d.width / 2 + 0.5)) wallCol(x, -hz + inset, north);
    wallCol(x, hz - inset, south);
  }
  // Trusses span east-west over the whole hall, every 6 m; a zig-zag web between two chords.
  const y0 = p.trussY0;
  const y1 = p.trussY1;
  const depth = y1 - y0;
  // Roof pieces fade on their own screen position (each chord is split into 6 m pieces for that).
  const roof: Cut = [0, 0, 0, 3];
  const panel = 3;
  for (const z of p.trussZ) {
    for (let x = -hx; x < hx - 1e-3; x += 2 * panel) {
      const w = Math.min(2 * panel, hx - x);
      const g = v(x + w / 2, (y0 + y1) / 2, z);
      steel.push({ p: v(x + w / 2, y1 - 0.2, z), s: v(w, 0.2, 0.22), cut: roof, g });
      steel.push({ p: v(x + w / 2, y0, z), s: v(w, 0.18, 0.2), cut: roof, g });
    }
    for (let x = -hx + 1.5, i = 0; x < hx - 1.4; x += panel, i++) {
      const g = v(x + panel / 2, (y0 + y1) / 2, z);
      steel.push({ p: v(x, y0, z), s: v(0.1, depth, 0.1), cut: roof, g });
      const len = Math.hypot(panel, depth - 0.3);
      const a = Math.atan2(depth - 0.3, panel) * (i % 2 ? -1 : 1);
      steel.push({ p: v(x + panel / 2, y0 + depth / 2 - 0.04, z), s: v(len, 0.08, 0.08), q: zq(a), cut: roof, g });
    }
  }
  // Purlins run north-south on top of the trusses, every 3 m; one instance per truss bay so each fades on its own.
  const tz = [-hz, ...p.trussZ, hz];
  for (let x = -hx + 3; x < hx - 1; x += 3)
    for (let i = 0; i + 1 < tz.length; i++) {
      const za = tz[i];
      const zb = tz[i + 1];
      steel.push({ p: v(x, y1, (za + zb) / 2), s: v(0.12, 0.18, zb - za), cut: roof, g: v(x, y1, (za + zb) / 2) });
    }

  const unit = new BoxGeometry(1, 1, 1);
  unit.translate(0, 0.5, 0);
  const cutA = new Float32Array(steel.length * 4);
  const grpA = new Float32Array(steel.length * 3);
  steel.forEach((s, i) => {
    cutA.set(s.cut, i * 4);
    grpA.set([s.g.x, s.g.y, s.g.z], i * 3);
  });
  unit.setAttribute('aCut', new InstancedBufferAttribute(cutA, 4));
  unit.setAttribute('aGroup', new InstancedBufferAttribute(grpA, 3));
  const steelMat = new MeshStandardMaterial({ color: '#2b2f36', roughness: 0.55, metalness: 0.6, envMap, envMapIntensity: 0.8 });
  steelMat.name = 'steel';
  patchCutaway(steelMat, u, { instanced: true });
  const steelMesh = new InstancedMesh(unit, steelMat, steel.length);
  const m = new Matrix4();
  const q0 = new Quaternion();
  const tmp = new Vector3();
  steel.forEach((s, i) => {
    // Rotated members are centred on their midpoint: shift by half the (rotated) height.
    if (s.q) {
      tmp.set(0, -s.s.y / 2, 0).applyQuaternion(s.q);
      m.compose(tmp.add(s.p), s.q, s.s);
    } else m.compose(s.p, q0, s.s);
    steelMesh.setMatrixAt(i, m);
  });
  steelMesh.name = 'steel';
  steelMesh.frustumCulled = false;

  const signs = buildSigns(p, u, envMap, doorTop);

  return {
    walls,
    signs: signs.mesh,
    steel: steelMesh,
    uniforms: u,
    trailerPallets,
    stats: () => ({ wallTris: wallsGeo.getAttribute('position').count / 3, steelParts: steel.length }),
    dispose() {
      signs.dispose();
      wallsGeo.dispose();
      wallsMat.dispose();
      unit.dispose();
      steelMat.dispose();
      steelMesh.dispose();
    },
  };
}

/** Signs on the dock wall, painted on one small canvas: a zone banner and door numbers. Cut away with the wall. */
function buildSigns(p: WorldPlan, u: CutUniforms, envMap: Texture | null, doorTop: number) {
  const W = 1024;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const font = (px: number) => `800 ${px}px ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  // Banner (top 128 px): white letters on safety blue with a yellow rule.
  g.fillStyle = '#1f4f9a';
  g.fillRect(0, 0, W, 128);
  g.fillStyle = '#f2c230';
  g.fillRect(0, 112, W, 16);
  g.fillStyle = '#ffffff';
  g.font = font(74);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('SHIPPING & RECEIVING', W / 2, 58, W - 40);
  // Door plates (bottom 128 px): up to 8 cells of 128 px, a yellow plate with a black number.
  for (let i = 0; i < 8; i++) {
    g.fillStyle = '#f2c230';
    g.fillRect(i * 128 + 4, 132, 120, 120);
    g.fillStyle = '#15171a';
    g.font = font(84);
    g.fillText(String(i + 1), i * 128 + 64, 196);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const cut: number[] = [];
  const grp: number[] = [];
  const hz = p.sizeZ / 2;
  const zf = -hz + 0.03;
  const quad = (x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number) => {
    const pts = [
      [x0, y0, u0, v0],
      [x1, y0, u1, v0],
      [x1, y1, u1, v1],
      [x0, y0, u0, v0],
      [x1, y1, u1, v1],
      [x0, y1, u0, v1],
    ];
    for (const [x, y, uu, vv] of pts) {
      pos.push(x, y, zf);
      uv.push(uu, vv);
      nrm.push(0, 0, 1);
      cut.push(0, -1, hz + 0.175, 2);
      grp.push(0, 0, 0);
    }
  };
  // Banner over the widest gap between doors near the middle; a number plate above each door.
  const ds = [...p.doors].sort((a, b) => a.x - b.x);
  let gap = { x: 0, w: Math.min(16, p.sizeX * 0.3) };
  let best = Infinity;
  for (let i = 0; i + 1 < ds.length; i++) {
    const a = ds[i].x + ds[i].width / 2;
    const b = ds[i + 1].x - ds[i + 1].width / 2;
    const score = Math.abs((a + b) / 2) - (b - a);
    if (score < best) {
      best = score;
      gap = { x: (a + b) / 2, w: b - a };
    }
  }
  const bw = Math.min(16, gap.w - 1);
  const by = doorTop + 0.55;
  quad(gap.x - bw / 2, by, gap.x + bw / 2, by + bw / 8, 0, 0.5, 1, 1);
  p.doors.forEach((d, i) => {
    const k = i % 8;
    quad(d.x - 0.35, doorTop + 0.6, d.x + 0.35, doorTop + 1.3, k / 8, 0, (k + 1) / 8, 0.5);
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aCut', new Float32BufferAttribute(cut, 4));
  geo.setAttribute('aGroup', new Float32BufferAttribute(grp, 3));
  geo.computeBoundingSphere();
  const mat = new MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new Color(0.45, 0.45, 0.45), roughness: 0.6, envMap, envMapIntensity: 0.5 });
  mat.name = 'signs';
  patchCutaway(mat, u, { instanced: false });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'signs';
  mesh.frustumCulled = false;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}

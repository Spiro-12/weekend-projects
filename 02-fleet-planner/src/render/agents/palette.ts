// Agent colours (Gate 0 visual review): vendor light bands, type colours for floor glow discs and route ribbons
// (vendor shade within the type), effect colours, and display names for the hover label.
import { Color } from 'three';
import type { AgentTypeId } from '../../contracts/types.ts';

/** Vendor light bands: A cyan, D violet, B orange, C mint. */
export const VENDOR_LIGHT: Record<string, number> = { A: 0x22d3ee, D: 0xa78bfa, B: 0xff8a3d, C: 0x6ee7b7 };
export const DEFAULT_LIGHT = 0xe8f4ff;

/** Type colours for ribbons and glow discs: AMRs cyan, forklifts orange, humanoids violet, people hi-vis. */
export const TYPE_COLOR: Record<AgentTypeId, number> = { amr: 0x22d3ee, forklift: 0xff8a3d, humanoid: 0xa78bfa, picker: 0xc8f031, driver: 0xffb020 };

/** Small hue / lightness shifts so vendors of one type read as shades of the type colour. */
const VENDOR_SHADE: Record<string, [number, number]> = { A: [0, 0], B: [0.035, 0.06], C: [-0.035, 0.02], D: [0.06, -0.05] };

const cache = new Map<string, Color>();
/** Linear type colour with the vendor shade (cached). */
export function typeShade(type: AgentTypeId, vendor: string): Color {
  const key = `${type}/${vendor}`;
  let c = cache.get(key);
  if (!c) {
    c = new Color(TYPE_COLOR[type] ?? 0xffffff);
    const [h, l] = VENDOR_SHADE[vendor] ?? [0, 0];
    c.offsetHSL(h, 0, l);
    cache.set(key, c);
  }
  return c;
}

export const FX = {
  select: new Color(0x38e1ff),
  blocked: new Color(0xffb020),
  deadlock: new Color(0xff3b3b),
  waitFor: new Color(0xffc531),
  safetySpot: new Color(0x2a7bff),
};

export const TYPE_LABEL: Record<AgentTypeId, string> = {
  amr: 'cart robot',
  forklift: 'autonomous forklift',
  humanoid: 'humanoid',
  picker: 'picker',
  driver: 'forklift driver',
};

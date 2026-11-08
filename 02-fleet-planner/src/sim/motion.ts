// Integer motion helpers shared by the real sim and FakeSim (PROTOCOL §1).
// Speed is millimetres per tick; each agent carries its leftover distance so average speed is exact
// (no rounding to whole ticks per cell). A move between neighbouring cells needs CELL_MM.
import { CELL_MM, TICK_MS, type AgentSpec, type Heading } from '../contracts/types.ts';

/** mm per tick from a spec speed in m/s (rounded once, at load time). */
export function mmPerTick(spec: Pick<AgentSpec, 'speedMps'>): number {
  return Math.max(1, Math.round(spec.speedMps.value * TICK_MS));
}

/**
 * Start a one-cell move with `carryMm` banked from the previous move. Returns how many ticks it takes and the carry
 * left after arriving. Over continuous movement the average speed equals mmPerTick exactly.
 * PROTOCOL §1: the remainder carries only while moving continuously in a straight line. Any turn (`turned`, even for
 * agents with turnTicks 0) or a stop (pass carryMm = 0) resets it; turn ticks add time but no distance.
 */
export function moveTicks(carryMm: number, speedMmPerTick: number, turnTicks = 0, turned = turnTicks > 0): { ticks: number; carryMm: number } {
  const banked = turned ? 0 : carryMm;
  const need = CELL_MM - banked;
  const ticks = need <= 0 ? 1 : Math.ceil(need / speedMmPerTick);
  const carry = banked + ticks * speedMmPerTick - CELL_MM;
  return { ticks: ticks + turnTicks, carryMm: Math.min(carry, CELL_MM - 1) };
}

/** Heading of a move from cell a to neighbour b on a grid of `width` cells. */
export function headingOf(a: number, b: number, width: number): Heading {
  if (b === a + 1) return 0;
  if (b === a + width) return 1;
  if (b === a - 1) return 2;
  return 3;
}

/** Number of 90° turns between two headings (0, 1 or 2). */
export function turns(h1: Heading, h2: Heading): number {
  const d = Math.abs(h1 - h2);
  return d === 3 ? 1 : d;
}

/** Integer ticks for a dwell given in seconds (rounded up). */
export function secToTicks(sec: number): number {
  return Math.max(1, Math.ceil((sec * 1000) / TICK_MS));
}

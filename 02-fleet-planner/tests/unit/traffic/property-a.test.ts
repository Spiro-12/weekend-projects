// Property tests, seeds 1..25 (property-b runs 26..50). See property.ts.
import { describe, expect, it } from 'vitest';
import { NO_VIOLATIONS, PROPERTY_TICKS, propertyRun } from './property.ts';

const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

describe(`one brain, property tests: seeds ${SEEDS[0]}-${SEEDS[SEEDS.length - 1]} x ${PROPERTY_TICKS} ticks`, () => {
  it.each(SEEDS)('seed %i: no overlap, swap, forklift on ".", robot into a person or into a cell being vacated', (seed) => {
    const r = propertyRun(seed);
    expect(r.violations).toEqual(NO_VIOLATIONS);
    expect(r.moves).toBeGreaterThan(10_000);
    expect(r.goals).toBeGreaterThan(200);
    expect(r.personMoves).toBeGreaterThan(1_000);
  });
});

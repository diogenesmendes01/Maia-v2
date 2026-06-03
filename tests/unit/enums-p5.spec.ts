import { describe, it, expect } from 'vitest';
import {
  GapLevel,
  ProposalStatus,
  CapabilityTestOutcome,
} from '@/types/enums.js';

describe('P5 enums', () => {
  it('GapLevel has 4 values', () => {
    expect(Object.values(GapLevel).sort()).toEqual([
      'dashboard',
      'mentionable',
      'proposed',
      'silent',
    ]);
  });
  it('ProposalStatus values match snapshot', () => {
    expect(Object.values(ProposalStatus)).toMatchInlineSnapshot(`
      [
        "draft",
        "submitted",
        "approved",
        "testing",
        "rejected",
        "delivered",
        "reverted",
      ]
    `);
  });
  it('CapabilityTestOutcome has 3 values', () => {
    expect(Object.values(CapabilityTestOutcome).sort()).toEqual(['error', 'fail', 'pass']);
  });
});

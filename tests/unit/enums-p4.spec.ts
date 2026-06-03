import { describe, it, expect } from 'vitest';
import {
  DriftType,
  DriftSeverity,
  ProfileStatus,
  DriftDecision,
} from '@/types/enums.js';

describe('P4 enums', () => {
  // P4 baseline: 7 detectores (tom, valores, confianca, vies, escopo, linguagem, procedimento).
  // P8b adicionou SOUL_DRIFT (8º). P8d adicionou PAPEL_DRIFT (9º).
  it('DriftType has 9 values (P4 baseline + P8b soul_drift + P8d papel_drift)', () => {
    expect(Object.values(DriftType)).toHaveLength(9);
  });
  it('DriftSeverity has 4 values', () => {
    expect(Object.values(DriftSeverity)).toHaveLength(4);
  });
  it('ProfileStatus = proposed/active/frozen/rolled_back', () => {
    expect(Object.values(ProfileStatus).sort()).toEqual([
      'active',
      'frozen',
      'proposed',
      'rolled_back',
    ]);
  });
  it('DriftDecision has 4 values', () => {
    expect(Object.values(DriftDecision)).toHaveLength(4);
  });
});

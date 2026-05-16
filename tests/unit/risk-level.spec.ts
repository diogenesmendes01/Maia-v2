/**
 * P9c — risk level utility tests.
 *
 * Garantem ordenação total + invariante anti-downgrade.
 */
import { describe, it, expect } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import {
  compareRiskLevel,
  maxRiskLevel,
  isAtLeast,
  RISK_LEVELS_ASCENDING,
} from '@/shared/risk/level.ts';

describe('risk level utilities', () => {
  it('RISK_LEVELS_ASCENDING está em ordem total', () => {
    expect(RISK_LEVELS_ASCENDING).toEqual([
      RiskLevel.LOW,
      RiskLevel.MEDIUM,
      RiskLevel.HIGH,
      RiskLevel.CRITICAL,
    ]);
  });

  describe('compareRiskLevel', () => {
    it('retorna 0 para iguais', () => {
      expect(compareRiskLevel(RiskLevel.LOW, RiskLevel.LOW)).toBe(0);
      expect(compareRiskLevel(RiskLevel.CRITICAL, RiskLevel.CRITICAL)).toBe(0);
    });

    it('retorna -1 quando a < b', () => {
      expect(compareRiskLevel(RiskLevel.LOW, RiskLevel.MEDIUM)).toBe(-1);
      expect(compareRiskLevel(RiskLevel.MEDIUM, RiskLevel.HIGH)).toBe(-1);
      expect(compareRiskLevel(RiskLevel.HIGH, RiskLevel.CRITICAL)).toBe(-1);
      expect(compareRiskLevel(RiskLevel.LOW, RiskLevel.CRITICAL)).toBe(-1);
    });

    it('retorna 1 quando a > b', () => {
      expect(compareRiskLevel(RiskLevel.CRITICAL, RiskLevel.HIGH)).toBe(1);
      expect(compareRiskLevel(RiskLevel.HIGH, RiskLevel.LOW)).toBe(1);
    });

    it('é antissimétrico: cmp(a,b) = -cmp(b,a)', () => {
      for (const a of RISK_LEVELS_ASCENDING) {
        for (const b of RISK_LEVELS_ASCENDING) {
          // Normaliza -0 para 0 (Math.sign pode produzir -0 quando o
          // operando original é 0). A asserção semântica é "soma zero".
          expect(compareRiskLevel(a, b) + compareRiskLevel(b, a)).toBe(0);
        }
      }
    });

    it('é transitivo: a<=b e b<=c => a<=c', () => {
      const levels = RISK_LEVELS_ASCENDING;
      for (const a of levels) {
        for (const b of levels) {
          for (const c of levels) {
            const ab = compareRiskLevel(a, b) <= 0;
            const bc = compareRiskLevel(b, c) <= 0;
            const ac = compareRiskLevel(a, c) <= 0;
            if (ab && bc) expect(ac).toBe(true);
          }
        }
      }
    });
  });

  describe('maxRiskLevel', () => {
    it('retorna o maior dos dois', () => {
      expect(maxRiskLevel(RiskLevel.LOW, RiskLevel.MEDIUM)).toBe(RiskLevel.MEDIUM);
      expect(maxRiskLevel(RiskLevel.HIGH, RiskLevel.LOW)).toBe(RiskLevel.HIGH);
      expect(maxRiskLevel(RiskLevel.CRITICAL, RiskLevel.HIGH)).toBe(RiskLevel.CRITICAL);
    });

    it('é commutativo (sempre retorna o de maior rank)', () => {
      for (const a of RISK_LEVELS_ASCENDING) {
        for (const b of RISK_LEVELS_ASCENDING) {
          // Em empates, retorna o primeiro argumento, mas o RANK é igual.
          const m1 = maxRiskLevel(a, b);
          const m2 = maxRiskLevel(b, a);
          // Devem ter o mesmo rank (mesmo nível, possivelmente operandos
          // distintos só em ties que são idênticos).
          expect(compareRiskLevel(m1, m2)).toBe(0);
        }
      }
    });
  });

  describe('isAtLeast', () => {
    it('true quando a >= b', () => {
      expect(isAtLeast(RiskLevel.MEDIUM, RiskLevel.LOW)).toBe(true);
      expect(isAtLeast(RiskLevel.LOW, RiskLevel.LOW)).toBe(true);
      expect(isAtLeast(RiskLevel.CRITICAL, RiskLevel.HIGH)).toBe(true);
    });

    it('false quando a < b', () => {
      expect(isAtLeast(RiskLevel.LOW, RiskLevel.MEDIUM)).toBe(false);
      expect(isAtLeast(RiskLevel.MEDIUM, RiskLevel.CRITICAL)).toBe(false);
    });
  });
});

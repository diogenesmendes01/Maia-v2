/**
 * P9c — risk level utility tests.
 *
 * Garantem ordenação total + invariante anti-downgrade.
 *
 * Codex review #97 finding 3: compare/max agora fail-closed em entradas
 * runtime inválidas (não-string, string fora do enum, undefined). Antes,
 * `RANK[bad]` virava undefined e o operador comparador produzia NaN +
 * propagava o valor inválido — corrompia o ScoredRisk.level final.
 */
import { describe, it, expect } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import {
  compareRiskLevel,
  maxRiskLevel,
  maxRiskLevelSafe,
  isAtLeast,
  isRiskLevel,
  assertRiskLevel,
  InvalidRiskLevelError,
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

  // ----------------------------------------------------------------------
  // Codex review #97 finding 3 — runtime validation fail-closed
  // ----------------------------------------------------------------------

  describe('isRiskLevel (type guard runtime)', () => {
    it('true para todos os níveis válidos', () => {
      for (const lvl of RISK_LEVELS_ASCENDING) {
        expect(isRiskLevel(lvl)).toBe(true);
      }
    });

    it('false para strings fora do enum', () => {
      expect(isRiskLevel('super_high')).toBe(false);
      expect(isRiskLevel('LOW')).toBe(false); // case-sensitive
      expect(isRiskLevel('')).toBe(false);
    });

    it('false para tipos não-string', () => {
      expect(isRiskLevel(undefined)).toBe(false);
      expect(isRiskLevel(null)).toBe(false);
      expect(isRiskLevel(0)).toBe(false);
      expect(isRiskLevel(1)).toBe(false);
      expect(isRiskLevel(true)).toBe(false);
      expect(isRiskLevel({})).toBe(false);
      expect(isRiskLevel([])).toBe(false);
    });

    it('false para chaves "tóxicas" de Object.prototype', () => {
      // Garantia anti hasOwnProperty poisoning.
      expect(isRiskLevel('__proto__')).toBe(false);
      expect(isRiskLevel('constructor')).toBe(false);
      expect(isRiskLevel('toString')).toBe(false);
    });
  });

  describe('assertRiskLevel', () => {
    it('não throw em valores válidos', () => {
      expect(() => assertRiskLevel(RiskLevel.LOW)).not.toThrow();
      expect(() => assertRiskLevel('critical')).not.toThrow();
    });

    it('throw InvalidRiskLevelError em inválido', () => {
      expect(() => assertRiskLevel('super_high')).toThrow(InvalidRiskLevelError);
      expect(() => assertRiskLevel(undefined)).toThrow(InvalidRiskLevelError);
      expect(() => assertRiskLevel(3)).toThrow(InvalidRiskLevelError);
    });

    it('mensagem do erro carrega contexto', () => {
      try {
        assertRiskLevel('xyz', 'test context');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRiskLevelError);
        expect((err as InvalidRiskLevelError).context).toBe('test context');
        expect((err as InvalidRiskLevelError).value).toBe('xyz');
      }
    });
  });

  describe('compareRiskLevel — fail-closed em inválido', () => {
    it('throw em string fora do enum', () => {
      expect(() =>
        compareRiskLevel('bogus' as unknown as RiskLevel, RiskLevel.LOW),
      ).toThrow(InvalidRiskLevelError);
      expect(() =>
        compareRiskLevel(RiskLevel.LOW, 'bogus' as unknown as RiskLevel),
      ).toThrow(InvalidRiskLevelError);
    });

    it('throw em undefined', () => {
      expect(() =>
        compareRiskLevel(undefined as unknown as RiskLevel, RiskLevel.LOW),
      ).toThrow(InvalidRiskLevelError);
    });

    it('throw em número', () => {
      expect(() =>
        compareRiskLevel(3 as unknown as RiskLevel, RiskLevel.LOW),
      ).toThrow(InvalidRiskLevelError);
    });

    it('NUNCA retorna NaN (regressão Codex)', () => {
      // Antes do fix: RANK[bad] = undefined ⇒ undefined - 0 = NaN ⇒
      // Math.sign(NaN) = NaN. Agora throw, então o caller decide.
      for (const lvl of RISK_LEVELS_ASCENDING) {
        for (const other of RISK_LEVELS_ASCENDING) {
          const r = compareRiskLevel(lvl, other);
          expect(Number.isNaN(r)).toBe(false);
          expect([-1, 0, 1]).toContain(r);
        }
      }
    });
  });

  describe('maxRiskLevel — fail-closed em inválido', () => {
    it('throw em operando inválido', () => {
      expect(() =>
        maxRiskLevel('bogus' as unknown as RiskLevel, RiskLevel.LOW),
      ).toThrow(InvalidRiskLevelError);
      expect(() =>
        maxRiskLevel(RiskLevel.HIGH, 'bogus' as unknown as RiskLevel),
      ).toThrow(InvalidRiskLevelError);
    });

    it('NUNCA retorna string fora do enum (regressão Codex)', () => {
      // Antes do fix: maxRiskLevel('high', 'bogus') podia retornar 'bogus'
      // se RANK['bogus'] resolvesse para undefined e a comparação fosse
      // false ('high' >= undefined === false). Agora throw.
      for (const lvl of RISK_LEVELS_ASCENDING) {
        for (const other of RISK_LEVELS_ASCENDING) {
          const r = maxRiskLevel(lvl, other);
          expect(isRiskLevel(r)).toBe(true);
        }
      }
    });
  });

  describe('maxRiskLevelSafe — tolerante a um operando inválido', () => {
    it('retorna o operando válido se outro for inválido', () => {
      expect(maxRiskLevelSafe('bogus', RiskLevel.LOW)).toBe(RiskLevel.LOW);
      expect(maxRiskLevelSafe(RiskLevel.HIGH, undefined)).toBe(RiskLevel.HIGH);
      expect(maxRiskLevelSafe(null, RiskLevel.MEDIUM)).toBe(RiskLevel.MEDIUM);
    });

    it('throw se AMBOS forem inválidos', () => {
      expect(() => maxRiskLevelSafe('bogus', undefined)).toThrow(InvalidRiskLevelError);
    });

    it('quando ambos válidos, comporta-se como maxRiskLevel', () => {
      expect(maxRiskLevelSafe(RiskLevel.LOW, RiskLevel.HIGH)).toBe(RiskLevel.HIGH);
      expect(maxRiskLevelSafe(RiskLevel.CRITICAL, RiskLevel.LOW)).toBe(RiskLevel.CRITICAL);
    });
  });
});

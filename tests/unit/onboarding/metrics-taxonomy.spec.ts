/**
 * Issue #519 — as MÉTRICAS da saga, depois da review do PR #541.
 *
 * O defeito: `wizard.ts` emitia por `@/lib/metrics` DIRETO, contornando o
 * allowlist de chaves, a guarda de PII, o budget de cardinalidade e a
 * atribuição automática de tenant/agente de `src/observability/metrics.ts`. Os
 * labels `reason` (do `reason_code` do cancelamento), `error_code` e
 * `check_code` são ENTRADA DO CHAMADOR: texto operacional — ou PII — entrava no
 * label, e a série era ilimitada.
 *
 * O que este arquivo prova, sem banco:
 *   1. os vocabulários fechados de `taxonomy.ts` são EXATAMENTE os conjuntos do
 *      código (passos e códigos de check) — nenhum pode divergir em silêncio;
 *   2. `closedVocabulary` colapsa qualquer coisa fora do contrato;
 *   3. um `reason_code` com PII (telefone, e-mail) NÃO vira label;
 *   4. mil `reason_code` distintos produzem UMA série, não mil;
 *   5. as métricas emitidas estão declaradas em `METRIC`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CLOSED_VOCABULARY_FALLBACK,
  METRIC,
  METRIC_NAMES,
  ONBOARDING_REASONS,
  ONBOARDING_STEP_VALUES,
  READINESS_CHECK_CODE_VALUES,
  closedVocabulary,
} from '../../../src/observability/taxonomy.js';
import { ONBOARDING_STEPS } from '../../../src/onboarding/state-machine.js';
import { ONBOARDING_ERROR_CODES } from '../../../src/onboarding/errors.js';
import { READINESS_CHECK_CODES } from '../../../src/onboarding/readiness.js';
import { sanitizeLabels, _resetLabelGuardForTests, _cardinalityFor } from '../../../src/observability/labels.js';

beforeEach(() => _resetLabelGuardForTests());

describe('vocabulários fechados — espelho EXATO do código', () => {
  it('`step` cobre exatamente os passos da máquina de estados', () => {
    expect([...ONBOARDING_STEP_VALUES].sort()).toEqual([...ONBOARDING_STEPS].sort());
  });

  it('`check_code` cobre exatamente os códigos de readiness', () => {
    expect([...READINESS_CHECK_CODE_VALUES].sort()).toEqual([...READINESS_CHECK_CODES].sort());
  });

  it('`reason` contém todo código de erro tipado da saga', () => {
    for (const code of ONBOARDING_ERROR_CODES) {
      expect(ONBOARDING_REASONS, `código '${code}' não declarado no vocabulário`).toContain(code);
    }
    // O sanitizador de exceção também emite este:
    expect(ONBOARDING_REASONS).toContain('internal_error');
  });

  it('o fallback está no próprio vocabulário — senão ele mesmo seria colapsado', () => {
    expect(ONBOARDING_REASONS).toContain(CLOSED_VOCABULARY_FALLBACK);
  });
});

describe('closedVocabulary — o texto livre do chamador nunca vira label', () => {
  it('deixa passar o que está no contrato', () => {
    expect(closedVocabulary('activate', ONBOARDING_STEP_VALUES)).toBe('activate');
    expect(closedVocabulary('readiness_blocked', ONBOARDING_REASONS)).toBe('readiness_blocked');
  });

  it.each([
    'cliente +55 11 98765-4321 desistiu',
    'joao@acme.com pediu cancelamento',
    'motivo livre digitado pelo operador',
    '',
  ])('colapsa o texto livre %j', (raw) => {
    expect(closedVocabulary(raw, ONBOARDING_REASONS)).toBe(CLOSED_VOCABULARY_FALLBACK);
  });

  it('colapsa null/undefined', () => {
    expect(closedVocabulary(null, ONBOARDING_REASONS)).toBe(CLOSED_VOCABULARY_FALLBACK);
    expect(closedVocabulary(undefined, ONBOARDING_REASONS)).toBe(CLOSED_VOCABULARY_FALLBACK);
  });

  it('mil motivos distintos produzem UMA série, não mil', () => {
    // A prova de que a explosão de cardinalidade é impossível ANTES do budget:
    // o vocabulário fechado já reduziu tudo a um único valor.
    const emitted = new Set(
      Array.from({ length: 1000 }, (_, i) =>
        closedVocabulary(`motivo-livre-${i}`, ONBOARDING_REASONS),
      ),
    );
    expect(emitted).toEqual(new Set([CLOSED_VOCABULARY_FALLBACK]));
  });
});

describe('a camada sanitizada aceita os labels da saga', () => {
  it('`step` e `check_code` estão no allowlist e sobrevivem à sanitização', () => {
    const { labels, violations } = sanitizeLabels(METRIC.ONBOARDING_STEP_COMPLETED, {
      step: 'activate',
      tenant_id: 'acme',
      agent_id: 'acme-bot',
    });
    expect(violations).toEqual([]);
    expect(labels).toEqual({ step: 'activate', tenant_id: 'acme', agent_id: 'acme-bot' });
  });

  it('`error_code` NÃO está no allowlist — por isso a saga usa `reason`', () => {
    // Este era o label do código antigo. Se alguém o reintroduzir, ele é
    // simplesmente DESCARTADO (a série perde a dimensão em silêncio), e é por
    // isso que a correção troca a chave em vez de alargar o allowlist.
    const { labels, violations } = sanitizeLabels(METRIC.ONBOARDING_STEP_FAILED, {
      error_code: 'readiness_blocked',
    });
    expect(labels.error_code).toBeUndefined();
    expect(violations.map((v) => v.reason)).toContain('key_not_allowed');
  });

  it('um `reason` com telefone é redigido pela guarda de PII', () => {
    // Defesa em profundidade: mesmo que o vocabulário fechado fosse removido,
    // a camada sanitizada não deixaria o número virar série.
    const { labels, violations } = sanitizeLabels(METRIC.ONBOARDING_RUN_CANCELLED, {
      reason: '+5511987654321',
    });
    expect(labels.reason).toBe('__sanitized__');
    expect(violations.map((v) => v.reason)).toContain('value_pii');
  });

  it('o budget de `check_code` é respeitado pelo guarda', () => {
    for (const code of READINESS_CHECK_CODE_VALUES) {
      sanitizeLabels(METRIC.AGENT_READINESS_FAILED, { check_code: code });
    }
    expect(_cardinalityFor(METRIC.AGENT_READINESS_FAILED, 'check_code')).toBe(
      READINESS_CHECK_CODE_VALUES.length,
    );
  });
});

describe('as séries da saga estão DECLARADAS', () => {
  it('todo nome emitido por wizard.ts está em METRIC', () => {
    for (const name of [
      METRIC.ONBOARDING_RUN_STARTED,
      METRIC.ONBOARDING_RUN_CANCELLED,
      METRIC.ONBOARDING_RUN_COMPLETED,
      METRIC.ONBOARDING_STEP_COMPLETED,
      METRIC.ONBOARDING_STEP_FAILED,
      METRIC.ONBOARDING_IDEMPOTENCY_REPLAY,
      METRIC.ONBOARDING_STEP_DURATION_MS,
      METRIC.AGENT_READINESS_FAILED,
    ]) {
      expect(METRIC_NAMES).toContain(name);
    }
  });

  it('`wizard.ts` não importa mais `@/lib/metrics` direto', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../../../src/onboarding/wizard.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from '@\/lib\/metrics/);
    expect(src).toMatch(/from '@\/observability\/metrics/);
  });
});

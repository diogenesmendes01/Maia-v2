/**
 * Issue #504 §"Notas de implementação" — `maia_turn_job_version_total{version}`
 * é o critério MENSURÁVEL de remoção do caminho V1 ("zero jobs V1 observados
 * por uma janela definida").
 *
 * Antes desta entrega `jobVersionLabel` (`src/runtime/turns/job.ts`) existia e
 * NINGUÉM a emitia: o critério de remoção era uma frase na issue, não um
 * número que alguém pudesse consultar. Este arquivo fixa as três coisas que
 * fazem dele um número confiável:
 *
 *   1. o vocabulário do label é ESPELHO do que `jobVersionLabel` pode devolver
 *      — uma quarta forma de payload não pode virar série sem passar pela
 *      taxonomia;
 *   2. `version` está no allowlist de chaves com budget próprio, então o rótulo
 *      passa pelo sanitizador em vez de sair cru;
 *   3. a emissão vai pela camada de POLÍTICA (`observability/metrics.ts`),
 *      que anexa `tenant_id`/`agent_id` — a exigência que a #601/PR #607
 *      estabeleceu para toda série nova.
 *
 * A prova de que o WORKER de verdade a emite é de integração (real Redis):
 * `tests/integration/turn-job-v2-queue-real-redis.spec.ts`. Aqui só o contrato.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALLOWED_LABEL_KEYS,
  CLOSED_VOCABULARY_FALLBACK,
  LABEL_CARDINALITY_BUDGET,
  METRIC,
  METRIC_NAMES,
  TURN_JOB_VERSION_VALUES,
  TURN_SCOPE_REJECTION_VALUES,
  closedVocabulary,
} from '../../../src/observability/taxonomy.js';
import { counter } from '../../../src/observability/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';
import { runWithTenantContext } from '../../../src/db/tenant-context.js';
import { jobVersionLabel, parseAgentTurnJob } from '../../../src/runtime/turns/job.js';

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
});

const UUID_A = '11111111-1111-4111-8111-111111111111';

async function versionSeries(): Promise<string[]> {
  const exposicao = await renderPrometheus();
  return exposicao.split('\n').filter((l) => l.startsWith(METRIC.TURN_JOB_VERSION));
}

describe('#504 — o vocabulário de `version` é espelho de `jobVersionLabel`', () => {
  it('as três formas de payload que o parser produz são exatamente o vocabulário', () => {
    const observados = [
      jobVersionLabel(parseAgentTurnJob({ version: 2, turn_id: UUID_A })),
      jobVersionLabel(parseAgentTurnJob({ mensagem_id: UUID_A })),
      jobVersionLabel(parseAgentTurnJob({ lixo: true })),
    ].sort();
    expect(observados).toEqual(['invalid', 'v1', 'v2']);
    expect([...TURN_JOB_VERSION_VALUES].sort()).toEqual(observados);
  });

  it('as duas séries novas estão declaradas na taxonomia', () => {
    expect(METRIC_NAMES).toContain(METRIC.TURN_JOB_VERSION);
    expect(METRIC_NAMES).toContain(METRIC.TURN_SCOPE_REJECTED);
  });

  it('`version` é chave PERMITIDA e tem budget próprio', () => {
    expect(ALLOWED_LABEL_KEYS.has('version')).toBe(true);
    expect(LABEL_CARDINALITY_BUDGET.version).toBeGreaterThanOrEqual(
      TURN_JOB_VERSION_VALUES.length + 1,
    );
  });

  it('um valor fora do vocabulário COLAPSA antes de virar série', () => {
    expect(closedVocabulary('v3', TURN_JOB_VERSION_VALUES)).toBe(CLOSED_VOCABULARY_FALLBACK);
    expect(closedVocabulary(undefined, TURN_JOB_VERSION_VALUES)).toBe(
      CLOSED_VOCABULARY_FALLBACK,
    );
  });

  it('os motivos de recusa do resolvedor também são um vocabulário fechado', () => {
    expect([...TURN_SCOPE_REJECTION_VALUES].sort()).toEqual([
      'malformed_turn_id',
      'representative_missing',
      'scope_mismatch',
      'scope_unusable',
      'turn_not_found',
    ]);
    expect(closedVocabulary('qualquer_coisa', TURN_SCOPE_REJECTION_VALUES)).toBe(
      CLOSED_VOCABULARY_FALLBACK,
    );
  });
});

describe('#504 — a emissão passa pela camada que ATRIBUI tenant/agent', () => {
  it('dentro de um escopo de tenant, a série sai atribuída ao par real', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'acme-bot' }, async () => {
      counter(METRIC.TURN_JOB_VERSION, { version: 'v2' });
    });
    const linhas = await versionSeries();
    expect(linhas.join('\n')).toContain('tenant_id="acme"');
    expect(linhas.join('\n')).toContain('agent_id="acme-bot"');
    expect(linhas.join('\n')).toContain('version="v2"');
  });

  it('FORA de escopo (o caso do worker, no parse) cai no `system` sancionado — nunca `default`', async () => {
    counter(METRIC.TURN_JOB_VERSION, { version: 'v1' });
    const texto = (await versionSeries()).join('\n');
    expect(texto).toContain('tenant_id="system"');
    expect(texto).not.toContain('tenant_id="default"');
  });
});

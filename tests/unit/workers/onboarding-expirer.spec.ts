/**
 * Issue #519 (GATE 5) — o worker `onboarding_expirer`.
 *
 * O que estes testes provam, e por que são feitos ASSIM:
 *
 *   - a entrada existe no REGISTRY DE PRODUÇÃO (`src/workers/index.ts`) com o
 *     nome, a cadência e a fase combinados. Nenhum teste aqui monta scheduler
 *     próprio: todos partem de `JOBS` e chamam `job.fn` — apagar a entrada do
 *     array deixa TODO este arquivo vermelho, que é exatamente o defeito que
 *     um teste-espelho não pegaria;
 *   - a `fn` registrada chama `onboardingRunsRepo.expireStale` PASSANDO O
 *     LIMITE DE LOTE (o repo tem default próprio; o worker não pode depender
 *     dele nem varrer sem teto);
 *   - uma corrida que falha não propaga para o scheduler;
 *   - a observabilidade não fica muda: contagem de expiradas na série de
 *     cancelamento (`reason='expired'`) e resultado da corrida em
 *     `maia_worker_run_total`.
 *
 * O comportamento de BANCO (run vencida expira, run viva sobrevive, o lote
 * corta em `limit`) é provado contra Postgres real em
 * `tests/integration/onboarding-expirer-worker.spec.ts` — aqui o repo é falso
 * de propósito, para isolar o call site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { expireStale } = vi.hoisted(() => ({ expireStale: vi.fn(async () => 0) }));

vi.mock('@/db/repositories/onboarding-repos.js', () => ({
  onboardingRunsRepo: { expireStale },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { renderPrometheus, _resetForTests } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { JOBS } from '@/workers/index.js';
import {
  ONBOARDING_EXPIRER_BATCH_LIMIT,
  runOnboardingExpirer,
} from '@/workers/onboarding-expirer.js';

function registryJob() {
  return JOBS.find((j) => j.name === 'onboarding_expirer');
}

describe('worker onboarding_expirer (issue #519)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expireStale.mockImplementation(async () => 0);
    _resetForTests();
    _resetLabelGuardForTests();
  });

  describe('entrada no registry', () => {
    it('está registrada a cada 5 minutos, na fase 1', () => {
      const job = registryJob();
      expect(job).toBeDefined();
      // Cadência é decisão do dono: 5 minutos.
      expect(job!.cron).toBe('*/5 * * * *');
      // startWorkers(1) ignora phase > 1 — fase 2+ nunca rodaria em produção.
      expect(job!.phase).toBe(1);
      expect(job!.fn).toBe(runOnboardingExpirer);
    });

    it('a fn registrada é a que chama expireStale (não um stub)', async () => {
      const job = registryJob();
      expect(job).toBeDefined();
      await job!.fn();
      expect(expireStale).toHaveBeenCalledTimes(1);
    });
  });

  describe('lote', () => {
    it('passa o limite de lote explicitamente para expireStale', async () => {
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenCalledWith(expect.any(Date), ONBOARDING_EXPIRER_BATCH_LIMIT);
      const [, limit] = expireStale.mock.calls[0] as unknown as [Date, number];
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(100);
    });

    it('faz UMA passada por tick — não varre em laço até esvaziar', async () => {
      // Lote cheio = ainda há fila. O tick seguinte pega o resto; este NÃO
      // pode ficar girando (seguraria conexões por minutos num backlog).
      expireStale.mockImplementation(async () => ONBOARDING_EXPIRER_BATCH_LIMIT);
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ expired: ONBOARDING_EXPIRER_BATCH_LIMIT }),
        'onboarding_expirer.batch_capped',
      );
    });
  });

  describe('falha de uma corrida', () => {
    it('não propaga para o scheduler', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await expect(registryJob()!.fn()).resolves.toBeUndefined();
    });

    it('a corrida seguinte roda normalmente depois de uma falha', async () => {
      expireStale.mockImplementationOnce(async () => {
        throw new Error('connection terminated');
      });
      await registryJob()!.fn();
      expireStale.mockImplementationOnce(async () => 2);
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 2 }),
        'onboarding_expirer.done',
      );
    });

    it('deixa a falha visível no log e na métrica (não morre calado)', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await registryJob()!.fn();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'deadlock detected' }),
        'onboarding_expirer.failed',
      );
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="error",tenant_id="system",worker="onboarding_expirer"} 1',
      );
    });
  });

  describe('observabilidade', () => {
    it('conta as runs expiradas na série de cancelamento, com reason=expired', async () => {
      expireStale.mockImplementation(async () => 3);
      await registryJob()!.fn();
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="system",reason="expired",tenant_id="system"} 3',
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 3 }),
        'onboarding_expirer.done',
      );
    });

    /**
     * `counter()` resolve `tenant_id`/`agent_id` LENDO O ALS no instante da
     * emissão (`src/observability/metrics.ts:38`) e só cai em `system` quando
     * o ALS está VAZIO. Numa cadeia de cron ele está — mas isso é propriedade
     * do ambiente, não do código: bastaria alguém invocar o worker de dentro
     * de um contexto de tenant (ou um escopo vazar de um tick anterior) para a
     * série de housekeeping sair rotulada com aquele tenant, e ninguém veria.
     *
     * Estes dois casos simulam exatamente esse vazamento: rodam a `fn` do
     * registry DENTRO de um `runWithTenantContext` e exigem `system`. Com as
     * emissões fora do `runWithSystemContext`, ambos ficam vermelhos com o
     * tenant vazado no rótulo.
     */
    it('rotula com system DECLARADO, mesmo invocada dentro do ALS de outro tenant', async () => {
      expireStale.mockImplementation(async () => 3);
      await runWithTenantContext({ tenant_id: 'tenant-vazado', agent_id: 'bot-vazado' }, () =>
        registryJob()!.fn(),
      );
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="system",reason="expired",tenant_id="system"} 3',
      );
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="ok",tenant_id="system",worker="onboarding_expirer"} 1',
      );
      // Nenhuma série de housekeeping pode carregar o escopo vazado.
      expect(out).not.toContain('tenant-vazado');
      expect(out).not.toContain('bot-vazado');
    });

    it('rotula com system também no caminho de erro, sob ALS de outro tenant', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await runWithTenantContext({ tenant_id: 'tenant-vazado', agent_id: 'bot-vazado' }, () =>
        registryJob()!.fn(),
      );
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="error",tenant_id="system",worker="onboarding_expirer"} 1',
      );
      expect(out).not.toContain('tenant-vazado');
    });

    it('registra a corrida bem-sucedida mesmo quando não havia nada a expirar', async () => {
      await registryJob()!.fn();
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="ok",tenant_id="system",worker="onboarding_expirer"} 1',
      );
      // Tick vazio não polui o log de INFO.
      expect(logger.debug).toHaveBeenCalledWith('onboarding_expirer.idle');
      expect(out).not.toContain('maia_onboarding_run_cancelled_total');
    });
  });
});

/**
 * Issue #519 (GATE 5 + atribuição por escopo) — o worker `onboarding_expirer`.
 *
 * O que estes testes provam, e por que são feitos ASSIM:
 *
 *   - a entrada existe no REGISTRY DE PRODUÇÃO (`src/workers/index.ts`) com o
 *     nome, a cadência e a fase combinados. Nenhum teste aqui monta scheduler
 *     próprio: todos partem de `JOBS` e chamam `job.fn` — apagar a entrada do
 *     array deixa TODO este arquivo vermelho, que é exatamente o defeito que
 *     um teste-espelho não pegaria;
 *   - a `fn` registrada chama `onboardingRunsRepo.expireStale` PASSANDO O
 *     LIMITE DE LOTE, e esse limite vem do CONTRATO DE CONFIGURAÇÃO
 *     (`ONBOARDING_EXPIRER_BATCH_LIMIT`): "100 a cada 5 minutos" não é
 *     contrato, é default operacional ajustável;
 *   - a série de cancelamento sai ATRIBUÍDA A CADA RUN (`tenant_id + agent_id`),
 *     não uma vez sob `system` — inclusive quando o ALS de outro tenant está
 *     vazado por cima da corrida;
 *   - a run SEM tenant (o `global_bootstrap`, que vence antes de existir
 *     tenant) continua expirada e contada, no bucket sancionado `system`;
 *   - uma corrida que falha não propaga para o scheduler.
 *
 * O comportamento de BANCO (run vencida expira, run viva sobrevive, o lote
 * corta em `limit`, o backlog encolhe) é provado contra Postgres real em
 * `tests/integration/onboarding-expirer-worker.spec.ts` — aqui o repo é falso
 * de propósito, para isolar o call site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExpireResult = {
  total: number;
  by_scope: { tenant_id: string | null; agent_id: string | null; total: number }[];
};

const { expireStale, batchLimit } = vi.hoisted(() => ({
  expireStale: vi.fn(async (): Promise<ExpireResult> => ({ total: 0, by_scope: [] })),
  /** Teto de lote servido pelo contrato de configuração — mutável por caso. */
  batchLimit: { value: 100 },
}));

vi.mock('@/db/repositories/onboarding-repos.js', () => ({
  onboardingRunsRepo: { expireStale },
}));

/**
 * Só `ONBOARDING_EXPIRER_BATCH_LIMIT` é interceptado; todo o resto do contrato
 * continua sendo o objeto REAL. Um mock de config inteiro quebraria
 * `@/workers/index.js` (que lê outras variáveis) e o teste passaria a provar o
 * mock, não o worker.
 */
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, key, receiver) =>
        key === 'ONBOARDING_EXPIRER_BATCH_LIMIT'
          ? batchLimit.value
          : Reflect.get(target, key, receiver),
    }),
  };
});

/** Açúcar: um único escopo com `total` runs. */
function scope(
  tenant_id: string | null,
  agent_id: string | null,
  total: number,
): ExpireResult['by_scope'][number] {
  return { tenant_id, agent_id, total };
}

/** Resultado de `expireStale` a partir dos escopos, com o total coerente. */
function result(...by_scope: ExpireResult['by_scope']): ExpireResult {
  return { total: by_scope.reduce((acc, s) => acc + s.total, 0), by_scope };
}

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { renderPrometheus, _resetForTests } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import {
  JOBS,
  _internal as workersInternal,
  _resetWorkerStateForTests,
  activeWorkerJobs,
} from '@/workers/index.js';
import { runOnboardingExpirer } from '@/workers/onboarding-expirer.js';

function registryJob() {
  return JOBS.find((j) => j.name === 'onboarding_expirer');
}

describe('worker onboarding_expirer (issue #519)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchLimit.value = 100;
    expireStale.mockImplementation(async () => ({ total: 0, by_scope: [] }));
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
      expect(expireStale).toHaveBeenCalledWith(expect.any(Date), 100);
      const [, limit] = expireStale.mock.calls[0] as unknown as [Date, number];
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    });

    /**
     * O achado do dono na revisão de #555: "100 a cada 5 minutos" não pode
     * virar CONTRATO. O teto é um default operacional, e o operador precisa
     * poder mexer nele sem redeploy de código — por isso ele é uma variável do
     * contrato de configuração e é LIDA A CADA CORRIDA, não uma constante
     * compilada. Com a constante de volta, este caso fica vermelho.
     */
    it('o teto do lote vem do contrato de configuração, e é ajustável', async () => {
      batchLimit.value = 7;
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenCalledWith(expect.any(Date), 7);

      // Ajustável DE VERDADE: sem reimportar o módulo, o tick seguinte já usa o
      // valor novo (uma captura no import congelaria o primeiro).
      batchLimit.value = 250;
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenLastCalledWith(expect.any(Date), 250);
    });

    it('faz UMA passada por tick — não varre em laço até esvaziar', async () => {
      // Lote cheio = ainda há fila. O tick seguinte pega o resto; este NÃO
      // pode ficar girando (seguraria conexões por minutos num backlog).
      batchLimit.value = 3;
      expireStale.mockImplementation(async () =>
        result(scope('t1', 'a1', 2), scope('t2', 'a2', 1)),
      );
      await registryJob()!.fn();
      expect(expireStale).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 3, limit: 3 }),
        'onboarding_expirer.batch_capped',
      );
    });
  });

  describe('falha de uma corrida', () => {
    /** Roda o tick pelo caminho REAL do registry e espera a corrida terminar. */
    async function runRegistryTick(): Promise<void> {
      workersInternal.runTick(registryJob()!);
      while (activeWorkerJobs().includes('onboarding_expirer')) {
        await new Promise((r) => setTimeout(r, 2));
      }
    }

    /**
     * O contrato do registry (`src/workers/index.ts:247-255`): resolver é
     * SUCESSO. Uma corrida que engolisse o erro carimbaria
     * `maia_worker_last_success_timestamp` a cada 5 minutos durante uma
     * indisponibilidade de banco — falso sucesso novo por tick, exatamente na
     * telemetria que `docs/runbooks/operational.md` manda usar para achar
     * worker quebrado. Por isso a corrida REJEITA depois de logar e medir.
     */
    it('rejeita para o registry marcar failure (e não falso sucesso)', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await expect(registryJob()!.fn()).rejects.toThrow(/onboarding_expirer/);
    });

    it('move o gauge de FALHA do registry — e não o de sucesso', async () => {
      _resetWorkerStateForTests();
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });

      await runRegistryTick();

      const out = await renderPrometheus();
      const failure = Number(
        /maia_worker_last_failure_timestamp\{worker="onboarding_expirer"\} (\d+)/.exec(
          out,
        )?.[1] ?? '0',
      );
      const success = Number(
        /maia_worker_last_success_timestamp\{worker="onboarding_expirer"\} (\d+)/.exec(
          out,
        )?.[1] ?? '0',
      );
      expect(failure).toBeGreaterThan(0);
      expect(success).toBe(0);
      // O registry viu a falha e a registrou como tal.
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ job: 'onboarding_expirer' }),
        'worker.failed',
      );
    });

    it('o scheduler segue vivo: a corrida seguinte roda e marca sucesso', async () => {
      _resetWorkerStateForTests();
      expireStale.mockImplementationOnce(async () => {
        throw new Error('connection terminated');
      });
      await runRegistryTick();
      expireStale.mockImplementationOnce(async () => result(scope('acme', 'ana', 2)));
      await runRegistryTick();

      expect(expireStale).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 2 }),
        'onboarding_expirer.done',
      );
      const out = await renderPrometheus();
      expect(
        /maia_worker_last_success_timestamp\{worker="onboarding_expirer"\} (\d+)/.exec(out)?.[1],
      ).not.toBe('0');
    });

    it('o erro que sobe é estável e NÃO carrega credencial', async () => {
      // #533: este repositório já vazou `DATABASE_URL` por stderr cru. O erro
      // que atravessa a fronteira do worker é construído por nós, nunca o do
      // driver.
      expireStale.mockImplementation(async () => {
        throw new Error(
          'connect ECONNREFUSED postgres://maia_test:test1234@localhost:5432/maia_test',
        );
      });

      await expect(registryJob()!.fn()).rejects.toThrow(/onboarding_expirer/);
      const thrown = await registryJob()!
        .fn()
        .then(() => null)
        .catch((e: Error) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain('test1234');
      expect((thrown as Error).message).not.toContain('postgres://');
      // Nem a mensagem, nem `cause`, nem o stack.
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain('test1234');
      // E o log da corrida também não.
      const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
      expect(logged).not.toContain('test1234');
      expect(logged).toContain('[REDACTED_URL]');
    });

    it('deixa a falha visível no log e na métrica (não morre calado)', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await expect(registryJob()!.fn()).rejects.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'deadlock detected', name: 'Error' }),
        'onboarding_expirer.failed',
      );
      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="error",tenant_id="system",worker="onboarding_expirer"} 1',
      );
    });
  });

  describe('observabilidade — atribuição por escopo', () => {
    /**
     * A decisão do dono na revisão de #555: a varredura roda global sob
     * `system`, mas a SÉRIE de cancelamento é atribuída ao `tenant_id +
     * agent_id` de cada run. O motivo é que o cancelamento pelo console
     * (`src/onboarding/wizard.ts`) emite ESTA MESMA série já atribuída ao
     * tenant real — com o varredor emitindo tudo sob `system`, a mesma série
     * tinha duas atribuições conforme quem cancelou.
     */
    it('emite UMA série por escopo, com o tenant e o agente de cada run', async () => {
      expireStale.mockImplementation(async () =>
        result(scope('acme', 'ana', 2), scope('globex', 'bob', 1)),
      );

      await registryJob()!.fn();

      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="ana",reason="expired",tenant_id="acme"} 2',
      );
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="bob",reason="expired",tenant_id="globex"} 1',
      );
      // E NENHUMA linha da série sob `system`: um agregado de 3 rotulado
      // `system` é exatamente o defeito que esta issue corrige.
      expect(out).not.toContain(
        'maia_onboarding_run_cancelled_total{agent_id="system",reason="expired",tenant_id="system"}',
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 3, scopes: 2 }),
        'onboarding_expirer.done',
      );
    });

    /**
     * A run de `global_bootstrap` vence ANTES de existir tenant (`tenant_id` é
     * nullable de propósito). Ela precisa continuar sendo expirada E contada —
     * é a run mais órfã, a que ninguém mais vai limpar. Vai para o bucket
     * sancionado `system`, o mesmo que `admin_audit_log` já usa para ela, e
     * NUNCA para o literal `'default'` (invariante MUST nº 8).
     */
    it('a run SEM tenant continua contada, no bucket system — nunca em default', async () => {
      expireStale.mockImplementation(async () =>
        result(scope(null, null, 1), scope('acme', 'ana', 1)),
      );

      await registryJob()!.fn();

      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="system",reason="expired",tenant_id="system"} 1',
      );
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="ana",reason="expired",tenant_id="acme"} 1',
      );
      expect(out).not.toContain('tenant_id="default"');
      // Contada, não descartada: o total do log inclui a run órfã.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ expired: 2 }),
        'onboarding_expirer.done',
      );
    });

    /**
     * O caso que separa "passar um parâmetro" de "atribuir": `counter()`
     * resolve o par LENDO O ALS no instante da emissão, e o valor do chamador
     * só vence quando NÃO é `null` (`merged.tenant_id ?? attr.tenant_id`).
     * Repassar `run.tenant_id` cru funciona para a run COM tenant e falha na
     * run SEM tenant, que herda o escopo do ALS — e sob `runWithSystemContext`
     * o resultado ainda parece certo. Este caso vaza um ALS de outro tenant por
     * cima da corrida: só um colapso EXPLÍCITO `null → 'system'` (`scopeAttribution`)
     * sobrevive.
     *
     * É o mesmo defeito de #555 pelo outro lado, e por isso os dois sentidos
     * são exigidos aqui: a série de cancelamento carrega o escopo DA RUN, e as
     * séries de housekeeping (`maia_worker_run_total`) continuam `system`.
     */
    it('sob ALS vazado: a série carrega o escopo DA RUN, e a órfã cai em system', async () => {
      expireStale.mockImplementation(async () =>
        result(scope(null, null, 1), scope('acme', 'ana', 2)),
      );

      await runWithTenantContext({ tenant_id: 'tenant-vazado', agent_id: 'bot-vazado' }, () =>
        registryJob()!.fn(),
      );

      const out = await renderPrometheus();
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="ana",reason="expired",tenant_id="acme"} 2',
      );
      expect(out).toContain(
        'maia_onboarding_run_cancelled_total{agent_id="system",reason="expired",tenant_id="system"} 1',
      );
      // A EXECUÇÃO continua declaradamente `system`.
      expect(out).toContain(
        'maia_worker_run_total{agent_id="system",status="ok",tenant_id="system",worker="onboarding_expirer"} 1',
      );
      // Nada, em nenhuma série, herdou o escopo vazado.
      expect(out).not.toContain('tenant-vazado');
      expect(out).not.toContain('bot-vazado');
    });

    it('rotula com system também no caminho de erro, sob ALS de outro tenant', async () => {
      expireStale.mockImplementation(async () => {
        throw new Error('deadlock detected');
      });
      await expect(
        runWithTenantContext({ tenant_id: 'tenant-vazado', agent_id: 'bot-vazado' }, () =>
          registryJob()!.fn(),
        ),
      ).rejects.toThrow();
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

    /**
     * O worker NÃO publica o backlog: uma fila publicada por ele congela no
     * último valor quando ele para, que é a falha que a série existe para
     * pegar. Quem a emite é `src/observability/onboarding-expiry-collector.ts`,
     * no scrape. Se alguém mover a emissão para cá, este caso fica vermelho.
     */
    it('não publica o backlog daqui — ele é lido no scrape', async () => {
      expireStale.mockImplementation(async () => result(scope('acme', 'ana', 3)));
      await registryJob()!.fn();
      const out = await renderPrometheus();
      expect(out).not.toContain('maia_onboarding_expiry_backlog');
      expect(out).not.toContain('maia_onboarding_expiry_oldest_age_seconds');
    });
  });
});

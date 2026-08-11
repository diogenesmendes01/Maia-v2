import { onboardingRunsRepo } from '@/db/repositories/onboarding-repos.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { counter, METRIC } from '@/observability/metrics.js';

/**
 * Issue #519 — varredura de runs de onboarding vencidas.
 *
 * `onboardingRunsRepo.expireStale()` (`src/db/repositories/onboarding-repos.ts:917`)
 * existia desde a saga e NINGUÉM a chamava: uma run abandonada ficava viva
 * para sempre, segurando os índices parciais
 * `onboarding_runs_one_live_per_{tenant,agent}_uq` e impedindo que o operador
 * recomeçasse o wizard. Isto é housekeeping normal da aplicação, então mora no
 * scheduler interno — não num job de operação/manutenção externa.
 *
 * Desenho, em três decisões:
 *
 * 1. **Escopo `system`, não per-tenant.** Diferente de `pending_expirer` e
 *    `audit_mode_expirer` (que são DISPATCHERS porque o trabalho interno lê o
 *    tenant do ALS), `expireStale` é uma varredura GLOBAL explícita: o SELECT
 *    não tem predicado de tenant, não lê o contexto ALS, e uma run vencida
 *    pode nem ter `tenant_id` ainda (a coluna é nullable justamente porque a
 *    run nasce antes do tenant existir). Enumerar tuplas aqui deixaria de fora
 *    exatamente as runs mais órfãs. Rodamos sob `runWithSystemContext` — o
 *    mesmo tratamento de `idempotency_cleanup`, e o bucket sancionado para
 *    trabalho sem dono (ARCHITECTURE.md §7, `'system'`).
 *
 * 2. **Lote limitado, uma passada por tick.** `expireStale` abre UMA transação
 *    por run (`SELECT … FOR UPDATE` + UPDATE + evento). Um backlog de milhares
 *    de runs vencidas não pode virar um tick que segura conexões por minutos —
 *    o limite de lote (`ONBOARDING_EXPIRER_BATCH_LIMIT`) é passado
 *    EXPLICITAMENTE e o worker NÃO faz laço até esvaziar. A cada 5 minutos,
 *    100 runs por tick drenam 1.200 runs/hora; o resto espera o próximo tick, e
 *    `onboarding_expirer.batch_capped` avisa que existe fila.
 *
 * 3. **Sem lock de single-flight — de propósito.** Duas réplicas rodando o
 *    mesmo tick não fazem estrago: cada run é expirada dentro de uma transação
 *    que a trava com `SELECT … FOR UPDATE` e RE-VALIDA estado e `expires_at`
 *    depois de obter a trava. A perdedora da corrida encontra a run já em
 *    `cancelled` (estado terminal) e devolve `false` — sem segundo UPDATE, sem
 *    segundo evento `run_expired`, sem contagem dobrada. Acrescentar um
 *    advisory lock global (o padrão de `idempotency_outbox_relayer` /
 *    `outbound_messages_sweeper`) só faria sentido se a operação NÃO fosse
 *    idempotente sob concorrência — aqueles dois disparam efeito externo
 *    não-idempotente (envio WhatsApp), este só escreve no banco sob trava de
 *    linha. O guarda de auto-sobreposição do registry
 *    (`src/workers/index.ts` `runTick`) já cobre o caso de duas execuções na
 *    MESMA réplica.
 */

/** Nome da entrada no registry — usado como label `worker` das métricas. */
const WORKER = 'onboarding_expirer';

/**
 * Teto de runs expiradas por tick. Igual ao default do repositório; explícito
 * aqui porque o limite é decisão do CHAMADOR (quem conhece a cadência), não do
 * repositório.
 */
export const ONBOARDING_EXPIRER_BATCH_LIMIT = 100;

/**
 * @param opts.limit teto do lote. Só a suíte passa este parâmetro; o registry
 *        chama `fn()` sem argumento e recebe `ONBOARDING_EXPIRER_BATCH_LIMIT`.
 */
export async function runOnboardingExpirer(opts: { limit?: number } = {}): Promise<void> {
  const limit = opts.limit ?? ONBOARDING_EXPIRER_BATCH_LIMIT;

  // O escopo `system` envolve a corrida INTEIRA — varredura, emissões do
  // caminho feliz E as do `catch` —, não só a chamada ao repositório.
  // `counter()` resolve `tenant_id`/`agent_id` LENDO O ALS no instante da
  // emissão (`src/observability/metrics.ts:38`) e só cai em `system` quando o
  // ALS está VAZIO. Numa cadeia de cron ele está — mas isso é propriedade do
  // AMBIENTE, não do código: bastaria alguém invocar este worker de dentro de
  // um contexto de tenant para a série de housekeeping sair rotulada com
  // aquele tenant, e ninguém veria. Aqui o `system` é DECLARADO.
  await runWithSystemContext(async () => {
    try {
      const expired = await onboardingRunsRepo.expireStale(new Date(), limit);

      counter(METRIC.WORKER_RUN, { worker: WORKER, status: 'ok' });

      if (expired === 0) {
        logger.debug('onboarding_expirer.idle');
        return;
      }

      // Mesma série que o cancelamento operado pelo console emite
      // (`src/onboarding/wizard.ts:590`), com `reason='expired'` — já no
      // vocabulário fechado `ONBOARDING_REASONS`. A atribuição sai `system`
      // porque `expireStale` devolve só a CONTAGEM: quem precisa saber de qual
      // tenant era cada run tem o evento `run_expired` e a run em si.
      counter(METRIC.ONBOARDING_RUN_CANCELLED, { reason: 'expired' }, expired);
      logger.info({ expired, limit }, 'onboarding_expirer.done');

      if (expired >= limit) {
        // Lote cheio ⇒ provavelmente sobrou fila para o próximo tick.
        logger.warn({ expired, limit }, 'onboarding_expirer.batch_capped');
      }
    } catch (err) {
      // Uma corrida que falha NÃO derruba o scheduler nem contamina os outros
      // jobs: o erro fica no log e na série
      // `maia_worker_run_total{status="error"}` (o registry só vê uma execução
      // que terminou). O `try` fica DENTRO do escopo `system` de propósito:
      // esta emissão também é rotulada, e um erro é justamente quando ninguém
      // está olhando o rótulo.
      counter(METRIC.WORKER_RUN, { worker: WORKER, status: 'error' });
      logger.error(
        { err: (err as Error).message, stack: (err as Error).stack },
        'onboarding_expirer.failed',
      );
    }
  });
}

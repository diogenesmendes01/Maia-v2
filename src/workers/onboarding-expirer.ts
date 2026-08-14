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
 * Qualquer URI com credencial embutida (`postgres://user:senha@host/db`) some
 * do que este worker escreve. #533: já houve vazamento de `DATABASE_URL` por
 * stderr cru, e uma falha de conexão é exatamente o erro cuja mensagem carrega
 * a DSN.
 */
const URI_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi;

/**
 * Recorte SANITIZADO e BOUNDED de um erro: nome, código (o `code` do driver
 * quando ele existe — `40P01` deadlock, `57P01` admin shutdown — que é o que
 * um plantonista quer no log) e a mensagem com URIs censuradas e truncada.
 */
function safeFailure(err: unknown): { name: string; code: string; reason: string } {
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e?.name === 'string' ? e.name.slice(0, 64) : 'Error';
  const code =
    typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(e.code) ? e.code : 'unknown';
  const reason =
    typeof e?.message === 'string'
      ? e.message.replace(URI_RE, '[REDACTED_URL]').slice(0, 200)
      : '';
  return { name, code, reason };
}

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
      // O `try` fica DENTRO do escopo `system` de propósito: esta emissão
      // também é rotulada, e um erro é justamente quando ninguém está olhando
      // o rótulo.
      counter(METRIC.WORKER_RUN, { worker: WORKER, status: 'error' });
      const safe = safeFailure(err);
      logger.error({ ...safe }, 'onboarding_expirer.failed');

      // E REJEITA. O registry lê qualquer resolução como sucesso
      // (`src/workers/index.ts` `runTick`: `.then()` carimba
      // `maia_worker_last_success_timestamp`, `.catch()` carimba
      // `maia_worker_last_failure_timestamp` e loga `worker.failed`). Engolir
      // o erro produziria um falso sucesso NOVO a cada 5 minutos durante uma
      // indisponibilidade de banco — justamente na telemetria que
      // `docs/runbooks/operational.md` manda usar para achar worker quebrado,
      // e o `WORKER_RUN{status="error"}` local não conserta esses gauges. O
      // `runTick` isola a rejeição e o próximo tick é agendado do mesmo jeito:
      // o scheduler não cai.
      //
      // O erro que sobe é CONSTRUÍDO aqui: estável, curto e SEM `cause`. O
      // pino do registry serializa o erro (mensagem E stack, e `cause` junto)
      // no `worker.failed`, e a mensagem de uma falha de conexão carrega a
      // `DATABASE_URL` inteira — o vazamento de #533. É por isso que a regra
      // `preserve-caught-error` é desligada AQUI e só aqui: ela pede
      // exatamente o que não pode atravessar a fronteira. A cadeia não se
      // perde — o recorte sanitizado (`name`, `code`, `reason` com URIs
      // censuradas) foi logado na linha acima.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`onboarding_expirer falhou (${safe.name}/${safe.code})`);
    }
  });
}

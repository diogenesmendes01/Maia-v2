import { config } from '@/config/env.js';
import { onboardingRunsRepo } from '@/db/repositories/onboarding-repos.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { counter, scopeAttribution, METRIC } from '@/observability/metrics.js';

/**
 * Issue #519 — varredura de runs de onboarding vencidas.
 *
 * `onboardingRunsRepo.expireStale()` existia desde a saga e NINGUÉM a chamava:
 * uma run abandonada ficava viva para sempre, segurando os índices parciais
 * `onboarding_runs_one_live_per_{tenant,agent}_uq` e impedindo que o operador
 * recomeçasse o wizard. Isto é housekeeping normal da aplicação, então mora no
 * scheduler interno — não num job de operação/manutenção externa.
 *
 * Desenho, em quatro decisões:
 *
 * 1. **EXECUÇÃO sob `system`, ATRIBUIÇÃO por escopo.** Diferente de
 *    `pending_expirer` e `audit_mode_expirer` (que são DISPATCHERS porque o
 *    trabalho interno lê o tenant do ALS), `expireStale` é uma varredura GLOBAL
 *    explícita: o SELECT não tem predicado de tenant, não lê o contexto ALS, e
 *    uma run vencida pode nem ter `tenant_id` ainda (a coluna é nullable
 *    justamente porque a run nasce antes do tenant existir). Enumerar tuplas
 *    aqui deixaria de fora exatamente as runs mais órfãs. Rodamos sob
 *    `runWithSystemContext` — o mesmo tratamento de `idempotency_cleanup`, e o
 *    bucket sancionado para trabalho sem dono (ARCHITECTURE.md §7, `'system'`).
 *
 *    O que NÃO é global é o RÓTULO da série de cancelamento. Ver `emitCancelled`.
 *
 * 2. **Lote limitado, uma passada por tick — e o resto é OBSERVÁVEL.**
 *    `expireStale` abre UMA transação por run (`SELECT … FOR UPDATE` + UPDATE +
 *    evento + auditoria). Um backlog de milhares de runs vencidas não pode
 *    virar um tick que segura conexões por minutos — o limite de lote é passado
 *    EXPLICITAMENTE e o worker NÃO faz laço até esvaziar.
 *
 *    O contrato é "trabalho limitado por tick, backlog observável e prazo
 *    máximo de limpeza", NÃO "100 a cada 5 minutos" (decisão do dono na revisão
 *    de #555). Por isso o teto é `ONBOARDING_EXPIRER_BATCH_LIMIT`, uma variável
 *    do contrato de configuração (`src/config/contract.ts`) e não uma constante
 *    compilada, e por isso a fila restante é uma SÉRIE
 *    (`maia_onboarding_expiry_backlog`, lida no scrape por
 *    `src/observability/onboarding-expiry-collector.ts`) e não só um `logger.warn`.
 *    O prazo máximo de limpeza é derivável das duas: `backlog ÷ (limite × ticks
 *    por hora)`.
 *
 * 3. **Sem lock de single-flight — de propósito.** Duas réplicas rodando o
 *    mesmo tick não fazem estrago: cada run é expirada dentro de uma transação
 *    que a trava com `SELECT … FOR UPDATE` e RE-VALIDA estado e `expires_at`
 *    depois de obter a trava. A perdedora da corrida encontra a run já em
 *    `cancelled` (estado terminal) e devolve `null` — sem segundo UPDATE, sem
 *    segundo evento `run_expired`, sem contagem dobrada. Acrescentar um
 *    advisory lock global (o padrão de `idempotency_outbox_relayer` /
 *    `outbound_messages_sweeper`) só faria sentido se a operação NÃO fosse
 *    idempotente sob concorrência — aqueles dois disparam efeito externo
 *    não-idempotente (envio WhatsApp), este só escreve no banco sob trava de
 *    linha. O guarda de auto-sobreposição do registry
 *    (`src/workers/index.ts` `runTick`) já cobre o caso de duas execuções na
 *    MESMA réplica.
 *
 * 4. **O worker NÃO publica o backlog.** Uma métrica de fila publicada pelo
 *    worker congela no último valor quando o worker para — que é exatamente a
 *    falha que ela deveria pegar (o mesmo argumento de #536 para
 *    `maia_restore_drill_check_level`). O backlog é lido no SCRAPE, a partir do
 *    banco, por um coletor; aqui só sai o que este tick de fato FEZ.
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
 * Teto de runs expiradas por tick, LIDO A CADA CORRIDA do contrato de
 * configuração. Não é constante de módulo: capturar o valor no import
 * congelaria a variável no primeiro `import`, e um teste que a sobrescreve
 * passaria a depender da ordem de carga dos módulos.
 *
 * O limite continua sendo decisão do CHAMADOR (quem conhece a cadência) e é
 * passado EXPLICITAMENTE ao repositório — que tem default próprio, e depender
 * dele deixaria o teto do worker invisível no call site.
 */
export function onboardingExpirerBatchLimit(): number {
  return config.ONBOARDING_EXPIRER_BATCH_LIMIT;
}

/**
 * Emite `maia_onboarding_run_cancelled_total{reason="expired"}` UMA VEZ POR
 * ESCOPO, com o `tenant_id + agent_id` de cada run afetada.
 *
 * POR QUE NÃO UMA EMISSÃO SÓ SOB `system` (o que esta função substitui): o
 * cancelamento pelo console emite a MESMA série (`src/onboarding/wizard.ts`)
 * atribuída ao tenant real da run. Com o varredor emitindo tudo sob `system`,
 * a mesma série tinha duas atribuições diferentes conforme QUEM cancelou, e
 * "quantas runs do tenant X foram canceladas" passava a depender de o
 * cancelamento ter sido manual — que é precisamente o que o dashboard não
 * pode saber.
 *
 * POR QUE ISSO NÃO É "SÓ PASSAR UM PARÂMETRO": `counter()` resolve
 * `tenant_id`/`agent_id` LENDO O ALS no instante da emissão e o valor do
 * chamador só vence quando NÃO É `null`/`undefined`
 * (`src/observability/metrics.ts`, `merged.tenant_id ?? attr.tenant_id`).
 * Repassar `run.tenant_id` cru funcionaria para a run com tenant e falharia
 * exatamente na run SEM tenant — que herdaria silenciosamente o escopo do ALS.
 * Sob `runWithSystemContext` isso ainda pareceria certo (`system`), e viraria
 * o rótulo errado no dia em que alguém invocasse o worker de dentro de um
 * contexto de tenant. `scopeAttribution` colapsa `null → 'system'` ANTES da
 * emissão, então o rótulo é DECLARADO, não herdado.
 *
 * A RUN SEM TENANT (`global_bootstrap`, que vence antes de existir tenant)
 * continua expirada e contada, no bucket `system`. Três razões:
 * (a) `system` é o bucket sancionado para trabalho genuinamente sem dono, o
 * mesmo que `governance/audit.ts` e `admin_audit_log` já usam para estas
 * runs — a métrica passa a concordar com a trilha em vez de contradizê-la;
 * (b) inventar `'default'` é a invariante MUST nº 8, e inventar um bucket novo
 * (`unassigned`) criaria um valor de `tenant_id` que nenhuma outra série usa,
 * quebrando qualquer join por tenant no dashboard;
 * (c) descartá-la seria pior que rotulá-la mal: a run mais órfã é a que mais
 * precisa aparecer, e some da contagem justamente quando o bootstrap global
 * está falhando em série.
 *
 * CARDINALIDADE: `tenant_id` tem orçamento declarado de 500 valores distintos e
 * `agent_id` de 2000 (`LABEL_CARDINALITY_BUDGET`, `src/observability/taxonomy.ts`).
 * Atribuir por escopo NÃO estoura nada porque não cria valores novos: são os
 * mesmos tenants/agentes que o console já emite nesta mesma série, e o teto do
 * lote limita quantos escopos distintos um tick pode tocar. Se um dia o número
 * de tenants passar de 500, o sanitizador colapsa o excedente em `__overflow__`
 * e incrementa `maia_metric_label_cardinality_overflow_total` — degrada, não
 * detona.
 */
function emitCancelled(by_scope: readonly { tenant_id: string | null; agent_id: string | null; total: number }[]): void {
  for (const scope of by_scope) {
    counter(
      METRIC.ONBOARDING_RUN_CANCELLED,
      { reason: 'expired', ...scopeAttribution(scope) },
      scope.total,
    );
  }
}

/**
 * @param opts.limit teto do lote. Só a suíte passa este parâmetro; o registry
 *        chama `fn()` sem argumento e recebe `ONBOARDING_EXPIRER_BATCH_LIMIT`
 *        do contrato de configuração.
 */
export async function runOnboardingExpirer(opts: { limit?: number } = {}): Promise<void> {
  const limit = opts.limit ?? onboardingExpirerBatchLimit();

  // O escopo `system` envolve a corrida INTEIRA — varredura, emissões do
  // caminho feliz E as do `catch` —, não só a chamada ao repositório.
  // `counter()` resolve `tenant_id`/`agent_id` LENDO O ALS no instante da
  // emissão (`src/observability/metrics.ts`) e só cai em `system` quando o
  // ALS está VAZIO. Numa cadeia de cron ele está — mas isso é propriedade do
  // AMBIENTE, não do código: bastaria alguém invocar este worker de dentro de
  // um contexto de tenant para as séries de housekeeping (`maia_worker_run_total`
  // e as emissões do erro) saírem rotuladas com aquele tenant, e ninguém
  // veria. Aqui o `system` é DECLARADO. A série de CANCELAMENTO não depende
  // disto: ela carrega o escopo de cada run, explicitamente (ver `emitCancelled`).
  await runWithSystemContext(async () => {
    try {
      const { total, by_scope } = await onboardingRunsRepo.expireStale(new Date(), limit);

      counter(METRIC.WORKER_RUN, { worker: WORKER, status: 'ok' });

      if (total === 0) {
        logger.debug('onboarding_expirer.idle');
        return;
      }

      emitCancelled(by_scope);
      logger.info({ expired: total, scopes: by_scope.length, limit }, 'onboarding_expirer.done');

      if (total >= limit) {
        // Lote cheio ⇒ provavelmente sobrou fila para o próximo tick. O
        // TAMANHO dessa fila não sai daqui: ver a decisão 4 do cabeçalho.
        logger.warn({ expired: total, limit }, 'onboarding_expirer.batch_capped');
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

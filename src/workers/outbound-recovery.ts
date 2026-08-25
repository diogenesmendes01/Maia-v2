/**
 * Issue #633 (fatia D da épica #506) — a VARREDURA de recuperação do outbox
 * durável.
 *
 * Quatro operações por tick, por (tenant, agent):
 *
 *  (A) REARMAR o trabalho entregável — `pending`/`retryable` com o gate de
 *      backoff vencido, e `claimed`/`sending` com lease morta (takeover). O job
 *      tem `jobId` determinístico por `outbound_id`, então re-armar é
 *      idempotente por construção.
 *  (B) RECONCILIAR o incerto — `delivery_unknown`, `reconciling` e a janela
 *      `delivered -> completed` que a #632 declarou. É o produto principal da
 *      fatia, e não um caso de borda.
 *  (C) DLQ — teto de tentativas e prazo de reconciliação vencido, auditados.
 *  (D) DIVERGÊNCIA turno↔outbound, nos DOIS sentidos. Observação, nunca
 *      correção.
 *
 * ─── Por que múltiplos sweepers concorrentes não duplicam ───────────────────
 *
 * NÃO por advisory lock global. O sweeper legado (`outbound-messages-sweeper.ts`,
 * #292) usa um, e ali faz sentido: aquele sweep PROMOVE rows por predicado de
 * idade, e duas promoções concorrentes da mesma row seriam dois efeitos. Aqui
 * a garantia é mais forte e mais barata:
 *
 *   - toda MUTAÇÃO é um `UPDATE ... WHERE status = <origem esperada>`
 *     (compare-and-swap). Duas réplicas que decidam o mesmo produzem UM
 *     vencedor e um `UPDATE` que volta zero linhas — no lock de row do
 *     PostgreSQL, não em disciplina de código;
 *   - o REARME é idempotente pelo `jobId` determinístico: dois `add` do mesmo
 *     `outbound_id` produzem UM job;
 *   - a ENTREGA em si é protegida pelo claim atômico com lease de #632, que já
 *     é a camada que sobrevive a jobs duplicados vindos de qualquer origem.
 *
 * Um lock global aqui não acrescentaria segurança e custaria disponibilidade:
 * enquanto uma réplica varre, as outras não fariam nada — e a recuperação é
 * justamente o que precisa continuar funcionando quando uma réplica está
 * doente.
 *
 * ─── O que este worker NUNCA faz ────────────────────────────────────────────
 *
 * Reenviar por decisão própria a partir de um estado incerto. A única transição
 * que devolve uma linha `delivery_unknown` ao ciclo de entrega é
 * `promoteUnknownToRetryable`, e ela só é chamada quando
 * `reconciliationDisposition` devolve `resend_idempotent` — que por sua vez só
 * acontece quando `autoResendAllowed` (#632) é verdadeiro, isto é, quando o
 * provedor honra a chave idempotente para aquele `payload_type`. Para os quatro
 * tipos sem chave nativa no Baileys a resposta é `escalate_manual`, e a linha
 * espera um humano.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { counter, gauge } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import { enqueueOutboundDelivery } from '@/gateway/queue.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  outboundRecoveryRepo,
  type RecoveryCandidate,
  type RecoveryScope,
} from '@/db/repositories/outbound-recovery-repo.js';
import {
  DELIVERED_WITHOUT_HISTORY_GRACE_MS,
  attemptBudgetExhausted,
  reconciliationDisposition,
  type ReconciliationResult,
} from '@/runtime/outbound/recovery-contract.js';
import type { OutboundProviderChannel } from '@/runtime/outbound/contract.js';

/** O canal de egresso desta fatia — fechado, como em `delivery.ts`. */
const EGRESS_CHANNEL: OutboundProviderChannel = 'whatsapp';

/**
 * Teto de linhas tocadas por escopo, por tick, em cada uma das duas varreduras.
 *
 * Justiça entre tenants, mesmo raciocínio de `OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT`
 * (#292): um tenant de alto volume não consome a janela inteira e não faz os
 * demais esperarem. O tick é de um minuto, então o resto drena logo.
 */
const SWEEP_LIMIT_PER_SCOPE = 200;

/**
 * Última idade medida por escopo, para o provider do gauge.
 *
 * ─── Por que medir no tick e não no scrape ──────────────────────────────────
 *
 * `gauge()` registra um PROVIDER, chamado a cada scrape do `/metrics`. Um
 * provider que consultasse o PostgreSQL faria a frequência de scrape virar
 * carga de banco, multiplicada pelo número de escopos — e um Prometheus
 * configurado agressivamente derrubaria a métrica que ele existe para observar.
 *
 * A medição acontece uma vez por tick (um minuto) e o provider lê daqui. O
 * valor é, no pior caso, um tick velho; para uma série cuja unidade é o SEGUNDO
 * e cujo alerta dispara em minutos, isso é ruído irrelevante.
 *
 * O provider é registrado UMA vez por escopo (`registeredGauges`); registrar de
 * novo apenas substituiria a closure, mas a checagem deixa explícito que o
 * conjunto de séries é estável e não cresce por tick.
 */
const lastPendingAge = new Map<string, number>();
const registeredGauges = new Set<string>();

function scopeKey(s: RecoveryScope): string {
  // Enquadramento por prefixo de comprimento, e nao um separador solto:
  // `tenants.id`/`agents.id` sao TEXT sem CHECK de formato (007), entao um
  // separador simples faria ("a:b","c") e ("a","b:c") colidirem na mesma
  // serie. Mesmo raciocinio da derivacao de chaves em #630.
  return `${s.tenant_id.length}:${s.tenant_id}:${s.agent_id}`;
}

function publishPendingAge(scope: RecoveryScope, seconds: number): void {
  const key = scopeKey(scope);
  lastPendingAge.set(key, seconds);
  if (registeredGauges.has(key)) return;
  registeredGauges.add(key);
  gauge(METRIC.OUTBOUND_PENDING_AGE_SECONDS, () => lastPendingAge.get(key) ?? 0, {
    tenant_id: scope.tenant_id,
    agent_id: scope.agent_id,
  });
}

/** Só para teste: esquece as séries registradas entre casos. */
export function __resetOutboundRecoveryGaugesForTest(): void {
  lastPendingAge.clear();
  registeredGauges.clear();
}

type SweepStats = {
  rearmed: number;
  reconciled: Record<ReconciliationResult, number>;
  dead_lettered: number;
};

function emptyReconciled(): Record<ReconciliationResult, number> {
  return {
    await_grace: 0,
    resend_idempotent: 0,
    escalate_manual: 0,
    dead_letter: 0,
    noop: 0,
    history_recovered: 0,
  };
}

function recordReconciliation(
  stats: SweepStats,
  result: ReconciliationResult,
): void {
  stats.reconciled[result] += 1;
  counter(METRIC.OUTBOUND_RECONCILIATION, { result });
}

/**
 * (A) REARMAR o trabalho entregável.
 *
 * O teto de tentativas é consultado ANTES do rearme, e é isto que impede o
 * "rearma → falha → rearma" eterno que a issue lista como risco. Uma linha que
 * estourou o orçamento vai para a DLQ em vez de ganhar mais um job.
 *
 * ─── A exceção: `sending` NUNCA é morto direto ──────────────────────────────
 *
 * Uma linha em `sending` teve a chamada ao provedor INICIADA, e o desfecho é
 * desconhecido. Mandá-la para `dead_letter` aqui a deixaria terminal com
 * `delivery_outcome` NULL — e `manualRearmDuplicateRisk` lê justamente esse
 * campo para decidir se um rearmamento manual pode duplicar. O operador veria
 * "sem risco" numa linha cuja chamada estava em voo, e a confirmação de risco —
 * a defesa contra a falha #12 — não seria pedida.
 *
 * Então ela é rearmada mesmo acima do teto. O takeover a reivindica, mantém em
 * `sending` (o claim não normaliza), e `claimDisposition` a fecha como
 * `cancelled_after_send_unknown` ⇒ `delivery_unknown`. É a reconciliação que a
 * mata, um tick depois, COM o desfecho registrado. Uma volta a mais, e a linha
 * chega à DLQ dizendo a verdade sobre si.
 */
async function sweepDeliverable(stats: SweepStats): Promise<void> {
  const candidates = await outboundRecoveryRepo.listDeliverable(SWEEP_LIMIT_PER_SCOPE);
  for (const row of candidates) {
    if (attemptBudgetExhausted(row.attempt) && row.status !== 'sending') {
      await deadLetter(row, 'attempt_limit', stats);
      continue;
    }
    try {
      await enqueueOutboundDelivery(row.outbound_id);
      counter(METRIC.OUTBOUND_REARM, { origin: 'recovery' });
      stats.rearmed += 1;
    } catch (err) {
      // Redis fora do ar não perde trabalho: a ROW continua elegível e o
      // próximo tick tenta de novo. Falhar o tick inteiro por causa de uma
      // linha faria as outras três operações pararem junto.
      logger.warn(
        { outbound_id: row.outbound_id, err: (err as Error).message },
        'outbound_recovery.rearm_failed',
      );
    }
  }
}

/**
 * (B) + (C) RECONCILIAR o incerto, e desistir quando é hora.
 *
 * A linha `delivered` é tratada aqui e não em (A) de propósito: ela NÃO é
 * reivindicável e NÃO deve ser reenviada — a mensagem chegou. O que falta é o
 * histórico, e recuperá-lo é uma leitura + uma transição, sem tocar o provedor.
 */
async function sweepReconciliation(stats: SweepStats): Promise<void> {
  const candidates = await outboundRecoveryRepo.listReconciliation(SWEEP_LIMIT_PER_SCOPE);
  for (const row of candidates) {
    if (row.status === 'delivered') {
      await reconcileDelivered(row, stats);
      continue;
    }
    if (row.delivery_outcome === null) {
      // Uma linha em `delivery_unknown`/`reconciling` SEM desfecho registrado é
      // dado incoerente: os dois estados só nascem de `statusForOutcome`, que
      // grava os dois campos na mesma declaração. Não se decide sobre ela — a
      // decisão exige o desfecho, e inventar um seria escolher entre reenviar e
      // desistir sem base.
      recordReconciliation(stats, 'noop');
      logger.error(
        { outbound_id: row.outbound_id, status: row.status, ops_alert: true },
        'outbound_recovery.unknown_without_outcome',
      );
      continue;
    }
    const disposition = reconciliationDisposition({
      outcome: row.delivery_outcome,
      channel: EGRESS_CHANNEL,
      payload_type: row.payload_type,
      attempt: row.attempt,
      age_ms: row.age_ms,
    });
    switch (disposition) {
      case 'await_grace':
        recordReconciliation(stats, 'await_grace');
        break;
      case 'resend_idempotent': {
        // A ÚNICA escrita desta fatia que autoriza um efeito externo repetido.
        // Ela chegou aqui porque `autoResendAllowed` disse que o provedor
        // deduplica este tipo de payload — nunca por otimismo.
        const promoted = await outboundRecoveryRepo.promoteUnknownToRetryable({
          outbound_id: row.outbound_id,
        });
        if (!promoted.promoted) {
          // Outra réplica venceu o CAS, ou a linha já era `reconciling`.
          recordReconciliation(stats, 'noop');
          break;
        }
        recordReconciliation(stats, 'resend_idempotent');
        try {
          await enqueueOutboundDelivery(row.outbound_id);
          counter(METRIC.OUTBOUND_REARM, { origin: 'recovery' });
          stats.rearmed += 1;
        } catch (err) {
          logger.warn(
            { outbound_id: row.outbound_id, err: (err as Error).message },
            'outbound_recovery.rearm_failed',
          );
        }
        break;
      }
      case 'escalate_manual': {
        const marked = await outboundRecoveryRepo.markReconciling({
          outbound_id: row.outbound_id,
        });
        // Já estava em `reconciling` (o CAS exige `delivery_unknown`): ela
        // continua na fila e continua envelhecendo, que é o alarme. Contar
        // `escalate_manual` de novo a cada tick inflaria a série; o que mede
        // "quanto está parado" é `maia_outbound_pending_age_seconds`.
        recordReconciliation(stats, marked.marked ? 'escalate_manual' : 'noop');
        if (marked.marked) {
          logger.warn(
            {
              outbound_id: row.outbound_id,
              outcome: row.delivery_outcome,
              payload_type: row.payload_type,
              attempt: row.attempt,
              ops_alert: true,
            },
            'outbound_recovery.escalated_to_manual — o provedor não deduplica este tipo; ' +
              'reenviar duplicaria a mensagem. Ver docs/runbooks/outbound-recovery.md',
          );
        }
        break;
      }
      case 'dead_letter':
        // As DUAS causas passam por aqui, e o `reason` tem de distinguí-las: a
        // triagem de "esgotou tentativas" (olhe a entrega) é outra que a de
        // "ficou incerta por 24h" (olhe o provedor).
        await deadLetter(
          row,
          attemptBudgetExhausted(row.attempt) ? 'attempt_limit' : 'reconciliation_timeout',
          stats,
        );
        break;
      default: {
        const _never: never = disposition;
        void _never;
        break;
      }
    }
  }
}

/**
 * A janela `delivered -> completed` declarada pela #632.
 *
 * A leitura do histórico PRECEDE a transição, e é o que impede um segundo
 * registro na conversa: o caminho síncrono de `output-dispatch.ts` grava o
 * histórico por conta própria e para em `delivered`, então uma linha `delivered`
 * COM histórico é normal, não crash.
 *
 * Uma linha `delivered` SEM histórico e ainda jovem é concorrência normal (a
 * transação de `completeDeliveryTx` pode estar em voo) — a carência a protege.
 * Depois dela, é a janela de crash: a mensagem chegou e o histórico se perdeu.
 * Esta fatia REPORTA isso; ela não fabrica o histórico faltante, porque o texto
 * viria do payload e reconstruí-lo aqui duplicaria a lógica de `buildHistorico`
 * num segundo lugar.
 */
async function reconcileDelivered(
  row: RecoveryCandidate,
  stats: SweepStats,
): Promise<void> {
  if (row.age_ms < DELIVERED_WITHOUT_HISTORY_GRACE_MS) {
    recordReconciliation(stats, 'await_grace');
    return;
  }
  const correlation = await outboundRecoveryRepo.correlationOf(row.outbound_id);
  if (!correlation) {
    recordReconciliation(stats, 'noop');
    return;
  }
  const hasHistory = await outboundRecoveryRepo.hasHistoryFor(correlation);
  if (!hasHistory) {
    // A mensagem CHEGOU (só `accepted_confirmed` produz `delivered`) e o
    // histórico não entrou. Não se reenvia — duplicaria. Não se inventa o
    // histórico — o texto teria de ser re-renderizado.
    recordReconciliation(stats, 'escalate_manual');
    logger.error(
      { outbound_id: row.outbound_id, age_ms: Math.round(row.age_ms), ops_alert: true },
      'outbound_recovery.delivered_without_history — a mensagem chegou e o histórico da ' +
        'conversa não registrou. NÃO reenviar. Ver docs/runbooks/outbound-recovery.md',
    );
    return;
  }
  const completed = await outboundRecoveryRepo.completeDeliveredWithHistoryTx({
    outbound_id: row.outbound_id,
    ...correlation,
  });
  recordReconciliation(stats, completed.completed ? 'history_recovered' : 'noop');
}

/**
 * O CAS de origem, por estado real da linha. Fechado por construção: um estado
 * fora deste mapa não é morto por esta varredura.
 */
const DEAD_LETTER_SOURCES: Readonly<Record<string, readonly string[]>> = {
  pending: ['pending'],
  retryable: ['retryable'],
  claimed: ['claimed'],
  delivery_unknown: ['delivery_unknown'],
  reconciling: ['reconciling'],
};

async function deadLetter(
  row: RecoveryCandidate,
  reason: 'attempt_limit' | 'reconciliation_timeout',
  stats: SweepStats,
): Promise<void> {
  const correlation = await outboundRecoveryRepo.correlationOf(row.outbound_id);
  if (!correlation) {
    recordReconciliation(stats, 'noop');
    return;
  }
  const moved = await outboundRecoveryRepo.deadLetterTx({
    outbound_id: row.outbound_id,
    // Os estados de origem são exatamente os que produzem cada motivo. Fechar
    // a lista é o que torna a operação idempotente entre réplicas: o segundo
    // `UPDATE` volta zero linhas e nenhuma auditoria duplicada é gravada.
    // A lista de origem é a do CAMINHO que produziu a decisão, não a do motivo:
    // `attempt_limit` nasce nos dois (na varredura entregável e na
    // reconciliação), e `sending` não está em nenhuma das duas — ver a exceção
    // documentada em `sweepDeliverable`.
    from_statuses: DEAD_LETTER_SOURCES[row.status] ?? ['pending', 'retryable', 'claimed'],
    reason,
    attempt: row.attempt,
    delivery_outcome: row.delivery_outcome,
    ...correlation,
  });
  if (!moved.dead_lettered) {
    recordReconciliation(stats, 'noop');
    return;
  }
  stats.dead_lettered += 1;
  recordReconciliation(stats, 'dead_letter');
  counter(METRIC.OUTBOUND_DEAD_LETTER, { reason });
  logger.error(
    {
      outbound_id: row.outbound_id,
      reason,
      attempt: row.attempt,
      outcome: row.delivery_outcome,
      ops_alert: true,
    },
    'outbound_recovery.dead_lettered',
  );
}

/**
 * (D) DIVERGÊNCIA turno↔outbound, nos dois sentidos.
 *
 * OBSERVAÇÃO, nunca correção — e a razão é assimétrica:
 *
 *   `turn_pending_without_outbound` — consertar seria INVENTAR uma resposta que
 *     a cognição nunca produziu.
 *   `outbound_without_live_turn` — consertar seria CANCELAR uma entrega que
 *     pode estar em voo.
 *
 * As duas contagens vêm do MESMO instante (uma declaração), porque rodadas
 * separadas fariam uma linha que muda de estado entre elas aparecer nas duas
 * contagens ou em nenhuma.
 *
 * Só emite métrica e auditoria quando há divergência: uma auditoria por tick
 * por tenant dizendo "zero" é ruído que esconde a linha que importa.
 */
async function sweepDivergence(scope: RecoveryScope): Promise<void> {
  const d = await outboundRecoveryRepo.countTurnOutboundDivergence();
  const total = d.turn_pending_without_outbound + d.outbound_without_live_turn;
  if (total === 0) return;
  if (d.turn_pending_without_outbound > 0) {
    counter(
      METRIC.OUTBOUND_TURN_INCONSISTENCY,
      { kind: 'turn_pending_without_outbound' },
      d.turn_pending_without_outbound,
    );
  }
  if (d.outbound_without_live_turn > 0) {
    counter(
      METRIC.OUTBOUND_TURN_INCONSISTENCY,
      { kind: 'outbound_without_live_turn' },
      d.outbound_without_live_turn,
    );
  }
  logger.error(
    { ...scope, ...d, ops_alert: true },
    'outbound_recovery.turn_outbound_divergence',
  );
  await audit({
    acao: 'outbound_turn_inconsistency_detected',
    metadata: {
      turn_pending_without_outbound: d.turn_pending_without_outbound,
      outbound_without_live_turn: d.outbound_without_live_turn,
    },
  });
}

/**
 * A varredura de UM escopo. Exportada para que o teste de integração entre pelo
 * MESMO caminho da produção, com o contexto de tenant já aberto pelo chamador.
 */
export async function runOutboundRecoveryForScope(
  scope: RecoveryScope,
): Promise<SweepStats> {
  const stats: SweepStats = { rearmed: 0, reconciled: emptyReconciled(), dead_lettered: 0 };
  await sweepDeliverable(stats);
  await sweepReconciliation(stats);
  await sweepDivergence(scope);
  publishPendingAge(scope, await outboundRecoveryRepo.oldestPendingAgeSeconds());
  return stats;
}

/**
 * Entrypoint do worker. Dispatcher per-tenant — mesmo padrão de
 * `outbound-messages-sweeper.ts` (#292) e `reflection-batch` (#240/#251). Cron
 * registrado em `src/workers/index.ts`.
 *
 * NO-OP com `FEATURE_OUTBOUND_RECOVERY` desligada, e a checagem é a PRIMEIRA
 * linha: sem ela o worker consultaria o banco a cada minuto num deploy que não
 * ligou a fatia. A flag, e não a fase do cron, é o gate.
 *
 * Fail-isolated por escopo: erro em um tenant não interrompe o loop.
 */
export async function runOutboundRecovery(): Promise<void> {
  if (!config.FEATURE_OUTBOUND_RECOVERY) return;

  const scopes = await outboundRecoveryRepo.listScopesWithWork();
  if (scopes.length === 0) {
    logger.debug({}, 'outbound_recovery.idle');
    return;
  }

  let rearmed = 0;
  let deadLettered = 0;
  const reconciled = emptyReconciled();
  let scopesProcessed = 0;
  let scopesFailed = 0;

  for (const scope of scopes) {
    try {
      const stats = await runWithTenantContext(scope, () =>
        runOutboundRecoveryForScope(scope),
      );
      rearmed += stats.rearmed;
      deadLettered += stats.dead_lettered;
      for (const k of Object.keys(reconciled) as ReconciliationResult[]) {
        reconciled[k] += stats.reconciled[k];
      }
      scopesProcessed++;
    } catch (err) {
      scopesFailed++;
      logger.warn(
        { ...scope, err: (err as Error).message },
        'outbound_recovery.scope_failed',
      );
    }
  }

  logger.info(
    {
      scopes: scopes.length,
      scopes_processed: scopesProcessed,
      scopes_failed: scopesFailed,
      rearmed,
      dead_lettered: deadLettered,
      ...reconciled,
    },
    'outbound_recovery.done',
  );
}

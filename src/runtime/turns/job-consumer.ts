/**
 * Issue #504 §Contrato do job — o CONSUMIDOR do payload, na leitura DUAL.
 *
 * Este módulo é o corpo do processor que `src/index.ts` registra em
 * `startAgentWorker`. Ele existe separado do `index.ts` por uma razão só: é o
 * ponto onde a decisão "V1 ou V2" acontece de verdade, e um teste que quisesse
 * provar essa decisão contra uma cópia montada dentro do próprio teste não
 * provaria nada. Aqui há UM caminho, e é o de produção.
 *
 * ─── As três formas de payload e o que cada uma autoriza ────────────────────
 *
 *  **V1** (o que roda hoje): a identidade é a MENSAGEM. Nada muda em relação ao
 *  comportamento anterior a esta issue — `runAgentForMensagem(mensagem_id)`
 *  sob o contexto `system` que o worker já abriu, e a resolução de tenant
 *  continua inteiramente dentro de `core.ts`. É deliberado que este ramo seja
 *  byte-a-byte o de antes: a janela de compatibilidade só é segura se o
 *  caminho legado não for reescrito junto.
 *
 *  **V2**: a identidade é o TURNO. O tenant não vem do payload (não pode: o
 *  schema é `.strict()`), então antes de qualquer trabalho de domínio o escopo
 *  é resolvido a partir da linha persistida por `resolveTurnJobScope` — a
 *  fronteira de confiança, documentada em `scope-resolver.ts`. A partir dali
 *  TODO acesso volta a ser escopado: abrimos `runWithTenantContext` com o par
 *  reconciliado e só então entramos no mesmo `runAgentForMensagem`.
 *
 *  **inválido**: nenhum dos dois parsers reconheceu. Não há turno a executar e
 *  não há escopo a abrir. LANÇA — o job vira retry e depois DLQ, com a métrica
 *  `maia_turn_job_version_total{version="invalid"}` já contabilizada pelo
 *  worker. Engolir seria transformar um payload fora de contrato num turno
 *  silenciosamente perdido.
 *
 * ─── Por que o V2 abre contexto de tenant e o V1 não ────────────────────────
 *
 * Não é assimetria por descuido: é o único ganho de isolamento que o V2 traz
 * de graça. No V1 o worker sabe apenas um `mensagem_id`, então a janela entre
 * o início do job e a resolução do canal roda sob `system` — e tudo que ela
 * emite (auditoria de falha de resolução, métricas de turno) sai atribuído a
 * `system`. No V2 o dono já é conhecido ANTES dessa janela, então ela roda
 * atribuída. `core.ts` continua abrindo o seu próprio contexto ANINHADO com o
 * par que o canal resolver, que vence para o escopo interno — se os dois
 * discordarem (canal re-hospedado entre o ingresso e o worker), quem decide
 * continua sendo o resolver de canal, exatamente como hoje.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { runWithCorrelation, tryGetCorrelation } from '@/observability/correlation.js';
import { histogram } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import { runAgentForMensagem } from '@/agent/core.js';
import type { ParsedAgentTurnJob } from './job.js';
import { resolveTurnJobScope } from './scope-resolver.js';

/**
 * Payload irreconhecível. Tipado (e não um `Error` genérico) para que o
 * `worker.on('failed')` e a DLQ possam distinguir "contrato do job violado" de
 * uma falha de turno — as duas pedem triagem oposta.
 */
export class TurnJobPayloadError extends Error {
  readonly code = 'TURN_JOB_PAYLOAD_INVALID';
  constructor(readonly issue: string) {
    super(
      `payload do job de turno não corresponde a V1 nem a V2 (campo: ${issue}); ` +
        `nenhum turno pode ser identificado a partir dele`,
    );
    this.name = 'TurnJobPayloadError';
  }
}

/**
 * Fatos que só o consumidor consegue descobrir e que o instrumento do worker
 * precisa depois — hoje, o relógio do SLI ponta-a-ponta.
 *
 * É uma CAIXA mutável e não um valor de retorno porque `recordTurnOutcome` roda
 * também no caminho de EXCEÇÃO: um turno que falhou também esperou, e um SLI
 * que só existe para turnos bem-sucedidos se cala exatamente quando a fila está
 * em apuros. Um retorno se perderia no throw.
 */
export type AgentJobFacts = { received_at_ms: number | null };

export async function runAgentTurnJob(
  parsed: ParsedAgentTurnJob,
  facts: AgentJobFacts,
): Promise<void> {
  if (parsed.kind === 'invalid') throw new TurnJobPayloadError(parsed.issue);

  if (parsed.kind === 'v1') {
    // Caminho legado, PRESERVADO. Ver o bloco no topo.
    await runAgentForMensagem(parsed.mensagem_id);
    return;
  }

  // ── V2 ────────────────────────────────────────────────────────────────────
  // Fail-closed por construção: `resolveTurnJobScope` LANÇA em qualquer
  // desfecho que não seja uma resolução inequívoca, então não existe ramo neste
  // arquivo em que um turno rode sem par (tenant, agent) reconciliado.
  const scope = await resolveTurnJobScope(parsed.turn_id);
  facts.received_at_ms = scope.received_at_ms;

  // `maia_queue_wait_ms` recomposta do BANCO. O payload V2 não carrega
  // `enqueued_at_ms` (a issue exige "apenas version e turn_id"), então o
  // relógio da espera passa a ser `agent_turns.queued_at` — que é MAIS durável
  // que o carimbo do produtor: sobrevive a um rearme e a um restart do worker.
  // Ausente quando o turno nunca passou por `markQueued` (rearme direto de
  // `claimed`/`running` com lease vencida); nesse caso não há espera a medir e
  // inventar uma amostra seria pior do que não ter.
  if (scope.queued_at_ms !== null) {
    const waited = Date.now() - scope.queued_at_ms;
    // ATRIBUÍDA de propósito: no V1 esta amostra sai como `system` "por
    // construção" (nada resolveu o tenant ainda — ver o comentário em
    // `queue.ts`). No V2 o dono JÁ é conhecido neste ponto, então passamos a
    // tupla explicitamente e a série da espera na fila passa a responder
    // "de QUEM é o backlog?".
    if (waited >= 0) {
      histogram(METRIC.QUEUE_WAIT_MS, waited, {
        queue: 'agent',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    }
  }

  // Correlação REANCORADA na mensagem. O `trace_id` de um turno é derivado do
  // id do inbound persistido desde a #514 (`deriveTraceId(mensagem_id)`), e é
  // esse valor que o ingresso já gravou nos seus spans. O payload V2 não pode
  // transportá-lo, então o worker o RECONSTRÓI aqui, assim que a mensagem passa
  // a ser conhecida — sem isto o mesmo turno teria dois `trace_id` (um do
  // ingresso, outro do worker) e a waterfall se partiria ao meio.
  //
  // `attempt`/`origin`/`enqueued_at_ms` vêm do contexto EXTERNO aberto pelo
  // worker: são fatos daquela camada, e recalculá-los aqui só criaria uma
  // segunda verdade.
  const outer = tryGetCorrelation();
  logger.debug(
    { turn_id: scope.turn_id, tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    'turn.job_v2_dispatch',
  );

  await runWithTenantContext({ tenant_id: scope.tenant_id, agent_id: scope.agent_id }, () =>
    runWithCorrelation(
      {
        seed: scope.mensagem_id,
        turn_id: scope.turn_id,
        attempt: outer?.attempt ?? 1,
        origin: outer?.origin ?? 'queue',
        received_at_ms: scope.received_at_ms,
        enqueued_at_ms: outer?.enqueued_at_ms ?? scope.queued_at_ms,
      },
      () => runAgentForMensagem(scope.mensagem_id),
    ),
  );
}

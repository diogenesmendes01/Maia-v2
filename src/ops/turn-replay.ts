/**
 * Issue #504 §"Retry, recovery e DLQ" — o REPLAY MANUAL de um turno morto, como
 * operação de operador.
 *
 * Antes desta entrega `replayDeadLetteredTurn` (`src/runtime/turns/lifecycle.ts`)
 * existia sem um único call site: nem CLI, nem rota, nem teste. Uma transição
 * `dead_letter -> queued` auditada que ninguém podia disparar é o mesmo que não
 * ter caminho de recuperação — o operador acabaria fazendo `UPDATE agent_turns`
 * à mão, que é exatamente o que a máquina de estados existe para impedir.
 *
 * Este módulo é a operação; `scripts/dlq.ts` é só o adaptador de linha de
 * comando em volta dele (parse de flags e impressão). A lógica mora aqui para
 * que exista um call site de PRODUÇÃO testável — um teste que reimplementasse a
 * sequência abaixo estaria medindo a si mesmo.
 *
 * ─── A ordem dos três passos é a garantia ───────────────────────────────────
 *
 *  1. **Resolver o dono** pela fronteira de confiança
 *     (`resolveTurnJobScope`). O operador digita um `turn_id`; ele NÃO digita
 *     um tenant, e não deveria — deixar o operador escolher o escopo é deixar
 *     um erro de digitação virar escrita cross-tenant. O escopo sai da linha, e
 *     a mensagem representativa vem reconciliada com ele.
 *  2. **Transicionar por CAS auditado.** `replayDeadLetteredTurn` só sai de
 *     `dead_letter`; qualquer outro estado devolve `replayed: false`. É aqui
 *     que um turno VIVO é protegido de um replay acidental.
 *  3. **Rearmar o transporte** — e só depois do passo 2 ter vencido. Rearmar
 *     antes (ou sem olhar o resultado) armaria um job para um turno que outro
 *     worker pode estar executando: duas tentativas concorrentes, que é
 *     precisamente o que #504 fecha.
 *
 * O rearme usa `enqueueAgent`, que remove o job retido em `completed`/`failed`
 * com o mesmo `jobId` determinístico antes de adicionar. Sem esse passo a
 * BullMQ ignoraria o `add` (id já existente) e o turno ficaria em `queued` para
 * sempre — o "job retido bloqueia rearmamento legítimo" que a issue lista como
 * risco.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { enqueueAgent } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';
import { replayDeadLetteredTurn } from '@/runtime/turns/lifecycle.js';
import { resolveTurnJobScope, type TurnJobScope } from '@/runtime/turns/scope-resolver.js';

export type TurnReplayOutcome =
  | { replayed: true; scope: TurnJobScope }
  /** O CAS recusou: o turno não estava em `dead_letter`. NADA foi rearmado. */
  | { replayed: false; scope: TurnJobScope; reason: 'not_dead_lettered' }
  /**
   * #629 — a ORDEM DA CONVERSA JÁ ESTÁ COMPROMETIDA: existe turno POSTERIOR
   * na mesma stream que já chegou a estado terminal, e devolver este à fila o
   * executaria depois de algo que o usuário já viu.
   *
   * NADA foi rearmado. A remediação NÃO é tentar de novo — a recusa é
   * permanente até alguém decidir o contrário —, é `--reconcile`, que é a porta
   * explícita e auditada da issue-mãe ("exige modo de replay/reconciliação
   * explícito").
   */
  | {
      replayed: false;
      scope: TurnJobScope;
      reason: 'order_committed';
      committed_after: number;
    };

/**
 * Executa o replay manual de um turno. Propaga `TurnScopeUnresolvedError`
 * quando o escopo não pôde ser resolvido — o chamador (CLI) traduz para uma
 * mensagem de operador e um exit code.
 *
 * `rearm: false` existe para o operador que quer apenas devolver o turno ao
 * estado `queued` e deixar o sweep de recovery rearmá-lo (modo autoritativo).
 * O default é rearmar, porque com `FEATURE_TURN_STATE_AUTHORITATIVE` desligada
 * — que é o default hoje — nada mais o faria.
 */
export async function replayTurnByOperator(args: {
  turn_id: string;
  actor: string;
  reason: string;
  rearm?: boolean;
  /**
   * #629 — MODO DE RECONCILIAÇÃO. Atravessa a recusa por ordem comprometida, e
   * a atravessia é auditada como `turn_replay_reconciled`. Sem ele o replay de
   * um turno cuja conversa já andou é RECUSADO — que é o comportamento que a
   * issue-mãe exige ("rearmamento manual não pode violar a ordem já
   * comprometida").
   */
  reconcile?: boolean;
}): Promise<TurnReplayOutcome> {
  const scope = await resolveTurnJobScope(args.turn_id);

  return runWithTenantContext(
    { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    async (): Promise<TurnReplayOutcome> => {
      const result = await replayDeadLetteredTurn({
        turn_id: scope.turn_id,
        actor: args.actor,
        reason: args.reason,
        ...(args.reconcile === true ? { reconcile: true } : {}),
      });
      if (!result.replayed) {
        logger.warn(
          { turn_id: scope.turn_id, actor: args.actor, reason: result.reason },
          'turn.manual_replay_refused',
        );
        // #629 — a recusa por ordem comprometida NÃO é rearmada e NÃO é
        // colapsada com `not_dead_lettered`: a primeira pede `--reconcile`, a
        // segunda pede outro `turn_id`. Um único código mandaria o operador
        // procurar o erro no lugar errado.
        return result.reason === 'order_committed'
          ? {
              replayed: false,
              scope,
              reason: 'order_committed',
              committed_after: result.committed_after,
            }
          : { replayed: false, scope, reason: 'not_dead_lettered' };
      }
      if (args.rearm !== false) {
        await enqueueAgent({
          mensagem_id: scope.mensagem_id,
          turn_id: scope.turn_id,
          ...(scope.received_at_ms !== null ? { received_at_ms: scope.received_at_ms } : {}),
        });
      }
      logger.info(
        {
          turn_id: scope.turn_id,
          tenant_id: scope.tenant_id,
          agent_id: scope.agent_id,
          actor: args.actor,
          rearmed: args.rearm !== false,
          reconcile: args.reconcile === true,
        },
        'turn.manual_replay_done',
      );
      return { replayed: true, scope };
    },
  );
}

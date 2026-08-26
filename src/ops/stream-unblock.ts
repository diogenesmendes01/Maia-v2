/**
 * Issue #629 (fatia F da #505) — o DESBLOQUEIO de uma conversa interditada,
 * como operação de operador.
 *
 * ─── Por que esta porta tem de existir junto com o bloqueio ───────────────
 *
 * A issue-mãe autoriza bloquear a stream "em casos de efeito ou governança
 * críticos", e a mesma frase que autoriza cria a dívida: uma conversa que só
 * pode ser interditada e nunca liberada é a falha nº 5 lida ao pé da letra —
 * *"um turno em DLQ bloqueia a stream para sempre"*. A fatia D (#627) evitou
 * essa falha tornando `dead_letter` liberador; esta fatia reintroduz o bloqueio
 * DE PROPÓSITO, e por isso ela deve, no mesmo commit, a saída.
 *
 * `src/ops/turn-replay.ts` é o precedente exato e a razão de este módulo não
 * ser um bloco em `scripts/dlq.ts`: uma operação que só existe dentro do parser
 * de linha de comando não tem call site de PRODUÇÃO testável, e um teste que
 * reimplementasse a sequência estaria medindo a si mesmo.
 *
 * ─── A ordem dos quatro passos é a garantia ───────────────────────────────
 *
 *  1. **Resolver o dono** pela fronteira de confiança (`resolveTurnJobScope`,
 *     a partir do turno ENVENENADO). O operador digita um id; ele não digita um
 *     tenant, e não deveria — deixá-lo escolher o escopo é deixar um erro de
 *     digitação virar escrita cross-tenant.
 *  2. **CAS do desbloqueio.** `unblocked_at IS NULL` no `WHERE`: dois
 *     operadores simultâneos produzem UM desbloqueio e um `not_blocked`, e a
 *     `audit_log` não ganha duas decisões humanas onde houve uma.
 *  3. **Auditar** — antes do sinal, pela mesma razão de `signalStreamPromotion`:
 *     a `audit_log` é o registro durável de que a plataforma LIBEROU a
 *     conversa. Auditar depois do enqueue deixaria a janela em que o job existe
 *     e nenhuma trilha explica de onde ele veio, que é exatamente a pergunta
 *     feita durante um incidente.
 *  4. **Rearmar o transporte**, e só se houve o que rearmar. Uma conversa
 *     liberada sem head vivo não precisa de wake-up nenhum, e armar um job para
 *     o turno morto seria pedir a execução do que a política acabou de matar.
 *
 * ─── O que este módulo deliberadamente NÃO faz ───────────────────────────
 *
 * Não faz replay do turno envenenado. Desbloquear e ressuscitar são decisões
 * diferentes com riscos diferentes: liberar a conversa deixa as mensagens
 * SEGUINTES andarem (e a semântica quebrada do turno morto fica registrada na
 * DLQ); replayar o turno morto reexecuta um trabalho que já pode ter aplicado
 * metade de um efeito irreversível. Fundi-las num comando faria a segunda
 * acontecer por acidente sempre que alguém quisesse só a primeira. Quem quer as
 * duas roda `unblock` e depois `replay`, nessa ordem — e a segunda passa pelo
 * guarda de ordem comprometida (`src/ops/turn-replay.ts`), como deve.
 */
import { streamBlocksRepo } from '@/db/repositories/stream-block-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { audit } from '@/governance/audit.js';
import { enqueueAgent } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';
import { resolveTurnJobScope, type TurnJobScope } from '@/runtime/turns/scope-resolver.js';

export type StreamUnblockOutcome =
  | {
      unblocked: true;
      scope: TurnJobScope;
      block_id: string;
      /** O turno rearmado, ou `null` quando a conversa não tinha fila viva. */
      rearmed_turn_id: string | null;
    }
  /**
   * Não havia bloqueio ATIVO para a conversa deste turno. NADA mudou.
   *
   * Cobre os três casos que o operador confunde entre si, e por isso o comando
   * imprime o motivo: o id era de outro turno, outro operador já desbloqueou, ou
   * a conversa nunca foi interditada (o turno morreu com política `release`).
   */
  | { unblocked: false; scope: TurnJobScope; reason: 'not_blocked' };

/**
 * Desbloqueia a conversa a que o turno pertence. Propaga
 * `TurnScopeUnresolvedError` quando o escopo não pôde ser resolvido — o
 * chamador (CLI) traduz para mensagem de operador e exit code.
 *
 * `rearm: false` existe pelo mesmo motivo de `replayTurnByOperator`: o operador
 * que quer apenas remover a interdição e deixar o varredor de recovery
 * reencontrar a fila, sem produzir um job imediato.
 */
export async function unblockStreamByOperator(args: {
  turn_id: string;
  actor: string;
  reason: string;
  rearm?: boolean;
}): Promise<StreamUnblockOutcome> {
  const scope = await resolveTurnJobScope(args.turn_id);

  return runWithTenantContext(
    { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
    async (): Promise<StreamUnblockOutcome> => {
      const active = await streamBlocksRepo.findActiveByTurn(scope.turn_id);
      if (!active) {
        logger.warn(
          { turn_id: scope.turn_id, actor: args.actor },
          'stream.unblock_refused_not_blocked',
        );
        return { unblocked: false, scope, reason: 'not_blocked' };
      }

      const result = await streamBlocksRepo.unblockTx({
        block_id: active.id,
        actor: args.actor,
        reason: args.reason,
      });
      if (!result.ok) {
        // Corrida perdida: outro operador desbloqueou entre a leitura e o CAS.
        // NÃO é erro, e não audita — a decisão humana que valeu foi a dele.
        logger.warn(
          { turn_id: scope.turn_id, block_id: active.id, actor: args.actor },
          'stream.unblock_lost_race',
        );
        return { unblocked: false, scope, reason: 'not_blocked' };
      }

      await audit({
        acao: 'stream_unblocked',
        alvo_id: result.block.blocked_by_turn_id,
        metadata: {
          block_id: result.block.id,
          category: result.block.category,
          reason: result.block.reason,
          actor: args.actor,
          operator_reason: args.reason,
          blocked_by_turn_id: result.block.blocked_by_turn_id,
          rearmed_turn_id: result.head?.turn_id ?? null,
        },
      });

      if (result.head && args.rearm !== false) {
        // `turn_id` no payload é o que torna o `jobId` DETERMINÍSTICO (#504):
        // se o varredor já tiver rearmado este mesmo head, a BullMQ ignora o
        // segundo `add` em vez de produzir duas execuções.
        await enqueueAgent({
          mensagem_id: result.head.representative_message_id,
          turn_id: result.head.turn_id,
        });
      }

      logger.info(
        {
          turn_id: scope.turn_id,
          block_id: result.block.id,
          actor: args.actor,
          rearmed_turn_id: result.head?.turn_id ?? null,
          rearmed: result.head !== null && args.rearm !== false,
        },
        'stream.unblocked',
      );
      return {
        unblocked: true,
        scope,
        block_id: result.block.id,
        rearmed_turn_id: args.rearm === false ? null : (result.head?.turn_id ?? null),
      };
    },
  );
}

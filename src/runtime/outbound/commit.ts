/**
 * Issue #631 (fatia B da épica #506) — a FRONTEIRA que o dispatcher de saída
 * atravessa antes de qualquer chamada ao canal.
 *
 * O defeito que esta fatia corrige, textualmente da auditoria da #506: em
 * `src/agent/output-dispatch.ts` o ledger era tratado em caminho OPCIONAL e
 * FAIL-OPEN (`claimOutboundLedgerOrFailOpen` — "log the issue and proceed as
 * if there's no prior row"), e enviar e persistir ficavam separados por uma
 * janela de crash. As duas coisas têm a mesma consequência: existe estado do
 * mundo — uma mensagem no telefone de alguém — que o PostgreSQL nunca soube
 * que ia existir.
 *
 * `commitOutboundIntent` inverte a ordem e fecha a porta:
 *
 *   1. constrói o artefato determinístico de #630 (payload validado,
 *      `payload_hash`, as duas chaves);
 *   2. abre UMA transação que valida o `claim_token` do turno, insere o
 *      artefato com a `logical_dedupe_key`, move o turno para
 *      `outbound_pending` e grava a auditoria — commit;
 *   3. só então devolve o controle a quem vai chamar o canal.
 *
 * Se qualquer passo falhar, ela LANÇA. Não há retorno "deu ruim, siga em
 * frente"; não há `catch` que registre e prossiga. É a diferença inteira entre
 * esta fatia e o código que ela substitui.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 * Não envia, não enfileira e não decide política de entrega. O delivery worker
 * com claim/lease é a #632; recovery, reconciliação e DLQ são a #633; o
 * inventário de TODOS os caminhos de envio é a #634; multipart é a #635.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { counter, METRIC } from '@/observability/metrics.js';
import {
  outboundOutboxRepo,
  OutboundCommitError,
  type OutboundOutboxRow,
} from '@/db/repositories/outbound-outbox-repo.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { turnStateMachineEnabled } from '@/runtime/turns/lifecycle.js';
import { instrumentOutboundCommit } from '@/observability/instrumentation.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import { getOutboundTurnScope } from './turn-scope.js';
import {
  buildOutboundArtifact,
  type OutboundPayload,
  type OutboundProviderChannel,
} from './contract.js';

export { OutboundCommitError };

/**
 * O commit foi PULADO porque não existe turno durável para ancorá-lo.
 *
 * Os casos, todos legítimos e todos pré-existentes a esta fatia: workers de
 * agenda e lembretes, playground, testes, e o regime de rollback em que
 * `FEATURE_TURN_STATE_MACHINE` está desligada. Nenhum deles tem `turn_id`, e a
 * FK composta `(tenant_id, agent_id, turn_id)` da migração 121 torna a row
 * durável literalmente inexprimível sem ele.
 *
 * É um desfecho NOMEADO e não um `undefined` silencioso porque a diferença
 * entre "não havia turno" e "o commit não rodou por engano" é a diferença
 * entre escopo declarado e buraco. Migrar esses caminhos é a #634.
 */
export type OutboundCommitSkip = {
  committed: false;
  reason: 'no_turn_scope' | 'turn_state_machine_off' | 'feature_disabled';
};

export type OutboundCommitted = {
  committed: true;
  outbound_id: string;
  /** `false` quando a saída lógica já existia — retry da MESMA resposta. */
  inserted: boolean;
  row: OutboundOutboxRow;
};

export type OutboundCommitOutcome = OutboundCommitted | OutboundCommitSkip;

/**
 * A posse perdida DEPOIS do claim e ANTES do commit.
 *
 * Mesma leitura de três estados de `resolveFence` (`src/runtime/turns/lifecycle.ts`):
 * `unfenced` (não há lease — regime de rollback de #504), `fenced` (token vivo)
 * e `lost` (a lease EXISTIU e morreu). Colapsar `lost` em `unfenced` é o erro
 * que aquele módulo documenta em detalhe: sem `expected_claim_token` o UPDATE
 * perde o predicado de posse e sobra só o CAS de versão — que um zumbi passa
 * sempre que o `state_version` não andou.
 */
type CommitFence =
  | { kind: 'unfenced' }
  | { kind: 'fenced'; claim_token: string }
  | { kind: 'lost' };

function resolveCommitFence(handle: TurnHandle): CommitFence {
  const lease = handle.lease;
  if (!lease) return { kind: 'unfenced' };
  const token = lease.token;
  if (token === null) return { kind: 'lost' };
  return { kind: 'fenced', claim_token: token };
}

export type CommitOutboundIntentInput = {
  /** O payload já na união de #630. Validado de novo em `buildOutboundArtifact`. */
  payload: OutboundPayload;
  /** Canal de egresso. Fechado — hoje só `whatsapp`. */
  channel: OutboundProviderChannel;
  /**
   * Posição da saída no turno. DETERMINÍSTICA e escolhida pelo call site, nunca
   * "a próxima livre".
   *
   * A tentação é alocar `max(sequence)+1` dentro da transação. Ela quebra o
   * critério de pronto mais importante desta fatia: um retry da MESMA resposta
   * receberia posição 1, derivaria outra `logical_dedupe_key` (a posição entra
   * no material) e produziria uma SEGUNDA linha — o duplo envio, criado pelo
   * mecanismo que existe para impedi-lo. Com a posição fixa por call site, o
   * retry recalcula a mesma chave e o unique da 121 devolve a linha que já
   * existe.
   */
  sequence_in_turn: number;
  conversa_id: string;
  in_reply_to: string;
  pessoa_id?: string | null;
};

/**
 * Commita a intenção de resposta. LANÇA se não conseguir.
 *
 * Chamada IMEDIATAMENTE antes da chamada ao canal, em cada limite de efeito de
 * `src/agent/output-dispatch.ts`. "Imediatamente" é literal: qualquer trabalho
 * entre o commit e o envio é trabalho que pode falhar com a resposta já
 * comprometida, e cada await ali é uma janela nova.
 */
export function commitOutboundIntent(
  input: CommitOutboundIntentInput,
): Promise<OutboundCommitOutcome> {
  // Issue #535 — span `outbound.commit`. É a fronteira de saída que SOBREVIVEU
  // à migração para o outbox: desde #316/#630 o envio físico acontece no
  // delivery worker, a um processo e vários minutos de distância, então o span
  // que pertence ao TURNO é este — a transação que torna a resposta durável e
  // que, por #631, precisa ter sucesso antes de qualquer coisa chegar ao canal.
  // É também por isso que `whatsapp.send` saiu da taxonomia em vez de ganhar
  // emissor; ver `SPANS_REMOVED_IN_535`.
  //
  // O envelope inclui os três `return` de regime de propósito: "não commitou
  // porque a flag está desligada" é um desfecho tão observável quanto o commit,
  // e é o que distingue escopo declarado de buraco.
  return instrumentOutboundCommit(
    () => commitOutboundIntentInner(input),
    (o) => (o.committed ? 'committed' : o.reason),
  );
}

async function commitOutboundIntentInner(
  input: CommitOutboundIntentInput,
): Promise<OutboundCommitOutcome> {
  // ── Regime. As três razões de NÃO commitar, todas nomeadas. ─────────────
  //
  // A flag é kill switch de rollback e NÃO pode ficar desligada em produção:
  // `src/config/rules.ts` (regra `outbound-commit/production-required`) recusa
  // o BOOT nesse caso. Ou seja, este `return` só é alcançável fora de
  // produção — é a única forma de uma flag existir sem ser um caminho
  // fail-open, que é o que #631 §Escopo de flag exige.
  if (!config.FEATURE_OUTBOUND_DURABLE_COMMIT) {
    return { committed: false, reason: 'feature_disabled' };
  }
  if (!turnStateMachineEnabled()) {
    return { committed: false, reason: 'turn_state_machine_off' };
  }
  const handle = getOutboundTurnScope();
  if (!handle) return { committed: false, reason: 'no_turn_scope' };

  const fence = resolveCommitFence(handle);
  if (fence.kind === 'lost') {
    // A posse morreu entre o claim e aqui. Não vamos nem ao banco: o UPDATE
    // seria recusado de qualquer forma, e ir até lá com token morto depende de
    // a lease do sucessor JÁ estar registrada — entre a perda e o takeover
    // existe uma janela em que o token antigo ainda é o vigente na linha, e
    // nela a gravação passaria. Mesmo raciocínio de `refuseLostOwnership`.
    counter(METRIC.OUTBOUND_COMMIT_REJECTED, { reason: 'ownership_lost' });
    throw new OutboundCommitError('stale_claim', handle.turn_id);
  }

  // ── (1) O ARTEFATO. Puro, determinístico, e fora da transação de propósito:
  // construí-lo dentro só faria a transação viver mais tempo segurando o lock
  // da linha do turno. Ele valida o payload (fail-closed) e deriva as duas
  // chaves; um payload inválido lança AQUI, antes de qualquer escrita.
  //
  // `tenant_id`/`agent_id` vêm do ALS de `src/db/tenant-context.ts` — a MESMA
  // fonte que o repositório consulta DENTRO da transação, e que ele compara
  // com o artefato antes de gravar. Não vêm do handle porque o handle não os
  // carrega: duplicar a informação criaria duas verdades sobre a mesma coisa,
  // e a que estivesse errada seria a que derivaria a chave.
  const artifact = buildOutboundArtifact({
    tenant_id: getCurrentTenant(),
    agent_id: getCurrentAgent(),
    turn_id: handle.turn_id,
    sequence_in_turn: input.sequence_in_turn,
    payload: input.payload,
    channel: input.channel,
  });

  // ── (2) A TRANSAÇÃO. Ver `outbound-outbox-repo.ts`. ─────────────────────
  let result;
  try {
    result = await outboundOutboxRepo.commitTurnOutboundTx({
      artifact,
      conversa_id: input.conversa_id,
      in_reply_to: input.in_reply_to,
      expected_state_version: handle.state_version,
      ...(fence.kind === 'fenced' ? { expected_claim_token: fence.claim_token } : {}),
      ...(input.pessoa_id !== undefined ? { pessoa_id: input.pessoa_id } : {}),
    });
  } catch (err) {
    counter(METRIC.OUTBOUND_COMMIT_REJECTED, {
      reason: err instanceof OutboundCommitError ? err.rejection : 'db_error',
    });
    logger.error(
      {
        turn_id: handle.turn_id,
        sequence_in_turn: input.sequence_in_turn,
        payload_type: artifact.payload_type,
        err: (err as Error).message,
        ops_alert: true,
      },
      'outbound.commit_failed_send_blocked',
    );
    // RELANÇA. Este é o ponto da issue: falha do ledger IMPEDE o envio, com
    // erro observável. Trocar este `throw` por um `return` fail-open é a
    // reintrodução exata do defeito — e é o que a sonda 2 verifica.
    throw err;
  }

  // ── (3) O HANDLE em memória segue o banco. ──────────────────────────────
  //
  // `concludeTurn` grava com `expected_version: handle.state_version`. Sem
  // esta atualização o CAS seguinte usaria a versão ANTERIOR ao commit, seria
  // recusado como `state_mismatch`, e o turno ficaria preso em
  // `outbound_pending` — resposta entregue, turno eternamente aberto. É a
  // consequência silenciosa mais provável desta fatia, e a razão de o escopo
  // guardar o handle POR REFERÊNCIA.
  handle.status = 'outbound_pending';
  handle.state_version = Number(result.turn.state_version);
  handle.conversa_id = result.turn.conversa_id;

  counter(METRIC.OUTBOUND_COMMITTED, { kind: artifact.payload_type });
  logger.info(
    {
      turn_id: handle.turn_id,
      outbound_id: result.row.id,
      sequence_in_turn: input.sequence_in_turn,
      payload_type: artifact.payload_type,
      idempotent_reuse: !result.inserted,
    },
    'outbound.committed',
  );
  return {
    committed: true,
    outbound_id: result.row.id,
    inserted: result.inserted,
    row: result.row,
  };
}


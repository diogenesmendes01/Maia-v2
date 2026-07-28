/**
 * Issue #503 — fachada de ciclo de vida do turno usada pelo runtime.
 *
 * É a ÚNICA porta pela qual gateway/agent/workers falam com a máquina de
 * estados. Três responsabilidades que o repositório deliberadamente não tem:
 *
 *   1. **Flag de rollout.** Tudo aqui é no-op quando
 *      `FEATURE_TURN_STATE_MACHINE` está OFF, então o kill switch da issue
 *      (§ Migration e rollout, passo 4) devolve o runtime ao comportamento
 *      anterior sem tocar em código.
 *   2. **Política de falha por MODO.** Em shadow/dual-write a máquina é uma
 *      trilha PARALELA (`processada_em` decide), então falha ao transicionar
 *      vira log + métrica e nunca derruba o turno do usuário. Em AUTORITATIVO
 *      isso se inverte: fail-soft contradiria "PostgreSQL é a fonte de
 *      verdade", então a falha propaga como `TurnStateWriteError` e o turno
 *      não avança. Ver `guarded()`.
 *   3. **Auditoria e observabilidade.** Descarte por política, dead letter,
 *      replay manual, conclusão sem resposta e detecção de inconsistência
 *      geram `audit()`; o resto vira métrica + log estruturado.
 *
 * Campos permitidos em log/auditoria (issue §Observabilidade): turn_id,
 * tenant_id, agent_id, conversation_id, from_status, to_status, attempt,
 * error_code, latency_ms. NUNCA texto, prompt, telefone, JID ou resposta.
 */
import { config } from '@/config/env.js';
import { agentTurnsRepo, type TurnTransitionResult } from '@/db/repositories/turn-repos.js';
import type { AgentTurn, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import {
  COMPLETED_WITHOUT_REPLY_OUTCOMES,
  sanitizeTurnError,
  type TurnOutcome,
  type TurnStatus,
} from './contract.js';

/** Referência viva a um turno em execução. `state_version` é o token do CAS. */
export type TurnHandle = {
  turn_id: string;
  status: TurnStatus;
  state_version: number;
  attempt_count: number;
  conversa_id: string | null;
};

/** Dual-write ligado? (escrita da máquina de estados) */
export function turnStateMachineEnabled(): boolean {
  return config.FEATURE_TURN_STATE_MACHINE;
}

/** Leitura nova já é autoritativa? (recovery elege por estado, não por timestamp) */
export function turnStateAuthoritative(): boolean {
  return config.FEATURE_TURN_STATE_MACHINE && config.FEATURE_TURN_STATE_AUTHORITATIVE;
}

function toHandle(turn: AgentTurn): TurnHandle {
  return {
    turn_id: turn.id,
    status: turn.status as TurnStatus,
    state_version: Number(turn.state_version),
    attempt_count: turn.attempt_count,
    conversa_id: turn.conversa_id,
  };
}

/**
 * Aplica um resultado de transição: atualiza o handle no sucesso, registra
 * conflito no fracasso. Devolve `true` quando a transição venceu.
 */
function applyResult(handle: TurnHandle, result: TurnTransitionResult): boolean {
  if (result.ok) {
    const from = handle.status;
    handle.status = result.turn.status as TurnStatus;
    handle.state_version = Number(result.turn.state_version);
    handle.attempt_count = result.turn.attempt_count;
    handle.conversa_id = result.turn.conversa_id;
    logger.debug(
      {
        turn_id: handle.turn_id,
        from_status: from,
        to_status: handle.status,
        attempt: handle.attempt_count,
      },
      'turn.transitioned',
    );
    return true;
  }
  logger.warn(
    {
      turn_id: handle.turn_id,
      from_status: handle.status,
      to_status: result.to,
      conflict: result.conflict,
      ...(result.conflict === 'state_mismatch'
        ? { current_status: result.current_status, current_state_version: result.current_state_version }
        : {}),
    },
    'turn.transition_conflict',
  );
  return false;
}

/**
 * Falha BLOQUEANTE de escrita da máquina de estados. Só existe em modo
 * autoritativo — ver `guarded()`.
 */
export class TurnStateWriteError extends Error {
  readonly code = 'TURN_STATE_WRITE_FAILED';
  readonly op: string;
  readonly error_code: string;

  constructor(op: string, error_code: string, cause: unknown) {
    super(
      `falha ao persistir transição de turno (op=${op}, error_code=${error_code}); ` +
        `em modo autoritativo o PostgreSQL é a fonte de verdade, então o turno NÃO pode ` +
        `prosseguir como se tivesse sido gravado`,
      { cause },
    );
    this.name = 'TurnStateWriteError';
    this.op = op;
    this.error_code = error_code;
  }
}

/**
 * Executa uma operação da máquina de estados aplicando a política de falha do
 * MODO CORRENTE.
 *
 * SHADOW / dual-write (`FEATURE_TURN_STATE_AUTHORITATIVE=false`): a máquina é
 * um OBSERVADOR — `mensagens.processada_em` é quem decide. Uma falha de
 * escrita não pode derrubar o turno do usuário, então vira log + métrica e a
 * função devolve `null`.
 *
 * AUTORITATIVO: fail-soft passa a CONTRADIZER a invariante "PostgreSQL é a
 * fonte de verdade" — a persistência falharia e o caller seguiria adiante,
 * gravando `processada_em` e deixando o turno `running` sem lease, invisível
 * para o recovery (achado P1 da rodada 1). Nesse modo o erro é PROPAGADO como
 * `TurnStateWriteError`: o job do BullMQ falha, nada é projetado no campo
 * legado, e o turno continua elegível.
 *
 * `blocking: false` força o comportamento shadow — usado só pelo probe de
 * divergência, que é observabilidade e nunca deve derrubar o sweep.
 */
async function guarded<T>(
  op: string,
  fn: () => Promise<T>,
  opts: { blocking?: boolean } = {},
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TurnStateWriteError) throw err; // já contabilizado
    const { code } = sanitizeTurnError({ error: err });
    incCounter('maia_turn_state_errors_total', { op, error_code: code });
    const blocking = opts.blocking ?? turnStateAuthoritative();
    if (blocking) {
      logger.error({ op, error_code: code, ops_alert: true }, 'turn.state_write_failed');
      throw new TurnStateWriteError(op, code, err);
    }
    logger.warn({ op, error_code: code }, 'turn.state_write_failed');
    return null;
  }
}

/**
 * Garante que a mensagem inbound tem turno e devolve o handle.
 *
 * Caminho normal: o turno já existe (criado ATOMICAMENTE com o inbound no
 * ingresso). Caminho de compatibilidade: rows persistidas antes desta issue,
 * ou por um nó ainda sem o dual-write durante deploy rolling — nesse caso o
 * turno é criado agora, em `received`.
 */
export async function ensureTurnHandle(
  mensagem: Pick<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'conversa_id' | 'channel_id'>,
): Promise<TurnHandle | null> {
  if (!turnStateMachineEnabled()) return null;
  return guarded('ensure_turn', async () => {
    const existing = await agentTurnsRepo.findTurnByMessage(mensagem.id);
    if (existing) return toHandle(existing);
    const created = await agentTurnsRepo.ensureTurnForMessage(mensagem);
    logger.info({ turn_id: created.id, conversation_id: created.conversa_id }, 'turn.created');
    return toHandle(created);
  });
}

/** `received | retryable -> queued` — o wake-up do BullMQ foi confirmado. */
export async function noteTurnQueued(handle: TurnHandle | null): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  await guarded('mark_queued', async () => {
    const result = await agentTurnsRepo.markQueued({
      turn_id: handle.turn_id,
      expected_version: handle.state_version,
    });
    applyResult(handle, result);
  });
}

/**
 * O enqueue falhou (Redis OOM/indisponível). O turno permanece em `received` —
 * NÃO vira `retryable`, porque nem tentativa houve: o recovery reencontra
 * `received` antigo e rearma. Só registramos o erro para triagem.
 */
export async function noteTurnEnqueueFailed(
  handle: TurnHandle | null,
  args: { code: string; error: unknown },
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  const { code } = sanitizeTurnError({ code: args.code, error: args.error });
  incCounter('maia_turn_enqueue_failures_total', { error_code: code });
  logger.warn({ turn_id: handle.turn_id, error_code: code }, 'turn.enqueue_failed');
}

/**
 * Marca o início da execução (`-> claimed -> running`).
 *
 * NÃO é um claim distribuído: nesta issue a máquina de estados registra que a
 * execução começou, mas NÃO decide quem executa — dois workers ainda podem
 * entrar no mesmo turno. O claim atômico com lease e fencing é #504, que
 * substitui o miolo daqui preservando esta assinatura. Por isso um conflito
 * aqui NUNCA aborta o turno: seria uma falsa sensação de exclusão mútua.
 */
export async function beginTurnExecution(
  handle: TurnHandle | null,
  args: { conversa_id?: string | null; channel_id?: string | null } = {},
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  await guarded('begin_execution', async () => {
    // Reentrada de um turno em RETRY. O recovery normalmente já fez
    // `retryable -> queued` ao rearmar, mas um retry do próprio BullMQ chega
    // aqui direto de `retryable`. Sem esta perna o turno executaria inteiro
    // ainda marcado `retryable`, e a conclusão terminal falharia no CAS
    // (`retryable` não alcança `completed`) — o turno voltaria à fila para
    // sempre. `retryable -> queued` é aresta do contrato, então a cadeia
    // completa é retryable -> queued -> claimed -> running.
    if (handle.status === 'retryable') {
      applyResult(
        handle,
        await agentTurnsRepo.markQueued({
          turn_id: handle.turn_id,
          expected_version: handle.state_version,
        }),
      );
    }
    if (handle.status === 'received' || handle.status === 'queued') {
      applyResult(
        handle,
        await agentTurnsRepo.markClaimed({
          turn_id: handle.turn_id,
          expected_version: handle.state_version,
        }),
      );
    }
    if (handle.status === 'claimed') {
      applyResult(
        handle,
        await agentTurnsRepo.markRunning({
          turn_id: handle.turn_id,
          expected_version: handle.state_version,
          ...(args.conversa_id !== undefined ? { conversa_id: args.conversa_id } : {}),
          ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
        }),
      );
    }
  });
}

/**
 * Incorpora as mensagens agregadas pelo debounce ao turno em execução.
 *
 * Duas situações por mensagem irmã:
 *   - sem turno (row legada / ingresso sem dual-write): vira input deste turno;
 *   - com turno próprio (o ingresso criou um por mensagem): o turno da irmã é
 *     marcado `superseded`/`merged_into_turn` e a associação input permanece
 *     onde está — assim a trilha mostra que aquele turno foi absorvido, sem
 *     violar "uma mensagem pertence a no máximo um turno".
 *
 * A associação DEFINITIVA (um turno por rajada, decidido no ingresso) é
 * fechada em #505 — aqui o objetivo é que a rajada produza UM turno executável
 * e nenhum turno órfão executável.
 */
export async function absorbDebounceInputs(
  handle: TurnHandle | null,
  mensagem_ids: readonly string[],
): Promise<void> {
  if (!handle || !turnStateMachineEnabled() || mensagem_ids.length === 0) return;
  await guarded('absorb_inputs', async () => {
    let seq = 1;
    for (const mensagem_id of mensagem_ids) {
      const sibling = await agentTurnsRepo.findTurnByMessage(mensagem_id);
      if (!sibling) {
        await agentTurnsRepo.attachInputTx({
          turn_id: handle.turn_id,
          mensagem_id,
          ingress_seq: seq++,
        });
        continue;
      }
      if (sibling.id === handle.turn_id) continue;
      const result = await agentTurnsRepo.markSuperseded({
        turn_id: sibling.id,
        expected_version: Number(sibling.state_version),
      });
      if (result.ok) {
        logger.debug(
          { turn_id: sibling.id, to_status: 'superseded', absorbed_by: handle.turn_id },
          'turn.transitioned',
        );
      }
    }
  });
}

/**
 * Conclui o turno com um outcome EXPLÍCITO.
 *
 * O estado alvo é derivado do outcome pelo contrato (um outcome pertence a um
 * único estado terminal), de modo que o caller declara o RESULTADO DE NEGÓCIO e
 * nunca escolhe o estado — é assim que "nenhum turno é concluído simplesmente
 * porque uma função retornou" fica garantido.
 */
export async function concludeTurn(
  handle: TurnHandle | null,
  outcome: TurnOutcome,
  ctx: { pessoa_id?: string | null; mensagem_id?: string | null } = {},
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  await guarded('conclude', async () => {
    const from = handle.status;
    const result =
      outcome === 'merged_into_turn'
        ? await agentTurnsRepo.markSuperseded({
            turn_id: handle.turn_id,
            expected_version: handle.state_version,
          })
        : IGNORED_OUTCOMES.has(outcome)
          ? await agentTurnsRepo.markIgnored({
              turn_id: handle.turn_id,
              outcome,
              expected_version: handle.state_version,
            })
          : await agentTurnsRepo.completeTurnTx({
              turn_id: handle.turn_id,
              outcome,
              expected_version: handle.state_version,
            });
    if (!applyResult(handle, result)) return;

    if (IGNORED_OUTCOMES.has(outcome)) {
      await audit({
        acao: 'turn_ignored_by_policy',
        ...(ctx.pessoa_id ? { pessoa_id: ctx.pessoa_id } : {}),
        ...(handle.conversa_id ? { conversa_id: handle.conversa_id } : {}),
        ...(ctx.mensagem_id ? { mensagem_id: ctx.mensagem_id } : {}),
        alvo_id: handle.turn_id,
        metadata: { from_status: from, to_status: 'ignored', outcome },
      });
      return;
    }
    if (COMPLETED_WITHOUT_REPLY_OUTCOMES.includes(outcome)) {
      await audit({
        acao: 'turn_completed_without_reply',
        ...(ctx.pessoa_id ? { pessoa_id: ctx.pessoa_id } : {}),
        ...(handle.conversa_id ? { conversa_id: handle.conversa_id } : {}),
        ...(ctx.mensagem_id ? { mensagem_id: ctx.mensagem_id } : {}),
        alvo_id: handle.turn_id,
        metadata: { from_status: from, to_status: 'completed', outcome },
      });
    }
  });
}

/** Outcomes que pertencem ao estado `ignored` (descarte intencional). */
const IGNORED_OUTCOMES: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>([
  'blocked_by_policy',
  'identity_unknown',
  'identity_blocked',
  'quarantined',
  'rate_limited_silent',
  'operator_cancelled',
]);

/** Backoff exponencial com teto, em ms — 30s, 60s, 120s, … até 15min. */
export function retryDelayMs(attempt: number): number {
  const base = 30_000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, 15 * 60_000);
}

/** Tentativas antes do dead letter (espelha `attempts: 3` do BullMQ). */
export const MAX_TURN_ATTEMPTS = 3;

/**
 * A tentativa falhou ANTES de efeito irreversível: agenda retry, ou manda para
 * dead letter quando as tentativas se esgotaram.
 *
 * É este caminho que fecha os cenários A e B da issue — timeout do reasoner e
 * falha pre-send do outbound deixam de virar `completed`.
 */
export async function failTurnRetryable(
  handle: TurnHandle | null,
  args: { code: string; error?: unknown; mensagem_id?: string | null },
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  const { code, summary } = sanitizeTurnError({ code: args.code, error: args.error });
  // Esgotou as tentativas: dead letter. FORA do `guarded` abaixo para não
  // aninhar duas políticas de falha (a contagem em `maia_turn_state_errors_total`
  // sairia dobrada e o `op` do erro seria o do wrapper externo, não o real).
  if (handle.attempt_count >= MAX_TURN_ATTEMPTS) {
    await deadLetterTurn(handle, { code, summary, outcome: 'retry_exhausted' });
    return;
  }
  await guarded('fail_retryable', async () => {
    const next = new Date(Date.now() + retryDelayMs(handle.attempt_count + 1));
    const from = handle.status;
    const result = await agentTurnsRepo.markRetryable({
      turn_id: handle.turn_id,
      next_attempt_at: next,
      error_code: code,
      error_summary: summary,
      expected_version: handle.state_version,
    });
    if (!applyResult(handle, result)) return;
    incCounter('maia_turn_retries_total', { error_code: code });
    logger.info(
      {
        turn_id: handle.turn_id,
        from_status: from,
        to_status: 'retryable',
        attempt: handle.attempt_count,
        error_code: code,
      },
      'turn.retry_scheduled',
    );
  });
}

/** Terminal por esgotamento/intervenção. Sempre auditado. */
export async function deadLetterTurn(
  handle: TurnHandle | null,
  args: {
    code: string;
    summary?: string | null;
    outcome?: 'retry_exhausted' | 'operator_cancelled';
    error?: unknown;
  },
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  const sanitized =
    args.summary !== undefined
      ? { code: args.code, summary: args.summary }
      : sanitizeTurnError({ code: args.code, error: args.error });
  await guarded('dead_letter', async () => {
    const from = handle.status;
    const result = await agentTurnsRepo.markDeadLetter({
      turn_id: handle.turn_id,
      outcome: args.outcome ?? 'retry_exhausted',
      error_code: sanitized.code,
      error_summary: sanitized.summary,
      expected_version: handle.state_version,
    });
    if (!applyResult(handle, result)) return;
    logger.error(
      {
        turn_id: handle.turn_id,
        from_status: from,
        to_status: 'dead_letter',
        attempt: handle.attempt_count,
        error_code: sanitized.code,
        ops_alert: true,
      },
      'turn.dead_lettered',
    );
    await audit({
      acao: 'turn_dead_lettered',
      ...(handle.conversa_id ? { conversa_id: handle.conversa_id } : {}),
      alvo_id: handle.turn_id,
      metadata: {
        from_status: from,
        to_status: 'dead_letter',
        attempt: handle.attempt_count,
        error_code: sanitized.code,
        outcome: args.outcome ?? 'retry_exhausted',
      },
    });
  });
}

/**
 * Replay MANUAL de dead letter — operação de operador, explícita e auditada,
 * que gera nova tentativa. NÃO é chamada por nenhum caminho automático.
 */
export async function replayDeadLetteredTurn(args: {
  turn_id: string;
  actor: string;
  reason: string;
}): Promise<{ replayed: boolean }> {
  const turn = await agentTurnsRepo.findById(args.turn_id);
  if (!turn) return { replayed: false };
  const result = await agentTurnsRepo.replayDeadLetterTx({
    turn_id: args.turn_id,
    expected_version: Number(turn.state_version),
  });
  if (!result.ok) {
    logger.warn(
      { turn_id: args.turn_id, to_status: 'queued', conflict: result.conflict },
      'turn.transition_conflict',
    );
    return { replayed: false };
  }
  await audit({
    acao: 'turn_replayed',
    ...(result.turn.conversa_id ? { conversa_id: result.turn.conversa_id } : {}),
    alvo_id: args.turn_id,
    metadata: {
      from_status: 'dead_letter',
      to_status: 'queued',
      attempt: result.turn.attempt_count,
      actor: args.actor,
      reason: args.reason,
    },
  });
  return { replayed: true };
}

/**
 * Shadow-read (issue §6, passo 6 do rollout): mede a divergência entre a
 * máquina de estados e a projeção legada `processada_em`, no escopo corrente.
 * Só MEDE — a correção é decisão do operador (ver runbook). Emite auditoria
 * quando encontra divergência, porque a issue exige auditar "detecção de
 * inconsistência".
 */
export async function reportLegacyProjectionDivergence(): Promise<{
  terminal_without_projection: number;
  projection_without_terminal: number;
} | null> {
  if (!turnStateMachineEnabled()) return null;
  // `blocking: false` SEMPRE: o probe é observabilidade. Derrubar o sweep de
  // recovery porque a medição de divergência falhou seria trocar um problema
  // de visibilidade por um de disponibilidade.
  return guarded('projection_divergence', async () => {
    const counts = await agentTurnsRepo.countLegacyProjectionMismatch();
    const total = counts.terminal_without_projection + counts.projection_without_terminal;
    if (total === 0) return counts;
    incCounter(
      'maia_turn_legacy_projection_mismatch_total',
      { kind: 'terminal_without_projection' },
      counts.terminal_without_projection,
    );
    incCounter(
      'maia_turn_legacy_projection_mismatch_total',
      { kind: 'projection_without_terminal' },
      counts.projection_without_terminal,
    );
    logger.warn({ ...counts }, 'turn.legacy_projection_mismatch');
    await audit({
      acao: 'turn_state_inconsistency_detected',
      metadata: { ...counts },
    });
    return counts;
  }, { blocking: false });
}

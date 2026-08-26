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
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import type { LeaseLossReason, StreamBlockRecord } from './claim.js';
import {
  COMPLETED_WITHOUT_REPLY_OUTCOMES,
  sanitizeTurnError,
  type TurnOutcome,
  type TurnStatus,
} from './contract.js';
import {
  acquireTurnLease,
  reportFenceRejection,
  turnClaimEnabled,
  type TurnLease,
} from './lease.js';

// #626 — a fachada reexporta o relator de violação de FIFO porque quem o chama
// não é só o claim: o varredor de recovery (`src/workers/message-recovery.ts`)
// tem um canário próprio, e a regra da fachada é "importe sempre de
// `@/runtime/turns/index.js`".
export { reportStreamFifoViolation } from './lease.js';
// #627 (fatia D da #505) — o SINAL da promoção. Módulo à parte porque ele é
// quem alcança a BullMQ (por `await import`, para não arrastar a conexão Redis
// de `@/gateway/queue.js` para dentro de todo processo que carrega a máquina de
// estados); ver o cabeçalho de `stream-promotion.ts`.
import {
  noteNoSuccessor,
  reportPromotionFenceRejected,
  signalStreamPromotion,
} from './stream-promotion.js';
// #629 (fatia F da #505) — a POLÍTICA de poison/DLQ. Módulo PURO: a decisão
// ("bloquear ou liberar") é uma função de (código, outcome, conjunto
// configurado), e o conjunto entra como parâmetro. Quem LÊ a configuração é
// esta fachada, porque é aqui que `@/config/env.js` já mora — o repositório,
// que EXECUTA o bloqueio, continua sem alcançá-lo (#596).
import {
  classifyPoison,
  parsePoisonBlockCategories,
  poisonDisposition,
  type PoisonCategory,
} from './poison-policy.js';
import { recordPoisonDecision } from './stream-metrics.js';

/** Referência viva a um turno em execução. `state_version` é o token do CAS. */
export type TurnHandle = {
  turn_id: string;
  status: TurnStatus;
  state_version: number;
  attempt_count: number;
  conversa_id: string | null;
  /**
   * #504 — a POSSE desta tentativa, quando `FEATURE_TURN_CLAIM` está ligada.
   *
   * Vive no handle, e não numa variável de `core.ts`, porque o handle já é o
   * objeto que atravessa todo o turno: pendurar a lease nele é o que permite
   * que CADA transição terminal encontre o token sem que ninguém precise
   * lembrar de passá-lo adiante. `null` no caminho legado, e `null` quando o
   * claim não foi concedido (aí o turno não deve nem começar).
   */
  lease?: TurnLease | null;
};

/**
 * A POSSE de um turno tem TRÊS estados, não dois — e confundir dois deles é o
 * que transforma o fail-closed em fail-open.
 *
 *   `unfenced` — não há lease nenhuma. É o regime de #503
 *     (`FEATURE_TURN_CLAIM` OFF) ou um handle que nunca passou pelo claim. Não
 *     há token a exigir, e as gravações seguem sem `expected_claim_token`
 *     exatamente como antes desta issue. É o que faz a flag ser um kill switch
 *     de verdade.
 *
 *   `fenced` — a lease existe e está VIVA até onde este processo sabe. Toda
 *     gravação leva o `claim_token` no WHERE.
 *
 *   `lost` — a lease EXISTIU e não está mais viva: `markLost()` (heartbeat
 *     morto, fence recusado) ou `release()` (shutdown gracioso). Este é o
 *     estado que a versão anterior colapsava com `unfenced`, porque
 *     `lease.token` devolve `null` depois da perda e o `fenceToken()` anterior
 *     traduzia `null` para `{}`.
 *
 * O colapso não era cosmético. Sem `expected_claim_token`, `transitionTurn`
 * não aplica predicado nenhum de posse: sobra o CAS por `state_version`. Basta
 * o `state_version` não ter andado — o banco voltou depois de um blip de
 * heartbeat, ou alguém concluiu depois de `release()` — para o worker que JÁ
 * SABE que perdeu a posse gravar assim mesmo, e gravar como se fosse dono.
 * Ou seja: o caminho que detecta a perda era o mesmo que a tornava inofensiva.
 *
 * Aqui `lost` é um estado próprio, e quem o recebe NÃO escreve.
 */
type TurnFence =
  | { kind: 'unfenced' }
  | { kind: 'fenced'; expected_claim_token: string }
  | { kind: 'lost'; reason: LeaseLossReason };

function resolveFence(handle: TurnHandle): TurnFence {
  const lease = handle.lease;
  // Sem lease: feature desligada, ou handle que nunca reivindicou. Regime #503.
  if (!lease) return { kind: 'unfenced' };
  const token = lease.token;
  // `token === null` <=> `!lease.alive` (ver `TurnLease.token`). Lemos os dois
  // porque é o par que dá a RAZÃO, e a razão vai para a métrica e a auditoria.
  if (token === null) return { kind: 'lost', reason: lease.lostReason ?? 'expired' };
  return { kind: 'fenced', expected_claim_token: token };
}

/** Argumento de fence para o repositório. Só o estado `fenced` produz token. */
function fenceArgs(fence: TurnFence): { expected_claim_token?: string } {
  return fence.kind === 'fenced' ? { expected_claim_token: fence.expected_claim_token } : {};
}

/**
 * A tentativa local perdeu a posse ANTES de tentar gravar — cancelamento local,
 * sem ida ao banco.
 *
 * É deliberadamente o MESMO desfecho de uma rejeição vinda do banco
 * (`handleStaleClaim`): mesma métrica, mesmo log, mesma auditoria. Um operador
 * que investiga "por que este turno não concluiu" não deveria precisar saber se
 * quem recusou foi o predicado SQL ou o guard em memória — o fato é o mesmo, e
 * o fato é "uma escrita desta tentativa foi recusada pelo fence".
 *
 * A alternativa — deixar passar sem fence — é o defeito. A outra alternativa —
 * gravar COM o token morto e deixar o banco recusar — funcionaria hoje, mas
 * depende de a lease do sucessor já estar registrada; entre a perda e o
 * takeover existe uma janela em que o token antigo ainda é o vigente no banco,
 * e nela a escrita passaria.
 */
async function refuseLostOwnership(
  handle: TurnHandle,
  operation: string,
  reason: LeaseLossReason,
): Promise<void> {
  logger.warn(
    {
      turn_id: handle.turn_id,
      operation,
      attempt: handle.attempt_count,
      from_status: handle.status,
      reason,
    },
    'turn.write_refused_lease_not_alive',
  );
  await reportFenceRejection({
    turn_id: handle.turn_id,
    operation,
    attempt: handle.attempt_count,
    current_status: handle.status,
  });
}

/**
 * Reage a uma transição recusada pelo FENCE.
 *
 * Uma única porta para os cinco pontos de conclusão do turno. A reação é sempre
 * a mesma e é sempre TERMINAR a tentativa local: cancelamos a lease (para que o
 * heartbeat pare de renovar algo que não é mais nosso) e registramos a
 * rejeição. Deliberadamente NÃO tentamos "consertar" reescrevendo sem o fence —
 * a issue proíbe, e com razão: sobrescrever o ownership atual é reintroduzir a
 * execução dupla no exato caminho que a detectou.
 */
async function handleStaleClaim(
  handle: TurnHandle,
  result: TurnTransitionResult,
  operation: string,
): Promise<boolean> {
  if (result.ok || result.conflict !== 'stale_claim') return false;
  // CANCELA a tentativa local, não apenas o timer: o banco acabou de responder
  // que não somos mais donos, então o `AbortSignal` tem de disparar AGORA. Só
  // parar o heartbeat deixaria o pipeline seguir trabalhando — chamando LLM,
  // executando tool — em nome de uma posse que já acabou.
  handle.lease?.markLost('token_mismatch');
  await reportFenceRejection({
    turn_id: handle.turn_id,
    operation,
    attempt: handle.attempt_count,
    current_status: result.current_status,
  });
  return true;
}

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

/** Por que a execução não pôde começar. `started: true` é a única autorização. */
export type TurnExecutionStart =
  | { started: true }
  /** Outro worker tem a posse (ou o turno não está elegível). NÃO é erro. */
  | { started: false; reason: 'not_claimed' }
  /**
   * #625 — a STREAM está ocupada por outro turno ativo. O banco recusou o
   * segundo claim.
   *
   * Separado de `not_claimed` porque o diagnóstico é outro: `not_claimed` diz
   * "este turno não é meu", `stream_busy` diz "esta CONVERSA está ocupada".
   * Colapsar os dois apagaria justamente o sinal que a issue-mãe manda vigiar
   * durante o rollout — uma stream que serializa aparece como `stream_busy` em
   * massa, e como nada em particular se o motivo virasse `not_claimed`.
   */
  | { started: false; reason: 'stream_busy' }
  /**
   * #626 — a conversa tem FILA: existe turno anterior não terminal na mesma
   * stream. Distinto de `stream_busy` (a conversa está OCUPADA por um turno com
   * lease viva) e de `not_claimed` (o TURNO não está elegível) — as três param
   * a execução, e só a leitura difere: `not_head` é normal e some quando o
   * anterior avança.
   */
  | { started: false; reason: 'not_head' }
  /**
   * #626 — o turno anterior está em `outbound_pending` e NENHUM claim o move.
   * Quem destrava é o delivery worker do outbox (#506); esperar não resolve, e
   * é por isso que ele não é `not_head`.
   */
  | { started: false; reason: 'stream_blocked' }
  /**
   * #629 — a CONVERSA está interditada por política de poison, e nenhum
   * mecanismo automático a destrava: nem o varredor, nem a promoção, nem o
   * tempo. Só `npm run dlq -- unblock`, que é operação auditada.
   *
   * É a recusa que mais precisa de nome próprio: `not_head` e `stream_busy`
   * somem sozinhos quando o head anda, e esta não some nunca sem um humano.
   */
  | { started: false; reason: 'stream_poisoned' }
  /** Perdemos a posse entre o claim e o `running`. */
  | { started: false; reason: 'stale_claim' }
  /** O estado andou por baixo de nós — alguém concluiu, absorveu ou matou o turno. */
  | { started: false; reason: 'state_conflict' };

/**
 * Toma a POSSE do turno e marca o início da execução.
 *
 * Dois regimes, escolhidos por `FEATURE_TURN_CLAIM`:
 *
 * **ON (#504).** `claimNextEligibleTurn` é a autoridade: uma declaração SQL atômica
 * decide o dono, incrementa a tentativa canônica, gera o `claim_token` e abre a
 * lease. `started: false` significa **não processe** — e é a primeira vez nesta
 * máquina de estados em que um "não" aqui de fato barra a execução. Note que o
 * claim aceita `retryable` diretamente: o passo `retryable -> queued` do regime
 * legado existia só para satisfazer a tabela de transições, e o claim tem
 * predicado próprio (ver `src/runtime/turns/claim.ts`).
 *
 * **OFF (#503).** Comportamento preservado byte a byte: registra que a execução
 * começou e nunca barra ninguém. Não é exclusão mútua e nunca foi — por isso um
 * conflito aqui continua não abortando o turno, o que seria falsa sensação de
 * segurança.
 */
export async function beginTurnExecution(
  handle: TurnHandle | null,
  args: { conversa_id?: string | null; channel_id?: string | null } = {},
): Promise<TurnExecutionStart> {
  if (!handle || !turnStateMachineEnabled()) return { started: true };
  if (turnClaimEnabled()) return beginClaimedExecution(handle, args);
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
  return { started: true };
}

/**
 * O caminho de #504: claim atômico + lease + `running` já fenced.
 *
 * A ordem é a que importa e não é intercambiável:
 *   1. **claim** — só depois de vencer a corrida no PostgreSQL existe uma
 *      tentativa autorizada. Todo o resto pende disto;
 *   2. **lease** — o heartbeat começa imediatamente, ANTES de `running`, para
 *      que nem essa janela fique sem renovação;
 *   3. **running fenced** — a primeira gravação da tentativa já exige o token.
 *      Se ela for recusada aqui, perdemos a posse em milissegundos (takeover
 *      por lease de uma encarnação anterior, tipicamente) e paramos antes de
 *      qualquer efeito.
 *
 * `guarded` NÃO envolve o claim: a política de falha de #503 (fail-soft em
 * shadow) diria "siga em frente" a um claim que não pôde ser lido, e seguir em
 * frente sem posse é precisamente o defeito. Uma falha de infraestrutura aqui
 * vira `not_claimed`, e o turno continua elegível para o próximo tick.
 */
async function beginClaimedExecution(
  handle: TurnHandle,
  args: { conversa_id?: string | null; channel_id?: string | null },
): Promise<TurnExecutionStart> {
  let acquired: Awaited<ReturnType<typeof acquireTurnLease>>;
  try {
    acquired = await acquireTurnLease(handle.turn_id);
  } catch (err) {
    const { code } = sanitizeTurnError({ error: err });
    incCounter('maia_turn_state_errors_total', { op: 'claim', error_code: code });
    logger.error({ turn_id: handle.turn_id, error_code: code }, 'turn.claim_failed');
    return { started: false, reason: 'not_claimed' };
  }
  if (!acquired.lease) {
    // As recusas por STREAM chegam ao caller com o nome delas. Colapsá-las em
    // `not_claimed` apagaria, no log de `src/agent/core.ts`, a diferença entre
    // "outro worker pegou este turno" e "esta conversa tem fila" — e é a
    // segunda que explica por que uma conversa inteira parou.
    // #629 acrescentou `stream_poisoned`, e ele é o que MAIS precisa chegar
    // ao caller: `not_head` e `stream_busy` somem sozinhos quando o head anda,
    // e `stream_poisoned` não some nunca sem um humano. Colapsá-lo em
    // `not_claimed` faria a única recusa que exige operação parecer a mais
    // rotineira de todas.
    const streamReasons = [
      'stream_busy',
      'not_head',
      'stream_blocked',
      'stream_poisoned',
    ] as const;
    const rejeicao = acquired.result.ok === false ? acquired.result.reason : null;
    const porStream = streamReasons.find((r) => r === rejeicao);
    return { started: false, reason: porStream ?? 'not_claimed' };
  }

  const lease = acquired.lease;
  handle.lease = lease;
  handle.status = lease.claim.status;
  handle.state_version = lease.claim.state_version;
  handle.attempt_count = lease.claim.attempt;

  // A lease acabou de nascer, então o normal aqui é `fenced`. `lost` é possível
  // e não é teórico: o primeiro heartbeat pode bater entre o claim e esta linha
  // e descobrir que uma encarnação anterior nossa já foi substituída. Nesse caso
  // NÃO gravamos — nem com fence, nem sem.
  const fence = resolveFence(handle);
  if (fence.kind === 'lost') {
    await refuseLostOwnership(handle, 'mark_running', fence.reason);
    return { started: false, reason: 'stale_claim' };
  }
  const result = await agentTurnsRepo.markRunning({
    turn_id: handle.turn_id,
    expected_version: handle.state_version,
    // A tentativa canônica JÁ foi contada pelo claim. Contar de novo aqui
    // esgotaria `MAX_TURN_ATTEMPTS` na metade das tentativas reais.
    bump_attempt: false,
    ...fenceArgs(fence),
    ...(args.conversa_id !== undefined ? { conversa_id: args.conversa_id } : {}),
    ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
  });
  if (await handleStaleClaim(handle, result, 'mark_running')) {
    return { started: false, reason: 'stale_claim' };
  }
  if (!applyResult(handle, result)) {
    // Não é perda de posse: o estado andou por baixo de nós (absorvido pelo
    // debounce, cancelado por operador). Devolvemos a posse já, para não
    // segurar por um TTL um turno que não vamos executar.
    await lease.release();
    return { started: false, reason: 'state_conflict' };
  }
  return { started: true };
}

/**
 * Incorpora as mensagens agregadas pelo debounce ao turno em execução.
 *
 * Duas situações por mensagem irmã:
 *   - sem turno (row legada / ingresso sem dual-write): vira input deste turno;
 *   - com turno próprio (o ingresso criou um por mensagem): o turno da irmã é
 *     marcado `superseded`/`merged_into_turn` COM `superseded_by_turn_id`
 *     apontando para o turno executor, e a associação input permanece onde
 *     está — sem violar "uma mensagem pertence a no máximo um turno".
 *
 * A relação de absorção é PERSISTIDA (não só logada): antes o operador via
 * `outcome = merged_into_turn` e não tinha como saber qual turno respondeu no
 * lugar; a pergunta "quem absorveu este?" / "o que este absorveu?" agora tem
 * resposta em SQL (`listAbsorbedTurns`).
 *
 * A associação DEFINITIVA (um turno por rajada, decidido no ingresso) é
 * fechada em #505 — aqui o objetivo é que a rajada produza UM turno executável
 * e nenhum turno órfão executável.
 *
 * ─── O FENCE PERTENCE A QUEM ABSORVE (#504, decisão do dono) ────────────────
 *
 * Absorver é uma gravação com DUAS linhas: a que muda (o irmão) e a que
 * autoriza (este turno). A posse exigida é a DESTE turno — o irmão
 * normalmente nunca foi reivindicado, porque quem foi reivindicado foi o
 * executor da rajada, e exigir claim dele tornaria a absorção legítima
 * impossível no caso comum.
 *
 * Duas camadas, e as duas são necessárias:
 *
 *  1. AQUI, em memória: se esta tentativa já SABE que perdeu a lease
 *     (heartbeat morto, `release()` do shutdown), não escrevemos nada — nem a
 *     supersessão do irmão, nem o `attachInputTx` das irmãs sem turno. Entre a
 *     perda e o takeover existe uma janela em que o token antigo ainda é o
 *     vigente no banco, e nela o predicado SQL sozinho aprovaria a escrita.
 *  2. NO BANCO, via `absorber_claim_token`: um zumbi que ainda NÃO percebeu a
 *     perda passa pelo guard local e é recusado pelo `EXISTS` que exige token
 *     vigente E `lease_expires_at > now()` deste turno.
 *
 * A posse é reavaliada a CADA irmã: a rajada pode ser longa e a lease pode
 * morrer no meio dela.
 */
export async function absorbDebounceInputs(
  handle: TurnHandle | null,
  mensagem_ids: readonly string[],
): Promise<void> {
  if (!handle || !turnStateMachineEnabled() || mensagem_ids.length === 0) return;
  await guarded('absorb_inputs', async () => {
    let seq = 1;
    for (const mensagem_id of mensagem_ids) {
      const fence = resolveFence(handle);
      if (fence.kind === 'lost') {
        await refuseLostOwnership(handle, 'absorb_inputs', fence.reason);
        return;
      }
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
      const result = await agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: handle.turn_id,
        // O CAS do IRMÃO: é ele que decide a corrida entre duas absorções
        // concorrentes. O fence acima diz "posso absorver"; este diz "este
        // irmão ainda está no estado que eu li".
        expected_version: Number(sibling.state_version),
        ...(fence.kind === 'fenced'
          ? { absorber_claim_token: fence.expected_claim_token }
          : {}),
      });
      // `stale_claim` aqui significa que a posse DESTE turno acabou — não que o
      // irmão andou. Parar a rajada inteira é a única reação correta: as
      // próximas absorções seriam recusadas pelo mesmo motivo, e insistir é o
      // comportamento de zumbi que o fence existe para impedir.
      if (await handleStaleClaim(handle, result, 'absorb_inputs')) return;
      if (result.ok) {
        logger.debug(
          { turn_id: sibling.id, to_status: 'superseded', absorbed_by: handle.turn_id },
          'turn.transitioned',
        );
        // #627 — `superseded` também é TERMINAL, então a transação do irmão
        // pode ter promovido alguém. No caminho NORMAL não promove: o
        // absorvedor está `running` e é ele o head, então a eleição não acha
        // sucessor elegível. Só sinaliza quando houve promoção de verdade — e
        // NÃO conta `no_successor` por irmão absorvido, que encheria o
        // denominador da métrica com eventos de debounce e faria a razão
        // `promoted/(promoted+no_successor)` medir rajada em vez de fila.
        if (result.promotion) {
          await signalStreamPromotion(result.promotion, {
            source: 'terminal',
            promoted_by_turn_id: sibling.id,
          });
        }
      }
    }
    // #505 — o turno agregado passa a declarar o INTERVALO de ingressos que
    // consumiu, não só o da mensagem representativa. Roda DEPOIS da absorção
    // para que a fronteira reflita o batch já fechado. Só estende (LEAST/
    // GREATEST) e só com ingressos da MESMA stream — ver
    // `extendTurnStreamBoundaryTx`.
    const extended = await agentTurnsRepo.extendTurnStreamBoundaryTx({
      turn_id: handle.turn_id,
      mensagem_ids,
    });
    if (extended) {
      logger.debug(
        { turn_id: handle.turn_id, absorbed: mensagem_ids.length },
        'stream.turn_boundary_extended',
      );
    }
  });
}

/**
 * #627 — o turno acabou de chegar a TERMINAL. Sinaliza o sucessor que a
 * transação já promoveu, ou registra que não havia quem promover.
 *
 * Roda DEPOIS de `applyResult`, isto é, depois de a transação ter comitado. A
 * ordem é a exigência literal da issue ("persistir a decisão antes de sinalizar
 * a BullMQ") e ela não depende de disciplina: `result.promotion` só existe
 * porque o UPDATE da promoção já casou dentro da transação do CAS terminal —
 * não há como chamar isto antes.
 *
 * NUNCA lança: ver `signalStreamPromotion`. Uma conclusão bem-sucedida não pode
 * virar falha porque o Redis piscou.
 */
async function notePromotion(result: TurnTransitionResult): Promise<void> {
  if (!result.ok) return;
  if (!result.promotion) {
    noteNoSuccessor();
    return;
  }
  await signalStreamPromotion(result.promotion, {
    source: 'terminal',
    promoted_by_turn_id: result.turn.id,
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
    // A lease morreu antes da conclusão (heartbeat perdido, `release()` do
    // shutdown, ou um fence anterior desta mesma tentativa). Concluir agora é
    // gravar sem posse — e é exatamente o cenário do worker lento que a issue
    // fecha.
    //
    // `merged_into_turn` NÃO é exceção, e já foi. Aqui o turno declara a SI
    // MESMO absorvido, então a gravação pertence a esta tentativa como
    // qualquer outra e leva o fence do PRÓPRIO turno
    // (`markSupersededSelf`). A absorção de um IRMÃO — onde o fence é do
    // absorvedor e o irmão não precisa de claim — é outra operação, e mora em
    // `absorbDebounceInputs`. Enquanto as duas eram a mesma chamada sem fence,
    // esta porta era a única transição terminal que um worker sem posse
    // conseguia atravessar, e `superseded` é terminal: o sucessor perdia o
    // turno sem que nada aparecesse como conflito.
    const fence = resolveFence(handle);
    if (fence.kind === 'lost') {
      await refuseLostOwnership(handle, `conclude_${outcome}`, fence.reason);
      // #627 — a conclusão recusada é uma PROMOÇÃO que deixou de acontecer, e
      // esse é o fato que a issue manda auditar ("claim stale tentando promover
      // sucessor é rejeitado, e a rejeição é auditada"). Sem esta linha, um
      // zumbi barrado e uma stream sem sucessor produziriam o mesmo silêncio.
      await reportPromotionFenceRejected({
        turn_id: handle.turn_id,
        operation: `conclude_${outcome}`,
        attempt: handle.attempt_count,
      });
      return;
    }
    const result =
      outcome === 'merged_into_turn'
        ? await agentTurnsRepo.markSupersededSelf({
            turn_id: handle.turn_id,
            expected_version: handle.state_version,
            ...fenceArgs(fence),
          })
        : IGNORED_OUTCOMES.has(outcome)
          ? await agentTurnsRepo.markIgnored({
              turn_id: handle.turn_id,
              outcome,
              expected_version: handle.state_version,
              ...fenceArgs(fence),
            })
          : await agentTurnsRepo.completeTurnTx({
              turn_id: handle.turn_id,
              outcome,
              expected_version: handle.state_version,
              ...fenceArgs(fence),
            });
    // O FENCE na conclusão é o ponto central da issue: um worker lento que
    // perdeu a lease chega aqui com trabalho pronto e é RECUSADO. Sem isto ele
    // marcaria `completed` por cima da tentativa do sucessor, e o usuário
    // receberia duas respostas com o turno registrado como concluído uma vez.
    if (await handleStaleClaim(handle, result, `conclude_${outcome}`)) {
      // #627 — mesma leitura do ramo `lost` acima, com a recusa vindo do banco
      // em vez do guard em memória. O fato operacional é o mesmo: a fila não
      // andou porque quem tentou concluir já não era o dono.
      await reportPromotionFenceRejected({
        turn_id: handle.turn_id,
        operation: `conclude_${outcome}`,
        attempt: handle.attempt_count,
      });
      return;
    }
    if (!applyResult(handle, result)) return;
    // Concluído: a posse morreu com o CAS (`clearClaim`), só resta o timer.
    handle.lease?.stop();
    // #627 — A FILA ANDA. A transação que concluiu este turno já elegeu e
    // promoveu o sucessor; aqui só resta bater na BullMQ. DEPOIS do commit,
    // nunca antes.
    await notePromotion(result);

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
  'pending_race_lost',
]);

/** Teto do backoff, em ms. O crescimento exponencial para aqui. */
export const RETRY_BACKOFF_CEILING_MS = 15 * 60_000;

/**
 * Amplitude do jitter, como fração do atraso base. ±20%.
 *
 * "Jitter LIMITADO" (issue #504 §Retry, recovery e DLQ) e não jitter total: o
 * atraso continua previsível dentro de uma janela que o operador consegue
 * declarar num runbook, o que um `random(0, base)` destrói. 20% é largo o
 * bastante para desmanchar a sincronização e estreito o bastante para que a
 * tentativa 3 continue sendo reconhecivelmente "dois minutos".
 */
export const RETRY_JITTER_RATIO = 0.2;

/**
 * Backoff exponencial com teto E JITTER, em ms — ~30s, ~60s, ~120s, … até 15min.
 *
 * ─── Por que o jitter não é cosmético aqui ──────────────────────────────────
 *
 * `next_attempt_at` é PERSISTIDO, e o recovery varre por `next_attempt_at <=
 * now()`. Sem jitter, N turnos que falharam pelo mesmo motivo no mesmo instante
 * — que é o caso NORMAL, porque a causa costuma ser compartilhada (LLM fora do
 * ar, banco lento, deploy) — recebem o MESMO `next_attempt_at` ao milissegundo
 * e voltam todos juntos, contra a mesma dependência que acabou de cair. O
 * backoff exponencial sozinho não resolve isso: ele afasta as tentativas do
 * MESMO turno, e mantém alinhadas as de turnos DIFERENTES.
 *
 * ─── Onde o teto é aplicado, e por quê ──────────────────────────────────────
 *
 * O teto limita a BASE, e o resultado final é reclampado em `[0, teto]`. Duas
 * consequências deliberadas:
 *   - o teto continua sendo um teto de verdade: nenhum atraso passa de 15min,
 *     que é o número que o runbook promete;
 *   - no teto a janela vira `[12min, 15min]` em vez de `[12min, 18min]`. Ainda
 *     é espalhamento — que é a única coisa que importa ali — e é o lado do
 *     trade-off que não quebra a promessa documentada.
 *
 * `Math.random` é lido diretamente, sem injeção de dependência: um parâmetro
 * `rand` faria todo teste de jitter medir a função que o próprio teste passou.
 * A suíte espia `Math.random` no ponto de produção.
 */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(
    30_000 * Math.pow(2, Math.max(0, attempt - 1)),
    RETRY_BACKOFF_CEILING_MS,
  );
  const jitter = base * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.min(RETRY_BACKOFF_CEILING_MS, Math.max(0, Math.round(base + jitter)));
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
    const fence = resolveFence(handle);
    if (fence.kind === 'lost') {
      // Nem sequer agendar retry: `next_attempt_at`/`last_error_code` são
      // campos DO TURNO, e o turno é de outra tentativa. Quem tem a posse
      // decide o desfecho — inclusive se houve falha.
      await refuseLostOwnership(handle, 'fail_retryable', fence.reason);
      return;
    }
    const next = new Date(Date.now() + retryDelayMs(handle.attempt_count + 1));
    const from = handle.status;
    const result = await agentTurnsRepo.markRetryable({
      turn_id: handle.turn_id,
      next_attempt_at: next,
      error_code: code,
      error_summary: summary,
      expected_version: handle.state_version,
      ...fenceArgs(fence),
    });
    if (await handleStaleClaim(handle, result, 'fail_retryable')) return;
    if (!applyResult(handle, result)) return;
    handle.lease?.stop();
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

/**
 * #629 — o conjunto de categorias que BLOQUEIAM, memoizado por valor bruto.
 *
 * O memo é sobre a STRING da env, não sobre "já li uma vez": `config` é um
 * singleton, mas uma spec que recarrega o módulo com outro valor precisa ver o
 * novo — e um memo booleano faria o segundo caso da suíte medir a configuração
 * do primeiro. Reparsear a cada dead letter também serviria (é uma string
 * curta), mas dead letter acontece em rajada quando uma dependência cai, e
 * lançar dentro de `guarded` por categoria inválida numa rajada seria trocar um
 * erro de configuração por uma tempestade de erros de transição.
 */
let poisonBlockCache: { raw: string; set: Set<PoisonCategory> } | null = null;

function poisonBlockCategories(): Set<PoisonCategory> {
  const raw = config.TURN_POISON_BLOCK_CATEGORIES ?? '';
  if (poisonBlockCache?.raw === raw) return poisonBlockCache.set;
  const set = parsePoisonBlockCategories(raw);
  poisonBlockCache = { raw, set };
  return set;
}

/** Só para teste: força a releitura da política na próxima decisão. */
export function _resetPoisonPolicyCacheForTests(): void {
  poisonBlockCache = null;
}

/** Terminal por esgotamento/intervenção. Sempre auditado. */
export async function deadLetterTurn(
  handle: TurnHandle | null,
  args: {
    code: string;
    summary?: string | null;
    outcome?: 'retry_exhausted' | 'operator_cancelled' | 'unsafe_to_retry';
    error?: unknown;
  },
): Promise<void> {
  if (!handle || !turnStateMachineEnabled()) return;
  const sanitized =
    args.summary !== undefined
      ? { code: args.code, summary: args.summary }
      : sanitizeTurnError({ code: args.code, error: args.error });
  await guarded('dead_letter', async () => {
    const fence = resolveFence(handle);
    if (fence.kind === 'lost') {
      await refuseLostOwnership(handle, 'dead_letter', fence.reason);
      await reportPromotionFenceRejected({
        turn_id: handle.turn_id,
        operation: 'dead_letter',
        attempt: handle.attempt_count,
      });
      return;
    }
    const from = handle.status;
    // #629 (fatia F) — A ESCOLHA, e ela é tomada ANTES da escrita.
    //
    // A issue-mãe exige que a política escolha CONSCIENTEMENTE entre liberar a
    // conversa e interditá-la, e que a escolha seja configurável por categoria
    // de erro. Classificar aqui — e não dentro da transação — é o que mantém a
    // decisão TESTÁVEL sem banco e o repositório sem `@/config/env.js`: o que
    // desce é o veredito, não a política.
    const outcome = args.outcome ?? 'retry_exhausted';
    const category = classifyPoison({ error_code: sanitized.code, outcome });
    const disposition = poisonDisposition(category, poisonBlockCategories());
    const result = await agentTurnsRepo.markDeadLetter({
      turn_id: handle.turn_id,
      outcome,
      error_code: sanitized.code,
      error_summary: sanitized.summary,
      expected_version: handle.state_version,
      ...(disposition === 'block_stream'
        ? { block_stream: { category, reason: 'poison' as const } }
        : {}),
      ...fenceArgs(fence),
    });
    if (await handleStaleClaim(handle, result, 'dead_letter')) {
      await reportPromotionFenceRejected({
        turn_id: handle.turn_id,
        operation: 'dead_letter',
        attempt: handle.attempt_count,
      });
      return;
    }
    if (!applyResult(handle, result)) return;
    handle.lease?.stop();
    // A DECISÃO é contada DEPOIS do CAS ter vencido, e não antes de escrever.
    // Um zumbi cujo `dead_letter` é recusado pelo fence não tomou decisão
    // nenhuma — contá-lo faria `maia_stream_poison_total` medir TENTATIVAS de
    // decidir, e a razão `block_stream/(block_stream+release)` deixaria de ser
    // a política e passaria a ser a política mais a taxa de zumbis.
    recordPoisonDecision(category, disposition);
    // #627 — `dead_letter` é TERMINAL, e a issue-mãe é explícita sobre o que
    // isso significa para a fila: a política de DLQ "libera o próximo turno".
    // Um turno envenenado que ficasse segurando a conversa para sempre é a
    // falha nº 5 da issue-mãe.
    //
    // #629 — e agora esse "libera" é uma DECISÃO, não um efeito colateral da
    // máquina de estados. Quando a política mandou bloquear, a mesma transação
    // já inseriu a interdição e `promoteStreamSuccessor` NÃO elegeu ninguém (a
    // eleição carrega `streamNotPoisoned`), então `notePromotion` conta
    // `no_successor` — que é a verdade: não havia sucessor a promover, porque a
    // conversa está interditada.
    if (result.ok && result.stream_block) await reportStreamBlockedByPoison(result.stream_block);
    await notePromotion(result);
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
 * #629 — a INTERDIÇÃO da conversa, relatada.
 *
 * Os três fatos num lugar só — métrica já contada em `recordPoisonDecision`,
 * log estruturado e `audit_log` —, pela mesma regra de `signalStreamPromotion`
 * e `reportFenceRejection`: três callers fazendo isso à mão é como um deles
 * acaba sem auditoria, e o que falta é sempre o do caminho raro.
 *
 * `ops_alert: true` e nível `error`, e aqui isso é honesto ao contrário de
 * `stream.turn_promotion_enqueue_failed` (que é `warn` porque o varredor
 * conserta sozinho): NADA conserta isto sozinho. Uma conversa interditada
 * continua interditada até um humano rodar `npm run dlq -- unblock`. Um alerta
 * que exige intervenção é exatamente o que deve acordar o plantão.
 */
async function reportStreamBlockedByPoison(block: StreamBlockRecord): Promise<void> {
  logger.error(
    {
      turn_id: block.blocked_turn_id,
      block_id: block.block_id,
      category: block.category,
      reason: block.reason,
      error_code: block.error_code,
      ops_alert: true,
    },
    'stream.poisoned',
  );
  await audit({
    acao: 'stream_poisoned',
    ...(block.conversa_id ? { conversa_id: block.conversa_id } : {}),
    alvo_id: block.blocked_turn_id,
    metadata: {
      block_id: block.block_id,
      category: block.category,
      reason: block.reason,
      disposition: 'block_stream',
      blocked_by_turn_id: block.blocked_turn_id,
      error_code: block.error_code,
    },
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
  /**
   * #629 — MODO DE RECONCILIAÇÃO. Sem ele, o replay é RECUSADO quando a ordem
   * da conversa já foi comprometida (existe turno posterior já terminal). Ver
   * `agentTurnsRepo.replayDeadLetterTx`.
   */
  reconcile?: boolean;
}): Promise<ReplayOutcome> {
  const turn = await agentTurnsRepo.findById(args.turn_id);
  if (!turn) return { replayed: false, reason: 'not_dead_lettered' };
  const result = await agentTurnsRepo.replayDeadLetterTx({
    turn_id: args.turn_id,
    expected_version: Number(turn.state_version),
    ...(args.reconcile === true ? { reconcile: true } : {}),
  });
  if (!result.ok) {
    logger.warn(
      { turn_id: args.turn_id, to_status: 'queued', conflict: result.conflict },
      'turn.transition_conflict',
    );
    // #629 — A RECUSA POR ORDEM COMPROMETIDA É AUDITADA, e as outras não.
    //
    // `state_mismatch` e `not_found` são erro de operador (turno vivo, id
    // errado) e já vivem no log. `order_committed` é diferente em espécie: é a
    // plataforma HONRANDO uma invariante contra uma ordem humana explícita, e
    // esse é exatamente o tipo de evento que a issue-mãe manda auditar. Sem a
    // row, a pergunta "por que este turno nunca voltou?" não tem resposta
    // durável — só um exit code que ninguém guardou.
    if (result.conflict === 'order_committed') {
      logger.warn(
        {
          turn_id: args.turn_id,
          actor: args.actor,
          committed_after: result.committed_after,
          ops_alert: true,
        },
        'stream.manual_replay_refused',
      );
      await audit({
        acao: 'turn_replay_refused',
        ...(turn.conversa_id ? { conversa_id: turn.conversa_id } : {}),
        alvo_id: args.turn_id,
        metadata: {
          reason: 'order_committed',
          committed_after: result.committed_after,
          actor: args.actor,
          operator_reason: args.reason,
        },
      });
      return {
        replayed: false,
        reason: 'order_committed',
        committed_after: result.committed_after,
      };
    }
    return { replayed: false, reason: 'not_dead_lettered' };
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
      // #629 — o MODO fica na row de rotina também. Ler `turn_replayed` sem
      // saber se foi reconciliação obrigaria a cruzar com a row de
      // `turn_replay_reconciled` para saber o que aconteceu, e a auditoria de
      // um replay tem de ser legível numa linha.
      mode: args.reconcile === true ? 'reconcile' : 'ordered',
    },
  });
  if (args.reconcile === true) {
    // A row que separa "replay normal" de "o operador ATRAVESSOU a ordem". É a
    // única evidência de que a plataforma processou algo fora da ordem que já
    // havia entregue, e por isso ela é sua própria ação — não um campo de
    // metadata que uma consulta de rotina filtraria fora sem querer.
    logger.warn(
      { turn_id: args.turn_id, actor: args.actor, ops_alert: true },
      'stream.manual_replay_reconciled',
    );
    await audit({
      acao: 'turn_replay_reconciled',
      ...(result.turn.conversa_id ? { conversa_id: result.turn.conversa_id } : {}),
      alvo_id: args.turn_id,
      metadata: { actor: args.actor, operator_reason: args.reason },
    });
  }
  return { replayed: true };
}

/**
 * #629 — o desfecho TIPADO de um replay manual.
 *
 * `not_dead_lettered` e `order_committed` são recusas com remediações opostas,
 * e é por isso que não são um booleano: a primeira quer dizer "você errou o
 * turno" (releia o id, ele não está morto) e a segunda quer dizer "você acertou
 * o turno e a plataforma não vai fazer isso sem você declarar que sabe" — cuja
 * remediação é `--reconcile`, não uma correção.
 */
export type ReplayOutcome =
  | { replayed: true }
  | { replayed: false; reason: 'not_dead_lettered' }
  | { replayed: false; reason: 'order_committed'; committed_after: number };

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
  pairs: number;
} | null> {
  if (!turnStateMachineEnabled()) return null;
  // `blocking: false` SEMPRE: o probe é observabilidade. Derrubar o sweep de
  // recovery porque a medição de divergência falhou seria trocar um problema
  // de visibilidade por um de disponibilidade.
  return guarded(
    'projection_divergence',
    async () => {
      // CROSS-TENANT por construção. A versão anterior media só os pares que a
      // fonte de recovery já tinha enumerado, então a divergência central da
      // issue — turno `retryable` com `processada_em` preenchido — podia nunca
      // gerar métrica, precisamente porque aquele par não tinha nada na fila.
      const perPair = await agentTurnsRepo.countLegacyProjectionMismatchByPair();
      const totals = { terminal_without_projection: 0, projection_without_terminal: 0 };
      for (const p of perPair) {
        totals.terminal_without_projection += p.terminal_without_projection;
        totals.projection_without_terminal += p.projection_without_terminal;
      }
      if (perPair.length === 0) return { ...totals, pairs: 0 };

      // Métrica SEM label de tenant (cardinalidade): o par vai na auditoria e
      // no log, que é onde o operador precisa dele.
      incCounter(
        'maia_turn_legacy_projection_mismatch_total',
        { kind: 'terminal_without_projection' },
        totals.terminal_without_projection,
      );
      incCounter(
        'maia_turn_legacy_projection_mismatch_total',
        { kind: 'projection_without_terminal' },
        totals.projection_without_terminal,
      );
      for (const p of perPair) {
        logger.warn(
          {
            tenant_id: p.tenant_id,
            agent_id: p.agent_id,
            terminal_without_projection: p.terminal_without_projection,
            projection_without_terminal: p.projection_without_terminal,
          },
          'turn.legacy_projection_mismatch',
        );
        // Auditoria ATRIBUÍDA ao par divergente — sem o contexto, a row cairia
        // no tenant sintético `system` e perderia justamente a informação que
        // o operador precisa para agir.
        await runWithTenantContext({ tenant_id: p.tenant_id, agent_id: p.agent_id }, () =>
          audit({
            acao: 'turn_state_inconsistency_detected',
            metadata: {
              terminal_without_projection: p.terminal_without_projection,
              projection_without_terminal: p.projection_without_terminal,
            },
          }),
        );
      }
      return { ...totals, pairs: perPair.length };
    },
    { blocking: false },
  );
}

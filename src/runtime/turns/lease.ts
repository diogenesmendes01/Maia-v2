/**
 * Issue #504 — o DETENTOR da lease: aquisição, heartbeat, perda e devolução.
 *
 * Divisão de responsabilidade com o resto da issue:
 *   `claim.ts`        — vocabulário puro (tipos, jobId, validação de config);
 *   `turn-repos.ts`   — os statements atômicos (claim, renovação, liberação);
 *   ESTE módulo       — o ciclo de vida em memória de UMA tentativa: o timer de
 *                       heartbeat, o `AbortController` do cancelamento e o
 *                       registro que o shutdown ordenado drena;
 *   `lifecycle.ts`    — a política de estado (retry, dead letter, auditoria).
 *
 * ## O contrato de posse
 *
 * `acquireTurnLease` devolve `null` quando o claim não foi vencido. Isso NÃO é
 * erro: é o resultado normal de duas réplicas competindo pelo mesmo wake-up, e
 * o caller simplesmente não processa. Tratar como exceção encheria o painel de
 * alarme em cima do funcionamento correto do sistema.
 *
 * ## Por que o heartbeat aborta em vez de só logar
 *
 * Um dono que parou de renovar já não é dono — o turno voltou ao pool e outra
 * réplica pode estar executando. Continuar trabalhando ali é, na melhor das
 * hipóteses, desperdício, e na pior um efeito externo duplicado. O
 * `AbortController` é o sinal COOPERATIVO para parar o que ainda não começou; o
 * `claim_token` no WHERE é a garantia DURA de que o que já começou não grava.
 * Um sem o outro seria falsa segurança: o abort não alcança uma chamada HTTP em
 * voo, e o fence não impede que ela saia.
 */
import { config } from '@/config/env.js';
import { agentTurnsRepo } from '@/db/repositories/turn-repos.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { runtimeInstanceId } from '@/runtime/instance-identity.js';
import {
  assertLeaseConfig,
  TurnLeaseLostError,
  type LeaseLostReason,
  type TurnExecutionContext,
} from './claim.js';

/**
 * Quantos heartbeats consecutivos podem falhar por INDISPONIBILIDADE do banco
 * antes de a tentativa ser abortada.
 *
 * Dois, e o número é derivado, não escolhido: com heartbeat a cada TTL/3, duas
 * falhas consecutivas consomem 2/3 do TTL. Abortar aí deixa o terço restante
 * para o encerramento ordenado da tentativa ANTES de a lease vencer de fato —
 * ou seja, a tentativa desiste enquanto ainda é dona, em vez de descobrir que
 * perdeu depois que um sucessor já assumiu. Um terceiro heartbeat esperaria
 * justamente até a janela em que a corrida existe.
 */
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 2;

/** A posse VIVA de um turno por esta tentativa. */
export type TurnLease = {
  /** O fence — propagado pelo ALS de `execution-context.ts`. */
  readonly ctx: TurnExecutionContext;
  /**
   * `state_version` da row DEPOIS do claim. O claim é uma transição: ele
   * incrementa a versão, então o handle que o caller carregava ficou obsoleto
   * no instante em que a posse foi conquistada. Devolver isto aqui evita a
   * releitura que reabriria a janela que o statement único fechou.
   */
  readonly claimed_state_version: number;
  /** Estado do turno logo após o claim (sempre `claimed`). */
  readonly claimed_status: string;
  /** A lease ainda vale, até onde este processo sabe. */
  isValid(): boolean;
  /** Lança `TurnLeaseLostError` se a posse já foi perdida. */
  assertValid(): void;
  /**
   * Encerra o ciclo local: para o heartbeat e (quando `release`) devolve a
   * posse no banco. Idempotente.
   */
  finish(opts?: { release?: boolean; reason?: LeaseLostReason }): Promise<void>;
};

type ActiveLease = TurnLease & { readonly turn_id: string };

/**
 * Leases VIVAS deste processo. É o que o passo de drain (#512) usa para não
 * deixar timer nem posse pendurados — três subscribers já esqueceram isso nesta
 * rodada, e cada deploy limpo reportava shutdown forçado.
 */
const active = new Map<string, ActiveLease>();

/** Config de lease validada UMA vez por processo (fail-loud no primeiro uso). */
let leaseConfig: { ttl_ms: number; heartbeat_ms: number } | null = null;

function resolveLeaseConfig(): { ttl_ms: number; heartbeat_ms: number } {
  if (leaseConfig) return leaseConfig;
  const resolved = {
    ttl_ms: config.TURN_LEASE_TTL_MS,
    heartbeat_ms: config.TURN_LEASE_HEARTBEAT_MS,
  };
  // Redundante com a regra de boot em `src/config/rules.ts` — e a redundância é
  // o ponto: um processo que subiu com `MAIA_CONFIG_STRICT_BOOT=false` (a
  // válvula de rollback) chegaria aqui com a combinação insegura, e o claim é o
  // último lugar onde ela pode ser barrada antes de virar execução concorrente.
  assertLeaseConfig(resolved);
  leaseConfig = resolved;
  return resolved;
}

/** O claim distribuído está ligado? */
export function turnClaimEnabled(): boolean {
  return config.FEATURE_TURN_CLAIM && config.FEATURE_TURN_STATE_MACHINE;
}

/** Identidade desta instância como DONA de turnos. */
export function turnWorkerId(): string {
  return runtimeInstanceId();
}

/**
 * Tenta reivindicar o turno e, vencendo, começa a renovar a lease.
 *
 * `null` = não adquiriu (outro dono, backoff pendente, turno terminal). Roda
 * DENTRO do contexto de tenant do turno — o caller resolve o escopo pela row
 * (`findScopeByIdCrossTenant`), nunca pelo payload.
 */
export async function acquireTurnLease(input: {
  turn_id: string;
  deadline?: Date | null;
}): Promise<TurnLease | null> {
  // Um processo drenando NÃO reivindica trabalho novo. Sem esta porta, o
  // shutdown ordenado abriria uma tentativa que ele mesmo teria de abortar
  // segundos depois — e o turno perderia uma tentativa canônica à toa.
  if (!lifecycle.isAcceptingWork()) {
    incCounter('maia_turn_claim_total', { result: 'refused_draining' });
    return null;
  }
  const { ttl_ms, heartbeat_ms } = resolveLeaseConfig();
  const worker_id = turnWorkerId();
  const started = Date.now();

  const result = await agentTurnsRepo.tryClaimTurn({
    turn_id: input.turn_id,
    worker_id,
    lease_ms: ttl_ms,
  });
  // Latência do claim em ms (o histograma do repo é milissegundo-based; a
  // issue sugere segundos, mas trocar a unidade aqui quebraria os buckets
  // compartilhados de `observeHistogram`).
  observeHistogram('maia_turn_claim_latency_ms', Date.now() - started, {
    result: result.ok ? 'acquired' : result.reason,
  });

  if (!result.ok) {
    logger.debug(
      {
        turn_id: input.turn_id,
        worker_id,
        claim_result: result.reason,
        current_status: result.current_status ?? null,
      },
      'turn.claim_not_acquired',
    );
    return null;
  }

  const controller = new AbortController();
  const claim = result.claim;
  const ctx: TurnExecutionContext = {
    tenant_id: claim.tenant_id,
    agent_id: claim.agent_id,
    turn_id: claim.turn_id,
    attempt: claim.attempt,
    claim_token: claim.claim_token,
    worker_id,
    lease_expires_at: claim.lease_expires_at,
    deadline: input.deadline ?? claim.turn.deadline_at ?? null,
    signal: controller.signal,
  };

  let lost: LeaseLostReason | null = null;
  let failures = 0;
  let finished = false;

  const markLost = (reason: LeaseLostReason): void => {
    if (lost) return;
    lost = reason;
    if (reason !== 'released') {
      incCounter('maia_turn_lease_lost_total', { reason });
      logger.warn(
        { turn_id: ctx.turn_id, worker_id, attempt: ctx.attempt, reason, ops_alert: true },
        'turn.lease_lost',
      );
    }
    if (!controller.signal.aborted) controller.abort();
  };

  const beat = async (): Promise<void> => {
    if (lost || finished) return;
    try {
      const renewal = await agentTurnsRepo.renewTurnLease({
        turn_id: ctx.turn_id,
        claim_token: ctx.claim_token,
        worker_id,
        lease_ms: ttl_ms,
      });
      if (renewal.ok) {
        failures = 0;
        return;
      }
      // Renovação RECUSADA pelo banco: o token não é mais o vigente, ou a lease
      // já venceu. Não há retentativa possível — retomar posse implicitamente é
      // exatamente o que a issue proíbe.
      markLost('taken_over');
    } catch (err) {
      // Falha de INFRAESTRUTURA (banco fora). Distinta da recusa acima: aqui
      // ainda podemos ser donos, então toleramos até o limite derivado do TTL.
      failures += 1;
      logger.warn(
        {
          turn_id: ctx.turn_id,
          worker_id,
          consecutive_failures: failures,
          err: (err as Error).message,
        },
        'turn.lease_heartbeat_failed',
      );
      if (failures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) markLost('heartbeat_failed');
    }
  };

  const timer = setInterval(() => {
    void beat();
  }, heartbeat_ms);
  // `unref` para que um heartbeat pendurado NUNCA segure o event loop depois de
  // um drain limpo — a causa exata do "shutdown forçado" que #512 caçou.
  timer.unref?.();

  const lease: ActiveLease = {
    turn_id: ctx.turn_id,
    ctx,
    claimed_state_version: Number(claim.turn.state_version),
    claimed_status: claim.turn.status,
    isValid: () => !lost && !controller.signal.aborted,
    assertValid: () => {
      if (lost) throw new TurnLeaseLostError({ turn_id: ctx.turn_id, reason: lost });
      if (controller.signal.aborted) {
        throw new TurnLeaseLostError({ turn_id: ctx.turn_id, reason: 'taken_over' });
      }
    },
    finish: async (opts = {}) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      active.delete(ctx.turn_id);
      if (opts.reason) markLost(opts.reason);
      if (opts.release !== true) return;
      // Devolver a posse é BEST-EFFORT: se falhar, a lease expira sozinha e o
      // recovery reencontra o turno. Derrubar o encerramento por causa disso
      // trocaria uma recuperação em segundos por uma exceção no drain.
      try {
        await agentTurnsRepo.releaseTurnLease({
          turn_id: ctx.turn_id,
          claim_token: ctx.claim_token,
        });
      } catch (err) {
        logger.warn(
          { turn_id: ctx.turn_id, worker_id, err: (err as Error).message },
          'turn.lease_release_failed',
        );
      }
    },
  };
  active.set(ctx.turn_id, lease);

  logger.info(
    {
      turn_id: ctx.turn_id,
      tenant_id: ctx.tenant_id,
      agent_id: ctx.agent_id,
      worker_id,
      attempt: ctx.attempt,
      lease_expires_at: ctx.lease_expires_at.toISOString(),
    },
    'turn.claimed',
  );
  // Auditoria da AQUISIÇÃO. A issue exige que aquisição, renovação, perda,
  // rejeição por fencing e recuperação sejam explicáveis; renovação fica de
  // FORA da trilha de propósito — é o evento mais frequente do sistema (uma
  // linha a cada 15s por turno em voo) e inundá-la esconderia os outros quatro,
  // que são os que importam numa investigação. O sinal de renovação vive na
  // métrica `maia_turn_lease_heartbeat_total`.
  await audit({
    acao: 'turn_claimed',
    ...(claim.turn.conversa_id ? { conversa_id: claim.turn.conversa_id } : {}),
    alvo_id: ctx.turn_id,
    metadata: {
      worker_id,
      attempt: ctx.attempt,
      from_status: claim.turn.status,
      lease_ttl_ms: ttl_ms,
    },
  }).catch((err) =>
    logger.warn({ turn_id: ctx.turn_id, err: (err as Error).message }, 'turn.claim_audit_failed'),
  );

  return lease;
}

/** Quantas leases este processo detém agora (readiness/diagnóstico). */
export function activeTurnLeaseCount(): number {
  return active.size;
}

/**
 * Drena as leases vivas — passo do shutdown ordenado (#512).
 *
 * Roda DEPOIS do `worker.close()` do BullMQ, que já aguardou o job ativo
 * terminar: no caminho normal não sobra nada e isto é um no-op. O que ele
 * cobre é o caminho anormal — uma tentativa que estourou o deadline do drain e
 * ficou com timer e posse pendurados. Devolver a posse aqui faz a próxima
 * réplica reencontrar o turno em segundos em vez de esperar um TTL inteiro.
 */
export async function drainTurnLeases(): Promise<{ released: number }> {
  const leases = [...active.values()];
  for (const lease of leases) {
    await lease.finish({ release: true, reason: 'released' });
  }
  if (leases.length > 0) {
    logger.info({ released: leases.length }, 'turn.leases_drained');
  }
  return { released: leases.length };
}

/** Só para teste: zera o cache de config e o registro de leases. */
export function __resetTurnLeaseStateForTests(): void {
  leaseConfig = null;
  active.clear();
}

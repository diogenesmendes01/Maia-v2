/**
 * Issue #504 — contrato PURO de claim, lease, fencing e identidade de job.
 *
 * Mesmo princípio de `contract.ts` (#503): zero I/O, zero import de `db`, `env`
 * ou BullMQ. É o vocabulário que gateway, worker, recovery e repositório
 * compartilham — e, por ser puro, é testável sem Postgres nem Redis, que é o
 * único jeito de provar a derivação determinística do `jobId` e a validação da
 * relação TTL/heartbeat sem subir infraestrutura.
 *
 * O que ESTE módulo decide:
 *   * a forma do payload da fila (V2) e como ler o legado (V1);
 *   * o `jobId` determinístico a partir do `turn_id`;
 *   * as origens elegíveis para o claim atômico;
 *   * a relação segura entre TTL da lease e cadência do heartbeat;
 *   * o tipo do contexto de execução que carrega o fence.
 *
 * O que ele NÃO decide: quem ganha o claim (é do PostgreSQL, em
 * `agentTurnsRepo.tryClaimTurn`) nem quando renovar (é do runtime, em
 * `src/runtime/turns/lease.ts`).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TurnStatus } from './contract.js';

// ─── Payload da fila ─────────────────────────────────────────────────────────

/**
 * Versão corrente do payload. V2 carrega SÓ a identidade durável do turno: o
 * worker recarrega tenant, agent, conversa, canal e mensagens do PostgreSQL
 * DEPOIS de vencer o claim.
 *
 * Por que não confiar no payload: um job pode ficar em Redis por horas, ser
 * redelivered, ou ter sido armado por um processo de outra versão. Qualquer
 * campo replicado ali é uma cópia que pode divergir da row — e um `tenant_id`
 * divergente é exatamente a classe de bug que a invariante 1 do AGENTS.md
 * existe para impedir. Identidade durável + releitura elimina a cópia.
 */
export const AGENT_TURN_JOB_VERSION = 2 as const;

/**
 * Campos de correlação (#514). São OPCIONAIS e nunca correctness-critical: o
 * consumidor sabe re-derivar `trace_id` a partir da identidade do job.
 */
const correlationFields = {
  trace_id: z.string().optional(),
  enqueued_at_ms: z.number().optional(),
  received_at_ms: z.number().optional(),
};

/** Payload V2 — identidade durável do turno e nada mais. */
export const agentTurnJobV2Schema = z
  .object({
    version: z.literal(2),
    turn_id: z.string().uuid(),
    ...correlationFields,
  })
  .strip();

export type AgentTurnJobV2 = z.infer<typeof agentTurnJobV2Schema>;

/**
 * Payload LEGADO (V1) — a identidade era a mensagem inbound. Continua legível
 * durante a janela de rollout: um job armado por um processo antigo tem de
 * processar normalmente enquanto as duas versões coexistem. A remoção deste
 * ramo tem critério mensurável — ver `LEGACY_JOB_REMOVAL_CRITERION`.
 */
export const agentJobV1Schema = z
  .object({
    mensagem_id: z.string().uuid(),
    ...correlationFields,
  })
  .strip();

export type AgentJobV1 = z.infer<typeof agentJobV1Schema>;

/** Resultado da leitura do payload — discriminado, nunca `any`. */
export type ParsedAgentJob =
  | { version: 2; turn_id: string; legacy: false }
  | { version: 1; mensagem_id: string; legacy: true };

/**
 * Critério de REMOÇÃO do caminho legado, escrito aqui para que não vire
 * folclore: zero incrementos de `maia_turn_job_payload_total{version="v1"}`
 * durante 7 dias corridos em produção, com o produtor V2 ativo para 100% dos
 * tenants. Enquanto o contador subir, existe produtor antigo no ar.
 */
export const LEGACY_JOB_REMOVAL_CRITERION =
  'zero maia_turn_job_payload_total{version="v1"} por 7 dias com produtor V2 em 100%';

/**
 * Lê um payload da fila, aceitando as duas versões. FAIL-CLOSED: um payload que
 * não casa com nenhum dos dois schemas devolve `null` e o caller recusa o job —
 * processar "o que der" com um payload desconhecido é como um turno vira
 * execução sem identidade.
 */
export function parseAgentJob(data: unknown): ParsedAgentJob | null {
  const v2 = agentTurnJobV2Schema.safeParse(data);
  if (v2.success) return { version: 2, turn_id: v2.data.turn_id, legacy: false };
  const v1 = agentJobV1Schema.safeParse(data);
  if (v1.success) return { version: 1, mensagem_id: v1.data.mensagem_id, legacy: true };
  return null;
}

/** A identidade que o payload carrega, qualquer que seja a versão. */
export function agentJobIdentity(parsed: ParsedAgentJob): string {
  return parsed.version === 2 ? parsed.turn_id : parsed.mensagem_id;
}

// ─── jobId determinístico ────────────────────────────────────────────────────

/** Prefixo do jobId de turno. Legível no `redis-cli` e no painel do BullMQ. */
export const TURN_JOB_ID_PREFIX = 'turn-';

/**
 * `jobId` ESTÁVEL por turno: mesmo `turn_id` ⇒ mesmo id, sempre.
 *
 * É o que faz o rearmamento ser idempotente: dois recoveries concorrentes, um
 * retry do ingresso e um replay manual convergem para UM job. BullMQ recusa o
 * `add` quando já existe job com o mesmo id — a exclusão passa a ser
 * estrutural, não uma corrida vencida por sorte.
 *
 * Por que digest e não o UUID cru: BullMQ reserva ':' em custom ids (é o
 * separador das keys no Redis) e um id derivado por digest não depende do
 * formato do identificador de turno — a mesma lição já aprendida em
 * `unroutedReplayJobId` (review PR #496). 40 hex chars = 160 bits, colisão
 * fora de qualquer escala operacional.
 */
export function turnJobId(turn_id: string): string {
  const digest = createHash('sha256').update(turn_id).digest('hex');
  return `${TURN_JOB_ID_PREFIX}${digest.slice(0, 40)}`;
}

// ─── Claim ───────────────────────────────────────────────────────────────────

/**
 * Origens elegíveis para o CLAIM atômico.
 *
 * DIVERGÊNCIA DELIBERADA da tabela de `contract.ts`, documentada porque é a
 * pergunta que um revisor faz primeiro: `retryable -> claimed` e as auto-arestas
 * `claimed -> claimed` / `running -> claimed` NÃO constam de `TURN_TRANSITIONS`
 * e continuam proibidas para `transitionTurn`.
 *
 * O motivo é que o claim não é um par (from, to): ele só é legal SOB PREDICADO
 * ADICIONAL, que `checkTurnTransition` — que enxerga apenas o par — não tem
 * como expressar:
 *
 *   received | queued  → sem condição extra;
 *   retryable          → somente com `next_attempt_at <= now()` (o backoff
 *                        venceu). Deixar o recovery fazer `retryable -> queued`
 *                        antes criaria uma janela entre as duas escritas em que
 *                        o turno é `queued` sem dono e sem lease;
 *   claimed | running  → somente com `lease_expires_at <= now()`. É o TAKEOVER:
 *                        o dono anterior morreu, e o novo `claim_token` é
 *                        exatamente o que impede o zumbi de gravar depois.
 *
 * Por isso o claim é um statement PRÓPRIO no repositório
 * (`agentTurnsRepo.tryClaimTurn`), com o predicado inteiro num único
 * `UPDATE ... RETURNING`, e não uma chamada de `transitionTurn`.
 *
 * `outbound_pending` está FORA de propósito: a resposta já foi comprometida e
 * reexecutar o ReAct duplicaria efeito (invariante dura de #506). Terminais
 * também — um turno terminal não volta a ser trabalho.
 */
export const CLAIM_ELIGIBLE_STATUSES: readonly TurnStatus[] = [
  'received',
  'queued',
  'retryable',
  'claimed',
  'running',
] as const;

/** Origens em que o claim é um TAKEOVER (exige lease vencida). */
export const CLAIM_TAKEOVER_STATUSES: readonly TurnStatus[] = ['claimed', 'running'] as const;

/**
 * Por que o claim NÃO foi adquirido. Nenhum destes é erro: "não adquiri" é o
 * resultado NORMAL de duas réplicas competindo, e tratá-lo como exceção
 * produziria alarme em cima do funcionamento correto.
 */
export const CLAIM_REJECTIONS = [
  /** A row não existe NESTE (tenant, agent). */
  'not_found',
  /** Terminal ou `outbound_pending`: não há trabalho a reivindicar. */
  'not_claimable',
  /** Outro worker tem lease VIVA. */
  'lease_active',
  /** `retryable` cujo backoff ainda não venceu. */
  'backoff_pending',
] as const;

export type ClaimRejection = (typeof CLAIM_REJECTIONS)[number];

/** Por que uma lease foi perdida (label de métrica, cardinalidade fechada). */
export const LEASE_LOST_REASONS = [
  /** O token não é mais o vigente — alguém assumiu o turno. */
  'taken_over',
  /** A lease expirou antes de a renovação chegar. */
  'expired',
  /** Heartbeats consecutivos falharam (banco indisponível). */
  'heartbeat_failed',
  /** O turno saiu dos estados que sustentam posse (concluído por outro caminho). */
  'not_owned',
  /** Shutdown ordenado: a posse foi devolvida de propósito. */
  'released',
] as const;

export type LeaseLostReason = (typeof LEASE_LOST_REASONS)[number];

// ─── Contexto de execução (o fence) ──────────────────────────────────────────

/**
 * O contexto que acompanha UMA tentativa. É o objeto que responde "esta escrita
 * ainda me pertence?" em qualquer ponto do pipeline.
 *
 * `signal` é o mecanismo de CANCELAMENTO: quando a lease é perdida, o
 * `AbortController` do detentor dispara e todo caminho que o observa para. Ele
 * não substitui o fencing no banco — aborta o que ainda não começou, enquanto o
 * `claim_token` recusa o que tentar gravar mesmo assim.
 */
export type TurnExecutionContext = {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly turn_id: string;
  /** Tentativa CANÔNICA, vinda do PostgreSQL — nunca `job.attemptsMade`. */
  readonly attempt: number;
  readonly claim_token: string;
  readonly worker_id: string;
  /** Quando a lease vigente expira. Renovada pelo heartbeat. */
  readonly lease_expires_at: Date;
  /** Teto absoluto da tentativa quando #507 o definir; `null` até lá. */
  readonly deadline: Date | null;
  readonly signal: AbortSignal;
};

/**
 * Erro de FENCING: a escrita foi recusada porque o `claim_token` da tentativa
 * não é mais o vigente. É a materialização de `stale_claim`.
 *
 * FAIL-LOUD de propósito. Engolir isto seria o pior dos mundos: a tentativa
 * seguiria acreditando ter concluído o turno enquanto o sucessor o executa —
 * exatamente a execução dupla que esta issue existe para impedir. Nunca
 * "corrigir" sobrescrevendo a posse atual.
 */
export class TurnFenceRejectedError extends Error {
  readonly code = 'TURN_FENCE_REJECTED';
  readonly turn_id: string;
  readonly operation: string;
  readonly claim_token: string;

  constructor(args: { turn_id: string; operation: string; claim_token: string }) {
    super(
      `escrita recusada por fencing (turn_id=${args.turn_id}, operation=${args.operation}): ` +
        `o claim_token desta tentativa não é mais o vigente — outro worker assumiu o turno`,
    );
    this.name = 'TurnFenceRejectedError';
    this.turn_id = args.turn_id;
    this.operation = args.operation;
    this.claim_token = args.claim_token;
  }
}

/** A lease foi perdida; a tentativa local deve parar. */
export class TurnLeaseLostError extends Error {
  readonly code = 'TURN_LEASE_LOST';
  readonly turn_id: string;
  readonly reason: LeaseLostReason;

  constructor(args: { turn_id: string; reason: LeaseLostReason }) {
    super(
      `lease do turno perdida (turn_id=${args.turn_id}, reason=${args.reason}); ` +
        `a tentativa local é cancelada e NÃO pode ser retomada implicitamente`,
    );
    this.name = 'TurnLeaseLostError';
    this.turn_id = args.turn_id;
    this.reason = args.reason;
  }
}

// ─── Configuração de lease/heartbeat ─────────────────────────────────────────

/**
 * Razão máxima entre cadência de heartbeat e TTL da lease.
 *
 * Um terço, como a issue exige, e o número não é arbitrário: com heartbeat a
 * cada TTL/3, DOIS heartbeats consecutivos podem falhar (GC longo, blip de
 * rede, failover de réplica) antes de a lease vencer. Com TTL/2 um único tick
 * perdido já deixa a janela de takeover aberta enquanto o dono segue vivo e
 * trabalhando — que é a receita para execução concorrente com fencing correto,
 * ou seja, trabalho jogado fora.
 */
export const LEASE_HEARTBEAT_MAX_RATIO = 1 / 3;

/** Piso do TTL. Abaixo disto, um turno normal perde a lease no meio. */
export const LEASE_TTL_MIN_MS = 5_000;

export type LeaseConfigCheck =
  | { ok: true }
  | { ok: false; reason: 'ttl_too_small' | 'heartbeat_not_positive' | 'heartbeat_too_slow'; detail: string };

/**
 * Valida a relação TTL × heartbeat. Separada da leitura de env de propósito:
 * a regra é do CONTRATO, e testá-la não pode exigir montar `process.env`.
 */
export function checkLeaseConfig(input: {
  ttl_ms: number;
  heartbeat_ms: number;
}): LeaseConfigCheck {
  if (!Number.isFinite(input.ttl_ms) || input.ttl_ms < LEASE_TTL_MIN_MS) {
    return {
      ok: false,
      reason: 'ttl_too_small',
      detail: `TURN_LEASE_TTL_MS=${input.ttl_ms} é menor que o piso ${LEASE_TTL_MIN_MS}ms`,
    };
  }
  if (!Number.isFinite(input.heartbeat_ms) || input.heartbeat_ms <= 0) {
    return {
      ok: false,
      reason: 'heartbeat_not_positive',
      detail: `TURN_LEASE_HEARTBEAT_MS=${input.heartbeat_ms} precisa ser > 0`,
    };
  }
  if (input.heartbeat_ms > input.ttl_ms * LEASE_HEARTBEAT_MAX_RATIO) {
    return {
      ok: false,
      reason: 'heartbeat_too_slow',
      detail:
        `TURN_LEASE_HEARTBEAT_MS=${input.heartbeat_ms} excede um terço de ` +
        `TURN_LEASE_TTL_MS=${input.ttl_ms} (máx ${Math.floor(input.ttl_ms * LEASE_HEARTBEAT_MAX_RATIO)}ms): ` +
        `um único tick perdido abriria janela de takeover com o dono vivo`,
    };
  }
  return { ok: true };
}

/** Variante fail-loud — usada no boot, onde configuração insegura deve derrubar. */
export function assertLeaseConfig(input: { ttl_ms: number; heartbeat_ms: number }): void {
  const check = checkLeaseConfig(input);
  if (!check.ok) {
    throw new Error(`configuração de lease insegura (${check.reason}): ${check.detail}`);
  }
}

// ─── Backoff persistido ──────────────────────────────────────────────────────

/**
 * Jitter LIMITADO aplicado ao backoff persistido em `next_attempt_at`.
 *
 * Sem jitter, N turnos que falharam pelo mesmo motivo (um provedor fora do ar)
 * voltam todos no mesmo instante e derrubam de novo o que acabou de voltar —
 * o rebanho trovejante clássico. O teto de 20% mantém a ordem de grandeza do
 * backoff previsível para quem investiga: um retry de 30s não vira 90s.
 */
export const RETRY_JITTER_RATIO = 0.2;

/**
 * Aplica o jitter. `random` é injetável para tornar o teste determinístico —
 * a propriedade que interessa provar é o INTERVALO, não o sorteio.
 */
export function jitteredDelayMs(base_ms: number, random: () => number = Math.random): number {
  const spread = base_ms * RETRY_JITTER_RATIO;
  // random() ∈ [0,1) ⇒ delta ∈ [-spread, +spread)
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(base_ms + delta));
}

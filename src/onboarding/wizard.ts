/**
 * Issue #519 — o ORQUESTRADOR da saga. É a única porta de entrada de comandos
 * do wizard; toda superfície (tRPC, CLI, doctor) chama daqui.
 *
 * Responsabilidades, nesta ordem — e a ordem importa:
 *   1. escopo fail-closed (`scope.ts`) — antes de tocar em qualquer coisa;
 *   2. RBAC por comando (§"Permissões são verificadas em cada comando");
 *   3. contrato de payload (Zod) — backend decide, UI propõe;
 *   4. idempotência (hash da chave + hash canônico do payload);
 *   5. delegação a `onboardingRunsRepo.commitStep`, que faz a transição sob a
 *      trava da run;
 *   6. métricas e auditoria agente-escopada PÓS-COMMIT.
 *
 * O que este módulo deliberadamente NÃO faz: decidir a transição. Isso é da
 * máquina de estados, e é avaliado DENTRO da transação contra o estado travado
 * — validar aqui, fora do lock, seria TOCTOU.
 *
 * ─── Nenhum efeito antes da decisão (review do PR #541) ──────────────────────
 * TODO efeito de um passo — inclusive o pareamento de #518 — acontece DENTRO do
 * `apply` de `commitStep`, isto é, depois da trava da run, da checagem de
 * expiração, do ledger de idempotência, da versão esperada e da transição.
 * Enfileirar o pareamento ANTES disso (como se fazia) produzia efeito de
 * runtime para um pedido velho, terminal ou inválido, e para a MESMA ação sob
 * uma chave diferente — o `command_id` derivado só protege o retry da MESMA
 * chave. Era uma violação direta de "backend decide, LLM/caller propõe": o
 * efeito precedia a decisão.
 *
 * ─── Métricas passam pelo sanitizador ────────────────────────────────────────
 * As séries deste módulo saem por `@/observability/metrics` (allowlist de
 * chave, guarda de PII, budget de cardinalidade, atribuição tenant/agent), e
 * os valores dos labels vêm de VOCABULÁRIOS FECHADOS declarados em
 * `@/observability/taxonomy`. `reason_code`, código de erro e código de check
 * são entrada do chamador; texto livre vai para auditoria e log, nunca para um
 * label.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { counter, histogram } from '@/observability/metrics.js';
import {
  METRIC,
  ONBOARDING_REASONS,
  ONBOARDING_STEP_VALUES,
  READINESS_CHECK_CODE_VALUES,
  closedVocabulary,
} from '@/observability/taxonomy.js';
import { logger } from '@/lib/logger.js';
import {
  onboardingRunsRepo,
  type CommitStepInput,
  type CommitStepOutcome,
  type StepApplication,
} from '@/db/repositories/onboarding-repos.js';
import type { OnboardingRunRow } from '@/db/schema.js';
import { OnboardingError, toOnboardingErrorCode } from './errors.js';
import { hashIdempotencyKey, hashPayload } from './idempotency.js';
import {
  applyActivate,
  applyCapabilityPacks,
  applyConfigureProfile,
  applyConfigureRole,
  applyConfirmChannelReady,
  applyDeclareChannel,
  applyProvisionAdmin,
  applyProvisionAgent,
  applyProvisionTenant,
  parseStepPayload,
} from './provisioning.js';
import {
  blockingFailures,
  evaluateAgentReadiness,
  READINESS_CHECK_CODES,
  type AgentReadiness,
} from './readiness.js';
import { loadReadinessFactsWith, lockReadinessSnapshot } from './readiness-facts.js';
import {
  parseCancelReason,
  projectRunMetadata,
  type OnboardingCancelReason,
  type OnboardingRunMetadata,
} from './sanitize.js';
import { assertTenantScope } from './scope.js';
import {
  allowedStepsFrom,
  getStepDefinition,
  type OnboardingState,
  type OnboardingStep,
} from './state-machine.js';

/** TTL default de uma run abandonada: 7 dias. */
export const DEFAULT_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Métricas: vocabulário fechado + atribuição explícita ─────────────────────
//
// A saga roda FORA de qualquer ALS de tenant (o alvo do provisionamento pode
// nem existir ainda), então a atribuição automática de `@/observability/metrics`
// cairia no bucket `system` para tudo. Passamos o par da RUN explicitamente —
// o emissor deixa o valor do chamador vencer o do ALS — e caímos em `system`
// só enquanto a run realmente não tem escopo resolvido, que é o bucket
// sancionado para trabalho sem dono (mesmo desenho de `governance/audit.ts`).

type MetricScope = { tenant_id: string | null; agent_id: string | null };

function attribution(scope: MetricScope): { tenant_id: string; agent_id: string } {
  return { tenant_id: scope.tenant_id ?? 'system', agent_id: scope.agent_id ?? 'system' };
}

/**
 * Passo → label `step`, colapsado no vocabulário fechado.
 *
 * Os dois PSEUDO-passos que também têm ledger — `create_run` e `cancel_run` —
 * não estão em `ONBOARDING_STEP_VALUES` (que espelha `ONBOARDING_STEPS`, os
 * passos da máquina de estados) e portanto colapsam em `other` na série de
 * replay. É deliberado: alargar o vocabulário exigiria mexer em
 * `src/observability/taxonomy.ts`, e o teste que pina `step ≡ ONBOARDING_STEPS`
 * existe justamente para impedir que os dois conjuntos divirjam. Quem precisa
 * distinguir "replay de criação" de "replay de cancelamento" tem o evento
 * `step_replayed` e a auditoria, com o passo por extenso.
 */
function stepLabel(step: string): string {
  return closedVocabulary(step, ONBOARDING_STEP_VALUES);
}

/**
 * Código de erro/motivo → label `reason`, colapsado no vocabulário fechado.
 *
 * É AQUI que o `reason_code` arbitrário do cancelamento para de virar série.
 * O motivo original continua inteiro em `onboarding_runs.last_error_code`, no
 * evento append-only e em `admin_audit_log` — texto livre pertence à trilha,
 * não a um label.
 */
function reasonLabel(code: string | null | undefined): string {
  return closedVocabulary(code, ONBOARDING_REASONS);
}

/** Versão do contrato desta saga. Gravada em cada run para o rollout/rollback. */
export const ONBOARDING_CONTRACT_VERSION = '1';

export type OnboardingActor = {
  actor_id: string;
  /** `founder` é global; os demais papéis são restritos ao próprio tenant. */
  actor_role: 'founder' | 'owner' | 'compliance_officer' | 'analyst' | 'viewer';
  /** Tenant da SESSÃO administrativa. `null` só para o founder global. */
  tenant_id: string | null;
};

/** Projeção segura da run — é isto que a UI recebe, nunca a row crua. */
export type OnboardingRunView = {
  id: string;
  kind: string;
  tenant_id: string | null;
  agent_id: string | null;
  state: OnboardingState;
  current_step: string | null;
  version: number;
  allowed_steps: OnboardingStep[];
  last_error_code: string | null;
  /** O passo que falhou, quando a run está em `failed_retryable`. */
  failed_step: string | null;
  /** O estado de onde aquele passo partiu — diagnóstico para o operador. */
  resume_state: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
};

export function toRunView(run: OnboardingRunRow): OnboardingRunView {
  return {
    id: run.id,
    kind: run.kind,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    state: run.state as OnboardingState,
    current_step: run.current_step,
    version: run.version,
    // O ponto de retomada entra no cálculo: a partir de `failed_retryable` a UI
    // só pode oferecer o retry do passo que falhou e as remediações declaradas
    // (review do PR #541, achado 4). Passar só o estado, como antes, oferecia
    // onze botões dos quais o backend recusaria dez.
    allowed_steps: allowedStepsFrom(run.state as OnboardingState, {
      failed_step: run.failed_step,
      resume_state: run.resume_state,
    }),
    last_error_code: run.last_error_code,
    failed_step: run.failed_step,
    resume_state: run.resume_state,
    created_at: run.created_at.toISOString(),
    updated_at: run.updated_at.toISOString(),
    expires_at: run.expires_at.toISOString(),
    completed_at: run.completed_at?.toISOString() ?? null,
    cancelled_at: run.cancelled_at?.toISOString() ?? null,
  };
}

export type StepOutcome =
  | {
      status: 'completed';
      run: OnboardingRunView;
      result: Record<string, unknown>;
      /** `true` quando o resultado veio do ledger (retry após commit). */
      replayed: boolean;
      readiness?: AgentReadiness;
    }
  | { status: 'denied'; run: OnboardingRunView; code: string; message: string; readiness?: AgentReadiness }
  | { status: 'conflict'; code: string; message: string; run: OnboardingRunView }
  | { status: 'not_found' };

/** Papéis autorizados a mutar uma saga. Leitura é mais ampla. */
const MUTATING_ROLES = new Set(['founder', 'owner', 'compliance_officer']);

/**
 * RBAC por comando. Duas regras:
 *   - o papel precisa ser de mutação;
 *   - a sessão precisa ser do MESMO tenant da run. `founder` é a única exceção
 *     (é o papel global), e mesmo ele não pode escapar do escopo da run — o
 *     `tenant_id` que vai para o `WHERE` do `commitStep` continua sendo o da
 *     run, não o do ator.
 */
function assertMayMutate(actor: OnboardingActor, runTenantId: string | null): void {
  if (!MUTATING_ROLES.has(actor.actor_role)) {
    throw new OnboardingError('forbidden', `papel '${actor.actor_role}' não pode mutar onboarding`);
  }
  if (actor.actor_role === 'founder') return;
  if (actor.tenant_id === null) {
    throw new OnboardingError('forbidden', 'sessão administrativa sem tenant');
  }
  assertTenantScope(actor.tenant_id);
  if (runTenantId !== null && runTenantId !== actor.tenant_id) {
    // Mensagem genérica de propósito: não confirmamos a existência da run
    // alheia (descoberta horizontal por id conhecido).
    throw new OnboardingError('forbidden', 'run fora do escopo da sessão');
  }
}

/**
 * O filtro de tenant das leituras/escritas.
 *
 * `null` significa SEM FILTRO e é privilégio EXCLUSIVO do papel global
 * `founder`. Qualquer outro papel precisa de uma sessão com tenant — uma
 * sessão sem tenant NÃO vira "vê tudo", vira recusa. Esta função é a única
 * fonte desse `null`; centralizá-la é o que impede que um caller novo
 * reintroduza o buraco por descuido.
 */
function tenantFilterFor(actor: OnboardingActor): string | null {
  if (actor.actor_role === 'founder') return null;
  if (actor.tenant_id === null) {
    throw new OnboardingError('forbidden', 'sessão administrativa sem tenant');
  }
  assertTenantScope(actor.tenant_id);
  return actor.tenant_id;
}

/** O tenant que entra no `WHERE` das escritas — o da RUN, nunca o do ator. */
function scopeFilterFor(actor: OnboardingActor, run: OnboardingRunRow): string | null {
  return run.tenant_id ?? tenantFilterFor(actor);
}

// ── Porta de pareamento (#518) ───────────────────────────────────────────────

/**
 * O handle de transação do passo, como `commitStep` o entrega ao `apply`.
 * Tipado estruturalmente para não arrastar o pool do Postgres para dentro de
 * quem só quer o TIPO (doctor, testes).
 */
export type StepTx = Parameters<CommitStepInput['apply']>[0];

/**
 * A porta recebe o `tx` DO PASSO.
 *
 * A fila de comandos Admin→runtime de #518 (`channel_line_state`,
 * `migrations/103`) é o outbox durável deste efeito — é uma tabela do MESMO
 * banco, não uma chamada de rede. Logo o lugar certo do enfileiramento é
 * dentro da transação do passo: ou o comando existe junto do ledger, do evento,
 * da auditoria e do novo estado, ou não existe nada. Não há mais janela em que
 * o runtime veja um comando que a saga recusou.
 */
export type PairingPort = (input: {
  tx: StepTx;
  tenant_id: string;
  agent_id: string;
  channel_id: string;
  command_id: string;
  method: 'qr' | 'code';
  actor_id: string;
  actor_role: string;
  correlation_id: string;
}) => Promise<{ ok: boolean; reason?: string }>;

const defaultPairingPort: PairingPort = async (input) => {
  const { channelLineStateRepo } = await import('@/db/repositories/channel-line-state-repos.js');
  const res = await channelLineStateRepo.requestCommandWithAuditInTx(input.tx, {
    scope: {
      tenant_id: input.tenant_id,
      agent_id: input.agent_id,
      channel_id: input.channel_id,
    },
    command: 'start_pairing',
    method: input.method,
    command_id: input.command_id,
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    correlation_id: input.correlation_id,
    audit: {
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      action: 'onboarding_pairing_requested',
      change_summary: { channel_id: input.channel_id, method: input.method },
    },
  });
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
};

/**
 * Avaliador de readiness. O `tx` é opcional na ASSINATURA (um teste injeta um
 * relatório fixo e não precisa dele) mas NUNCA no caminho de ativação: lá o
 * wizard sempre o passa, e o avaliador default lê por ele.
 */
export type ReadinessEvaluator = (
  scope: { tenant_id: string; agent_id: string },
  ctx?: { tx: StepTx },
) => Promise<AgentReadiness>;

/**
 * Re-review do PR #541, achado 1 — a saga é o dono do INÍCIO DA SESSÃO, não só
 * do `active = true`.
 *
 * O pareamento do onboarding deixou de ativar e deixou de subir a sessão de
 * roteamento. Alguém tem que subi-la, senão a run termina com a linha ativa no
 * banco e MUDA — visível para o resolver, sem socket. Esse alguém é o passo
 * `activate`, e o efeito é PÓS-COMMIT de propósito: abrir um socket Baileys
 * dentro da transação do passo prenderia a trava da run pela duração de um
 * handshake de rede, e um rollback deixaria o socket vivo para um `active` que
 * não existe.
 *
 * A porta é fail-isolated por construção: a linha JÁ está ativa e durável, e o
 * worker `channel_pairing`/o boot (`startAdditionalLineSessions`) reconciliam.
 * Uma falha de socket não pode desfazer a conclusão da run.
 */
export type LineSessionStarter = (
  scope: { tenant_id: string; agent_id: string },
  channel_ids: readonly string[],
) => Promise<void>;

const defaultStartLineSessions: LineSessionStarter = async (scope, channel_ids) => {
  if (channel_ids.length === 0) return;
  const { config } = await import('@/config/env.js');
  if (!config.MAIA_MULTI_LINE) return;
  const { db } = await import('@/db/client.js');
  const { channels } = await import('@/db/schema.js');
  const { and, eq, inArray } = await import('drizzle-orm');
  // O par COMPLETO no WHERE (invariante 1): o id vem do resultado do passo,
  // mas quem autoriza subir o socket é o escopo da run.
  const lines = await db
    .select({ id: channels.id, external_id: channels.external_id })
    .from(channels)
    .where(
      and(
        eq(channels.tenant_id, scope.tenant_id),
        eq(channels.agent_id, scope.agent_id),
        eq(channels.channel_type, 'whatsapp'),
        eq(channels.is_synthetic, false),
        eq(channels.active, true),
        inArray(channels.id, [...channel_ids]),
      ),
    );
  const { _internal } = await import('@/gateway/line-sessions.js');
  for (const line of lines) {
    await _internal
      .startLineSession({
        id: line.id,
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
        external_id: line.external_id,
      })
      .catch((err) =>
        logger.error(
          { channel_id: line.id, err: (err as Error).message },
          'onboarding.start_line_session_failed',
        ),
      );
  }
};

export type WizardDeps = {
  requestPairing?: PairingPort;
  evaluateReadiness?: ReadinessEvaluator;
  startLineSessions?: LineSessionStarter;
  now?: () => Date;
};

// ── Comandos ─────────────────────────────────────────────────────────────────

/**
 * O resultado da abertura da saga. `replayed` distingue "abri a run agora" de
 * "esta run já existia e é a sua" — o cliente precisa saber qual dos dois para
 * não contar duas aberturas, e a métrica idem.
 */
export type StartRunOutcome =
  | { status: 'started'; run: OnboardingRunView; replayed: boolean }
  | { status: 'conflict'; code: string; message: string; run?: OnboardingRunView };

/**
 * Abre a saga. IDEMPOTENTE (review do PR #541, achado 2): `idempotency_key` é
 * obrigatória e opaca, exatamente como no `executeOnboardingStep`, e o retry
 * com a mesma chave devolve a run JÁ MATERIALIZADA em vez de abrir outra.
 *
 * `metadata` deixou de ser `Record<string, unknown>` arbitrário: é um schema
 * TIPADO com vocabulário fechado (`runMetadataSchema`), e só os campos
 * aprovados são projetados para persistência (achado 5). Uma chave livre como
 * `note` — que atravessava a denylist porque o NOME dela é inofensivo — passa
 * a ser recusada na entrada.
 */
export async function startOnboardingRun(input: {
  kind: 'global_bootstrap' | 'tenant_onboarding';
  tenant_id: string | null;
  actor: OnboardingActor;
  idempotency_key: string;
  correlation_id?: string;
  ttl_ms?: number;
  metadata?: OnboardingRunMetadata;
}): Promise<StartRunOutcome> {
  if (input.kind === 'global_bootstrap') {
    // O bootstrap global exige uma credencial de uso único e um endpoint
    // restrito, que NÃO fazem parte desta fatia. Recusar explicitamente é
    // melhor do que aceitar uma run que nenhum comando saberia avançar.
    throw new OnboardingError(
      'kind_not_implemented',
      'bootstrap global ainda não implementado nesta fatia — use `tenant_onboarding`',
    );
  }
  assertMayMutate(input.actor, input.tenant_id);
  if (input.tenant_id !== null) assertTenantScope(input.tenant_id);
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length < 8) {
    throw new OnboardingError(
      'missing_idempotency_key',
      'idempotency_key é obrigatória na criação da run (mínimo 8 caracteres)',
    );
  }

  const correlation_id = input.correlation_id ?? randomUUID();
  // Contrato TIPADO + projeção explícita: o que não está no schema não chega
  // ao banco. Lança `invalid_scope` antes de qualquer escrita.
  const metadata = projectRunMetadata(input.metadata);
  const idempotency_key_hash = hashIdempotencyKey(input.idempotency_key);
  // O hash cobre a INTENÇÃO inteira da criação: reciclar a chave para outro
  // tenant, outro kind ou outro metadata é conflito, não replay.
  const payload_hash = hashPayload({
    step: 'create_run',
    payload: { kind: input.kind, tenant_id: input.tenant_id, metadata },
  });

  const { schemaFingerprint } = await import('./readiness.js');
  const { loadSchemaState } = await import('./readiness-facts.js');
  // Veredito canônico do schema (#516) — o mesmo que o readiness consome.
  const schema = await loadSchemaState();

  const created = await onboardingRunsRepo.create({
    kind: input.kind,
    tenant_id: input.tenant_id,
    agent_id: null,
    created_by: input.actor.actor_id,
    actor_role: input.actor.actor_role,
    correlation_id,
    expires_at: new Date(Date.now() + (input.ttl_ms ?? DEFAULT_RUN_TTL_MS)),
    configuration_contract_version: ONBOARDING_CONTRACT_VERSION,
    schema_version: schemaFingerprint(schema),
    idempotency_key_hash,
    payload_hash,
    metadata,
  });

  if (created.outcome === 'payload_conflict') {
    return {
      status: 'conflict',
      code: 'idempotency_payload_mismatch',
      message: 'a mesma idempotency key foi usada para abrir uma run diferente',
      run: toRunView(created.run),
    };
  }
  if (created.outcome === 'live_run_exists') {
    // Existe outra run VIVA para o escopo inicial, aberta com OUTRA chave.
    // `duplicate_tenant` é o código mais próximo do union fechado de
    // `ONBOARDING_ERROR_CODES` — o vocabulário é espelhado pelas métricas
    // (`src/observability/taxonomy.ts`), fora desta fatia, e inventar um código
    // novo faria os dois conjuntos divergirem em silêncio.
    return {
      status: 'conflict',
      code: 'duplicate_tenant',
      message: 'já existe uma saga de onboarding viva para este tenant — retome ou cancele',
    };
  }

  const run = created.run;
  const replayed = created.outcome === 'replayed';
  if (replayed) {
    counter(METRIC.ONBOARDING_IDEMPOTENCY_REPLAY, {
      step: stepLabel('create_run'),
      ...attribution({ tenant_id: run.tenant_id, agent_id: run.agent_id }),
    });
  } else {
    counter(METRIC.ONBOARDING_RUN_STARTED, {
      kind: input.kind,
      ...attribution({ tenant_id: run.tenant_id, agent_id: run.agent_id }),
    });
  }
  return { status: 'started', run: toRunView(run), replayed };
}

export async function getOnboardingRun(input: {
  run_id: string;
  actor: OnboardingActor;
}): Promise<OnboardingRunView | null> {
  const run = await onboardingRunsRepo.getForScope({
    run_id: input.run_id,
    tenant_id: tenantFilterFor(input.actor),
  });
  return run ? toRunView(run) : null;
}

export async function listOnboardingRuns(input: {
  actor: OnboardingActor;
  tenant_id: string;
  include_terminal?: boolean;
}): Promise<OnboardingRunView[]> {
  assertTenantScope(input.tenant_id);
  if (input.actor.actor_role !== 'founder' && input.actor.tenant_id !== input.tenant_id) {
    throw new OnboardingError('forbidden', 'listagem fora do escopo da sessão');
  }
  const rows = await onboardingRunsRepo.listForTenant({
    tenant_id: input.tenant_id,
    include_terminal: input.include_terminal ?? false,
  });
  return rows.map(toRunView);
}

/**
 * Cancelamento — IDEMPOTENTE e com motivo de VOCABULÁRIO FECHADO (review do
 * PR #541, achados 3 e 5).
 *
 * O que mudou, e por quê:
 *   * `idempotency_key` passou a ser obrigatória. Sem ela, um retry após um
 *     commit cujo resultado se perdeu encontrava a run já `cancelled` e
 *     recebia `run_terminal` — um ERRO para uma operação que tinha dado certo.
 *   * `reason_code` deixou de ser texto livre. Ele é persistido INTEGRALMENTE
 *     em `onboarding_runs.last_error_code`, no evento append-only e em
 *     `admin_audit_log`; enquanto era livre, "telefone/e-mail do cliente que
 *     desistiu" entrava nas três — a denylist de `sanitize.ts` decide por NOME
 *     de chave e nunca olhou esse valor. Agora o valor persistido é o mesmo
 *     que vira label de métrica.
 */
export async function cancelOnboardingRun(input: {
  run_id: string;
  expected_version: number;
  actor: OnboardingActor;
  reason_code: OnboardingCancelReason;
  idempotency_key: string;
  correlation_id?: string;
}): Promise<StepOutcome> {
  const reason_code = parseCancelReason(input.reason_code);
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length < 8) {
    throw new OnboardingError(
      'missing_idempotency_key',
      'idempotency_key é obrigatória no cancelamento (mínimo 8 caracteres)',
    );
  }

  const existing = await onboardingRunsRepo.getForScope({
    run_id: input.run_id,
    tenant_id: tenantFilterFor(input.actor),
  });
  if (!existing) return { status: 'not_found' };
  assertMayMutate(input.actor, existing.tenant_id);

  const outcome = await onboardingRunsRepo.cancel({
    run_id: input.run_id,
    tenant_id: scopeFilterFor(input.actor, existing),
    expected_version: input.expected_version,
    actor_id: input.actor.actor_id,
    actor_role: input.actor.actor_role,
    correlation_id: input.correlation_id ?? randomUUID(),
    reason_code,
    idempotency_key_hash: hashIdempotencyKey(input.idempotency_key),
    payload_hash: hashPayload({ step: 'cancel_run', payload: { reason_code } }),
  });
  if (outcome.outcome === 'committed') {
    counter(METRIC.ONBOARDING_RUN_CANCELLED, {
      reason: reasonLabel(reason_code),
      ...attribution(existing),
    });
  }
  if (outcome.outcome === 'replayed') {
    counter(METRIC.ONBOARDING_IDEMPOTENCY_REPLAY, {
      step: stepLabel('cancel_run'),
      ...attribution(existing),
    });
  }
  return mapOutcome(outcome);
}

/**
 * O comando central. `idempotency_key` é OBRIGATÓRIA e opaca: o frontend a
 * conserva até obter um resultado conclusivo (o contrato da issue §4).
 */
export async function executeOnboardingStep(input: {
  run_id: string;
  step: string;
  payload: unknown;
  idempotency_key: string;
  expected_version: number;
  actor: OnboardingActor;
  correlation_id?: string;
  deps?: WizardDeps;
}): Promise<StepOutcome> {
  const def = getStepDefinition(input.step);
  const step = def.step;
  const correlation_id = input.correlation_id ?? randomUUID();
  const started = Date.now();

  const existing = await onboardingRunsRepo.getForScope({
    run_id: input.run_id,
    tenant_id: tenantFilterFor(input.actor),
  });
  if (!existing) return { status: 'not_found' };
  assertMayMutate(input.actor, existing.tenant_id);

  const idempotency_key_hash = hashIdempotencyKey(input.idempotency_key);
  const payload = parseStepPayload(step, input.payload);
  const payload_hash = hashPayload({ step, payload });

  // `evaluate_readiness`/`activate` produzem um relatório que o caller precisa
  // ver mesmo quando a transição é negada. Capturado aqui, fora do `apply`.
  let readiness: AgentReadiness | undefined;

  const requestPairing = input.deps?.requestPairing ?? defaultPairingPort;
  const startLineSessions = input.deps?.startLineSessions ?? defaultStartLineSessions;

  /**
   * O avaliador default lê os fatos PELO `tx` DO PASSO. Ler pelo handle global
   * `db`, como se fazia, tirava a decisão de dentro da transação que faz as
   * escritas: só a row de `onboarding_runs` estava travada, e profile, grant,
   * papel, política ou canal podiam mudar entre o retrato e o `applyActivate`.
   */
  const evaluate: ReadinessEvaluator =
    input.deps?.evaluateReadiness ??
    ((scope, ctx) =>
      evaluateAgentReadiness(
        scope,
        ctx
          ? { loadFacts: (s) => loadReadinessFactsWith(ctx.tx, s) }
          : {},
      ));

  let outcome: CommitStepOutcome;
  try {
    outcome = await onboardingRunsRepo.commitStep({
      run_id: input.run_id,
      tenant_id: scopeFilterFor(input.actor, existing),
      expected_version: input.expected_version,
      step,
      idempotency_key_hash,
      payload_hash,
      actor_id: input.actor.actor_id,
      actor_role: input.actor.actor_role,
      correlation_id,
      apply: async (tx, run): Promise<StepApplication> => {
        switch (step) {
          case 'provision_tenant':
            return applyProvisionTenant(tx, run, payload as never);
          case 'provision_admin':
            return applyProvisionAdmin(tx, run, payload as never);
          case 'provision_agent':
            return applyProvisionAgent(tx, run, payload as never);
          case 'configure_profile':
            return applyConfigureProfile(tx, run, payload as never, input.actor.actor_id);
          case 'apply_capability_packs':
            return applyCapabilityPacks(tx, run, payload as never, input.actor.actor_id);
          case 'configure_role':
            return applyConfigureRole(tx, run, payload as never);
          case 'declare_channel':
            return applyDeclareChannel(tx, run, payload as never);
          case 'start_pairing': {
            // O EFEITO ACONTECE AQUI — depois da trava, da expiração, do
            // ledger, da versão e da transição, e no MESMO `tx`. A fila de
            // #518 é uma tabela deste banco (migration 103), então enfileirar
            // dentro da transação é o que torna a saga inteira tudo-ou-nada:
            // nenhum comando sobrevive a um passo recusado.
            const p = payload as { channel_id: string; method: 'qr' | 'code' };
            const scope = requireRunScope(run);
            const command_id = deriveCommandId(run.id, step, idempotency_key_hash);
            const res = await requestPairing({
              tx,
              tenant_id: scope.tenant_id,
              agent_id: scope.agent_id,
              channel_id: p.channel_id,
              command_id,
              method: p.method,
              actor_id: input.actor.actor_id,
              actor_role: input.actor.actor_role,
              correlation_id,
            });
            if (!res.ok) {
              return {
                result: {},
                deny: {
                  code: res.reason ?? 'pairing_rejected',
                  message: 'o runtime recusou a solicitação de pareamento',
                },
                audit: {
                  action: 'onboarding_pairing_started',
                  resource_type: 'channel',
                  resource_id: p.channel_id,
                },
              };
            }
            return {
              result: { channel_id: p.channel_id, command_id },
              summary: { channel_id: p.channel_id },
              audit: {
                action: 'onboarding_pairing_started',
                resource_type: 'channel',
                resource_id: p.channel_id,
              },
            };
          }
          case 'confirm_channel_ready':
            return applyConfirmChannelReady(tx, run, payload as never);
          case 'evaluate_readiness': {
            // Lê pelo `tx`: o relatório é do MESMO banco que a run travada,
            // não de uma conexão paralela. Não trava as linhas — este passo
            // não escreve nada, e segurar `FOR SHARE` sobre a configuração do
            // agente a cada refresh de dashboard seria contenção gratuita.
            readiness = await evaluate(requireRunScope(run), { tx });
            return {
              result: readinessResult(readiness),
              summary: readinessSummary(readiness),
              ...(readiness.ready
                ? {}
                : {
                    deny: {
                      code: 'readiness_blocked',
                      message: `${blockingFailures(readiness).length} check(s) bloqueante(s) reprovado(s)`,
                    },
                  }),
              audit: {
                action: 'onboarding_readiness_evaluated',
                resource_type: 'agent',
                resource_id: run.agent_id,
              },
            };
          }
          case 'activate': {
            const scope = requireRunScope(run);
            const confirm = payload as { confirm_tenant_id: string; confirm_agent_id: string };
            if (
              confirm.confirm_tenant_id !== scope.tenant_id ||
              confirm.confirm_agent_id !== scope.agent_id
            ) {
              return {
                result: {},
                deny: {
                  code: 'scope_mismatch',
                  message: 'o par confirmado não corresponde ao escopo da run',
                },
                audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: run.agent_id },
              };
            }
            // REAVALIAÇÃO sob a trava da run: readiness verde há cinco minutos
            // não autoriza ativar agora.
            //
            // E não basta reavaliar: a decisão e a escrita precisam depender do
            // MESMO retrato protegido. Primeiro travamos as linhas de que o
            // veredito depende (`FOR SHARE` no que só é lido, `FOR UPDATE` no
            // que será escrito), depois lemos os fatos PELO `tx`, depois
            // escrevemos. `applyActivate` ainda confere o efeito das suas
            // escritas — lock não é predicate lock, e uma linha nova inserida
            // concorrentemente não seria travada por nada.
            await lockReadinessSnapshot(tx, scope);
            readiness = await evaluate(scope, { tx });
            if (!readiness.ready) {
              return {
                result: readinessResult(readiness),
                summary: readinessSummary(readiness),
                deny: {
                  code: 'readiness_blocked',
                  message: `${blockingFailures(readiness).length} check(s) bloqueante(s) reprovado(s)`,
                },
                audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: run.agent_id },
              };
            }
            // O conjunto de canais VALIDADO pelo avaliador viaja junto: a
            // ativação liga exatamente os canais que satisfizeram, cada um por
            // si, política + papel ativo + posse provada, e confere esse mesmo
            // conjunto contra o banco sob os locks antes de escrever (review do
            // PR #541, achado 1).
            // `channels` viaja junto porque a ativação agora aplica o conjunto
            // EXATO: liga os aprovados e DESLIGA os governados excluídos, e a
            // auditoria da desativação precisa dos `failed_checks` de cada um
            // (re-review do PR #541, achado 3). O ator vai junto porque tirar
            // um canal do roteamento é decisão de governança — tem dono.
            return applyActivate(tx, run, {
              configuration_fingerprint: readiness.configuration_fingerprint,
              schema_fingerprint: readiness.schema_fingerprint,
              activatable_channel_ids: readiness.activatable_channel_ids,
              channel_verdicts: readiness.channels,
              actor: {
                actor_id: input.actor.actor_id,
                actor_role: input.actor.actor_role,
              },
            });
          }
          default: {
            const exhaustive: never = step;
            throw new OnboardingError('unknown_step', `passo não tratado: ${String(exhaustive)}`);
          }
        }
      },
    });
  } catch (err) {
    const code = toOnboardingErrorCode(err);
    counter(METRIC.ONBOARDING_STEP_FAILED, {
      step: stepLabel(step),
      reason: reasonLabel(code),
      ...attribution(existing),
    });
    logger.error({ err, step, run_id: input.run_id, correlation_id }, 'onboarding.step_failed');
    throw err;
  }

  histogram(METRIC.ONBOARDING_STEP_DURATION_MS, Date.now() - started, {
    step: stepLabel(step),
    ...attribution('run' in outcome ? outcome.run : existing),
  });

  // Num REPLAY o `apply` do passo nunca roda, logo `readiness` acima continua
  // `undefined`: o relatório precisa vir do LEDGER, que é onde a avaliação
  // original ficou guardada. Reavaliar aqui produziria um veredito NOVO — e um
  // veredito novo não é um replay.
  const replayedReadiness =
    (step === 'evaluate_readiness' || step === 'activate') &&
    ((outcome.outcome === 'denied' && outcome.replayed === true) ||
      outcome.outcome === 'replayed')
      ? reconstituteReadiness(outcome.result)
      : undefined;

  // Auditoria agente-escopada PÓS-COMMIT. `admin_audit_log` já recebeu o
  // registro atômico dentro da transação; este `audit()` existe porque
  // readiness e ativação são decisões de governança do AGENTE e pertencem
  // também à trilha `audit_log` (invariante 4). É best-effort por construção
  // (`audit()` loga+conta a falha) — a evidência atômica já está gravada.
  await emitAgentScopedAudit(step, outcome, replayedReadiness ?? readiness);

  switch (outcome.outcome) {
    case 'committed':
      counter(METRIC.ONBOARDING_STEP_COMPLETED, {
        step: stepLabel(step),
        ...attribution(outcome.run),
      });
      if (step === 'activate') {
        counter(METRIC.ONBOARDING_RUN_COMPLETED, {
          kind: outcome.run.kind,
          ...attribution(outcome.run),
        });
        // Re-review do PR #541, achado 1 — o passo final é o dono do início da
        // sessão. Só os canais que ESTA transação ligou; `activated_channel_ids`
        // é o conjunto re-derivado sob os locks, nunca "os canais do agente".
        // Fail-isolated: a run já concluiu e é durável.
        const activated = outcome.result.activated_channel_ids;
        if (Array.isArray(activated) && activated.length > 0 && outcome.run.tenant_id && outcome.run.agent_id) {
          await startLineSessions(
            { tenant_id: outcome.run.tenant_id, agent_id: outcome.run.agent_id },
            activated.filter((id): id is string => typeof id === 'string'),
          ).catch((err) =>
            logger.error(
              { err, run_id: outcome.run.id },
              'onboarding.start_line_sessions_failed',
            ),
          );
        }
      }
      return {
        status: 'completed',
        run: toRunView(outcome.run),
        result: outcome.result,
        replayed: false,
        ...(readiness ? { readiness } : {}),
      };
    case 'replayed':
      counter(METRIC.ONBOARDING_IDEMPOTENCY_REPLAY, {
        step: stepLabel(step),
        ...attribution(outcome.run),
      });
      return {
        status: 'completed',
        run: toRunView(outcome.run),
        result: outcome.result,
        replayed: true,
        ...(replayedReadiness ? { readiness: replayedReadiness } : {}),
      };
    case 'denied':
      // Uma negativa REPLAYADA (retry da mesma chave após um commit cuja
      // resposta se perdeu) não é uma nova recusa: contá-la inflaria
      // `onboarding_step_failed_total` com retentativas do cliente. Ela ganha a
      // série de replay, como qualquer outro resultado vindo do ledger.
      counter(
        outcome.replayed ? METRIC.ONBOARDING_IDEMPOTENCY_REPLAY : METRIC.ONBOARDING_STEP_FAILED,
        outcome.replayed
          ? { step: stepLabel(step), ...attribution(outcome.run) }
          : {
              step: stepLabel(step),
              reason: reasonLabel(outcome.code),
              ...attribution(outcome.run),
            },
      );
      // Pela mesma razão do contador acima: `agent_readiness_failed` conta
      // CHECKS REPROVADOS numa avaliação, e o replay não avalia nada. Contar o
      // relatório reconstituído somaria os mesmos checks de novo a cada retry.
      if (readiness) {
        for (const failed of blockingFailures(readiness)) {
          counter(METRIC.AGENT_READINESS_FAILED, {
            check_code: closedVocabulary(failed.code, READINESS_CHECK_CODE_VALUES),
            ...attribution(outcome.run),
          });
        }
      }
      return {
        status: 'denied',
        run: toRunView(outcome.run),
        code: outcome.code,
        message: outcome.message,
        // O relatório volta nas duas pontas: da avaliação nova (`readiness`) ou
        // do ledger (`replayedReadiness`). Antes o replay devolvia code/message
        // e mais nada — o operador ficava sabendo que foi recusado sem saber
        // por qual check nem o que corrigir.
        ...(readiness ?? replayedReadiness
          ? { readiness: (readiness ?? replayedReadiness) as AgentReadiness }
          : {}),
      };
    default:
      return mapOutcome(outcome);
  }
}

function mapOutcome(outcome: CommitStepOutcome): StepOutcome {
  switch (outcome.outcome) {
    case 'not_found':
      return { status: 'not_found' };
    case 'committed':
      return { status: 'completed', run: toRunView(outcome.run), result: outcome.result, replayed: false };
    case 'replayed':
      return { status: 'completed', run: toRunView(outcome.run), result: outcome.result, replayed: true };
    case 'payload_conflict':
      return {
        status: 'conflict',
        code: 'idempotency_payload_mismatch',
        message: 'a mesma idempotency key foi usada com um payload diferente',
        run: toRunView(outcome.run),
      };
    case 'version_conflict':
      return {
        status: 'conflict',
        code: 'version_conflict',
        message: 'a run avançou desde a leitura — recarregue e tente de novo',
        run: toRunView(outcome.run),
      };
    case 'invalid_transition':
      return {
        status: 'conflict',
        code: outcome.code,
        message: outcome.message,
        run: toRunView(outcome.run),
      };
    case 'denied':
      return {
        status: 'denied',
        run: toRunView(outcome.run),
        code: outcome.code,
        message: outcome.message,
      };
  }
}

function requireRunScope(run: OnboardingRunRow): { tenant_id: string; agent_id: string } {
  if (!run.tenant_id || !run.agent_id) {
    throw new OnboardingError('scope_mismatch', 'run sem (tenant, agente) resolvido');
  }
  return { tenant_id: run.tenant_id, agent_id: run.agent_id };
}

/** Só códigos + status. Mensagens ficam no relatório devolvido, não no banco. */
function readinessSummary(readiness: AgentReadiness): Record<string, unknown> {
  return {
    ready: readiness.ready,
    failed_checks: blockingFailures(readiness).map((c) => c.code),
    configuration_fingerprint: readiness.configuration_fingerprint,
    schema_fingerprint: readiness.schema_fingerprint,
  };
}

/**
 * O `result` que vai para o LEDGER (`onboarding_step_results.result`) — e que
 * o replay devolve no lugar de reavaliar.
 *
 * Guarda o relatório INTEIRO, e não a projeção `{code,status,severity}` que
 * havia antes, porque o ledger é a única memória que a saga tem de uma decisão
 * já tomada. Com a projeção, o replay de uma NEGATIVA devolvia um veredito sem
 * `message` e sem `remediation`: o operador que perdeu a primeira resposta
 * descobria que foi recusado e não descobria o que fazer a respeito — a única
 * parte acionável da resposta era exatamente a que não sobrevivia ao retry.
 *
 * Não é o mesmo papel de `readinessSummary`, que alimenta
 * `onboarding_events.summary` e a auditoria e continua deliberadamente
 * reduzido a códigos: aquilo é uma TRILHA (varrida, agregada, retida por
 * muito tempo), isto é uma RESPOSTA (lida uma vez pelo cliente que a pediu).
 *
 * Continua passando por `sanitizeForPersistence` no repositório, como todo
 * `result`; as mensagens de check já nascem sanitizadas por contrato
 * (`ReadinessCheck.message` em `readiness.ts`).
 */
function readinessResult(readiness: AgentReadiness): Record<string, unknown> {
  return {
    tenant_id: readiness.tenant_id,
    agent_id: readiness.agent_id,
    ready: readiness.ready,
    evaluated_at: readiness.evaluated_at,
    configuration_fingerprint: readiness.configuration_fingerprint,
    schema_fingerprint: readiness.schema_fingerprint,
    checks: readiness.checks.map((c) => ({
      code: c.code,
      status: c.status,
      severity: c.severity,
      message: c.message,
      remediation: c.remediation,
    })),
    channels: readiness.channels,
    activatable_channel_ids: readiness.activatable_channel_ids,
  };
}

/**
 * O INVERSO de `readinessResult`: reconstitui o relatório a partir do que o
 * ledger guardou, para que o replay devolva a MESMA resposta.
 *
 * Reavaliar seria a outra saída possível, e está errada por duas razões: uma
 * avaliação nova pode dar outro veredito (a configuração muda), então não seria
 * um replay; e seria uma DECISÃO nova, que precisaria de auditoria própria —
 * exatamente o que o replay não é.
 *
 * A validação é Zod e o retorno é `undefined` quando não casa. O JSON vem do
 * banco, pode ter sido gravado por uma versão anterior do código (o `result`
 * projetado, sem `message`/`remediation`) e pode ter sido truncado pelos
 * limites de `sanitize.ts`. Nesses casos o replay devolve code/message sem
 * relatório — o comportamento antigo — em vez de um relatório inventado.
 */
const replayedReadinessSchema = z.object({
  tenant_id: z.string().min(1),
  agent_id: z.string().min(1),
  ready: z.boolean(),
  evaluated_at: z.string(),
  configuration_fingerprint: z.string(),
  schema_fingerprint: z.string(),
  checks: z.array(
    z.object({
      code: z.enum(READINESS_CHECK_CODES),
      status: z.enum(['pass', 'fail']),
      severity: z.enum(['blocking', 'advisory']),
      message: z.string(),
      remediation: z.string(),
    }),
  ),
  channels: z.array(
    z.object({
      channel_id: z.string(),
      policy_governed: z.boolean(),
      policy_role_active: z.boolean(),
      ownership_proven: z.boolean(),
      online: z.boolean(),
      activatable: z.boolean(),
      failed_checks: z.array(z.enum(READINESS_CHECK_CODES)),
    }),
  ),
  activatable_channel_ids: z.array(z.string()),
});

function reconstituteReadiness(result: unknown): AgentReadiness | undefined {
  const parsed = replayedReadinessSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `command_id` DERIVADO — não aleatório. É o que torna o retry do pareamento
 * idempotente: a mesma (run, passo, chave) produz sempre o mesmo uuid, e #518
 * devolve a sessão existente em vez de abrir outra.
 */
export function deriveCommandId(run_id: string, step: string, key_hash: string): string {
  const h = createHash('sha256').update(`${run_id}:${step}:${key_hash}`, 'utf8').digest('hex');
  // Formato uuid v4-like (a versão/variante são cosméticas: o valor é um hash,
  // e a coluna é `uuid`).
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

async function emitAgentScopedAudit(
  step: OnboardingStep,
  outcome: CommitStepOutcome,
  readiness: AgentReadiness | undefined,
): Promise<void> {
  if (step !== 'evaluate_readiness' && step !== 'activate') return;
  if (outcome.outcome !== 'committed' && outcome.outcome !== 'denied') return;
  // Um REPLAY não é uma decisão — e `audit_log` registra decisões (invariante 4
  // do AGENTS.md). A negativa aconteceu UMA vez; o cliente é que perdeu a
  // resposta e repetiu a chave. Auditar de novo gravava uma segunda linha para
  // um evento único, e "quantas vezes este agente foi recusado" deixava de ser
  // respondível contando linhas — passava a medir retentativas de rede.
  //
  // Escolhemos NÃO auditar, em vez de auditar marcando `replayed: true`, por
  // três razões:
  //
  //   1. Simetria das duas trilhas. `commitStep` também NÃO escreve
  //      `admin_audit_log` no caminho de replay. Gravar em `audit_log` e não em
  //      `admin_audit_log` faria as duas trilhas discordarem sobre quantas
  //      vezes a recusa aconteceu — e a discordância só apareceria numa
  //      auditoria, tarde.
  //   2. O replay JÁ tem registro append-only, e no lugar certo: `commitStep`
  //      insere um `step_replayed` em `onboarding_events`, na MESMA transação,
  //      com ator, `correlation_id` e hash da chave. "O cliente repetiu" é um
  //      fato da saga, não uma decisão de governança.
  //   3. Uma linha por retry é ilimitada: um cliente em loop de retry inflaria
  //      a trilha de governança indefinidamente, e todo consumidor que
  //      esquecesse de filtrar a flag contaria errado. Fechar na ESCRITA é
  //      determinístico; depender de todo leitor filtrar, não.
  if (outcome.outcome === 'denied' && outcome.replayed) return;
  const run = outcome.run;
  if (!run.tenant_id || !run.agent_id) return;

  const acao =
    step === 'evaluate_readiness'
      ? 'agent_readiness_evaluated'
      : outcome.outcome === 'committed'
        ? 'agent_activation_approved'
        : 'agent_activation_denied';

  await runWithTenantContext({ tenant_id: run.tenant_id, agent_id: run.agent_id }, () =>
    audit({
      acao,
      entidade_alvo: 'agent',
      // `audit_log.alvo_id` é uma coluna `uuid`; `agents.id` é TEXT (um slug
      // como `acme-bot`). Passar o id do agente ali é 22P02 — e `audit()`
      // ENGOLE a exceção por design (best-effort, loga `audit.write_failed`),
      // então a trilha agente-escopada de readiness e de ativação simplesmente
      // NUNCA era gravada: sem erro para o operador, sem teste vermelho, só uma
      // linha de log. O agente já está atribuído em `audit_log.agent_id` (TEXT)
      // pelo `runWithTenantContext` acima; repetimos o id em `metadata` para
      // quem consulta por lá. Invariante 4 do AGENTS.md.
      alvo_id: null,
      metadata: {
        run_id: run.id,
        step,
        agent_id: run.agent_id,
        tenant_id: run.tenant_id,
        ...(readiness ? readinessSummary(readiness) : {}),
      },
    }),
  );
}

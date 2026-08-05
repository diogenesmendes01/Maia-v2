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
  type AgentReadiness,
} from './readiness.js';
import { loadReadinessFactsWith, lockReadinessSnapshot } from './readiness-facts.js';
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

/** Passo → label `step`, colapsado no vocabulário fechado. */
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
    allowed_steps: allowedStepsFrom(run.state as OnboardingState),
    last_error_code: run.last_error_code,
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

export type WizardDeps = {
  requestPairing?: PairingPort;
  evaluateReadiness?: ReadinessEvaluator;
  now?: () => Date;
};

// ── Comandos ─────────────────────────────────────────────────────────────────

export async function startOnboardingRun(input: {
  kind: 'global_bootstrap' | 'tenant_onboarding';
  tenant_id: string | null;
  actor: OnboardingActor;
  correlation_id?: string;
  ttl_ms?: number;
  metadata?: Record<string, unknown>;
}): Promise<OnboardingRunView> {
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

  const correlation_id = input.correlation_id ?? randomUUID();
  const { schemaFingerprint } = await import('./readiness.js');
  const { loadSchemaState } = await import('./readiness-facts.js');
  // Veredito canônico do schema (#516) — o mesmo que o readiness consome.
  const schema = await loadSchemaState();

  const run = await onboardingRunsRepo.create({
    kind: input.kind,
    tenant_id: input.tenant_id,
    agent_id: null,
    created_by: input.actor.actor_id,
    actor_role: input.actor.actor_role,
    correlation_id,
    expires_at: new Date(Date.now() + (input.ttl_ms ?? DEFAULT_RUN_TTL_MS)),
    configuration_contract_version: ONBOARDING_CONTRACT_VERSION,
    schema_version: schemaFingerprint(schema),
    metadata: input.metadata,
  });

  counter(METRIC.ONBOARDING_RUN_STARTED, {
    kind: input.kind,
    ...attribution({ tenant_id: run.tenant_id, agent_id: run.agent_id }),
  });
  return toRunView(run);
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

export async function cancelOnboardingRun(input: {
  run_id: string;
  expected_version: number;
  actor: OnboardingActor;
  reason_code: string;
  correlation_id?: string;
}): Promise<StepOutcome> {
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
    reason_code: input.reason_code.slice(0, 64),
  });
  if (outcome.outcome === 'committed') {
    // `reason_code` é TEXTO ARBITRÁRIO do console. Ele vai inteiro (truncado em
    // 64) para `onboarding_runs.last_error_code`, para o evento e para a
    // auditoria; no label entra apenas o vocabulário fechado.
    counter(METRIC.ONBOARDING_RUN_CANCELLED, {
      reason: reasonLabel(input.reason_code),
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
            return applyActivate(tx, run, {
              configuration_fingerprint: readiness.configuration_fingerprint,
              schema_fingerprint: readiness.schema_fingerprint,
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

  // Auditoria agente-escopada PÓS-COMMIT. `admin_audit_log` já recebeu o
  // registro atômico dentro da transação; este `audit()` existe porque
  // readiness e ativação são decisões de governança do AGENTE e pertencem
  // também à trilha `audit_log` (invariante 4). É best-effort por construção
  // (`audit()` loga+conta a falha) — a evidência atômica já está gravada.
  await emitAgentScopedAudit(step, outcome, readiness);

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
      };
    case 'denied':
      counter(METRIC.ONBOARDING_STEP_FAILED, {
        step: stepLabel(step),
        reason: reasonLabel(outcome.code),
        ...attribution(outcome.run),
      });
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
        ...(readiness ? { readiness } : {}),
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

function readinessResult(readiness: AgentReadiness): Record<string, unknown> {
  return {
    ready: readiness.ready,
    evaluated_at: readiness.evaluated_at,
    configuration_fingerprint: readiness.configuration_fingerprint,
    schema_fingerprint: readiness.schema_fingerprint,
    checks: readiness.checks.map((c) => ({ code: c.code, status: c.status, severity: c.severity })),
  };
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

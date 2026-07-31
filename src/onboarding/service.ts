/**
 * Issue #519 — o SERVIÇO da saga de onboarding.
 *
 * Divisão de responsabilidades:
 *   - `state-machine.ts` diz o que PODE acontecer (puro);
 *   - `onboarding-repos.ts` guarda o estado, serializa concorrência e escreve
 *     a trilha;
 *   - `readiness.ts` produz o laudo canônico;
 *   - ESTE módulo executa o efeito de cada passo, e é o único lugar que sabe
 *     que "o passo `agent`" significa `agentsRepo.createWithSeedAndAudit`.
 *
 * Duas escolhas de projeto que valem explicação:
 *
 * 1. **Os efeitos reusam os repos atômicos existentes.** `createWithAuditAtomic`,
 *    `createWithSeedAndAudit`, `createWithAudit` e `approveAndActivateAtomic`
 *    já commitam o recurso E a auditoria juntos, e já mapeiam `23505` para
 *    razão tipada. Reescrever esse trabalho aqui criaria uma segunda fonte de
 *    verdade sobre atomicidade — o oposto do que a issue pede.
 *
 * 2. **A ADOÇÃO só acontece em retomada.** Se o processo caiu entre o efeito e
 *    a conclusão do passo, o recurso existe e o ledger está `pending`. Nesse e
 *    somente nesse caso, uma duplicata é ADOTADA em vez de virar erro — e ainda
 *    assim só quando a identidade bate exatamente e o recurso está no escopo
 *    da run. Fora da retomada, duplicata é conflito: adotar um tenant ou um
 *    agente alheio "porque o id coincide" seria escalação de privilégio
 *    disfarçada de idempotência.
 */
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { CONTRACT_VERSION } from '@/config/contract.js';
import { logger } from '@/lib/logger.js';
import { counter, histogram } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import {
  agentsRepo,
  agentToolGrantsRepo,
  appUsersRepo,
  channelLineStateRepo,
  channelPoliciesRepo,
  channelsRepo,
  onboardingRepo,
  operationalProfileVersionsRepo,
  rolesRepo,
  tenantsRepo,
  bootstrapCredentialsRepo,
  hashOpaque,
  hashPayload,
} from '@/db/repositories.js';
import type { OnboardingRunRow } from '@/db/schema.js';
import { PROFILE_BODY_SCHEMA_VERSION, type ProfileBody } from '@/db/schema.js';
import { ARCHETYPE_PACK_MAP, isArchetypeId } from '@/tools/archetype-packs.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import {
  OnboardingError,
  allowedSteps,
  progressOf,
  type OnboardingErrorCode,
  type OnboardingKind,
  type OnboardingState,
  type OnboardingStep,
} from './state-machine.js';
import {
  ActivationStepSchema,
  AdminStepSchema,
  AgentStepSchema,
  CapabilitiesStepSchema,
  ChannelStepSchema,
  PairingStepSchema,
  ProfileStepSchema,
  RoleStepSchema,
  TenantStepSchema,
  type BootstrapCommand,
} from './commands.js';
import {
  blockingFailures,
  evaluateAgentReadiness,
  type AgentReadiness,
} from './readiness.js';

/** Quem está pedindo. Nunca vem do body — o router o constrói da SESSÃO. */
export interface OnboardingActor {
  user_id: string;
  role: string;
  /** Tenant da sessão. */
  tenant_id: string;
  is_founder: boolean;
}

/** O ator sintético do bootstrap global: não há sessão a que se referir. */
const BOOTSTRAP_ACTOR: OnboardingActor = {
  user_id: 'bootstrap',
  role: 'founder',
  tenant_id: 'system',
  is_founder: true,
};

export interface RunView {
  id: string;
  kind: OnboardingKind;
  state: OnboardingState;
  current_step: OnboardingStep;
  version: number;
  tenant_id: string | null;
  agent_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  last_error_code: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
  progress: number;
  allowed_steps: OnboardingStep[];
  /** Laudo canônico — só depois que a run tem escopo completo. */
  readiness: AgentReadiness | null;
}

// ---------------------------------------------------------------------------

function toView(run: OnboardingRunRow, readiness: AgentReadiness | null): RunView {
  const state = run.state as OnboardingState;
  return {
    id: run.id,
    kind: run.kind as OnboardingKind,
    state,
    current_step: run.current_step as OnboardingStep,
    version: run.version,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    created_by: run.created_by,
    created_at: run.created_at,
    updated_at: run.updated_at,
    expires_at: run.expires_at,
    completed_at: run.completed_at,
    cancelled_at: run.cancelled_at,
    last_error_code: run.last_error_code,
    correlation_id: run.correlation_id,
    metadata: (run.metadata ?? {}) as Record<string, unknown>,
    progress: progressOf(state),
    allowed_steps: allowedSteps({ kind: run.kind as OnboardingKind, state }),
    readiness,
  };
}

/**
 * Autorização de LEITURA/ESCRITA sobre a run. Fail-closed e sem distinguir
 * "não existe" de "não é seu": um tenant não pode nem DESCOBRIR a run de
 * outro (critério de aceite explícito).
 */
function assertRunVisible(run: OnboardingRunRow | null, actor: OnboardingActor): OnboardingRunRow {
  if (!run) {
    throw new OnboardingError('run_not_found', 'Run de onboarding não encontrada.', false);
  }
  if (actor.is_founder) return run;
  if (run.actor_tenant_id !== actor.tenant_id && run.tenant_id !== actor.tenant_id) {
    throw new OnboardingError('run_not_found', 'Run de onboarding não encontrada.', false);
  }
  return run;
}

/** Só owner e founder operam o wizard — o mesmo gate da #518. */
function assertOperatorRole(actor: OnboardingActor): void {
  if (actor.role !== 'owner' && actor.role !== 'founder') {
    throw new OnboardingError(
      'forbidden_role',
      `Papel '${actor.role}' não pode operar o provisionamento.`,
      false,
    );
  }
}

async function readinessForRun(run: OnboardingRunRow): Promise<AgentReadiness | null> {
  if (!run.tenant_id || !run.agent_id) return null;
  return evaluateAgentReadiness(run.tenant_id, run.agent_id);
}

// ---------------------------------------------------------------------------
// Efeitos por passo
// ---------------------------------------------------------------------------

interface StepContext {
  run: OnboardingRunRow;
  actor: OnboardingActor;
  /** `true` quando a reivindicação já existia (retomada após queda). */
  resumed: boolean;
}

interface StepOutcome {
  result: Record<string, unknown>;
  tenant_id?: string;
  agent_id?: string;
  metadata_patch?: Record<string, unknown>;
  audit: {
    action: string;
    resource_type: string;
    resource_id: string | null;
    change_summary: Record<string, unknown>;
  };
}

/**
 * Um recurso duplicado só pode ser ADOTADO numa retomada. Fora dela, o id já
 * existir significa colisão real — e devolver sucesso escondendo isso deixaria
 * o operador achando que provisionou algo que não provisionou.
 */
function assertAdoptable(ctx: StepContext, code: OnboardingErrorCode, message: string): void {
  if (!ctx.resumed) throw new OnboardingError(code, message);
}

async function stepTenant(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = TenantStepSchema.parse(raw);

  if (input.mode === 'attach') {
    const tenant = await tenantsRepo.findById(input.tenant_id);
    if (!tenant) {
      throw new OnboardingError('tenant_not_found', `Tenant '${input.tenant_id}' não existe.`);
    }
    // Só founder anexa um tenant que não é o da própria sessão.
    if (!ctx.actor.is_founder && tenant.id !== ctx.actor.tenant_id) {
      throw new OnboardingError('forbidden_role', 'Você só pode provisionar no próprio tenant.', false);
    }
    if (tenant.status !== 'active') {
      throw new OnboardingError('tenant_suspended', `Tenant está '${tenant.status}'.`);
    }
    return {
      result: { tenant_id: tenant.id, created: false },
      tenant_id: tenant.id,
      metadata_patch: { tenant_nome: tenant.nome },
      audit: {
        action: 'onboarding_tenant_attached',
        resource_type: 'tenant',
        resource_id: tenant.id,
        change_summary: {
          target_tenant_id: tenant.id,
          onboarding_run_id: ctx.run.id,
          reason: input.comment,
        },
      },
    };
  }

  // `create` — provisionar tenant novo é operação de founder (mesmo gate que
  // `tenants.create` já aplica). O bootstrap global roda com ator sintético
  // founder, o que é correto: é justamente o momento em que não há sessão.
  if (!ctx.actor.is_founder) {
    throw new OnboardingError('forbidden_role', 'Criar tenant exige papel founder.', false);
  }
  const created = await tenantsRepo.createWithAuditAtomic({
    tenant: { id: input.tenant_id, nome: input.nome ?? input.tenant_id, status: 'active' },
    // A FK de `admin_audit_log` aponta para `tenants`; usar o tenant recém
    // inserido é válido porque as duas escritas vivem na MESMA transação do
    // repo. No bootstrap global não existe outro tenant a que atribuir.
    audit: {
      tenant_id: input.tenant_id,
      actor_id: ctx.actor.user_id,
      actor_role: ctx.actor.role,
    },
  });
  if (!created.ok) {
    const existing = await tenantsRepo.findById(input.tenant_id);
    assertAdoptable(
      ctx,
      'tenant_duplicate',
      `Tenant '${input.tenant_id}' já existe. Escolha outro id ou use o modo "anexar".`,
    );
    if (!existing || existing.created_at.getTime() < ctx.run.created_at.getTime()) {
      // Existe, mas é ANTERIOR à run: não foi esta run que o criou, então não
      // é retomada — é colisão.
      throw new OnboardingError(
        'tenant_duplicate',
        `Tenant '${input.tenant_id}' já existe e não pertence a esta run.`,
      );
    }
    return {
      result: { tenant_id: existing.id, created: true, adopted: true },
      tenant_id: existing.id,
      metadata_patch: { tenant_nome: existing.nome },
      audit: {
        action: 'onboarding_tenant_created',
        resource_type: 'tenant',
        resource_id: existing.id,
        change_summary: {
          target_tenant_id: existing.id,
          onboarding_run_id: ctx.run.id,
          adopted_after_resume: true,
          reason: input.comment,
        },
      },
    };
  }
  return {
    result: { tenant_id: created.tenant.id, created: true },
    tenant_id: created.tenant.id,
    metadata_patch: { tenant_nome: created.tenant.nome },
    audit: {
      action: 'onboarding_tenant_created',
      resource_type: 'tenant',
      resource_id: created.tenant.id,
      change_summary: {
        target_tenant_id: created.tenant.id,
        onboarding_run_id: ctx.run.id,
        reason: input.comment,
      },
    },
  };
}

async function stepAdmin(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = AdminStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  // O bootstrap global cria o FOUNDER (é o único momento em que ele nasce);
  // qualquer outra run cria um OWNER restrito ao tenant alvo. É o requisito
  // "não cria novo founder global" convertido em regra de backend, não em
  // opção de formulário.
  const role = ctx.run.kind === 'global_bootstrap' ? 'founder' : 'owner';

  const existing = await appUsersRepo.getByEmail(tenantId, input.email);
  if (existing) {
    assertAdoptable(
      ctx,
      'admin_duplicate',
      'Já existe um usuário administrativo com este e-mail neste tenant.',
    );
    if (existing.role !== role) {
      throw new OnboardingError(
        'admin_duplicate',
        'Já existe um usuário com este e-mail neste tenant, com outro papel.',
      );
    }
    return adminOutcome(ctx, existing.id, role, input.email, input.comment, true);
  }

  const user = await appUsersRepo.create({
    id: randomUUID(),
    tenant_id: tenantId,
    email: input.email,
    name: input.name,
    role,
    // O IdP é a fonte de verdade da verificação; marcamos aqui para que o
    // primeiro sign-in não caia em AccessDenied (o resolver exige
    // `email_verified`). O acesso continua dependendo do IdP autenticar.
    email_verified: new Date(),
  });
  return adminOutcome(ctx, user.id, role, input.email, input.comment, false);
}

function adminOutcome(
  ctx: StepContext,
  appUserId: string,
  role: string,
  email: string,
  comment: string,
  adopted: boolean,
): StepOutcome {
  // O e-mail NÃO entra na trilha: `app_users.id` já resolve quem é, e o
  // domínio basta para a forense ("veio do IdP certo?"). Auditoria e evento
  // são append-only — o que entra ali nunca sai.
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return {
    result: { app_user_id: appUserId, role, adopted },
    audit: {
      action: 'bootstrap_initial_admin_created',
      resource_type: 'app_user',
      resource_id: appUserId,
      change_summary: {
        app_user_id: appUserId,
        role,
        email_domain: domain,
        onboarding_run_id: ctx.run.id,
        adopted_after_resume: adopted,
        reason: comment,
      },
    },
  };
}

/** Corpo mínimo e conservador do perfil semente. O operador refina depois. */
function seedProfileBody(roleDescriptor: string, createdBy: string): ProfileBody {
  return {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: roleDescriptor,
      voice: { tone: 'cordial e objetivo', formality: 'medium', verbosity: 'concise' },
      // Piso conservador: pouca inferência, nenhuma especulação, confiança
      // alta exigida para agir. Um agente recém-provisionado não deve ser
      // ousado — o operador afrouxa depois, com aprovação.
      cognitive_limits: {
        max_inference_depth: 2,
        max_speculation_in_response: 0,
        confidence_floor_for_action: 0.8,
      },
      priorities: ['clareza', 'segurança'],
      principles: [],
      learned_voice_modifiers: [],
    },
    style: { language: 'pt-BR', rhythm: {} },
    metadata: {
      effective_from: new Date().toISOString(),
      created_by: createdBy,
      previous_version_id: null,
    },
  };
}

async function stepAgent(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = AgentStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  // Arquétipo desconhecido NÃO é erro nem coringa: o agente nasce só com o
  // piso da plataforma (`BASE_AGENT_PACKS`). Fail-closed no sentido que
  // importa — menos privilégio, nunca mais.
  const archetype = input.archetype && isArchetypeId(input.archetype) ? input.archetype : null;
  const extraPacks = archetype ? [...ARCHETYPE_PACK_MAP[archetype]] : [];

  const created = await agentsRepo.createWithSeedAndAudit({
    agent: {
      id: input.agent_id,
      tenant_id: tenantId,
      nome: input.nome,
      // NASCE PAUSADO. É o coração do gate: a ativação é um comando explícito
      // do backend no fim da saga, nunca efeito colateral de criar o agente.
      // Com o default `active` do schema, um agente sem perfil, sem papel e
      // sem canal já nasceria "no ar".
      status: 'paused',
    },
    seed_profile: {
      profile_body: seedProfileBody(input.role_descriptor, ctx.actor.user_id),
      proposed_by: ctx.actor.user_id,
      proposed_reason: input.comment,
    },
    audit: { actor_id: ctx.actor.user_id, actor_role: ctx.actor.role },
    grant: { extra_packs: extraPacks, archetype },
  });

  if (!created.ok) {
    const existing = await agentsRepo.findById(input.agent_id);
    assertAdoptable(ctx, 'agent_duplicate', `Agente '${input.agent_id}' já existe.`);
    if (
      !existing ||
      existing.tenant_id !== tenantId ||
      existing.created_at.getTime() < ctx.run.created_at.getTime()
    ) {
      throw new OnboardingError(
        'agent_duplicate',
        `Agente '${input.agent_id}' já existe e não pertence a esta run.`,
      );
    }
    return {
      result: { agent_id: existing.id, adopted: true },
      agent_id: existing.id,
      metadata_patch: { agent_nome: existing.nome, archetype },
      audit: {
        action: 'onboarding_agent_created',
        resource_type: 'agent',
        resource_id: existing.id,
        change_summary: {
          agent_id: existing.id,
          onboarding_run_id: ctx.run.id,
          adopted_after_resume: true,
          reason: input.comment,
        },
      },
    };
  }

  return {
    result: {
      agent_id: created.agent.id,
      seed_profile_version_id: created.seed_profile.id,
      seed_profile_version: created.seed_profile.version,
    },
    agent_id: created.agent.id,
    metadata_patch: { agent_nome: created.agent.nome, archetype },
    audit: {
      action: 'onboarding_agent_created',
      resource_type: 'agent',
      resource_id: created.agent.id,
      change_summary: {
        agent_id: created.agent.id,
        onboarding_run_id: ctx.run.id,
        seed_profile_version_id: created.seed_profile.id,
        status: 'paused',
        archetype,
        reason: input.comment,
      },
    },
  };
}

async function stepProfile(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = ProfileStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  const agentId = ctx.run.agent_id!;

  const { active, proposed } = await runWithTenantContext(
    { tenant_id: tenantId, agent_id: agentId },
    async () => ({
      active: await operationalProfileVersionsRepo.getActive(),
      proposed: await operationalProfileVersionsRepo.listByStatus('proposed'),
    }),
  );

  // Já ativo: o passo é idempotente por natureza (o efeito desejado existe).
  if (active && (!input.profile_version_id || active.id === input.profile_version_id)) {
    return profileOutcome(ctx, active.id, active.version, input.comment, true);
  }

  const target = input.profile_version_id
    ? proposed.find((p) => p.id === input.profile_version_id)
    : proposed[0];
  if (!target) {
    throw new OnboardingError(
      'profile_not_found',
      'Nenhuma versão de perfil proposta para aprovar neste agente.',
    );
  }

  const result = await operationalProfileVersionsRepo.approveAndActivateAtomic({
    tenant_id: tenantId,
    agent_id: agentId,
    id: target.id,
    actor_id: ctx.actor.user_id,
    actor_role: ctx.actor.role,
    comment: input.comment,
  });
  if (!result.ok) {
    throw new OnboardingError(
      'profile_approval_failed',
      `Não foi possível aprovar o perfil (${result.reason}). Recarregue e tente de novo.`,
    );
  }
  return profileOutcome(ctx, result.activated.id, result.activated.version, input.comment, false);
}

function profileOutcome(
  ctx: StepContext,
  versionId: string,
  version: number,
  comment: string,
  alreadyActive: boolean,
): StepOutcome {
  return {
    result: { profile_version_id: versionId, profile_version: version, already_active: alreadyActive },
    audit: {
      action: 'onboarding_profile_activated',
      resource_type: 'agent_operational_profile_version',
      resource_id: versionId,
      change_summary: {
        agent_id: ctx.run.agent_id,
        onboarding_run_id: ctx.run.id,
        profile_version: version,
        already_active: alreadyActive,
        reason: comment,
      },
    },
  };
}

async function stepCapabilities(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = CapabilitiesStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  const agentId = ctx.run.agent_id!;

  // Determinístico: o piso da plataforma SEMPRE entra, os extras são
  // deduplicados e ordenados. Aplicar o mesmo pedido duas vezes produz
  // exatamente a mesma linha — é o "aplicação repetida de pack é
  // determinística" da issue, garantido pela forma do dado, não por um
  // if de idempotência.
  const packs = [...new Set([...BASE_AGENT_PACKS, ...input.extra_packs])].sort();

  const grant = await runWithTenantContext(
    { tenant_id: tenantId, agent_id: agentId },
    async () =>
      agentToolGrantsRepo.upsertForCurrentAgent({
        granted_packs: packs,
        granted_tools: [],
        denied_tools: [],
        granted_by: ctx.actor.user_id,
        reason: `onboarding run ${ctx.run.id}: ${input.comment}`,
      }),
  );

  return {
    result: { grant_id: grant.id, packs: packs.join(','), pack_count: packs.length },
    metadata_patch: { granted_packs: packs },
    audit: {
      action: 'onboarding_capabilities_applied',
      resource_type: 'agent_tool_grant',
      resource_id: grant.id,
      change_summary: {
        agent_id: agentId,
        onboarding_run_id: ctx.run.id,
        granted_packs: packs,
        reason: input.comment,
      },
    },
  };
}

async function stepRole(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = RoleStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  const agentId = ctx.run.agent_id!;

  const created = await rolesRepo.createWithAudit({
    tenant_id: tenantId,
    agent_id: agentId,
    role: {
      role_key: input.role_key,
      display_name: input.display_name,
      description: input.description,
      prompt_addendum: input.prompt_addendum,
      // O papel do wizard é, por definição, o papel PADRÃO: é ele que a
      // política do canal vai nomear.
      is_default: true,
    },
    audit: { actor_id: ctx.actor.user_id, actor_role: ctx.actor.role, reason: input.comment },
  });

  if (!created.ok) {
    // Papéis são escopados por (tenant, agent) — um `role_key` repetido aqui é
    // sempre do MESMO agente, então adotar é seguro mesmo fora da retomada.
    const existing = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: agentId },
      async () => rolesRepo.getByKey(input.role_key),
    );
    if (!existing) {
      throw new OnboardingError(
        'role_conflict',
        'Já existe outro papel padrão para este agente. Ajuste os papéis antes de continuar.',
      );
    }
    return roleOutcome(ctx, existing.id, existing.role_key, input.comment, true);
  }
  return roleOutcome(ctx, created.role.id, created.role.role_key, input.comment, false);
}

function roleOutcome(
  ctx: StepContext,
  roleId: string,
  roleKey: string,
  comment: string,
  adopted: boolean,
): StepOutcome {
  return {
    result: { role_id: roleId, role_key: roleKey, adopted },
    metadata_patch: { role_key: roleKey },
    audit: {
      action: 'onboarding_role_created',
      resource_type: 'role',
      resource_id: roleId,
      change_summary: {
        agent_id: ctx.run.agent_id,
        onboarding_run_id: ctx.run.id,
        role_key: roleKey,
        is_default: true,
        adopted_after_resume: adopted,
        reason: comment,
      },
    },
  };
}

/**
 * Declara a linha WhatsApp E amarra a política dela ao papel padrão.
 *
 * Os dois vivem no mesmo passo porque `channel_policies.channel_id` é FK: uma
 * política não pode existir antes do canal, e um canal sem política é
 * exatamente o "canal ativo sem governança" que a #518 fechou. O canal nasce
 * INATIVO (`channelsRepo.createWithAudit` força `active: false` para whatsapp):
 * digitar um número nunca dá posse.
 */
async function stepChannel(ctx: StepContext, raw: unknown): Promise<StepOutcome> {
  const input = ChannelStepSchema.parse(raw);
  const tenantId = ctx.run.tenant_id!;
  const agentId = ctx.run.agent_id!;

  const defaultRole = await runWithTenantContext(
    { tenant_id: tenantId, agent_id: agentId },
    async () => rolesRepo.getDefault(),
  );
  if (!defaultRole || !defaultRole.active) {
    throw new OnboardingError(
      'role_conflict',
      'O agente não tem papel padrão ativo — a política do canal precisa nomear um.',
    );
  }

  let channelId: string | null = null;
  let adopted = false;
  const created = await channelsRepo.createWithAudit({
    tenant_id: tenantId,
    agent_id: agentId,
    channel: {
      channel_type: 'whatsapp',
      external_id: input.external_id,
      display_name: input.display_name,
    },
    audit: { actor_id: ctx.actor.user_id, actor_role: ctx.actor.role, reason: input.comment },
  });
  if (created.ok) {
    channelId = created.channel.id;
  } else if (created.reason === 'invalid_line') {
    throw new OnboardingError(
      'channel_invalid_line',
      'A linha WhatsApp precisa estar em E.164 com "+" (ex.: +5511999999999).',
    );
  } else {
    // Duplicata: a UNIQUE é (tenant_id, channel_type, external_id). A linha
    // pode pertencer a OUTRO agente do mesmo tenant — nesse caso NÃO é
    // adoção, é conflito de posse.
    const lines = await channelLineStateRepo.listLinesForScope({
      tenant_id: tenantId,
      agent_id: agentId,
    });
    const match = lines.find(
      (l) => l.channel_type === 'whatsapp' && l.external_id === normalizeLine(input.external_id),
    );
    if (!match) {
      throw new OnboardingError(
        'channel_conflict',
        'Esta linha já está declarada para outro agente deste tenant.',
      );
    }
    channelId = match.channel_id;
    adopted = true;
  }

  const policy = await runWithTenantContext(
    { tenant_id: tenantId, agent_id: agentId },
    async () => {
      const current = await channelPoliciesRepo.getByChannelId(channelId!);
      if (current) {
        if (current.default_role_id === defaultRole.id) return current;
        return channelPoliciesRepo.update(current.id, {
          default_role_id: defaultRole.id,
          switch_behavior: input.switch_behavior,
        });
      }
      return channelPoliciesRepo.create({
        channel_id: channelId!,
        default_role_id: defaultRole.id,
        switch_behavior: input.switch_behavior,
      });
    },
  );

  return {
    result: { channel_id: channelId, channel_policy_id: policy.id, adopted },
    metadata_patch: { channel_id: channelId },
    audit: {
      action: 'onboarding_channel_declared',
      resource_type: 'channel',
      resource_id: channelId,
      change_summary: {
        agent_id: agentId,
        onboarding_run_id: ctx.run.id,
        channel_policy_id: policy.id,
        default_role_id: defaultRole.id,
        switch_behavior: input.switch_behavior,
        adopted_after_resume: adopted,
        reason: input.comment,
      },
    },
  };
}

/** Normalização E.164 mínima só para comparar com o que o repo gravou. */
function normalizeLine(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  return digits.length > 0 ? `+${digits}` : raw;
}

const LEDGER_STEPS: ReadonlySet<OnboardingStep> = new Set([
  'tenant',
  'admin',
  'agent',
  'profile',
  'capabilities',
  'role',
  'channel',
]);

const STEP_EFFECTS: Record<
  'tenant' | 'admin' | 'agent' | 'profile' | 'capabilities' | 'role' | 'channel',
  (ctx: StepContext, raw: unknown) => Promise<StepOutcome>
> = {
  tenant: stepTenant,
  admin: stepAdmin,
  agent: stepAgent,
  profile: stepProfile,
  capabilities: stepCapabilities,
  role: stepRole,
  channel: stepChannel,
};

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export async function startRun(
  actor: OnboardingActor,
  input: { tenant_id?: string | null; metadata?: Record<string, unknown> },
): Promise<RunView> {
  assertOperatorRole(actor);
  const open = async () =>
    onboardingRepo.createRun({
      kind: 'tenant_onboarding',
      actor_tenant_id: actor.tenant_id,
      tenant_id: input.tenant_id ?? null,
      created_by: actor.user_id,
      created_by_role: actor.role,
      configuration_contract_version: CONTRACT_VERSION,
      schema_version: CONTRACT_VERSION,
      metadata: input.metadata ?? {},
    });

  let created = await open();
  if (!created.ok) {
    // Sweep PREGUIÇOSO da expiração, em vez de um worker com timer: a única
    // consequência de uma run vencida não varrida é ocupar o índice parcial de
    // "uma run viva por (tenant, agente)", e é exatamente aqui que isso
    // aparece. Um worker novo teria de entrar na sequência de drain da #512
    // para ganhar o mesmo efeito. Comandos já recusam run vencida
    // (`run_expired`), então a expiração NÃO depende deste sweep para valer.
    await onboardingRepo.expireStaleRuns();
    created = await open();
  }
  if (!created.ok) {
    throw new OnboardingError(
      'step_out_of_order',
      'Já existe uma run de onboarding viva para este escopo. Retome-a em vez de abrir outra.',
    );
  }
  counter(METRIC.ONBOARDING_RUN_STARTED, { kind: 'tenant_onboarding' });
  return toView(created.run, null);
}

export async function getRun(actor: OnboardingActor, runId: string): Promise<RunView> {
  assertOperatorRole(actor);
  const run = assertRunVisible(
    await onboardingRepo.getForActor({
      id: runId,
      actor_tenant_id: actor.tenant_id,
      cross_tenant: actor.is_founder,
    }),
    actor,
  );
  return toView(run, await readinessForRun(run));
}

export async function listRuns(actor: OnboardingActor, includeTerminal = false): Promise<RunView[]> {
  assertOperatorRole(actor);
  const rows = await onboardingRepo.listForActor({
    actor_tenant_id: actor.tenant_id,
    cross_tenant: actor.is_founder,
    include_terminal: includeTerminal,
  });
  // Sem readiness na LISTAGEM: seriam N laudos completos por render. O laudo
  // vem no detalhe da run, que é onde a decisão acontece.
  return rows.map((r) => toView(r, null));
}

/**
 * Executa um passo mutável. É o coração do CLAIM → EFEITO → COMPLETE.
 */
export async function executeStep(
  actor: OnboardingActor,
  cmd: {
    run_id: string;
    step: OnboardingStep;
    expected_version: number;
    idempotency_key: string;
    payload: unknown;
  },
): Promise<RunView> {
  assertOperatorRole(actor);
  const run = assertRunVisible(
    await onboardingRepo.getForActor({
      id: cmd.run_id,
      actor_tenant_id: actor.tenant_id,
      cross_tenant: actor.is_founder,
    }),
    actor,
  );

  if (cmd.step === 'pairing') return stepPairing(actor, run, cmd);
  if (cmd.step === 'readiness') return stepReadiness(actor, run, cmd.expected_version);
  if (cmd.step === 'activation') return stepActivation(actor, run, cmd);

  if (!LEDGER_STEPS.has(cmd.step)) {
    throw new OnboardingError('step_out_of_order', `Passo '${cmd.step}' não é executável.`, false);
  }
  const effect = STEP_EFFECTS[cmd.step as keyof typeof STEP_EFFECTS];

  const started = Date.now();
  const claim = await onboardingRepo.claimStep({
    run_id: run.id,
    step: cmd.step,
    expected_version: cmd.expected_version,
    idempotency_key_hash: hashOpaque(cmd.idempotency_key),
    request_hash: hashPayload(cmd.payload),
    actor_id: actor.user_id,
    actor_role: actor.role,
  });

  if (!claim.ok) throw claimFailureToError(claim.reason);
  if (claim.outcome === 'replay') {
    counter(METRIC.ONBOARDING_IDEMPOTENCY_REPLAY, { step: cmd.step });
    const fresh = (await onboardingRepo.getById(run.id))!;
    return toView(fresh, await readinessForRun(fresh));
  }

  const ctx: StepContext = {
    run: claim.run,
    actor,
    resumed: claim.outcome === 'resumed',
  };

  let outcome: StepOutcome;
  try {
    outcome = await effect(ctx, cmd.payload);
  } catch (err) {
    const code = err instanceof OnboardingError ? err.code : 'internal_error';
    if (!(err instanceof OnboardingError)) {
      // Erro cru NUNCA vaza para o cliente nem para a trilha: log estruturado
      // com o correlation id, código sanitizado no resto do mundo.
      logger.error(
        { err, run_id: run.id, step: cmd.step, correlation_id: run.correlation_id },
        'onboarding.step_failed',
      );
    }
    await onboardingRepo.failStep({
      run_id: run.id,
      step: cmd.step,
      error_code: code,
      actor_id: actor.user_id,
      actor_role: actor.role,
      audit: {
        action: 'onboarding_step_denied',
        resource_type: 'onboarding_run',
        resource_id: run.id,
        change_summary: { step: cmd.step, error_code: code, agent_id: run.agent_id },
      },
    });
    counter(METRIC.ONBOARDING_STEP_FAILED, { step: cmd.step, reason: code });
    throw err instanceof OnboardingError
      ? err
      : new OnboardingError('internal_error', 'Falha interna ao executar o passo.');
  }

  const completed = await onboardingRepo.completeStep({
    run_id: run.id,
    step: cmd.step,
    // Numa retomada a versão já pode ter avançado; o CAS só é aplicado quando
    // esta requisição foi a que reivindicou.
    expected_version: claim.outcome === 'claimed' ? cmd.expected_version : null,
    to_state: claim.to_state,
    next_step: claim.next_step,
    actor_id: actor.user_id,
    actor_role: actor.role,
    result: outcome.result,
    tenant_id: outcome.tenant_id,
    agent_id: outcome.agent_id,
    metadata_patch: outcome.metadata_patch,
    audit: outcome.audit,
  });
  if (!completed.ok) throw claimFailureToError(completed.reason);

  counter(METRIC.ONBOARDING_STEP_COMPLETED, { step: cmd.step });
  histogram(METRIC.ONBOARDING_STEP_DURATION_MS, Date.now() - started, { step: cmd.step });

  return toView(completed.run, await readinessForRun(completed.run));
}

/**
 * Declara que a run está esperando o pareamento. O pareamento em si roda pelo
 * router da #518 (`channelLines.startPairing`), que já tem rate limit, gate de
 * keyring e a fila durável de comandos — este passo não o duplica.
 */
async function stepPairing(
  actor: OnboardingActor,
  run: OnboardingRunRow,
  cmd: { expected_version: number; payload: unknown },
): Promise<RunView> {
  const input = PairingStepSchema.parse(cmd.payload);
  const result = await onboardingRepo.transitionRun({
    run_id: run.id,
    step: 'pairing',
    expected_version: cmd.expected_version,
    actor_id: actor.user_id,
    actor_role: actor.role,
    summary: { awaiting: 'line_ownership' },
    audit: {
      action: 'onboarding_pairing_awaited',
      resource_type: 'onboarding_run',
      resource_id: run.id,
      change_summary: {
        agent_id: run.agent_id,
        channel_id: (run.metadata as Record<string, unknown>)?.channel_id ?? null,
        reason: input.comment,
      },
    },
  });
  if (!result.ok) throw claimFailureToError(result.reason);
  counter(METRIC.ONBOARDING_STEP_COMPLETED, { step: 'pairing' });
  return toView(result.run, await readinessForRun(result.run));
}

/**
 * Avalia o readiness canônico e move a run. Repetível de propósito: é o passo
 * do "erro corrigível" — o operador conserta a política e reavalia, sem abrir
 * run nova e sem perder o que já foi provisionado.
 */
async function stepReadiness(
  actor: OnboardingActor,
  run: OnboardingRunRow,
  expectedVersion: number,
): Promise<RunView> {
  if (!run.tenant_id || !run.agent_id) {
    throw new OnboardingError('scope_mismatch', 'A run ainda não tem tenant e agente resolvidos.');
  }
  const readiness = await evaluateAgentReadiness(run.tenant_id, run.agent_id);
  const blocking = blockingFailures(readiness);

  counter(METRIC.AGENT_READINESS_EVALUATED, {
    result: readiness.ready ? 'ready' : 'blocked',
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
  });
  for (const code of blocking) {
    counter(METRIC.AGENT_READINESS_FAILED, {
      check_code: code,
      tenant_id: run.tenant_id,
      agent_id: run.agent_id,
    });
  }

  const result = await onboardingRepo.transitionRun({
    run_id: run.id,
    step: 'readiness',
    expected_version: expectedVersion,
    actor_id: actor.user_id,
    actor_role: actor.role,
    ...(readiness.ready
      ? {}
      : {
          override_state: 'readiness_failed' as const,
          override_next_step: 'readiness' as const,
          event_type: 'denied' as const,
          error_code: 'readiness_blocked',
        }),
    summary: {
      ready: readiness.ready,
      blocking: blocking.join(','),
      configuration_fingerprint: readiness.configuration_fingerprint,
    },
    audit: {
      action: 'agent_readiness_evaluated',
      resource_type: 'agent',
      resource_id: run.agent_id,
      change_summary: {
        agent_id: run.agent_id,
        onboarding_run_id: run.id,
        ready: readiness.ready,
        blocking_checks: blocking,
        configuration_fingerprint: readiness.configuration_fingerprint,
        schema_fingerprint: readiness.schema_fingerprint,
      },
    },
  });
  if (!result.ok) throw claimFailureToError(result.reason);
  return toView(result.run, readiness);
}

/**
 * A ATIVAÇÃO. Três momentos, nesta ordem, e nenhum deles confia no anterior:
 *
 *   1. `beginActivation` marca a INTENÇÃO (`ready_for_activation` → `activating`)
 *      com CAS. É durável para que uma queda no meio seja diagnosticável — o
 *      runbook de rollback manda procurar exatamente por `activating`.
 *   2. o readiness é REAVALIADO. Um laudo lido há trinta segundos não prova
 *      nada agora: a política pode ter sido alterada, o papel desativado, a
 *      linha desabilitada.
 *   3. `finishActivation` faz a transição atômica — status do agente, run
 *      concluída, evento e auditoria com os fingerprints, tudo num commit.
 */
async function stepActivation(
  actor: OnboardingActor,
  run: OnboardingRunRow,
  cmd: { expected_version: number; payload: unknown },
): Promise<RunView> {
  const input = ActivationStepSchema.parse(cmd.payload);
  if (!run.tenant_id || !run.agent_id) {
    throw new OnboardingError('scope_mismatch', 'A run ainda não tem tenant e agente resolvidos.');
  }
  // O operador confirma o par que está vendo. Divergência = ele está olhando
  // outra tela; recusar é mais barato que ativar o agente errado.
  if (input.confirm_tenant_id !== run.tenant_id || input.confirm_agent_id !== run.agent_id) {
    throw new OnboardingError(
      'scope_mismatch',
      'O tenant/agente confirmado não corresponde ao da run. Recarregue a tela.',
    );
  }

  const begun = await onboardingRepo.beginActivation({
    run_id: run.id,
    expected_version: cmd.expected_version,
    actor_id: actor.user_id,
    actor_role: actor.role,
  });
  if (!begun.ok) {
    throw begun.reason === 'not_ready'
      ? new OnboardingError(
          'readiness_blocked',
          'A run não passou por uma avaliação de prontidão verde. Reavalie antes de ativar.',
        )
      : claimFailureToError(begun.reason);
  }

  const readiness = await evaluateAgentReadiness(run.tenant_id, run.agent_id);
  const blocking = blockingFailures(readiness);
  if (!readiness.ready) {
    for (const code of blocking) {
      counter(METRIC.AGENT_READINESS_FAILED, {
        check_code: code,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
      });
    }
    await onboardingRepo.abortActivation({
      run_id: run.id,
      actor_id: actor.user_id,
      actor_role: actor.role,
      error_code: 'readiness_blocked',
      blocking,
    });
    counter(METRIC.ONBOARDING_STEP_FAILED, { step: 'activation', reason: 'readiness_blocked' });
    throw new OnboardingError(
      'readiness_blocked',
      `A prontidão mudou desde a última avaliação: ${blocking.join(', ')}. Corrija e reavalie.`,
    );
  }

  const finished = await onboardingRepo.finishActivation({
    run_id: run.id,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    actor_id: actor.user_id,
    actor_role: actor.role,
    configuration_fingerprint: readiness.configuration_fingerprint,
    schema_fingerprint: readiness.schema_fingerprint,
    comment: input.comment,
  });
  if (!finished.ok) {
    counter(METRIC.ONBOARDING_STEP_FAILED, { step: 'activation', reason: finished.reason });
    throw new OnboardingError(
      'activation_race_lost',
      'Outra ativação concluiu esta run primeiro. Recarregue a tela.',
    );
  }

  counter(METRIC.ONBOARDING_STEP_COMPLETED, { step: 'activation' });
  counter(METRIC.ONBOARDING_RUN_COMPLETED, { kind: finished.run.kind });
  histogram(
    METRIC.ONBOARDING_RUN_DURATION_MS,
    finished.run.completed_at!.getTime() - finished.run.created_at.getTime(),
    { kind: finished.run.kind },
  );
  return toView(finished.run, readiness);
}

/**
 * Cancela a run. Compensações SEGURAS apenas:
 *   - o pareamento em curso é abortado (recurso efêmero, só desta run);
 *   - a credencial de bootstrap viva é revogada;
 *   - tenant, agente, papel e canal NÃO são apagados — são recursos que podem
 *     já estar em uso, e a issue proíbe compensação cega. O agente segue
 *     `paused`, que é o estado seguro: existe, é diagnosticável, não atende.
 * Auditoria e eventos permanecem, sempre.
 */
export async function cancelRun(
  actor: OnboardingActor,
  input: { run_id: string; expected_version: number; comment: string },
): Promise<RunView> {
  assertOperatorRole(actor);
  const run = assertRunVisible(
    await onboardingRepo.getForActor({
      id: input.run_id,
      actor_tenant_id: actor.tenant_id,
      cross_tenant: actor.is_founder,
    }),
    actor,
  );

  const channelId = (run.metadata as Record<string, unknown>)?.channel_id;
  if (typeof channelId === 'string' && run.tenant_id && run.agent_id) {
    // Encerra a sessão de pareamento — recurso EFÊMERO desta jornada. O
    // comando é idempotente na #518; falhar aqui não pode impedir o
    // cancelamento, então o erro é registrado e seguimos.
    try {
      await channelLineStateRepo.requestCommandWithAudit({
        scope: { tenant_id: run.tenant_id, agent_id: run.agent_id, channel_id: channelId },
        command: 'abort_pairing',
        command_id: randomUUID(),
        actor_id: actor.user_id,
        actor_role: actor.role,
        correlation_id: run.correlation_id,
        audit: {
          actor_id: actor.user_id,
          actor_role: actor.role,
          action: 'pairing_session_aborted',
          change_summary: {
            agent_id: run.agent_id,
            onboarding_run_id: run.id,
            reason: 'onboarding run cancelled',
          },
        },
      });
    } catch (err) {
      logger.warn(
        { err, run_id: run.id, correlation_id: run.correlation_id },
        'onboarding.cancel_pairing_abort_failed',
      );
    }
  }

  if (run.kind === 'global_bootstrap') {
    await bootstrapCredentialsRepo.revokeLive({ reason: `onboarding run ${run.id} cancelada` });
  }

  const cancelled = await onboardingRepo.cancelRun({
    run_id: run.id,
    expected_version: input.expected_version,
    actor_id: actor.user_id,
    actor_role: actor.role,
    reason: input.comment,
  });
  if (!cancelled.ok) throw claimFailureToError(cancelled.reason);
  counter(METRIC.ONBOARDING_RUN_CANCELLED, { reason: 'operator' });
  return toView(cancelled.run, null);
}

/**
 * BOOTSTRAP GLOBAL — o primeiro administrador, sem SQL.
 *
 * Só é permitido quando o sistema ainda não tem identidade administrativa
 * global: se já existe QUALQUER `app_users`, a porta está fechada. O segredo
 * de uso único é consumido por CAS antes de qualquer escrita, então duas
 * requisições simultâneas produzem no máximo um bootstrap.
 *
 * A rota que expõe isto NUNCA recebe o segredo por query string, e nada do
 * segredo entra em log, evento ou auditoria — só o resultado da tentativa.
 */
export async function bootstrapGlobal(
  cmd: BootstrapCommand,
  deps: {
    hasAnyAppUser: () => Promise<boolean>;
  },
): Promise<RunView> {
  const alreadyBootstrapped = await deps.hasAnyAppUser();
  if (alreadyBootstrapped) {
    counter(METRIC.BOOTSTRAP_ATTEMPT, { result: 'closed' });
    throw new OnboardingError(
      'bootstrap_not_allowed',
      'O sistema já possui identidade administrativa. O bootstrap global está definitivamente fechado.',
      false,
    );
  }

  const created = await onboardingRepo.createBootstrapRun({
    created_by: BOOTSTRAP_ACTOR.user_id,
    configuration_contract_version: CONTRACT_VERSION,
    schema_version: CONTRACT_VERSION,
    metadata: { tenant_id: cmd.tenant_id },
  });
  if (!created.ok) {
    counter(METRIC.BOOTSTRAP_ATTEMPT, { result: 'conflict' });
    throw new OnboardingError(
      'bootstrap_not_allowed',
      'Já existe um bootstrap global em andamento.',
      false,
    );
  }

  const consumed = await bootstrapCredentialsRepo.consume({
    secret_hash: hashOpaque(cmd.secret),
    run_id: created.run.id,
  });
  if (!consumed.ok) {
    // A run é encerrada para não travar o índice de "um bootstrap vivo".
    await onboardingRepo.cancelRun({
      run_id: created.run.id,
      expected_version: created.run.version,
      actor_id: BOOTSTRAP_ACTOR.user_id,
      actor_role: BOOTSTRAP_ACTOR.role,
      reason: `credencial de bootstrap recusada (${consumed.reason})`,
    });
    counter(METRIC.BOOTSTRAP_ATTEMPT, { result: consumed.reason });
    throw new OnboardingError(
      consumed.reason === 'locked' ? 'bootstrap_credential_locked' : 'bootstrap_credential_invalid',
      consumed.reason === 'locked'
        ? 'Credencial de bootstrap bloqueada por excesso de tentativas. Emita outra.'
        : 'Credencial de bootstrap inválida, expirada ou já consumida.',
      false,
    );
  }

  counter(METRIC.ONBOARDING_RUN_STARTED, { kind: 'global_bootstrap' });
  counter(METRIC.BOOTSTRAP_ATTEMPT, { result: 'ok' });

  // Os dois primeiros passos rodam pela MESMA máquina de estados dos demais —
  // não existe um caminho paralelo "de bootstrap" com regras próprias.
  let view = await executeStep(BOOTSTRAP_ACTOR, {
    run_id: created.run.id,
    step: 'tenant',
    expected_version: created.run.version,
    idempotency_key: `bootstrap-tenant-${created.run.id}`,
    payload: {
      mode: 'create',
      tenant_id: cmd.tenant_id,
      nome: cmd.tenant_nome,
      comment: 'Bootstrap global: primeiro tenant da instalação.',
    },
  });
  view = await executeStep(BOOTSTRAP_ACTOR, {
    run_id: created.run.id,
    step: 'admin',
    expected_version: view.version,
    idempotency_key: `bootstrap-admin-${created.run.id}`,
    payload: {
      email: cmd.admin_email,
      name: cmd.admin_name,
      comment: 'Bootstrap global: primeiro administrador da instalação.',
    },
  });
  return view;
}

// ---------------------------------------------------------------------------

function claimFailureToError(reason: string): OnboardingError {
  switch (reason) {
    case 'run_not_found':
      return new OnboardingError('run_not_found', 'Run de onboarding não encontrada.', false);
    case 'run_terminal':
      return new OnboardingError('run_terminal', 'A run já terminou e não aceita comandos.', false);
    case 'run_expired':
      return new OnboardingError(
        'run_expired',
        'A run expirou. Abra uma nova — o que já foi provisionado permanece.',
        false,
      );
    case 'version_conflict':
      return new OnboardingError(
        'version_conflict',
        'A run mudou desde que esta tela foi carregada. Recarregue e repita.',
      );
    case 'claim_in_progress':
      return new OnboardingError(
        'version_conflict',
        'Outra tentativa deste passo está em andamento. Aguarde e recarregue.',
      );
    case 'claim_lost':
      return new OnboardingError(
        'version_conflict',
        'A reivindicação deste passo foi perdida. Recarregue e repita.',
      );
    case 'idempotency_payload_mismatch':
      return new OnboardingError(
        'idempotency_payload_mismatch',
        'A mesma chave de idempotência foi usada com outro conteúdo. Gere uma chave nova.',
        false,
      );
    case 'step_out_of_order':
      return new OnboardingError(
        'step_out_of_order',
        'Este passo não pode ser executado agora. Recarregue e siga a etapa corrente.',
      );
    case 'kind_not_allowed':
      return new OnboardingError('kind_not_allowed', 'Passo indisponível para este tipo de run.', false);
    default:
      return new OnboardingError('internal_error', 'Falha interna na saga de onboarding.');
  }
}

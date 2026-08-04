/**
 * Issue #519 — as ESCRITAS de provisionamento de cada passo, todas recebendo o
 * `tx` da transação curta aberta por `onboardingRunsRepo.commitStep`.
 *
 * Por que aqui e não nos repos existentes: os repos tenant-scoped
 * (`channelsRepo`, `rolesRepo`, `operationalProfileVersionsRepo`, …) leem o
 * escopo do AsyncLocalStorage e escrevem com o handle global `db`. Nenhum dos
 * dois serve à saga:
 *   - o escopo do wizard é o ALVO do provisionamento, que ainda não existe
 *     quando o passo começa (não há como "entrar" no contexto de um tenant que
 *     este mesmo passo vai criar);
 *   - a escrita PRECISA acontecer no `tx` do passo, senão a garantia
 *     tudo-ou-nada de `commitStep` some.
 * Por isso cada passo recebe `tx` e carimba `(tenant_id, agent_id)`
 * LITERALMENTE, vindos do payload já validado pelo guard de escopo.
 *
 * Todo payload é validado por Zod ANTES de qualquer escrita — "backend decide"
 * (invariante 3): a UI propõe o payload, o backend recusa o que não couber no
 * contrato.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { pgErrorCode } from '@/db/client.js';
import {
  agent_operational_profile_versions,
  agent_tool_grants,
  agents,
  app_users,
  channel_line_state,
  channel_policies,
  channels,
  roles,
  tenants,
} from '@/db/schema.js';
import { normalizeWhatsappLine } from '@/db/repositories/channel-repos.js';
import type { StepApplication } from '@/db/repositories/onboarding-repos.js';
import type { OnboardingRunRow } from '@/db/schema.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import { OnboardingError } from './errors.js';
import { assertProvisioningScope, assertTenantScope } from './scope.js';
import type { OnboardingStep } from './state-machine.js';

type Tx = Parameters<
  Parameters<typeof import('@/db/client.js').withTx>[0]
>[0];

// ── Contratos de payload ─────────────────────────────────────────────────────

const scopeId = z.string().min(2).max(64);

export const STEP_PAYLOAD_SCHEMAS = {
  provision_tenant: z.object({
    tenant_id: scopeId,
    nome: z.string().min(1).max(200),
  }),
  provision_admin: z.object({
    // `app_users` é gerido pelo NextAuth: não há credencial aqui. O admin do
    // tenant é criado com papel restrito ao tenant recém-criado — nunca
    // `founder`, que é global (§1 da issue: "não cria novo founder global").
    user_id: z.string().min(3).max(128),
    email: z.string().email(),
    name: z.string().min(1).max(200).optional(),
    role: z.enum(['owner', 'compliance_officer', 'analyst', 'viewer']).default('owner'),
  }),
  provision_agent: z.object({
    agent_id: scopeId,
    nome: z.string().min(1).max(200),
  }),
  configure_profile: z.object({
    // A saga aprova e ativa a versão SEMENTE criada junto com o agente. O
    // corpo do profile continua governado pelo fluxo de proposta/aprovação —
    // aqui só existe a aprovação explícita do operador.
    approve: z.literal(true),
    reason: z.string().max(500).optional(),
  }),
  apply_capability_packs: z.object({
    // Packs de DOMÍNIO adicionais. O piso (`BASE_AGENT_PACKS`) é sempre unido,
    // então a aplicação é determinística e idempotente por construção.
    granted_packs: z.array(z.string().min(1).max(64)).max(50).default([]),
    denied_tools: z.array(z.string().min(1).max(64)).max(200).default([]),
    reason: z.string().max(500).optional(),
  }),
  configure_role: z.object({
    role_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    display_name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    granted_packs: z.array(z.string().min(1).max(64)).max(50).default([]),
  }),
  declare_channel: z.object({
    channel_type: z.literal('whatsapp'),
    /** Linha E.164 com `+`. NÃO é persistida em metadata/summary/result. */
    external_id: z.string().min(8).max(24),
    display_name: z.string().max(200).optional(),
    switch_behavior: z.enum(['fixed', 'by_context', 'by_command']).default('fixed'),
  }),
  start_pairing: z.object({
    channel_id: z.string().uuid(),
    method: z.enum(['qr', 'code']).default('qr'),
  }),
  confirm_channel_ready: z.object({
    channel_id: z.string().uuid(),
  }),
  evaluate_readiness: z.object({}).default({}),
  activate: z.object({
    /**
     * O operador confirma o par EXATO que está ativando. Se divergir do escopo
     * da run, a ativação é recusada — é a defesa contra ativar o agente errado
     * a partir de uma aba antiga do console (§7 da issue).
     */
    confirm_tenant_id: scopeId,
    confirm_agent_id: scopeId,
  }),
} as const satisfies Record<OnboardingStep, z.ZodTypeAny>;

export type StepPayload<S extends OnboardingStep> = z.infer<(typeof STEP_PAYLOAD_SCHEMAS)[S]>;

export function parseStepPayload<S extends OnboardingStep>(step: S, raw: unknown): StepPayload<S> {
  const schema = STEP_PAYLOAD_SCHEMAS[step];
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new OnboardingError('invalid_scope', `payload inválido para o passo '${step}'`, {
      step,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
  }
  return parsed.data as StepPayload<S>;
}

// ── Escritas ─────────────────────────────────────────────────────────────────

function requireTenant(run: OnboardingRunRow): string {
  if (!run.tenant_id) {
    throw new OnboardingError('scope_mismatch', 'run ainda não tem tenant resolvido');
  }
  assertTenantScope(run.tenant_id);
  return run.tenant_id;
}

function requireScope(run: OnboardingRunRow): { tenant_id: string; agent_id: string } {
  const scope = { tenant_id: run.tenant_id, agent_id: run.agent_id };
  assertProvisioningScope(scope);
  return scope;
}

export async function applyProvisionTenant(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'provision_tenant'>,
): Promise<StepApplication> {
  assertTenantScope(payload.tenant_id);
  if (run.tenant_id && run.tenant_id !== payload.tenant_id) {
    throw new OnboardingError(
      'scope_mismatch',
      'a run já está vinculada a outro tenant',
      { run_tenant: run.tenant_id },
    );
  }

  // ON CONFLICT DO NOTHING + SELECT: reexecutar o passo com uma chave nova
  // depois de um crash não pode explodir com 23505. A máquina de estados já
  // impede o avanço duplicado; aqui garantimos que a ESCRITA em si seja
  // convergente.
  await tx
    .insert(tenants)
    .values({ id: payload.tenant_id, nome: payload.nome, status: 'active' })
    .onConflictDoNothing();

  const rows = await tx.select().from(tenants).where(eq(tenants.id, payload.tenant_id)).limit(1);
  const tenant = rows[0];
  if (!tenant) {
    throw new OnboardingError('tenant_not_found', 'tenant não encontrado após o INSERT');
  }

  return {
    result: { tenant_id: tenant.id, status: tenant.status },
    scope_patch: { tenant_id: tenant.id },
    summary: { tenant_id: tenant.id },
    audit: { action: 'onboarding_tenant_provisioned', resource_type: 'tenant', resource_id: tenant.id },
  };
}

export async function applyProvisionAdmin(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'provision_admin'>,
): Promise<StepApplication> {
  const tenant_id = requireTenant(run);

  await tx
    .insert(app_users)
    .values({
      id: payload.user_id,
      tenant_id,
      email: payload.email,
      name: payload.name ?? null,
      role: payload.role,
    })
    .onConflictDoNothing();

  const rows = await tx
    .select()
    .from(app_users)
    .where(and(eq(app_users.tenant_id, tenant_id), eq(app_users.email, payload.email)))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new OnboardingError(
      'duplicate_agent',
      'usuário administrativo não encontrado após o INSERT (id em uso por outro tenant?)',
    );
  }

  // `email` NUNCA entra em result/summary — a denylist de `sanitize.ts` já o
  // redigiria, mas não o mandamos de todo modo.
  return {
    result: { user_id: user.id, role: user.role },
    summary: { user_id: user.id, role: user.role },
    audit: { action: 'onboarding_admin_provisioned', resource_type: 'app_user', resource_id: user.id },
  };
}

export async function applyProvisionAgent(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'provision_agent'>,
): Promise<StepApplication> {
  const tenant_id = requireTenant(run);
  assertProvisioningScope({ tenant_id, agent_id: payload.agent_id });

  await tx
    .insert(agents)
    .values({
      id: payload.agent_id,
      tenant_id,
      nome: payload.nome,
      // NASCE INATIVO. A ativação é um comando explícito no fim da saga, com
      // readiness reavaliado — nunca um efeito colateral da criação.
      status: 'provisioning',
    })
    .onConflictDoNothing();

  const agentRows = await tx.select().from(agents).where(eq(agents.id, payload.agent_id)).limit(1);
  const agent = agentRows[0];
  if (!agent) {
    throw new OnboardingError('agent_not_found', 'agente não encontrado após o INSERT');
  }
  if (agent.tenant_id !== tenant_id) {
    // O id do agente é PK GLOBAL: colidir com o agente de outro tenant não pode
    // virar "reaproveitar o agente alheio".
    throw new OnboardingError(
      'duplicate_agent',
      'o id de agente informado já pertence a outro tenant',
      { agent_id: payload.agent_id },
    );
  }

  // Versão SEMENTE do profile operacional (v1, `proposed`) — mesmo contrato de
  // `agentsRepo.createWithSeedAndAudit`: nenhum profile nasce ativo.
  await tx
    .insert(agent_operational_profile_versions)
    .values({
      tenant_id,
      agent_id: agent.id,
      version: 1,
      status: 'proposed',
      profile_body: {},
      proposed_by: 'onboarding_wizard',
      proposed_reason: `run ${run.id}`,
    })
    .onConflictDoNothing();

  // Piso de capacidades: um agente sem linha em `agent_tool_grants` cai no
  // fail-closed do runtime.
  await tx
    .insert(agent_tool_grants)
    .values({
      tenant_id,
      agent_id: agent.id,
      granted_packs: [...BASE_AGENT_PACKS],
      granted_tools: [],
      denied_tools: [],
      granted_by: 'onboarding_wizard',
      reason: `run ${run.id}`,
    })
    .onConflictDoNothing();

  return {
    result: { agent_id: agent.id, status: agent.status, seed_profile_version: 1 },
    scope_patch: { agent_id: agent.id },
    summary: { agent_id: agent.id },
    audit: { action: 'onboarding_agent_provisioned', resource_type: 'agent', resource_id: agent.id },
  };
}

export async function applyConfigureProfile(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'configure_profile'>,
  actor_id: string,
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);
  const now = new Date();

  // Aprova E ativa a semente, escopado. O `WHERE status='proposed'` torna a
  // escrita convergente: reexecutar não reaprova nem duplica.
  const activated = await tx
    .update(agent_operational_profile_versions)
    .set({
      status: 'active',
      approved_by: actor_id,
      approved_at: now,
      activated_at: now,
    })
    .where(
      and(
        eq(agent_operational_profile_versions.tenant_id, tenant_id),
        eq(agent_operational_profile_versions.agent_id, agent_id),
        eq(agent_operational_profile_versions.version, 1),
        eq(agent_operational_profile_versions.status, 'proposed'),
      ),
    )
    .returning();

  const current = await tx
    .select()
    .from(agent_operational_profile_versions)
    .where(
      and(
        eq(agent_operational_profile_versions.tenant_id, tenant_id),
        eq(agent_operational_profile_versions.agent_id, agent_id),
        eq(agent_operational_profile_versions.status, 'active'),
      ),
    )
    .limit(1);
  if (!current[0]) {
    return {
      result: {},
      deny: {
        code: 'activation_precondition_failed',
        message: 'nenhuma versão de profile ficou ativa para este agente',
      },
      audit: {
        action: 'onboarding_profile_activated',
        resource_type: 'agent_operational_profile_version',
        resource_id: null,
      },
    };
  }

  return {
    result: {
      profile_version_id: current[0].id,
      version: current[0].version,
      newly_activated: activated.length > 0,
    },
    summary: { version: current[0].version },
    audit: {
      action: 'onboarding_profile_activated',
      resource_type: 'agent_operational_profile_version',
      resource_id: current[0].id,
    },
  };
}

export async function applyCapabilityPacks(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'apply_capability_packs'>,
  actor_id: string,
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);

  // DETERMINÍSTICO: união com o piso, deduplicado e ORDENADO. Aplicar o mesmo
  // pack duas vezes produz exatamente a mesma linha — é o que a issue exige de
  // "aplicação repetida de pack é determinística".
  const packs = [...new Set([...BASE_AGENT_PACKS, ...payload.granted_packs])].sort();
  const denied = [...new Set(payload.denied_tools)].sort();

  await tx
    .insert(agent_tool_grants)
    .values({
      tenant_id,
      agent_id,
      granted_packs: packs,
      granted_tools: [],
      denied_tools: denied,
      granted_by: actor_id,
      reason: payload.reason ?? `run ${run.id}`,
    })
    .onConflictDoUpdate({
      target: [agent_tool_grants.tenant_id, agent_tool_grants.agent_id],
      set: {
        granted_packs: packs,
        denied_tools: denied,
        granted_by: actor_id,
        reason: payload.reason ?? `run ${run.id}`,
        updated_at: new Date(),
      },
    });

  return {
    result: { granted_packs: packs, denied_tools: denied },
    summary: { pack_count: packs.length },
    audit: { action: 'onboarding_packs_applied', resource_type: 'agent_tool_grants', resource_id: agent_id },
  };
}

export async function applyConfigureRole(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'configure_role'>,
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);

  // Exatamente UM papel default ativo (o check `default_role_resolved` do
  // readiness). Rebaixar os demais ANTES de inserir mantém o invariante mesmo
  // quando a saga é reexecutada com outro `role_key`.
  await tx
    .update(roles)
    .set({ is_default: false, updated_at: new Date() })
    .where(and(eq(roles.tenant_id, tenant_id), eq(roles.agent_id, agent_id), eq(roles.is_default, true)));

  await tx
    .insert(roles)
    .values({
      tenant_id,
      agent_id,
      role_key: payload.role_key,
      display_name: payload.display_name,
      description: payload.description ?? null,
      granted_packs: [...new Set(payload.granted_packs)].sort(),
      active: true,
      is_default: true,
    })
    .onConflictDoUpdate({
      target: [roles.tenant_id, roles.agent_id, roles.role_key],
      set: {
        display_name: payload.display_name,
        description: payload.description ?? null,
        granted_packs: [...new Set(payload.granted_packs)].sort(),
        active: true,
        is_default: true,
        updated_at: new Date(),
      },
    });

  const rows = await tx
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.tenant_id, tenant_id),
        eq(roles.agent_id, agent_id),
        eq(roles.role_key, payload.role_key),
      ),
    )
    .limit(1);
  const role = rows[0];
  if (!role) throw new OnboardingError('role_not_found', 'papel não encontrado após o upsert');

  return {
    result: { role_id: role.id, role_key: role.role_key },
    summary: { role_key: role.role_key },
    audit: { action: 'onboarding_role_configured', resource_type: 'role', resource_id: role.id },
  };
}

export async function applyDeclareChannel(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'declare_channel'>,
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);

  const external_id = normalizeWhatsappLine(payload.external_id);
  if (!external_id) {
    throw new OnboardingError(
      'invalid_scope',
      "external_id de linha whatsapp precisa ser E.164 com '+'",
    );
  }

  const defaultRole = await tx
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.tenant_id, tenant_id),
        eq(roles.agent_id, agent_id),
        eq(roles.is_default, true),
        eq(roles.active, true),
      ),
    )
    .limit(1);
  if (!defaultRole[0]) {
    return {
      result: {},
      deny: {
        code: 'role_not_found',
        message: 'o agente não tem papel padrão ativo — rode `configure_role` antes',
      },
      audit: { action: 'onboarding_channel_declared', resource_type: 'channel', resource_id: null },
    };
  }

  // O canal nasce INATIVO (`active=false`): "declarado" não é "roteando".
  // Ele só passa a rotear na ativação final, depois de readiness aprovado.
  try {
    await tx
      .insert(channels)
      .values({
        tenant_id,
        agent_id,
        external_id,
        channel_type: 'whatsapp',
        display_name: payload.display_name ?? null,
        active: false,
      })
      .onConflictDoNothing();
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new OnboardingError('duplicate_channel', 'a linha já está declarada em outro escopo');
    }
    throw err;
  }

  const channelRows = await tx
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.tenant_id, tenant_id),
        eq(channels.agent_id, agent_id),
        eq(channels.channel_type, 'whatsapp'),
        eq(channels.external_id, external_id),
      ),
    )
    .limit(1);
  const channel = channelRows[0];
  if (!channel) {
    // O unique é (tenant, type, external_id): a linha existe no tenant mas sob
    // OUTRO agente. Recusar é obrigatório — herdar a linha alheia é o cruzamento
    // de escopo que o readiness existe para impedir.
    throw new OnboardingError(
      'duplicate_channel',
      'a linha já está declarada neste tenant sob outro agente',
    );
  }

  // Estado operacional inicial de #518.
  await tx
    .insert(channel_line_state)
    .values({ channel_id: channel.id, tenant_id, agent_id, state: 'declared' })
    .onConflictDoNothing();

  // A `channel_policy` é materializada AQUI (e não no passo `configure_role`)
  // porque `channel_policies.channel_id` é NOT NULL — a política não pode
  // existir antes do canal. Ver a nota de desvio em `state-machine.ts`.
  await tx
    .insert(channel_policies)
    .values({
      tenant_id,
      agent_id,
      channel_id: channel.id,
      default_role_id: defaultRole[0].id,
      switch_behavior: payload.switch_behavior,
    })
    .onConflictDoUpdate({
      target: channel_policies.channel_id,
      set: {
        default_role_id: defaultRole[0].id,
        switch_behavior: payload.switch_behavior,
        updated_at: new Date(),
      },
    });

  // `external_id` (o telefone) NÃO entra em result/summary.
  return {
    result: { channel_id: channel.id, channel_type: channel.channel_type, active: channel.active },
    summary: { channel_id: channel.id },
    audit: { action: 'onboarding_channel_declared', resource_type: 'channel', resource_id: channel.id },
  };
}

/**
 * Confirma que a linha PROVOU posse, lendo o estado operacional de #518.
 * Puramente observacional — não escreve nada.
 */
export async function applyConfirmChannelReady(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'confirm_channel_ready'>,
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);

  const rows = await tx
    .select({ state: channel_line_state.state })
    .from(channel_line_state)
    .where(
      and(
        eq(channel_line_state.tenant_id, tenant_id),
        eq(channel_line_state.agent_id, agent_id),
        eq(channel_line_state.channel_id, payload.channel_id),
      ),
    )
    .limit(1);
  const state = rows[0]?.state ?? null;

  if (state === null) {
    return {
      result: {},
      deny: { code: 'channel_not_found', message: 'linha não encontrada neste (tenant, agente)' },
      audit: { action: 'onboarding_channel_confirmed', resource_type: 'channel', resource_id: null },
    };
  }
  if (state !== 'connected' && state !== 'verified_offline') {
    return {
      result: { line_state: state },
      deny: {
        code: 'channel_not_paired',
        message: `linha em '${state}' — posse ainda não provada`,
      },
      audit: {
        action: 'onboarding_channel_confirmed',
        resource_type: 'channel',
        resource_id: payload.channel_id,
      },
    };
  }

  return {
    result: { channel_id: payload.channel_id, line_state: state },
    summary: { line_state: state },
    audit: {
      action: 'onboarding_channel_confirmed',
      resource_type: 'channel',
      resource_id: payload.channel_id,
    },
  };
}

/**
 * Ativação: liga o agente E as linhas governadas, no mesmo `tx` da transição
 * da run. O readiness já foi reavaliado pelo wizard imediatamente antes, sob a
 * trava da run.
 */
export async function applyActivate(
  tx: Tx,
  run: OnboardingRunRow,
  fingerprints: { configuration_fingerprint: string; schema_fingerprint: string },
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);

  await tx
    .update(agents)
    .set({ status: 'active', updated_at: new Date() })
    .where(and(eq(agents.id, agent_id), eq(agents.tenant_id, tenant_id)));

  // Só as linhas GOVERNADAS (com política do mesmo escopo) passam a rotear.
  const activatedChannels = await tx
    .update(channels)
    .set({ active: true, updated_at: new Date() })
    .where(
      and(
        eq(channels.tenant_id, tenant_id),
        eq(channels.agent_id, agent_id),
        eq(channels.is_synthetic, false),
        sql`EXISTS (
          SELECT 1 FROM channel_policies cp
           WHERE cp.channel_id = ${channels.id}
             AND cp.tenant_id = ${tenant_id}
             AND cp.agent_id = ${agent_id}
        )`,
      ),
    )
    .returning({ id: channels.id });

  return {
    result: {
      agent_id,
      activated_channels: activatedChannels.length,
      configuration_fingerprint: fingerprints.configuration_fingerprint,
      schema_fingerprint: fingerprints.schema_fingerprint,
    },
    summary: {
      activated_channels: activatedChannels.length,
      configuration_fingerprint: fingerprints.configuration_fingerprint,
    },
    completes: true,
    audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: agent_id },
  };
}

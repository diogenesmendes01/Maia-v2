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
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { pgErrorCode } from '@/db/client.js';
import {
  admin_audit_log,
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
// O vocabulário de "posse provada" é do readiness — a ativação NÃO tem um
// paralelo. Importar a constante (em vez de repetir os literais) é o que faz a
// re-derivação da ativação e o avaliador puro concordarem por construção.
import { OWNERSHIP_PROVEN_LINE_STATES } from './readiness.js';
import { assertProvisioningScope, assertTenantScope } from './scope.js';
import type { OnboardingStep } from './state-machine.js';

type Tx = Parameters<
  Parameters<typeof import('@/db/client.js').withTx>[0]
>[0];

// ── Vocabulário de enum/status que a saga ESCREVE ────────────────────────────
//
// Cada coluna abaixo tem um `CHECK (col IN (…))` em `migrations/`. Um literal
// aqui que o CHECK não admita é um 23514 que NENHUM teste com store falso
// enxerga — foi assim que `agents.status='provisioning'` e
// `channel_policies.switch_behavior='fixed'` chegaram ao CI.
//
// Por isso os literais moram em constantes NOMEADAS, são usados nas escritas, e
// `SAGA_ENUM_WRITES` os expõe agrupados por `tabela.coluna`. É contra esse mapa
// que `tests/unit/onboarding/schema-constraint-compatibility.spec.ts` confronta
// os CHECKs lidos de `migrations/*.sql` — sem banco, em segundos.

/** Status do tenant que `provision_tenant` cria. */
export const TENANT_STATUS_ACTIVE = 'active';

/**
 * O agente NASCE aqui: existe, mas não é operável. Ver
 * `migrations/110_agents_status_provisioning.sql` para por que não é `paused`.
 */
export const AGENT_STATUS_PROVISIONING = 'provisioning';
/** E só chega aqui pelo comando explícito `activate`. */
export const AGENT_STATUS_ACTIVE = 'active';

/** A versão SEMENTE do profile nasce proposta — nenhum profile nasce ativo. */
export const PROFILE_STATUS_SEED = 'proposed';
/** E é ativada pelo passo `configure_profile`, com aprovação do operador. */
export const PROFILE_STATUS_ACTIVE = 'active';

/** Único tipo de canal desta fatia. */
export const CHANNEL_TYPE_WHATSAPP = 'whatsapp';

/** Estado operacional inicial da linha (#518): declarada, não pareada. */
export const CHANNEL_LINE_STATE_INITIAL = 'declared';

/**
 * Papéis administrativos que `provision_admin` pode conceder. `founder` está
 * FORA de propósito: é global, e a saga não cria founder novo (§1 da issue).
 */
export const ADMIN_ROLES = ['owner', 'compliance_officer', 'analyst', 'viewer'] as const;

/**
 * Vocabulário de `channel_policies.switch_behavior`. São EXATAMENTE os valores
 * do CHECK de `migrations/033_p6_channel_policies.sql:10` e do enum
 * `SwitchBehavior` (`src/types/enums.ts:197`) — a saga não inventa um
 * vocabulário paralelo para uma coluna que outro módulo interpreta
 * (`src/cognition/role-selector/policy-decider.ts`).
 */
export const SWITCH_BEHAVIORS = [
  'locked',
  'prefer_handoff',
  'free_with_trigger',
  'by_context',
] as const;

/** Fail-closed: o canal recém-declarado fica preso ao seu único papel padrão. */
export const SWITCH_BEHAVIOR_DEFAULT = 'locked';

/** Mapa `tabela.coluna` → literais que a saga pode escrever naquela coluna. */
export const SAGA_ENUM_WRITES = {
  'tenants.status': [TENANT_STATUS_ACTIVE],
  'agents.status': [AGENT_STATUS_PROVISIONING, AGENT_STATUS_ACTIVE],
  'app_users.role': [...ADMIN_ROLES],
  'agent_operational_profile_versions.status': [PROFILE_STATUS_SEED, PROFILE_STATUS_ACTIVE],
  'channels.channel_type': [CHANNEL_TYPE_WHATSAPP],
  'channel_line_state.state': [CHANNEL_LINE_STATE_INITIAL],
  'channel_policies.switch_behavior': [...SWITCH_BEHAVIORS],
} as const satisfies Record<string, readonly string[]>;

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
    role: z.enum(ADMIN_ROLES).default('owner'),
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
    channel_type: z.literal(CHANNEL_TYPE_WHATSAPP),
    /** Linha E.164 com `+`. NÃO é persistida em metadata/summary/result. */
    external_id: z.string().min(8).max(24),
    display_name: z.string().max(200).optional(),
    /**
     * VOCABULÁRIO DA PLATAFORMA, não um paralelo. Os valores são exatamente os
     * do CHECK de `channel_policies.switch_behavior`
     * (`migrations/033_p6_channel_policies.sql:10`) e do enum `SwitchBehavior`
     * (`src/types/enums.ts:197`), porque é esta coluna que o payload alimenta e
     * é `src/cognition/role-selector/policy-decider.ts` que o interpreta.
     *
     * O default é `locked` — fail-closed: um agente recém-provisionado tem
     * exatamente UM papel padrão (invariante do check `default_role_resolved`),
     * então o canal nasce preso a ele. Trocar de papel por contexto é uma
     * decisão de governança posterior, tomada no console, não um efeito
     * colateral do onboarding.
     */
    switch_behavior: z.enum(SWITCH_BEHAVIORS).default(SWITCH_BEHAVIOR_DEFAULT),
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
    .values({ id: payload.tenant_id, nome: payload.nome, status: TENANT_STATUS_ACTIVE })
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
  const ehBootstrap = run.kind === 'global_bootstrap';

  // O PAPEL do primeiro administrador é decidido pelo BACKEND, não proposto
  // pelo chamador.
  //
  // `ADMIN_ROLES` exclui `founder` DE PROPÓSITO: é essa exclusão que impede o
  // onboarding de um tenant qualquer de cunhar uma identidade administrativa
  // GLOBAL. O banco aceita o papel (CHECK da migration 045); quem o proíbe é
  // o vocabulário do payload.
  //
  // No bootstrap a necessidade é a oposta: sem um founder, o sistema fica sem
  // identidade global e a pré-condição do próprio bootstrap ("não existe
  // identidade administrativa global") continuaria verdadeira para sempre —
  // seria possível emitir credencial de novo, indefinidamente.
  //
  // A saída é FORÇAR aqui, em vez de admitir `founder` no enum. Assim o
  // onboarding de tenant continua incapaz de produzi-lo por construção, e o
  // bootstrap sempre o produz sem depender do que o chamador mandou.
  const papel = ehBootstrap ? 'founder' : payload.role;

  await tx
    .insert(app_users)
    .values({
      id: payload.user_id,
      tenant_id,
      email: payload.email,
      name: payload.name ?? null,
      role: papel,
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

  // O MARCADOR, na MESMA transação que criou o founder.
  //
  // Sem isto o "bloqueio definitivo" da migration 136 nunca engatava:
  // `isBootstrapCompleted()` responderia `false` para sempre e uma segunda
  // credencial poderia ser emitida depois de um bootstrap bem-sucedido. Duas
  // transações separadas também não serviriam — um crash entre elas deixaria
  // founder sem marcador (bloqueio nunca engata) ou marcador sem founder
  // (bootstrap travado sem nunca ter produzido identidade).
  if (ehBootstrap) {
    const { markBootstrapCompletedTx } = await import('./bootstrap.js');
    // `actor_id` da run é `bootstrap:<credential_id>` — quem o montou foi
    // `startGlobalBootstrapRun`, DEPOIS de resgatar a credencial.
    const credential_id = run.created_by.startsWith('bootstrap:')
      ? run.created_by.slice('bootstrap:'.length)
      : null;
    if (credential_id === null) {
      // Uma run `global_bootstrap` cujo criador não veio do resgate não
      // deveria existir — a fronteira de `openRun` impede. Falha fechado em
      // vez de gravar um marcador sem procedência.
      throw new OnboardingError(
        'bootstrap_not_allowed',
        'run de bootstrap sem credencial de origem rastreável',
      );
    }
    await markBootstrapCompletedTx(tx, {
      credential_id,
      tenant_id,
      founder_user_id: user.id,
    });
  }

  // `email` NUNCA entra em result/summary — a denylist de `sanitize.ts` já o
  // redigiria, mas não o mandamos de todo modo.
  return {
    result: { user_id: user.id, role: user.role },
    summary: { user_id: user.id, role: user.role },
    audit: {
      action: ehBootstrap ? 'bootstrap_initial_admin_created' : 'onboarding_admin_provisioned',
      resource_type: 'app_user',
      resource_id: user.id,
    },
  };
}

export async function applyProvisionAgent(
  tx: Tx,
  run: OnboardingRunRow,
  payload: StepPayload<'provision_agent'>,
): Promise<StepApplication> {
  const tenant_id = requireTenant(run);
  assertProvisioningScope({ tenant_id, agent_id: payload.agent_id });

  // `provision_agent` CRIA um agente. Não adota, não reconfigura, não
  // "converge" para um que já exista — e é o `RETURNING` que faz disso um fato,
  // não uma intenção.
  //
  // O que havia antes: `ON CONFLICT DO NOTHING` seguido de um `SELECT` pelo par
  // `(id, tenant_id)`. O `SELECT` não distingue "acabei de inserir" de "já
  // estava lá": um id colidindo com um agente do MESMO tenant era encontrado
  // pela releitura e o passo seguia como SUCESSO. Os passos seguintes da saga
  // então sobrescreviam profile, grants e papel padrão de um agente que podia
  // estar ATIVO em produção — a saga de onboarding virava um caminho de
  // reconfiguração silenciosa. O `duplicate_agent` documentado só disparava
  // quando o id pertencia a OUTRO tenant (aí o par não devolvia nada), ou seja,
  // metade do contrato prometido em `docs/architecture/modules/onboarding.md`
  // nunca existiu.
  //
  // Com `RETURNING`, a linha só volta quando o `INSERT` REALMENTE inseriu.
  // Nenhuma linha ⟺ a PK global de `agents` já está tomada — não importa por
  // qual tenant — e a única resposta é `duplicate_agent`.
  //
  // Isto NÃO reintroduz o vazamento de existência cross-tenant que a releitura
  // por par corrigiu, e a razão é que aqui não há releitura NENHUMA: o resultado
  // vem do próprio `INSERT`, nunca lemos a row alheia, e a recusa é
  // indistinguível entre "o id é de outro tenant" e "o id é deste tenant". A
  // mensagem continua sem nomear o dono — só um id já em uso, que é o mínimo
  // inerente a qualquer criação com id escolhido pelo caller.
  //
  // E o REPLAY legítimo não passa por aqui: o ledger de idempotência da saga
  // (migration 113) resolve a mesma (run, passo, chave) em
  // `onboardingRunsRepo.commitStep` ANTES de chamar este `apply`, devolvendo o
  // resultado anterior. Como a linha do ledger e este `INSERT` são gravados na
  // MESMA transação curta, não existe estado em que o agente exista e o ledger
  // não saiba — logo, um retry nunca cai neste `duplicate_agent`.
  const insertedRows = await tx
    .insert(agents)
    .values({
      id: payload.agent_id,
      tenant_id,
      nome: payload.nome,
      // NASCE INATIVO. A ativação é um comando explícito no fim da saga, com
      // readiness reavaliado — nunca um efeito colateral da criação.
      //
      // `provisioning` é um valor de primeira classe do CHECK de `agents.status`
      // desde `migrations/110_agents_status_provisioning.sql`. NÃO trocar por
      // `paused`: `paused` significa "esteve ativo e foi parado", e a remediação
      // óbvia para ele (despausar) colocaria em serviço um agente sem profile,
      // sem papel e sem política — ver o cabeçalho da migration 110.
      status: AGENT_STATUS_PROVISIONING,
    })
    .onConflictDoNothing()
    .returning();

  const agent = insertedRows[0];
  if (!agent) {
    throw new OnboardingError(
      'duplicate_agent',
      'o id de agente informado já está em uso — escolha outro',
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
      status: PROFILE_STATUS_SEED,
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
      status: PROFILE_STATUS_ACTIVE,
      approved_by: actor_id,
      approved_at: now,
      activated_at: now,
    })
    .where(
      and(
        eq(agent_operational_profile_versions.tenant_id, tenant_id),
        eq(agent_operational_profile_versions.agent_id, agent_id),
        eq(agent_operational_profile_versions.version, 1),
        eq(agent_operational_profile_versions.status, PROFILE_STATUS_SEED),
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
        eq(agent_operational_profile_versions.status, PROFILE_STATUS_ACTIVE),
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
        channel_type: CHANNEL_TYPE_WHATSAPP,
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
        eq(channels.channel_type, CHANNEL_TYPE_WHATSAPP),
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
    .values({ channel_id: channel.id, tenant_id, agent_id, state: CHANNEL_LINE_STATE_INITIAL })
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
 * Ativação: liga o agente E as linhas INTEGRALMENTE VÁLIDAS, no mesmo `tx` da
 * transição da run. O readiness foi reavaliado pelo wizard imediatamente antes,
 * DENTRO desta mesma transação e sob os locks de `lockReadinessSnapshot`.
 *
 * ─── O conjunto ativado é o VALIDADO, não "os que têm política" ──────────────
 * (Review adversarial do PR #541, achado 1.)
 *
 * A versão anterior seleccionava os canais por um único predicado — EXISTE
 * `channel_policy` do mesmo escopo — e ligava todos. Isso ativava canais que o
 * readiness jamais aprovou individualmente: a linha sem posse provada e a linha
 * cuja política aponta para papel inativo entravam em roteamento porque OUTRO
 * canal do mesmo agente satisfazia o predicado que faltava a elas.
 *
 * Agora a ativação recebe do readiness o conjunto EXATO de canais aprovados
 * (`AgentReadiness.activatable_channel_ids`) e RE-DERIVA a mesma conjunção
 * contra o banco, sob os locks, com a query abaixo. Só ativa se os dois
 * conjuntos coincidirem EXATAMENTE:
 *
 *   * a re-derivação sozinha não bastaria — ela é uma segunda opinião, não a
 *     decisão; a decisão foi tomada pelo avaliador puro e é ela que o operador
 *     viu e aprovou;
 *   * o conjunto do readiness sozinho não bastaria — ele foi calculado antes
 *     das escritas, e o `FOR SHARE` não é predicate lock: uma linha NOVA
 *     inserida concorrentemente não é travada por nada.
 *
 * Divergência entre os dois ⇒ NEGATIVA de governança (`deny`), run para
 * `readiness_failed`. Nunca um `active` que ligou algo que ninguém validou.
 *
 * As escritas continuam CONFERIDAS antes de a run poder concluir: se o `UPDATE`
 * do agente não casou, ou se o conjunto de canais mudou entre a leitura e a
 * escrita, a transação inteira volta.
 *
 * ─── O conjunto é EXATO: liga os válidos E DESLIGA os excluídos ──────────────
 * (Re-review adversarial do PR #541, achado 3.)
 *
 * Ligar o conjunto validado sem o complemento deixava metade da decisão por
 * escrever. Um canal governado cujo papel foi DESATIVADO depois de ele já estar
 * roteando continuava roteando: o readiness o excluía, a ativação simplesmente
 * não o mencionava, e `active` seguia `true` porque OUTRO canal do agente
 * mantinha a readiness global verdadeira.
 *
 * A semântica fixada é: **readiness do agente é EXISTENCIAL — pelo menos um
 * canal precisa satisfazer integralmente política + papel ativo + posse —, mas
 * cada canal é FAIL-CLOSED INDIVIDUALMENTE.** Ativa-se somente
 * `activatable_channel_ids`; os governados restantes ficam `active = false`.
 * Um canal quebrado não derruba os válidos, e um canal válido não empresta
 * roteamento para um quebrado.
 *
 * A alternativa "negar a ativação se houver canal ativo excluído" foi
 * DESCARTADA: ela devolve exatamente o comportamento que a regra existencial
 * rejeita — um canal ruim parando o agente inteiro.
 *
 * O universo do complemento é o dos canais GOVERNADOS (não-sintéticos do
 * escopo COM `channel_policy` do mesmo escopo) — o mesmo conjunto que
 * `readiness.ts` chama `governedChannels`. Um canal sem política nenhuma não
 * está sob a governança de canal deste agente, e desligá-lo aqui seria uma
 * decisão diferente da que esta review pediu.
 *
 * A desativação é AUDITADA por canal (`onboarding_channel_deactivated`, no
 * MESMO `tx`): um canal que roteava e deixou de rotear é decisão de governança,
 * não detalhe de implementação. Só quem estava `active` gera linha — reafirmar
 * `false` sobre `false` não é mudança.
 */
export async function applyActivate(
  tx: Tx,
  run: OnboardingRunRow,
  fingerprints: {
    configuration_fingerprint: string;
    schema_fingerprint: string;
    /** O conjunto aprovado pelo readiness — a única lista que pode ser ativada. */
    activatable_channel_ids: readonly string[];
    /**
     * O veredito POR CANAL do readiness. Alimenta a auditoria da desativação
     * com os códigos que CADA canal reprovou — sem isto a trilha diria "foi
     * desligado" sem dizer por quê.
     */
    channel_verdicts?: ReadonlyArray<{ channel_id: string; failed_checks: readonly string[] }>;
    /** O ATOR do comando — a desativação é decisão de governança, tem dono. */
    actor: { actor_id: string; actor_role: string };
  },
): Promise<StepApplication> {
  const { tenant_id, agent_id } = requireScope(run);
  const approved = [...new Set(fingerprints.activatable_channel_ids)].sort();

  // (1) LEITURA primeiro. A precondição é conferida ANTES de qualquer escrita,
  // porque uma NEGATIVA (`deny`) NÃO faz rollback — ela commita a transição
  // para `readiness_failed`. Escrever antes de decidir deixaria o agente
  // `active` numa run que não concluiu, que é pior do que o defeito original.
  //
  // A conjunção inteira vira JOIN: canal não-sintético do escopo × política do
  // MESMO escopo × papel ATIVO do MESMO escopo × estado de linha que prova
  // posse. Os `eq` de `(tenant_id, agent_id)` estão em CADA junção, não só no
  // `WHERE`: `channel_line_state` replica o par sem FK composta (migration 103)
  // e `channel_policies` idem, então casar o escopo no `ON` é o que impede uma
  // linha replicada divergente de emprestar validade a um canal alheio.
  const governed = await tx
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(
      channel_policies,
      and(
        eq(channel_policies.channel_id, channels.id),
        eq(channel_policies.tenant_id, tenant_id),
        eq(channel_policies.agent_id, agent_id),
      ),
    )
    .innerJoin(
      roles,
      and(
        eq(roles.id, channel_policies.default_role_id),
        eq(roles.tenant_id, tenant_id),
        eq(roles.agent_id, agent_id),
        eq(roles.active, true),
      ),
    )
    .innerJoin(
      channel_line_state,
      and(
        eq(channel_line_state.channel_id, channels.id),
        eq(channel_line_state.tenant_id, tenant_id),
        eq(channel_line_state.agent_id, agent_id),
        // O vocabulário vem de `readiness.ts`, não de literais repetidos aqui:
        // se ele divergir, os dois lados divergem JUNTOS e o teste de
        // compatibilidade de CHECK denuncia.
        inArray(channel_line_state.state, [...OWNERSHIP_PROVEN_LINE_STATES]),
      ),
    )
    .where(
      and(
        eq(channels.tenant_id, tenant_id),
        eq(channels.agent_id, agent_id),
        eq(channels.is_synthetic, false),
      ),
    );

  const rederived = [...new Set(governed.map((g) => g.id))].sort();

  // O UNIVERSO do complemento, lido pelo MESMO `tx` e sob os MESMOS locks:
  // **todo** canal não-sintético de `tenant_id + agent_id`, tenha política ou
  // não. `rederived` é um subconjunto deste; a diferença é o que precisa ficar
  // fora do roteamento. `active` vem junto porque só quem ESTAVA ativo produz
  // linha de auditoria.
  //
  // A primeira versão restringia este universo aos canais GOVERNADOS (os com
  // `channel_policy` do mesmo par), por ser a leitura literal do achado. O
  // owner recusou, e a razão é boa: **ausência de política não é ausência de
  // decisão, é um estado inválido.** Um canal sem policy não tem papel padrão
  // resolvível, logo não pode rotear — deixá-lo de fora do complemento
  // transformaria a falha mais grosseira de configuração na única que escapa,
  // ou seja, um fail-OPEN exatamente onde o desenho é fail-closed. É também o
  // caso mais fácil de produzir por acidente: basta apagar uma policy.
  //
  // Duas fronteiras que o `WHERE` preserva, e que os testes fixam:
  //   - `is_synthetic = false` — a sonda sintética (#502) tem ciclo de vida
  //     próprio e não é roteamento de tenant; desligá-la aqui cegaria o
  //     monitoramento como efeito colateral de um onboarding;
  //   - o par `(tenant_id, agent_id)` — o complemento nunca alcança outro
  //     escopo. Um agente ativar-se não pode desligar canal de ninguém.
  const governedRows = await tx
    .select({ id: channels.id, active: channels.active })
    .from(channels)
    .where(
      and(
        eq(channels.tenant_id, tenant_id),
        eq(channels.agent_id, agent_id),
        eq(channels.is_synthetic, false),
      ),
    );
  const governedIds = [...new Set(governedRows.map((g) => g.id))].sort();
  let deactivatedChannelIds: string[] = [];

  if (rederived.length === 0) {
    return {
      result: { activated_channels: 0 },
      summary: { activated_channels: 0 },
      deny: {
        code: 'activation_precondition_failed',
        message:
          'nenhuma linha integralmente válida para ativar — a configuração mudou entre a avaliação e a escrita',
      },
      audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: agent_id },
    };
  }

  if (
    approved.length !== rederived.length ||
    approved.some((id, i) => id !== rederived[i])
  ) {
    return {
      result: { activated_channels: 0 },
      summary: { activated_channels: 0 },
      deny: {
        code: 'activation_precondition_failed',
        message:
          'o conjunto de linhas válidas divergiu do que o readiness aprovou — nada foi ativado',
      },
      audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: agent_id },
    };
  }

  // (2) Escritas, cada uma conferida. Aqui a falha é uma INVARIANTE quebrada,
  // não uma decisão de governança: as linhas estão travadas desde
  // `lockReadinessSnapshot`, então nada deveria ter sumido. Lançar é a resposta
  // certa — o rollback leva tudo, e a run não avança.
  const activatedAgent = await tx
    .update(agents)
    .set({ status: AGENT_STATUS_ACTIVE, updated_at: new Date() })
    .where(and(eq(agents.id, agent_id), eq(agents.tenant_id, tenant_id)))
    .returning({ id: agents.id });
  if (activatedAgent.length !== 1) {
    throw new OnboardingError(
      'activation_precondition_failed',
      'o agente do escopo da run desapareceu durante a ativação',
      { agent_id, matched: activatedAgent.length },
    );
  }

  // Só os canais INTEGRALMENTE VÁLIDOS passam a rotear — exatamente os que a
  // leitura (1) re-derivou sob o lock e que o readiness já havia aprovado.
  // `rederived` (e não `approved`) alimenta o `IN`: os dois são iguais por
  // construção neste ponto, e usar o conjunto lido pelo `tx` mantém a escrita
  // ancorada no que ESTA transação enxerga.
  const activatedChannels = await tx
    .update(channels)
    .set({ active: true, updated_at: new Date() })
    .where(
      and(
        eq(channels.tenant_id, tenant_id),
        eq(channels.agent_id, agent_id),
        inArray(channels.id, rederived),
      ),
    )
    .returning({ id: channels.id });
  if (activatedChannels.length !== rederived.length) {
    throw new OnboardingError(
      'activation_precondition_failed',
      'o conjunto de linhas válidas mudou durante a ativação',
      { expected: rederived.length, matched: activatedChannels.length },
    );
  }

  // ── O COMPLEMENTO (achado 3): os governados que NÃO entraram ───────────────
  //
  // Mesma transação, mesmos locks (`lockReadinessSnapshot` tomou `FOR UPDATE`
  // em `channels` do escopo). Fazer isto depois, ou noutra conexão, reabriria
  // exatamente a janela em que um canal excluído segue roteando.
  const excluded = governedIds.filter((id) => !rederived.includes(id));
  if (excluded.length > 0) {
    // Quem ESTAVA roteando é o que a governança precisa registrar. Reafirmar
    // `false` sobre `false` é no-op semântico, não uma decisão.
    const wasActive = [
      ...new Set(
        governedRows.filter((r) => excluded.includes(r.id) && r.active).map((r) => r.id),
      ),
    ].sort();

    const deactivated = await tx
      .update(channels)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          inArray(channels.id, excluded),
        ),
      )
      .returning({ id: channels.id });
    // Contagem conferida, como no ramo da ativação: sob os locks nada deveria
    // ter sumido, e um descasamento é invariante quebrada — lançar leva a
    // transação inteira de volta.
    if (deactivated.length !== excluded.length) {
      throw new OnboardingError(
        'activation_precondition_failed',
        'o conjunto de linhas excluídas mudou durante a ativação',
        { expected: excluded.length, matched: deactivated.length },
      );
    }

    const verdictOf = new Map(
      (fingerprints.channel_verdicts ?? []).map((v) => [v.channel_id, v.failed_checks]),
    );
    for (const id of wasActive) {
      await tx.insert(admin_audit_log).values({
        tenant_id,
        actor_id: fingerprints.actor.actor_id,
        actor_role: fingerprints.actor.actor_role,
        action: 'onboarding_channel_deactivated',
        resource_type: 'channel',
        resource_id: id,
        change_summary: {
          agent_id,
          run_id: run.id,
          was_active: true,
          // Tipado, vindo do veredito do readiness — nunca texto livre.
          failed_checks: [...(verdictOf.get(id) ?? [])],
        },
      });
    }

    deactivatedChannelIds = wasActive;
  }

  return {
    result: {
      agent_id,
      activated_channels: activatedChannels.length,
      activated_channel_ids: rederived,
      deactivated_channels: deactivatedChannelIds.length,
      deactivated_channel_ids: deactivatedChannelIds,
      configuration_fingerprint: fingerprints.configuration_fingerprint,
      schema_fingerprint: fingerprints.schema_fingerprint,
    },
    summary: {
      activated_channels: activatedChannels.length,
      deactivated_channels: deactivatedChannelIds.length,
      configuration_fingerprint: fingerprints.configuration_fingerprint,
    },
    completes: true,
    audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: agent_id },
  };
}

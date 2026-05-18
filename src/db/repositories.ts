import { eq, and, inArray, desc, isNull, sql, or, gt, lt, ne } from 'drizzle-orm';
import { db, withTx } from './client.js';
import { procedure_status_events } from './schema.js';
import {
  pessoas,
  permissoes,
  permission_profiles,
  conversas,
  mensagens,
  entidades,
  contas_bancarias,
  transacoes,
  contrapartes,
  categorias,
  agent_facts,
  learned_rules,
  pending_questions,
  idempotency_keys,
  audit_log,
  workflows,
  workflow_steps,
  entity_states,
  self_state,
  system_health_events,
  dead_letter_jobs,
  tenants,
  agents,
  cognitive_module_log,
  cognitive_candidates,
  memory_entry,
  behavioral_hint,
  agent_capabilities_domain,
  agent_capabilities_skill,
  agent_capability_gaps,
  procedure_definitions,
  procedure_assignments,
  procedure_executions,
  procedure_execution_events,
  procedure_selector_decisions,
  procedure_tests,
  procedure_metrics,
  agent_operational_profile_versions,
  agent_drift_alerts,
  gap_escalation_rules,
  capability_proposals,
  capability_test_results,
  channels,
  roles,
  channel_policies,
  role_selector_decisions,
} from './schema.js';
import { TypedError } from '@/lib/utils.js';
import { applyTenantGuard } from './tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from './tenant-context.js';
import type {
  ProfileStatus,
  DriftType,
  DriftSeverity,
  DriftDecision,
  GapLevel,
  ProposalStatus,
  SwitchBehavior,
  AnnounceMode,
  SuggestedBy,
  DecidedBy,
  RoleSelectorStrength,
  RoleDecisionAction,
} from '@/types/enums.js';
import type {
  Pessoa,
  Permissao,
  Conversa,
  Mensagem,
  Entidade,
  Conta,
  Transacao,
  Contraparte,
  Categoria,
  PermissionProfile,
  AgentFact,
  LearnedRule,
  PendingQuestion,
  AuditEntry,
  Workflow,
  WorkflowStep,
  EntityState,
  SelfState,
  Tenant,
  Agent,
  CognitiveModuleLog,
  CognitiveCandidate,
  MemoryEntry,
  BehavioralHint,
  AgentCapabilityDomain,
  AgentCapabilitySkill,
  AgentCapabilityGap,
  ProcedureDefinition,
  ProcedureAssignment,
  ProcedureExecution,
  ProcedureExecutionEvent,
  ProcedureSelectorDecision,
  ProcedureTest,
  ProcedureMetric,
  ProcedureStatusEvent,
  ProcedureStatusUpdate,
  AgentOperationalProfileVersion,
  ProfileBody,
  AgentDriftAlert,
  GapEscalationRule,
  NewGapEscalationRule,
  CapabilityProposal,
  CapabilityTestResult,
  Channel,
  Role,
  ChannelPolicy,
  NewChannelPolicy,
  RoleSelectorDecisionRow,
} from './schema.js';

export type EntityScope = {
  pessoa_id: string;
  entidades: string[];
};

export class EmptyScopeError extends TypedError {
  constructor() {
    super('empty_scope', 'Repository called without entity scope');
  }
}

export const pessoasRepo = {
  /**
   * P83-C7: tenant-scoped findById. A row from another tenant is invisible.
   */
  async findById(id: string): Promise<Pessoa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(pessoas)
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * P83-C7: tenant-scoped findByPhone. WhatsApp phone numbers are
   * globally unique but the pessoa record still belongs to a single
   * tenant — we MUST scope the read.
   */
  async findByPhone(telefone: string): Promise<Pessoa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(pessoas)
      .where(and(
        eq(pessoas.telefone_whatsapp, telefone),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Pessoa, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Pessoa> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(pessoas).values(guarded).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Pessoa['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(pessoas)
      .set({ status, updated_at: new Date() })
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ));
  },
  async updatePreferencias(id: string, preferencias: Record<string, unknown>): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(pessoas)
      .set({ preferencias, updated_at: new Date() })
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ));
  },
  async list(): Promise<Pessoa[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(pessoas)
      .where(and(eq(pessoas.tenant_id, tenant_id), eq(pessoas.agent_id, agent_id)));
  },
};

export const permissoesRepo = {
  // P83-C7: all permissoes reads + writes scoped to current tenant.
  async forPessoa(pessoa_id: string): Promise<Permissao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(permissoes)
      .where(and(
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
        eq(permissoes.pessoa_id, pessoa_id),
        eq(permissoes.status, 'ativa'),
      ));
  },
  async byKey(pessoa_id: string, entidade_id: string): Promise<Permissao | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(permissoes)
      .where(and(
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
        eq(permissoes.pessoa_id, pessoa_id),
        eq(permissoes.entidade_id, entidade_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Permissao, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<Permissao> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(permissoes).values(guarded).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Permissao['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(permissoes)
      .set({ status })
      .where(and(
        eq(permissoes.id, id),
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
      ));
  },
};

export const profilesRepo = {
  async byId(id: string): Promise<PermissionProfile | null> {
    const rows = await db
      .select()
      .from(permission_profiles)
      .where(eq(permission_profiles.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async list(): Promise<PermissionProfile[]> {
    return db.select().from(permission_profiles);
  },
};

export const conversasRepo = {
  async findActive(pessoa_id: string): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.pessoa_id, pessoa_id),
          eq(conversas.status, 'ativa'),
        ),
      )
      .orderBy(desc(conversas.ultima_atividade_em))
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: {
    pessoa_id: string;
    escopo_entidades: string[];
  }): Promise<Conversa> {
    const guarded = applyTenantGuard({
      pessoa_id: input.pessoa_id,
      escopo_entidades: input.escopo_entidades,
    });
    const rows = await db.insert(conversas).values(guarded).returning();
    return rows[0]!;
  },
  async touch(id: string): Promise<void> {
    await db
      .update(conversas)
      .set({ ultima_atividade_em: new Date() })
      .where(eq(conversas.id, id));
  },
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    await db.update(conversas).set({ metadata }).where(eq(conversas.id, id));
  },
  /**
   * Atomic partial merge into conversas.metadata via the jsonb `||`
   * operator. Issue #73: avoids losing concurrent keys (e.g. pending_question)
   * when two workers race to write metadata. Existing keys in `patch`
   * overwrite existing keys in metadata; everything else is preserved.
   */
  async mergeMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(conversas.id, id));
  },
  /**
   * Atomic key removal from conversas.metadata via the jsonb `-` operator.
   * Superpowers I3 (PR #74): paired with `mergeMetadata` for the deprecated
   * lightweight-pending-question flow so a clear-pending operation no
   * longer races with concurrent `mergeMetadata` writes (e.g.
   * `last_scope_hash`) — the previous `updateMetadata` full-object set
   * would silently drop concurrent keys.
   */
  async unsetMetadataKey(id: string, key: string): Promise<void> {
    await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} - ${key}` })
      .where(eq(conversas.id, id));
  },
  async close(id: string, contexto_resumido: string): Promise<void> {
    await db
      .update(conversas)
      .set({ status: 'encerrada', contexto_resumido })
      .where(eq(conversas.id, id));
  },
  async invalidateScopeForPessoa(pessoa_id: string): Promise<void> {
    await db
      .update(conversas)
      .set({ escopo_entidades: [] })
      .where(eq(conversas.pessoa_id, pessoa_id));
  },
};

export const mensagensRepo = {
  async create(input: Omit<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<Mensagem> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(mensagens).values(guarded).returning();
    return rows[0]!;
  },
  async createInbound(
    input: Omit<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>,
  ): Promise<{ row: Mensagem; duplicate: boolean }> {
    const wid = (input.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
    if (typeof wid === 'string' && wid.length > 0) {
      const existing = await this.findByWhatsappId(wid);
      if (existing) return { row: existing, duplicate: true };
    }
    try {
      const guarded = applyTenantGuard(input);
      const rows = await db.insert(mensagens).values(guarded).returning();
      return { row: rows[0]!, duplicate: false };
    } catch (err) {
      // Unique-violation race: re-fetch and treat as duplicate.
      if (typeof wid === 'string' && (err as { code?: string }).code === '23505') {
        const existing = await this.findByWhatsappId(wid);
        if (existing) return { row: existing, duplicate: true };
      }
      throw err;
    }
  },
  async listUnprocessedOlderThan(ms: number, limit = 100): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - ms);
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          isNull(mensagens.processada_em),
          eq(mensagens.direcao, 'in'),
          sql`created_at < ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
  },
  async findById(id: string): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async findByWhatsappId(whatsapp_id: string): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          sql`metadata->>'whatsapp_id' = ${whatsapp_id}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async recentInConversation(conversa_id: string, n = 20): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(mensagens.created_at))
      .limit(n);
  },
  /**
   * Inbound messages from a given telefone (`metadata->>'telefone'`) that
   * haven't been processed yet, in chronological order (oldest first).
   *
   * Keyed off telefone — NOT conversa_id — because at the moment the
   * debounce worker fires, only the target message has had its
   * conversa_id resolved by the agent. Earlier chunks from the same
   * burst still carry `conversa_id IS NULL` (baileys saves all inbounds
   * with null conversa_id; resolution happens in `runAgentForMensagem`).
   * Querying by conversa_id would silently miss them.
   *
   * `excludeId` lets the caller skip the "target" message that triggered
   * the run. The result includes orphans (`conversa_id IS NULL`) and
   * messages already attached to a conversa — caller filters by
   * conversa_id == target's OR null to avoid cross-conversation leakage
   * (defensive: telefone is 1:1 with pessoa, so leakage is theoretical).
   */
  async listUnprocessedByTelefone(
    telefone: string,
    opts?: { excludeId?: string; limit?: number },
  ): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const limit = opts?.limit ?? 50;
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.direcao, 'in'),
          isNull(mensagens.processada_em),
          sql`metadata->>'telefone' = ${telefone}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
    if (opts?.excludeId) return rows.filter((r) => r.id !== opts.excludeId);
    return rows;
  },
  async setConversaId(id: string, conversa_id: string): Promise<void> {
    await db.update(mensagens).set({ conversa_id }).where(eq(mensagens.id, id));
  },
  /**
   * Bulk variant for the debounce aggregation path: adopts orphan
   * inbound rows (conversa_id null) into the conversation that the
   * target message resolved to. One UPDATE round-trip instead of N.
   */
  async setConversaIdMany(ids: string[], conversa_id: string): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(mensagens)
      .set({ conversa_id })
      .where(inArray(mensagens.id, ids));
  },
  async markProcessed(id: string, tokens: number | null): Promise<void> {
    await db
      .update(mensagens)
      .set({ processada_em: new Date(), tokens_usados: tokens ?? null })
      .where(eq(mensagens.id, id));
  },

  // [P88-C1] EXPLICITLY bypasses applyTenantGuard — the channel resolver
  // runs BEFORE tenant context exists (it's the entry point that DISCOVERS
  // which tenant owns the inbound). If a non-default channel resolves to
  // (tenantX, agentX) but the gateway persisted the row under (default,
  // default), the post-resolution tenant-scoped findById would return null
  // and the turn would be silently dropped. This method atomically adopts
  // the row to the resolved triplet so the inner tenant-scoped read finds
  // it. Same sanctioned-bypass pattern as channelsRepo.findByExternalCrossTenant.
  async adoptToResolvedTenantCrossTenant(args: {
    id: string;
    tenant_id: string;
    agent_id: string;
  }): Promise<void> {
    await db
      .update(mensagens)
      .set({ tenant_id: args.tenant_id, agent_id: args.agent_id })
      .where(eq(mensagens.id, args.id));
  },
};

export const entidadesRepo = {
  async list(): Promise<Entidade[]> {
    return db.select().from(entidades);
  },
  async byId(id: string): Promise<Entidade | null> {
    const rows = await db.select().from(entidades).where(eq(entidades.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async byIds(ids: string[]): Promise<Entidade[]> {
    if (ids.length === 0) return [];
    return db.select().from(entidades).where(inArray(entidades.id, ids));
  },
  async create(input: Omit<Entidade, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Entidade> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(entidades).values(guarded).returning();
    return rows[0]!;
  },
};

export const contasRepo = {
  async byEntity(entidade_id: string): Promise<Conta[]> {
    return db.select().from(contas_bancarias).where(eq(contas_bancarias.entidade_id, entidade_id));
  },
  async byId(id: string): Promise<Conta | null> {
    const rows = await db
      .select()
      .from(contas_bancarias)
      .where(eq(contas_bancarias.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async byEntities(scope: EntityScope): Promise<Conta[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contas_bancarias)
      .where(inArray(contas_bancarias.entidade_id, scope.entidades));
  },
  async create(input: Omit<Conta, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Conta> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contas_bancarias).values(guarded).returning();
    return rows[0]!;
  },
  async addToBalance(id: string, delta: number): Promise<Conta | null> {
    const rows = await db
      .update(contas_bancarias)
      .set({
        saldo_atual: sql`saldo_atual + ${delta}`,
        updated_at: new Date(),
      })
      .where(eq(contas_bancarias.id, id))
      .returning();
    return rows[0] ?? null;
  },
};

export const transacoesRepo = {
  async byScope(
    scope: EntityScope,
    filter?: {
      date_from?: string;
      date_to?: string;
      categoria_id?: string;
      natureza?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Transacao[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conds = [
      eq(transacoes.tenant_id, tenant_id),
      eq(transacoes.agent_id, agent_id),
      inArray(transacoes.entidade_id, scope.entidades),
    ];
    if (filter?.date_from) conds.push(sql`data_competencia >= ${filter.date_from}`);
    if (filter?.date_to) conds.push(sql`data_competencia <= ${filter.date_to}`);
    if (filter?.categoria_id) conds.push(eq(transacoes.categoria_id, filter.categoria_id));
    if (filter?.natureza) conds.push(eq(transacoes.natureza, filter.natureza));
    return db
      .select()
      .from(transacoes)
      .where(and(...conds))
      .orderBy(desc(transacoes.data_competencia))
      .limit(filter?.limit ?? 50)
      .offset(filter?.offset ?? 0);
  },
  async create(input: Omit<Transacao, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Transacao> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(transacoes).values(guarded).returning();
    return rows[0]!;
  },
  async listRecent(limit = 50): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(transacoes)
      .where(and(eq(transacoes.tenant_id, tenant_id), eq(transacoes.agent_id, agent_id)))
      .orderBy(desc(transacoes.created_at))
      .limit(limit);
  },
  async findRecentSimilar(params: {
    entidade_id: string;
    valor: string;
    descricao: string;
    registrado_por: string;
    sinceMs: number;
  }): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const since = new Date(Date.now() - params.sinceMs);
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.entidade_id, params.entidade_id),
          eq(transacoes.valor, params.valor),
          eq(transacoes.registrado_por, params.registrado_por),
          sql`created_at >= ${since.toISOString()}`,
        ),
      );
  },
  async byId(id: string): Promise<Transacao | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async update(id: string, patch: Partial<Transacao>): Promise<void> {
    await db.update(transacoes).set(patch).where(eq(transacoes.id, id));
  },
};

export const categoriasRepo = {
  async list(scope?: EntityScope): Promise<Categoria[]> {
    if (!scope) return db.select().from(categorias);
    return db
      .select()
      .from(categorias)
      .where(
        sql`(${categorias.entidade_id} IS NULL OR ${inArray(categorias.entidade_id, scope.entidades)})`,
      );
  },
  async byId(id: string): Promise<Categoria | null> {
    const rows = await db.select().from(categorias).where(eq(categorias.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async byIds(ids: string[]): Promise<Categoria[]> {
    if (ids.length === 0) return [];
    return db.select().from(categorias).where(inArray(categorias.id, ids));
  },
  async byNomeNatureza(nome: string, natureza: string): Promise<Categoria | null> {
    const rows = await db
      .select()
      .from(categorias)
      .where(and(eq(categorias.nome, nome), eq(categorias.natureza, natureza), isNull(categorias.entidade_id)))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const contrapartesRepo = {
  async byScope(scope: EntityScope): Promise<Contraparte[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contrapartes)
      .where(inArray(contrapartes.entidade_id, scope.entidades));
  },
  async byId(id: string): Promise<Contraparte | null> {
    const rows = await db.select().from(contrapartes).where(eq(contrapartes.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Contraparte, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Contraparte> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contrapartes).values(guarded).returning();
    return rows[0]!;
  },
};

export const factsRepo = {
  async getByKey(escopo: string, chave: string): Promise<AgentFact | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          eq(agent_facts.escopo, escopo),
          eq(agent_facts.chave, chave),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async upsert(input: {
    escopo: string;
    chave: string;
    valor: unknown;
    fonte: 'configurado' | 'aprendido' | 'inferido';
    confianca?: number;
  }): Promise<AgentFact> {
    const guarded = applyTenantGuard({
      escopo: input.escopo,
      chave: input.chave,
      valor: input.valor as object,
      fonte: input.fonte,
      confianca: String(input.confianca ?? 1),
    });
    const rows = await db
      .insert(agent_facts)
      .values(guarded)
      .onConflictDoUpdate({
        // PR #82 review (Codex): conflict target must match the
        // (tenant_id, agent_id, escopo, chave) unique introduced in
        // migration 018 — otherwise tenant B can overwrite tenant A's
        // fact by colliding on (escopo, chave).
        target: [
          agent_facts.tenant_id,
          agent_facts.agent_id,
          agent_facts.escopo,
          agent_facts.chave,
        ],
        set: {
          valor: input.valor as object,
          fonte: input.fonte,
          updated_at: new Date(),
        },
      })
      .returning();
    return rows[0]!;
  },
  async listForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): every read path that surfaces knowledge
    // to the LLM MUST filter by lifecycle_status. Without this, a
    // propose_fact row with lifecycle_status='pending_review' (or even
    // 'revoked') reaches the prompt because the legacy path filtered only
    // by tenant/agent/escopo. The 5 visible states mirror
    // visibility.VISIBLE_STATES.
    return db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          inArray(agent_facts.escopo, escopos),
          inArray(agent_facts.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      );
  },
  /**
   * PR #82 review (Superpowers Critical #1): the legacy factsBlock in the
   * system prompt was rendering every agent_fact unfiltered, bypassing the
   * memory_entry sensitivity/mention_allowed model. This method returns
   * only facts whose content has either (a) no corresponding memory_entry
   * row yet (e.g. classifier hasn't run, or the fact predates P2) or
   * (b) has a memory_entry that is needs_review=false AND mention_allowed=
   * true. Sensitive/personal facts whose memory_entry says do-not-mention
   * are dropped from the prompt.
   *
   * The match is by literal `content` against two known shapes:
   *   1. P2-era persister: valor = { content, subject_id }, so the join
   *      is `me.content = af.valor->>'content'`.
   *   2. Legacy (pre-P2) facts: migration 017 seeded memory_entry with
   *      `content = CONCAT(af.chave, ': ', af.valor::text)`. If the fact's
   *      `valor` happened to already include a `content` key, shape (1)
   *      alone wouldn't catch it until the reclassifier worker rewrote
   *      that entry. We also match shape (2) so the sensitivity filter
   *      is correct during the reclassifier-backlog window.
   *
   * Facts predating P2 with NO memory_entry row at all are still shown —
   * a conservative default for migration-window legacy data, since the
   * 017 seed guarantees they get a needs_review=true entry the reclassifier
   * will eventually re-evaluate.
   */
  async listMentionableForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): lifecycle_status filter is mandatory
    // on every read that the LLM can see. pending_review / deprecated /
    // revoked rows MUST NOT reach the prompt — they live behind the
    // Admin UI Proposal Inbox until a human acts on them.
    const result = await db.execute<AgentFact>(sql`
      SELECT af.*
      FROM agent_facts af
      WHERE af.tenant_id = ${tenant_id}
        AND af.agent_id = ${agent_id}
        AND af.escopo = ANY(${escopos})
        AND af.lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM memory_entry me
          WHERE me.tenant_id = af.tenant_id
            AND me.agent_id = af.agent_id
            AND (
              me.content = (af.valor->>'content')
              OR me.content = (af.chave || ': ' || af.valor::text)
            )
            AND (
              me.needs_review = true
              OR me.mention_allowed = false
            )
        )
    `);
    return Array.from(result.rows as unknown as AgentFact[]);
  },
};

export const rulesRepo = {
  async listActive(tipo: string): Promise<LearnedRule[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): rules surfaced to the LLM must pass
    // both the legacy `ativa` flag AND the lifecycle_status visibility
    // filter. propose_rule lands rows in pending_review (master §2.6) —
    // those rows must NEVER appear in the rulesBlock until a human
    // approves them in the Admin UI Proposal Inbox.
    return db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.ativa, true),
          eq(learned_rules.tipo, tipo),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(50);
  },
  async create(
    input: Omit<
      LearnedRule,
      | 'id'
      | 'tenant_id'
      | 'agent_id'
      | 'created_at'
      | 'updated_at'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<LearnedRule> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(learned_rules).values(guarded).returning();
    return rows[0]!;
  },
  async findByContext(tipo: string, contexto: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104): exclude non-visible lifecycle states so a
    // pending_review duplicate doesn't satisfy the dedup check and
    // accidentally short-circuit a fresh proposal.
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.tipo, tipo),
          eq(learned_rules.contexto, contexto),
          eq(learned_rules.ativa, true),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async incrementAcerto(id: string): Promise<void> {
    await db
      .update(learned_rules)
      .set({
        acertos: sql`acertos + 1`,
        confianca: sql`LEAST(1.00, confianca + 0.10)`,
        updated_at: new Date(),
      })
      .where(eq(learned_rules.id, id));
  },
  async incrementErro(id: string): Promise<void> {
    await db
      .update(learned_rules)
      .set({
        erros: sql`erros + 1`,
        confianca: sql`GREATEST(0.00, confianca - 0.20)`,
        updated_at: new Date(),
      })
      .where(eq(learned_rules.id, id));
  },
  async setStatus(
    id: string,
    update: { ativa?: boolean; confianca?: number },
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (update.ativa !== undefined) set.ativa = update.ativa;
    if (update.confianca !== undefined) set.confianca = String(update.confianca);
    await db.update(learned_rules).set(set).where(eq(learned_rules.id, id));
  },
};

// `metadata` is `notNull()` in the schema (with `default '{}'::jsonb`) which
// makes it required on the inferred select type. Existing callers (e.g.
// src/identity/quarantine.ts) that predate the column don't pass metadata —
// the DB default is what they want. We strip metadata from the Omit and
// add it back as optional so those call sites keep typechecking.
type PendingQuestionInsert = Omit<
  PendingQuestion,
  'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'resolvida_em' | 'resposta' | 'metadata'
> & { metadata?: object };

export const pendingQuestionsRepo = {
  async create(input: PendingQuestionInsert): Promise<PendingQuestion> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
  async findOpen(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(and(eq(pending_questions.conversa_id, conversa_id), eq(pending_questions.status, 'aberta')))
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  async findOpenByPessoaAndType(pessoa_id: string, tipo: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.pessoa_id, pessoa_id),
          eq(pending_questions.tipo, tipo),
          eq(pending_questions.status, 'aberta'),
          sql`(${pending_questions.expira_em} IS NULL OR ${pending_questions.expira_em} > NOW())`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  async resolve(id: string, resposta: unknown): Promise<void> {
    await db
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(eq(pending_questions.id, id));
  },
  async expireDue(): Promise<number> {
    const rows = await db
      .update(pending_questions)
      .set({ status: 'expirada' })
      .where(and(eq(pending_questions.status, 'aberta'), sql`expira_em < now()`))
      .returning({ id: pending_questions.id });
    return rows.length;
  },

  // === B0 tx-aware additions ===

  async findActiveSnapshot(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActiveForUpdate(
    tx: typeof db,
    conversa_id: string,
  ): Promise<PendingQuestion | null> {
    const rows = await tx
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  },

  async resolveTx(tx: typeof db, id: string, resposta: unknown): Promise<void> {
    await tx
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(eq(pending_questions.id, id));
  },

  async cancelTx(tx: typeof db, id: string, reason: string): Promise<void> {
    await tx.execute(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE id = ${id}
    `);
  },

  async cancelOpenForConversaTx(
    tx: typeof db,
    conversa_id: string,
    reason: string,
  ): Promise<{ cancelled_ids: string[] }> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE conversa_id = ${conversa_id}
         AND status = 'aberta'
       RETURNING id::text
    `);
    return { cancelled_ids: result.rows.map((r) => (r as { id: string }).id) };
  },

  async createTx(
    tx: typeof db,
    input: PendingQuestionInsert,
  ): Promise<PendingQuestion> {
    // Insert inside the same tx as the cancel — required by the partial unique
    // index `(conversa_id) WHERE status='aberta'` from migration 004. Doing
    // the insert on the global pool would race with the in-flight cancel and
    // hit a duplicate-key error.
    const guarded = applyTenantGuard(input);
    const rows = await tx.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
};

export const idempotencyRepo = {
  async lookup(key: string): Promise<unknown | null> {
    const rows = await db
      .select()
      .from(idempotency_keys)
      .where(eq(idempotency_keys.key, key))
      .limit(1);
    return rows[0]?.resultado ?? null;
  },
  async store(input: {
    key: string;
    tool_name: string;
    operation_type: string;
    pessoa_id: string;
    entity_id: string;
    payload_hash: string;
    file_sha256?: string;
    resultado: unknown;
  }): Promise<void> {
    await db
      .insert(idempotency_keys)
      .values({
        key: input.key,
        tool_name: input.tool_name,
        operation_type: input.operation_type,
        pessoa_id: input.pessoa_id,
        entity_id: input.entity_id,
        payload_hash: input.payload_hash,
        file_sha256: input.file_sha256 ?? null,
        resultado: input.resultado as object,
      })
      .onConflictDoNothing();
  },
  async cleanup(olderThanDays: number): Promise<number> {
    const rows = await db
      .delete(idempotency_keys)
      .where(sql`created_at < now() - (${olderThanDays} || ' days')::interval`)
      .returning({ key: idempotency_keys.key });
    return rows.length;
  },
};

export const auditRepo = {
  async write(input: Omit<AuditEntry, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(audit_log).values(guarded);
  },
  async listByPessoa(pessoa_id: string, n = 100): Promise<AuditEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(audit_log)
      .where(
        and(
          eq(audit_log.tenant_id, tenant_id),
          eq(audit_log.agent_id, agent_id),
          eq(audit_log.pessoa_id, pessoa_id),
        ),
      )
      .orderBy(desc(audit_log.created_at))
      .limit(n);
  },
  async findByMensagemId(mensagem_id: string): Promise<AuditEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(audit_log)
      .where(
        and(
          eq(audit_log.tenant_id, tenant_id),
          eq(audit_log.agent_id, agent_id),
          eq(audit_log.mensagem_id, mensagem_id),
        ),
      );
  },
};

export const workflowsRepo = {
  // P83-C7: tenant-scoped workflow reads/writes.
  async create(input: Omit<Workflow, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>): Promise<Workflow> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(workflows).values(guarded).returning();
    return rows[0]!;
  },
  async byId(id: string): Promise<Workflow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.id, id),
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async setStatus(id: string, status: Workflow['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const update: Record<string, unknown> = { status };
    if (status === 'concluido') update.concluido_em = new Date();
    await db
      .update(workflows)
      .set(update)
      .where(and(
        eq(workflows.id, id),
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
      ));
  },
  async listPending(): Promise<Workflow[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
        sql`status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')`,
      ));
  },
};

export const workflowStepsRepo = {
  async createMany(
    inputs: Omit<WorkflowStep, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>[],
  ): Promise<WorkflowStep[]> {
    if (inputs.length === 0) return [];
    const guarded = inputs.map((i) => applyTenantGuard(i));
    return db.insert(workflow_steps).values(guarded).returning();
  },
  async byWorkflow(workflow_id: string): Promise<WorkflowStep[]> {
    return db
      .select()
      .from(workflow_steps)
      .where(eq(workflow_steps.workflow_id, workflow_id))
      .orderBy(workflow_steps.ordem);
  },
};

export const entityStatesRepo = {
  async byId(entidade_id: string): Promise<EntityState | null> {
    const rows = await db
      .select()
      .from(entity_states)
      .where(eq(entity_states.entidade_id, entidade_id))
      .limit(1);
    return rows[0] ?? null;
  },
  async upsert(input: Partial<EntityState> & { entidade_id: string }): Promise<EntityState> {
    const rows = await db
      .insert(entity_states)
      .values({ entidade_id: input.entidade_id, contexto: input.contexto ?? {} })
      .onConflictDoUpdate({
        target: entity_states.entidade_id,
        set: { ...input, updated_at: new Date() },
      })
      .returning();
    return rows[0]!;
  },
};

export const selfStateRepo = {
  async getActive(): Promise<SelfState | null> {
    const rows = await db
      .select()
      .from(self_state)
      .where(eq(self_state.ativa, true))
      .orderBy(desc(self_state.versao))
      .limit(1);
    return rows[0] ?? null;
  },
  async appendLearning(learning: string): Promise<void> {
    const active = await this.getActive();
    if (!active) return;
    const prev = active.resumo_aprendizados ?? '';
    const lines = prev.split('\n').filter(Boolean);
    lines.push(`[${new Date().toISOString().slice(0, 10)}] ${learning}`);
    const trimmed = lines.slice(-50).join('\n');
    await db
      .update(self_state)
      .set({ resumo_aprendizados: trimmed })
      .where(eq(self_state.id, active.id));
  },
};

export const healthRepo = {
  async record(input: {
    component: string;
    status: 'ok' | 'degraded' | 'down';
    duration_ms?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await db.insert(system_health_events).values({
      component: input.component,
      status: input.status,
      duration_ms: input.duration_ms ?? null,
      error: input.error ?? null,
      metadata: input.metadata ?? {},
    });
  },
  async lastForComponent(component: string) {
    const rows = await db
      .select()
      .from(system_health_events)
      .where(eq(system_health_events.component, component))
      .orderBy(desc(system_health_events.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const dlqRepo = {
  async add(input: {
    queue_name: string;
    job_id: string;
    payload: unknown;
    error: string;
    attempts: number;
  }): Promise<{ id: string }> {
    const now = new Date();
    const rows = await db
      .insert(dead_letter_jobs)
      .values({
        queue_name: input.queue_name,
        job_id: input.job_id,
        payload: input.payload as object,
        error: input.error,
        attempts: input.attempts,
        first_failed_at: now,
        last_failed_at: now,
      })
      .returning({ id: dead_letter_jobs.id });
    return rows[0]!;
  },
  async listOpen(n = 100) {
    return db
      .select()
      .from(dead_letter_jobs)
      .where(eq(dead_letter_jobs.resolved, false))
      .orderBy(desc(dead_letter_jobs.created_at))
      .limit(n);
  },
  async countOpen(): Promise<number> {
    const r = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${dead_letter_jobs} WHERE resolved = false
    `);
    return (r.rows[0]?.c as number | undefined) ?? 0;
  },
  async resolve(id: string): Promise<void> {
    await db
      .update(dead_letter_jobs)
      .set({ resolved: true, resolved_at: new Date() })
      .where(eq(dead_letter_jobs.id, id));
  },
};

export const tenantsRepo = {
  async findById(id: string): Promise<Tenant | null> {
    const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async create(t: { id: string; nome: string; status?: string }): Promise<Tenant> {
    const [created] = await db.insert(tenants).values(t).returning();
    return created!;
  },

  // P3c Task 9: workers que precisam iterar todos os tenants (ex.: reaper)
  // chamam list() para fan-out. Cross-tenant por design — single point of
  // truth para enumeração, sem RLS implícito.
  async list(): Promise<Tenant[]> {
    return db.select().from(tenants).orderBy(tenants.id);
  },
};

export const agentsRepo = {
  async findById(id: string): Promise<Agent | null> {
    const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async listByTenant(tenant_id: string): Promise<Agent[]> {
    return db.select().from(agents).where(eq(agents.tenant_id, tenant_id));
  },
};

export const cognitiveModuleLogRepo = {
  // PR #75 review (Superpowers finding #6): cognitive_module_log é tenant-aware
  // (tenant_id + agent_id NOT NULL desde migration 008). O caller atual
  // (reflection.ts) já passa tenant_id/agent_id explicitamente e roda dentro
  // de runWithTenantContext, mas aplicamos `applyTenantGuard` aqui pra:
  //   1. Falhar fechado se algum caller futuro esquecer o contexto.
  //   2. Detectar mismatch entre input e contexto (caller passou tenant errado).
  // O DEFAULT 'default' do schema fica como rede de segurança em P0 — sweep
  // de DROP DEFAULT está agendado pro pós-P0 (finding #7).
  async record(entry: Omit<CognitiveModuleLog, 'id' | 'created_at'>): Promise<void> {
    const guarded = applyTenantGuard(entry as Record<string, unknown>);
    await db.insert(cognitive_module_log).values(guarded as typeof entry);
  },

  async recentByModule(module_name: string, limit = 100): Promise<CognitiveModuleLog[]> {
    return db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, module_name))
      .orderBy(desc(cognitive_module_log.created_at))
      .limit(limit);
  },
};

export const cognitiveCandidatesRepo = {
  async create(
    input: Omit<CognitiveCandidate, 'id' | 'created_at' | 'tenant_id' | 'agent_id' | 'status' | 'consumed_by_phase' | 'consumed_at'>,
  ): Promise<CognitiveCandidate> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(cognitive_candidates).values(guarded).returning();
    return row!;
  },

  async listPending(candidate_type?: string, limit = 100): Promise<CognitiveCandidate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conditions = [
      eq(cognitive_candidates.tenant_id, tenant_id),
      eq(cognitive_candidates.agent_id, agent_id),
      eq(cognitive_candidates.status, 'pending'),
    ];
    if (candidate_type) conditions.push(eq(cognitive_candidates.candidate_type, candidate_type));
    return db
      .select()
      .from(cognitive_candidates)
      .where(and(...conditions))
      .orderBy(desc(cognitive_candidates.created_at))
      .limit(limit);
  },

  async markConsumed(id: string, phase: string): Promise<void> {
    await db
      .update(cognitive_candidates)
      .set({ status: 'consumed', consumed_by_phase: phase, consumed_at: new Date() })
      .where(eq(cognitive_candidates.id, id));
  },

  /**
   * Returns the distinct (tenant_id, agent_id) pairs that own at least
   * one pending candidate of the requested type. Used by workers that
   * must fan out across tenants (e.g., procedure_candidate_consumer).
   *
   * NOTE: This method intentionally does NOT use the tenant guard —
   * iteration is part of the worker's contract. Callers MUST invoke it
   * once at worker startup and then wrap per-pair processing in
   * `runWithTenantContext`. (P83-C2)
   */
  async listPendingTenantPairsForType(
    candidate_type: string,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const rows = await db
      .selectDistinct({
        tenant_id: cognitive_candidates.tenant_id,
        agent_id: cognitive_candidates.agent_id,
      })
      .from(cognitive_candidates)
      .where(
        and(
          eq(cognitive_candidates.status, 'pending'),
          eq(cognitive_candidates.candidate_type, candidate_type),
        ),
      );
    return rows;
  },
};

export const memoryEntryRepo = {
  async create(
    input: Omit<
      MemoryEntry,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<MemoryEntry> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(memory_entry).values(guarded).returning();
    return row!;
  },

  async findRelevant(opts: {
    interlocutor_id?: string;
    role_id?: string;
    channel_id?: string;
    conversa_id?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(memory_entry.tenant_id, tenant_id),
      eq(memory_entry.agent_id, agent_id),
      eq(memory_entry.needs_review, false),
      // PR #82 review (Codex medium + Superpowers Critical #2): TTL must
      // be enforced at query time. Entries past expires_at MUST NOT be
      // returned to the prompt builder. NULL expires_at = no TTL.
      or(isNull(memory_entry.expires_at), gt(memory_entry.expires_at, now)),
      // P10a (review #104 critical): lifecycle_status filter enforced on
      // every prompt-exposing read. pending_review / deprecated / revoked
      // entries stay hidden from the LLM.
      inArray(memory_entry.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    // Filtrar por scope_type + subject_id apropriado. PR #82 review
    // (Superpowers Critical #4): role/channel devem só ser incluídos
    // quando o caller passar o subject id correspondente — senão a
    // memória escopada por role/channel atravessa todas as fronteiras.
    const orConds = [];
    if (opts.interlocutor_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'interlocutor'),
          eq(memory_entry.subject_id, opts.interlocutor_id),
        ),
      );
    }
    if (opts.role_id) {
      orConds.push(
        and(eq(memory_entry.scope_type, 'role'), eq(memory_entry.subject_id, opts.role_id)),
      );
    }
    if (opts.channel_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'channel'),
          eq(memory_entry.subject_id, opts.channel_id),
        ),
      );
    }
    if (opts.conversa_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'conversation'),
          eq(memory_entry.subject_id, opts.conversa_id),
        ),
      );
    }
    orConds.push(eq(memory_entry.scope_type, 'agent'));

    return db
      .select()
      .from(memory_entry)
      .where(and(...conds, or(...orConds)))
      .orderBy(desc(memory_entry.created_at))
      .limit(opts.limit ?? 50);
  },

  async markReviewed(
    id: string,
    updates: {
      memory_type: string;
      sensitivity: string;
      proactive_use: boolean;
      mention_allowed: boolean;
      ttl_days?: number | null;
      scope_type?: string;
      subject_id?: string;
    },
  ): Promise<void> {
    // PR #82 review (Superpowers Critical #3): when promoting a candidate
    // out of needs_review, compute expires_at from ttl_days so that the
    // TTL filter in findRelevant can actually evict the row. Without this
    // a sensitive memory with ttl_days=7 was kept indefinitely.
    const expires_at =
      updates.ttl_days != null
        ? new Date(Date.now() + updates.ttl_days * 24 * 60 * 60 * 1000)
        : null;
    await db
      .update(memory_entry)
      .set({ ...updates, expires_at, needs_review: false, updated_at: new Date() })
      .where(eq(memory_entry.id, id));
  },

  async listNeedsReview(limit = 100): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(memory_entry)
      .where(
        and(
          eq(memory_entry.tenant_id, tenant_id),
          eq(memory_entry.agent_id, agent_id),
          eq(memory_entry.needs_review, true),
        ),
      )
      .limit(limit);
  },
};

export const behavioralHintRepo = {
  async create(
    input: Omit<
      BehavioralHint,
      | 'id'
      | 'created_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns + updated_at have DB defaults — callers
      // don't supply them.
      | 'updated_at'
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<BehavioralHint> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(behavioral_hint).values(guarded).returning();
    return row!;
  },

  async findActiveForScope(opts: {
    scope_type: string;
    subject_id?: string | null;
  }): Promise<BehavioralHint[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(behavioral_hint.tenant_id, tenant_id),
      eq(behavioral_hint.agent_id, agent_id),
      eq(behavioral_hint.scope_type, opts.scope_type),
      isNull(behavioral_hint.revoked_at),
      // P10a (review #104 critical): hints proposed via propose_hint
      // start in pending_review / ephemeral. The LLM-facing path must
      // include only visible states so a pending hint never steers
      // behavior before a human approves it.
      inArray(behavioral_hint.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    if (opts.subject_id) conds.push(eq(behavioral_hint.subject_id, opts.subject_id));
    return db
      .select()
      .from(behavioral_hint)
      .where(
        and(
          ...conds,
          or(isNull(behavioral_hint.expires_at), gt(behavioral_hint.expires_at, now)),
        ),
      );
  },

  async revoke(id: string): Promise<void> {
    await db
      .update(behavioral_hint)
      .set({ revoked_at: new Date() })
      .where(eq(behavioral_hint.id, id));
  },
};

export const capabilitiesDomainRepo = {
  async findByDomain(domain: string): Promise<AgentCapabilityDomain | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
          eq(agent_capabilities_domain.domain, domain),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    updates: Partial<AgentCapabilityDomain>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Try update first
    const existing = await capabilitiesDomainRepo.findByDomain(domain);
    if (existing) {
      await db
        .update(agent_capabilities_domain)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_domain.id, existing.id));
    } else {
      await db.insert(agent_capabilities_domain).values({
        tenant_id,
        agent_id,
        domain,
        ...updates,
      } as typeof agent_capabilities_domain.$inferInsert);
    }
  },

  async listAll(): Promise<AgentCapabilityDomain[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
        ),
      );
  },
};

export const capabilitiesSkillRepo = {
  async findBySkill(domain: string, skill_name: string): Promise<AgentCapabilitySkill | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
          eq(agent_capabilities_skill.skill_name, skill_name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    skill_name: string,
    updates: Partial<AgentCapabilitySkill>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const existing = await capabilitiesSkillRepo.findBySkill(domain, skill_name);
    if (existing) {
      await db
        .update(agent_capabilities_skill)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_skill.id, existing.id));
    } else {
      await db.insert(agent_capabilities_skill).values({
        tenant_id,
        agent_id,
        domain,
        skill_name,
        ...updates,
      } as typeof agent_capabilities_skill.$inferInsert);
    }
  },

  async listByDomain(domain: string): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
        ),
      );
  },

  async listAll(): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
        ),
      );
  },
};

export const capabilityGapsRepo = {
  async upsert(input: {
    capability_description: string;
    tipo: 'tool' | 'knowledge' | 'procedure';
    contexto?: string;
    source_candidate_id?: string;
  }): Promise<AgentCapabilityGap> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Simple match by description (LIKE or exact); P3+ pode usar embedding similarity
    const existing = await db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.capability_description, input.capability_description),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(agent_capability_gaps)
        .set({
          frequency_score: existing[0].frequency_score + 1,
          last_observed: new Date(),
        })
        .where(eq(agent_capability_gaps.id, existing[0].id));
      return existing[0];
    }

    const [created] = await db
      .insert(agent_capability_gaps)
      .values({
        tenant_id,
        agent_id,
        capability_description: input.capability_description,
        tipo: input.tipo,
        contexto: input.contexto ?? null,
        source_candidate_id: input.source_candidate_id ?? null,
      } as typeof agent_capability_gaps.$inferInsert)
      .returning();
    return created!;
  },

  async listByLevel(level: string): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.current_level, level),
        ),
      );
  },

  async escalateLevel(id: string, new_level: string): Promise<void> {
    await db
      .update(agent_capability_gaps)
      .set({ current_level: new_level, last_level_change_at: new Date() })
      .where(eq(agent_capability_gaps.id, id));
  },

  // P5: extensions ------------------------------------------------------------
  // listByLevels: plural variant for the escalation engine that needs to load
  // every gap in a set of current levels (e.g. ['silent', 'dashboard']) in one
  // query before running level-transition rules.
  async listByLevels(levels: GapLevel[]): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    if (levels.length === 0) return [];
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          inArray(agent_capability_gaps.current_level, levels),
        ),
      );
  },

  // P5: updateLevel — typed args variant of escalateLevel, scoped by the
  // current tenant/agent context (defense in depth: even with a leaked id
  // from another tenant, the WHERE clause filters it out). Sets
  // last_level_change_at = now() which the cooldown logic depends on.
  async updateLevel(args: { id: string; new_level: GapLevel }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(agent_capability_gaps)
      .set({ current_level: args.new_level, last_level_change_at: new Date() })
      .where(
        and(
          eq(agent_capability_gaps.id, args.id),
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
        ),
      );
  },

  // P5: daysSinceLastProposed — tenant/agent-wide MAX(last_level_change_at)
  // where current_level='proposed'. Used by the escalation engine to enforce
  // cooldown_days_proposed_to_proposed: do not raise another gap to 'proposed'
  // if the last one happened recently. Returns null if no gap was ever
  // promoted to 'proposed' for this (tenant, agent).
  async daysSinceLastProposed(): Promise<number | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ days: number | null }>(sql`
      SELECT EXTRACT(DAY FROM (now() - MAX(last_level_change_at)))::int AS days
        FROM agent_capability_gaps
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND current_level = 'proposed'
    `);
    const first = result.rows[0];
    if (!first) return null;
    return first.days ?? null;
  },

  // P5: create — straight insert via applyTenantGuard (no de-dup by
  // description like upsert does). Used by call-sites that already know
  // the gap is new — typically the dialogical-acquisition engine creating
  // technical_gap rows derived from a failed capability_test_result, where
  // grouping by description would be incorrect.
  async create(input: {
    capability_description: string;
    tipo: string;
    contexto?: string;
  }): Promise<AgentCapabilityGap> {
    const guarded = applyTenantGuard({
      capability_description: input.capability_description,
      tipo: input.tipo,
      contexto: input.contexto ?? null,
    });
    const [row] = await db
      .insert(agent_capability_gaps)
      .values(guarded as typeof agent_capability_gaps.$inferInsert)
      .returning();
    return row!;
  },
};

export const procedureDefinitionsRepo = {
  async create(
    input: Omit<ProcedureDefinition, 'id' | 'created_at' | 'updated_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<ProcedureDefinition> {
    const guarded = applyTenantGuard(input);
    const [row] = await db
      .insert(procedure_definitions)
      .values(guarded as typeof procedure_definitions.$inferInsert)
      .returning();
    return row!;
  },

  async findActiveByName(nome: string): Promise<ProcedureDefinition | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.nome, nome),
        eq(procedure_definitions.status, 'active'),
      ))
      .orderBy(desc(procedure_definitions.version_number))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Tenant-scoped findById. Returns null if the row exists but belongs
   * to a different tenant/agent (P83-H5: prevent cross-tenant access by id).
   */
  async findById(id: string): Promise<ProcedureDefinition | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.id, id),
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: string, limit = 100): Promise<ProcedureDefinition[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.status, status),
      ))
      .orderBy(desc(procedure_definitions.created_at))
      .limit(limit);
  },

  /**
   * Tenant-scoped status update. (P83-H5)
   * Returns number of affected rows so callers can detect cross-tenant
   * attempts (0 rows updated = id belongs to another tenant or doesn't exist).
   */
  async updateStatus(id: string, updates: ProcedureStatusUpdate): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(procedure_definitions)
      .set({ ...updates, updated_at: new Date() })
      .where(and(
        eq(procedure_definitions.id, id),
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
      ))
      .returning({ id: procedure_definitions.id });
    return rows.length;
  },

  async listAllVersionsByName(nome: string): Promise<ProcedureDefinition[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.nome, nome),
      ))
      .orderBy(desc(procedure_definitions.version_number));
  },

  /**
   * Atomically activate `target_id` and freeze any other active version
   * of the same `nome` within the same tenant/agent. The whole operation
   * runs in a single transaction with row-level locking so concurrent
   * approvers cannot leave two rows in `status='active'`. Combined with
   * the UNIQUE partial index `procedure_def_active_uniq_idx`, this makes
   * dual-active a hard impossibility at both the application and DB
   * layers. (P83-C4)
   */
  async atomicActivate(args: {
    target_id: string;
    actor: string;
    preserve_activated_at?: boolean;
  }): Promise<{
    activated: ProcedureDefinition;
    deactivated: ProcedureDefinition | null;
  }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();

    return withTx(async (tx) => {
      // 1) Lock the row we want to activate FOR UPDATE. Also confirms
      // tenant-scope.
      const targetRows = await tx
        .select()
        .from(procedure_definitions)
        .where(and(
          eq(procedure_definitions.id, args.target_id),
          eq(procedure_definitions.tenant_id, tenant_id),
          eq(procedure_definitions.agent_id, agent_id),
        ))
        .for('update');
      const target = targetRows[0];
      if (!target) {
        throw new Error(`procedure_definition ${args.target_id} not found in current tenant`);
      }

      // 2) Lock any currently active sibling rows (same nome) so two
      // concurrent activations serialize on this set.
      const activeSiblings = await tx
        .select()
        .from(procedure_definitions)
        .where(and(
          eq(procedure_definitions.tenant_id, tenant_id),
          eq(procedure_definitions.agent_id, agent_id),
          eq(procedure_definitions.nome, target.nome),
          eq(procedure_definitions.status, 'active'),
          ne(procedure_definitions.id, target.id),
        ))
        .for('update');

      let deactivated: ProcedureDefinition | null = null;
      if (activeSiblings.length > 0) {
        // Migrate constraint guarantees at most one, but we defensively
        // handle a list. Freeze each, then return the first as the
        // deactivated row.
        for (const sib of activeSiblings) {
          const [updated] = await tx
            .update(procedure_definitions)
            .set({ status: 'frozen', deactivated_at: now, updated_at: now })
            .where(eq(procedure_definitions.id, sib.id))
            .returning();
          if (updated && !deactivated) deactivated = updated;
        }
      }

      // 3) Promote the target to active. Preserve original activated_at
      // if it was already set (H1 — keep first-activation timestamp).
      const setPayload: ProcedureStatusUpdate & { updated_at: Date } = {
        status: 'active',
        approved_by: args.actor,
        approved_at: now,
        deactivated_at: null,
        updated_at: now,
      };
      if (!args.preserve_activated_at || target.activated_at == null) {
        setPayload.activated_at = now;
      }
      const [activated] = await tx
        .update(procedure_definitions)
        .set(setPayload)
        .where(eq(procedure_definitions.id, target.id))
        .returning();
      if (!activated) {
        throw new Error(`procedure_definition ${target.id} disappeared mid-transaction`);
      }

      // 4) Append event-sourcing rows for the audit trail (H2).
      await tx.insert(procedure_status_events).values({
        tenant_id,
        agent_id,
        definition_id: target.id,
        from_status: target.status,
        to_status: 'active',
        actor: args.actor,
      });
      if (deactivated) {
        await tx.insert(procedure_status_events).values({
          tenant_id,
          agent_id,
          definition_id: deactivated.id,
          from_status: 'active',
          to_status: 'frozen',
          actor: args.actor,
          reason: `superseded by ${target.id}`,
        });
      }

      return { activated, deactivated };
    });
  },
};

export const procedureStatusEventsRepo = {
  async record(input: {
    definition_id: string;
    from_status: string;
    to_status: string;
    actor: string;
    reason?: string;
  }): Promise<void> {
    const guarded = applyTenantGuard({
      definition_id: input.definition_id,
      from_status: input.from_status,
      to_status: input.to_status,
      actor: input.actor,
      reason: input.reason ?? null,
    });
    await db.insert(procedure_status_events).values(guarded);
  },

  async listByDefinition(definition_id: string): Promise<ProcedureStatusEvent[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_status_events)
      .where(and(
        eq(procedure_status_events.tenant_id, tenant_id),
        eq(procedure_status_events.agent_id, agent_id),
        eq(procedure_status_events.definition_id, definition_id),
      ))
      .orderBy(desc(procedure_status_events.occurred_at));
  },
};

export const procedureAssignmentsRepo = {
  /**
   * Create an assignment. P83-H6: refuses to assign a procedure whose
   * `definition_id` belongs to a different tenant. The FK only enforces
   * referential integrity, not tenant-isolation, so we cross-check here.
   */
  async create(
    input: Omit<ProcedureAssignment, 'id' | 'activated_at' | 'tenant_id'>,
  ): Promise<ProcedureAssignment> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // Verify the referenced definition is in the caller's tenant.
    const defRows = await db
      .select({
        id: procedure_definitions.id,
        tenant_id: procedure_definitions.tenant_id,
        agent_id: procedure_definitions.agent_id,
      })
      .from(procedure_definitions)
      .where(eq(procedure_definitions.id, input.definition_id))
      .limit(1);
    const def = defRows[0];
    if (!def) {
      throw new Error(`procedure_definition ${input.definition_id} does not exist`);
    }
    if (def.tenant_id !== tenant_id || def.agent_id !== agent_id) {
      throw new Error(
        `cross-tenant assignment refused: definition ${input.definition_id} belongs to a different tenant/agent`,
      );
    }

    const [row] = await db
      .insert(procedure_assignments)
      .values({ ...input, tenant_id } as typeof procedure_assignments.$inferInsert)
      .returning();
    return row!;
  },

  async listForTarget(target_type: string, target_id: string): Promise<ProcedureAssignment[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(procedure_assignments)
      .where(and(
        eq(procedure_assignments.tenant_id, tenant_id),
        eq(procedure_assignments.target_type, target_type),
        eq(procedure_assignments.target_id, target_id),
        eq(procedure_assignments.enabled, true),
      ));
  },

  async disable(id: string): Promise<void> {
    await db
      .update(procedure_assignments)
      .set({ enabled: false, deactivated_at: new Date() })
      .where(eq(procedure_assignments.id, id));
  },
};

export const procedureExecutionsRepo = {
  async create(
    input: Omit<ProcedureExecution, 'id' | 'started_at' | 'last_activity_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<ProcedureExecution> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(procedure_executions).values(guarded as any).returning();
    return row!;
  },

  async findActiveForConversa(conversa_id: string): Promise<ProcedureExecution | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_executions)
      .where(and(
        eq(procedure_executions.tenant_id, tenant_id),
        eq(procedure_executions.agent_id, agent_id),
        eq(procedure_executions.conversa_id, conversa_id),
        eq(procedure_executions.status, 'in_progress'),
      ))
      .orderBy(desc(procedure_executions.last_activity_at))
      .limit(1);
    return rows[0] ?? null;
  },

  // P84-C1: tenant-scoped read. The previous implementation queried by id
  // alone — UUID collisions are astronomically unlikely but the project's
  // tenant-isolation invariant is structural, not probabilistic. Every
  // cross-tenant query path must be closed by code.
  async findById(id: string): Promise<ProcedureExecution | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_executions)
      .where(and(
        eq(procedure_executions.id, id),
        eq(procedure_executions.tenant_id, tenant_id),
        eq(procedure_executions.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  // P84-C2: tenant-scoped create with ON CONFLICT no-op on the
  // (tenant,agent,conversa) WHERE status='in_progress' partial unique index
  // shipped in migration 023. When two workers race and both see
  // activeExecution=null → both call startExecution, the second insert is
  // rejected by the constraint; we swallow it and return null so the caller
  // re-loads the active row.
  async createOrFindActive(
    input: Omit<ProcedureExecution, 'id' | 'started_at' | 'last_activity_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<{ execution: ProcedureExecution; created: boolean }> {
    const guarded = applyTenantGuard(input);
    const rows = await db
      .insert(procedure_executions)
      .values(guarded as any)
      .onConflictDoNothing({
        target: [
          procedure_executions.tenant_id,
          procedure_executions.agent_id,
          procedure_executions.conversa_id,
        ],
        // index_predicate for the partial unique index defined in
        // migration 023_p3b_unique_in_progress_per_conversa.sql. The
        // predicate MUST match the migration's `WHERE` exactly so Postgres'
        // partial-index inference engine can match this ON CONFLICT to the
        // index — relying on column-presence inference alone is brittle.
        where: sql`status = 'in_progress' AND conversa_id IS NOT NULL`,
      })
      .returning();

    if (rows[0]) {
      return { execution: rows[0], created: true };
    }

    // Conflict path: another worker created an in_progress execution for
    // the same conversa concurrently. Re-load and return it. conversa_id
    // is guaranteed non-null here because the partial index only applies
    // when conversa_id IS NOT NULL (and a null conversa_id can't conflict).
    if (guarded.conversa_id == null) {
      throw new Error('procedureExecutionsRepo.createOrFindActive: insert returned no row and conversa_id is null');
    }
    const existing = await procedureExecutionsRepo.findActiveForConversa(guarded.conversa_id as string);
    if (!existing) {
      throw new Error('procedureExecutionsRepo.createOrFindActive: conflict but no active row found');
    }
    return { execution: existing, created: false };
  },

  // P84-C5 / P3c fix P85-I1: transaction-aware variant. When called from
  // inside a withTx() block, all writes commit together with the caller's
  // events. Used by the engine (advance/complete/abort) and by the reaper
  // (auto_abandoned event + status update must be atomic — without this, a
  // process crash between event-write and status-write produces a duplicate
  // auto_abandoned event on the next reaper tick).
  async updateStateTx(
    tx: typeof db,
    id: string,
    updates: Partial<{
      current_step_id: string | null;
      execution_state: any;
      completed_steps: any;
      last_activity_at: Date;
      status: string;
      outcome: string;
      ended_at: Date;
      notes: string;
    }>,
  ): Promise<void> {
    await tx
      .update(procedure_executions)
      .set({ ...updates, last_activity_at: new Date() } as any)
      .where(eq(procedure_executions.id, id));
  },

  async updateState(
    id: string,
    updates: Partial<{
      current_step_id: string | null;
      execution_state: any;
      completed_steps: any;
      last_activity_at: Date;
      status: string;
      outcome: string;
      ended_at: Date;
      notes: string;
    }>,
  ): Promise<void> {
    await db
      .update(procedure_executions)
      .set({ ...updates, last_activity_at: new Date() } as any)
      .where(eq(procedure_executions.id, id));
  },

  // P3c Task 9 — reaper helper. Retorna execuções do tenant atual ainda em
  // status='in_progress' cuja last_activity_at < now() - ttl_days. Workers
  // chamam dentro de runWithTenantContext para isolar por tenant.
  //
  // PR #85 fix P85-I6: cap result size with `limit` (default 1000) to keep
  // the per-tick cost bounded. After a long outage this prevents one cron
  // tick from grinding through tens of thousands of stale rows in a single
  // sequential pass and overlapping with the next tick. Reaper is
  // idempotent across runs (combined with P85-I1's transactional write),
  // so the leftover backlog drains on subsequent ticks.
  async listStaleInProgress(opts: {
    ttl_days: number;
    limit?: number;
  }): Promise<ProcedureExecution[]> {
    const tenant_id = getCurrentTenant();
    const cutoff = new Date(Date.now() - opts.ttl_days * 86_400_000);
    const cap = opts.limit ?? 1000;
    return db
      .select()
      .from(procedure_executions)
      .where(
        and(
          eq(procedure_executions.tenant_id, tenant_id),
          eq(procedure_executions.status, 'in_progress'),
          lt(procedure_executions.last_activity_at, cutoff),
        ),
      )
      .limit(cap);
  },
};

export const procedureExecutionEventsRepo = {
  async record(
    input: Omit<ProcedureExecutionEvent, 'id' | 'created_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(procedure_execution_events).values(guarded as any);
  },

  // P84-C5 / P3c fix P85-I1: transaction-aware variant. Lets the engine
  // commit recordEvent+updateState atomically inside withTx(), and lets the
  // reaper atomically pair the audit-event INSERT with the
  // procedure-execution UPDATE. The applyTenantGuard call still binds
  // tenant/agent from AsyncLocalStorage so tenant isolation is preserved
  // across the transaction boundary.
  async recordTx(
    tx: typeof db,
    input: Omit<ProcedureExecutionEvent, 'id' | 'created_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await tx.insert(procedure_execution_events).values(guarded as any);
  },

  // P84-C1: tenant-scoped read. Mirror the pattern in findById — never
  // trust the execution_id alone, even though FKs make a cross-tenant
  // collision unlikely. Audit trail reads must respect tenant boundaries.
  async listByExecution(execution_id: string): Promise<ProcedureExecutionEvent[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_execution_events)
      .where(and(
        eq(procedure_execution_events.execution_id, execution_id),
        eq(procedure_execution_events.tenant_id, tenant_id),
        eq(procedure_execution_events.agent_id, agent_id),
      ))
      .orderBy(procedure_execution_events.created_at);
  },
};

export const procedureSelectorDecisionsRepo = {
  async record(
    input: Omit<ProcedureSelectorDecision, 'id' | 'decided_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(procedure_selector_decisions).values(guarded as any);
  },

  async recentByConversa(conversa_id: string, limit = 20): Promise<ProcedureSelectorDecision[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(procedure_selector_decisions)
      .where(and(
        eq(procedure_selector_decisions.tenant_id, tenant_id),
        eq(procedure_selector_decisions.conversa_id, conversa_id),
      ))
      .orderBy(desc(procedure_selector_decisions.decided_at))
      .limit(limit);
  },
};

// P3c: procedure_tests — cenários executáveis usados como gate de promoção
// proposed → active. `recordRun` é chamado pelo test-runner; `allPassFor` é
// o predicado consultado por `transitionProcedureStatus` antes de ativar.
export const procedureTestsRepo = {
  async create(input: {
    definition_id: string;
    name: string;
    description?: string;
    scenario: unknown;
    expected_outcome: 'success' | 'failure' | 'partial' | 'escalated';
    expected_step_path?: unknown;
  }): Promise<ProcedureTest> {
    const guarded = applyTenantGuard({
      definition_id: input.definition_id,
      name: input.name,
      description: input.description ?? null,
      scenario: input.scenario as object,
      expected_outcome: input.expected_outcome,
      expected_step_path: (input.expected_step_path ?? null) as object | null,
    });
    const [row] = await db.insert(procedure_tests).values(guarded as any).returning();
    return row!;
  },

  async listByDefinition(definition_id: string): Promise<ProcedureTest[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_tests)
      .where(and(
        eq(procedure_tests.tenant_id, tenant_id),
        eq(procedure_tests.agent_id, agent_id),
        eq(procedure_tests.definition_id, definition_id),
      ))
      .orderBy(procedure_tests.created_at);
  },

  async recordRun(args: {
    id: string;
    status: 'pass' | 'fail' | 'error' | 'skipped';
    details: unknown;
  }): Promise<void> {
    await db
      .update(procedure_tests)
      .set({
        last_run_at: new Date(),
        last_run_status: args.status,
        last_run_details: args.details as object,
        updated_at: new Date(),
      })
      .where(eq(procedure_tests.id, args.id));
  },

  // True iff there's >=1 test AND ALL have last_run_status='pass'.
  // Used as gate before promoting proposed → active.
  async allPassFor(definition_id: string): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ last_run_status: procedure_tests.last_run_status })
      .from(procedure_tests)
      .where(and(
        eq(procedure_tests.tenant_id, tenant_id),
        eq(procedure_tests.agent_id, agent_id),
        eq(procedure_tests.definition_id, definition_id),
      ));
    if (rows.length === 0) return false;
    return rows.every((r) => r.last_run_status === 'pass');
  },

  async delete(id: string): Promise<void> {
    await db.delete(procedure_tests).where(eq(procedure_tests.id, id));
  },
};

// P3c: procedure_metrics — read-only access to the materialized view.
// Refresh is owned by a worker; this repo only exposes reads, filtered by
// tenant/agent context (still applyTenantGuard-equivalent: every select
// includes tenant + agent from the AsyncLocalStorage).
export const procedureMetricsRepo = {
  async getByDefinition(definition_id: string): Promise<ProcedureMetric | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_metrics)
      .where(and(
        eq(procedure_metrics.tenant_id, tenant_id),
        eq(procedure_metrics.agent_id, agent_id),
        eq(procedure_metrics.definition_id, definition_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByTenantAgent(): Promise<ProcedureMetric[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_metrics)
      .where(and(
        eq(procedure_metrics.tenant_id, tenant_id),
        eq(procedure_metrics.agent_id, agent_id),
      ));
  },
};
export const operationalProfileVersionsRepo = {
  async create(input: {
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason?: string;
  }): Promise<AgentOperationalProfileVersion> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const version = await operationalProfileVersionsRepo.nextVersion();
    const guarded = applyTenantGuard({
      version,
      status: 'proposed',
      profile_body: input.profile_body,
      proposed_by: input.proposed_by,
      proposed_reason: input.proposed_reason ?? null,
    });
    // tenant_id/agent_id são injetados pelo applyTenantGuard. Os types do
    // Drizzle agora alinham naturalmente com o $inferInsert da tabela (1
    // coluna JSONB `profile_body` em vez das 4 legacy) — sem cast necessário.
    void tenant_id;
    void agent_id;
    const [row] = await db
      .insert(agent_operational_profile_versions)
      .values(guarded)
      .returning();
    return row!;
  },

  async getActive(): Promise<AgentOperationalProfileVersion | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
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
    return rows[0] ?? null;
  },

  async getById(id: string): Promise<AgentOperationalProfileVersion | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProfileStatus): Promise<AgentOperationalProfileVersion[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.status, status),
        ),
      )
      .orderBy(desc(agent_operational_profile_versions.version));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido
  // - terminal:            row já está rolled_back (terminal)
  // - invalid_transition:  destino não permitido a partir do source ou same-state
  // - already_has_active:  to:'active' mas outra row ativa existe para (tenant,agent)
  async transition(args: {
    id: string;
    to: ProfileStatus;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<
    | { ok: true; updated: AgentOperationalProfileVersion }
    | { ok: false; reason: 'not_found' | 'invalid_transition' | 'already_has_active' | 'terminal' }
  > {
    const row = await operationalProfileVersionsRepo.getById(args.id);
    if (!row) return { ok: false, reason: 'not_found' };

    const from = row.status as ProfileStatus;
    if (from === 'rolled_back') return { ok: false, reason: 'terminal' };
    if (from === args.to) return { ok: false, reason: 'invalid_transition' };

    const allowed: Record<string, readonly string[]> = {
      proposed: ['active', 'frozen', 'rolled_back'],
      active: ['frozen', 'rolled_back'],
      frozen: ['active', 'rolled_back'],
    };
    if (!allowed[from]?.includes(args.to)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    if (args.to === 'active') {
      const active = await operationalProfileVersionsRepo.getActive();
      if (active && active.id !== row.id) {
        return { ok: false, reason: 'already_has_active' };
      }
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status: args.to };
    if (args.to === 'active') {
      // approved_at é definido na primeira vez que se aprova; re-ativações
      // a partir de frozen preservam o approved_at original.
      if (!row.approved_at) {
        patch.approved_at = now;
        if (args.approved_by) patch.approved_by = args.approved_by;
      }
      patch.activated_at = now;
    } else if (args.to === 'frozen') {
      patch.frozen_at = now;
    } else if (args.to === 'rolled_back') {
      patch.rolled_back_at = now;
      patch.rollback_reason = args.rollback_reason ?? null;
    }

    // [P86-C3] tenant-scoped write predicate: even though `getById` above
    // already filtered by tenant_id/agent_id, the actual UPDATE must
    // include them in WHERE as defense-in-depth (an alert UUID alone is
    // not enough authorization to mutate identity in a different tenant
    // context). This is the inviolable tenant isolation invariant.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const [updated] = await db
      .update(agent_operational_profile_versions)
      .set(patch as Partial<typeof agent_operational_profile_versions.$inferInsert>)
      .where(
        and(
          eq(agent_operational_profile_versions.id, args.id),
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
        ),
      )
      .returning();
    if (!updated) {
      // Could only happen if tenant context changed between the read above
      // and the update — treat as not_found to keep the contract.
      return { ok: false, reason: 'not_found' };
    }
    return { ok: true, updated };
  },

  // Próxima version sequencial para (tenant_id, agent_id) corrente.
  // MAX(version) + 1, ou 1 quando não existe versão ainda.
  async nextVersion(): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ max: number | null }>(sql`
      SELECT MAX(version) AS max
        FROM agent_operational_profile_versions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
    `);
    const max = result.rows[0]?.max ?? null;
    return max == null ? 1 : Number(max) + 1;
  },
};

// P4: agent_drift_alerts — audit das execuções do drift detector.
// Cada alert = 1 evento (drift_type, severity, decision) + evidência + audit
// trail (decided_by, resolved_by, resolution_note). FK opcional para
// agent_operational_profile_versions porque drifts podem ser detectados antes
// de uma nova versão de perfil ser proposta.
export const driftAlertsRepo = {
  async create(input: {
    profile_version_id?: string;
    drift_type: DriftType;
    severity: DriftSeverity;
    evidence: unknown;
    detected_by: string;
    decision: DriftDecision;
    decided_by: string;
  }): Promise<AgentDriftAlert> {
    const guarded = applyTenantGuard({
      profile_version_id: input.profile_version_id ?? null,
      drift_type: input.drift_type,
      severity: input.severity,
      evidence: input.evidence as object,
      detected_by: input.detected_by,
      decision: input.decision,
      decided_by: input.decided_by,
    });
    const [row] = await db
      .insert(agent_drift_alerts)
      .values(guarded as typeof agent_drift_alerts.$inferInsert)
      .returning();
    return row!;
  },

  async listUnresolved(): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          isNull(agent_drift_alerts.resolved_at),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  async listByProfileVersion(profile_version_id: string): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          eq(agent_drift_alerts.profile_version_id, profile_version_id),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  // [P86-C3] tenant-scoped: includes tenant_id AND agent_id predicates in
  // the UPDATE so an alert UUID from another tenant cannot be resolved from
  // the wrong context. Returns { ok, found } so callers can detect a
  // forbidden/missing target without silently no-op'ing.
  async resolve(args: {
    id: string;
    resolution_note: string;
    resolved_by: string;
  }): Promise<{ ok: boolean; found: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(agent_drift_alerts)
      .set({
        resolution_note: args.resolution_note,
        resolved_at: new Date(),
        resolved_by: args.resolved_by,
      })
      .where(
        and(
          eq(agent_drift_alerts.id, args.id),
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
        ),
      )
      .returning({ id: agent_drift_alerts.id });
    return { ok: updated.length > 0, found: updated.length > 0 };
  },
};

// P5: gap_escalation_rules — thresholds determinísticos por (tenant_id, agent_id)
// para a escalation chain (silent → dashboard → mentionable → proposed).
// Defaults vivem no schema; este repo expõe getForCurrentAgent (null se nenhuma
// regra customizada) e upsert (ON CONFLICT via UNIQUE(tenant_id, agent_id)).
export const gapEscalationRulesRepo = {
  async getForCurrentAgent(): Promise<GapEscalationRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(gap_escalation_rules)
      .where(
        and(
          eq(gap_escalation_rules.tenant_id, tenant_id),
          eq(gap_escalation_rules.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsert(input: Partial<NewGapEscalationRule>): Promise<GapEscalationRule> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Strip any tenant/agent the caller might have supplied — applyTenantGuard
    // semantics: context wins, mismatch throws.
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = input;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const now = new Date();
    const [row] = await db
      .insert(gap_escalation_rules)
      .values({
        ...rest,
        tenant_id,
        agent_id,
        updated_at: now,
      } as typeof gap_escalation_rules.$inferInsert)
      .onConflictDoUpdate({
        target: [gap_escalation_rules.tenant_id, gap_escalation_rules.agent_id],
        set: {
          ...rest,
          updated_at: now,
        },
      })
      .returning();
    return row!;
  },
};

// P5: capability_proposals — propostas formais de capability (spec gerada por
// LLM no nível 'proposed'). Fluxo de status:
//   draft → submitted → approved | rejected
//   approved → delivered
//   rejected | delivered = terminal
// transition() é typed-result (sem throw): { ok:true, updated } | { ok:false,
// reason: 'not_found' | 'invalid_transition' }. Cada transição seta um
// timestamp (submitted_at | decided_at | delivered_at) + campos opcionais
// (decided_by, decision_reason, delivery_artifact_ref).
export const capabilityProposalsRepo = {
  async create(input: {
    gap_id?: string;
    capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
    title: string;
    description: string;
    proposed_spec: unknown;
    motivation: string;
    expected_impact?: string;
    test_scenarios: unknown[];
  }): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await db
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  // PR #87 follow-up — transactional variant of create. Writes via the
  // caller-supplied `tx` handle so the INSERT participates in an outer
  // withTx block. Pairs with capabilityGapsRepo.updateLevelTx so the
  // gap-escalation worker can commit the proposal artifact and the gap
  // level flip in a single transaction; transient failure during the
  // gap UPDATE rolls back the proposal INSERT so the next worker tick
  // does NOT produce a duplicate proposal row.
  async createTx(
    tx: typeof db,
    input: {
      gap_id?: string;
      capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
      title: string;
      description: string;
      proposed_spec: unknown;
      motivation: string;
      expected_impact?: string;
      test_scenarios: unknown[];
    },
  ): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await tx
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<CapabilityProposal | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProposalStatus): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.status, status),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  async listByGap(gap_id: string): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.gap_id, gap_id),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido (ou fora do tenant/agent atual)
  // - invalid_transition:  destino não permitido a partir do source, mesmo
  //                        status (re-entrada), ou origem terminal
  //                        (rejected/reverted).
  //
  // P87-C3 (PR #87 review): activation gate. A transição approved → delivered
  // foi removida — agora exige caminho approved → testing → delivered (sucesso)
  // ou approved → testing → reverted (falha). A wiring é feita por
  // activateApprovedCapability (capability-test-runner.ts), que é o ÚNICO
  // caller production-grade do trio approved → testing → {delivered|reverted}.
  // Chamadas diretas a transition({to:'delivered'}) continuam permitidas a
  // partir de 'testing', NUNCA a partir de 'approved'.
  //
  // Side effects (timestamps + opcionais):
  //   to:'submitted' → submitted_at
  //   to:'approved'  → decided_at + decided_by? + decision_reason?
  //   to:'rejected'  → decided_at + decided_by? + decision_reason?
  //   to:'testing'   → (sem timestamp dedicado; updated_at marca)
  //   to:'delivered' → delivered_at + delivery_artifact_ref?
  //                    + last_test_outcome? + last_test_at?
  //   to:'reverted'  → reverted_at + revert_reason?
  //                    + last_test_outcome? + last_test_at?
  async transition(args: {
    id: string;
    to: ProposalStatus;
    decided_by?: string;
    decision_reason?: string;
    delivery_artifact_ref?: string;
    revert_reason?: string;
    last_test_outcome?: 'pass' | 'fail' | 'error';
  }): Promise<
    | { ok: true; updated: CapabilityProposal }
    | { ok: false; reason: 'not_found' | 'invalid_transition' }
  > {
    const row = await capabilityProposalsRepo.getById(args.id);
    if (!row) return { ok: false, reason: 'not_found' };

    const from = row.status as ProposalStatus;
    // Terminal sources — no further transitions.
    if (from === 'rejected' || from === 'reverted') {
      return { ok: false, reason: 'invalid_transition' };
    }
    if (from === args.to) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const allowed: Record<string, readonly string[]> = {
      draft: ['submitted'],
      submitted: ['approved', 'rejected'],
      approved: ['testing'],
      testing: ['delivered', 'reverted'],
      // P87-C3 — delivered → reverted permitido (Superpowers Important #2):
      // tools can fail after activation; revert tooling pode marcar a row.
      delivered: ['reverted'],
    };
    if (!allowed[from]?.includes(args.to)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status: args.to, updated_at: now };
    if (args.to === 'submitted') {
      patch.submitted_at = now;
    } else if (args.to === 'approved' || args.to === 'rejected') {
      patch.decided_at = now;
      if (args.decided_by) patch.decided_by = args.decided_by;
      if (args.decision_reason) patch.decision_reason = args.decision_reason;
    } else if (args.to === 'delivered') {
      patch.delivered_at = now;
      if (args.delivery_artifact_ref)
        patch.delivery_artifact_ref = args.delivery_artifact_ref;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    } else if (args.to === 'reverted') {
      patch.reverted_at = now;
      if (args.revert_reason) patch.revert_reason = args.revert_reason;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    }

    const [updated] = await db
      .update(capability_proposals)
      .set(patch as Partial<typeof capability_proposals.$inferInsert>)
      .where(eq(capability_proposals.id, args.id))
      .returning();
    return { ok: true, updated: updated! };
  },
};

// P5: capability_test_results — auditoria do loop fechado pós-ativação. Cada
// run dos test_scenarios da proposal gera uma linha; outcome=fail/error pode
// disparar triggered_revert=true e criar um technical_gap_id (gap derivado
// para investigação). Reads ordenam por ran_at DESC (mais recente primeiro).
export const capabilityTestResultsRepo = {
  async record(input: {
    proposal_id: string;
    gap_id?: string;
    outcome: 'pass' | 'fail' | 'error';
    scenarios_run: unknown[];
    scenarios_passed: number;
    scenarios_failed: number;
    details?: unknown;
    triggered_revert?: boolean;
    technical_gap_id?: string;
  }): Promise<CapabilityTestResult> {
    // PR #87 Minor #3: defensive parity. applyTenantGuard injeta tenant/agent
    // do contexto atual, mas NÃO valida que technical_gap_id (passado pelo
    // caller) pertence ao mesmo tenant. Hoje a chain (capability-test-runner
    // → revertCapability → capabilityGapsRepo.create) sempre cria o gap
    // dentro do mesmo tenant context, então o id retornado é seguro — mas
    // callers futuros poderiam quebrar essa premissa. Faz cross-check
    // explícito para fechar a porta agora.
    if (input.technical_gap_id) {
      const tenant_id = getCurrentTenant();
      const agent_id = getCurrentAgent();
      const rows = await db
        .select({ id: agent_capability_gaps.id })
        .from(agent_capability_gaps)
        .where(
          and(
            eq(agent_capability_gaps.id, input.technical_gap_id),
            eq(agent_capability_gaps.tenant_id, tenant_id),
            eq(agent_capability_gaps.agent_id, agent_id),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new Error('capability_test_results.technical_gap_id_cross_tenant');
      }
    }
    const guarded = applyTenantGuard({
      proposal_id: input.proposal_id,
      gap_id: input.gap_id ?? null,
      outcome: input.outcome,
      scenarios_run: input.scenarios_run as unknown as object,
      scenarios_passed: input.scenarios_passed,
      scenarios_failed: input.scenarios_failed,
      details: (input.details ?? {}) as object,
      triggered_revert: input.triggered_revert ?? false,
      technical_gap_id: input.technical_gap_id ?? null,
    });
    const [row] = await db
      .insert(capability_test_results)
      .values(guarded as typeof capability_test_results.$inferInsert)
      .returning();
    return row!;
  },

  async listByProposal(proposal_id: string): Promise<CapabilityTestResult[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at));
  },

  async latestByProposal(proposal_id: string): Promise<CapabilityTestResult | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

// P6: channels — instâncias de entrada de mensagem (1+ por agent). Tenant-
// scoped via applyTenantGuard; findByExternalCrossTenant é o único método que
// bypassa o guard (usado pelo resolver de entrada, antes do contexto existir).
export const channelsRepo = {
  async create(input: {
    external_id: string;
    channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
    display_name?: string;
    metadata?: unknown;
  }): Promise<Channel> {
    const guarded = applyTenantGuard({
      external_id: input.external_id,
      channel_type: input.channel_type,
      display_name: input.display_name ?? null,
      metadata: (input.metadata as object) ?? {},
    });
    const [row] = await db
      .insert(channels)
      .values(guarded as typeof channels.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async findByExternal(
    channel_type: string,
    external_id: string,
  ): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.channel_type, channel_type),
          eq(channels.external_id, external_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  // EXPLICITLY bypasses applyTenantGuard — used by resolver (entry point,
  // before context exists). The (channel_type, external_id) lookup discovers
  // which tenant/agent owns the inbound message.
  async findByExternalCrossTenant(args: {
    channel_type: string;
    external_id: string;
  }): Promise<Channel | null> {
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.channel_type, args.channel_type),
          eq(channels.external_id, args.external_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listActive(): Promise<Channel[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.active, true),
        ),
      );
  },

  // [P88-C3] Tenant-scoped: write paths MUST enforce isolation. Without
  // tenant/agent predicates, any caller with another tenant's channel UUID
  // could disable that channel (cross-tenant DoS). Read-side filters here
  // were already tenant-scoped — this aligns the destructive path.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(channels)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .returning({ id: channels.id });
    return { rowCount: result.length };
  },
};

// P6: roles — modos operacionais por agent (comercial, suporte, default, etc).
// Exatamente 1 default por (tenant, agent), garantido por partial unique index.
export const rolesRepo = {
  async create(input: {
    role_key: string;
    display_name: string;
    description?: string;
    prompt_addendum?: string;
    is_default?: boolean;
  }): Promise<Role> {
    const guarded = applyTenantGuard({
      role_key: input.role_key,
      display_name: input.display_name,
      description: input.description ?? null,
      prompt_addendum: input.prompt_addendum ?? null,
      is_default: input.is_default ?? false,
    });
    const [row] = await db
      .insert(roles)
      .values(guarded as typeof roles.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getByKey(role_key: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.role_key, role_key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getDefault(): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.is_default, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listActive(): Promise<Role[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.active, true),
        ),
      );
  },

  // [P88-C3] Tenant-scoped: same justification as channelsRepo.deactivate.
  // Cross-tenant deactivation would break the inviolable isolation invariant.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(roles)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .returning({ id: roles.id });
    return { rowCount: result.length };
  },
};

// P6: channel_policies — governance que define default role + switch_behavior
// + travas anti-oscilação para by_context. UNIQUE (channel_id) garante 1
// policy por canal.
export const channelPoliciesRepo = {
  async create(input: {
    channel_id: string;
    default_role_id: string;
    switch_behavior: SwitchBehavior;
    announce_mode?: AnnounceMode;
    by_context_guards?: unknown;
    allowed_role_ids?: string[];
  }): Promise<ChannelPolicy> {
    const guarded = applyTenantGuard({
      channel_id: input.channel_id,
      default_role_id: input.default_role_id,
      switch_behavior: input.switch_behavior,
      ...(input.announce_mode !== undefined
        ? { announce_mode: input.announce_mode }
        : {}),
      ...(input.by_context_guards !== undefined
        ? { by_context_guards: input.by_context_guards as object }
        : {}),
      ...(input.allowed_role_ids !== undefined
        ? { allowed_role_ids: input.allowed_role_ids as unknown as object }
        : {}),
    });
    const [row] = await db
      .insert(channel_policies)
      .values(guarded as typeof channel_policies.$inferInsert)
      .returning();
    return row!;
  },

  async getByChannelId(channel_id: string): Promise<ChannelPolicy | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channel_policies)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.channel_id, channel_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async update(
    id: string,
    patch: Partial<NewChannelPolicy>,
  ): Promise<ChannelPolicy> {
    // Strip any tenant/agent the caller might have supplied — context wins.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = patch;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const [row] = await db
      .update(channel_policies)
      .set({
        ...rest,
        updated_at: new Date(),
      } as Partial<typeof channel_policies.$inferInsert>)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.id, id),
        ),
      )
      .returning();
    return row!;
  },
};

// P6: role_selector_decisions — log append-only de TODA decisão do role
// selector (mesmo "keep_current"). decided_by NUNCA pode ser llm_classifier:
// CHECK constraint no DB + runtime guard aqui (defense in depth). LLM
// sugere (suggested_by), policy decide (decided_by).
export const roleSelectorDecisionsRepo = {
  async record(input: {
    conversa_id?: string;
    turno_id?: string;
    channel_id?: string;
    policy_id?: string;
    current_role_id?: string;
    suggested_role_id?: string;
    decided_role_id: string;
    action: RoleDecisionAction;
    candidates: unknown[];
    conflicts: unknown[];
    suggested_by: SuggestedBy;
    decided_by: DecidedBy;
    suggested_strength?: RoleSelectorStrength;
    suggested_confidence?: number;
    reason?: string;
    switch_count_in_conversation?: number;
  }): Promise<RoleSelectorDecisionRow> {
    // CRITICAL runtime guard — defense in depth. DB has CHECK constraint,
    // but app validates too. LLM sugere; policy/owner/fallback decide.
    if ((input.decided_by as string) === 'llm_classifier') {
      throw new Error('decided_by_cannot_be_llm_classifier');
    }
    const guarded = applyTenantGuard({
      conversa_id: input.conversa_id ?? null,
      turno_id: input.turno_id ?? null,
      channel_id: input.channel_id ?? null,
      policy_id: input.policy_id ?? null,
      current_role_id: input.current_role_id ?? null,
      suggested_role_id: input.suggested_role_id ?? null,
      decided_role_id: input.decided_role_id,
      action: input.action,
      candidates: input.candidates as unknown as object,
      conflicts: input.conflicts as unknown as object,
      suggested_by: input.suggested_by,
      decided_by: input.decided_by,
      suggested_strength: input.suggested_strength ?? null,
      suggested_confidence:
        input.suggested_confidence !== undefined
          ? String(input.suggested_confidence)
          : null,
      reason: input.reason ?? null,
      switch_count_in_conversation: input.switch_count_in_conversation ?? 0,
    });
    const [row] = await db
      .insert(role_selector_decisions)
      .values(guarded as typeof role_selector_decisions.$inferInsert)
      .returning();
    return row!;
  },

  async listByConversation(
    conversa_id: string,
  ): Promise<RoleSelectorDecisionRow[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at));
  },

  // [P88-C2] Returns the most recently DECIDED role for this conversation
  // (across all turns). Used by the role selector to rehydrate the current
  // role each turn — without this, `current_role` resets to policy.default
  // every turn, breaking the `by_context` anti-osc lock (it would punish
  // consistency by counting three same-context turns as three switches).
  async getLastDecidedRoleId(conversa_id: string): Promise<string | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ decided_role_id: role_selector_decisions.decided_role_id })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(1);
    return rows[0]?.decided_role_id ?? null;
  },

  // [P88-H4 cooldown_turns] Counts decisions in this conversation in the
  // last N turns (i.e., the N most recent decisions). Used by the policy
  // decider to enforce `cooldown_turns` — require N turns between switches.
  async countSwitchesInLastNTurns(args: {
    conversa_id: string;
    n: number;
  }): Promise<number> {
    if (args.n <= 0) return 0;
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ action: role_selector_decisions.action })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, args.conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(args.n);
    return rows.filter((r) => r.action === 'switch').length;
  },

  async countSwitchesInConversation(conversa_id: string): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count
        FROM role_selector_decisions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND conversa_id = ${conversa_id}
         AND action = 'switch'
    `);
    const raw = result.rows[0]?.count ?? 0;
    return typeof raw === 'string' ? Number(raw) : raw;
  },
};

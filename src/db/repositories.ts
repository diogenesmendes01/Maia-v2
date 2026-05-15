import { eq, and, inArray, desc, isNull, sql, or, gt, lt } from 'drizzle-orm';
import { db } from './client.js';
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
} from './schema.js';
import { TypedError } from '@/lib/utils.js';
import { applyTenantGuard } from './tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from './tenant-context.js';
import type { ProfileStatus, DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
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
  AgentOperationalProfileVersion,
  ProfileBody,
  AgentDriftAlert,
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
  async findById(id: string): Promise<Pessoa | null> {
    const rows = await db.select().from(pessoas).where(eq(pessoas.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async findByPhone(telefone: string): Promise<Pessoa | null> {
    const rows = await db
      .select()
      .from(pessoas)
      .where(eq(pessoas.telefone_whatsapp, telefone))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Pessoa, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Pessoa> {
    const rows = await db.insert(pessoas).values(input).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Pessoa['status']): Promise<void> {
    await db.update(pessoas).set({ status, updated_at: new Date() }).where(eq(pessoas.id, id));
  },
  async updatePreferencias(id: string, preferencias: Record<string, unknown>): Promise<void> {
    await db
      .update(pessoas)
      .set({ preferencias, updated_at: new Date() })
      .where(eq(pessoas.id, id));
  },
  async list(): Promise<Pessoa[]> {
    return db.select().from(pessoas);
  },
};

export const permissoesRepo = {
  async forPessoa(pessoa_id: string): Promise<Permissao[]> {
    return db
      .select()
      .from(permissoes)
      .where(and(eq(permissoes.pessoa_id, pessoa_id), eq(permissoes.status, 'ativa')));
  },
  async byKey(pessoa_id: string, entidade_id: string): Promise<Permissao | null> {
    const rows = await db
      .select()
      .from(permissoes)
      .where(and(eq(permissoes.pessoa_id, pessoa_id), eq(permissoes.entidade_id, entidade_id)))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Permissao, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<Permissao> {
    const rows = await db.insert(permissoes).values(input).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Permissao['status']): Promise<void> {
    await db.update(permissoes).set({ status }).where(eq(permissoes.id, id));
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
    const rows = await db.insert(entidades).values(input).returning();
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
    const rows = await db.insert(contas_bancarias).values(input).returning();
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
    const rows = await db.insert(contrapartes).values(input).returning();
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
        target: [agent_facts.escopo, agent_facts.chave],
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
    return db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          inArray(agent_facts.escopo, escopos),
        ),
      );
  },
};

export const rulesRepo = {
  async listActive(tipo: string): Promise<LearnedRule[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.ativa, true),
          eq(learned_rules.tipo, tipo),
        ),
      )
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(50);
  },
  async create(input: Omit<LearnedRule, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<LearnedRule> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(learned_rules).values(guarded).returning();
    return rows[0]!;
  },
  async findByContext(tipo: string, contexto: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
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
    const rows = await db.insert(pending_questions).values(input).returning();
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
    const rows = await tx.insert(pending_questions).values(input).returning();
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
  async create(input: Omit<Workflow, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>): Promise<Workflow> {
    const rows = await db.insert(workflows).values(input).returning();
    return rows[0]!;
  },
  async byId(id: string): Promise<Workflow | null> {
    const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async setStatus(id: string, status: Workflow['status']): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === 'concluido') update.concluido_em = new Date();
    await db.update(workflows).set(update).where(eq(workflows.id, id));
  },
  async listPending(): Promise<Workflow[]> {
    return db
      .select()
      .from(workflows)
      .where(
        sql`status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')`,
      );
  },
};

export const workflowStepsRepo = {
  async createMany(
    inputs: Omit<WorkflowStep, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>[],
  ): Promise<WorkflowStep[]> {
    if (inputs.length === 0) return [];
    return db.insert(workflow_steps).values(inputs).returning();
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
  async record(entry: Omit<CognitiveModuleLog, 'id' | 'created_at'>): Promise<void> {
    await db.insert(cognitive_module_log).values(entry);
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
};

export const memoryEntryRepo = {
  async create(
    input: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<MemoryEntry> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(memory_entry).values(guarded).returning();
    return row!;
  },

  async findRelevant(opts: {
    interlocutor_id?: string;
    role_id?: string;
    conversa_id?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conds = [
      eq(memory_entry.tenant_id, tenant_id),
      eq(memory_entry.agent_id, agent_id),
      eq(memory_entry.needs_review, false),
    ];
    // Filtrar por scope_type + subject_id apropriado
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
    await db
      .update(memory_entry)
      .set({ ...updates, needs_review: false, updated_at: new Date() })
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
    input: Omit<BehavioralHint, 'id' | 'created_at' | 'tenant_id' | 'agent_id'>,
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
};

export const procedureDefinitionsRepo = {
  async create(
    input: Omit<ProcedureDefinition, 'id' | 'created_at' | 'updated_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<ProcedureDefinition> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(procedure_definitions).values(guarded as any).returning();
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

  async findById(id: string): Promise<ProcedureDefinition | null> {
    const rows = await db.select().from(procedure_definitions).where(eq(procedure_definitions.id, id)).limit(1);
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

  async updateStatus(
    id: string,
    updates: { status: string; approved_by?: string; approved_at?: Date | null; activated_at?: Date | null; deactivated_at?: Date | null; proposed_by?: string },
  ): Promise<void> {
    await db
      .update(procedure_definitions)
      .set({ ...updates, updated_at: new Date() })
      .where(eq(procedure_definitions.id, id));
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
};

export const procedureAssignmentsRepo = {
  async create(
    input: Omit<ProcedureAssignment, 'id' | 'activated_at' | 'tenant_id'>,
  ): Promise<ProcedureAssignment> {
    const tenant_id = getCurrentTenant();
    const [row] = await db
      .insert(procedure_assignments)
      .values({ ...input, tenant_id } as any)
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

// P4: agent_operational_profile_versions — append-only, profile_body JSONB
// (v3.1.1, 3 namespaces: identity/style/metadata), status
// (proposed | active | frozen | rolled_back). Apenas a row `active` por
// (tenant_id, agent_id) entra em runtime (enforced pelo partial unique index
// agent_op_profile_unique_active_idx em migrations/025). Esse repo expõe um
// state machine de transição com guard `already_has_active` em código (defesa
// em profundidade), além da UQ no SQL.
//
// Regras:
//   create() — sempre status='proposed'. Nunca aceita 'active' direto.
//   transition() — proposed → active|frozen|rolled_back
//                  active   → frozen|rolled_back
//                  frozen   → active|rolled_back
//                  rolled_back — terminal
//                  to:'active' verifica que não há outro active para
//                  (tenant, agent) e retorna { ok:false, reason:'already_has_active' }.
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

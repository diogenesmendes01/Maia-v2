import { eq, and, inArray, desc, isNull, sql, or, gt } from 'drizzle-orm';
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
} from './schema.js';
import { TypedError } from '@/lib/utils.js';
import { applyTenantGuard } from './tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from './tenant-context.js';
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

import { eq, and, inArray, desc, isNull, sql } from 'drizzle-orm';
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
} from './schema.js';
import { TypedError } from '@/lib/utils.js';
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
  async create(input: Omit<Pessoa, 'id' | 'created_at' | 'updated_at'>): Promise<Pessoa> {
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
  async create(input: Omit<Permissao, 'id' | 'created_at'>): Promise<Permissao> {
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
    const rows = await db
      .select()
      .from(conversas)
      .where(and(eq(conversas.pessoa_id, pessoa_id), eq(conversas.status, 'ativa')))
      .orderBy(desc(conversas.ultima_atividade_em))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: {
    pessoa_id: string;
    escopo_entidades: string[];
  }): Promise<Conversa> {
    const rows = await db
      .insert(conversas)
      .values({ pessoa_id: input.pessoa_id, escopo_entidades: input.escopo_entidades })
      .returning();
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
  async create(input: Omit<Mensagem, 'id' | 'created_at'>): Promise<Mensagem> {
    const rows = await db.insert(mensagens).values(input).returning();
    return rows[0]!;
  },
  async createInbound(
    input: Omit<Mensagem, 'id' | 'created_at'>,
  ): Promise<{ row: Mensagem; duplicate: boolean }> {
    const wid = (input.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
    if (typeof wid === 'string' && wid.length > 0) {
      const existing = await this.findByWhatsappId(wid);
      if (existing) return { row: existing, duplicate: true };
    }
    try {
      const rows = await db.insert(mensagens).values(input).returning();
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
    const cutoff = new Date(Date.now() - ms);
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          isNull(mensagens.processada_em),
          eq(mensagens.direcao, 'in'),
          sql`created_at < ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
  },
  async findById(id: string): Promise<Mensagem | null> {
    const rows = await db.select().from(mensagens).where(eq(mensagens.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async findByWhatsappId(whatsapp_id: string): Promise<Mensagem | null> {
    const rows = await db
      .select()
      .from(mensagens)
      .where(sql`metadata->>'whatsapp_id' = ${whatsapp_id}`)
      .limit(1);
    return rows[0] ?? null;
  },
  async recentInConversation(conversa_id: string, n = 20): Promise<Mensagem[]> {
    return db
      .select()
      .from(mensagens)
      .where(eq(mensagens.conversa_id, conversa_id))
      .orderBy(desc(mensagens.created_at))
      .limit(n);
  },
  async setConversaId(id: string, conversa_id: string): Promise<void> {
    await db.update(mensagens).set({ conversa_id }).where(eq(mensagens.id, id));
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
  async create(input: Omit<Entidade, 'id' | 'created_at' | 'updated_at'>): Promise<Entidade> {
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
  async create(input: Omit<Conta, 'id' | 'created_at' | 'updated_at'>): Promise<Conta> {
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
    const conds = [inArray(transacoes.entidade_id, scope.entidades)];
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
  async create(input: Omit<Transacao, 'id' | 'created_at' | 'updated_at'>): Promise<Transacao> {
    const rows = await db.insert(transacoes).values(input).returning();
    return rows[0]!;
  },
  async findRecentSimilar(params: {
    entidade_id: string;
    valor: string;
    descricao: string;
    registrado_por: string;
    sinceMs: number;
  }): Promise<Transacao[]> {
    const since = new Date(Date.now() - params.sinceMs);
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.entidade_id, params.entidade_id),
          eq(transacoes.valor, params.valor),
          eq(transacoes.registrado_por, params.registrado_por),
          sql`created_at >= ${since.toISOString()}`,
        ),
      );
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
  async create(input: Omit<Contraparte, 'id' | 'created_at' | 'updated_at'>): Promise<Contraparte> {
    const rows = await db.insert(contrapartes).values(input).returning();
    return rows[0]!;
  },
};

export const factsRepo = {
  async getByKey(escopo: string, chave: string): Promise<AgentFact | null> {
    const rows = await db
      .select()
      .from(agent_facts)
      .where(and(eq(agent_facts.escopo, escopo), eq(agent_facts.chave, chave)))
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
    const rows = await db
      .insert(agent_facts)
      .values({
        escopo: input.escopo,
        chave: input.chave,
        valor: input.valor as object,
        fonte: input.fonte,
        confianca: String(input.confianca ?? 1),
      })
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
    return db.select().from(agent_facts).where(inArray(agent_facts.escopo, escopos));
  },
};

export const rulesRepo = {
  async listActive(tipo: string): Promise<LearnedRule[]> {
    return db
      .select()
      .from(learned_rules)
      .where(and(eq(learned_rules.ativa, true), eq(learned_rules.tipo, tipo)))
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(50);
  },
  async create(input: Omit<LearnedRule, 'id' | 'created_at' | 'updated_at'>): Promise<LearnedRule> {
    const rows = await db.insert(learned_rules).values(input).returning();
    return rows[0]!;
  },
  async byId(id: string): Promise<LearnedRule | null> {
    const rows = await db.select().from(learned_rules).where(eq(learned_rules.id, id)).limit(1);
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

export const pendingQuestionsRepo = {
  async create(
    input: Omit<PendingQuestion, 'id' | 'created_at' | 'resolvida_em' | 'resposta'>,
  ): Promise<PendingQuestion> {
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
  async write(input: Omit<AuditEntry, 'id' | 'created_at'>): Promise<void> {
    await db.insert(audit_log).values(input);
  },
  async listByPessoa(pessoa_id: string, n = 100): Promise<AuditEntry[]> {
    return db
      .select()
      .from(audit_log)
      .where(eq(audit_log.pessoa_id, pessoa_id))
      .orderBy(desc(audit_log.created_at))
      .limit(n);
  },
};

export const workflowsRepo = {
  async create(input: Omit<Workflow, 'id' | 'iniciado_em' | 'concluido_em'>): Promise<Workflow> {
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
    inputs: Omit<WorkflowStep, 'id' | 'iniciado_em' | 'concluido_em'>[],
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
  }): Promise<void> {
    const now = new Date();
    await db.insert(dead_letter_jobs).values({
      queue_name: input.queue_name,
      job_id: input.job_id,
      payload: input.payload as object,
      error: input.error,
      attempts: input.attempts,
      first_failed_at: now,
      last_failed_at: now,
    });
  },
  async listOpen(n = 100) {
    return db
      .select()
      .from(dead_letter_jobs)
      .where(eq(dead_letter_jobs.resolved, false))
      .orderBy(desc(dead_letter_jobs.created_at))
      .limit(n);
  },
  async resolve(id: string): Promise<void> {
    await db
      .update(dead_letter_jobs)
      .set({ resolved: true, resolved_at: new Date() })
      .where(eq(dead_letter_jobs.id, id));
  },
};

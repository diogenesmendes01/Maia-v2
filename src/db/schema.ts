import {
  pgTable,
  pgMaterializedView,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  integer,
  boolean,
  date,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const entidades = pgTable('entidades', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  nome: text('nome').notNull(),
  tipo: text('tipo').notNull(),
  documento: text('documento'),
  status: text('status').notNull().default('ativa'),
  cor: text('cor'),
  observacoes: text('observacoes'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contas_bancarias = pgTable('contas_bancarias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  entidade_id: uuid('entidade_id').notNull(),
  banco: text('banco').notNull(),
  agencia: text('agencia'),
  numero: text('numero'),
  apelido: text('apelido').notNull(),
  tipo: text('tipo').notNull(),
  saldo_atual: numeric('saldo_atual', { precision: 15, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('ativa'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const categorias = pgTable('categorias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  entidade_id: uuid('entidade_id'),
  parent_id: uuid('parent_id'),
  nome: text('nome').notNull(),
  natureza: text('natureza').notNull(),
  cor: text('cor'),
  icone: text('icone'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transacoes = pgTable('transacoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  entidade_id: uuid('entidade_id').notNull(),
  conta_id: uuid('conta_id').notNull(),
  categoria_id: uuid('categoria_id'),
  natureza: text('natureza').notNull(),
  valor: numeric('valor', { precision: 15, scale: 2 }).notNull(),
  data_competencia: date('data_competencia').notNull(),
  data_pagamento: date('data_pagamento'),
  status: text('status').notNull(),
  descricao: text('descricao').notNull(),
  contraparte: text('contraparte'),
  contraparte_id: uuid('contraparte_id'),
  origem: text('origem').notNull(),
  conversa_id: uuid('conversa_id'),
  mensagem_id: uuid('mensagem_id'),
  registrado_por: uuid('registrado_por'),
  confianca_ia: numeric('confianca_ia', { precision: 3, scale: 2 }),
  confirmada_em: timestamp('confirmada_em', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transferencias_internas = pgTable('transferencias_internas', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  transacao_origem_id: uuid('transacao_origem_id').notNull(),
  transacao_destino_id: uuid('transacao_destino_id').notNull(),
  tipo: text('tipo').notNull(),
  observacoes: text('observacoes'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recorrencias = pgTable('recorrencias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  entidade_id: uuid('entidade_id').notNull(),
  conta_id: uuid('conta_id').notNull(),
  categoria_id: uuid('categoria_id'),
  natureza: text('natureza').notNull(),
  descricao: text('descricao').notNull(),
  valor_aprox: numeric('valor_aprox', { precision: 15, scale: 2 }).notNull(),
  dia_do_mes: integer('dia_do_mes'),
  frequencia: text('frequencia').notNull().default('mensal'),
  ativa: boolean('ativa').notNull().default(true),
  proxima_em: date('proxima_em'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contrapartes = pgTable('contrapartes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  entidade_id: uuid('entidade_id').notNull(),
  nome: text('nome').notNull(),
  tipo: text('tipo').notNull(),
  documento: text('documento'),
  chave_pix: text('chave_pix'),
  banco_padrao: text('banco_padrao'),
  observacoes: text('observacoes'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('ativa'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pessoas = pgTable('pessoas', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  nome: text('nome').notNull(),
  apelido: text('apelido'),
  telefone_whatsapp: text('telefone_whatsapp').notNull().unique(),
  tipo: text('tipo').notNull(),
  email: text('email'),
  observacoes: text('observacoes'),
  preferencias: jsonb('preferencias').notNull().default(sql`'{}'::jsonb`),
  modelo_mental: jsonb('modelo_mental').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('ativa'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permission_profiles = pgTable('permission_profiles', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  nome: text('nome').notNull(),
  acoes: text('acoes').array().notNull(),
  limite_default: numeric('limite_default', { precision: 15, scale: 2 }).notNull().default('0'),
  descricao: text('descricao'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissoes = pgTable(
  'permissoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    pessoa_id: uuid('pessoa_id').notNull(),
    entidade_id: uuid('entidade_id'),
    papel: text('papel').notNull(),
    profile_id: text('profile_id').notNull(),
    acoes_permitidas: text('acoes_permitidas').array().notNull().default(sql`'{}'::text[]`),
    limites: jsonb('limites').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('ativa'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique().on(t.pessoa_id, t.entidade_id),
  }),
);

export const conversas = pgTable('conversas', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  pessoa_id: uuid('pessoa_id').notNull(),
  escopo_entidades: uuid('escopo_entidades').array().notNull().default(sql`'{}'::uuid[]`),
  status: text('status').notNull().default('ativa'),
  contexto_resumido: text('contexto_resumido'),
  ultima_atividade_em: timestamp('ultima_atividade_em', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mensagens = pgTable('mensagens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  conversa_id: uuid('conversa_id'),
  direcao: text('direcao').notNull(),
  tipo: text('tipo').notNull(),
  conteudo: text('conteudo'),
  midia_url: text('midia_url'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  processada_em: timestamp('processada_em', { withTimezone: true }),
  ferramentas_chamadas: jsonb('ferramentas_chamadas').notNull().default(sql`'[]'::jsonb`),
  tokens_usados: integer('tokens_usados'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agent_facts = pgTable(
  'agent_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    escopo: text('escopo').notNull(),
    chave: text('chave').notNull(),
    valor: jsonb('valor').notNull(),
    confianca: numeric('confianca', { precision: 3, scale: 2 }).notNull().default('1.00'),
    fonte: text('fonte').notNull().default('aprendido'),
    ultima_validacao: timestamp('ultima_validacao', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique().on(t.escopo, t.chave),
  }),
);

export const learned_rules = pgTable('learned_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  tipo: text('tipo').notNull(),
  contexto: text('contexto').notNull(),
  acao: text('acao').notNull(),
  contexto_jsonb: jsonb('contexto_jsonb').notNull().default(sql`'{}'::jsonb`),
  acoes_jsonb: jsonb('acoes_jsonb').notNull().default(sql`'{}'::jsonb`),
  confianca: numeric('confianca', { precision: 3, scale: 2 }).notNull().default('0.50'),
  acertos: integer('acertos').notNull().default(0),
  erros: integer('erros').notNull().default(0),
  ativa: boolean('ativa').notNull().default(true),
  exemplo_origem_id: uuid('exemplo_origem_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agent_memories = pgTable('agent_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  conteudo: text('conteudo').notNull(),
  embedding: text('embedding'),
  tipo: text('tipo').notNull(),
  escopo: text('escopo').notNull(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  ref_tabela: text('ref_tabela'),
  ref_id: uuid('ref_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const self_state = pgTable('self_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  versao: integer('versao').notNull(),
  system_prompt: text('system_prompt').notNull(),
  resumo_aprendizados: text('resumo_aprendizados'),
  ativa: boolean('ativa').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entity_states = pgTable('entity_states', {
  entidade_id: uuid('entidade_id').primaryKey(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  workflow_atual: uuid('workflow_atual'),
  contexto: jsonb('contexto').notNull().default(sql`'{}'::jsonb`),
  ultima_reconciliacao: timestamp('ultima_reconciliacao', { withTimezone: true }),
  ultimo_briefing: timestamp('ultimo_briefing', { withTimezone: true }),
  proximo_vencimento: date('proximo_vencimento'),
  saldo_consolidado: numeric('saldo_consolidado', { precision: 15, scale: 2 }),
  saldo_atualizado_em: timestamp('saldo_atualizado_em', { withTimezone: true }),
  flags: jsonb('flags').notNull().default(sql`'{}'::jsonb`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  tipo: text('tipo').notNull(),
  status: text('status').notNull().default('pendente'),
  contexto: jsonb('contexto').notNull().default(sql`'{}'::jsonb`),
  entidade_id: uuid('entidade_id'),
  pessoa_envolvida: uuid('pessoa_envolvida'),
  proxima_acao_em: timestamp('proxima_acao_em', { withTimezone: true }),
  iniciado_em: timestamp('iniciado_em', { withTimezone: true }).notNull().defaultNow(),
  concluido_em: timestamp('concluido_em', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
});

export const workflow_steps = pgTable('workflow_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  workflow_id: uuid('workflow_id').notNull(),
  ordem: integer('ordem').notNull(),
  descricao: text('descricao').notNull(),
  status: text('status').notNull().default('pendente'),
  resultado: jsonb('resultado'),
  iniciado_em: timestamp('iniciado_em', { withTimezone: true }),
  concluido_em: timestamp('concluido_em', { withTimezone: true }),
});

export const pending_questions = pgTable('pending_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  conversa_id: uuid('conversa_id'),
  pessoa_id: uuid('pessoa_id'),
  tipo: text('tipo').notNull(),
  pergunta: text('pergunta').notNull(),
  opcoes_validas: jsonb('opcoes_validas').notNull().default(sql`'[]'::jsonb`),
  acao_proposta: jsonb('acao_proposta').notNull(),
  expira_em: timestamp('expira_em', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('aberta'),
  resposta: jsonb('resposta'),
  resolvida_em: timestamp('resolvida_em', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotency_keys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  tool_name: text('tool_name').notNull(),
  operation_type: text('operation_type').notNull(),
  pessoa_id: uuid('pessoa_id').notNull(),
  entity_id: uuid('entity_id').notNull(),
  payload_hash: text('payload_hash').notNull(),
  file_sha256: text('file_sha256'),
  resultado: jsonb('resultado').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const system_health_events = pgTable('system_health_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  component: text('component').notNull(),
  status: text('status').notNull(),
  duration_ms: integer('duration_ms'),
  error: text('error'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dead_letter_jobs = pgTable('dead_letter_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  queue_name: text('queue_name').notNull(),
  job_id: text('job_id').notNull(),
  payload: jsonb('payload').notNull(),
  error: text('error').notNull(),
  attempts: integer('attempts').notNull(),
  first_failed_at: timestamp('first_failed_at', { withTimezone: true }).notNull(),
  last_failed_at: timestamp('last_failed_at', { withTimezone: true }).notNull(),
  resolved: boolean('resolved').notNull().default(false),
  resolved_at: timestamp('resolved_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dashboard_sessions = pgTable('dashboard_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  pessoa_id: uuid('pessoa_id').notNull(),
  token_hash: text('token_hash').notNull(),
  expira_em: timestamp('expira_em', { withTimezone: true }).notNull(),
  ip: text('ip'),
  user_agent: text('user_agent'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  used_at: timestamp('used_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});

export const import_runs = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    pessoa_id: uuid('pessoa_id').notNull(),
    entidade_id: uuid('entidade_id').notNull(),
    conta_id: uuid('conta_id').notNull(),
    fonte: text('fonte').notNull(),
    arquivo_sha256: text('arquivo_sha256').notNull(),
    arquivo_nome: text('arquivo_nome'),
    periodo_de: date('periodo_de'),
    periodo_ate: date('periodo_ate'),
    total_lancamentos: integer('total_lancamentos').notNull().default(0),
    matched: integer('matched').notNull().default(0),
    candidates: integer('candidates').notNull().default(0),
    novos: integer('novos').notNull().default(0),
    status: text('status').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Mirrors `UNIQUE (conta_id, arquivo_sha256)` from migrations/002 §188 —
    // prevents the same file being imported twice into the same account.
    arquivo_uniq: unique().on(t.conta_id, t.arquivo_sha256),
  }),
);

export const import_entries = pgTable(
  'import_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    import_run_id: uuid('import_run_id').notNull(),
    ordem: integer('ordem').notNull(),
    tipo_oper: text('tipo_oper').notNull(),
    valor: numeric('valor', { precision: 15, scale: 2 }).notNull(),
    data_oper: date('data_oper').notNull(),
    fitid: text('fitid'),
    memo: text('memo'),
    contraparte_raw: text('contraparte_raw'),
    status: text('status').notNull(),
    matched_transacao_id: uuid('matched_transacao_id'),
    candidates: jsonb('candidates'),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Mirrors `idx_import_entries_run` from migrations/002 §208.
    by_run: index('idx_import_entries_run').on(t.import_run_id, t.ordem),
  }),
);

// FKs (pessoas/entidades/contas/transacoes) and CHECK constraints (fonte,
// status, tipo_oper) live in migrations/002_specs_v1.sql and are enforced by
// Postgres. We don't redeclare them in the Drizzle schema because no other
// table in this file does — keeping it consistent with the surrounding code.
// The migration is the source of truth; this schema is the typing layer.

export const audit_log = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),
  agent_id: text('agent_id').notNull().default('default'),
  pessoa_id: uuid('pessoa_id'),
  acao: text('acao').notNull(),
  entidade_alvo: text('entidade_alvo'),
  alvo_id: uuid('alvo_id'),
  conversa_id: uuid('conversa_id'),
  mensagem_id: uuid('mensagem_id'),
  diff: jsonb('diff'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// P0 multi-tenant scaffolding (migration 007). `tenants.id` and `agents.id` are
// TEXT (human-readable slugs like 'default', 'cliente-x'), not UUIDs — the
// 'default' row is seeded by the migration to preserve the legacy single-tenant
// Maia behavior. FK from agents.tenant_id → tenants.id is enforced in SQL only;
// see plan §6.1.
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  nome: text('nome').notNull(),
  status: text('status').notNull().default('active'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    nome: text('nome').notNull(),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdIdx: index('agents_tenant_id_idx').on(t.tenant_id),
  }),
);

// P0 cognitive module audit log (migration 008). Records every invocation of a
// cognitive module (e.g. reflection.ts) for observability, cost tracking, and
// debugging. FKs to tenants/agents enforced in SQL only; see plan §8 and §10.5.
export const cognitive_module_log = pgTable(
  'cognitive_module_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    module_name: text('module_name').notNull(),
    module_version: text('module_version').notNull().default('v1'),
    prompt_version: text('prompt_version'),
    triggered_by: text('triggered_by').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    latency_ms: integer('latency_ms'),
    model_used: text('model_used'),
    tokens_in: integer('tokens_in'),
    tokens_out: integer('tokens_out'),
    cost_estimate: numeric('cost_estimate', { precision: 10, scale: 6 }),
    output_summary_hash: text('output_summary_hash'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    fallback_triggered: boolean('fallback_triggered').notNull().default(false),
    fallback_reason: text('fallback_reason'),
    status: text('status').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('cognitive_module_log_tenant_agent_idx').on(
      t.tenant_id,
      t.agent_id,
      t.created_at,
    ),
    moduleIdx: index('cognitive_module_log_module_idx').on(t.module_name, t.created_at),
    conversaIdx: index('cognitive_module_log_conversa_idx').on(t.conversa_id),
  }),
);

export const cognitive_candidates = pgTable(
  'cognitive_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    source_event_type: text('source_event_type').notNull(),
    source_event_id: uuid('source_event_id'),
    candidate_type: text('candidate_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    consumed_by_phase: text('consumed_by_phase'),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('cognitive_candidates_tenant_agent_status_idx').on(
      t.tenant_id, t.agent_id, t.status, t.created_at,
    ),
    typeStatusIdx: index('cognitive_candidates_type_status_idx').on(t.candidate_type, t.status),
  }),
);

export const memory_entry = pgTable(
  'memory_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    interlocutor_id: uuid('interlocutor_id'),
    conversa_id: uuid('conversa_id'),
    content: text('content').notNull(),
    memory_type: text('memory_type').notNull(),
    scope_type: text('scope_type').notNull(),
    subject_id: text('subject_id'),
    sensitivity: text('sensitivity').notNull().default('low'),
    proactive_use: boolean('proactive_use').notNull().default(false),
    mention_allowed: boolean('mention_allowed').notNull().default(false),
    ttl_days: integer('ttl_days'),
    needs_review: boolean('needs_review').notNull().default(false),
    source_event_id: uuid('source_event_id'),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('memory_entry_tenant_agent_idx').on(t.tenant_id, t.agent_id, t.created_at),
    interlocutorIdx: index('memory_entry_interlocutor_idx').on(t.interlocutor_id),
    scopeIdx: index('memory_entry_scope_idx').on(t.scope_type, t.subject_id),
    needsReviewIdx: index('memory_entry_needs_review_idx').on(t.needs_review),
    expiresIdx: index('memory_entry_expires_idx').on(t.expires_at),
  }),
);

export const behavioral_hint = pgTable(
  'behavioral_hint',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    scope_type: text('scope_type').notNull(),
    subject_id: text('subject_id'),
    hint_text: text('hint_text').notNull(),
    derived_from_memory_id: uuid('derived_from_memory_id'),
    derived_sensitivity: text('derived_sensitivity').notNull(),
    ttl_days: integer('ttl_days'),
    extension_reason: text('extension_reason'),
    extension_approved_by: text('extension_approved_by'),
    extension_approved_at: timestamp('extension_approved_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantScopeIdx: index('behavioral_hint_tenant_scope_idx').on(
      t.tenant_id,
      t.agent_id,
      t.scope_type,
      t.subject_id,
    ),
    activeIdx: index('behavioral_hint_active_idx').on(t.revoked_at, t.expires_at),
  }),
);

export const agent_capabilities_domain = pgTable(
  'agent_capabilities_domain',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    domain: text('domain').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    evidence_count: integer('evidence_count').notNull().default(0),
    success_count: integer('success_count').notNull().default(0),
    failure_count: integer('failure_count').notNull().default(0),
    last_success: timestamp('last_success', { withTimezone: true }),
    last_failure: timestamp('last_failure', { withTimezone: true }),
    failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique().on(t.tenant_id, t.agent_id, t.domain),
    domainIdx: index('caps_domain_idx').on(t.tenant_id, t.agent_id, t.domain),
  }),
);

export const agent_capabilities_skill = pgTable(
  'agent_capabilities_skill',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    domain: text('domain').notNull(),
    skill_name: text('skill_name').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    evidence_count: integer('evidence_count').notNull().default(0),
    success_count: integer('success_count').notNull().default(0),
    failure_count: integer('failure_count').notNull().default(0),
    last_success: timestamp('last_success', { withTimezone: true }),
    last_failure: timestamp('last_failure', { withTimezone: true }),
    failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique().on(t.tenant_id, t.agent_id, t.domain, t.skill_name),
    skillIdx: index('caps_skill_idx').on(t.tenant_id, t.agent_id, t.domain, t.skill_name),
  }),
);

export const agent_capability_gaps = pgTable(
  'agent_capability_gaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    capability_description: text('capability_description').notNull(),
    tipo: text('tipo').notNull(),
    contexto: text('contexto'),
    frequency_score: integer('frequency_score').notNull().default(1),
    severity_score: integer('severity_score').notNull().default(1),
    current_level: text('current_level').notNull().default('silent'),
    source_candidate_id: uuid('source_candidate_id'),
    last_observed: timestamp('last_observed', { withTimezone: true }).notNull().defaultNow(),
    last_level_change_at: timestamp('last_level_change_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    levelIdx: index('caps_gaps_level_idx').on(t.tenant_id, t.agent_id, t.current_level),
  }),
);

export const procedure_definitions = pgTable(
  'procedure_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    scope: text('scope').notNull(),
    owner_agent_id: text('owner_agent_id'),
    nome: text('nome').notNull(),
    version_number: integer('version_number').notNull().default(1),
    status: text('status').notNull().default('draft'),
    intencao: text('intencao').notNull(),
    when_apply: jsonb('when_apply').notNull().default(sql`'{}'::jsonb`),
    when_not_apply: jsonb('when_not_apply').notNull().default(sql`'{}'::jsonb`),
    steps: jsonb('steps').notNull().default(sql`'[]'::jsonb`),
    success_criteria: jsonb('success_criteria').notNull().default(sql`'[]'::jsonb`),
    failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),
    tools_referenced: jsonb('tools_referenced').notNull().default(sql`'[]'::jsonb`),
    source: text('source').notNull(),
    proposed_by: text('proposed_by'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
    source_candidate_id: uuid('source_candidate_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('procedure_def_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.nome),
    activeIdx: index('procedure_def_active_idx').on(t.tenant_id, t.agent_id, t.nome),
    sourceCandidateIdx: index('procedure_def_source_candidate_idx').on(t.source_candidate_id),
  }),
);

export const procedure_assignments = pgTable(
  'procedure_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    definition_id: uuid('definition_id').notNull(),
    definition_version: integer('definition_version').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    customizations: jsonb('customizations').notNull().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    activated_at: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
    deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    targetIdx: index('procedure_assignments_target_idx').on(t.tenant_id, t.target_type, t.target_id, t.enabled),
    defIdx: index('procedure_assignments_def_idx').on(t.definition_id),
  }),
);

export const procedure_executions = pgTable(
  'procedure_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    definition_id: uuid('definition_id').notNull(),
    definition_version: integer('definition_version').notNull(),
    status: text('status').notNull().default('in_progress'),
    current_step_id: text('current_step_id'),
    // PR #84 Minor #2: declared and read by prompt-builder (stateJson block),
    // but no engine path mutates it in P3b. Reserved for P3c which will emit
    // `state_updated` events with `execution_state` deltas (e.g. coleted slot
    // values across steps) and replay them in `replayState`.
    execution_state: jsonb('execution_state').notNull().default(sql`'{}'::jsonb`),
    completed_steps: jsonb('completed_steps').notNull().default(sql`'[]'::jsonb`),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    outcome: text('outcome'),
    notes: text('notes'),
  },
  (t) => ({
    tenantAgentStatusIdx: index('procedure_exec_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.last_activity_at),
    conversaIdx: index('procedure_exec_conversa_idx').on(t.conversa_id),
    inProgressIdx: index('procedure_exec_in_progress_idx').on(t.tenant_id, t.agent_id, t.conversa_id, t.last_activity_at),
    // P84-C2: partial UNIQUE constraint enforcing at most one in_progress
    // execution per (tenant, agent, conversa). Declared via raw SQL migration
    // 023 because Drizzle 0.45 doesn't expose partial-unique-index in DSL;
    // recorded here for documentation. See migration 023.
  }),
);

export const procedure_execution_events = pgTable(
  'procedure_execution_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    execution_id: uuid('execution_id').notNull(),
    step_id: text('step_id'),
    event_type: text('event_type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    executionIdx: index('procedure_events_execution_idx').on(t.execution_id, t.created_at),
    typeIdx: index('procedure_events_type_idx').on(t.event_type, t.created_at),
  }),
);

export const procedure_selector_decisions = pgTable(
  'procedure_selector_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    current_execution_id: uuid('current_execution_id'),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
    conflicts: jsonb('conflicts').notNull().default(sql`'[]'::jsonb`),
    decision: text('decision').notNull(),
    selected_procedure_id: uuid('selected_procedure_id'),
    decided_by: text('decided_by').notNull(),
    reason: text('reason'),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversaIdx: index('procedure_selector_conversa_idx').on(t.conversa_id, t.decided_at),
  }),
);

export const procedure_tests = pgTable(
  'procedure_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    definition_id: uuid('definition_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    scenario: jsonb('scenario').notNull(),
    expected_outcome: text('expected_outcome').notNull(),
    expected_step_path: jsonb('expected_step_path'),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    last_run_status: text('last_run_status'),
    last_run_details: jsonb('last_run_details'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    definitionIdx: index('procedure_tests_definition_idx').on(t.definition_id, t.last_run_status),
    tenantAgentIdx: index('procedure_tests_tenant_agent_idx').on(t.tenant_id, t.agent_id),
  }),
);

// P3c: procedure_metrics — materialized view aggregating execution metrics per
// definition (recalculable 100% from procedure_executions, itself a projection
// of procedure_execution_events). Defined via SQL in migrations/024; declared
// here with `.existing()` so Drizzle types reads without trying to manage DDL.
// `success_rate` and `avg_completion_seconds` are typed as text because
// PostgreSQL `numeric` / `double precision` arrive as strings via node-postgres.
export const procedure_metrics = pgMaterializedView('procedure_metrics', {
  definition_id: uuid('definition_id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  nome: text('nome').notNull(),
  version: integer('version').notNull(),
  definition_status: text('definition_status').notNull(),
  total_executions: integer('total_executions').notNull(),
  successful_executions: integer('successful_executions').notNull(),
  failed_executions: integer('failed_executions').notNull(),
  aborted_executions: integer('aborted_executions').notNull(),
  escalated_executions: integer('escalated_executions').notNull(),
  abandoned_executions: integer('abandoned_executions').notNull(),
  in_progress_executions: integer('in_progress_executions').notNull(),
  success_rate: text('success_rate'),
  avg_completion_seconds: text('avg_completion_seconds'),
  last_execution_at: timestamp('last_execution_at', { withTimezone: true }),
  refreshed_at: timestamp('refreshed_at', { withTimezone: true }).notNull(),
}).existing();

// P4: agent_operational_profile_versions — append-only, 4 camadas
// (núcleo imutável / perfil operacional aprendido / memória episódica temporária
// / backlog de crescimento aprovado) + status (proposed | active | frozen |
// rolled_back). Apenas a row `active` por (tenant_id, agent_id) entra em
// runtime — esse invariante é garantido pelo unique index parcial
// `agent_op_profile_unique_active_idx` declarado em migrations/025
// (Drizzle não expressa WHERE em uniqueIndex; a DB enforce).
export const agent_operational_profile_versions = pgTable(
  'agent_operational_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    core_immutable: jsonb('core_immutable').notNull().default(sql`'{}'::jsonb`),
    operational_profile: jsonb('operational_profile').notNull().default(sql`'{}'::jsonb`),
    episodic_temp: jsonb('episodic_temp').notNull().default(sql`'{}'::jsonb`),
    growth_backlog: jsonb('growth_backlog').notNull().default(sql`'{}'::jsonb`),
    proposed_by: text('proposed_by').notNull(),
    proposed_reason: text('proposed_reason'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    frozen_at: timestamp('frozen_at', { withTimezone: true }),
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    rollback_reason: text('rollback_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('agent_op_profile_tenant_agent_status_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
      t.version,
    ),
    versionUq: uniqueIndex('agent_op_profile_version_uq').on(t.tenant_id, t.agent_id, t.version),
  }),
);

// P4: agent_drift_alerts — audit das execuções do drift detector.
// Cada alert = 1 tipo de drift detectado (7 tipos: tom, valores, confianca,
// vies, escopo, linguagem, procedimento) × 4 severidades (baixo, medio, alto,
// critico) × decisão (auto_approved, queued_human, frozen, rollback). A FK
// para agent_operational_profile_versions é opcional porque um drift pode ser
// detectado antes de uma nova versão de perfil ser proposta. Constraints CHECK
// e o partial index `agent_drift_unresolved_idx` ficam só na DB (migrações/026);
// Drizzle não expressa WHERE em index().
export const agent_drift_alerts = pgTable(
  'agent_drift_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    profile_version_id: uuid('profile_version_id'),
    drift_type: text('drift_type').notNull(),
    severity: text('severity').notNull(),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    detected_by: text('detected_by').notNull(),
    decision: text('decision').notNull(),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    decided_by: text('decided_by').notNull(),
    resolution_note: text('resolution_note'),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    resolved_by: text('resolved_by'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentSeverityIdx: index('agent_drift_tenant_agent_severity_idx').on(
      t.tenant_id,
      t.agent_id,
      t.severity,
      t.created_at,
    ),
    profileVersionIdx: index('agent_drift_profile_version_idx').on(t.profile_version_id),
  }),
);

// P5: gap_escalation_rules — thresholds determinísticos por (tenant_id, agent_id)
// para a escalation chain (silent -> dashboard -> mentionable -> proposed). Defaults
// embutidos no schema; UNIQUE (tenant_id, agent_id) garante uma única regra ativa
// por agente. Quando ausente, o engine usa os defaults da coluna.
export const gap_escalation_rules = pgTable(
  'gap_escalation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    dashboard_freq_threshold: integer('dashboard_freq_threshold').notNull().default(3),
    mentionable_severity_threshold: integer('mentionable_severity_threshold').notNull().default(5),
    proposed_combined_threshold: integer('proposed_combined_threshold').notNull().default(8),
    proposed_min_distinct_contexts: integer('proposed_min_distinct_contexts').notNull().default(2),
    cooldown_days_proposed_to_proposed: integer('cooldown_days_proposed_to_proposed').notNull().default(14),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentUq: uniqueIndex('gap_escalation_rules_tenant_agent_uq').on(t.tenant_id, t.agent_id),
  }),
);

export type Entidade = typeof entidades.$inferSelect;
export type Pessoa = typeof pessoas.$inferSelect;
export type Permissao = typeof permissoes.$inferSelect;
export type Conversa = typeof conversas.$inferSelect;
export type Mensagem = typeof mensagens.$inferSelect;
export type Transacao = typeof transacoes.$inferSelect;
export type Conta = typeof contas_bancarias.$inferSelect;
export type Categoria = typeof categorias.$inferSelect;
export type Contraparte = typeof contrapartes.$inferSelect;
export type AgentFact = typeof agent_facts.$inferSelect;
export type LearnedRule = typeof learned_rules.$inferSelect;
export type AgentMemory = typeof agent_memories.$inferSelect;
export type SelfState = typeof self_state.$inferSelect;
export type EntityState = typeof entity_states.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowStep = typeof workflow_steps.$inferSelect;
export type PendingQuestion = typeof pending_questions.$inferSelect;
export type IdempotencyKey = typeof idempotency_keys.$inferSelect;
export type SystemHealthEvent = typeof system_health_events.$inferSelect;
export type DeadLetterJob = typeof dead_letter_jobs.$inferSelect;
export type AuditEntry = typeof audit_log.$inferSelect;
export type PermissionProfile = typeof permission_profiles.$inferSelect;
export type DashboardSession = typeof dashboard_sessions.$inferSelect;
export type ImportRun = typeof import_runs.$inferSelect;
export type ImportEntry = typeof import_entries.$inferSelect;
export type Tenant = typeof tenants.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type CognitiveModuleLog = typeof cognitive_module_log.$inferSelect;
export type CognitiveCandidate = typeof cognitive_candidates.$inferSelect;
export type MemoryEntry = typeof memory_entry.$inferSelect;
export type BehavioralHint = typeof behavioral_hint.$inferSelect;
export type AgentCapabilityDomain = typeof agent_capabilities_domain.$inferSelect;
export type AgentCapabilitySkill = typeof agent_capabilities_skill.$inferSelect;
export type AgentCapabilityGap = typeof agent_capability_gaps.$inferSelect;
export type ProcedureDefinition = typeof procedure_definitions.$inferSelect;
export type ProcedureAssignment = typeof procedure_assignments.$inferSelect;
export type ProcedureExecution = typeof procedure_executions.$inferSelect;
export type ProcedureExecutionEvent = typeof procedure_execution_events.$inferSelect;
export type ProcedureSelectorDecision = typeof procedure_selector_decisions.$inferSelect;
export type ProcedureTest = typeof procedure_tests.$inferSelect;
export type NewProcedureTest = typeof procedure_tests.$inferInsert;
export type ProcedureMetric = typeof procedure_metrics.$inferSelect;
export type AgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferSelect;
export type NewAgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferInsert;
export type AgentDriftAlert = typeof agent_drift_alerts.$inferSelect;
export type NewAgentDriftAlert = typeof agent_drift_alerts.$inferInsert;
export type GapEscalationRule = typeof gap_escalation_rules.$inferSelect;
export type NewGapEscalationRule = typeof gap_escalation_rules.$inferInsert;

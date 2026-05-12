import {
  pgTable,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  integer,
  boolean,
  date,
  unique,
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
    uniq: unique('agent_facts_tenant_agent_escopo_chave_key').on(
      t.tenant_id,
      t.agent_id,
      t.escopo,
      t.chave,
    ),
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

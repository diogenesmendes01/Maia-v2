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
  check,
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

// Spec 18 — Scheduling: Series, Occurrences, Tasks, Outbox.
// Lives in its own domain alongside `workflows` (which keeps dual_approval
// and any other ad-hoc workflow types). Recurring scheduling never touches
// `workflows` anymore — the v1 chain_id design was scrapped per spec 18 v2.
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tipo: text('tipo').notNull(),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    rrule: text('rrule'),
    one_shot_at: timestamp('one_shot_at', { withTimezone: true }),
    month_end_policy: text('month_end_policy').notNull().default('skip_invalid_month'),
    missed_run_policy: text('missed_run_policy').notNull().default('fire_latest_only'),
    staleness_threshold_hours: integer('staleness_threshold_hours').notNull().default(24),
    exclusive_per_destinatario: boolean('exclusive_per_destinatario').notNull().default(false),
    contexto_template: jsonb('contexto_template').notNull().default(sql`'{}'::jsonb`),
    entidade_id: uuid('entidade_id'),
    owner_pessoa_id: uuid('owner_pessoa_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => ({
    by_owner_active: index('idx_series_active').on(t.owner_pessoa_id),
  }),
);

export const occurrences = pgTable(
  'occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    series_id: uuid('series_id').notNull(),
    scheduled_for: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    outcome: text('outcome'),
    claimed_by: text('claimed_by'),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    correlation_token: text('correlation_token'),
    contexto_snapshot: jsonb('contexto_snapshot').notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_series_sched: unique('occurrences_series_scheduled_uniq').on(t.series_id, t.scheduled_for),
    by_due: index('idx_occurrences_due').on(t.scheduled_for),
    by_series_status: index('idx_occurrences_series_status').on(t.series_id, t.status),
  }),
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrence_id: uuid('occurrence_id').notNull(),
    ordem: integer('ordem').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    result: jsonb('result').notNull().default(sql`'{}'::jsonb`),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    by_occurrence_ordem: unique('tasks_occurrence_ordem_uniq').on(t.occurrence_id, t.ordem),
  }),
);

export const outbox_messages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrence_id: uuid('occurrence_id'),
    task_id: uuid('task_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    claimed_by: text('claimed_by'),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(5),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    last_error: text('last_error'),
    sent_at: timestamp('sent_at', { withTimezone: true }),
    dedup_key: text('dedup_key'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_due: index('idx_outbox_due').on(t.next_attempt_at),
  }),
);

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
  // Spec 18 §7.5 — per-occurrence audit trail. Nullable; only set by scheduling flows.
  occurrence_id: uuid('occurrence_id'),
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
    tenantStatusIdx: index('agents_tenant_status_idx').on(t.tenant_id, t.status),
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
    // subject_id é nullable: é obrigatório para scope_type
    // ∈ {conversation, interlocutor, channel, role}, e pode ser NULL para
    // scope_type ∈ {agent, tenant} (onde tenant_id/agent_id já carregam o
    // escopo). findRelevant em repositories.ts emite o disjunto
    // `eq(scope_type, 'agent')` sem checar subject_id, refletindo isso.
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
  // P83-C3: Drizzle definitions must mirror the SQL migration's CHECK +
  // UNIQUE so drizzle-kit drift detection does not propose dropping them
  // and so the types match what the database actually enforces.
  (t) => ({
    tenantAgentStatusIdx: index('procedure_def_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.nome),
    sourceCandidateIdx: index('procedure_def_source_candidate_idx').on(t.source_candidate_id),
    nameVersionUniq: unique('procedure_def_name_version_uniq').on(
      t.tenant_id,
      t.agent_id,
      t.nome,
      t.version_number,
    ),
    // P83-C4: partial UNIQUE so the DB rejects two simultaneously active
    // versions of the same nome. Promoted from a plain partial index to
    // a UNIQUE partial index. Migration 020 enforces this at the DB layer
    // (CREATE UNIQUE INDEX ... WHERE status='active').
    activeUniqIdx: uniqueIndex('procedure_def_active_uniq_idx')
      .on(t.tenant_id, t.agent_id, t.nome)
      .where(sql`status = 'active'`),
    scopeCheck: check(
      'procedure_def_scope_check',
      sql`scope IN ('global', 'tenant', 'agent', 'role')`,
    ),
    statusCheck: check(
      'procedure_def_status_check',
      sql`status IN ('draft', 'proposed', 'active', 'frozen', 'rolled_back')`,
    ),
    sourceCheck: check(
      'procedure_def_source_check',
      sql`source IN ('ensino', 'observacao', 'pratica', 'platform_wisdom')`,
    ),
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
    targetUniq: unique('procedure_assignments_target_uniq').on(
      t.tenant_id,
      t.definition_id,
      t.target_type,
      t.target_id,
    ),
    targetTypeCheck: check(
      'procedure_assignments_target_type_check',
      sql`target_type IN ('agent', 'role')`,
    ),
  }),
);

/**
 * Event-sourced status transition log for procedure_definitions. Each row
 * captures who moved the definition between which states and when.
 * (PR #83 H1, H2)
 */
export const procedure_status_events = pgTable(
  'procedure_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    definition_id: uuid('definition_id').notNull(),
    from_status: text('from_status').notNull(),
    to_status: text('to_status').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    defIdx: index('procedure_status_events_def_idx').on(t.definition_id, t.occurred_at),
    tenantAgentIdx: index('procedure_status_events_tenant_agent_idx').on(
      t.tenant_id,
      t.agent_id,
      t.occurred_at,
    ),
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

// P4: agent_operational_profile_versions — append-only, 1 JSONB `profile_body`
// (v3.1.1: { schema_version, identity{...}, style{...}, metadata{...} }) +
// status (proposed | active | frozen | rolled_back). Apenas a row `active` por
// (tenant_id, agent_id) entra em runtime — esse invariante é garantido pelo
// unique index parcial `agent_op_profile_unique_active_idx` declarado em
// migrations/025 (Drizzle não expressa WHERE em uniqueIndex; a DB enforce).
export const agent_operational_profile_versions = pgTable(
  'agent_operational_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    profile_body: jsonb('profile_body').notNull().default(sql`'{}'::jsonb`),
    // shape: { schema_version, identity{...}, style{...}, metadata{...} } — ver migration 025
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

// P5: capability_proposals — propostas formais (spec gerada por LLM no nível 'proposed').
// Fluxo de status: draft -> submitted -> approved/rejected -> delivered. Sem aprovação
// explícita, o agente não ganha a capability; loop fechado via capability_test_results.
export const capability_proposals = pgTable(
  'capability_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    gap_id: uuid('gap_id'),
    capability_type: text('capability_type').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    proposed_spec: jsonb('proposed_spec').notNull().default(sql`'{}'::jsonb`),
    motivation: text('motivation').notNull(),
    expected_impact: text('expected_impact'),
    test_scenarios: jsonb('test_scenarios').notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('draft'),
    submitted_at: timestamp('submitted_at', { withTimezone: true }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decided_by: text('decided_by'),
    decision_reason: text('decision_reason'),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    delivery_artifact_ref: text('delivery_artifact_ref'),
    // P87-C3 — closed-loop test gate. Estes são populados pelo orchestrator
    // `activateApprovedCapability` (capability-test-runner.ts), nunca pelo
    // state-machine puro.
    last_test_outcome: text('last_test_outcome'), // 'pass' | 'fail' | 'error' | null
    last_test_at: timestamp('last_test_at', { withTimezone: true }),
    reverted_at: timestamp('reverted_at', { withTimezone: true }),
    revert_reason: text('revert_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('cap_proposals_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.created_at),
    gapIdx: index('cap_proposals_gap_idx').on(t.gap_id),
  }),
);

// P5: capability_test_results — auditoria do loop fechado pós-ativação. Cada execução
// dos test_scenarios da proposal gera uma linha; outcome=fail/error pode disparar
// triggered_revert=true e criar um technical_gap_id (gap derivado para investigação).
export const capability_test_results = pgTable(
  'capability_test_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    proposal_id: uuid('proposal_id').notNull(),
    gap_id: uuid('gap_id'),
    outcome: text('outcome').notNull(),
    scenarios_run: jsonb('scenarios_run').notNull().default(sql`'[]'::jsonb`),
    scenarios_passed: integer('scenarios_passed').notNull().default(0),
    scenarios_failed: integer('scenarios_failed').notNull().default(0),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    triggered_revert: boolean('triggered_revert').notNull().default(false),
    technical_gap_id: uuid('technical_gap_id'),
    ran_at: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposalIdx: index('cap_test_results_proposal_idx').on(t.proposal_id, t.ran_at),
    outcomeIdx: index('cap_test_results_outcome_idx').on(t.tenant_id, t.agent_id, t.outcome, t.ran_at),
  }),
);

// P6: channels — instâncias de entrada de mensagem (1+ por agent). channel_type
// + external_id é a chave estável (UNIQUE por tenant); um mesmo agent pode ter
// múltiplos canais (várias instâncias WhatsApp, telegram, etc).
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    external_id: text('external_id').notNull(),
    channel_type: text('channel_type').notNull(),
    display_name: text('display_name'),
    active: boolean('active').notNull().default(true),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('channels_tenant_agent_idx').on(t.tenant_id, t.agent_id),
    externalIdx: index('channels_external_idx').on(t.channel_type, t.external_id),
    externalUq: uniqueIndex('channels_tenant_type_external_uq').on(t.tenant_id, t.channel_type, t.external_id),
  }),
);

// P6: roles — modos operacionais por agent (comercial, suporte, default, etc).
// Exatamente 1 default por (tenant, agent), garantido por partial unique index.
// prompt_addendum entra no prompt quando o role estiver ativo.
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    role_key: text('role_key').notNull(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    prompt_addendum: text('prompt_addendum'),
    active: boolean('active').notNull().default(true),
    is_default: boolean('is_default').notNull().default(false),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentActiveIdx: index('roles_tenant_agent_active_idx').on(t.tenant_id, t.agent_id, t.active),
    keyUq: uniqueIndex('roles_tenant_agent_key_uq').on(t.tenant_id, t.agent_id, t.role_key),
  }),
);

// P6: channel_policies — define o default role do channel + governance (switch_behavior)
// + travas anti-oscilação para by_context (min_confidence, cooldown_turns, strength_delta,
// max_switches). UNIQUE (channel_id) garante 1 policy por canal.
export const channel_policies = pgTable(
  'channel_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    channel_id: uuid('channel_id').notNull(),
    default_role_id: uuid('default_role_id').notNull(),
    switch_behavior: text('switch_behavior').notNull(),
    announce_mode: text('announce_mode').notNull().default('affects_user'),
    by_context_guards: jsonb('by_context_guards').notNull().default(sql`'{"min_confidence_to_switch":0.7,"cooldown_turns":3,"required_strength_delta":0.2,"max_switches_per_conversation":3}'::jsonb`),
    allowed_role_ids: jsonb('allowed_role_ids').notNull().default(sql`'[]'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('channel_policies_tenant_agent_idx').on(t.tenant_id, t.agent_id),
    channelUq: uniqueIndex('channel_policies_channel_uq').on(t.channel_id),
  }),
);

// P6: role_selector_decisions — log append-only de TODA decisão do role selector
// (mesmo "keep_current"). suggested_by registra a sugestão (LLM ou determinístico);
// decided_by registra QUEM decidiu — NUNCA llm_classifier (CHECK constraint no DB).
// LLM sugere, policy decide. Defesa do criterio #2 da spec.
export const role_selector_decisions = pgTable(
  'role_selector_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    channel_id: uuid('channel_id'),
    policy_id: uuid('policy_id'),
    current_role_id: uuid('current_role_id'),
    suggested_role_id: uuid('suggested_role_id'),
    decided_role_id: uuid('decided_role_id').notNull(),
    action: text('action').notNull(),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
    conflicts: jsonb('conflicts').notNull().default(sql`'[]'::jsonb`),
    suggested_by: text('suggested_by').notNull(),
    decided_by: text('decided_by').notNull(),
    suggested_strength: text('suggested_strength'),
    suggested_confidence: numeric('suggested_confidence', { precision: 4, scale: 3 }),
    reason: text('reason'),
    switch_count_in_conversation: integer('switch_count_in_conversation').notNull().default(0),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversaIdx: index('role_selector_conversa_idx').on(t.conversa_id, t.decided_at),
    tenantAgentIdx: index('role_selector_tenant_agent_idx').on(t.tenant_id, t.agent_id, t.decided_at),
  }),
);

// P10b: runtime_trace_envelopes — sync envelope written BEFORE any side
// effect with side_effect_level >= medium. Narrow shape, written in the
// hot path; the heavy packet body lives in runtime_trace_bodies and is
// persisted async via the TraceBody writer worker.
// Invariant 12: envelope MUST precede the side effect.
// Invariant 8: envelope_hmac is HMAC-SHA256(secret = per-tenant key from
// KMS, payload = canonical-JSON of envelope minus envelope_hmac field).
export const runtime_trace_envelopes = pgTable(
  'runtime_trace_envelopes',
  {
    trace_id: uuid('trace_id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    policy_id: uuid('policy_id'),
    decision: text('decision').notNull(),
    side_effect_level: text('side_effect_level').notNull(),
    redaction_class: text('redaction_class').notNull().default('standard'),
    envelope_hmac: text('envelope_hmac').notNull(),
    hmac_key_version: integer('hmac_key_version').notNull(),
    body_status: text('body_status').notNull().default('pending'),
    body_persisted_at: timestamp('body_persisted_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('runtime_trace_env_tenant_created_idx').on(
      t.tenant_id,
      t.agent_id,
      t.created_at,
    ),
    bodyPendingIdx: index('runtime_trace_env_body_pending_idx').on(t.created_at),
    conversaIdx: index('runtime_trace_env_conversa_idx').on(t.conversa_id, t.created_at),
  }),
);

// P10b: runtime_trace_bodies — async body persistence. PK = trace_id so the
// writer worker can use ON CONFLICT DO NOTHING to make at-least-once delivery
// idempotent. The body is the redacted ExecutionContextPacket + DecisionPacket
// payload; when redaction_class='debug' on the envelope, the body is replaced
// by an encrypted AES-GCM snapshot uploaded to S3 (24h TTL, MFA-gated read).
export const runtime_trace_bodies = pgTable(
  'runtime_trace_bodies',
  {
    trace_id: uuid('trace_id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    packet: jsonb('packet').notNull(),
    packet_hmac: text('packet_hmac').notNull(),
    hmac_key_version: integer('hmac_key_version').notNull(),
    redaction_applied: text('redaction_applied').notNull(),
    bytes_redacted: integer('bytes_redacted').notNull().default(0),
    encrypted: boolean('encrypted').notNull().default(false),
    s3_uri: text('s3_uri'),
    persisted_at: timestamp('persisted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('runtime_trace_bodies_tenant_idx').on(
      t.tenant_id,
      t.agent_id,
      t.persisted_at,
    ),
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
export type ProcedureStatusEvent = typeof procedure_status_events.$inferSelect;
// Scheduling v2 aliases — table names are plural, type aliases are singular.
export type Series = typeof series.$inferSelect;
export type SeriesInsert = typeof series.$inferInsert;
export type Occurrence = typeof occurrences.$inferSelect;
export type OccurrenceInsert = typeof occurrences.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type OutboxMessage = typeof outbox_messages.$inferSelect;
export type OutboxMessageInsert = typeof outbox_messages.$inferInsert;

// Subset of procedure_definitions columns mutable by the status transition
// engine. Kept narrow on purpose so callers cannot accidentally update
// unrelated columns via the same code path.
export type ProcedureStatusUpdate = {
  status?: ProcedureDefinition['status'];
  proposed_by?: string | null;
  approved_by?: string | null;
  approved_at?: Date | null;
  activated_at?: Date | null;
  deactivated_at?: Date | null;
};

export type AgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferSelect;
export type NewAgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferInsert;

// Single source of truth for the ProfileBody schema version literal.
// Bump this constant when introducing a new ProfileBody shape (e.g., v3.1.2).
export const PROFILE_BODY_SCHEMA_VERSION = 'v3.1.1-2026-05-15' as const;
export type ProfileBodySchemaVersion = typeof PROFILE_BODY_SCHEMA_VERSION;

// Tipo estrutural do JSONB `profile_body` (v3.1.1)
export interface ProfileBody {
  schema_version: ProfileBodySchemaVersion;
  identity: {
    role_descriptor: string;
    voice: {
      tone: string;
      formality: 'low' | 'medium' | 'high';
      verbosity: 'concise' | 'medium' | 'detailed';
    };
    cognitive_limits: {
      max_inference_depth: number;
      max_speculation_in_response: number;
      confidence_floor_for_action: number;
    };
    priorities: string[];
    learned_voice_modifiers: unknown[];
  };
  style: {
    language: string;
    rhythm: Record<string, unknown>;
  };
  metadata: {
    effective_from: string;
    created_by: string;
    previous_version_id: string | null;
  };
}
export type AgentDriftAlert = typeof agent_drift_alerts.$inferSelect;
export type NewAgentDriftAlert = typeof agent_drift_alerts.$inferInsert;
export type GapEscalationRule = typeof gap_escalation_rules.$inferSelect;
export type NewGapEscalationRule = typeof gap_escalation_rules.$inferInsert;
export type CapabilityProposal = typeof capability_proposals.$inferSelect;
export type NewCapabilityProposal = typeof capability_proposals.$inferInsert;
export type CapabilityTestResult = typeof capability_test_results.$inferSelect;
export type NewCapabilityTestResult = typeof capability_test_results.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type ChannelPolicy = typeof channel_policies.$inferSelect;
export type NewChannelPolicy = typeof channel_policies.$inferInsert;
export type RoleSelectorDecisionRow = typeof role_selector_decisions.$inferSelect;
export type NewRoleSelectorDecisionRow = typeof role_selector_decisions.$inferInsert;
export type RuntimeTraceEnvelope = typeof runtime_trace_envelopes.$inferSelect;
export type NewRuntimeTraceEnvelope = typeof runtime_trace_envelopes.$inferInsert;
export type RuntimeTraceBody = typeof runtime_trace_bodies.$inferSelect;
export type NewRuntimeTraceBody = typeof runtime_trace_bodies.$inferInsert;

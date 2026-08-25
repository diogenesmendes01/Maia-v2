import {
  pgTable,
  pgMaterializedView,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  integer,
  bigserial,
  boolean,
  date,
  unique,
  uniqueIndex,
  index,
  check,
  varchar,
  bigint,
  smallint,
  primaryKey,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AudienceType, TrustLevel } from '@/shared/audience.js';
import { AUDIENCE_TYPES, TRUST_LEVELS } from '@/shared/audience.js';

export const entidades = pgTable('entidades', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  nome: text('nome').notNull(),
  tipo: text('tipo').notNull(),
  documento: text('documento'),
  status: text('status').notNull().default('ativa'),
  cor: text('cor'),
  observacoes: text('observacoes'),
  // Calendar v2: localização para resolução de feriados regionais (M036).
  // NULL = retrocompat; sem cidade/uf, só feriados nacionais aplicam-se.
  cidade: text('cidade'),
  uf: varchar('uf', { length: 2 }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Calendar v2: holidays — feriados nacionais, estaduais, municipais, custom
// por entidade e recessos de holding. tenant_id NOT NULL (P0 invariant).
// Veja migrations/056_calendar_b_holidays.sql para CHECK constraints.
export const holidays = pgTable(
  'holidays',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    name: text('name').notNull(),
    month: smallint('month').notNull(),
    day: smallint('day').notNull(),
    year: integer('year'),
    type: text('type').notNull(),
    uf: varchar('uf', { length: 2 }),
    cidade: text('cidade'),
    proposal_id: uuid('proposal_id'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    status: text('status').notNull().default('ativo'),
    source: text('source'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantDateIdx: index('idx_holidays_tenant_date').on(t.tenant_id, t.month, t.day),
    tenantRegionalIdx: index('idx_holidays_tenant_regional').on(t.tenant_id, t.type, t.uf, t.cidade),
  }),
);

// Calendar v2: junction holiday_entidades (custom holidays linked to specific
// entidades, e.g. holding recess for entidade X). tenant_id explícito.
export const holiday_entidades = pgTable(
  'holiday_entidades',
  {
    tenant_id: text('tenant_id').notNull(),
    holiday_id: bigint('holiday_id', { mode: 'number' }).notNull(),
    entidade_id: uuid('entidade_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.holiday_id, t.entidade_id] }),
    tenantEntidadeIdx: index('idx_holiday_entidades_tenant_entidade').on(t.tenant_id, t.entidade_id),
  }),
);

export type Holiday = typeof holidays.$inferSelect;
export type NewHoliday = typeof holidays.$inferInsert;
export type HolidayEntidade = typeof holiday_entidades.$inferSelect;
export type NewHolidayEntidade = typeof holiday_entidades.$inferInsert;

export const contas_bancarias = pgTable('contas_bancarias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  transacao_origem_id: uuid('transacao_origem_id').notNull(),
  transacao_destino_id: uuid('transacao_destino_id').notNull(),
  tipo: text('tipo').notNull(),
  observacoes: text('observacoes'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recorrencias = pgTable('recorrencias', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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

export const pessoas = pgTable(
  'pessoas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    nome: text('nome').notNull(),
    apelido: text('apelido'),
    // Issue #407: the global unique on telefone_whatsapp (migration 001) is
    // relaxed to a COMPOSITE unique (tenant_id, agent_id, telefone_whatsapp)
    // in migration 074 so the same phone can exist for two agents with
    // distinct audience roles. The column itself is no longer `.unique()`.
    telefone_whatsapp: text('telefone_whatsapp').notNull(),
    tipo: text('tipo').notNull(),
    email: text('email'),
    observacoes: text('observacoes'),
    preferencias: jsonb('preferencias').notNull().default(sql`'{}'::jsonb`),
    modelo_mental: jsonb('modelo_mental').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('ativa'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    telefoneUniq: unique('pessoas_tenant_agent_telefone_key').on(
      t.tenant_id,
      t.agent_id,
      t.telefone_whatsapp,
    ),
  }),
);

/**
 * agent_audience_profiles — per-agent audience relation (issue #407).
 *
 * The relation that answers "who is this pessoa FOR THIS AGENT?". 1:1 with
 * `pessoas` for now (UNIQUE on tenant_id+agent_id+pessoa_id). `audience_type`
 * and `trust_level` are GOVERNANCE-DERIVED (invariant #3 — never declared by
 * the LLM); their legal values are the canonical enums in
 * `src/shared/audience.ts`. `status` mirrors the resolver's fail-closed
 * vocabulary: a row that is not `active` makes the audience resolution
 * fail-closed (treated as quarantined).
 *
 * Tenant isolation (invariant #1): tenant_id + agent_id NOT NULL; every
 * read/write through `agentAudienceProfilesRepo` is scoped via the ALS
 * context. See migration 074 for FK + CHECK constraints.
 */
export const agent_audience_profiles = pgTable(
  'agent_audience_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    pessoa_id: uuid('pessoa_id').notNull(),
    audience_type: text('audience_type').notNull().default('unknown'),
    trust_level: text('trust_level').notNull().default('unverified'),
    status: text('status').notNull().default('active'),
    permission_profile_ids: text('permission_profile_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pessoaUniq: unique('agent_audience_profiles_tenant_agent_pessoa_key').on(
      t.tenant_id,
      t.agent_id,
      t.pessoa_id,
    ),
    // Hard 1:1 with pessoas (mirrors migration 074's UNIQUE(pessoa_id)): a
    // pessoa already belongs to one (tenant, agent), so it gets one profile.
    pessoaOnlyUniq: unique('agent_audience_profiles_pessoa_key').on(t.pessoa_id),
    lookupIdx: index('agent_audience_profiles_tenant_agent_pessoa_idx').on(
      t.tenant_id,
      t.agent_id,
      t.pessoa_id,
    ),
    // CHECK constraints mirror migration 074. audience_type/trust_level draw
    // their legal values from the canonical enums in src/shared/audience.ts
    // (referenced here so the Drizzle schema and the SQL never drift); status
    // uses the resolver's fail-closed vocabulary.
    audienceTypeChk: check(
      'agent_audience_profiles_audience_type_chk',
      sql`${t.audience_type} IN (${sql.raw(AUDIENCE_TYPES.map((v) => `'${v}'`).join(', '))})`,
    ),
    trustLevelChk: check(
      'agent_audience_profiles_trust_level_chk',
      sql`${t.trust_level} IN (${sql.raw(TRUST_LEVELS.map((v) => `'${v}'`).join(', '))})`,
    ),
    statusChk: check(
      'agent_audience_profiles_status_chk',
      sql`${t.status} IN ('active', 'inactive', 'quarantined', 'blocked')`,
    ),
  }),
);

/**
 * agent_tool_grants — the per-agent tool grant (issue #408).
 *
 * Answers "what tools does THIS AGENT have installed?" — a DIFFERENT axis from
 * "what can the PERSON do" (`permissoes`). The two compose by AND at runtime
 * (the Runtime Tool Filter). A grant lists:
 *   - `granted_packs`  — pack ids from `src/tools/packs.ts` (product packs),
 *   - `granted_tools`  — individual tool names granted outside a pack,
 *   - `denied_tools`   — HARD deny: never visible to the LLM AND refused by the
 *                        dispatcher, even if also in a granted pack/tool.
 * `baseline.core` is ALWAYS unioned in at runtime (the conservative floor), so
 * the default grant is `granted_packs=['baseline.core','domain.calendar']`
 * (migration 085 backfilled existing grants and updated the column default).
 *
 * Tenant isolation (invariant #1): tenant_id + agent_id NOT NULL; the row is
 * UNIQUE per (tenant_id, agent_id) — one effective grant per agent. Every
 * read/write through `agentToolGrantsRepo` is scoped via the ALS context.
 * See migration 076 for FK + the partial-creation default-grant seed.
 */
export const agent_tool_grants = pgTable(
  'agent_tool_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    granted_packs: text('granted_packs')
      .array()
      .notNull()
      .default(sql`'{baseline.core,domain.calendar}'::text[]`),
    granted_tools: text('granted_tools').array().notNull().default(sql`'{}'::text[]`),
    denied_tools: text('denied_tools').array().notNull().default(sql`'{}'::text[]`),
    granted_by: text('granted_by'),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One effective grant per agent (invariant #1 — tenant-scoped uniqueness).
    agentUniq: unique('agent_tool_grants_tenant_agent_key').on(t.tenant_id, t.agent_id),
    lookupIdx: index('agent_tool_grants_tenant_agent_idx').on(t.tenant_id, t.agent_id),
  }),
);

export const permission_profiles = pgTable('permission_profiles', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  pessoa_id: uuid('pessoa_id').notNull(),
  // 090 (fase 0 roteamento multi-linha) — identidade da conversa inclui o
  // canal: mesma pessoa em duas linhas = duas conversas; a resposta sai pela
  // linha da conversa. NULL = legado (casa qualquer canal do agente até
  // encerrar). FK composta (tenant, agent, channel) na migração.
  channel_id: uuid('channel_id'),
  escopo_entidades: uuid('escopo_entidades').array().notNull().default(sql`'{}'::uuid[]`),
  status: text('status').notNull().default('ativa'),
  contexto_resumido: text('contexto_resumido'),
  ultima_atividade_em: timestamp('ultima_atividade_em', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mensagens = pgTable('mensagens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  conversa_id: uuid('conversa_id'),
  // 090 — canal (linha) que entregou/enviará a mensagem. O dedup de
  // whatsapp_id é POR CANAL para rows novas (a unique global de 003 colidiria
  // IDs entre linhas/tenants — spec roteamento v4 §1.7). NULL = legado.
  channel_id: uuid('channel_id'),
  direcao: text('direcao').notNull(),
  tipo: text('tipo').notNull(),
  conteudo: text('conteudo'),
  midia_url: text('midia_url'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  processada_em: timestamp('processada_em', { withTimezone: true }),
  ferramentas_chamadas: jsonb('ferramentas_chamadas').notNull().default(sql`'[]'::jsonb`),
  tokens_usados: integer('tokens_usados'),
  // 118 (#505, shadow) — identidade da STREAM de ordenação e a posição deste
  // ingresso dentro dela. NULL = row anterior ao protocolo, ou outbound (que
  // nunca recebe stream). NÃO confundir `ingress_seq` com o homônimo de
  // `agent_turn_inputs`: aquele é a posição DENTRO DO TURNO (começa em 0), este
  // é a posição DENTRO DA STREAM (começa em 1) — ver migrations/118.
  stream_key: text('stream_key'),
  stream_key_version: smallint('stream_key_version'),
  ingress_seq: bigint('ingress_seq', { mode: 'number' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agent_facts = pgTable(
  'agent_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    escopo: text('escopo').notNull(),
    chave: text('chave').notNull(),
    valor: jsonb('valor').notNull(),
    confianca: numeric('confianca', { precision: 3, scale: 2 }).notNull().default('1.00'),
    fonte: text('fonte').notNull().default('aprendido'),
    ultima_validacao: timestamp('ultima_validacao', { withTimezone: true }),
    // P8c + P10a — Knowledge State Machine lifecycle columns
    // (P8c added lifecycle_status/evidence_count/lifecycle_transitions in
    // migration 041; P10a added last_recall_at in migration 050. P8c
    // shapes win because IF NOT EXISTS in 050 makes column ADDs no-ops.)
    lifecycle_status: text('lifecycle_status').notNull().default('active'),
    evidence_count: integer('evidence_count').notNull().default(1),
    lifecycle_transitions: jsonb('lifecycle_transitions').notNull().default(sql`'[]'::jsonb`),
    last_recall_at: timestamp('last_recall_at', { withTimezone: true }),
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
    // Issue #281 (redesigned in PR #310) — KSM auto-promoter hot path.
    // The promoter sweeps `WHERE lifecycle_status = X AND <updated_at /
    // evidence filter> LIMIT 100` hourly (workers/knowledge-state-
    // promoter.ts → repos.ts listEligible). Two partial indexes back it:
    //   (1) in-flight states swept by promoter steps 1-5;
    //   (2) the 'active' bulk swept by step 6 (active→deprecated).
    // The old (tenant_id, agent_id, id) index was dropped — it was
    // redundant with the PK on `id` for the findById/update path.
    // Created via migration 066 CONCURRENTLY.
    lifecycleInflightIdx: index('idx_agent_facts_lifecycle_inflight')
      .on(t.lifecycle_status, t.updated_at)
      .where(
        sql`lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified')`,
      ),
    // Expression index on the coalesced value the promoter's active sweep
    // ranges over (`COALESCE(last_recall_at, updated_at) < cutoff`). A
    // btree over the two SEPARATE columns cannot back a range over the
    // COALESCE(...) expression, so it must key on the expression itself
    // (mirrors migration 066: `((COALESCE(last_recall_at, updated_at)))`).
    lifecycleActiveIdx: index('idx_agent_facts_lifecycle_active')
      .on(sql`COALESCE(last_recall_at, updated_at)`)
      .where(sql`lifecycle_status = 'active'`),
  }),
);

export const learned_rules = pgTable(
  'learned_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    // P8c + P10a — Knowledge State Machine lifecycle columns
    // (P8c added lifecycle_status/evidence_count/lifecycle_transitions in
    // migration 041; P10a added last_recall_at in migration 050.)
    lifecycle_status: text('lifecycle_status').notNull().default('active'),
    evidence_count: integer('evidence_count').notNull().default(1),
    lifecycle_transitions: jsonb('lifecycle_transitions').notNull().default(sql`'[]'::jsonb`),
    last_recall_at: timestamp('last_recall_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Issue #281 (redesigned in PR #310, B3) — learned_rules was the
    // fourth KSM table previously omitted. The auto-promoter sweeps it
    // identically to the other three. Two partial lifecycle indexes back
    // `listEligible` (see agent_facts above for the full rationale).
    // Created via migration 066 CONCURRENTLY.
    lifecycleInflightIdx: index('idx_learned_rules_lifecycle_inflight')
      .on(t.lifecycle_status, t.updated_at)
      .where(
        sql`lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified')`,
      ),
    // Expression index on the coalesced value the promoter's active sweep
    // ranges over (`COALESCE(last_recall_at, updated_at) < cutoff`). A
    // btree over the two SEPARATE columns cannot back a range over the
    // COALESCE(...) expression, so it must key on the expression itself
    // (mirrors migration 066: `((COALESCE(last_recall_at, updated_at)))`).
    lifecycleActiveIdx: index('idx_learned_rules_lifecycle_active')
      .on(sql`COALESCE(last_recall_at, updated_at)`)
      .where(sql`lifecycle_status = 'active'`),
  }),
);

export const agent_memories = pgTable('agent_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  versao: integer('versao').notNull(),
  system_prompt: text('system_prompt').notNull(),
  resumo_aprendizados: text('resumo_aprendizados'),
  ativa: boolean('ativa').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entity_states = pgTable('entity_states', {
  entidade_id: uuid('entidade_id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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

// Fase 0 cap. 2 (migration 095) — evidência backend imutável de aprovação.
// Fonte de verdade das aprovações humanas (4-eyes/confirmação): intent
// imutável + hash canônico versionado, classe/contagem exigida, expiração e
// máquina de estados com consumo one-time. O LLM nunca cria/assina/consome.
export const approval_requests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    requester_pessoa_id: uuid('requester_pessoa_id').notNull(),
    entidade_id: uuid('entidade_id'),
    conversa_id: uuid('conversa_id'),
    mensagem_id: uuid('mensagem_id'),
    request_id: text('request_id'),
    tool: text('tool').notNull(),
    operation_type: text('operation_type').notNull(),
    intent_payload: jsonb('intent_payload').notNull(),
    intent_hash: text('intent_hash').notNull(),
    intent_hash_version: integer('intent_hash_version').notNull().default(1),
    approval_class: text('approval_class').notNull(),
    required_approvals: integer('required_approvals').notNull(),
    status: text('status').notNull().default('pending'),
    fingerprint: text('fingerprint').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    denied_at: timestamp('denied_at', { withTimezone: true }),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    claim_token: text('claim_token'),
    result_ref: text('result_ref'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scope_status_idx: index('approval_requests_scope_status_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
      t.expires_at,
    ),
    // Partial unique (WHERE status aberto) vive na migration 095 — Drizzle não
    // expressa o WHERE aqui; a DB enforce.
  }),
);

export const approval_decisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    request_id: uuid('request_id')
      .notNull()
      .references(() => approval_requests.id),
    principal_pessoa_id: uuid('principal_pessoa_id').notNull(),
    principal_tipo: text('principal_tipo').notNull(),
    decision: text('decision').notNull(),
    channel: text('channel').notNull().default('whatsapp'),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    request_principal_uq: unique('approval_decisions_request_principal_uq').on(
      t.request_id,
      t.principal_pessoa_id,
    ),
    scope_idx: index('approval_decisions_scope_idx').on(t.tenant_id, t.agent_id, t.request_id),
  }),
);

// Spec 18 — Scheduling: Series, Occurrences, Tasks, Outbox.
// Lives in its own domain alongside `workflows` (which keeps dual_approval
// and any other ad-hoc workflow types). Recurring scheduling never touches
// `workflows` anymore — the v1 chain_id design was scrapped per spec 18 v2.
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    // Tenant/agent-led partial index (migration 073, no-tx). Leads with
    // (tenant_id, agent_id) so soon-to-be tenant-scoped active-series
    // lookups probe by tenant before owner. Partial on status='active'.
    by_owner_active: index('idx_series_active')
      .on(t.tenant_id, t.agent_id, t.owner_pessoa_id)
      .where(sql`status = 'active'`),
  }),
);

export const occurrences = pgTable(
  'occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    // Tenant/agent-led partial "due" sweep index (migration 073, no-tx).
    // scheduled_for stays last so the dispatcher's LIMIT walks due rows
    // in order within a (tenant, agent) bucket. Partial on pending/claimed.
    by_due: index('idx_occurrences_due')
      .on(t.tenant_id, t.agent_id, t.scheduled_for)
      .where(sql`status IN ('pending', 'claimed')`),
    by_series_status: index('idx_occurrences_series_status').on(t.series_id, t.status),
    // Tenant/agent-led correlation-token lookup (migration 073, no-tx).
    // Partial on rows actively awaiting a correlated reply.
    by_correlation: index('idx_occurrences_correlation')
      .on(t.tenant_id, t.agent_id, t.correlation_token)
      .where(
        sql`correlation_token IS NOT NULL AND status IN ('awaiting_third_party', 'in_progress')`,
      ),
  }),
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    occurrence_id: uuid('occurrence_id'),
    task_id: uuid('task_id'),
    // 090 — linha pela qual a mensagem DEVE sair. Rows enviáveis
    // (pending/claimed) exigem canal (CHECK outbox_sendable_requires_channel);
    // não-deriváveis no backfill ficam status='blocked_channel_unresolved'
    // e o drain as ignora (fail-closed — nunca escolher linha sozinho).
    channel_id: uuid('channel_id'),
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
    // Tenant/agent-led partial relay "due" sweep index (migration 073,
    // no-tx). next_attempt_at last so the relayer's LIMIT walks due rows
    // in order within a (tenant, agent) bucket. Partial on pending/claimed.
    by_due: index('idx_outbox_due')
      .on(t.tenant_id, t.agent_id, t.next_attempt_at)
      .where(sql`status IN ('pending', 'claimed')`),
  }),
);

export const workflow_steps = pgTable('workflow_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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

// Issue #261: composite PK on (tenant_id, agent_id, key). Prior schema had
// `key` as a singleton PRIMARY KEY, which allowed two tenants computing the
// same idempotency_key to collide in the cache and leak tool output. The
// hash input in `src/governance/idempotency.ts` ALSO folds tenant_id/agent_id
// now, so a collision via the hash alone is no longer possible — but the
// composite PK makes the storage layer reflect the true identity tuple and
// guards against any future caller that bypasses `computeIdempotencyKey`.
// See migration 063_p10_idempotency_keys_tenant_pk.
//
// Issue #298: atomic reservation via INSERT ON CONFLICT.
//   - `state` distinguishes a reservation in flight ('in_progress') from a
//     completed handler ('completed'). Default 'completed' so the existing
//     write-once-after-handler rows in main are classified correctly with
//     no backfill (see migration 064).
//   - `expires_at` is the wall-clock deadline for in-flight reservations;
//     past it, a stale reservation can be reclaimed by the next caller and
//     the cleanup worker. NULL for completed rows.
//   - `resultado` is now nullable — only completed rows carry a result.
//     A DB-side CHECK enforces (state, resultado, expires_at) coherence
//     so a hand-crafted INSERT can't produce a malformed row.
//
// Issue #298 review (B2 + B3 — migration 065):
//   - `state` now also admits the terminal 'failed' value: a handler that
//     threw (or produced a malformed response) transitions in_progress→failed
//     instead of deleting the row, so a subsequent same-key dispatch does NOT
//     silently re-execute a partially-applied side effect.
//   - `reservation_token` is a fencing token (UUID) stamped on every
//     reservation (fresh INSERT or stale-lock reclaim). markCompleted /
//     releaseReservation only mutate the row when the caller presents the
//     token they received from tryReserve, so a slow/preempted owner whose
//     lease was reclaimed cannot clobber the new owner's reservation
//     (closes the double-execution window left by the fixed-TTL reclaim).
export const idempotency_keys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    tool_name: text('tool_name').notNull(),
    operation_type: text('operation_type').notNull(),
    pessoa_id: uuid('pessoa_id').notNull(),
    entity_id: uuid('entity_id').notNull(),
    payload_hash: text('payload_hash').notNull(),
    file_sha256: text('file_sha256'),
    resultado: jsonb('resultado'),
    state: text('state').notNull().default('completed'),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    reservation_token: text('reservation_token'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.agent_id, t.key] }),
  }),
);

// Issue #227: outbound delivery idempotency ledger. One row per inbound turn
// (any channel). Pre-send optimistic insert + status-aware guard closes the
// "delivered-but-threw" window left open by #216 phase-tagging. Distinct from
// outbox_messages (async worker queue) — this is the synchronous reply ledger.
// See migrations/063_outbound_messages.sql for the full design + status
// semantics (pending|sent|failed|unknown — 'unknown' is the no-re-send crux).
export const outbound_messages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // Turn-scoped: `${conversa_id}:${in_reply_to}`. Mirrors the
    // outbound_dispatch_failed audit metadata.idempotency_key from #216.
    // UNIQUE per (tenant_id, agent_id, idempotency_key) — see composite below.
    idempotency_key: text('idempotency_key').notNull(),
    conversa_id: uuid('conversa_id').notNull(),
    in_reply_to: uuid('in_reply_to').notNull(),
    channel: text('channel').notNull(),
    provider_message_id: text('provider_message_id'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    sent_at: timestamp('sent_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // ---------------------------------------------------------------
    // Issue #630 (fatia A de #506) — evolução para OUTBOX DURÁVEL.
    // Migração 121. Todas as colunas abaixo são NULLABLE porque a row
    // LEGADA (anterior ao outbox) não as tem; o CHECK
    // `outbound_messages_durable_row_complete_check` é que exige o tuplo
    // INTEIRO quando `turn_id IS NOT NULL`. Ou seja: "nullable no tipo,
    // obrigatório na row nova" — a nulabilidade serve à coexistência com o
    // legado, nunca a um fallback.
    // O vocabulário (payload types, status, delivery outcomes) vive em
    // src/runtime/outbound/contract.ts; aqui só a forma da tabela.
    // ---------------------------------------------------------------
    /** Turno dono da saída (#503). FK COMPOSTA (tenant, agent, turn_id) na 121. */
    turn_id: uuid('turn_id'),
    /** Posição da saída no turno (0-based). Eixo de ordenação do multipart (#635). */
    sequence_in_turn: integer('sequence_in_turn'),
    /** Versão da união Zod + da serialização canônica (OUTBOUND_PAYLOAD_VERSION). */
    payload_version: integer('payload_version'),
    /** Discriminante da união. Sem `image`/`video`: LineOutput não tem primitiva. */
    payload_type: text('payload_type'),
    /** Payload validado. Mídia por REFERÊNCIA — o contrato TS não tem variante que aceite URL. */
    payload_json: jsonb('payload_json'),
    /** sha256 hex da serialização canônica versionada. Entra na derivação das duas chaves. */
    payload_hash: text('payload_hash'),
    /** Identidade da saída lógica DENTRO da Maia. UNIQUE parcial por (tenant, agent, key). */
    logical_dedupe_key: text('logical_dedupe_key'),
    /** Chave estável entregue ao ADAPTADOR. Mesmo material, domínio de hash DIFERENTE. */
    provider_idempotency_key: text('provider_idempotency_key'),
    /** Tentativas de entrega. MUTÁVEL — por isso nunca entra na derivação das chaves. */
    attempt: integer('attempt').notNull().default(0),
    claimed_by: text('claimed_by'),
    /** Token de FENCING do delivery worker (#632). Mesmo vocabulário de agent_turns. */
    claim_token: uuid('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    /** Gate de backoff. Relógio do BANCO (now()), nunca do processo. */
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    provider_timestamp: timestamp('provider_timestamp', { withTimezone: true }),
    /** Código de baixa cardinalidade e sanitizado (≤64 chars por CHECK). */
    last_error_code: text('last_error_code'),
    /** Resultado NORMALIZADO do provedor: separa "aceitou" de "usuário recebeu". */
    delivery_outcome: text('delivery_outcome'),
  },
  (t) => ({
    byTenantCreated: index('idx_outbound_messages_tenant_created').on(
      t.tenant_id,
      t.created_at,
    ),
    // #292 — sweeper hot path (src/workers/outbound-messages-sweeper.ts). Both
    // sweep ops filter `WHERE tenant_id = $ AND agent_id = $ AND status IN (...)
    // AND created_at < cutoff` and ORDER BY created_at. The (tenant_id,
    // created_at) index above lacks agent_id + status, so the planner would
    // seq-scan + filter. This composite (tenant_id, agent_id, status,
    // created_at) lets the equality columns anchor the scan and created_at back
    // the range predicate + the LIMIT's ORDER BY. Created CONCURRENTLY by
    // migration 067 (no-tx) since outbound_messages can be large in prod.
    byTenantAgentStatusCreated: index(
      'idx_outbound_messages_tenant_agent_status_created',
    ).on(t.tenant_id, t.agent_id, t.status, t.created_at),
    // Multi-tenant invariant (#232/#237): tenant+agent scope the dedupe namespace.
    // Two tenants (or two agents in one tenant) can share the same idempotency_key
    // string without colliding; the advisory-lock in upsertPending hashes the same
    // (tenant_id, agent_id, idempotency_key) tuple so lock partitioning matches.
    byTenantAgentKey: unique('outbound_messages_tenant_agent_key').on(
      t.tenant_id,
      t.agent_id,
      t.idempotency_key,
    ),
    // #630 — identidade lógica da saída. UNIQUE PARCIAL de propósito: o
    // predicado `IS NOT NULL` é o que torna a criação do índice IMUNE a
    // duplicata histórica (nenhuma row legada satisfaz o predicado, logo
    // nenhuma entra no índice, logo nenhuma pode colidir). Ver o bloco
    // "O RISCO DECLARADO NA MÃE" no topo da migração 121.
    logicalDedupeUq: uniqueIndex('outbound_messages_logical_dedupe_uq')
      .on(t.tenant_id, t.agent_id, t.logical_dedupe_key)
      .where(sql`logical_dedupe_key IS NOT NULL`),
    // #630 — rede INDEPENDENTE da anterior: aquela impede "mesmo conteúdo
    // duas vezes"; esta impede "mesma posição do turno com conteúdo
    // diferente", que a outra deixaria passar (payload_hash entra na
    // derivação, então conteúdo diferente gera chave diferente).
    turnSequenceUq: uniqueIndex('outbound_messages_turn_sequence_uq')
      .on(t.tenant_id, t.agent_id, t.turn_id, t.sequence_in_turn)
      .where(sql`turn_id IS NOT NULL`),
    // #630 — seleção do delivery worker (#632). O status vai no PREDICADO
    // parcial e não na chave: são exatamente dois valores, então o índice
    // fica menor e não indexa row terminal (a maioria, sob retenção de 30d).
    // A lista espelha OUTBOUND_SELECTABLE_STATUSES em
    // src/runtime/outbound/contract.ts.
    readyIdx: index('idx_outbound_messages_ready')
      .on(t.tenant_id, t.agent_id, t.next_attempt_at)
      .where(sql`status IN ('pending', 'retryable')`),
  }),
);

// Issue #316: transactional outbox for exactly-once NON-IDEMPOTENT external
// effects. #303/#298 converge the idempotency CACHE on one result (fencing
// token), but a preempted owner can have ALREADY fired its side effect before
// being fenced. For non-idempotent external calls (send WhatsApp, charge,
// 3rd-party POST) that is a duplicate physical effect. The fix: the winning
// reservation's completion writes the INTENDED effect into this outbox IN THE
// SAME TRANSACTION as idempotency_keys → completed (so the effect is bound to
// the winner, not the racer), and a single relayer
// (src/workers/idempotency-outbox-relayer.ts) dispatches it EXACTLY ONCE with
// retry/backoff. The tool handler no longer fires the effect inline — it only
// PLANS it — so no effect escapes the atomic commit.
//
// Distinct from outbound_messages (synchronous reply ledger, #227/#233/#292)
// and outbox_messages (async scheduling queue, Spec 18): this is the
// effect-side of a tool dispatch's idempotency reservation, keyed back to the
// (tenant, agent, idempotency_key) tuple that won the reservation. See
// migrations/068_idempotency_effect_outbox.sql (table) +
// 069_idempotency_effect_outbox_relayer_index.sql (CONCURRENTLY index).
export const idempotency_effect_outbox = pgTable(
  'idempotency_effect_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // The SAME key as the winning idempotency_keys row. UNIQUE per
    // (tenant_id, agent_id, idempotency_key) makes the in-transaction INSERT
    // idempotent: a fenced/duplicate completion can't enqueue a 2nd effect.
    idempotency_key: text('idempotency_key').notNull(),
    // Discriminator for the relayer dispatch switch (e.g. 'whatsapp_text').
    effect_type: text('effect_type').notNull(),
    // Opaque effect description (recipient, text, …). Validated by the relayer
    // per effect_type before the physical dispatch.
    effect_payload: jsonb('effect_payload').notNull(),
    // pending = awaiting relay; sent = dispatched exactly once; failed =
    // exhausted max_attempts (terminal, ops_alert). DB CHECK enforces the set.
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(5),
    last_error: text('last_error'),
    // Backoff gate: the relayer only claims a pending row when
    // next_attempt_at <= now(). Pushed forward on each transient failure.
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Provider message id / external ref on a successful dispatch (audit).
    provider_ref: text('provider_ref'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Relayer sweep hot path: per (tenant, agent) claim pending rows whose
    // backoff gate elapsed, oldest-first. Equality columns anchor the probe;
    // next_attempt_at backs the range predicate + the LIMIT's ORDER BY.
    // Created CONCURRENTLY by migration 069 (no-tx).
    byTenantAgentStatusNext: index(
      'idx_idempotency_effect_outbox_tenant_agent_status_next',
    ).on(t.tenant_id, t.agent_id, t.status, t.next_attempt_at),
    // Retention-path PARTIAL index (PR #326 note (c)): backs the relayer's
    // terminal-row dispatcher enumeration AND the bounded cleanupTerminal DELETE
    // (status IN ('sent','failed') AND updated_at < cutoff, ORDER BY updated_at).
    // updated_at backs both the range predicate and the ORDER BY the LIMIT
    // walks. Partial (terminal-only) keeps it off the pending write hot path.
    // Created CONCURRENTLY by migration 070 (no-tx).
    byTenantAgentTerminalUpdated: index(
      'idx_idempotency_effect_outbox_tenant_agent_terminal_updated',
    )
      .on(t.tenant_id, t.agent_id, t.updated_at)
      .where(sql`status IN ('sent', 'failed')`),
    // One outbox row per winning reservation — the in-transaction INSERT is
    // ON CONFLICT DO NOTHING against this key (fenced completion → no 2nd row).
    byTenantAgentKey: unique('idempotency_effect_outbox_tenant_agent_key').on(
      t.tenant_id,
      t.agent_id,
      t.idempotency_key,
    ),
    statusChk: check(
      'idempotency_effect_outbox_status_chk',
      sql`${t.status} IN ('pending', 'sent', 'failed')`,
    ),
    failedHasErrorChk: check(
      'idempotency_effect_outbox_failed_has_error_chk',
      sql`${t.status} <> 'failed' OR ${t.last_error} IS NOT NULL`,
    ),
  }),
);

export const system_health_events = pgTable('system_health_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  component: text('component').notNull(),
  status: text('status').notNull(),
  duration_ms: integer('duration_ms'),
  error: text('error'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dead_letter_jobs = pgTable('dead_letter_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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

// Note: `dashboard_sessions` was removed in migration 062 alongside the
// legacy Fastify-served `/dashboard` (src/dashboard/index.ts). The admin-ui
// (`src/admin-ui/`, NextAuth-based) is the canonical web UI; sign-in lives in
// `app_users` + `app_sessions` (migration 045).

export const import_runs = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
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
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
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
    // P8c + P10a — Knowledge State Machine lifecycle columns
    // (P8c added lifecycle_status/evidence_count/confidence/lifecycle_transitions
    // in migration 041; P10a added last_recall_at in migration 050. P8c
    // shapes win because IF NOT EXISTS in 050 makes column ADDs no-ops.)
    lifecycle_status: text('lifecycle_status').notNull().default('active'),
    evidence_count: integer('evidence_count').notNull().default(1),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('1.00'),
    lifecycle_transitions: jsonb('lifecycle_transitions').notNull().default(sql`'[]'::jsonb`),
    last_recall_at: timestamp('last_recall_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('memory_entry_tenant_agent_idx').on(t.tenant_id, t.agent_id, t.created_at),
    interlocutorIdx: index('memory_entry_interlocutor_idx').on(t.interlocutor_id),
    scopeIdx: index('memory_entry_scope_idx').on(t.scope_type, t.subject_id),
    needsReviewIdx: index('memory_entry_needs_review_idx').on(t.needs_review),
    expiresIdx: index('memory_entry_expires_idx').on(t.expires_at),
    // Issue #281 (redesigned in PR #310) — KSM auto-promoter hot path.
    // Two partial lifecycle indexes back `listEligible`; distinct from
    // `memory_entry_tenant_agent_idx` (which orders by created_at for
    // time-window scans). The old (tenant_id, agent_id, id) index was
    // dropped as redundant with the PK. See agent_facts for the full
    // rationale. Created via migration 066 CONCURRENTLY.
    lifecycleInflightIdx: index('idx_memory_entry_lifecycle_inflight')
      .on(t.lifecycle_status, t.updated_at)
      .where(
        sql`lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified')`,
      ),
    // Expression index on the coalesced value the promoter's active sweep
    // ranges over (`COALESCE(last_recall_at, updated_at) < cutoff`). A
    // btree over the two SEPARATE columns cannot back a range over the
    // COALESCE(...) expression, so it must key on the expression itself
    // (mirrors migration 066: `((COALESCE(last_recall_at, updated_at)))`).
    lifecycleActiveIdx: index('idx_memory_entry_lifecycle_active')
      .on(sql`COALESCE(last_recall_at, updated_at)`)
      .where(sql`lifecycle_status = 'active'`),
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
    // P8c + P10a — Knowledge State Machine lifecycle columns
    // (P8c added lifecycle_status/evidence_count/confidence/lifecycle_transitions
    // in migration 041; P10a added last_recall_at + updated_at in migration 050.)
    lifecycle_status: text('lifecycle_status').notNull().default('active'),
    evidence_count: integer('evidence_count').notNull().default(1),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('1.00'),
    lifecycle_transitions: jsonb('lifecycle_transitions').notNull().default(sql`'[]'::jsonb`),
    last_recall_at: timestamp('last_recall_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantScopeIdx: index('behavioral_hint_tenant_scope_idx').on(
      t.tenant_id,
      t.agent_id,
      t.scope_type,
      t.subject_id,
    ),
    activeIdx: index('behavioral_hint_active_idx').on(t.revoked_at, t.expires_at),
    // Issue #281 (redesigned in PR #310) — KSM auto-promoter hot path.
    // The shared behavioral_hint table backs both `behavioral_hint` and
    // `procedure_hint` kinds; the promoter sweeps both by lifecycle_status.
    // Two partial lifecycle indexes back `listEligible`. The old
    // (tenant_id, agent_id, id) index was dropped as redundant with the
    // PK. See agent_facts for the full rationale. Created via migration
    // 066 CONCURRENTLY.
    lifecycleInflightIdx: index('idx_behavioral_hint_lifecycle_inflight')
      .on(t.lifecycle_status, t.updated_at)
      .where(
        sql`lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified')`,
      ),
    // Expression index on the coalesced value the promoter's active sweep
    // ranges over (`COALESCE(last_recall_at, updated_at) < cutoff`). A
    // btree over the two SEPARATE columns cannot back a range over the
    // COALESCE(...) expression, so it must key on the expression itself
    // (mirrors migration 066: `((COALESCE(last_recall_at, updated_at)))`).
    lifecycleActiveIdx: index('idx_behavioral_hint_lifecycle_active')
      .on(sql`COALESCE(last_recall_at, updated_at)`)
      .where(sql`lifecycle_status = 'active'`),
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
    /**
     * Domain key consumed by WorkflowSelector (DOMAIN_INTENT_MAP keys:
     * 'onboarding' | 'support' | 'transfer' | 'cancel').
     * NULL = backfill pending; code falls back to 'unknown' + logs a warn.
     * Migration: 060_p3a_procedure_definitions_domain.sql
     */
    domain: text('domain'),
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

// P8b — soul_biases: append-only behavioral biases versionadas por chave
// (tenant, agent, scope, scope_value, principle). DEFAULT 'proposed' garante que
// nenhuma bias nasça active por acidente (invariante 5). Partial unique
// "one active" garante 1 row active por chave (migration 038).
export const soul_biases = pgTable(
  'soul_biases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    scope: text('scope').notNull(),
    scope_value: text('scope_value').notNull(),
    principle: text('principle').notNull(),
    guidance: text('guidance').notNull(),
    origin: text('origin').notNull(),
    strength: numeric('strength', { precision: 4, scale: 3 }).notNull(),
    activation_context: jsonb('activation_context').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('proposed'),
    version: integer('version').notNull(),
    previous_version_id: uuid('previous_version_id'),
    proposed_by: text('proposed_by').notNull(),
    proposed_reason: text('proposed_reason'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    frozen_at: timestamp('frozen_at', { withTimezone: true }),
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    rollback_reason: text('rollback_reason'),
    deprecated_at: timestamp('deprecated_at', { withTimezone: true }),
    deprecated_reason: text('deprecated_reason'),
    proposal_id: uuid('proposal_id'),
    source_drift_alert_id: uuid('source_drift_alert_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUniq: unique('soul_biases_version_uniq').on(
      t.tenant_id,
      t.agent_id,
      t.scope,
      t.scope_value,
      t.principle,
      t.version,
    ),
    oneActiveIdx: uniqueIndex('soul_biases_one_active_idx')
      .on(t.tenant_id, t.agent_id, t.scope, t.scope_value, t.principle)
      .where(sql`status = 'active'`),
    activeLookupIdx: index('soul_biases_active_lookup_idx')
      .on(t.tenant_id, t.agent_id, t.status, t.scope, t.scope_value)
      .where(sql`status = 'active'`),
    proposedInboxIdx: index('soul_biases_proposed_inbox_idx')
      .on(t.tenant_id, t.agent_id, t.status, t.created_at)
      .where(sql`status = 'proposed'`),
    proposalIdx: index('soul_biases_proposal_idx')
      .on(t.proposal_id)
      .where(sql`proposal_id IS NOT NULL`),
    driftSourceIdx: index('soul_biases_drift_source_idx')
      .on(t.source_drift_alert_id)
      .where(sql`source_drift_alert_id IS NOT NULL`),
    scopeCheck: check(
      'soul_biases_scope_check',
      sql`scope IN ('tenant', 'agent', 'role', 'domain')`,
    ),
    statusCheck: check(
      'soul_biases_status_check',
      sql`status IN ('proposed', 'active', 'deprecated', 'rolled_back')`,
    ),
    originCheck: check(
      'soul_biases_origin_check',
      sql`origin IN ('founder_explicit', 'human_approved', 'tenant_culture_explicit', 'learned_strong_evidence')`,
    ),
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
    // 094 — marcador sintético IMUTÁVEL (spec sonda §1.3): setado só no seed da
    // migração, nunca por config de runtime. Base do sink de outbound e da
    // validação fail-fast de boot; garante que a sonda não silencie um recurso
    // não-sintético (o sink exige is_synthetic=true + triplete completo).
    is_synthetic: boolean('is_synthetic').notNull().default(false),
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

// 103 (issue #518) — estado OPERACIONAL da linha whatsapp + fila durável de
// comandos Admin→runtime. `channels.active` continua sendo ROTEAMENTO; este
// `state` é o ciclo de vida da posse/conexão (declared → pairing →
// verified_offline → connected → recovering/logged_out/failed/disabled).
//
// `pairing_material` é o envelope AES-256-GCM de staging-crypto.ts — QR/código
// NUNCA em claro, com TTL curto e apagado ao concluir/abortar/expirar. O
// console decifra na resposta tRPC autenticada; nada disso entra em URL,
// audit ou log. As CHECKs de estado/comando vivem na migration 103 (fonte de
// verdade das constraints); aqui declaramos tipos.
export const channel_line_state = pgTable(
  'channel_line_state',
  {
    channel_id: uuid('channel_id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    state: text('state').notNull().default('declared'),
    command: text('command'),
    command_method: text('command_method'),
    command_id: uuid('command_id'),
    command_requested_at: timestamp('command_requested_at', { withTimezone: true }),
    command_claimed_at: timestamp('command_claimed_at', { withTimezone: true }),
    owner_lease_expires_at: timestamp('owner_lease_expires_at', { withTimezone: true }),
    target_instance: text('target_instance'),
    session_owner_instance: text('session_owner_instance'),
    session_owner_lease_expires_at: timestamp('session_owner_lease_expires_at', {
      withTimezone: true,
    }),
    actor_id: text('actor_id'),
    actor_role: text('actor_role'),
    correlation_id: text('correlation_id'),
    pairing_material: customType<{ data: Buffer }>({
      dataType() {
        return 'bytea';
      },
    })('pairing_material'),
    pairing_material_key_id: text('pairing_material_key_id'),
    pairing_material_kind: text('pairing_material_kind'),
    pairing_material_expires_at: timestamp('pairing_material_expires_at', {
      withTimezone: true,
    }),
    pairing_method: text('pairing_method'),
    pairing_started_at: timestamp('pairing_started_at', { withTimezone: true }),
    pairing_expires_at: timestamp('pairing_expires_at', { withTimezone: true }),
    pairing_attempts: integer('pairing_attempts').notNull().default(0),
    owner_instance: text('owner_instance'),
    reason_code: text('reason_code'),
    verified_at: timestamp('verified_at', { withTimezone: true }),
    connected_at: timestamp('connected_at', { withTimezone: true }),
    disconnected_at: timestamp('disconnected_at', { withTimezone: true }),
    last_transition_at: timestamp('last_transition_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index('channel_line_state_scope_idx').on(t.tenant_id, t.agent_id),
    pendingCommandIdx: index('channel_line_state_pending_command_idx')
      .on(t.command_requested_at)
      .where(sql`command IS NOT NULL`),
    pairingExpiryIdx: index('channel_line_state_pairing_expiry_idx')
      .on(t.pairing_expires_at)
      .where(sql`state = 'pairing'`),
    ownerIdx: index('channel_line_state_owner_idx')
      .on(t.owner_instance)
      .where(sql`owner_instance IS NOT NULL`),
  }),
);
export type ChannelLineStateRow = typeof channel_line_state.$inferSelect;

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
    // Issue #415 — role → tool-pack axis (capability-taxonomy.md §5). A role
    // GRANTS domain tool packs on top of the universal baseline; it still owns
    // nothing executable. These are pack ids (strings) from `src/tools/packs.ts`
    // (#408), referenced BY STRING exactly like `agent_tool_grants.granted_packs`
    // — the same union model. `baseline.core` is ALWAYS unioned in at runtime, so
    // a role lists only what it ADDS (a role does NOT re-declare baseline). The
    // effective visible tools are `agent grant ∩ active-role packs ∩ skill scope
    // ∩ …` (taxonomy §2 step 7); this column supplies the "active-role packs"
    // factor. The pack ids referenced here are DEFINED by #416 — they may not
    // resolve to a real pack until that lands; the reference is a string contract.
    granted_packs: text('granted_packs').array().notNull().default(sql`'{}'::text[]`),
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

// 092 — staging de inbound não-roteado (spec roteamento v4 §1.4, modo
// strict). Envelope AES-256-GCM (staging-crypto.ts); TTL 72h; UNIQUE
// (line, whatsapp_id) = idempotência pré-resolução. O job BullMQ carrega só
// o id (jobId estável — digest de (line, whatsapp_id), ver unroutedReplayJobId).
export const inbound_unrouted = pgTable(
  'inbound_unrouted',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    line_external_id: text('line_external_id').notNull(),
    whatsapp_message_id: text('whatsapp_message_id').notNull(),
    envelope: customType<{ data: Buffer }>({
      dataType() {
        return 'bytea';
      },
    })('envelope').notNull(),
    enc_key_id: text('enc_key_id').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    handed_off_at: timestamp('handed_off_at', { withTimezone: true }),
  },
  (t) => ({
    lineMsgUq: uniqueIndex('inbound_unrouted_line_msg_uq').on(
      t.line_external_id,
      t.whatsapp_message_id,
    ),
    pendingIdx: index('idx_inbound_unrouted_pending')
      .on(t.received_at)
      .where(sql`status = 'pending'`),
    expiryIdx: index('idx_inbound_unrouted_expiry')
      .on(t.expires_at)
      .where(sql`status = 'pending'`),
  }),
);
export type InboundUnroutedRow = typeof inbound_unrouted.$inferSelect;

export type SoulBias = typeof soul_biases.$inferSelect;
export type NewSoulBias = typeof soul_biases.$inferInsert;

/**
 * P8b — Estrutura JSONB de `soul_biases.activation_context`.
 * Avaliada por soul-slice-builder. Vazio = sempre ativo dentro do scope.
 */
export interface ActivationContext {
  intent_in?: string[];
  risk_level_min?: 'low' | 'medium' | 'high';
  channel_in?: string[];
  role_in?: string[];
  domain_in?: string[];
  time_window?: string;
}

// P8e — policy_rules: Source of Truth versionada para regras de governança.
// Master spec v3.1.1 §2.1. DEFAULT 'proposed' garante invariante #5; partial
// unique 'one active' garante invariante #6 (no DB). rule_body é JSONB opaco
// em P8e — P9d entrega o avaliador de DSL/AST.
//
// Migration: migrations/036_p8e_policy_rules.sql. Indexes idx_policy_rules_*
// declared via raw SQL there (Drizzle 0.45 doesn't expose `COALESCE` in
// uniqueIndex expressions cleanly). We declare the table here so types and
// `.$inferSelect/$inferInsert` work; the migration is source of truth for
// constraints.
export const policy_rules = pgTable('policy_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id'),
  rule_kind: text('rule_kind').notNull(),
  rule_descriptor: text('rule_descriptor').notNull(),
  rule_body: jsonb('rule_body').notNull(),
  scope: jsonb('scope').notNull().default(sql`'{}'::jsonb`),
  source_of_truth: text('source_of_truth').notNull(),
  status: text('status').notNull().default('proposed'),
  version: integer('version').notNull(),
  proposed_by: text('proposed_by').notNull(),
  proposed_reason: text('proposed_reason'),
  approved_by: text('approved_by'),
  approved_at: timestamp('approved_at', { withTimezone: true }),
  activated_at: timestamp('activated_at', { withTimezone: true }),
  deprecated_at: timestamp('deprecated_at', { withTimezone: true }),
  rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
  rollback_reason: text('rollback_reason'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PolicyRuleRow = typeof policy_rules.$inferSelect;
export type NewPolicyRuleRow = typeof policy_rules.$inferInsert;

// =====================================================================
// P8.5 Admin UI v1 — auth, approvals, audit, debug snapshot grants
// =====================================================================

// 045: app_users — admin-ui authentication (NextAuth)
export const app_users = pgTable(
  'app_users',
  {
    id: text('id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    role: text('role').notNull(), // founder | compliance_officer | owner | analyst | viewer
    email_verified: timestamp('email_verified', { withTimezone: true }),
    image: text('image'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantEmailUq: unique('app_users_tenant_email_uq').on(t.tenant_id, t.email),
    tenantIdx: index('app_users_tenant_idx').on(t.tenant_id),
  }),
);

// 045: app_sessions — JWT/session tracking
export const app_sessions = pgTable(
  'app_sessions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    session_token: text('session_token').notNull().unique(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('app_sessions_user_id_idx').on(t.user_id),
    expiresIdx: index('app_sessions_expires_idx').on(t.expires),
  }),
);

// 046 + 093: proposal_approvals — tracks dual-approval state.
// 093 (spec perfil-inbox v4 §1.6): escopo tenant/agent/source. A unicidade
// GLOBAL (proposal, approver, decision) foi substituída por partial uniques:
//   - rows novas: (tenant, agent, source, proposal, approver, decision)
//     WHERE agent_id IS NOT NULL AND proposal_source IS NOT NULL;
//   - rows legadas: a semântica antiga, WHERE proposal_source IS NULL.
// CHECK (agent_id IS NULL) = (proposal_source IS NULL) — NULLs são distintos
// em Postgres; sem o pareamento, source preenchido + agent ausente duplicaria.
// Vocabulário de proposal_source fechado por CHECK (espelha a registry TS).
export const proposal_approvals = pgTable(
  'proposal_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    // 093 — nulos APENAS em rows legadas (pré-escopo), aos pares.
    agent_id: text('agent_id'),
    proposal_source: text('proposal_source'),
    proposal_id: uuid('proposal_id').notNull(),
    approval_class: text('approval_class').notNull(),
    approver_user_id: text('approver_user_id').notNull(),
    approver_role: text('approver_role').notNull(),
    decision: text('decision').notNull(), // 'approved' | 'rejected'
    comment: text('comment'),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopedUq: uniqueIndex('proposal_approvals_scoped_uq')
      .on(t.tenant_id, t.agent_id, t.proposal_source, t.proposal_id, t.approver_user_id, t.decision)
      .where(sql`agent_id IS NOT NULL AND proposal_source IS NOT NULL`),
    legacyUq: uniqueIndex('proposal_approvals_legacy_uq')
      .on(t.proposal_id, t.approver_user_id, t.decision)
      .where(sql`proposal_source IS NULL`),
    scopeReadIdx: index('proposal_approvals_scope_read_idx').on(
      t.tenant_id,
      t.proposal_source,
      t.proposal_id,
    ),
    proposalIdx: index('proposal_approvals_proposal_id_idx').on(t.proposal_id),
    classIdx: index('proposal_approvals_approval_class_idx').on(t.approval_class),
    tenantIdx: index('proposal_approvals_tenant_idx').on(t.tenant_id),
  }),
);

// 047: admin_audit_log — APPEND-ONLY audit trail for admin-ui mutations
// NEVER UPDATE/DELETE these rows. Constraint enforced at app + lint layer.
export const admin_audit_log = pgTable(
  'admin_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    actor_id: text('actor_id').notNull(),
    actor_role: text('actor_role').notNull(),
    action: text('action').notNull(),
    resource_type: text('resource_type').notNull(),
    resource_id: text('resource_id'),
    change_summary: jsonb('change_summary'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('admin_audit_log_tenant_id_created_idx').on(t.tenant_id, t.created_at),
    actorIdx: index('admin_audit_log_actor_id_idx').on(t.actor_id),
    resourceIdx: index('admin_audit_log_resource_idx').on(t.resource_type, t.resource_id),
  }),
);

// 062 (issue #183, PR #188 Codex round 1, [high]): global_settings —
// process-wide singleton settings (NOT scoped to tenant/agent by design).
// Used by /setup/llm-settings to flip the runtime LLM model slug so the
// change is visible to every tenant's next ReAct turn. Previous storage
// in agent_facts (scoped by tenant_id+agent_id) silently meant the
// founder UI only affected the founder's `default` agent — every other
// agent/tenant kept calling the old/env model.
export const global_settings = pgTable('global_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updated_by: text('updated_by'),
});

// 048: debug_snapshot_grants — TTL-bounded access to runtime_trace_bodies
export const debug_snapshot_grants = pgTable(
  'debug_snapshot_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    granted_to_user_id: text('granted_to_user_id').notNull(),
    granted_by_user_id: text('granted_by_user_id').notNull(),
    trace_id: uuid('trace_id').notNull(),
    reason: text('reason').notNull(),
    category: text('category'),
    read_count: integer('read_count').notNull().default(0),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    revoked_by_user_id: text('revoked_by_user_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('debug_snapshot_grants_expires_idx').on(t.expires_at),
    tenantIdx: index('debug_snapshot_grants_tenant_id_idx').on(t.tenant_id),
    grantedToIdx: index('debug_snapshot_grants_granted_to_idx').on(t.granted_to_user_id),
    traceIdx: index('debug_snapshot_grants_trace_idx').on(t.trace_id),
  }),
);

// =====================================================================
// P10b — Runtime Trace (envelope sync + body async, HMAC + redaction)
// =====================================================================

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
    // Issue #514 (migration 107): attempt grouping. `root_trace_id` equals
    // `trace_id` on attempt 1; retries get a derived id and point back here.
    // Issue #535 (migration 119): BOTH are now covered by `envelope_hmac` —
    // under signature v2. v1 rows keep them unsigned; see
    // `src/control-plane/runtime-trace/lib/signature.ts`.
    root_trace_id: uuid('root_trace_id'),
    attempt: integer('attempt').notNull().default(1),
    policy_id: uuid('policy_id'),
    decision: text('decision').notNull(),
    side_effect_level: text('side_effect_level').notNull(),
    redaction_class: text('redaction_class').notNull().default('standard'),
    envelope_hmac: text('envelope_hmac').notNull(),
    hmac_key_version: integer('hmac_key_version').notNull(),
    // Issue #535 (migration 119): which canonical material `envelope_hmac`
    // covers. DEFAULT 1 because every row that predates the column was signed
    // with the v1 field set. Production writes 2 and nothing else; the verifier
    // still reads 1 so fixtures and old environments keep a real verdict.
    signature_version: integer('signature_version').notNull().default(1),
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
    // Codex #102 issue 3: when encrypted=true and no S3 bucket configured
    // (dev/test/CI), the ciphertext is stored inline here. The DB CHECK
    // requires either s3_uri OR ciphertext_inline when encrypted=true.
    ciphertext_inline: text('ciphertext_inline'),
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

// P10b (Codex #102 issue 4): runtime_trace_body_outbox — durable queue
// for the async body writer. Written transactionally with the envelope
// so a process crash never strands the packet in volatile memory.
// Workers claim rows via FOR UPDATE SKIP LOCKED, write the body, and
// delete the outbox row in the same transaction.
export const runtime_trace_body_outbox = pgTable(
  'runtime_trace_body_outbox',
  {
    trace_id: uuid('trace_id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // The full TraceBodyInput shape, ready to feed writeBody() without
    // any rebuild. Includes packet + decision + redaction_class.
    payload: jsonb('payload').notNull(),
    redaction_class: text('redaction_class').notNull(),
    enqueued_at: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    last_attempt_at: timestamp('last_attempt_at', { withTimezone: true }),
    last_error: text('last_error'),
  },
  (t) => ({
    drainIdx: index('runtime_trace_body_outbox_drain_idx').on(t.enqueued_at),
  }),
);

export type Entidade = typeof entidades.$inferSelect;
export type Pessoa = typeof pessoas.$inferSelect;
// Issue #407: per-agent audience relation. `audience_type` / `trust_level` /
// `status` are stored as `text` (CHECK-constrained in migration 074); we
// narrow them here to the canonical unions from `src/shared/audience.ts` plus
// the audience-status vocabulary so call sites get exhaustive typing without a
// second source of truth for the enum values.
export type AgentAudienceProfileRow = typeof agent_audience_profiles.$inferSelect;
export type AudienceStatus = 'active' | 'inactive' | 'quarantined' | 'blocked';
export type AgentAudienceProfile = Omit<
  AgentAudienceProfileRow,
  'audience_type' | 'trust_level' | 'status'
> & {
  audience_type: AudienceType;
  trust_level: TrustLevel;
  status: AudienceStatus;
};
export type NewAgentAudienceProfile = typeof agent_audience_profiles.$inferInsert;
// Issue #408 — per-agent tool grant (granted_packs / granted_tools /
// denied_tools). Composed by AND with human permissions in the Runtime Tool
// Filter; `denied_tools` is HARD (invisible + dispatcher-refused).
export type AgentToolGrantRow = typeof agent_tool_grants.$inferSelect;
export type NewAgentToolGrant = typeof agent_tool_grants.$inferInsert;
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
export type ApprovalRequest = typeof approval_requests.$inferSelect;
export type ApprovalDecision = typeof approval_decisions.$inferSelect;
export type PendingQuestion = typeof pending_questions.$inferSelect;
export type IdempotencyKey = typeof idempotency_keys.$inferSelect;
export type IdempotencyEffectOutboxRow = typeof idempotency_effect_outbox.$inferSelect;
export type SystemHealthEvent = typeof system_health_events.$inferSelect;
export type DeadLetterJob = typeof dead_letter_jobs.$inferSelect;
export type AuditEntry = typeof audit_log.$inferSelect;
export type PermissionProfile = typeof permission_profiles.$inferSelect;
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
// Bump this constant when introducing a new ProfileBody shape (e.g., v3.1.3).
// v3.1.2: formaliza `identity.principles` no tipo canônico (spec perfil-inbox
// v4 §1.2 — antes persistido por cast em agents.ts, um campo high-risk fora
// do tipo). Mudança aditiva: nenhuma migração de dados.
export const PROFILE_BODY_SCHEMA_VERSION = 'v3.1.2-2026-07-13' as const;
export type ProfileBodySchemaVersion = typeof PROFILE_BODY_SCHEMA_VERSION;

// Versões conhecidas do ProfileBody (spec perfil-inbox v4 §1.2). A validação
// de corpo aceita QUALQUER versão conhecida — não apenas o literal corrente,
// que faria o predecessor legado falhar na validação ANTES de chegar ao mapa
// de compatibilidade. Versão desconhecida ⇒ `null` (o chamador trata como
// risco alto, fail-up — nunca erro de parse).
export type KnownProfileSchemaVersion = 'v3.1.1-2026-05-15' | 'v3.1.2-2026-07-13';

export const KNOWN_PROFILE_SCHEMA_VERSIONS: readonly KnownProfileSchemaVersion[] = [
  'v3.1.1-2026-05-15',
  'v3.1.2-2026-07-13',
];

export function parseKnownProfileSchemaVersion(v: unknown): KnownProfileSchemaVersion | null {
  if (typeof v !== 'string') return null;
  return (KNOWN_PROFILE_SCHEMA_VERSIONS as readonly string[]).includes(v)
    ? (v as KnownProfileSchemaVersion)
    : null;
}

// Mapa de compatibilidade ADITIVA entre versões persistidas (spec §1.2):
// `{ versão_proposta: [predecessores aceitos] }`, usando os literais REAIS
// gravados nas rows. Par presente ⇒ a diferença de versão em si não pesa no
// risco (só os campos alterados); par ausente e não-idêntico ⇒ risco alto.
// Atualizar a cada bump de PROFILE_BODY_SCHEMA_VERSION.
export const PROFILE_SCHEMA_COMPAT: Record<string, string[]> = {
  'v3.1.2-2026-07-13': ['v3.1.1-2026-05-15'],
};

// Tipo estrutural do JSONB `profile_body` (v3.1.2). `schema_version` admite
// qualquer versão conhecida — rows legadas (v3.1.1) continuam satisfazendo o
// tipo sem migração.
export interface ProfileBody {
  schema_version: KnownProfileSchemaVersion;
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
    // Contratos de valor invioláveis (valoresDetector — high-risk). Opcional:
    // ausência ⇒ guardrail desativado por decisão do operador (#189/#193).
    principles?: string[];
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
// 094 — Sonda sintética (spec §1.5): estado DURÁVEL em Postgres. Os contadores/
// gauges de metrics.ts são in-memory e as rows do run são limpas; sem estas
// tabelas um restart esqueceria o outage (last_ok) ou duplicaria runs
// (single-flight). Namespaced pelo tenant '__probe__', filtrado de dashboards.
export const synthetic_probe_runs = pgTable(
  'synthetic_probe_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    channel_id: uuid('channel_id'),
    scenario: text('scenario').notNull(),
    // id estável do inbound sintético injetado (metadata.whatsapp_id) — o HANDLE
    // do run; dele a sonda resolve a `mensagens` de entrada e daí os efeitos.
    whatsapp_id: text('whatsapp_id').notNull(),
    // `mensagens.id` da entrada resolvida — chave de correlação dos efeitos
    // (transacoes.mensagem_id / out.metadata->>'in_reply_to'). NULL até resolver.
    mensagem_id: uuid('mensagem_id'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    // ok | slow | wrong | silent | error — NULL enquanto em voo.
    outcome: text('outcome'),
    latency_ms: integer('latency_ms'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    // set no estado TERMINAL do run — só então o cleanup pode recolher (§1.5).
    terminal_at: timestamp('terminal_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index('synthetic_probe_runs_scope_idx').on(t.tenant_id, t.agent_id, t.started_at),
    widIdx: index('synthetic_probe_runs_wid_idx').on(t.whatsapp_id),
  }),
);

export const synthetic_probe_state = pgTable(
  'synthetic_probe_state',
  {
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // sinal PRIMÁRIO de outage (§1.6): o gauge seconds_since_last_ok lê daqui.
    last_ok_at: timestamp('last_ok_at', { withTimezone: true }),
    // primeira tentativa — o gauge cresce a partir daqui mesmo se NUNCA ficou
    // verde (last_ok_at nulo), senão gauge=0 e '>15m' nunca dispara (review).
    first_attempt_at: timestamp('first_attempt_at', { withTimezone: true }),
    consecutive_failures: integer('consecutive_failures').notNull().default(0),
    health: text('health').notNull().default('healthy'),
    // alerta durável com retry (§1.6): a transição saudável→degradado grava
    // alert_pending=true; o retry reentrega até confirmar e só então zera.
    alert_pending: boolean('alert_pending').notNull().default(false),
    alert_pending_since: timestamp('alert_pending_since', { withTimezone: true }),
    last_alert_attempt_at: timestamp('last_alert_attempt_at', { withTimezone: true }),
    // single-flight (§1.5): impede runs concorrentes; lease vencido é reciclado.
    lease_until: timestamp('lease_until', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.agent_id] }),
  }),
);

export type SyntheticProbeRun = typeof synthetic_probe_runs.$inferSelect;
export type NewSyntheticProbeRun = typeof synthetic_probe_runs.$inferInsert;
export type SyntheticProbeState = typeof synthetic_probe_state.$inferSelect;
export type NewSyntheticProbeState = typeof synthetic_probe_state.$inferInsert;

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
export type RuntimeTraceBodyOutbox = typeof runtime_trace_body_outbox.$inferSelect;
export type NewRuntimeTraceBodyOutbox = typeof runtime_trace_body_outbox.$inferInsert;

// P9a: skills — Skill Contracts versionados (Source of Truth)
// Master spec v3.1.1 §2.4 + §2.5 (runtime_hints).
// Convenções:
//  - DEFAULT status='proposed' (uma skill nunca nasce active).
//  - Partial unique "one active" garante invariante no DB; o repo respeita.
//  - tenant_id é TEXT (slug), seguindo padrão de migrations 007/018+ —
//    spec menciona UUID mas o resto da Maia ainda usa slug; alinhamento
//    pode ocorrer em P11. agent_id NULL = skill tenant-wide.
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id'),

    skill_descriptor: text('skill_descriptor').notNull(),
    category: text('category').notNull(),
    execution_mode: text('execution_mode').notNull(),

    goal: text('goal').notNull(),
    when_to_use: text('when_to_use').notNull(),
    procedure: jsonb('procedure').notNull().default(sql`'{}'::jsonb`),
    constraints: jsonb('constraints').notNull().default(sql`'[]'::jsonb`),

    input_schema: jsonb('input_schema').notNull(),
    output_schema: jsonb('output_schema').notNull(),

    allowed_tools: text('allowed_tools').array().notNull().default(sql`'{}'::text[]`),
    policy_descriptors: text('policy_descriptors').array().notNull().default(sql`'{}'::text[]`),

    // Issue #415 — role → skill axis (`applicable_to_role`, capability-taxonomy.md
    // §5). The role keys (from `roles.role_key`) for which this skill is in scope.
    // EMPTY = applies regardless of active role (the existing/baseline behaviour —
    // a baseline skill is universal). When non-empty, the SkillSelector keeps this
    // candidate ONLY when the turn's active role is one of these keys
    // (`selector(intent) ∩ applicable_to_role`, taxonomy §2 step 5). This is a
    // SCOPING declaration, NOT an authorization: it can only ever REMOVE a
    // candidate, never grant one — execution is still gated by policy + the
    // dispatcher. A skill never owns confirmation/write rules (taxonomy §3, §7).
    applicable_to_role: text('applicable_to_role').array().notNull().default(sql`'{}'::text[]`),

    success_criteria: jsonb('success_criteria').notNull().default(sql`'[]'::jsonb`),
    failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),

    runtime_hints: jsonb('runtime_hints').notNull().default(sql`'{}'::jsonb`),

    // Issue #409 — native, typed SkillUsagePolicy (Zod-validated in
    // src/skills/usage-policy.ts). NULLABLE: NULL/`{}` = the conservative
    // internal-only default (resolved in code), so an operator must OPT IN to
    // expose a skill to external audiences. COMPLEMENTS (never replaces)
    // `constraints` / `policy_descriptors` above.
    usage_policy: jsonb('usage_policy'),

    status: text('status').notNull().default('proposed'),
    version: integer('version').notNull(),
    proposed_by: text('proposed_by').notNull(),
    proposed_reason: text('proposed_reason'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    deprecated_at: timestamp('deprecated_at', { withTimezone: true }),
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    rollback_reason: text('rollback_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantActiveIdx: index('idx_skills_tenant_active')
      .on(t.tenant_id, t.status, t.skill_descriptor)
      .where(sql`status = 'active'`),
    tenantCategoryActiveIdx: index('idx_skills_tenant_category_active')
      .on(t.tenant_id, t.category, t.status)
      .where(sql`status = 'active'`),
    versionUq: uniqueIndex('idx_skills_version_uq').on(
      t.tenant_id,
      sql`COALESCE(agent_id, 'tenant_wide')`,
      t.skill_descriptor,
      t.version,
    ),
    oneActiveUq: uniqueIndex('idx_skills_one_active_uq')
      .on(t.tenant_id, sql`COALESCE(agent_id, 'tenant_wide')`, t.skill_descriptor)
      .where(sql`status = 'active'`),
    proposedIdx: index('idx_skills_proposed')
      .on(t.tenant_id, t.status, t.created_at)
      .where(sql`status = 'proposed'`),
    categoryCheck: check(
      'skills_category_check',
      sql`category IN ('classify', 'extract', 'compose', 'decide', 'tool_mediated', 'diagnose', 'plan', 'evaluator')`,
    ),
    executionModeCheck: check(
      'skills_execution_mode_check',
      sql`execution_mode IN ('prompt_only', 'procedure_adapter', 'tool_mediated', 'evaluator')`,
    ),
    statusCheck: check(
      'skills_status_check',
      sql`status IN ('proposed', 'active', 'deprecated', 'rolled_back')`,
    ),
  }),
);

export type SkillRow = typeof skills.$inferSelect;
export type NewSkillRow = typeof skills.$inferInsert;

/**
 * Runtime hints declarados no Skill Contract (master §2.5 CORREÇÃO #14).
 * O harness aplica caps por execução; ausência de campo cai em defaults
 * do SkillRunner.
 */
export interface SkillRuntimeHints {
  max_prompt_tokens?: number;
  max_output_tokens?: number;
  max_tool_calls?: number;
  preferred_model?: string;
  timeout_ms?: number;
}

/**
 * Forma estrutural do contrato declarativo (linha em `skills`). Usado
 * como input para `skillsRepo.propose` e como o `proposed_spec` em
 * `capability_proposals` quando capability_type='skill'.
 */
export interface SkillContract {
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  goal: string;
  when_to_use: string;
  procedure: Record<string, unknown>;
  constraints?: Array<Record<string, unknown>>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  allowed_tools?: string[];
  policy_descriptors?: string[];
  /**
   * Issue #415 — role → skill axis (`applicable_to_role`). Role keys for which
   * this skill is in scope; EMPTY = applies regardless of active role. A
   * SCOPING declaration only (taxonomy §5) — never an authorization.
   */
  applicable_to_role?: string[];
  success_criteria?: Array<Record<string, unknown>>;
  failure_modes?: Array<Record<string, unknown>>;
  runtime_hints?: SkillRuntimeHints;
  /**
   * Issue #409 — native SkillUsagePolicy (audience/channel/data_scope/exposure/
   * auth/confirmation/risk). Typed structurally here (a `Record`) to keep this
   * foundational module import-cycle-free; the canonical Zod contract +
   * `SkillUsagePolicy` type live in `src/skills/usage-policy.ts`. Absent ⇒
   * conservative internal-only default at runtime.
   */
  usage_policy?: Record<string, unknown> | null;
}

// =====================================================================
// P8.5 Admin UI v1 — type exports + Zod schemas + governance enums
// =====================================================================

export type AppUser = typeof app_users.$inferSelect;
export type NewAppUser = typeof app_users.$inferInsert;
export type AppSession = typeof app_sessions.$inferSelect;
export type NewAppSession = typeof app_sessions.$inferInsert;
export type ProposalApproval = typeof proposal_approvals.$inferSelect;
export type NewProposalApproval = typeof proposal_approvals.$inferInsert;
export type AdminAuditLogEntry = typeof admin_audit_log.$inferSelect;
export type NewAdminAuditLogEntry = typeof admin_audit_log.$inferInsert;
export type DebugSnapshotGrant = typeof debug_snapshot_grants.$inferSelect;
export type NewDebugSnapshotGrant = typeof debug_snapshot_grants.$inferInsert;

// String literal unions for governance enums consumed by tRPC + admin-ui.
// (Zod schemas live in src/admin-ui/lib/governance-schemas.ts to avoid
// adding a Zod dependency at the db layer; values mirror those constants.)
export type AdminUserRole = 'founder' | 'compliance_officer' | 'owner' | 'analyst' | 'viewer';

export type ProposalTypeId =
  | 'policy_rule'
  | 'soul_bias'
  | 'skill'
  | 'capability_proposal'
  | 'knowledge_proposal'
  | 'operational_profile';

export type RiskLevelId = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalClassId =
  | 'policy_rule_soft_guidance'
  | 'policy_rule_hard_limit'
  | 'soul_bias_core_value'
  | 'soul_bias_peripheral'
  | 'skill_new_domain'
  | 'skill_refinement'
  | 'capability_safe_tool'
  | 'capability_dangerous_tool'
  | 'capability_side_effect'
  | 'knowledge_rule'
  | 'knowledge_guidance'
  | 'knowledge_deprecated'
  | 'identity_drift_correction'
  | 'procedure_update'
  | 'operational_profile_change'
  | 'operational_profile_change_high';

export type ProposalUnifiedStatus = 'proposed' | 'pending_review' | 'rejected' | 'activated';

// ---------------------------------------------------------------------------
// Playground sandbox (issue #464 — migration 087)
//
// Sessions/turns for the admin-console "Testar agente" chat. The `status`
// column on turns doubles as the work queue (Postgres-as-queue): the runtime
// worker polls status='queued' rows, runs the sandboxed turn, and writes the
// agent reply back. Sandbox contract: no outbox, no memory writes, no
// learning, side-effect tools never executed (proposals recorded in
// decision_meta). See docs/superpowers/specs/2026-06-10-agent-playground-design.md.
// ---------------------------------------------------------------------------

export const playground_sessions = pgTable(
  'playground_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // NULL = active profile; otherwise the proposed version under test.
    profile_version_id: uuid('profile_version_id').references(
      () => agent_operational_profile_versions.id,
      { onDelete: 'set null' },
    ),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => ({
    tenantAgentIdx: index('playground_sessions_tenant_agent_idx').on(
      t.tenant_id,
      t.agent_id,
      t.created_at,
    ),
    expiryIdx: index('playground_sessions_expiry_idx').on(t.expires_at),
  }),
);

export type PlaygroundTurnStatus = 'queued' | 'running' | 'done' | 'error';

export const playground_turns = pgTable(
  'playground_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    session_id: uuid('session_id')
      .notNull()
      .references(() => playground_sessions.id, { onDelete: 'cascade' }),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    role: text('role').notNull(), // 'user' | 'agent' (CHECK in migration 087)
    content: text('content').notNull(),
    decision_meta: jsonb('decision_meta'),
    status: text('status').notNull().default('queued'), // PlaygroundTurnStatus
    error_detail: text('error_detail'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    sessionIdx: index('playground_turns_session_idx').on(t.session_id, t.created_at),
  }),
);

export type PlaygroundSession = typeof playground_sessions.$inferSelect;
export type NewPlaygroundSession = typeof playground_sessions.$inferInsert;
export type PlaygroundTurn = typeof playground_turns.$inferSelect;
export type NewPlaygroundTurn = typeof playground_turns.$inferInsert;

// ---------------------------------------------------------------------------
// Work loop v1 (issue #469 — migration 088)
//
// agent_objectives: responsabilidades declarativas, owner-aprovadas.
// objective_tasks: unidades de trabalho idempotentes (natural_key única
// enquanto viva), executadas pelo worker objective_execute; 'waiting_human'
// é a fila de exceções. Spec: docs/superpowers/specs/2026-06-10-agent-work-loop-design.md.
// ---------------------------------------------------------------------------

export type ObjectiveStatus = 'active' | 'paused' | 'archived';
export type ObjectiveTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_human'
  | 'done'
  | 'failed'
  | 'cancelled';

export const agent_objectives = pgTable(
  'agent_objectives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    params: jsonb('params').notNull().default({}),
    status: text('status').notNull().default('active'), // ObjectiveStatus
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('agent_objectives_tenant_agent_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
    ),
  }),
);

export const objective_tasks = pgTable(
  'objective_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objective_id: uuid('objective_id')
      .notNull()
      .references(() => agent_objectives.id, { onDelete: 'cascade' }),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    natural_key: text('natural_key').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'), // ObjectiveTaskStatus
    procedure_execution_id: uuid('procedure_execution_id'),
    pending_question_id: uuid('pending_question_id'),
    outcome: jsonb('outcome'),
    error_detail: text('error_detail'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    objectiveIdx: index('objective_tasks_objective_idx').on(t.objective_id, t.created_at),
    tenantAgentStatusIdx: index('objective_tasks_tenant_agent_status_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
    ),
  }),
);

export type AgentObjective = typeof agent_objectives.$inferSelect;
export type NewAgentObjective = typeof agent_objectives.$inferInsert;
export type ObjectiveTask = typeof objective_tasks.$inferSelect;
export type NewObjectiveTask = typeof objective_tasks.$inferInsert;

// ---------------------------------------------------------------------------
// MCP externo v1 (issue #478 — migração 089)
//
// mcp_servers: conexões first-party (credencial via secret REF; flags de
// teste/sync = ponte admin-ui→runtime). mcp_server_tools: estado de
// governança por tool — schema_hash diferente em tool aprovada ⇒ suspended
// (fail-closed). Spec: docs/superpowers/specs/2026-06-10-mcp-external-tools-design.md.
// ---------------------------------------------------------------------------

export type McpServerStatus = 'active' | 'disabled';
export type McpToolStatus = 'discovered' | 'approved' | 'suspended' | 'rejected';

export const mcp_servers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    transport: text('transport').notNull().default('streamable_http'),
    auth_secret_ref: text('auth_secret_ref'),
    status: text('status').notNull().default('active'), // McpServerStatus
    created_by: text('created_by').notNull(),
    test_requested_at: timestamp('test_requested_at', { withTimezone: true }),
    last_test_at: timestamp('last_test_at', { withTimezone: true }),
    last_test_result: jsonb('last_test_result'),
    sync_requested_at: timestamp('sync_requested_at', { withTimezone: true }),
    last_sync_at: timestamp('last_sync_at', { withTimezone: true }),
    last_sync_result: jsonb('last_sync_result'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('mcp_servers_tenant_idx').on(t.tenant_id, t.status),
    tenantNameUq: uniqueIndex('mcp_servers_tenant_name_uq').on(t.tenant_id, t.name),
  }),
);

export const mcp_server_tools = pgTable(
  'mcp_server_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    server_id: uuid('server_id')
      .notNull()
      .references(() => mcp_servers.id, { onDelete: 'cascade' }),
    tenant_id: text('tenant_id').notNull(),
    tool_name: text('tool_name').notNull(),
    description: text('description'),
    input_schema: jsonb('input_schema').notNull().default({}),
    schema_hash: text('schema_hash').notNull(),
    is_read_only: boolean('is_read_only').notNull().default(false),
    status: text('status').notNull().default('discovered'), // McpToolStatus
    risk_class: text('risk_class').notNull().default('critical'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    decision_comment: text('decision_comment'),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('mcp_server_tools_tenant_idx').on(t.tenant_id, t.status),
    serverIdx: index('mcp_server_tools_server_idx').on(t.server_id, t.status),
    serverToolUq: uniqueIndex('mcp_server_tools_server_tool_uq').on(t.server_id, t.tool_name),
  }),
);

export type McpServer = typeof mcp_servers.$inferSelect;
export type NewMcpServer = typeof mcp_servers.$inferInsert;
export type McpServerTool = typeof mcp_server_tools.$inferSelect;
export type NewMcpServerTool = typeof mcp_server_tools.$inferInsert;

// ─── Issue #503 — máquina de estados durável do turno inbound (migration 097) ─
//
// O turno é LÓGICO: agrega N mensagens inbound (debounce) numa única execução.
// PostgreSQL é a fonte de verdade do ciclo de vida; Redis/BullMQ são só
// wake-up e distribuição. O vocabulário de `status`/`outcome` e a tabela de
// transições vivem em `src/runtime/turns/contract.ts` — aqui só a forma da row.
// Toda escrita passa por `agentTurnsRepo` (src/db/repositories/turn-repos.ts);
// nenhum caller atualiza `status` direto.
export const agent_turns = pgTable(
  'agent_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    // NULL até a identidade/conversa ser resolvida (o inbound é persistido
    // ANTES da resolução — ver src/gateway/baileys.ts).
    conversa_id: uuid('conversa_id'),
    channel_id: uuid('channel_id'),
    representative_message_id: uuid('representative_message_id').notNull(),
    status: text('status').notNull().default('received'), // TurnStatus
    outcome: text('outcome'), // TurnOutcome | null
    /** Turno que absorveu este pelo debounce (só em `superseded`). */
    superseded_by_turn_id: uuid('superseded_by_turn_id'),
    // Compare-and-swap: toda transição incrementa e o UPDATE exige a versão
    // esperada. `bigint` com mode 'number' — o contador nunca chega perto de
    // 2^53 (é por turno, não global).
    state_version: bigint('state_version', { mode: 'number' }).notNull().default(0),
    attempt_count: integer('attempt_count').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    // Sanitizados por `sanitizeTurnError` — nunca payload/prompt/PII.
    last_error_code: text('last_error_code'),
    last_error_summary: text('last_error_summary'),
    // #504 (claim atômico / lease / fencing). `claim_token` é o FENCE: toda
    // gravação da tentativa exige o token vigente no WHERE, então um worker que
    // perdeu o lease não consegue escrever mesmo estando vivo.
    claimed_by: text('claimed_by'),
    claim_token: uuid('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    /** #504 — último heartbeat do dono. NULL = nunca houve dono com lease. */
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    // Reservado para #507 (deadline/cancelamento).
    deadline_at: timestamp('deadline_at', { withTimezone: true }),
    // Reservado para #506 (outbox durável).
    outbound_message_id: uuid('outbound_message_id'),
    // 118 (#505, shadow) — a STREAM a que o turno pertence e as FRONTEIRAS de
    // sequência que ele consumiu. Turno simples: `first === last`. Turno
    // agregado pelo debounce: o intervalo fechado dos ingressos absorvidos.
    // NULL = turno anterior ao protocolo (sem backfill).
    stream_key: text('stream_key'),
    stream_key_version: smallint('stream_key_version'),
    first_ingress_seq: bigint('first_ingress_seq', { mode: 'number' }),
    last_ingress_seq: bigint('last_ingress_seq', { mode: 'number' }),
    queued_at: timestamp('queued_at', { withTimezone: true }),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }),
    outbound_committed_at: timestamp('outbound_committed_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    dead_lettered_at: timestamp('dead_lettered_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdUq: unique('agent_turns_scope_id_uq').on(t.tenant_id, t.agent_id, t.id),
    representativeUq: uniqueIndex('agent_turns_representative_uq').on(
      t.representative_message_id,
    ),
    scopeStatusIdx: index('agent_turns_scope_status_next_attempt_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
      t.next_attempt_at,
    ),
    pendingDispatchIdx: index('agent_turns_pending_dispatch_idx')
      .on(t.status, t.next_attempt_at, t.created_at)
      .where(sql`status IN ('received', 'queued', 'claimed', 'running', 'retryable')`),
    conversaIdx: index('agent_turns_conversa_idx')
      .on(t.tenant_id, t.agent_id, t.conversa_id, t.created_at)
      .where(sql`conversa_id IS NOT NULL`),
    leaseIdx: index('agent_turns_lease_idx')
      .on(t.tenant_id, t.agent_id, t.lease_expires_at)
      .where(sql`status IN ('claimed', 'running')`),
    // #504 (migration 114): mesma pergunta, SEM tenant no prefixo — é o
    // dispatcher cross-tenant do recovery que a faz.
    leaseExpiryIdx: index('agent_turns_lease_expiry_idx')
      .on(t.lease_expires_at)
      .where(sql`status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL`),
    // #505 (migration 119): "existe turno ANTERIOR não terminal nesta stream?"
    // — o predicado do head-of-line das fases 5–6. Criado já na fase shadow
    // para que a ativação do enforcement não some uma construção de índice a
    // uma mudança de comportamento na mesma janela.
    streamHeadIdx: index('agent_turns_stream_head_idx')
      .on(t.tenant_id, t.agent_id, t.stream_key, t.first_ingress_seq, t.status)
      .where(sql`stream_key IS NOT NULL`),
    supersededByIdx: index('agent_turns_superseded_by_idx')
      .on(t.tenant_id, t.agent_id, t.superseded_by_turn_id)
      .where(sql`superseded_by_turn_id IS NOT NULL`),
    liveStatusIdx: index('agent_turns_live_status_idx')
      .on(t.status, t.updated_at)
      .where(
        sql`status IN ('received', 'queued', 'claimed', 'running', 'outbound_pending', 'retryable')`,
      ),
  }),
);

// Associação inbound -> turno. As DUAS FKs são COMPOSTAS por (tenant, agent):
// é o que impede fisicamente ligar uma mensagem do tenant B a um turno do
// tenant A. A unique em `mensagem_id` implementa "uma mensagem inbound
// pertence a no máximo um turno".
export const agent_turn_inputs = pgTable(
  'agent_turn_inputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    turn_id: uuid('turn_id').notNull(),
    mensagem_id: uuid('mensagem_id').notNull(),
    /** Ordem de chegada dentro do turno. 0 = mensagem representativa. */
    ingress_seq: integer('ingress_seq').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mensagemUq: uniqueIndex('agent_turn_inputs_mensagem_uq').on(t.mensagem_id),
    turnIdx: index('agent_turn_inputs_turn_idx').on(
      t.tenant_id,
      t.agent_id,
      t.turn_id,
      t.ingress_seq,
    ),
  }),
);

// Issue #505 (migration 118) — contador TRANSACIONAL de ingresso por stream.
//
// Uma linha por (tenant, agent, stream_key). O incremento é uma única
// declaração `INSERT … ON CONFLICT DO UPDATE … RETURNING`, atômica e monotônica
// sob múltiplos produtores: o lock da linha serializa APENAS a stream em
// questão, e streams distintas não se veem (é isso que dá paralelismo entre
// conversas sem lock global).
//
// A PK inclui tenant e agent mesmo com a `stream_key` já embutindo os dois no
// material canônico: embutir não é escopar. Com o par na chave, uma stream_key
// forjada ou colidida não consegue nem ENDEREÇAR o contador de outro tenant.
export const agent_stream_sequences = pgTable(
  'agent_stream_sequences',
  {
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    stream_key: text('stream_key').notNull(),
    /** Versão do algoritmo que MINTOU a stream — não muda no incremento. */
    stream_key_version: smallint('stream_key_version').notNull(),
    /** Última sequência ENTREGUE. 0 = linha nova; a 1ª alocação devolve 1. */
    last_ingress_seq: bigint('last_ingress_seq', { mode: 'number' }).notNull().default(0),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: 'agent_stream_sequences_pk',
      columns: [t.tenant_id, t.agent_id, t.stream_key],
    }),
  }),
);

export type AgentTurn = typeof agent_turns.$inferSelect;
export type NewAgentTurn = typeof agent_turns.$inferInsert;
export type AgentTurnInput = typeof agent_turn_inputs.$inferSelect;
export type NewAgentTurnInput = typeof agent_turn_inputs.$inferInsert;
export type AgentStreamSequence = typeof agent_stream_sequences.$inferSelect;

// ---------------------------------------------------------------------------
// Issue #520 — evidência de backup/restore (migration 101) e ciclo de vida de
// dados (migration 102).
//
// ESCOPO: as três tabelas de backup são DB-wide por natureza (`pg_dump` não
// tem tenant a que se atribuir) e vivem sob o sentinela RESERVADO `system`
// (src/db/tenant-context.ts:77) — a migration 101 grava esse contrato num
// CHECK. As quatro tabelas de ciclo de vida são per-tenant DE VERDADE:
// tenant_id/agent_id NOT NULL, primeiro em todo índice, e a migration 102
// recusa o literal legado 'default'.
// ---------------------------------------------------------------------------

export const backup_runs = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('system'),
    agent_id: text('agent_id').notNull().default('system'),
    correlation_id: text('correlation_id').notNull(),
    /** BackupState — src/ops/backup/state-machine.ts. */
    state: text('state').notNull().default('scheduled'),
    profile: text('profile').notNull(),
    trigger: text('trigger').notNull().default('schedule'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    dump_duration_ms: integer('dump_duration_ms'),
    upload_duration_ms: integer('upload_duration_ms'),
    outcome: text('outcome'),
    outcome_reason: text('outcome_reason'),
    /** Basename apenas — nunca caminho absoluto. */
    artifact_ref: text('artifact_ref'),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    encryption_mode: text('encryption_mode').notNull().default('none'),
    /** IDENTIFICADOR de chave. Material de chave nunca é persistido. */
    encryption_key_id: text('encryption_key_id'),
    destination_kind: text('destination_kind').notNull().default('local'),
    /** Locator opaco — src/ops/backup/redaction.ts:opaqueLocator. */
    destination_locator: text('destination_locator'),
    local_verified: boolean('local_verified').notNull().default(false),
    remote_verified: boolean('remote_verified').notNull().default(false),
    remote_verified_at: timestamp('remote_verified_at', { withTimezone: true }),
    tombstone_watermark: timestamp('tombstone_watermark', { withTimezone: true }),
    retention_class: text('retention_class').notNull().default('backup_artifact'),
    delete_after: timestamp('delete_after', { withTimezone: true }),
    legal_hold_state: text('legal_hold_state').notNull().default('none'),
    /** Código estável de falha — NUNCA a stderr crua do pg_dump. */
    error_code: text('error_code'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recent_idx: index('backup_runs_recent_idx').on(
      t.destination_kind,
      t.remote_verified,
      t.started_at,
    ),
    state_idx: index('backup_runs_state_idx').on(t.state, t.started_at),
    // O unique parcial de single-flight (WHERE state IN (não-terminais)) e os
    // CHECKs de forma vivem na migration 101 — Drizzle não os expressa aqui.
  }),
);

export const backup_manifests = pgTable(
  'backup_manifests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('system'),
    agent_id: text('agent_id').notNull().default('system'),
    backup_run_id: uuid('backup_run_id')
      .notNull()
      .references(() => backup_runs.id),
    manifest_version: integer('manifest_version').notNull(),
    manifest: jsonb('manifest').notNull(),
    manifest_sha256: text('manifest_sha256').notNull(),
    signature: text('signature').notNull(),
    signature_alg: text('signature_alg').notNull().default('HMAC-SHA256'),
    signature_key_version: integer('signature_key_version').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    run_uq: unique('backup_manifests_backup_run_id_key').on(t.backup_run_id),
    created_idx: index('backup_manifests_created_idx').on(t.created_at),
  }),
);

export const restore_drills = pgTable(
  'restore_drills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('system'),
    agent_id: text('agent_id').notNull().default('system'),
    correlation_id: text('correlation_id').notNull(),
    backup_run_id: uuid('backup_run_id').references(() => backup_runs.id),
    source: text('source').notNull().default('local'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    duration_ms: integer('duration_ms'),
    status: text('status').notNull().default('running'),
    /** Booleanos e contagens por probe — nunca valores de linha. */
    probes: jsonb('probes').notNull().default(sql`'{}'::jsonb`),
    tombstones_pending: integer('tombstones_pending'),
    failure_code: text('failure_code'),
    /**
     * Estado do HOST depois do teardown (migration 112): `clean` = banco
     * efêmero e arquivos estagiados provadamente removidos; `unsafe` = alguma
     * cópia da produção ficou (ou não se pôde provar que não ficou);
     * `unknown` = o processo morreu antes de conferir. Eixo INDEPENDENTE de
     * `failure_code`, para que falha de probe e falha de teardown não se
     * mascarem.
     */
    cleanup_status: text('cleanup_status').notNull().default('unknown'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recent_idx: index('restore_drills_recent_idx').on(t.status, t.started_at),
    run_idx: index('restore_drills_run_idx').on(t.backup_run_id),
    /** Parcial: o que se consulta em incidente é "há resíduo?" (migration 112). */
    unsafe_idx: index('restore_drills_unsafe_idx')
      .on(t.started_at)
      .where(sql`cleanup_status = 'unsafe'`),
  }),
);

export const legal_holds = pgTable(
  'legal_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    case_reference: text('case_reference').notNull(),
    /** Classe de dado congelada; '*' cobre todas as classes do escopo. */
    data_class: text('data_class').notNull(),
    /** Sujeito PSEUDONIMIZADO; NULL = hold de escopo amplo. */
    subject_ref: text('subject_ref'),
    /** CÓDIGO de motivo — §11 "logs não expõem motivo sensível". */
    reason_code: text('reason_code').notNull(),
    status: text('status').notNull().default('active'),
    effective_from: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effective_until: timestamp('effective_until', { withTimezone: true }),
    created_by: text('created_by').notNull(),
    approved_by: text('approved_by'),
    released_by: text('released_by'),
    released_at: timestamp('released_at', { withTimezone: true }),
    release_reevaluated_at: timestamp('release_reevaluated_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    active_idx: index('legal_holds_active_idx').on(
      t.tenant_id,
      t.agent_id,
      t.data_class,
      t.status,
      t.effective_from,
      t.effective_until,
    ),
  }),
);

export const privacy_requests = pgTable(
  'privacy_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    type: text('type').notNull(),
    /** Sujeito PSEUDONIMIZADO — §12 "evitar enumeração por identificador". */
    subject_ref: text('subject_ref').notNull(),
    status: text('status').notNull().default('received'),
    identity_method: text('identity_method'),
    identity_verified_by: text('identity_verified_by'),
    identity_verified_at: timestamp('identity_verified_at', { withTimezone: true }),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    due_at: timestamp('due_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    denied_reason_code: text('denied_reason_code'),
    systems_covered: jsonb('systems_covered').notNull().default(sql`'[]'::jsonb`),
    exceptions: jsonb('exceptions').notNull().default(sql`'[]'::jsonb`),
    /** Contagens e códigos, nunca o conteúdo excluído. */
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    /** Locator OPACO — jamais uma URL assinada. */
    export_locator: text('export_locator'),
    export_expires_at: timestamp('export_expires_at', { withTimezone: true }),
    export_downloaded_at: timestamp('export_downloaded_at', { withTimezone: true }),
    /**
     * Migration 118 — o varredor de TTL COMEÇOU neste pedido. Não autoriza
     * nada e não tira o pedido da fila; existe para que um passe interrompido
     * seja visível (started sem purged) em vez de ter que ser deduzido de log.
     */
    export_purge_started_at: timestamp('export_purge_started_at', { withTimezone: true }),
    /**
     * Migration 118 — o `.enc` foi removido e a ausência foi PROVADA. É a
     * condição (`IS NULL`) que torna a marcação uma transição de vencedor
     * único: quem não ganha não audita, e é assim que a segunda execução do
     * varredor não duplica auditoria.
     */
    export_purged_at: timestamp('export_purged_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scope_status_idx: index('privacy_requests_scope_status_idx').on(
      t.tenant_id,
      t.agent_id,
      t.status,
      t.created_at,
    ),
  }),
);

export const data_tombstones = pgTable(
  'data_tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    data_class: text('data_class').notNull(),
    /** PSEUDONIMIZADO — o ledger reconhece um sujeito, nunca o enumera. */
    subject_ref: text('subject_ref'),
    resource_locator: text('resource_locator'),
    action: text('action').notNull(),
    effective_at: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    privacy_request_id: uuid('privacy_request_id').references(() => privacy_requests.id),
    origin: text('origin').notNull().default('privacy_request'),
    version: integer('version').notNull().default(1),
    hmac: text('hmac').notNull(),
    hmac_key_version: integer('hmac_key_version').notNull().default(1),
    last_reconciled_at: timestamp('last_reconciled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    watermark_idx: index('data_tombstones_watermark_idx').on(
      t.effective_at,
      t.tenant_id,
      t.agent_id,
    ),
    scope_class_idx: index('data_tombstones_scope_class_idx').on(
      t.tenant_id,
      t.agent_id,
      t.data_class,
      t.effective_at,
    ),
  }),
);

export const retention_runs = pgTable(
  'retention_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    correlation_id: text('correlation_id').notNull(),
    data_class: text('data_class').notNull(),
    dry_run: boolean('dry_run').notNull().default(true),
    policy_version: text('policy_version').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull().default('running'),
    scanned: integer('scanned').notNull().default(0),
    eligible: integer('eligible').notNull().default(0),
    deleted: integer('deleted').notNull().default(0),
    skipped_held: integer('skipped_held').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    cursor_watermark: timestamp('cursor_watermark', { withTimezone: true }),
    error_code: text('error_code'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scope_idx: index('retention_runs_scope_idx').on(
      t.tenant_id,
      t.agent_id,
      t.data_class,
      t.started_at,
    ),
    status_idx: index('retention_runs_status_idx').on(t.status, t.started_at),
  }),
);

export type BackupRun = typeof backup_runs.$inferSelect;
export type NewBackupRun = typeof backup_runs.$inferInsert;
export type BackupManifestRow = typeof backup_manifests.$inferSelect;
export type NewBackupManifestRow = typeof backup_manifests.$inferInsert;
export type RestoreDrill = typeof restore_drills.$inferSelect;
export type NewRestoreDrill = typeof restore_drills.$inferInsert;
export type LegalHold = typeof legal_holds.$inferSelect;
export type NewLegalHold = typeof legal_holds.$inferInsert;
export type PrivacyRequest = typeof privacy_requests.$inferSelect;
export type NewPrivacyRequest = typeof privacy_requests.$inferInsert;
export type DataTombstone = typeof data_tombstones.$inferSelect;
export type NewDataTombstone = typeof data_tombstones.$inferInsert;
export type RetentionRun = typeof retention_runs.$inferSelect;
export type NewRetentionRun = typeof retention_runs.$inferInsert;

// ── 108 (issue #519) — saga durável de onboarding ────────────────────────────
// A migration 108 é a fonte de verdade das CHECKs (estados válidos, rejeição
// dos literais 'default'/'system', escopo obrigatório por kind). Aqui
// declaramos apenas os tipos que o Drizzle precisa.
//
// `version` é o token de optimistic concurrency: todo comando informa a versão
// que leu e o UPDATE só casa com ela — dois operadores no mesmo passo produzem
// UM avanço e um `version_conflict`.
export const onboarding_runs = pgTable(
  'onboarding_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    // NULL só enquanto o recurso ainda não existe (bootstrap global antes de
    // resolver o tenant; qualquer run antes de criar o agente).
    tenant_id: text('tenant_id'),
    agent_id: text('agent_id'),
    state: text('state').notNull().default('created'),
    current_step: text('current_step'),
    version: integer('version').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    last_error_code: text('last_error_code'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    configuration_contract_version: text('configuration_contract_version').notNull(),
    schema_version: text('schema_version').notNull(),
    // migration 113 — a criação da run é um COMANDO MUTÁVEL e portanto
    // idempotente: o ledger de criação vive na própria run (não há tabela
    // filha onde guardá-lo antes de a run existir). Unicidade em
    // `onboarding_runs_creation_key_uq` por (kind, tenant, hash).
    creation_idempotency_key_hash: text('creation_idempotency_key_hash'),
    creation_payload_hash: text('creation_payload_hash'),
    // migration 113 — ponto de retomada de `failed_retryable`. Sem eles o
    // estado autorizava QUALQUER passo anterior; com eles a máquina de estados
    // só admite o retry do passo que falhou e as remediações declaradas.
    failed_step: text('failed_step'),
    resume_state: text('resume_state'),
  },
  (t) => ({
    tenantStateIdx: index('onboarding_runs_tenant_state_idx').on(
      t.tenant_id,
      t.state,
      t.created_at,
    ),
  }),
);

// Append-only. Sustenta reconstrução e diagnóstico do workflow; NÃO substitui
// `audit_log` (governança). `summary` é sanitizado no código — nada de segredo,
// telefone, e-mail ou QR entra aqui.
export const onboarding_events = pgTable(
  'onboarding_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    run_id: uuid('run_id').notNull(),
    tenant_id: text('tenant_id'),
    agent_id: text('agent_id'),
    step: text('step').notNull(),
    event_type: text('event_type').notNull(),
    actor_id: text('actor_id').notNull(),
    correlation_id: text('correlation_id'),
    idempotency_key_hash: text('idempotency_key_hash'),
    from_state: text('from_state'),
    to_state: text('to_state'),
    summary: jsonb('summary').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('onboarding_events_run_idx').on(t.run_id, t.created_at),
    tenantIdx: index('onboarding_events_tenant_idx').on(t.tenant_id, t.created_at),
  }),
);

// Ledger de idempotência: o resultado persistido de cada comando concluído.
// UNIQUE (run_id, step, idempotency_key_hash) — mesma chave devolve o mesmo
// resultado; chave igual com payload divergente é conflito.
export const onboarding_step_results = pgTable(
  'onboarding_step_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    run_id: uuid('run_id').notNull(),
    tenant_id: text('tenant_id'),
    step: text('step').notNull(),
    idempotency_key_hash: text('idempotency_key_hash').notNull(),
    payload_hash: text('payload_hash').notNull(),
    result: jsonb('result').notNull().default(sql`'{}'::jsonb`),
    // migration 113 — o ledger guarda RESULTADOS CONCLUSIVOS TIPADOS, não só
    // sucessos: uma negativa de governança e um cancelamento também são
    // conclusões, e sem elas o retry da mesma chave devolvia `version_conflict`
    // / `run_terminal` em vez da resposta anterior.
    outcome_kind: text('outcome_kind').notNull().default('success'),
    outcome_code: text('outcome_code'),
    outcome_message: text('outcome_message'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex('onboarding_step_results_key_uq').on(
      t.run_id,
      t.step,
      t.idempotency_key_hash,
    ),
    runIdx: index('onboarding_step_results_run_idx').on(t.run_id, t.created_at),
  }),
);

export type OnboardingRunRow = typeof onboarding_runs.$inferSelect;
export type NewOnboardingRunRow = typeof onboarding_runs.$inferInsert;
export type OnboardingEventRow = typeof onboarding_events.$inferSelect;
export type NewOnboardingEventRow = typeof onboarding_events.$inferInsert;
export type OnboardingStepResultRow = typeof onboarding_step_results.$inferSelect;
export type NewOnboardingStepResultRow = typeof onboarding_step_results.$inferInsert;

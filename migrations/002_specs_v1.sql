-- =====================================================================
-- Maia — Migration 002 (specs v1)
-- Adds: contrapartes, permission_profiles, entity_states, pending_questions,
--       idempotency_keys, system_health_events, dead_letter_jobs, import_runs,
--       import_entries, dashboard_sessions
-- Alters: permissoes (status, profile_id), transacoes (contraparte_id)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- contrapartes ----------
CREATE TABLE contrapartes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID NOT NULL REFERENCES entidades(id) ON DELETE RESTRICT,
  nome            TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('fornecedor','cliente','funcionario_externo','orgao_publico','outro')),
  documento       TEXT,
  chave_pix       TEXT,
  banco_padrao    TEXT,
  observacoes     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','inativa')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entidade_id, documento)
);
CREATE INDEX idx_contrapartes_entidade ON contrapartes (entidade_id);
CREATE INDEX idx_contrapartes_nome_trgm ON contrapartes USING gin (nome gin_trgm_ops);
CREATE TRIGGER set_updated_at_contrapartes BEFORE UPDATE ON contrapartes FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

ALTER TABLE transacoes ADD COLUMN contraparte_id UUID REFERENCES contrapartes(id) ON DELETE SET NULL;
CREATE INDEX idx_transacoes_contraparte ON transacoes (contraparte_id);

-- ---------- permission_profiles ----------
CREATE TABLE permission_profiles (
  id              TEXT PRIMARY KEY,
  nome            TEXT NOT NULL,
  acoes           TEXT[] NOT NULL,
  limite_default  NUMERIC(15,2) NOT NULL DEFAULT 0,
  descricao       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO permission_profiles (id, nome, acoes, limite_default, descricao) VALUES
  ('dono_total',         'Dono — acesso total',
     ARRAY['*'],                                    999999999.00,
     'Owner. Bypasses single-signature limits but not 4-eyes critical actions.'),
  ('co_dono',            'Co-dono — acesso total com 4-eyes',
     ARRAY['*'],                                    999999999.00,
     'Spouse-equivalent. Same as dono_total but always counts toward 4-eyes.'),
  ('contador_leitura',   'Contador (leitura)',
     ARRAY['read_balance','read_transactions','read_reports','read_recurrences'],
     0.00,
     'Read-only on assigned entities; can request reports.'),
  ('operador_basico',    'Operador básico',
     ARRAY['read_balance','read_transactions','create_transaction'],
     200.00,
     'Can register low-value transactions on assigned entities.'),
  ('operador_avancado',  'Operador avançado',
     ARRAY['read_balance','read_transactions','create_transaction','schedule_reminder','correct_transaction'],
     1000.00,
     'Can register and correct transactions; lower frequency oversight.'),
  ('leitor',             'Leitor',
     ARRAY['read_balance'],
     0.00,
     'Read-only minimal: balance only.'),
  ('contato',            'Contato (sem acesso a dados)',
     ARRAY[]::TEXT[],
     0.00,
     'May converse with Maia but cannot read any entity data.');

-- ---------- permissoes alterations ----------
ALTER TABLE permissoes
  ADD COLUMN profile_id TEXT REFERENCES permission_profiles(id),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa','suspensa','revogada','pendente'));

UPDATE permissoes SET profile_id = 'dono_total' WHERE papel = 'dono';
UPDATE permissoes SET profile_id = 'contador_leitura' WHERE papel = 'contador';
UPDATE permissoes SET profile_id = 'operador_basico' WHERE papel = 'operador';
UPDATE permissoes SET profile_id = 'leitor' WHERE papel = 'leitor';
UPDATE permissoes SET profile_id = 'contato' WHERE papel = 'contato';
UPDATE permissoes SET profile_id = 'co_dono' WHERE papel = 'admin';

CREATE INDEX idx_permissoes_status ON permissoes (status) WHERE status != 'revogada';

-- ---------- pessoas: add 'quarentena' status ----------
ALTER TABLE pessoas DROP CONSTRAINT pessoas_status_check;
ALTER TABLE pessoas ADD CONSTRAINT pessoas_status_check
  CHECK (status IN ('ativa','inativa','bloqueada','quarentena'));

-- ---------- entity_states ----------
CREATE TABLE entity_states (
  entidade_id           UUID PRIMARY KEY REFERENCES entidades(id) ON DELETE CASCADE,
  workflow_atual        UUID REFERENCES workflows(id),
  contexto              JSONB NOT NULL DEFAULT '{}'::jsonb,
  ultima_reconciliacao  TIMESTAMPTZ,
  ultimo_briefing       TIMESTAMPTZ,
  proximo_vencimento    DATE,
  saldo_consolidado     NUMERIC(15,2),
  saldo_atualizado_em   TIMESTAMPTZ,
  flags                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER set_updated_at_entity_states BEFORE UPDATE ON entity_states FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- pending_questions ----------
CREATE TABLE pending_questions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversa_id     UUID REFERENCES conversas(id) ON DELETE CASCADE,
  pessoa_id       UUID REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  pergunta        TEXT NOT NULL,
  opcoes_validas  JSONB NOT NULL DEFAULT '[]'::jsonb,
  acao_proposta   JSONB NOT NULL,
  expira_em       TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','respondida','expirada','cancelada')),
  resposta        JSONB,
  resolvida_em    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pending_open ON pending_questions (status, expira_em) WHERE status = 'aberta';
CREATE INDEX idx_pending_pessoa ON pending_questions (pessoa_id, status);

-- ---------- idempotency_keys ----------
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  tool_name       TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id),
  entity_id       UUID NOT NULL REFERENCES entidades(id),
  payload_hash    TEXT NOT NULL,
  file_sha256     TEXT,
  resultado       JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_idempotency_created ON idempotency_keys (created_at);
CREATE INDEX idx_idempotency_pessoa ON idempotency_keys (pessoa_id, created_at DESC);

-- ---------- system_health_events ----------
CREATE TABLE system_health_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  component       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ok','degraded','down')),
  duration_ms     INT,
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_health_component_time ON system_health_events (component, created_at DESC);

-- ---------- dead_letter_jobs ----------
CREATE TABLE dead_letter_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  queue_name      TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  payload         JSONB NOT NULL,
  error           TEXT NOT NULL,
  attempts        INT NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at  TIMESTAMPTZ NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dlq_unresolved ON dead_letter_jobs (resolved, created_at DESC) WHERE resolved = FALSE;

-- ---------- import_runs / import_entries (Phase 4) ----------
CREATE TABLE import_runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id         UUID NOT NULL REFERENCES pessoas(id),
  entidade_id       UUID NOT NULL REFERENCES entidades(id),
  conta_id          UUID NOT NULL REFERENCES contas_bancarias(id),
  fonte             TEXT NOT NULL CHECK (fonte IN ('ofx','csv','pdf-extrato')),
  arquivo_sha256    TEXT NOT NULL,
  arquivo_nome      TEXT,
  periodo_de        DATE,
  periodo_ate       DATE,
  total_lancamentos INT NOT NULL DEFAULT 0,
  matched           INT NOT NULL DEFAULT 0,
  candidates        INT NOT NULL DEFAULT 0,
  novos             INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('pending_review','aplicado','cancelado','falhou')),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conta_id, arquivo_sha256)
);
CREATE TRIGGER set_updated_at_import_runs BEFORE UPDATE ON import_runs FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE import_entries (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_run_id         UUID NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  ordem                 INT NOT NULL,
  tipo_oper             TEXT NOT NULL CHECK (tipo_oper IN ('credit','debit')),
  valor                 NUMERIC(15,2) NOT NULL,
  data_oper             DATE NOT NULL,
  fitid                 TEXT,
  memo                  TEXT,
  contraparte_raw       TEXT,
  status                TEXT NOT NULL CHECK (status IN ('matched','candidate','new','rejected')),
  matched_transacao_id  UUID REFERENCES transacoes(id),
  candidates            JSONB,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_entries_run ON import_entries (import_run_id, ordem);

-- ---------- dashboard_sessions (Phase 5 stub) ----------
CREATE TABLE dashboard_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id),
  token_hash      TEXT NOT NULL,
  expira_em       TIMESTAMPTZ NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX idx_dashboard_sessions_active ON dashboard_sessions (pessoa_id) WHERE revoked_at IS NULL;

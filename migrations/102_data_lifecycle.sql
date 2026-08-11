-- 102 — Ciclo de vida de dados: legal hold, tombstones, privacy requests e
-- execuções de retenção (issue #520, §10/§11/§12/§13).
--
-- A busca no baseline não encontrou NENHUM destes fluxos implementado
-- ponta-a-ponta. As consequências que estas tabelas fecham:
--
--   * um restore de um snapshot anterior a uma exclusão RESSUSCITA o dado
--     (§13) — `data_tombstones` é o ledger que permite reaplicar a exclusão
--     antes de liberar tráfego;
--   * `legal_holds` dá ao backend um veredito determinístico sobre purge —
--     sem ele, hold e retenção competiriam de forma não determinística;
--   * `privacy_requests` persiste o workflow LGPD (acesso/exportação,
--     correção, anonimização/exclusão) com verificação de identidade FORA do
--     LLM e evidência do que foi coberto;
--   * `retention_runs` torna cada passe de retenção auditável, retomável e
--     dry-runnable.
--
-- ESCOPO (invariante 1): ao contrário da migration 101 (backup é DB-wide), TUDO
-- aqui é per-tenant de verdade. `tenant_id`/`agent_id` são NOT NULL, entram
-- primeiro em todo índice, e o CHECK abaixo recusa explicitamente o literal
-- legado 'default' — fail-closed, sem fallback.
--
-- PRAZOS JURÍDICOS: esta migration NÃO codifica prazo nenhum. Não há coluna de
-- "retenção padrão em dias" com valor cravado; a matriz de classes de dado vive
-- em src/ops/retention/data-classes.ts como CONFIGURAÇÃO com default
-- conservador, pendente de aprovação do jurídico/DPO (issue: "prazos, bases
-- legais e exceções precisam de aprovação do responsável jurídico/DPO").
--
-- PRIVACIDADE DO PRÓPRIO LEDGER: um tombstone que guardasse o telefone
-- excluído seria uma cópia do dado que ele diz ter apagado. Por isso
-- `subject_ref` e `resource_locator` são PSEUDONIMIZADOS (HMAC) pela aplicação
-- — o ledger permite RECONHECER um sujeito já conhecido, nunca enumerá-lo.

CREATE TABLE IF NOT EXISTS legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,

  -- Referência do caso (número do processo/ticket). Texto operacional, não PII.
  case_reference text NOT NULL,
  -- Classe de dado congelada. '*' congela todas as classes do escopo.
  data_class text NOT NULL,
  -- Sujeito pseudonimizado; NULL = hold de escopo amplo (todo o tenant/classe).
  subject_ref text,
  -- CÓDIGO de motivo, não texto livre: §11 "logs não expõem motivo sensível".
  reason_code text NOT NULL,

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  -- NULL = indefinido (até liberação explícita).
  effective_until timestamptz,

  -- §11 "criação/liberação exige papel e, se definido, dupla aprovação".
  created_by text NOT NULL,
  approved_by text,
  released_by text,
  released_at timestamptz,
  -- §11 "release não dispara deleção imediata sem reavaliação".
  release_reevaluated_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT legal_holds_scope_chk CHECK (tenant_id <> 'default' AND agent_id <> 'default'),
  CONSTRAINT legal_holds_released_shape_chk
    CHECK (status <> 'released' OR (released_by IS NOT NULL AND released_at IS NOT NULL))
);

-- O avaliador de hold pergunta sempre "existe hold ATIVO para (tenant, classe,
-- sujeito) agora?" — este índice é essa pergunta.
CREATE INDEX IF NOT EXISTS legal_holds_active_idx
  ON legal_holds (tenant_id, agent_id, data_class, status, effective_from, effective_until);

CREATE INDEX IF NOT EXISTS legal_holds_subject_idx
  ON legal_holds (tenant_id, agent_id, subject_ref)
  WHERE subject_ref IS NOT NULL;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,

  type text NOT NULL
    CHECK (type IN ('access_export', 'rectification', 'anonymization', 'deletion')),
  -- Sujeito PSEUDONIMIZADO. Guardar o telefone aqui transformaria a tabela de
  -- pedidos de privacidade num diretório de titulares (§12 "evitar enumeração
  -- por identificador").
  subject_ref text NOT NULL,

  status text NOT NULL DEFAULT 'received'
    CHECK (status IN (
      'received', 'identity_pending', 'identity_verified', 'approved',
      'in_progress', 'completed', 'denied', 'failed'
    )),

  -- §12 "verificação de identidade fora do LLM". `identity_verified_by` é
  -- SEMPRE um ator humano/backend determinístico; o CHECK abaixo impede que
  -- um pedido avance sem esse carimbo.
  identity_method text CHECK (identity_method IN ('owner_confirmation', 'admin_console', 'document')),
  identity_verified_by text,
  identity_verified_at timestamptz,

  approved_by text,
  approved_at timestamptz,
  -- Prazo de atendimento. O VALOR é configuração (default conservador),
  -- não uma constante jurídica cravada no schema.
  due_at timestamptz,
  completed_at timestamptz,
  denied_reason_code text,

  -- §12 "produzir relatório de sistemas cobertos e exceções aprovadas".
  systems_covered jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Contagens e códigos, nunca o conteúdo excluído (§15).
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- §12 "gerar export seguro, criptografado, expirá-lo e auditar acesso".
  -- Locator OPACO — jamais uma URL assinada.
  export_locator text,
  export_expires_at timestamptz,
  export_downloaded_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT privacy_requests_scope_chk CHECK (tenant_id <> 'default' AND agent_id <> 'default'),
  -- Identidade verificada é PRÉ-REQUISITO para sair de received/identity_pending.
  CONSTRAINT privacy_requests_identity_chk
    CHECK (
      status IN ('received', 'identity_pending', 'denied', 'failed')
      OR (identity_verified_by IS NOT NULL AND identity_verified_at IS NOT NULL)
    ),
  -- Um export sem expiração é um vazamento com prazo infinito.
  CONSTRAINT privacy_requests_export_expiry_chk
    CHECK (export_locator IS NULL OR export_expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS privacy_requests_scope_status_idx
  ON privacy_requests (tenant_id, agent_id, status, created_at DESC);

-- Um titular não deve ter dois pedidos DESTRUTIVOS abertos ao mesmo tempo
-- (duas exclusões concorrentes competiriam pelo mesmo dado).
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_open_subject_uq
  ON privacy_requests (tenant_id, agent_id, subject_ref, type)
  WHERE status IN ('received', 'identity_pending', 'identity_verified', 'approved', 'in_progress');

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,

  data_class text NOT NULL,
  -- PSEUDONIMIZADOS (HMAC aplicado pela aplicação). O ledger reconhece; não
  -- enumera. Ver src/ops/retention/tombstones.ts.
  subject_ref text,
  resource_locator text,

  action text NOT NULL CHECK (action IN ('delete', 'anonymize', 'redact')),
  -- Instante em que a exclusão passou a valer. Um restore cujo
  -- `tombstone_watermark` é ANTERIOR a este valor precisa reaplicar a ação.
  effective_at timestamptz NOT NULL DEFAULT now(),

  privacy_request_id uuid REFERENCES privacy_requests (id),
  -- Retenção ordinária também gera tombstone: sem ele, restaurar um snapshot
  -- antigo reviveria exatamente o que a política mandou expirar.
  origin text NOT NULL DEFAULT 'privacy_request'
    CHECK (origin IN ('privacy_request', 'retention_policy', 'operator')),

  -- Versão do registro + HMAC sobre o conteúdo canônico: um tombstone alterado
  -- (ou plantado) não passa na verificação da reconciliação.
  version integer NOT NULL DEFAULT 1,
  hmac text NOT NULL,
  hmac_key_version integer NOT NULL DEFAULT 1,

  -- Reconciliação: quando este tombstone foi reaplicado com sucesso após um
  -- restore. NULL = ainda pendente para qualquer snapshot anterior.
  last_reconciled_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT data_tombstones_scope_chk CHECK (tenant_id <> 'default' AND agent_id <> 'default'),
  -- Um tombstone sem alvo não é acionável.
  CONSTRAINT data_tombstones_target_chk
    CHECK (subject_ref IS NOT NULL OR resource_locator IS NOT NULL)
);

-- Consulta central da reconciliação pós-restore (§13 passo 4): "todos os
-- tombstones com effective_at > watermark do backup", em ordem determinística.
CREATE INDEX IF NOT EXISTS data_tombstones_watermark_idx
  ON data_tombstones (effective_at, tenant_id, agent_id);

CREATE INDEX IF NOT EXISTS data_tombstones_scope_class_idx
  ON data_tombstones (tenant_id, agent_id, data_class, effective_at DESC);

CREATE INDEX IF NOT EXISTS data_tombstones_subject_idx
  ON data_tombstones (tenant_id, agent_id, subject_ref)
  WHERE subject_ref IS NOT NULL;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  correlation_id text NOT NULL,

  data_class text NOT NULL,
  -- §10 "dry-run com contagem". Default TRUE espelha RETENTION_DRY_RUN: um
  -- passe que não declara intenção explícita NÃO apaga nada.
  dry_run boolean NOT NULL DEFAULT true,
  -- Versão da política aplicada — permite comparar contagens entre versões
  -- antes de ativar (§"Migração e rollout" passo 10).
  policy_version text NOT NULL,

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed')),

  scanned integer NOT NULL DEFAULT 0,
  eligible integer NOT NULL DEFAULT 0,
  deleted integer NOT NULL DEFAULT 0,
  -- §11 "hold ativo bloqueia purge aplicável" — contado, não silencioso.
  skipped_held integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,

  -- Cursor/watermark para retomada de um passe parcial (§10).
  cursor_watermark timestamptz,
  error_code text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT retention_runs_scope_chk CHECK (tenant_id <> 'default' AND agent_id <> 'default'),
  -- Dry-run NUNCA apaga. O banco recusa uma linha que afirme o contrário.
  CONSTRAINT retention_runs_dry_run_chk CHECK (NOT dry_run OR deleted = 0)
);

CREATE INDEX IF NOT EXISTS retention_runs_scope_idx
  ON retention_runs (tenant_id, agent_id, data_class, started_at DESC);

CREATE INDEX IF NOT EXISTS retention_runs_status_idx
  ON retention_runs (status, started_at DESC);

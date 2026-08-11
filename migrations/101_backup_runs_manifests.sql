-- 101 — Evidência durável de backup e restore (issue #520, §2/§3/§7/§15).
--
-- Antes desta migration a única evidência de um backup era uma linha em
-- `audit_logs` com `acao='backup_completed'` — emitida mesmo quando o upload
-- off-site tinha acabado de falhar (src/workers/backup.ts:50-85) e carregando
-- caminho local completo + URL do S3 no metadata. Não havia como responder
-- "qual foi o último backup íntegro e off-site?" sem ler o bucket na mão.
--
-- Três tabelas, três responsabilidades distintas (§15 "separar estado
-- operacional / manifesto técnico / audit log de decisão / métricas"):
--
--   backup_runs      — ESTADO OPERACIONAL. Uma linha por execução, com a
--                      máquina de estados do §2 e o veredito computado a
--                      partir de evidência (nunca de intenção).
--   backup_manifests — MANIFESTO TÉCNICO. Imutável, assinado (HMAC), 1:1 com
--                      a run. É o documento que um drill valida antes de
--                      restaurar qualquer coisa.
--   restore_drills   — RESULTADO DO DRILL. Liga-se ao backup_run exercitado e
--                      alimenta o RTO medido.
--
-- ESCOPO DE TENANT (invariante 1 + §"Invariantes obrigatórios"): um `pg_dump`
-- é DB-wide — não existe linha per-tenant a que atribuí-lo. As três tabelas
-- portanto vivem sob o sentinela RESERVADO `system` (src/db/tenant-context.ts:77),
-- e o CHECK abaixo torna isso EXPLÍCITO E VERIFICÁVEL: nenhuma outra tupla é
-- aceita, e em particular o literal legado 'default' é impossível. Isto NÃO é
-- um catch-all: retenção, legal hold, tombstone e privacy request (migration
-- 102) são per-tenant de verdade e NÃO usam este sentinela.
--
-- SEGREDOS: nenhuma coluna aqui aceita caminho absoluto, URL assinada,
-- credencial ou PII. `artifact_ref` é basename; `destination_locator` é o
-- hash opaco de src/ops/backup/redaction.ts:opaqueLocator; falhas guardam um
-- CÓDIGO estável (`error_code`), nunca a mensagem crua do pg_dump (que contém
-- a DATABASE_URL com senha).

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'system',
  agent_id text NOT NULL DEFAULT 'system',
  correlation_id text NOT NULL,

  -- Máquina de estados do §2. O CHECK impede que um estado inventado entre
  -- por um deploy antigo/novo fora de sincronia.
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN (
      'scheduled', 'running', 'dump_created', 'locally_verified', 'encrypted',
      'uploaded', 'remotely_verified', 'completed', 'completed_degraded',
      'failed', 'expired', 'deleted'
    )),
  profile text NOT NULL CHECK (profile IN ('development', 'staging', 'production')),
  trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'cli', 'retry')),

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  dump_duration_ms integer,
  upload_duration_ms integer,

  -- Veredito terminal e a RAZÃO estável (safe para label de métrica).
  outcome text CHECK (outcome IN ('completed', 'completed_degraded', 'failed')),
  outcome_reason text,

  -- Identidade do artefato — basename apenas, jamais caminho absoluto.
  artifact_ref text,
  size_bytes bigint,
  sha256 text,

  encryption_mode text NOT NULL DEFAULT 'none'
    CHECK (encryption_mode IN ('none', 'envelope_aes256_gcm')),
  -- IDENTIFICADOR de chave. Material de chave nunca é persistido.
  encryption_key_id text,

  destination_kind text NOT NULL DEFAULT 'local'
    CHECK (destination_kind IN ('local', 's3')),
  destination_locator text,

  local_verified boolean NOT NULL DEFAULT false,
  remote_verified boolean NOT NULL DEFAULT false,
  remote_verified_at timestamptz,

  -- Watermark de tombstones no instante do dump (§13): tudo excluído DEPOIS
  -- deste ponto precisa ser reaplicado antes de o restore liberar tráfego.
  tombstone_watermark timestamptz,

  retention_class text NOT NULL DEFAULT 'backup_artifact',
  delete_after timestamptz,
  legal_hold_state text NOT NULL DEFAULT 'none' CHECK (legal_hold_state IN ('none', 'held')),

  -- Código estável de falha. NUNCA a stderr crua.
  error_code text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Backup é global por natureza: só o sentinela reservado `system` é aceito.
  CONSTRAINT backup_runs_system_scope_chk
    CHECK (tenant_id = 'system' AND agent_id = 'system')
);

-- Um veredito terminal exige razão e horário de término (fail-loud em drift:
-- uma run "completed" sem finished_at seria evidência incompleta).
ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_terminal_shape_chk
  CHECK (
    state NOT IN ('completed', 'completed_degraded', 'failed')
    OR (outcome IS NOT NULL AND outcome_reason IS NOT NULL AND finished_at IS NOT NULL)
  );

-- Criptografia declarada exige o identificador da chave usada.
ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_encryption_key_chk
  CHECK (encryption_mode = 'none' OR encryption_key_id IS NOT NULL);

-- SINGLE-FLIGHT persistido (§2). O advisory lock de
-- src/ops/backup/single-flight.ts serializa processos vivos; este índice
-- parcial é a defesa em profundidade que sobrevive a um worker morto: no
-- máximo UMA run não-terminal existe a qualquer momento.
CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_single_active_uq
  ON backup_runs ((true))
  WHERE state IN ('scheduled', 'running', 'dump_created', 'locally_verified', 'encrypted', 'uploaded', 'remotely_verified');

-- Consulta primária do readiness/RPO: "qual a run verificada mais recente por
-- destino?" (src/ops/backup/rpo.ts).
CREATE INDEX IF NOT EXISTS backup_runs_recent_idx
  ON backup_runs (destination_kind, remote_verified, started_at DESC);

CREATE INDEX IF NOT EXISTS backup_runs_state_idx
  ON backup_runs (state, started_at DESC);

CREATE INDEX IF NOT EXISTS backup_runs_retention_idx
  ON backup_runs (delete_after)
  WHERE state IN ('completed', 'completed_degraded');

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS backup_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'system',
  agent_id text NOT NULL DEFAULT 'system',
  -- 1:1 com a run. O UNIQUE é o que torna o manifesto IMUTÁVEL na prática:
  -- não há "atualizar o manifesto", só emitir o de uma nova run.
  backup_run_id uuid NOT NULL UNIQUE REFERENCES backup_runs (id),

  manifest_version integer NOT NULL,
  -- Corpo canônico validado por src/ops/backup/manifest.ts:backupManifestSchema.
  manifest jsonb NOT NULL,
  -- SHA-256 da serialização canônica — permite comparar sem reparsear o JSON.
  manifest_sha256 text NOT NULL,
  -- Assinatura sobre a serialização canônica. `signature_key_version` permite
  -- rotacionar o segredo mantendo manifestos antigos verificáveis.
  signature text NOT NULL,
  signature_alg text NOT NULL DEFAULT 'HMAC-SHA256',
  signature_key_version integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT backup_manifests_system_scope_chk
    CHECK (tenant_id = 'system' AND agent_id = 'system')
);

CREATE INDEX IF NOT EXISTS backup_manifests_created_idx
  ON backup_manifests (created_at DESC);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS restore_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'system',
  agent_id text NOT NULL DEFAULT 'system',
  correlation_id text NOT NULL,

  -- NULL quando o drill nem chegou a selecionar um artefato (ex.: não havia
  -- nenhum candidato válido) — o registro da tentativa ainda importa.
  backup_run_id uuid REFERENCES backup_runs (id),
  -- De onde o artefato foi lido. §7 exige que o drill saiba consumir o
  -- artefato OFF-SITE, não só o dump local mais recente.
  source text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'offsite')),

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Alimenta o RTO medido (§8).
  duration_ms integer,

  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'passed', 'failed', 'skipped')),
  -- Resultado por probe (§7 "probes mínimos"): catálogo, tabelas críticas,
  -- FKs, contagem coerente de escopo, outbox sem elegíveis, etc. Guarda
  -- BOOLEANOS e CONTAGENS — nunca valores de linha (§7 "sem expor valores").
  probes jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Reconciliação de tombstones em dry-run (§7 passo 9 / §13).
  tombstones_pending integer,
  failure_code text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restore_drills_system_scope_chk
    CHECK (tenant_id = 'system' AND agent_id = 'system')
);

CREATE INDEX IF NOT EXISTS restore_drills_recent_idx
  ON restore_drills (status, started_at DESC);

CREATE INDEX IF NOT EXISTS restore_drills_run_idx
  ON restore_drills (backup_run_id);

-- Spec 18 — Scheduling: Series, Occurrences, Outbox, Operational Engine
-- Operational schema. Supersedes the v1 discovery draft (which only added
-- workflows.chain_id; rolled into this single migration since v1 was not
-- merged to production).

CREATE TABLE IF NOT EXISTS series (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                        TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  version                     INTEGER NOT NULL DEFAULT 1,
  rrule                       TEXT,
  one_shot_at                 TIMESTAMPTZ,
  month_end_policy            TEXT NOT NULL DEFAULT 'skip_invalid_month',
  missed_run_policy           TEXT NOT NULL DEFAULT 'fire_latest_only',
  staleness_threshold_hours   INTEGER NOT NULL DEFAULT 24,
  exclusive_per_destinatario  BOOLEAN NOT NULL DEFAULT FALSE,
  contexto_template           JSONB NOT NULL DEFAULT '{}'::jsonb,
  entidade_id                 UUID,
  owner_pessoa_id             UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at                TIMESTAMPTZ,
  CONSTRAINT series_tipo_check CHECK (
    tipo IN ('one_shot_reminder','recurring_outreach','recurring_payment')
  ),
  CONSTRAINT series_status_check CHECK (
    status IN ('active','paused','cancelled')
  ),
  CONSTRAINT series_month_end_policy_check CHECK (
    month_end_policy IN ('skip_invalid_month','last_day_of_month','nearest_previous','nearest_next')
  ),
  CONSTRAINT series_missed_run_policy_check CHECK (
    missed_run_policy IN ('fire_all','fire_latest_only','skip_all','escalate_to_owner')
  ),
  CONSTRAINT series_schedule_kind_check CHECK (
    (tipo = 'one_shot_reminder' AND one_shot_at IS NOT NULL AND rrule IS NULL)
    OR
    (tipo <> 'one_shot_reminder' AND rrule IS NOT NULL AND one_shot_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_series_active
  ON series (owner_pessoa_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS occurrences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id           UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  scheduled_for       TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  outcome             TEXT,
  claimed_by          TEXT,
  claimed_at          TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  correlation_token   TEXT,
  contexto_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT occurrences_status_check CHECK (
    status IN (
      'pending','claimed','in_progress','awaiting_third_party','awaiting_owner',
      'completed','skipped','failed','aged_out','cancelled'
    )
  ),
  UNIQUE (series_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_due
  ON occurrences (scheduled_for)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS idx_occurrences_series_status
  ON occurrences (series_id, status);

CREATE INDEX IF NOT EXISTS idx_occurrences_correlation
  ON occurrences (correlation_token)
  WHERE correlation_token IS NOT NULL
    AND status IN ('awaiting_third_party','in_progress');

CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id   UUID NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  ordem           INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  result          JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  CONSTRAINT tasks_status_check CHECK (
    status IN ('pending','in_progress','completed','skipped','failed')
  ),
  UNIQUE (occurrence_id, ordem)
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id     UUID REFERENCES occurrences(id) ON DELETE SET NULL,
  task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  claimed_by        TEXT,
  claimed_at        TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  sent_at           TIMESTAMPTZ,
  dedup_key         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_status_check CHECK (
    status IN ('pending','claimed','sent','failed','dead')
  ),
  CONSTRAINT outbox_kind_check CHECK (
    kind IN ('whatsapp_text','whatsapp_pending_question','whatsapp_alert','email_alert')
  )
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbox_messages (next_attempt_at)
  WHERE status IN ('pending','claimed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup
  ON outbox_messages (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Per-occurrence audit linkage.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS occurrence_id UUID REFERENCES occurrences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_occurrence
  ON audit_log (occurrence_id)
  WHERE occurrence_id IS NOT NULL;

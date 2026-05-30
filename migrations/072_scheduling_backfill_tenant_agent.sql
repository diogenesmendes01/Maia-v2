-- =====================================================================
-- Maia — Migration 072 (flip-readiness Batch A, #323; issue #355)
-- Backfill tenant_id / agent_id on the scheduling tables, deriving the
-- REAL tenant/agent down the FK chain rooted at series.owner_pessoa_id.
--
-- Migration 071 set every existing row to 'default'. This migration
-- OVERWRITES that with the owning pessoa's tenant/agent wherever the FK
-- chain can reach a pessoa. Done in FK order so each step reads
-- already-backfilled parents:
--
--   series       ← pessoas       (series.owner_pessoa_id → pessoas.id)
--   occurrences  ← series        (occurrences.series_id  → series.id)
--   tasks        ← occurrences   (tasks.occurrence_id    → occurrences.id)
--   outbox_messages ← occurrences (outbox.occurrence_id  → occurrences.id)
--                  then a SECOND pass via task_id → tasks → occurrence
--                  for rows whose occurrence_id IS NULL.
--
-- outbox_messages.occurrence_id and .task_id are BOTH nullable
-- (ON DELETE SET NULL in 007_scheduling.sql). Rows where BOTH are NULL
-- have no FK to derive from — they keep the 'default' floor set by 071
-- (owner-ratified default: these are legacy / terminal relay rows whose
-- parent occurrence/task was already deleted, so no real tenant remains
-- to recover). The final RAISE NOTICE reports how many such rows remain.
--
-- Idempotent: re-running converges to the same state (every UPDATE is a
-- deterministic join; the WHERE guards skip rows already matching).
--
-- SCHEMA-ONLY / data-only: no query, predicate, or worker is changed.
--
-- NOTE: no BEGIN/COMMIT wrappers — scripts/migrate.ts wraps each
-- forward migration in a transaction.
-- =====================================================================

-- 1) series ← pessoas (the root of the derivation; owner_pessoa_id is
--    NOT NULL, so every series resolves to a pessoa).
UPDATE series s
   SET tenant_id = p.tenant_id,
       agent_id  = p.agent_id
  FROM pessoas p
 WHERE p.id = s.owner_pessoa_id
   AND (s.tenant_id IS DISTINCT FROM p.tenant_id
        OR s.agent_id IS DISTINCT FROM p.agent_id);

-- 2) occurrences ← parent series (series_id is NOT NULL).
UPDATE occurrences o
   SET tenant_id = s.tenant_id,
       agent_id  = s.agent_id
  FROM series s
 WHERE s.id = o.series_id
   AND (o.tenant_id IS DISTINCT FROM s.tenant_id
        OR o.agent_id IS DISTINCT FROM s.agent_id);

-- 3) tasks ← parent occurrence (occurrence_id is NOT NULL).
UPDATE tasks t
   SET tenant_id = o.tenant_id,
       agent_id  = o.agent_id
  FROM occurrences o
 WHERE o.id = t.occurrence_id
   AND (t.tenant_id IS DISTINCT FROM o.tenant_id
        OR t.agent_id IS DISTINCT FROM o.agent_id);

-- 4a) outbox_messages ← occurrence (primary link; occurrence_id nullable).
UPDATE outbox_messages m
   SET tenant_id = o.tenant_id,
       agent_id  = o.agent_id
  FROM occurrences o
 WHERE o.id = m.occurrence_id
   AND (m.tenant_id IS DISTINCT FROM o.tenant_id
        OR m.agent_id IS DISTINCT FROM o.agent_id);

-- 4b) outbox_messages ← task → occurrence (fallback for rows with no
--     direct occurrence link). Only touches rows where occurrence_id is
--     NULL but task_id resolves to a task (and thus an occurrence).
UPDATE outbox_messages m
   SET tenant_id = o.tenant_id,
       agent_id  = o.agent_id
  FROM tasks t
  JOIN occurrences o ON o.id = t.occurrence_id
 WHERE m.occurrence_id IS NULL
   AND t.id = m.task_id
   AND (m.tenant_id IS DISTINCT FROM o.tenant_id
        OR m.agent_id IS DISTINCT FROM o.agent_id);

-- Report the owner-ratified-default residue: outbox rows with NEITHER an
-- occurrence nor a task to derive from. These intentionally stay
-- ('default','default'). Non-fatal — informational only.
DO $$
DECLARE
  orphan_outbox INTEGER;
BEGIN
  SELECT count(*) INTO orphan_outbox
    FROM outbox_messages
   WHERE occurrence_id IS NULL AND task_id IS NULL;
  RAISE NOTICE 'Backfill 072: % outbox_messages row(s) have no occurrence/task FK and keep tenant_id/agent_id = ''default'' (owner-ratified default).', orphan_outbox;
END $$;

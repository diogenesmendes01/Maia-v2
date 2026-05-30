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

-- Report series STILL at the ('default','default') floor after the backfill.
-- series.owner_pessoa_id has NO FK to pessoas(id), so a series whose
-- owner_pessoa_id does not resolve to a pessoa keeps the 071 default and is
-- indistinguishable, by column value alone, from a correctly-defaulted
-- single-tenant row. In a single-tenant deployment this count is legitimately
-- high (everything is default/default); in a MULTI-tenant deployment a
-- non-zero residue signals dangling owner_pessoa_id values worth investigating.
-- Non-fatal — informational only.
DO $$
DECLARE
  default_series INTEGER;
BEGIN
  SELECT count(*) INTO default_series
    FROM series
   WHERE tenant_id = 'default' AND agent_id = 'default';
  RAISE NOTICE 'Backfill 072: % series row(s) still tenant_id/agent_id = ''default'' after backfill (expected = single-tenant rows + any series with an unresolved owner_pessoa_id).', default_series;
END $$;

-- 2) occurrences ← parent series (series_id is NOT NULL).
UPDATE occurrences o
   SET tenant_id = s.tenant_id,
       agent_id  = s.agent_id
  FROM series s
 WHERE s.id = o.series_id
   AND (o.tenant_id IS DISTINCT FROM s.tenant_id
        OR o.agent_id IS DISTINCT FROM s.agent_id);

-- Report occurrences STILL at ('default','default') after the backfill. An
-- occurrence inherits from its parent series, so this is the CASCADE of the
-- series case above: any occurrence still default descends from a series that
-- itself stayed default (single-tenant, or an unresolved owner_pessoa_id).
-- Single-tenant: legitimately high. Multi-tenant: a non-zero residue points
-- back at a dangling parent series. Non-fatal — informational only.
DO $$
DECLARE
  default_occurrences INTEGER;
BEGIN
  SELECT count(*) INTO default_occurrences
    FROM occurrences
   WHERE tenant_id = 'default' AND agent_id = 'default';
  RAISE NOTICE 'Backfill 072: % occurrence row(s) still tenant_id/agent_id = ''default'' after backfill (expected = single-tenant rows + any cascaded from an unresolved parent series).', default_occurrences;
END $$;

-- 3) tasks ← parent occurrence (occurrence_id is NOT NULL).
UPDATE tasks t
   SET tenant_id = o.tenant_id,
       agent_id  = o.agent_id
  FROM occurrences o
 WHERE o.id = t.occurrence_id
   AND (t.tenant_id IS DISTINCT FROM o.tenant_id
        OR t.agent_id IS DISTINCT FROM o.agent_id);

-- Report tasks STILL at ('default','default') after the backfill. A task
-- inherits from its parent occurrence, so this is the tail of the same
-- cascade: any task still default descends from an occurrence (and ultimately
-- a series) that stayed default. Single-tenant: legitimately high.
-- Multi-tenant: a non-zero residue points back at a dangling ancestor series.
-- Non-fatal — informational only.
DO $$
DECLARE
  default_tasks INTEGER;
BEGIN
  SELECT count(*) INTO default_tasks
    FROM tasks
   WHERE tenant_id = 'default' AND agent_id = 'default';
  RAISE NOTICE 'Backfill 072: % task row(s) still tenant_id/agent_id = ''default'' after backfill (expected = single-tenant rows + any cascaded from an unresolved ancestor series).', default_tasks;
END $$;

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

-- Report outbox_messages STILL at ('default','default') after the backfill,
-- and the owner-ratified-default subset within it: rows with NEITHER an
-- occurrence nor a task to derive from (these intentionally stay default —
-- legacy/terminal relay rows whose parent was already deleted). The remainder
-- of the residue (default rows that DO have a resolvable FK) descends from a
-- parent occurrence that itself stayed default. Single-tenant: legitimately
-- high. Multi-tenant: residue beyond the no-FK subset signals a dangling
-- ancestor. Non-fatal — informational only.
DO $$
DECLARE
  default_outbox INTEGER;
  orphan_outbox  INTEGER;
BEGIN
  SELECT count(*) INTO default_outbox
    FROM outbox_messages
   WHERE tenant_id = 'default' AND agent_id = 'default';
  SELECT count(*) INTO orphan_outbox
    FROM outbox_messages
   WHERE occurrence_id IS NULL AND task_id IS NULL;
  RAISE NOTICE 'Backfill 072: % outbox_messages row(s) still tenant_id/agent_id = ''default'' after backfill (of which % have no occurrence/task FK and keep ''default'' by design — owner-ratified default; expected total = single-tenant rows + the no-FK subset + any cascaded from an unresolved parent).', default_outbox, orphan_outbox;
END $$;

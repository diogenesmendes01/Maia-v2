-- Issue #261 — idempotency_keys: promote PRIMARY KEY from (key) to
-- (tenant_id, agent_id, key).
--
-- Background
-- ----------
-- Migration 002 created `idempotency_keys` with `key TEXT PRIMARY KEY`.
-- Migrations 009/012 later added `tenant_id`/`agent_id` columns (NOT NULL,
-- default `'default'`) but the PRIMARY KEY stayed on `key` alone. That meant
-- two tenants computing the same idempotency key (same pessoa_id, entity_id,
-- tool_name, operation_type, payload, bucket) collided in the cache and one
-- tenant could read the other's cached tool output — a direct cross-tenant
-- leak documented in issue #261.
--
-- src/governance/idempotency.ts now folds tenant_id/agent_id into the hash
-- input, so identical hash collisions across tenants are no longer expected.
-- The PRIMARY KEY change makes the storage layer reflect the true identity
-- tuple — defense in depth against any future caller that bypasses
-- computeIdempotencyKey and supplies a raw key.
--
-- Backfill / rows already in the table
-- ------------------------------------
-- After migrations 010 + 012, every existing row has tenant_id='default' and
-- agent_id='default'. Promoting the PK to a composite key keeps every
-- existing row's identity stable: ('default','default', <existing key>) is
-- unique because the prior `key`-alone PK already made `key` unique
-- globally. No data-conflict risk on apply.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in a transaction.

ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey
  PRIMARY KEY (tenant_id, agent_id, key);

-- The lookup path filters by (tenant_id, agent_id, key); the new PK already
-- backs that read with an index on the same three columns in the same
-- order — no extra index needed.

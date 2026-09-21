-- Down da 146. Remove o vínculo canônico do vetor.
--
-- O `DROP` da FK vem antes do `DROP` do unique que a sustenta: a ordem
-- inversa falharia com "other objects depend on it", que foi exatamente o que
-- reprovou o CI da 145.

BEGIN;

DROP INDEX IF EXISTS agent_memories_canonical_idx;

ALTER TABLE agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_canonical_fk;

DROP INDEX IF EXISTS memory_entry_tenant_agent_id_uq;

ALTER TABLE agent_memories
  DROP COLUMN IF EXISTS content_digest,
  DROP COLUMN IF EXISTS memory_entry_id;

COMMIT;

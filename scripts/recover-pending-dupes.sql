-- =====================================================================
-- Maia — Recovery script for migration 004
-- Run BEFORE retrying migration 004 if it fails with duplicate-key.
-- Collapses each conversa's open-pending set to the single most-recent;
-- older opens become 'expirada'.
-- =====================================================================

UPDATE pending_questions p
   SET status = 'expirada'
 WHERE status = 'aberta'
   AND id NOT IN (
     SELECT DISTINCT ON (conversa_id) id
       FROM pending_questions
      WHERE status = 'aberta'
      ORDER BY conversa_id, created_at DESC
   );

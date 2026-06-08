-- issue #323 — delete the legacy `default` tenant/agent registry rows.
--
-- After 082 re-homed every child row to `primary` and 081 seeded `primary`,
-- nothing references `default` anymore (assumption verified for the
-- single-tenant runtime: the only agent under tenant `default` was the
-- `default` agent itself). FK RESTRICT now permits the delete. Delete the agent
-- first, then the tenant (the agent FK-references the tenant).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in tx. If a stray child still
-- references `default`, this migration fails loudly (correct: it means the
-- rehome missed a column — fix the rehome, do not force the delete).

DELETE FROM agents  WHERE id = 'default';
DELETE FROM tenants WHERE id = 'default';

-- Reverse 081: remove the `primary` agent then tenant.
--
-- In the full down chain (run in reverse order: 084_down, 083_down, 082_down,
-- 081_down) this runs LAST, after 082_down has moved all data off `primary`,
-- so no child row references it and the delete is FK-safe.

DELETE FROM agents  WHERE id = 'primary';
DELETE FROM tenants WHERE id = 'primary';

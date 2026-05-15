-- Reverte 014. Remove 'system' tenant/agent SOMENTE se nenhuma FK depende
-- deles. Caso contrário, a migration falha — operador precisa decidir o que
-- fazer com os eventos órfãos (mover pra 'default' ou apagar).

DELETE FROM agents  WHERE id = 'system';
DELETE FROM tenants WHERE id = 'system';

-- P0 follow-up (PR #75 review): seed a 'system' tenant + agent.
--
-- Motivação (Codex / Superpowers finding #3):
--   `auditRepo.write` aplica `applyTenantGuard` incondicionalmente. Callers de
--   sistema (setup/CSRF/pairing/bot-detection/startup) rodam fora de qualquer
--   `runWithTenantContext`, então toda escrita era engolida pelo `try/catch` em
--   `audit()` e só ficava o log `audit.write_failed`.
--
-- Solução:
--   `audit()` agora aplica `runWithTenantContext({ tenant_id:'system',
--   agent_id:'system' }, ...)` quando `tryGetCurrentContext()` retorna null.
--   Os rows resultantes precisam de um FK target — daí o seed abaixo.
--
-- Os IDs 'system' são reservados; nenhum operador humano pode ter acesso a
-- eles. Eles servem como "bucket" pra eventos sem dono natural (auditoria
-- de setup, pareamento, falha de boot, etc.). Eventos do tenant 'default'
-- continuam separados — operacionalmente é a Maia legacy single-tenant.
--
-- ON CONFLICT garante idempotência caso a migration rode em ambiente onde
-- alguém já tenha criado essas rows manualmente.

INSERT INTO tenants (id, nome, status)
  VALUES ('system', 'System (reserved)', 'active')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (id, tenant_id, nome, status)
  VALUES ('system', 'system', 'System (reserved)', 'active')
  ON CONFLICT (id) DO NOTHING;

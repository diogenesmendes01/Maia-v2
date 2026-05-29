-- Rollback de 063: volta para PRIMARY KEY em (key) apenas.
--
-- ATENÇÃO: se houver duas linhas com mesma `key` em tenants diferentes (o
-- estado que a PK composta foi criada justamente para permitir), este DOWN
-- vai falhar com "could not create unique index ... duplicate key value
-- violates unique constraint". É comportamento esperado — o operador
-- precisa decidir qual linha sobrevive antes de reverter (a separação
-- tenant é a feature).
--
-- Atomicidade: `_down.sql` files são rodados manualmente via `psql -f` (ver
-- `scripts/migrate.ts:13-17` — o runner forward EXPLICITAMENTE pula
-- `_down.sql`). Por isso embrulhamos em BEGIN/COMMIT aqui: sem o wrap,
-- DROP CONSTRAINT roda e commit imediatamente; se o subsequente ADD
-- CONSTRAINT falha (ex: duplicatas cross-tenant), a tabela fica SEM PK
-- alguma — janela inaceitável em produção. Com BEGIN/COMMIT, ADD falha →
-- ROLLBACK e a PK composta original é preservada.
--
-- Pre-flight check: se o operador quiser detectar duplicatas ANTES de
-- rodar este down (e abortar com mensagem clara em vez de receber o erro
-- de constraint do Postgres), execute primeiro:
--   SELECT key, COUNT(*) FROM idempotency_keys GROUP BY key HAVING COUNT(*) > 1;
-- Zero linhas retornadas = seguro rodar. Linhas retornadas = downgrade
-- vai falhar; resolver duplicatas primeiro.

BEGIN;

ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey
  PRIMARY KEY (key);

COMMIT;

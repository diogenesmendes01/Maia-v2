-- Rollback de 063: volta para PRIMARY KEY em (key) apenas.
--
-- ATENÇÃO: se houver duas linhas com mesma `key` em tenants diferentes (o
-- estado que a PK composta foi criada justamente para permitir), este DOWN
-- vai falhar com "could not create unique index ... duplicate key value
-- violates unique constraint". É comportamento esperado — o operador
-- precisa decidir qual linha sobrevive antes de reverter (a separação
-- tenant é a feature).
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in a transaction.

ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey
  PRIMARY KEY (key);

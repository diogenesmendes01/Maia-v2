-- Calendar v2 — Migration A: entidades.cidade + entidades.uf.
-- NULL permitido para retrocompatibilidade. Sem cidade/uf, feriados regionais
-- não se aplicam (degrada para "só nacionais"). Maia pode interrogar owner.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE entidades
  ADD COLUMN IF NOT EXISTS cidade TEXT,
  ADD COLUMN IF NOT EXISTS uf     VARCHAR(2);

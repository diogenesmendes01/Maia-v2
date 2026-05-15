-- Backfill é UPDATE de NULL → 'default'. Não dá pra "desfazer" sem perder informação.
-- Em prática: down migration de 009 (DROP COLUMNs) torna esse rollback irrelevante.
-- Este arquivo existe apenas pra cumprir contrato de migrations pareadas.
SELECT 'no-op: backfill irreversível por design' AS note;

-- maia:no-transaction
--
-- ============================================================================
--  ISTO NAO E UMA MIGRATION DO PRODUTO.
--
--  E a migration DELIBERADAMENTE QUEBRADA do drill da issue #705, item 2:
--  "provar que uma migration que FALHA impede o app novo de iniciar".
--
--  Ela mora em `scripts/drill/705-gate-de-migration/fixtures/`, FORA de
--  `migrations/`, e o runner de producao NUNCA a enxerga. Ela so entra em cena
--  dentro do diretorio efemero que `scripts/drill-migration-705.ts` monta em
--  `os.tmpdir()` durante a fase `quebrar`, e some quando esse diretorio some.
--
--  Se voce esta lendo este arquivo DENTRO de `migrations/`, pare: ele vazou.
--  Apague-o e rode `npm test -- tests/unit/ops/drill-705-fixture-isolada.spec.ts`.
-- ============================================================================
--
-- Por que `-- maia:no-transaction`, e nao uma falha transacional:
--
--   `terminalLedgerStatusFor()` (src/migrations/runner.ts:216) classifica a
--   falha pelo modo de transacao. Um arquivo transacional que falha volta
--   atras e e registrado como `failed`; um `no-transaction` que falha no meio
--   deixa efeito duravel e e registrado como `dirty`. O drill quer `dirty`: e
--   o estado que a #516 diz que "nunca e interpretado como sucesso", que
--   bloqueia toda migration seguinte, e do qual so se sai por `repair`
--   auditavel. `failed` provaria menos.
--
-- O efeito parcial e DELIBERADO e e metade do exercicio:
--
--   o primeiro statement cria uma tabela marcadora e commita (autocommit, sem
--   envelope). O ultimo estoura. O ledger fica `dirty` com um efeito real no
--   schema — exatamente a situacao que a secao "Recovering a dirty migration"
--   de `docs/runbooks/migrations.md` descreve. A tabela nao referencia nada,
--   nao e referenciada por nada, nao tem trigger, nao tem `tenant_id` e nao
--   guarda dado de ninguem. Desfaze-la e um `DROP TABLE`.

CREATE TABLE IF NOT EXISTS drill_705_marcador (
  id        text PRIMARY KEY,
  criado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO drill_705_marcador (id)
VALUES ('efeito-parcial-do-drill-705')
ON CONFLICT (id) DO NOTHING;

-- A falha.
--
-- O NOME da constraint e a mensagem: o Postgres reporta
--   ERROR:  check constraint "drill705_falha_deliberada" of relation
--           "drill_705_marcador" is violated by some row
-- com SQLSTATE 23514. Quem ler o log do drill ve POR QUE aquilo falhou sem
-- precisar deste arquivo aberto ao lado — e um `SELECT 1/0` (22012) nao diria
-- nada. A linha que a viola foi inserida pelo statement anterior, entao a
-- falha e deterministica e nao depende de nenhum dado do ambiente.
--
-- POR QUE NAO UM BLOCO `DO $$ … $$` COM `RAISE EXCEPTION`, que seria o obvio:
--   o runner divide migrations `-- maia:no-transaction` com
--   `splitNoTxStatements()` (src/migrations/discover.ts:328), que e um
--   `split(';')` ingenuo — ele NAO entende dollar-quoting. Um bloco `DO` com
--   `;` dentro do corpo e cortado ao meio e falha com 42601 (syntax_error),
--   nao com o erro que o autor escreveu. Verificado na bancada: a primeira
--   versao desta fixture usava `DO $drill705$ … $drill705$` e o ledger
--   registrou `error_class = 42601`. A regra para esta fixture, portanto:
--   NENHUM `;` dentro de um statement.
--
-- Nada fica para tras: a constraint nao chega a existir. O unico residuo e a
-- tabela marcadora do statement anterior, e desfaze-la e o `_down` irmao.

ALTER TABLE drill_705_marcador
  ADD CONSTRAINT drill705_falha_deliberada CHECK (id = 'esta-linha-nunca-bate');

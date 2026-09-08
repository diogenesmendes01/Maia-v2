# `scripts/drill/705-gate-de-migration/`

Fixtures do drill de migration em staging (issue **#705**, item 2).

## Por que isto não está em `migrations/`

O item 2 da #705 exige provar que **uma migration que falha impede o app novo de
iniciar**. Provar isso exige uma migration quebrada de verdade — não um mock,
não um `dirty` escrito à mão no ledger.

Um `.sql` quebrado dentro de `migrations/` seria um desastre, e não por
descuido: por construção. O runner varre aquele diretório
(`discoverMigrations()`), o build empacota o que está lá, o CI valida contra o
mesmo conjunto, e o job one-shot do deploy aplica exatamente aquele artefato. Um
arquivo quebrado ali entraria no ledger de todo mundo — incluindo o de produção,
um dia, quando alguém deployasse a imagem que o contém.

Então:

- as fixtures moram **aqui**, fora do diretório que o runner varre;
- `scripts/drill-migration-705.ts`, na fase `quebrar`, monta um diretório
  **efêmero** em `os.tmpdir()` com cópias dos `.sql` reais mais estas duas, e
  aponta o runner para ele (`RunnerDeps.migrationsDir` é parâmetro —
  `src/migrations/runner.ts:151`);
- `migrations/` é **lido**, nunca escrito;
- `assertFixtureNaoVazou()` roda antes de qualquer fase e aborta com exit 4 se
  algo do drill aparecer em `migrations/`, inclusive renomeado;
- `tests/unit/ops/drill-705-fixture-isolada.spec.ts` prova as três coisas sem
  precisar de banco.

## Se você encontrou uma cópia destes arquivos em `migrations/`

Ela vazou. Remova-a e rode:

```bash
npm test -- tests/unit/ops/drill-705-fixture-isolada.spec.ts
```

## Os arquivos

| Arquivo | O que é |
|---|---|
| `fixtures/900_drill705_falha_deliberada.sql` | A migration quebrada. `-- maia:no-transaction` de propósito, para que a falha vire `dirty` (e não `failed`). Cria uma tabela marcadora, commita, e então falha numa violação de CHECK (SQLSTATE 23514) cujo nome de constraint é `drill705_falha_deliberada`. |
| `fixtures/900_drill705_falha_deliberada_down.sql` | A `_down` irmã. Existe porque o runner recusa um artefato com forward sem down, e porque é o desfazer do efeito parcial. Nenhum runner a executa automaticamente. |

O prefixo `900` ordena depois de qualquer migration real (o head hoje é `138_`),
então no diretório efêmero ela é sempre a última a rodar: nenhuma migration real
fica atrás dela.

## Regra ao editar a fixture quebrada

**Nenhum `;` dentro de um statement.** O runner divide migrations
`-- maia:no-transaction` com `splitNoTxStatements()`
(`src/migrations/discover.ts:328`), que é um `split(';')` ingênuo e não entende
dollar-quoting. A primeira versão desta fixture usava
`DO $drill705$ … RAISE EXCEPTION … $drill705$;` e o ledger registrou
`error_class = 42601` (syntax_error) em vez do erro escrito — o bloco foi
cortado ao meio. A falha precisa ser a que o autor escolheu, senão a evidência
do item 2 é sobre outra coisa.

## Documentos

- [`docs/runbooks/drill-705-gabarito-de-coleta.md`](../../../docs/runbooks/drill-705-gabarito-de-coleta.md)
- [`docs/runbooks/drill-705-checklist-de-aceite.md`](../../../docs/runbooks/drill-705-checklist-de-aceite.md)
- [`docs/runbooks/migrations.md`](../../../docs/runbooks/migrations.md) — dirty, repair, rollback

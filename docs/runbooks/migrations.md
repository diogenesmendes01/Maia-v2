# Migrations runbook

This runbook explains how to apply and (manually) revert SQL migrations
in `migrations/`. Each migration `NNN_<name>.sql` ships with a sibling
`NNN_<name>_down.sql` for rollback. Forward migrations are applied by the
runner; rollbacks stay manual by design — nothing in the runner can
execute a `_down.sql`.

> **Issue #516 changed how migrations are applied.** The logic moved out
> of `scripts/migrate.ts` into `src/migrations/` (see
> [`docs/architecture/modules/migrations.md`](../architecture/modules/migrations.md)),
> and the runner now: serialises concurrent migrators with a global
> advisory lock; records a **checksum** per applied migration and refuses
> to proceed when a merged file changed; represents a partially-applied
> no-transaction migration as **dirty** and blocks on it; and exposes a
> read-only **schema readiness** verdict. `scripts/migrate.ts` is now a
> CLI with subcommands — `up` (the default, what `npm run db:migrate`
> runs), `plan`, `status` and `repair`.

## File layout

```
migrations/
  001_initial.sql                              # up
  001_initial_down.sql                         # down (manual)
  002_specs_v1.sql
  002_specs_v1_down.sql
  003_review_fixes.sql
  003_review_fixes_down.sql
  004_pending_one_active_per_conversa.sql
  004_pending_one_active_per_conversa_down.sql
  005_audit_mensagem_idx.sql
  005_audit_mensagem_idx_down.sql
```

The runner (`src/migrations/`, driven by `scripts/migrate.ts`) discovers
and applies every `NNN_*.sql` that does not end in `_down.sql`, in
**lexical filename order** (plain code-unit comparison — not a numeric
parse, and not `localeCompare`, which would be locale-dependent). Files
containing the marker `-- maia:no-transaction` on its own line (e.g. 005)
are applied outside a `BEGIN/COMMIT` envelope so they can use
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`.

A file may also declare `-- maia:statement-timeout=<ms>` to raise the
per-statement ceiling for a long backfill. The override lives in the
migration, where a reviewer sees it — not in an operator's shell.

Note: this is **not** Drizzle. `drizzle-orm` is used only as a query
builder; the migration runner is hand-rolled, and records applied
migrations by **full filename** in `schema_migrations` — which since #516
also carries the checksum, lifecycle status, timings and repair trail.

### Duplicate migration numbers (and why you must NOT rename to "fix" them)

Several numbers are shared by more than one forward migration today
(007, 014, 015, 018, 020, 023, 025, 026, 027, 031, 062, 063 — see issue
#308). They all merged and are applied in real environments. This is
**benign** here, because:

- The runner tracks applied migrations by **filename**, not by number,
  so two files sharing a number are two independent ledger rows.
- Lexical sort is deterministic and locale-independent for ASCII
  filenames, so files sharing a number always apply in the same order on
  every platform, and the next number (`064_*`) always sorts after every
  `063_*` (third char `4` > `3`) — there is no ordering ambiguity.
- The colliding migrations to date touch disjoint objects, so their
  relative order is immaterial anyway.

**Do NOT rename an already-merged/applied migration to renumber it.**
Because the ledger key is the filename, a rename makes the runner treat
the file as un-applied (it re-runs) and orphans the old `schema_migrations`
row — corrupting the applied history for zero benefit. The accepted set
is grandfathered in
`tests/unit/scripts/migration-number-uniqueness.spec.ts`, which **fails
CI if a NEW duplicate number is introduced** (the actual fix: don't add
new collisions — see "Adding a new migration" below).

## Inspecting before applying (read-only)

```bash
tsx scripts/migrate.ts status   # full ledger vs packaged artifact
tsx scripts/migrate.ts plan     # just: what would `up` apply?
```

Both are **read-only**: no DDL, no ledger writes, no advisory lock. Safe
against production, and safe to run while a migrator is working. They
exit non-zero only when something is actually broken (dirty row, checksum
mismatch, a migration the build does not ship, or no ledger at all) —
pending work alone is not an error, that is what `up` is for.

## Applying migrations (up)

```bash
npm run db:migrate              # = tsx scripts/migrate.ts up
```

Applies every pending forward migration in order, under a global advisory
lock, recording a checksum per migration. Idempotent: an already-applied
migration is skipped.

Before applying anything it **refuses** (exit 1, nothing executed) when:

- a migration is `dirty` — a no-transaction run failed midway;
- a `running` row exists while no migrator holds the lock — a crashed
  run; it is promoted to `dirty` and then blocks;
- an applied migration's file no longer matches its recorded checksum;
- an applied migration has no recorded checksum and no packaged file to
  adopt one from;
- the database ran a migration this build does not ship;
- a forward migration on disk has no `_down.sql` sibling;
- a migration that manages its own transaction is **not** one complete
  `BEGIN; … COMMIT;` envelope — a statement outside it, two envelopes,
  or an envelope that is never closed. See
  [Fixing `unverifiable_transaction_envelope`](#fixing-unverifiable_transaction_envelope).

A second migrator started concurrently **waits** for the first (30s by
default) and then exits cleanly with `lock_unavailable` — it never
applies anything unguarded.

### Os quatro tetos, e onde mexer neles

Todos vêm do contrato de configuração (#515) e só o serviço `migrator` os
recebe. Os defaults são os valores que antes eram constantes de módulo, então
não mexer em nada preserva o comportamento anterior.

| Variável | Default | O que limita |
|---|---:|---|
| `MIGRATION_LOCK_WAIT_MS` | `30000` | Quanto um segundo migrator espera pelo advisory lock antes de sair com `lock_unavailable`. |
| `MIGRATION_LOCK_POLL_MS` | `500` | Intervalo entre tentativas de `pg_try_advisory_lock` durante essa espera. |
| `MIGRATION_LOCK_TIMEOUT_MS` | `10000` | `SET lock_timeout` da sessão que aplica cada migration. `0` desliga (fail-OPEN). |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | `0` (sem teto) | `SET statement_timeout` da mesma sessão. Uma migration específica sobe o próprio teto com `-- maia:statement-timeout=<ms>`. |

Quando o `up` falha com erro de lock numa tabela quente, o teto que você quer
é `MIGRATION_LOCK_TIMEOUT_MS` — e a resposta certa quase nunca é subi-lo:
falhar em 10s é recuperável, segurar `ACCESS EXCLUSIVE` por minutos derruba
toda query que encostar na tabela. `MIGRATION_STATEMENT_TIMEOUT_MS` continua
sem teto por default de propósito: matar uma migration `-- maia:no-transaction`
no meio **fabrica** o dirty state que este runbook existe para evitar.

### No deploy, quem roda isto é o Compose (issue #516)

`docker-compose.yml` e `compose.prod.yml` têm um job one-shot `migrate`
entre "postgres healthy" e a subida de `app`/`admin-ui`, que dependem
dele com `service_completed_successfully`. Ou seja: **não há mais passo
manual de migration no deploy** — o `docker compose up` aplica e só então
sobe a aplicação.

```
postgres healthy → migrate (`npm run db:migrate`, exit 0) → app + admin-ui
```

Consequência operacional que importa: **um blocker segura o deploy
inteiro**. Se o `up` falhar com `service "migrate" didn't complete
successfully`, `app` e `admin-ui` ficam em `created` e nunca sobem. Isso
é intencional (fail-closed): uma instância de pé contra schema
incompatível responderia 503 no `/readyz` indefinidamente, o que é pior
de diagnosticar do que um deploy que não subiu.

```bash
C="docker compose --env-file .env.infra -f compose.prod.yml"   # prod
$C logs migrate            # eventos JSON: migration.applied / failed / dirty / blocked
$C run --rm migrate npm run db:migrate -- status   # read-only, sem lock
```

Depois de diagnosticar (e, se for o caso, `repair` — abaixo), repita o
`up`: o job roda de novo, e `migrate up` é idempotente.

O job roda **apenas** forward. Ele não executa nenhum `_down.sql`, não
substitui o backup exigido antes de uma migration destrutiva, e não muda
nada do procedimento manual descrito no resto deste runbook.

### Checksums on migrations that predate them

The first `up` after this change adopts the packaged checksum for every
already-applied migration that has none, marking it
`checksum_source = 'backfilled'`. No historical file is renamed, edited
or re-applied. Adoption trusts the artifact present at that moment, so do
it in staging first and compare `tsx scripts/migrate.ts status` output
between staging and production before rolling forward. After adoption,
any divergence is a hard blocker.

### Fixing `unverifiable_transaction_envelope`

This blocker is about the **repository**, not the database: nothing was
applied and nothing needs repairing. The migration wraps itself in
`BEGIN; … COMMIT;` but does not keep all of its SQL inside that one
envelope, so a failure in the part left outside would leave a durably
committed half — and the runner would have no way to tell that apart
from a clean rollback.

The blocker names the exact defect (`statement_after_commit`,
`multiple_envelopes`, `unterminated_envelope`, `statement_before_begin`,
`unbalanced_control`, `self_rollback`). Two ways to fix the file, both
in the PR that introduced it — never by editing a migration that has
already been applied anywhere:

1. Move every statement inside the single `BEGIN; … COMMIT;`; or
2. **delete** the `BEGIN;`/`COMMIT;` lines and let the runner own the
   transaction. This is the better default: the runner then commits the
   ledger row in the *same* transaction as the schema change, which is
   the only mode in this system where "applied" and "recorded" are
   genuinely atomic.

A migration that truly cannot run inside a transaction (`CREATE INDEX
CONCURRENTLY`) takes neither route — it declares
`-- maia:no-transaction` and omits the transaction block entirely.

## Recovering a dirty migration

`dirty` means a migration failed partway with no rollback to fall back
on — normally a `-- maia:no-transaction` file, so some statements may
have taken effect and others may not. It is never auto-retried and never
treated as success. (A self-transactional migration whose envelope could
not be proven complete is classified the same way, but in practice it is
refused as an artifact problem before it can run.)

1. **Read the ledger row** — it names the migration and the error class:

   ```bash
   tsx scripts/migrate.ts status
   ```

2. **Inspect the schema by hand** and decide which is true:
   - the migration's effects ARE fully in place, or
   - they are not, and you have undone the partial ones.

   For a partially-created `CREATE INDEX CONCURRENTLY`, Postgres leaves
   an INVALID index behind; drop it before choosing option (b):

   ```sql
   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE NOT i.indisvalid;
   ```

3. **Record the decision, with a reason that is persisted on the row:**

   ```bash
   # (a) verified fully applied
   tsx scripts/migrate.ts repair --id 066_x.sql --as applied \
     --reason "conferido: os 8 indices existem e sao validos"

   # (b) partial effects undone; let it run again from scratch
   tsx scripts/migrate.ts repair --id 066_x.sql --as pending \
     --reason "indice invalido dropado; reaplicar"
   ```

`repair` takes the same global lock, refuses an empty reason, and refuses
to touch a healthy `applied` row. **Never "clear the flag" without
verifying the schema** — the reason field exists precisely so the next
operator can tell what was checked.

### Dirty on `115_agent_turns_pending_race_lost.sql` (troca de CHECK em fases)

A 115 é `-- maia:no-transaction` por um motivo diferente do usual: ela
não roda `CONCURRENTLY`, ela precisa que a varredura do
`VALIDATE CONSTRAINT` aconteça numa transação **separada** do
`DROP`/`ADD`, senão a validação inteira corre sob o ACCESS EXCLUSIVE
desses e bloqueia escrita em `agent_turns` (tabela quente). Por isso ela
tem cinco statements e quatro estados intermediários possíveis. Descubra
em qual você está:

```sql
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = 'agent_turns'::regclass AND conname LIKE '%status_outcome%';
```

| O que você vê | Onde a 115 parou | O que fazer |
|---|---|---|
| só `agent_turns_status_outcome_chk`, `convalidated = t`, sem `pending_race_lost` na definição | antes da fase 1 | `repair --as pending` e reaplicar |
| `…_chk` + `…_chk_v115` com `convalidated = f` | depois da fase 1 | `repair --as pending` e reaplicar |
| `…_chk` + `…_chk_v115`, ambas `convalidated = t` | depois da fase 2 | `repair --as pending` e reaplicar |
| **só** `…_chk_v115`, `convalidated = t` | entre os dois statements da fase 3 | **não reaplique o arquivo** — ver abaixo |

Nos três primeiros a tabela ainda tem a constraint canônica de pé, então
reaplicar o arquivo inteiro é seguro: o `DROP … IF EXISTS` da fase 1 só
derruba o nome temporário. No quarto a canônica já caiu, e reaplicar
deixaria a tabela sem NENHUMA constraint entre dois statements. Ali a
remediação é um statement só, e então marcar como aplicada:

```sql
ALTER TABLE agent_turns
  RENAME CONSTRAINT agent_turns_status_outcome_chk_v115
                 TO agent_turns_status_outcome_chk;
```

```bash
tsx scripts/migrate.ts repair --id 115_agent_turns_pending_race_lost.sql --as applied \
  --reason "crash entre os dois statements da fase 3; rename manual conferido"
```

Rodar o `_down` da 115 também sai desse estado (ele derruba o nome
temporário junto), mas isso é reverter, não reparar — e ele **recusa** se
já houver turno com `outcome = 'pending_race_lost'`.

### Dirty on `116_mensagens_tipo_evento.sql` (troca de CHECK em fases)

Mesmo desenho da 115, em `mensagens` — a tabela de entrada/saída, onde
segurar ACCESS EXCLUSIVE pela varredura bloqueia inbound e outbound do
produto inteiro. Cinco statements, quatro estados intermediários:

```sql
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = 'mensagens'::regclass AND conname LIKE '%tipo_check%';
```

| O que você vê | Onde a 116 parou | O que fazer |
|---|---|---|
| só `mensagens_tipo_check`, `convalidated = t`, sem `evento` na definição | antes da fase 1 | `repair --as pending` e reaplicar |
| `…_tipo_check` + `…_tipo_check_v116` com `convalidated = f` | depois da fase 1 | `repair --as pending` e reaplicar |
| `…_tipo_check` + `…_tipo_check_v116`, ambas `convalidated = t` | depois da fase 2 | `repair --as pending` e reaplicar |
| **só** `…_tipo_check_v116`, `convalidated = t` | entre os dois statements da fase 3 | **não reaplique o arquivo** — ver abaixo |

Nos três primeiros a canônica ainda está de pé e reaplicar o arquivo é
seguro. No quarto ela já caiu, e reaplicar deixaria `mensagens` sem
NENHUMA constraint de `tipo` entre dois statements. Ali a remediação é um
statement só, e então marcar como aplicada:

```sql
ALTER TABLE mensagens
  RENAME CONSTRAINT mensagens_tipo_check_v116 TO mensagens_tipo_check;
```

```bash
tsx scripts/migrate.ts repair --id 116_mensagens_tipo_evento.sql --as applied \
  --reason "crash entre os dois statements da fase 3; rename manual conferido"
```

O `_down` da 116 também sai desse estado (derruba o nome temporário
junto), mas isso é reverter, não reparar. Ele apaga **só** o formato
completo que `flushUnconfirmedToolSummaries()` produz (`direcao='out'`,
`conteudo=''`, `midia_url IS NULL`, `metadata.event_only=true`,
`metadata.in_reply_to` presente, `metadata.flush_reason` no vocabulário de
`ReActExitReason`, `ferramentas_chamadas` não vazio) e **recusa**, com o
`ADD CONSTRAINT` abortando em 23514, se sobrar qualquer outra row
`tipo='evento'` — a recusa é atômica (`BEGIN`/`COMMIT`), então nem as rows
nem a constraint se movem. Para ver o que sobrou antes de decidir:

```sql
SELECT id, direcao, conteudo IS NULL AS conteudo_null,
       metadata->>'event_only'   AS event_only,
       metadata->>'flush_reason' AS flush_reason,
       jsonb_array_length(ferramentas_chamadas) AS n_tools
  FROM mensagens WHERE tipo = 'evento';
```

### When `repair --as applied` refuses

`--as applied` records the **packaged** checksum for the id. If this build
does not ship that migration there is nothing to record, so the command
refuses instead of flipping the row and reporting success:

```
$ tsx scripts/migrate.ts repair --id 099_ghost.sql --as applied --reason "..."
repair refused: repair --as applied refused for "099_ghost.sql": it would report
success without repairing readiness.
  - 099_ghost.sql [repair/artifact_missing]: this build does not package
    migrations/099_ghost.sql, so there is no checksum to record and the row
    would stay missing_file.
      → Marking it applied here writes checksum_source='backfilled' with nothing
        verified, and the next `migrate status`/`migrate up` blocks again on
        missing_file — repaired in name only.
      → Run the repair from a build that ships 099_ghost.sql, so the packaged
        checksum can be adopted.
      → Or, if 099_ghost.sql must not stand in this schema: undo its effects by
        hand, then `migrate repair --id 099_ghost.sql --as pending --reason
        "<why>"` — that DELETES the ledger row so the migration is applied again
        from scratch, instead of certifying a schema nobody can verify.
```

Exit code **1**, nothing written: no lock is taken, no DDL is issued, and
the ledger row is left exactly as it was (`status`, `checksum_sha256`,
`checksum_source`, `repaired_at`, `repair_reason` all unchanged). Before
this refusal existed the command answered `repaired 099_ghost.sql ->
applied` and exited 0, and then the very next `status` blocked again on
the same id — the worst possible answer from the tool you reach for
during an incident.

You will see this in exactly two situations, and they have different fixes:

| Situation | Fix |
|---|---|
| You are on an **older image** than the database (rollback, reverted branch, canary running behind) | Repair from the build that ships the migration. The running image genuinely cannot verify a file it does not have. |
| The migration **should not be in this schema at all** (manual rollback, abandoned branch) | Undo its effects, then `--as pending` — it deletes the row, so nothing is certified. |

## Checksum mismatch

`up`, `status` and readiness all fail when an applied migration's file
changed. That is the append-only rule being enforced (AGENTS.md §4 rule
6), not a glitch. The fix is almost always to **revert the edit** and put
the change in a NEW migration. The only legitimate exception — the file
was corrupted in transit, not edited — is handled by verifying the schema
by hand and then `repair --as applied --reason "..."`, which re-adopts
the packaged checksum and leaves an audit trail.

## Reverting a migration (down) — manual procedure

Down migrations are not yet wired into `scripts/migrate.ts`. To roll
back, apply the `_down.sql` file directly with `psql`. Always roll back
in reverse order — never skip an intermediate step.

1. **Back up the database first.** Down migrations are destructive: they
   drop tables, columns and indexes. For production, take a logical
   dump (`pg_dump`) before running anything.

   ```bash
   pg_dump "$DATABASE_URL" --no-owner --no-acl -F c -f /tmp/maia-pre-rollback.dump
   ```

2. **Identify the migration to revert.** Down only one migration at a
   time, starting from the most recent.

3. **Apply the corresponding `_down.sql`:**

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/005_audit_mensagem_idx_down.sql
   ```

   Notes:
   - `ON_ERROR_STOP=1` aborts on the first error.
   - Files NOT marked `maia:no-transaction` already wrap their work in
     `BEGIN/COMMIT`. Do not add extra transaction wrappers around them.
   - Files marked `-- maia:no-transaction` (e.g. 005) MUST run outside
     a transaction block. `psql -f` honors that automatically — do not
     wrap them with `psql -1` or a manual `BEGIN`.

4. **Mark the migration as un-applied** so the runner will re-apply it:

   ```bash
   tsx scripts/migrate.ts repair --id NNN_name.sql --as pending \
     --reason "rollback manual via NNN_name_down.sql em <data>"
   ```

   This deletes the ledger row and records why. (Deleting the row with
   raw SQL also works, but leaves no trail — prefer `repair`.) The
   bookkeeping table is `schema_migrations`; since #516 it also carries
   the checksum, status and repair columns described in
   [`docs/architecture/modules/migrations.md`](../architecture/modules/migrations.md).

5. **Verify the rollback** with a smoke query (table missing, column
   gone, index dropped) before rerunning the application.

## Warnings

- **Down migrations are destructive.** Dropping a table or column
  permanently removes its data. The `_down.sql` files use
  `DROP ... IF EXISTS` for idempotency, but they cannot recover lost
  rows.
- **Always back up production** before running a down migration.
- **`DROP EXTENSION` lines** (in `001_initial_down.sql` and
  `002_specs_v1_down.sql`) only succeed if no other schema in the
  database depends on those extensions. Comment them out if you share
  the database with other apps.
- **Reverting 002 widens `pessoas.status`.** It moves rows in the
  `'quarentena'` state to `'inativa'` so the old CHECK constraint can
  be re-applied. If you have specific routing for quarantined people,
  capture them first.
- **Reverting 004 drops `pending_questions.metadata`.** This discards
  audit metadata stamped by the pre-LLM gate (cancel_reason, lost_race,
  etc.). Export it first if it matters.

## Adding a new migration

When you write a forward migration, write its down file at the same
time. The two are reviewed together.

1. Pick the next number: `NNN = max(existing) + 1`. It MUST be unused by
   any existing forward migration — the
   `migration-number-uniqueness.spec.ts` guard fails CI on a new
   duplicate. (Pre-merge-wave collisions are grandfathered there; do not
   add to them.) If you need to slot a migration between two already-used
   numbers, append a lowercase letter to sequence it (`038b`, `038c`) —
   that token is distinct and sorts after the bare number.
2. Create `migrations/NNN_<short_name>.sql` with the forward changes.
   Prefer **no transaction control at all** in the file: the runner then
   wraps the whole migration and its ledger row in one transaction,
   which is the only genuinely atomic mode. If you do write your own
   `BEGIN; … COMMIT;`, every executable statement must sit inside that
   single envelope — `migrate up` refuses the file otherwise
   ([`unverifiable_transaction_envelope`](#fixing-unverifiable_transaction_envelope)).
   A migration that cannot run in a transaction declares
   `-- maia:no-transaction` and omits the block. So does one that **must
   not** run in a single transaction: swapping a CHECK/FK on a hot table
   with `ADD … NOT VALID` + `VALIDATE CONSTRAINT` only avoids a long
   ACCESS EXCLUSIVE if the validation commits separately from the
   `DROP`/`ADD` — inside one transaction the strong lock is held across
   the whole scan and the pair buys nothing. Such a file owes the reader
   its crash matrix in the header (see
   `115_agent_turns_pending_race_lost.sql` and
   [the recovery section](#dirty-on-115_agent_turns_pending_race_lostsql-troca-de-check-em-fases)).
3. Create `migrations/NNN_<short_name>_down.sql` that reverses them
   coherently:
   - Header:
     ```sql
     -- Down migration for NNN_<short_name>.sql
     -- WARNING: destructive — review before applying. Run in transaction.
     ```
   - Wrap the body in `BEGIN; ... COMMIT;` unless it uses
     `CREATE/DROP INDEX CONCURRENTLY`, in which case prepend
     `-- maia:no-transaction` and omit the transaction block.
   - Use `DROP ... IF EXISTS` and `ALTER TABLE ... DROP COLUMN IF EXISTS`
     for idempotency.
   - Drop objects in reverse FK order (children before parents).
4. Test the pair locally: apply up, apply down, then apply up again.
5. Open a PR with both files. Reviewer checks that the down truly
   reverses the up.

## Deploy ordering (expand/contract)

The runner decides schema compatibility; the operator does not. A build
declares the range it supports (`min_supported_migration` /
`max_supported_migration` — see the module doc) and
`getSchemaReadiness()` blocks when the database is outside it.

Two rules follow, and they are the operator's responsibility:

- **A destructive migration must not ship in the same release that
  removes compatibility with the old schema.** Expand in release N (add
  the new column, keep the old one), contract in release N+1 (drop the
  old one) — otherwise a rollback of the application has no schema to
  roll back to.
- **Reverting a deploy never runs a down migration.** Rollback of code is
  not rollback of schema. If a domain migration must actually be undone,
  take a backup first and follow the manual procedure above.

## Métricas do schema (Prometheus)

O veredito canônico (`getSchemaReadiness()`) é publicado como série no
`/metrics` do runtime — `src/observability/migration-collector.ts`, fiado
no boot por `registerRuntimeObservability()`. As quatro famílias são
lidas **no scrape**, do mesmo adaptador cacheado que o `/readyz` consome,
então a métrica e o gate não podem divergir:

| Série | O que é |
|---|---|
| `maia_schema_migration_head{kind="expected"}` | Posição (1-based) do head desta build na lista ordenada de migrations conhecidas. |
| `maia_schema_migration_head{kind="applied"}` | Idem para o head aplicado no banco. `0` = banco virgem. |
| `maia_schema_migrations_pending` | Migrations que faltam aplicar (inclui as `failed`, retentáveis). |
| `maia_schema_migrations_dirty` | Migrations em `dirty`. `> 0` é intervenção humana pendente. |
| `maia_schema_migration_last_duration_ms` | `execution_ms` da migration aplicada mais recentemente pelo relógio. |

Duas leituras que valem escrever no alerta:

- **`expected - applied`** é quantas migrations o banco está atrás, sem o
  alerta precisar conhecer o head da release.
- **`NaN` não é `0`.** `0` pendente e `0` dirty são a leitura saudável, então
  uma leitura que falha **não pode** produzir 0: todas as séries viram `NaN`
  quando o veredito não pôde ser lido (banco fora do ar, ledger ilegível,
  estado `unknown`). Alerta escrito sobre `> 0` continua correto; alerta que
  precisa distinguir "verificado saudável" de "não olhei" tem de testar
  `absent()`/`NaN` explicitamente.

Posição ordinal, e não o número do arquivo, porque o número **não é único**
neste repositório (issue #308 — doze números compartilhados), então `063` não
identifica um head.

**O tempo esperando o lock não é uma série, de propósito.** Ele é conhecido só
dentro do processo que migrou (`MigrationRunResult.lock_waited_ms`), e esse
processo é o job one-shot `migrate`, que sai e morre — ninguém o raspa. Um
gauge publicado por ele congelaria sem medição nenhuma, que é pior que
ausência porque parece um sinal. O valor continua nos eventos estruturados
`migration.lock_wait` / `migration.lock_acquired` que a CLI imprime (`docker
compose logs migrate`), e a consequência de alguém segurar o lock demais
aparece em `maia_schema_migrations_pending` que não cai.

## Future work (issue #516 remainder)

O escopo da #516 foi reduzido formalmente pelo dono em 2026-08-15: o
`maia doctor` migrou para a #517 e o material de Coolify/K8s para a #565.
O que sobra está abaixo.

### Entregue (não refazer)

- `/readyz` consome `getSchemaReadiness()`. O componente `schema` passa por
  `src/runtime/lifecycle/schema-readiness.ts`, então checksum divergente,
  linha `dirty` ou `running` órfã, arquivo de migration que esta build não
  empacota, head incompatível e banco ilegível respondem **503** cada um.
  `READINESS_SCHEMA_CHECK=false` é recusado no boot no profile `production`.
  Detalhe operacional (inclusive o cache de 10s do veredito) em
  [`operational.md`](operational.md) §8.1.
- Job one-shot `migrate` no Compose (PR #563): `docker-compose.yml:125` e
  `compose.prod.yml:168`, com `app` e `admin-ui` dependendo dele por
  `service_completed_successfully`. Ver
  [§ No deploy, quem roda isto é o Compose](#no-deploy-quem-roda-isto-é-o-compose-issue-516).
- `maia doctor` consumindo o veredito (PR #598): o check
  `postgres.schema_readiness` (`src/ops/doctor/checks/postgres.ts`) chama
  `getSchemaReadiness()` pelo seam read-only de `src/ops/doctor/schema.ts` —
  `BEGIN READ ONLY`, `SET LOCAL statement_timeout` e o `AbortSignal` do check.
  O doctor **não** re-deriva estado de schema; ele pergunta.
- Tetos de lock/statement no contrato de configuração (#515):
  `MIGRATION_LOCK_WAIT_MS`, `MIGRATION_LOCK_POLL_MS`,
  `MIGRATION_LOCK_TIMEOUT_MS` e `MIGRATION_STATEMENT_TIMEOUT_MS`, só no
  serviço `migrator`, com os defaults iguais aos valores que eram constantes
  de módulo (30000 / 500 / 10000 / sem teto). `src/migrations/` continua sem
  ler `process.env`: quem injeta é `scripts/migrate.ts`, via
  `migrationRunOptions()`.
- Métricas de migration no `/metrics` — ver a seção acima.

### Aberto

- **Drill em staging.** Nada aqui foi exercitado contra um banco de staging
  real: subir uma réplica atrás do head, ver o `/readyz` recusar, rodar o job,
  ver a rotação voltar. Depende do ambiente do dono, não de código.
- **Decisão de política do passo de boot — do dono, não do agente.**
  `src/index.ts` (lifecycle step `schema`) ainda usa `checkSchemaVersion()`,
  que compara só o id mais novo do ledger com o `.sql` mais novo em disco. O
  veredito canônico é o de `src/migrations/status.ts`, exposto por
  `getSchemaReadiness()`, e ele vê o que o outro não vê: checksum divergente,
  `dirty`, `running` órfã, arquivo ausente, head incompatível.

  Unificar os dois **não é uma limpeza, é uma troca de postura**, e os dois
  lados são defensáveis:

  - *Manter como está* — uma condição de schema derruba a readiness e o
    processo fica de pé respondendo 503. A instância é diagnosticável: dá para
    entrar nela, rodar `migrate status`, ler o log. O custo é que uma
    instância nunca-pronta pode ficar assim indefinidamente sem que ninguém
    olhe, se o alerta de readiness não estiver ligado.
  - *Unificar* — a mesma condição vira falha de boot e, sob um supervisor que
    reinicia, **crash loop**. O sinal é impossível de ignorar, e nenhuma
    instância meio-viva entra na rotação. O custo é que o container que você
    precisa inspecionar é justamente o que não fica de pé, e o loop de
    reinício apaga o rastro.

  A escolha depende de quem opera (supervisor, política de alerta, se há
  acesso ao container). Fica registrada como decisão do dono na #516.
- Um flag `--down=NNN` continua deliberadamente não construído: rollback de
  migration é manual e revisado.

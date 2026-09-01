# import

**Path:** `src/import/`

**Purpose** — OFX and CSV file ingestion for bank statements. Parsers normalize statement formats into typed transactions; the reconciler matches imported transactions against existing rows to detect duplicates and stale data. Used by the `import:ofx` / `import:list` / `import:show` / `import:apply` CLI workflow under `scripts/`.

## Escopo de tenant nas CLIs (issue #720)

Estas CLIs não têm turno de agente nem requisição HTTP de onde herdar a tupla,
então ela é **declarada** e **verificada**:

- `--tenant` e `--agent` são **obrigatórios e sem default** — ausentes, a CLI
  sai com 2 sem tocar no banco.
- Conta e pessoa são resolvidas **dentro do escopo declarado**. Uma conta de
  outro tenant simplesmente não é encontrada e a CLI recusa (exit 3): declarar
  sozinho permitiria escrever no tenant errado; derivar sozinho deixaria o
  arquivo escolher o tenant.
- Todo o trabalho roda em `runWithTenantContext`; todo `INSERT` passa por
  `applyTenantGuard`; todo `UPDATE` pina `id + tenant_id + agent_id` e verifica
  quantas linhas casou (`import_entries.matched_transacao_id` aponta para
  `transacoes.id`, que é PK **global** — um ponteiro cross-tenant existe e
  precisa falhar alto, não virar no-op).

A decisão de desenho, com as alternativas descartadas, está no cabeçalho de
[`scripts/import-ofx.ts`](../../../scripts/import-ofx.ts).

## Key files

| File | Role |
|---|---|
| `src/import/ofx-parser.ts` | OFX parser (handles Brazilian bank dialects) |
| `src/import/csv-parser.ts` | CSV parser (configurable column mapping) |
| `src/import/reconciler.ts` | Matches imported rows against existing transactions; flags duplicates |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — imports operate within `runWithTenantContext`; never touch a different tenant's data
- [Governance + observability](../concerns/governance-observability.md) — every applied import audits; the apply step is owner-gated via the CLI flow

## How to extend

| Need | Where |
|---|---|
| Support a new bank's OFX dialect | Extend `ofx-parser.ts`; add dialect detection; cover with fixture-based tests |
| Support a new CSV mapping | Configurable schema in `csv-parser.ts`; document in `import:show` output |
| Change reconciliation rule | Extend `reconciler.ts`; preserve the duplicate-detection contract |

## Public surface

| Consumed by | What |
|---|---|
| `scripts/import-ofx.ts` | CLI ingestion |
| `scripts/import-review.ts` | Review and apply flow |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/ofx-parser.spec.ts` | OFX parsing fixtures |
| `tests/unit/import-schema.spec.ts` | `import_runs` / `import_entries` no schema Drizzle |
| `tests/integration/import-cli-tenant-scope-real-db.spec.ts` | #720 — as duas CLIs contra Postgres real, como processo filho: ingestão viva, recusa de escopo com controle no mesmo `it`, `import:apply` ponta a ponta e o `UPDATE` cross-tenant recusado |
| `tests/unit/scripts/import-cli-escrita-escopada.spec.ts` | #720 — sonda de forma: fica vermelha se um `UPDATE ... WHERE id = $1` sem escopo (ou um `INSERT` sem `applyTenantGuard`) voltar |

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/import/`.
Issue #720 (em voo) conserta as CLIs em `scripts/`, não `src/import/` — o
`reconciler` já lia escopado via `transacoesRepo.byScope`; o que faltava era a
CLI abrir o contexto.

Verify: `gh pr list --state open --search "import OR ofx OR csv"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |

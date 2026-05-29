# import

**Path:** `src/import/`

**Purpose** — OFX and CSV file ingestion for bank statements. Parsers normalize statement formats into typed transactions; the reconciler matches imported transactions against existing rows to detect duplicates and stale data. Used by the `import:ofx` / `import:list` / `import:show` / `import:apply` CLI workflow under `scripts/`.

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
| `tests/unit/import/ofx-parser.spec.ts` | OFX parsing fixtures |
| `tests/unit/import/csv-parser.spec.ts` | CSV parsing |
| `tests/unit/import/reconciler.spec.ts` | Duplicate detection |

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/import/`.

Verify: `gh pr list --state open --search "import OR ofx OR csv"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |

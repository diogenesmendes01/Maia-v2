# ops

**Path:** `src/ops/`

**Purpose** — Verifiable business continuity and data lifecycle (issue #520). Two concerns live here: `backup/` turns "a backup ran" into evidence that an artifact is intact, encrypted, off-site and restorable; `retention/` turns "we delete old data" into a policy-driven, tenant-scoped, hold-aware, resurrection-proof mechanism.

Everything in this module is written so the DECISION is pure and the SIDE EFFECT is injected. That is what lets the whole backup lifecycle — including the failure branches that only occur at 03:00 on a bad night — be exercised in unit tests with no Postgres, no S3 and no `pg_dump` binary.

## Key files

| File | Role |
|---|---|
| `src/ops/backup/profile.ts` | Configuration contract per profile (`development` / `staging` / `production`), validated fail-closed from `src/config/env.ts` |
| `src/ops/backup/state-machine.ts` | The 12-state lifecycle and `classifyOutcome` — the terminal verdict is COMPUTED from evidence |
| `src/ops/backup/checksum.ts` | Streaming SHA-256 + timing-safe digest comparison |
| `src/ops/backup/manifest.ts` | Versioned, HMAC-signed manifest: provenance, checksum, coverage, tombstone watermark |
| `src/ops/backup/encryption.ts` | Client-side envelope encryption (AES-256-GCM), key rotation, decrypt drill |
| `src/ops/backup/redaction.ts` | Secret/PII minimisation for everything that reaches a log, manifest or audit row |
| `src/ops/backup/single-flight.ts` | Namespaced global advisory locks for backup / drill / retention / reconciliation |
| `src/ops/backup/service.ts` | `runVerifiedBackup` — the ONE runner shared by cron and CLI |
| `src/ops/backup/adapters.ts` | Real IO behind the service's ports (`pg_dump`, fs, S3, DB) |
| `src/ops/backup/rpo.ts` | RPO/RTO readiness: level + evidence + remediation per check |
| `src/ops/retention/data-classes.ts` | The machine-readable data inventory and retention matrix |
| `src/ops/retention/legal-hold.ts` | Deterministic hold evaluator (backend decides) |
| `src/ops/retention/tombstones.ts` | Pseudonymised, signed ledger + post-restore reconciliation gate |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — a `pg_dump` is DB-wide and runs under the reserved `system` sentinel (migration 101 enforces it with a CHECK). Retention, legal hold, tombstones and privacy requests are genuinely per-tenant and reject the legacy `default` literal (migration 102).
- [Governance + observability](../concerns/governance-observability.md) — every run, drill, purge, hold and privacy request audits; metrics stay label-free or low-cardinality.
- [Data retention matrix](../concerns/data-retention-matrix.md) — the inventory in `data-classes.ts` is the executable mirror of that document.
- Fail-closed everywhere: an unverifiable artifact, an unsigned manifest, an unreadable tombstone ledger or an unapproved retention policy all stop the operation instead of degrading it silently.

## How to extend

| Need | Where |
|---|---|
| Add a backup configuration knob | `src/config/env.ts` + `BackupConfigInput`/`resolveBackupProfile`; add its production rule to `validateBackupProfile` |
| Add a lifecycle stage | `state-machine.ts` (`BACKUP_STATES` + `TRANSITIONS`), then the CHECK in `migrations/101_*.sql` |
| Add a manifest field | `manifest.ts` (`backupManifestSchema`); bump `MANIFEST_VERSION` only when an existing field's MEANING changes |
| Add a data class | `retention/data-classes.ts` + the matrix doc; state its `dpo_open_question` |
| Add a readiness check | `rpo.ts` — every check must carry evidence and remediation |
| Support another off-site provider | `src/workers/backup-s3.ts` (protocol-compatible) or a new adapter behind `BackupPorts.upload`/`verifyRemote` |

## Public surface

- `runVerifiedBackup(ports, profile, trigger)` — the shared runner (`src/workers/backup.ts` and `scripts/backup.ts` are its only callers)
- `evaluateBackupReadiness(input)` — the RPO/RTO verdict for `maia doctor` / readiness
- `resolveRetention(classId, policy)` / `evaluateHold(holds, query)` — the two purge gates
- `planReconciliation(input)` / `canReleaseTraffic(plan, applied)` — the post-restore anti-resurrection gate

## Invariants

- A run is `completed` ONLY with a verified off-site copy; local-only is `completed_degraded`, never a normal success.
- Encryption required but absent is `failed`, never degraded — a plaintext dump must not leave the host.
- Key material never appears in a return value, error, log, metric or manifest; only `key_id` does.
- Deletion is irreversible, so every destructive path is dry-run by default (`RETENTION_DRY_RUN=true`) and blocked entirely until a DPO-approved `RETENTION_POLICY` is configured.
- A restore may not release traffic until every tombstone newer than the artifact's watermark has been re-applied and confirmed.

## Related

- Runbook: [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md)
- Migrations: `migrations/101_backup_runs_manifests.sql`, `migrations/102_data_lifecycle.sql`

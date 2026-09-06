# ops

**Path:** `src/ops/`

**Purpose** — Verifiable business continuity, data lifecycle and environment diagnosis. Four concerns live here: `backup/` turns "a backup ran" into evidence that an artifact is intact, encrypted, off-site and restorable (issue #520); `retention/` turns "we delete old data" into a policy-driven, tenant-scoped, hold-aware, resurrection-proof mechanism (#520); `privacy/` turns a data-subject request into an executed, auditable, hold-respecting erasure and closes the anti-resurrection loop by re-applying tombstones after a restore (#536); `doctor/` turns "it did not boot" into a read-only, deadline-bounded, redacted diagnosis with a stable exit code (#517).

`retention/` and `privacy/` are different levers on the same mechanism, and they are armed differently on purpose. A **subject** asking for erasure is an obligation with a named requester, and it executes today behind a recorded human approval. A **period-based** sweep over the ordinary data classes deletes on the platform's own initiative, and it deletes nothing until the DPO approves a `RETENTION_POLICY`. The **export TTL** is the one period-based path that is live (issue #536): the seven days are a decision already taken and already communicated to the subject in their own request, so the hourly `privacy_export_sweep` is not the platform choosing when to delete — it is the platform keeping a promise it made. A deadline nothing executes is not a deadline.

Everything in this module is written so the DECISION is pure and the SIDE EFFECT is injected. That is what lets the whole backup lifecycle — including the failure branches that only occur at 03:00 on a bad night — be exercised in unit tests with no Postgres, no S3 and no `pg_dump` binary.

## Key files

| File | Role |
|---|---|
| `src/ops/backup/profile.ts` | Resolves the backup posture (what is required, what is configured) for the Maia profile. The fail-closed VERDICTS live in `src/config/rules.ts` (`backup/*`), per issue #515 |
| `src/ops/backup/state-machine.ts` | The 12-state lifecycle and `classifyOutcome` — the terminal verdict is COMPUTED from evidence |
| `src/ops/backup/checksum.ts` | Streaming SHA-256 + timing-safe digest comparison |
| `src/ops/backup/manifest.ts` | Versioned, HMAC-signed manifest: provenance, checksum, coverage, tombstone watermark |
| `src/ops/backup/manifest-keyring.ts` | Resolves the manifest-signing secret BY `signature_key_version`, reusing the runtime-trace keyring, so an HMAC rotation does not strand recovery points still inside their retention window |
| `src/ops/backup/encryption.ts` | Client-side envelope encryption (AES-256-GCM), key rotation, decrypt drill |
| `src/ops/backup/redaction.ts` | Secret/PII minimisation for everything that reaches a log, manifest or audit row |
| `src/ops/backup/single-flight.ts` | Namespaced global advisory locks for backup / drill / retention / reconciliation |
| `src/ops/backup/service.ts` | `runVerifiedBackup` — the ONE runner shared by cron and CLI |
| `src/ops/backup/adapters.ts` | Real IO behind the service's ports (`pg_dump`, fs, S3, DB) |
| `src/ops/backup/remote-verify.ts` | Proving the OFF-SITE copy: provider-computed checksum or full re-download. Never the uploader's own metadata |
| `src/ops/backup/upload-deadline.ts` | Cancellable upload: aborts, awaits settlement, reaps any orphan object |
| `src/ops/backup/retention.ts` | Manifest-driven, hold-aware artifact deletion with confirmation and a conclusive outcome |
| `src/ops/backup/rpo.ts` | RPO/RTO readiness: level + evidence + remediation per check |
| `src/ops/backup/drill.ts` | `runRestoreDrill` — fetch the OFF-SITE artifact, bind it to its signed manifest, decrypt, restore in isolation, probe, reconcile in dry-run, tear down in `finally` and PROVE the teardown removed everything (issue #536) |
| `src/ops/backup/drill-probes.ts` | The probe suite the drill grades a restored snapshot with. Pure graders; counts and booleans only |
| `src/ops/backup/drill-adapters.ts` | Real IO behind the drill's ports (S3 GET to file, decrypt, `CREATE/DROP DATABASE`, `pg_restore`, probe queries) |
| `src/ops/retention/data-classes.ts` | The machine-readable data inventory and retention matrix |
| `src/ops/retention/legal-hold.ts` | Deterministic hold evaluator (backend decides) |
| `src/ops/retention/tombstones.ts` | Pseudonymised, signed ledger + post-restore reconciliation gate |
| `src/ops/privacy/workflow.ts` | The LGPD request state machine and subject resolution — a raw identifier becomes the same keyed `subject_ref` the ledger and the hold evaluator speak (issue #536) |
| `src/ops/privacy/execution.ts` | `executePrivacyRequest` — hold pre-flight over every class, then tombstone-before-purge, class by class, in a declared order. Pure; every side effect is a port |
| `src/ops/privacy/reapply.ts` | `reapplyTombstones` — the post-restore executor. Replays the pending tombstones through the same purge and asks `canReleaseTraffic` with the ids it CONFIRMED |
| `src/ops/privacy/adapters.ts` | Real IO behind both (`pessoas`/`conversas`/`mensagens` SQL, encrypted export, ledger writes) and `UNSUPPORTED_CLASSES` — the classes whose purge is a named debt rather than a silent zero |
| `src/ops/privacy/export-locator.ts` | The destructive guard for the encrypted export artifact: shape, containment, inode (`lstat`, not `stat`) and request-binding, in that order — a locator read from a row is untrusted input to an `rm` |
| `src/ops/privacy/export-sweeper.ts` | `runExportSweep` — the TTL executor. Plans from evidence, evaluates hold per scope, proves the path, removes, confirms, then marks-and-audits atomically. Also `readExportArtifact`, the read that makes a swept request say `purged` instead of handing out a dead locator |
| `src/ops/privacy/export-sweeper-adapters.ts` | Real IO behind the sweeper (`lstat`/`realpath`/`rm`, the queue query, the single-winner mark) — and the one place that reuses `privacyWorkspace()` from `adapters.ts`, so writer and sweeper cannot disagree about the directory |
| `src/ops/doctor/types.ts` | The check contract: status, criticality, deadline, the narrow read-only handles a check may touch (issue #517) |
| `src/ops/doctor/runner.ts` | Deadlines (per-check + total), dependency skipping, bounded concurrency, deterministic ordering, and `verdictFor()` — the SINGLE predicate behind both the exit code and the report's last line |
| `src/ops/doctor/report.ts` | Human + versioned JSON render, and the LAST redaction gate — every operator-visible string passes `scrubSecrets()` here |
| `src/ops/doctor/postgres.ts` | `doctorPostgresPool` + `readOnlyPostgres`: the two redundant halves of the read-only guarantee (`default_transaction_read_only=on` and `BEGIN READ ONLY … ROLLBACK`) |
| `src/ops/doctor/schema.ts` | The read-only seam for `getSchemaReadiness()` — the one consumer that needs a pool rather than the narrow handle. Same `BEGIN READ ONLY`, plus a `statement_timeout` below the check's deadline, plus giving the client up on abort so `pool.end()` never waits on a blocked read |
| `src/ops/doctor/redis.ts` | Closed command allowlist (`PING`, `INFO`, `DBSIZE`, `CONFIG GET`), keyed by SUBCOMMAND so `CONFIG SET` is a different entry and is absent |
| `src/ops/doctor/registry.ts` | The check list, in report order: what answers without a socket first |
| `src/ops/doctor/checks/` | One file per category — runtime, config, postgres, redis |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — a `pg_dump` is DB-wide and runs under the reserved `system` sentinel (migration 101 enforces it with a CHECK). Retention, legal hold, tombstones and privacy requests are genuinely per-tenant and reject the legacy `default` literal (migration 102).
- [Governance + observability](../concerns/governance-observability.md) — every run, drill, purge, hold and privacy request audits; metrics stay label-free or low-cardinality.
- [Data retention matrix](../concerns/data-retention-matrix.md) — the inventory in `data-classes.ts` is the executable mirror of that document.
- Fail-closed everywhere: an unverifiable artifact, an unsigned manifest, an unreadable tombstone ledger or an unapproved retention policy all stop the operation instead of degrading it silently.

## How to extend

| Need | Where |
|---|---|
| Add a backup configuration knob | Declare it in `src/config/contract.ts` (group `backup`), add it to `BackupConfigInput`/`backupConfigInput()`, and put its fail-closed rule in `src/config/rules.ts` (`backup/*`). Then `npm run config:generate`. |
| Add a lifecycle stage | `state-machine.ts` (`BACKUP_STATES` + `TRANSITIONS`), then the CHECK in `migrations/101_*.sql` |
| Add a manifest field | `manifest.ts` (`backupManifestSchema`); bump `MANIFEST_VERSION` only when an existing field's MEANING changes |
| Add a data class | `retention/data-classes.ts` + the matrix doc; state its `dpo_open_question` — or, when the platform owner has ratified the design, its `owner_ratification` record (`privacy.tombstone` is the one case; the input type of `cls()` forces exactly one of the two, and `approval_state` is derived from it). If a subject request should reach it, it must be `scope: 'tenant_agent'` and get an entry in `privacy/execution.ts`'s `PURGE_ORDER` |
| Implement a purge for a class | Add the SQL to `privacy/adapters.ts` and REMOVE the class from `UNSUPPORTED_CLASSES`. Nothing else changes — the executor picks it up. Place it in `PURGE_ORDER` by FK dependency (leaves before roots), never alphabetically: `mensagens.conversa_id` cascades from `conversas`, so deleting conversations first would silently zero the message count |
| Change the export TTL | `PRIVACY_EXPORT_TTL_DAYS` (contract, group `backup`) + the matrix doc. The value applies at ISSUE time and is stamped in `export_expires_at`; the sweeper honours the stamp, never the current config. See [`runbooks/privacy-export-ttl.md`](../../runbooks/privacy-export-ttl.md) §8 |
| Add a readiness check | `rpo.ts` — every check must carry evidence and remediation |
| Add a restore-drill probe | `drill-probes.ts`: a single-row SQL plus a PURE grader. `required: true` only when its failure means the snapshot is genuinely unusable; the query must return counts/booleans, never a row value |
| Add a `maia doctor` check | A `DoctorCheck` in `doctor/checks/<category>.ts`, registered in `doctor/registry.ts`. It must declare a deadline, `requiresNetwork`, a criticality, and remediation for every `fail`. It may touch dependencies ONLY through `ctx.postgres` / `ctx.redis` — a check that reaches for the application pool, a repository or `checkAll()` breaks the read-only guarantee |
| Let the doctor read a new dependency | Extend `DoctorContext` with a NARROW read-only handle (the way `ctx.schemaReadiness` binds `getSchemaReadiness()` through `doctor/schema.ts`), never with a client the check can write through |
| Make a blocker's `skip` NOT count as unproven | `notApplicable()` instead of `skip()`, and only when the check's subject does not exist in this environment. Every other `skip` on a blocker makes the run INCOMPLETO (exit 3) — that is the point |
| Support another off-site provider | `src/workers/backup-s3.ts` (protocol-compatible) or a new adapter behind `BackupPorts.upload`/`verifyRemote` |

## Public surface

- `runVerifiedBackup(ports, profile, trigger)` — the shared runner (`src/workers/backup.ts` and `scripts/backup.ts` are its only callers)
- `runRestoreDrill(ports, profile)` — the shared drill (`runRestoreDrillJob` in `src/workers/backup.ts`, reached from `scripts/restore-test.ts`)
- `evaluateBackupReadiness(input)` — the RPO/RTO verdict for `maia doctor` / readiness
- `resolveRetention(classId, policy)` / `evaluateHold(holds, query)` — the two purge gates
- `planReconciliation(input)` / `canReleaseTraffic(plan, applied)` — the post-restore anti-resurrection gate
- `executePrivacyRequest(req, subject, ports)` — the LGPD subject request (`runPrivacyRequestJob` in `src/workers/privacy.ts`, reached from `scripts/privacy-request.ts`)
- `runExportSweep(ports, options)` — the export TTL pass (`runPrivacyExportSweepJob`, the `privacy_export_sweep` cron, reached from `scripts/privacy-export.ts`)
- `readExportArtifact(row, now)` — the ONE place that decides what a reader may see of an export artifact (`none` · `available` · `expired` · `purged`); `expired` and `purged` both withhold the locator
- `proveExportArtifact(root, locator, probe)` / `assertLocatorBoundToRequest(planned, fresh)` — the guard every export removal passes through
- `reapplyTombstones(plan, ports, opts)` — the executor that closes the gate above (`runPostRestoreReconciliationJob`, reached from `scripts/post-restore-reconcile.ts`)
- `assertDrillTarget(name, productionUrl)` / `assertAdminTarget(adminUrl, productionUrl)` — the destructive-target guard every drill DDL passes through
- `runDoctor(checks, ctx, options)` / `verdictFor(run, strict)` / `exitCodeFor(run, strict)` — the read-only diagnosis and its verdict (`ready` 0 · `not_ready` 1 · `incomplete` 3; `2` belongs to the CLI and means the gate did not run). `scripts/doctor.ts` is its only caller today
- `evaluateSchemaReadiness(deps)` — `getSchemaReadiness()` bound to a read-only, time-bounded transaction over the doctor's pool
- `deriveTombstoneSecret(master)` — the ledger's keying material. Domain-separated from the manifest-signing key and FROZEN: changing the label invalidates every existing tombstone HMAC, and an unverifiable ledger blocks every restore

## Invariants

- A run is `completed` ONLY with a verified off-site copy; local-only is `completed_degraded`, never a normal success.
- Encryption required but absent is `failed`, never degraded — a plaintext dump must not leave the host.
- Key material never appears in a return value, error, log, metric or manifest; only `key_id` does.
- Deletion is irreversible, so every destructive path is dry-run by default (`RETENTION_DRY_RUN=true`) and blocked entirely until a DPO-approved `RETENTION_POLICY` is configured.
- A restore may not release traffic until every tombstone newer than the artifact's watermark has been re-applied and confirmed. "Confirmed" means the ids the executor actually got back — `canReleaseTraffic` is never handed `plan.pending`, and the ledger it planned from must be asserted INDEPENDENT of the restored snapshot, because the copy inside the restored database yields an `ok` plan with nothing pending and would release traffic over every erased subject.
- **A destructive drill operation names its target on three axes before acting** (issue #536). `assertSafeDatabaseName` only proves a string is a legal identifier — `assertSafeDatabaseName('maia')` passes and `maia` is production. `assertDrillTarget` additionally proves the target is not the configured database, not a reserved one, and carries the namespace `drillDatabaseName` mints; `assertAdminTarget` proves the DDL connection is the same host and a maintenance database. Not being able to determine which database is production is a REFUSAL, not permission to skip the comparison. The identity checks run before the namespace check so the recorded code names the worst true fact about the target.
- **`legal_holds` beats erasure by BLOCKING, never by deferring.** The hold pre-flight covers every class in scope before the first one is touched — evaluating class by class would erase half a subject's data and only then discover the hold, and neither half can be undone. A held request is terminal `denied` with `denied_reason_code='legal_hold'`; an unreadable hold table is `failed`, never "no hold found". The hold blocks the export too: handing a subject the copy of data a court froze is the same disclosure the hold exists to prevent.
- **The tombstone is written BEFORE the purge.** Both orders can be interrupted, at very different cost. Tombstone-after leaves erased data with no ledger row, and a later restore resurrects it with nothing to stop it — the exact failure the ledger exists for. Tombstone-before leaves, at worst, a tombstone for data still alive, and the reconciliation purges it again, because every subject-scoped purge is idempotent. One overstates and self-corrects; the other omits and cannot be repaired.
- **A TTL that nothing executes is not a TTL.** `export_expires_at` used to be a stamp with no executor: the deadline lived in the database and the `.enc` lived on disk forever — a leak with an infinite deadline, and an easy one to miss because the column looks like somebody handled it. The sweeper (`privacy_export_sweep`, hourly) is what makes the seven days real. Its idempotency lives in the ORDER: remove → confirm → mark-and-audit **in one transaction**, with the mark conditional on `export_purged_at IS NULL`. Mark-before-remove would leave a request claiming the artifact is gone with the file still on disk and no candidate left to find it; remove-before-mark leaves, at worst, a removed file and a request the next pass finishes. And because only the transaction that WON the mark audits, running the pass twice — in series or in parallel — produces exactly one `privacy_export_purged` row.
- **The locator is untrusted input to an `rm`.** It comes from a database row, so it is proven on four axes before anything is removed: shape (the UUID our own `sealExport` mints), containment (a direct child of the export root, by identity — `startsWith` alone accepts `/exports-evil/x` for a root of `/exports`), inode (`lstat` and never `stat`, because `stat` follows the symlink and hides the case; plus regular-file and `nlink === 1`, since a second hard link means removing ours destroys the trail and not the data), and BINDING — the row is re-read at the instant of removal, because between planning and deleting the locator may have been re-issued and the file in the plan may now be a live artifact. Order is contract, as in `assertDrillTarget`: the structural refusals come first so the audited code names the WORST true fact about the target — `../../etc/passwd` must be recorded as `path_separator`, not as the also-true "does not look like a UUID". Every refusal is AUDITED and nothing is removed; an unrecognisable locator is never "delete just in case" and never a silent skip.
- **A legal hold freezes the export copy, not just the source.** The sweeper evaluates the hold over `privacy.export` AND every subject-scoped class the bundle can carry: the package handed to a subject is responsive material exactly as much as the rows it was built from. The evaluation does NOT consult the class's own `legal_hold_applicable` flag — gating a destructive refusal on a mutable registry field means a one-character edit disarms it. An unreadable hold table fails the whole pass; "I could not check" is never "there is no hold".
- **A class whose purge is not implemented is a RECORDED EXCEPTION, never a purge that returns zero.** The two are technically identical and legally opposite: the second makes a request declare itself fulfilled having deleted nothing, which is evidence of compliance without the compliance.
- **A drill is `passed` only when the host is PROVEN clean.** The drill is the one job that deliberately materialises a full plaintext copy of production, so a teardown that merely did not throw is not evidence: `drill.ts` re-checks the ephemeral database against `pg_database` and each staged file against the filesystem AFTER removing them, and an absence it cannot prove counts exactly like a proven leak. The teardown verdict is a SECOND axis (`restore_drills.cleanup_status`, migration 112), never folded into `failure_code` — a probe failure and a residue can happen together, ask for opposite remediations, and must both be readable from the row.
- **The drill claims a staged path BEFORE it writes to it, never after.** Registering the destination on the way out of a call — after `fetchArtifact` returned, after `decrypt` returned — only ever records writes that SUCCEEDED, and every one of those calls streams: a transfer that dies mid-way leaves bytes at a path the teardown then walks past. The sweep would report `clean` truthfully about an inventory that was itself incomplete, so the `failure === null && cleanup.status !== 'clean'` promotion never fires and the drill certifies a clean host over a partial production dump (under `encryption.mode='none'`, a cleartext one). Claiming the slot up front is fail-closed and independent of any adapter's `catch`: a slot that was never written is proven absent by `fileExists` and grades `clean` anyway, because the sweep's authority is the host, not the bookkeeping. The local recovery point is the one path the drill must NOT claim — it is read in place (`ephemeral: false`).
- **Manifest verification resolves the key by the version the ENVELOPE names.** `backup_manifests.signature_key_version` is a selector, not a label: `verifyManifest` takes a `ManifestKeyring` and never a bare secret, because a verifier holding one secret only verifies manifests signed with the key it happens to hold now — so the first HMAC rotation would turn every recovery point still inside its retention window into `manifest_unverifiable`, making the rotation itself the event that destroys restorability. `manifest-keyring.ts` reuses the runtime-trace keyring (`hmacMasterSecretForVersion`) rather than re-parsing `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS`: two parsers for the same env var drift, and a drifted keyring is an unrestorable backup. An unknown version fails closed as `key_version_unknown` — never a fallback to the current key, which would both hide the diagnosis and accept an envelope that renamed its own version. A selector that is not a positive integer is refused before it reaches key material at all.

### The drill's status vocabulary

| Outcome | `status` | `failure_code` | `cleanup_status` | Means |
|---|---|---|---|---|
| Certified | `passed` | `null` | `clean` | The artifact is restorable AND nothing was left on the host. |
| Successful restore, unsafe residue | `failed` | `cleanup_failed` | `unsafe` | The artifact **is** restorable; a copy of production data is (or may be) still on the host. A human must remove it. Not a certification — see the runbook. |
| Restore unproven | `failed` | the restore-phase code | `clean` | Nothing is known to be restorable; the host is clean. |
| Both | `failed` | the restore-phase code | `unsafe` | Two independent problems in one row; neither masks the other. |
| Nothing to drill | `skipped` | `backups_disabled` | `clean` | The only legitimate non-verdict. `readReadinessFacts` ignores it. |
| Process died mid-drill | `running` | — | `unknown` | Nobody checked. Treat as possible residue. |

## Related

- Runbook: [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md)
- Runbook: [`docs/runbooks/doctor.md`](../../runbooks/doctor.md) — `maia doctor`, and the boundary between it, the configuration preflight, `/readyz` and the synthetic probe
- Runbook: [`docs/runbooks/privacy-export-ttl.md`](../../runbooks/privacy-export-ttl.md) — the export TTL: how the sweeper decides, what a refusal means, and how the DPO changes the deadline
- Migrations: `migrations/101_backup_runs_manifests.sql`, `migrations/102_data_lifecycle.sql`, `migrations/112_restore_drill_cleanup_status.sql`, `migrations/118_privacy_export_purge.sql`

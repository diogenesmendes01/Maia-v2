/**
 * Issue #516 — shared vocabulary for the migration runner, its ledger and the
 * schema-readiness surface consumed by `maia doctor` (#517).
 *
 * PURE module: no I/O, no `pg`, no config. Everything here is data, so the
 * decision logic in `status.ts` can be unit-tested with plain objects and no
 * database at all.
 *
 * Scoping note (AGENTS.md §4 rule 1). Every stateful boundary in Maia scopes by
 * `tenant_id + agent_id`. Schema migrations are the documented exception: DDL
 * is **global to the database**, shared by every tenant and agent, so the
 * ledger has no tenant/agent columns and the advisory lock is a single global
 * key. This is stated explicitly rather than silently ignored — a migration
 * that needs per-tenant data changes still writes tenant-scoped rows inside its
 * own SQL; it is only the *bookkeeping* that is global.
 */

/** Lifecycle of a single migration in the ledger (v2). */
export const LEDGER_STATUSES = ['running', 'applied', 'dirty', 'failed'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/**
 * How the ledger obtained a row's checksum.
 *
 * - `computed`   — the runner hashed the file at the moment it applied it.
 * - `backfilled` — the row predates checksums (or was written by the v1 runner)
 *   and the checksum was adopted from the packaged artifact after the fact.
 *   Adoption trusts the artifact present at backfill time; from then on any
 *   divergence is a blocker. See `docs/architecture/modules/migrations.md`.
 */
export const CHECKSUM_SOURCES = ['computed', 'backfilled'] as const;
export type ChecksumSource = (typeof CHECKSUM_SOURCES)[number];

/**
 * Whether a migration's OWN transaction control (if any) wraps all of its
 * executable SQL in one complete envelope. Computed by
 * `analyzeTransactionEnvelope` in `discover.ts`; it is the property the runner's
 * failure classification depends on, so it lives in the shared vocabulary.
 */
export type TransactionEnvelope = 'absent' | 'single_complete' | 'unverifiable';

/** One forward migration as it exists in the packaged artifact (on disk). */
export interface DiscoveredMigration {
  /** Full forward filename — the ledger key. Never renamed (append-only). */
  readonly id: string;
  /** Leading token (`^[0-9]+[a-z]?$`), or `null` when malformed. */
  readonly prefix: string | null;
  /** SHA-256 (hex) of the canonicalised file contents. */
  readonly checksum: string;
  /** File carries the `-- maia:no-transaction` marker. */
  readonly noTransaction: boolean;
  /**
   * How the migration's transaction is managed, which decides whether the
   * ledger write can be atomic with the schema change:
   *
   * - `runner` — the file has no transaction control, so the runner wraps it
   *   AND the ledger row in one transaction. Genuinely atomic: a crash leaves
   *   neither the change nor the row.
   * - `self`   — the file contains its own `BEGIN; … COMMIT;`. Postgres does
   *   not nest transactions, so the file's `COMMIT` closes the envelope before
   *   the ledger row can be written. Atomicity is impossible; the runner uses
   *   the `running`-first protocol so the gap is visible instead of silent.
   * - `none`   — `-- maia:no-transaction` (CONCURRENTLY DDL). Same
   *   `running`-first protocol, statements sent one at a time.
   */
  readonly transactionMode: 'runner' | 'self' | 'none';
  /**
   * Whether the file's OWN transaction control (when it has any) forms one
   * complete `BEGIN; … COMMIT;` envelope around all of its executable SQL.
   *
   * - `absent`          — no transaction control; the runner owns the envelope.
   * - `single_complete` — one envelope, nothing outside it. A failure anywhere
   *   aborts that transaction and the trailing `COMMIT` degrades to a rollback,
   *   so the migration really is retryable (`failed`).
   * - `unverifiable`    — own control, but not one complete envelope (a
   *   statement after the `COMMIT`, two envelopes, an envelope never closed).
   *   Part of the file can be DURABLY committed while a later statement fails,
   *   so a failure is `dirty`, not `failed`. `buildMigrationArtifact` also
   *   reports it as an artifact problem, which blocks `up` before any DDL.
   *
   * See `analyzeTransactionEnvelope` in `discover.ts`.
   */
  readonly transactionEnvelope: TransactionEnvelope;
  /** A `_down.sql` sibling exists (AGENTS.md §4 rule 6 requires one). */
  readonly hasDownSibling: boolean;
  /**
   * Per-migration `statement_timeout` override in ms, declared in the file via
   * `-- maia:statement-timeout=<ms>`. Versioned and reviewable by construction:
   * the override lives in the migration, not in an operator's shell.
   */
  readonly statementTimeoutMs: number | null;
  /** Raw (non-canonicalised) SQL, as it will be sent to Postgres. */
  readonly sql: string;
}

export type ArtifactProblemKind =
  | 'missing_down_sibling'
  | 'malformed_prefix'
  | 'duplicate_id'
  /**
   * A migration that manages its own transaction but does NOT wrap all of its
   * executable SQL in one complete envelope. Its failure mode is a partially
   * committed schema that the runner cannot distinguish from a clean rollback,
   * so the file is refused before it can reach a database.
   */
  | 'unverifiable_transaction_envelope';

export interface ArtifactProblem {
  readonly kind: ArtifactProblemKind;
  readonly id: string;
  readonly detail: string;
}

/** The packaged set of forward migrations, in apply order. */
export interface MigrationArtifact {
  readonly migrations: readonly DiscoveredMigration[];
  readonly byId: ReadonlyMap<string, DiscoveredMigration>;
  /** Highest id in apply order, or `null` for an empty artifact. */
  readonly head: string | null;
  readonly problems: readonly ArtifactProblem[];
}

/** A row of `schema_migrations` (ledger v2), normalised. */
export interface LedgerEntry {
  readonly id: string;
  readonly checksum_sha256: string | null;
  readonly checksum_source: ChecksumSource | null;
  readonly status: LedgerStatus;
  readonly started_at: string | null;
  readonly applied_at: string | null;
  readonly execution_ms: number | null;
  readonly app_version: string | null;
  readonly runner_version: string | null;
  readonly error_class: string | null;
  readonly repaired_at: string | null;
  readonly repair_reason: string | null;
}

/**
 * Per-migration verdict. `blocking` is the fail-closed bit: any blocking entry
 * stops `up` and keeps the schema out of readiness.
 */
export type MigrationEntryState =
  /** In the artifact, ledger says applied, checksum matches. */
  | 'applied'
  /** In the artifact, absent from the ledger. Not an error — just work to do. */
  | 'pending'
  /** No-transaction migration that failed midway; schema may be partial. */
  | 'dirty'
  /**
   * Ledger says `running`, observed from a read-only caller that does NOT hold
   * the migration lock: either a migrator is applying it right now, or a
   * migrator crashed. Indistinguishable from outside, therefore blocking.
   */
  | 'running'
  /**
   * Ledger says `running` observed while HOLDING the exclusive migration lock.
   * No other migrator can exist, so the row can only be the debris of a crashed
   * run. The runner promotes it to `dirty` in the ledger.
   */
  | 'orphaned_running'
  /** Transactional migration that rolled back cleanly; safe to retry. */
  | 'failed'
  /** Applied, but the file on disk no longer hashes to the recorded checksum. */
  | 'checksum_mismatch'
  /** Applied by an older runner and never backfilled — an unknown, so blocking. */
  | 'checksum_unknown'
  /** In the ledger, absent from the artifact — this release cannot verify it. */
  | 'missing_file';

export interface MigrationEntryStatus {
  readonly id: string;
  readonly state: MigrationEntryState;
  readonly blocking: boolean;
  /** Checksum of the packaged file (`null` when the file is missing). */
  readonly checksum: string | null;
  /** Checksum recorded in the ledger (`null` when never recorded). */
  readonly ledger_checksum: string | null;
  readonly checksum_source: ChecksumSource | null;
  readonly no_transaction: boolean | null;
  readonly applied_at: string | null;
  readonly execution_ms: number | null;
  readonly error_class: string | null;
}

export type SchemaBlockerKind =
  | 'ledger_unavailable'
  | 'ledger_missing'
  | 'dirty_migration'
  /**
   * A migration failed cleanly (its transaction rolled back). Reported by the
   * runner; readiness surfaces the same situation as `schema_below_minimum`,
   * because from the schema's point of view the migration is simply not applied.
   */
  | 'migration_failed'
  | 'running_migration'
  | 'orphaned_running'
  | 'checksum_mismatch'
  | 'checksum_unknown'
  | 'missing_file'
  | 'artifact_integrity'
  | 'schema_below_minimum'
  | 'schema_above_maximum';

export interface SchemaBlocker {
  readonly kind: SchemaBlockerKind;
  /** Migration id, when the blocker is attributable to one. */
  readonly id?: string;
  /** Operator-facing explanation. NEVER carries SQL, DSNs or driver text. */
  readonly detail: string;
}

/**
 * What schema range THIS build of the application can run against.
 *
 * `min_supported_migration` supports expand/contract rollouts: a release that
 * tolerates the previous schema lowers its minimum instead of demanding its own
 * head. `max_supported_migration` blocks an OLD build from booting against a
 * database that a NEWER build has already migrated past; `null` means the build
 * declares itself forward-tolerant.
 */
export interface MigrationCompatibilityManifest {
  readonly schema_manifest_version: 1;
  readonly expected_head: string | null;
  readonly min_supported_migration: string | null;
  readonly max_supported_migration: string | null;
}

export interface MigrationStatusCounts {
  readonly total: number;
  readonly applied: number;
  readonly pending: number;
  readonly dirty: number;
  readonly failed: number;
  readonly running: number;
  readonly orphaned_running: number;
  readonly checksum_mismatch: number;
  readonly checksum_unknown: number;
  readonly missing_file: number;
}

/**
 * Read-only description of "artifact vs database". Computed by a pure function
 * from the artifact plus the ledger rows, so it is fully unit-testable without
 * Postgres.
 */
export interface MigrationStatusReport {
  /** `false` when `schema_migrations` does not exist (or could not be read). */
  readonly ledger_present: boolean;
  /** 1 = pre-#516 ledger (id + applied_at only); 2 = checksum/state ledger. */
  readonly ledger_version: 1 | 2 | null;
  readonly expected_head: string | null;
  /** Highest id the ledger reports as `applied`. */
  readonly applied_head: string | null;
  readonly entries: readonly MigrationEntryStatus[];
  /** Ids ready to be applied, in apply order. */
  readonly pending: readonly string[];
  /**
   * Pending ids that sort BEFORE `applied_head` — merged from a branch that
   * started before the current head. Reported, not blocked (see the module
   * doc); the runner still applies them in artifact order.
   */
  readonly out_of_order: readonly string[];
  readonly counts: MigrationStatusCounts;
  readonly problems: readonly ArtifactProblem[];
}

/**
 * THE surface `maia doctor` (#517) and any readiness probe consumes. Everything
 * needed to render a verdict is here — a consumer never re-derives state by
 * parsing logs or re-hashing files.
 */
export interface SchemaReadiness {
  /** `true` only when the schema is verified compatible. Fail-closed. */
  readonly ready: boolean;
  /**
   * `ready`   — verified compatible.
   * `blocked` — a known, named incompatibility (see `blockers`).
   * `unknown` — the state could not be established (DB down, ledger missing,
   *             unreadable). Treated as NOT ready, never as "probably fine".
   */
  readonly state: 'ready' | 'blocked' | 'unknown';
  /** One-line summary of the first blocker; `null` when ready. */
  readonly reason: string | null;
  readonly blockers: readonly SchemaBlocker[];
  readonly manifest: MigrationCompatibilityManifest;
  readonly expected_head: string | null;
  readonly applied_head: string | null;
  readonly pending_count: number;
  readonly dirty_count: number;
  readonly checked_at: string;
  /**
   * Full per-migration detail, when it could be computed. `null` in the
   * `unknown` state (nothing was readable).
   */
  readonly status: MigrationStatusReport | null;
}

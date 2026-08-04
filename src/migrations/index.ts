/**
 * Issue #516 — public surface of the migration subsystem.
 *
 * Two audiences:
 *
 *   - **Writers** (`scripts/migrate.ts`, the compose init job): `runMigrations`,
 *     `repairMigration`. They take the global advisory lock and are the ONLY
 *     things allowed to change the schema.
 *   - **Readers** (`maia doctor` #517, `/readyz`, `migrate plan|status`):
 *     `getSchemaReadiness`, `getMigrationStatus`. Read-only, never throwing,
 *     fail-closed.
 *
 * Down migrations are NOT here, by design: rollback stays manual
 * (`docs/runbooks/migrations.md`). Nothing in this module can execute a
 * `_down.sql`.
 */
export {
  buildMigrationArtifact,
  compareMigrationIds,
  discoverMigrations,
  downSiblingOf,
  isForwardMigration,
  prefixOf,
  splitNoTxStatements,
  statementTimeoutOf,
  NO_TX_MARKER,
  STATEMENT_TIMEOUT_MARKER,
  type MigrationSource,
} from './discover.js';

export {
  canonicalizeMigrationSql,
  migrationChecksum,
  shortChecksum,
  SHORT_CHECKSUM_LENGTH,
} from './checksum.js';

export {
  computeMigrationStatus,
  defaultCompatibilityManifest,
  evaluateSchemaReadiness,
  unknownReadiness,
  type ComputeStatusOptions,
  type ReadinessOptions,
} from './status.js';

export {
  acquireMigrationLock,
  withMigrationLock,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_WAIT_MS,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_NAMESPACE,
  type LockAcquisition,
  type LockOptions,
  type MigrationLock,
} from './lock.js';

export {
  describeLedger,
  ensureLedgerSchema,
  readLedger,
  LEDGER_TABLE,
  LEDGER_V2_COLUMNS,
  LEDGER_V2_DDL,
  type LedgerClient,
  type LedgerShape,
} from './ledger.js';

export {
  repairMigration,
  runMigrations,
  DEFAULT_STATEMENT_LOCK_TIMEOUT_MS,
  RUNNER_VERSION,
  type MigrationEventSink,
  type MigrationRunResult,
  type RepairRequest,
  type RepairResult,
  type RunnerDeps,
  type RunOptions,
  type RunOutcome,
} from './runner.js';

export {
  getMigrationStatus,
  getSchemaReadiness,
  type SchemaInspectionDeps,
} from './readiness.js';

export type * from './types.js';

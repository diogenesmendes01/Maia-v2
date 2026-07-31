/**
 * Public surface of the migration runner (issue #516).
 *
 * Consumers:
 *   - `src/cli/maia.ts`                       — `maia migrate plan|status|up|repair`
 *   - `scripts/migrate.ts`                    — `npm run db:migrate` (thin shim)
 *   - `src/runtime/lifecycle/schema-version.ts` — `/readyz` schema gate
 *   - `maia doctor` (#517)                    — `planMigrations` + `evaluateCompatibility`
 *   - `tests/integration/_fixtures/postgres-testcontainer.ts` — test schema
 *
 * Import the barrel for types and pure helpers. Anything that needs a pool
 * goes through `bootstrap.ts`, which is the only module here that touches the
 * configuration loader.
 */
export * from './types.js';
export {
  NO_TX_MARKER,
  IDEMPOTENT_MARKER,
  STATEMENT_TIMEOUT_MARKER,
  PREFIX_SHAPE,
  canonicalizeSql,
  checksumOf,
  shortChecksum,
  prefixOf,
  splitNoTxStatements,
  parseStatementTimeout,
  describeMigration,
  defaultMigrationsDir,
  discoverMigrations,
  expectedHead,
} from './discover.js';
export {
  DEFAULT_RUNNING_STALE_MS,
  evaluateCompatibility,
  firstBlocker,
  type CompatibilityInput,
} from './compatibility.js';
export {
  buildSchemaManifest,
  type ManifestEntry,
  type ManifestRange,
  type SchemaManifest,
} from './manifest.js';
export {
  EVENTS_TABLE,
  LEDGER_TABLE,
  backfillChecksums,
  ensureLedger,
  errorClassOf,
  mapLedgerRow,
  readLedger,
  recordEvent,
  type LedgerEvent,
  type LedgerSnapshot,
} from './ledger.js';
export {
  MIGRATION_LOCK_CLASSID,
  MIGRATION_LOCK_OBJID,
  acquireMigrationLock,
  releaseMigrationLock,
  withMigrationLock,
  type LockOutcome,
} from './lock.js';
export {
  describeError,
  migrationLogger,
  redact,
  silentMigrationLogger,
  type MigrationLogEvent,
  type MigrationLogger,
} from './log.js';
export {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  migrateUp,
  planMigrations,
  repairMigration,
  type MigrationPlan,
  type MigrationPlanEntry,
  type MigrationState,
  type RepairRequest,
  type RepairResult,
  type RunnerOptions,
} from './runner.js';

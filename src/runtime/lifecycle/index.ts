/**
 * Runtime lifecycle — public surface (issue #512).
 *
 * `roles.ts` is the contract issue #513 (topology separation) builds on:
 * import `ProcessRole`/`ROLE_CONTRACTS`/`roleOwns`/`roleRequires` from here
 * rather than re-deriving what a process should start or gate on.
 */
export {
  PROCESS_ROLES,
  LIFECYCLE_COMPONENTS,
  ROLE_CONTRACTS,
  getRoleContract,
  parseProcessRole,
  roleOwns,
  roleRequires,
  type ProcessRole,
  type LifecycleComponent,
  type RoleContract,
} from './roles.js';

export {
  LIFECYCLE_STATES,
  lifecycle,
  getLifecycleState,
  type LifecycleState,
  type LifecycleSnapshot,
  type ComponentSnapshot,
  type ComponentState,
  type ShutdownStep,
  type ShutdownOutcome,
} from './controller.js';

export {
  checkRoleReadiness,
  checkStartup,
  type ReadinessCheck,
  type ReadinessStatus,
  type RoleReadinessReport,
} from './readiness.js';

/**
 * The schema gate `/readyz` uses (issue #516) — the canonical migration
 * verdict, cached. New consumers use THIS, not `checkSchemaVersion()`.
 */
export {
  checkSchemaReadiness,
  describeSchemaReadiness,
  SCHEMA_READINESS_TTL_MS,
  type SchemaReadinessDeps,
} from './schema-readiness.js';

/**
 * The pre-#516 comparison. Still the BOOT step in `src/index.ts`; it is NOT the
 * readiness verdict any more — see the module doc for why both exist.
 */
export { checkSchemaVersion, expectedSchemaVersion, type SchemaVersionResult } from './schema-version.js';

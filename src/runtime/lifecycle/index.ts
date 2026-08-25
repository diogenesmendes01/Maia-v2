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
 * The canonical schema verdict, cached — issue #516. It is BOTH the `/readyz`
 * gate and, through `./schema-boot-gate.js`, the boot gate. There is no second,
 * weaker schema check any more: `checkSchemaVersion()` was deleted with the
 * boot unification (ADR 0004).
 */
export {
  checkSchemaReadiness,
  describeSchemaReadiness,
  SCHEMA_READINESS_TTL_MS,
  type SchemaReadinessDeps,
} from './schema-readiness.js';

/**
 * The BOOT decision over that verdict (issue #516, ADR 0004): which exit code
 * a negative verdict costs, and the actionable message that goes with it.
 */
export {
  bootExitCode,
  describeSchemaBootFailure,
  SchemaBootAbortError,
  SCHEMA_BOOT_BLOCKER_PRECEDENCE,
  SCHEMA_BOOT_EXIT_CODES,
  type SchemaBootFailure,
} from './schema-boot-gate.js';

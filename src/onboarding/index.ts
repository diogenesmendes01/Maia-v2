/**
 * Issue #519 — superfície pública do módulo de onboarding.
 *
 * Para a issue #517 (`maia doctor`): o que você quer é
 * `evaluateAgentReadiness({ tenant_id, agent_id })`. Ela é a fonte canônica —
 * o mesmo contrato que a ativação usa. Não re-derive prontidão no CLI.
 */
export {
  evaluateAgentReadiness,
  evaluateReadinessFacts,
  blockingFailures,
  configurationFingerprint,
  schemaFingerprint,
  READINESS_CHECK_CODES,
  type AgentReadiness,
  type ReadinessCheck,
  type ReadinessCheckCode,
  type ReadinessCheckStatus,
  type ReadinessSeverity,
  type ReadinessFacts,
  type ReadinessFactsLoader,
  type SchemaFacts,
} from './readiness.js';

export {
  diagnoseAgentOwnershipGlobally,
  loadReadinessFactsFromDb,
  loadReadinessFactsWith,
  loadSchemaState,
  lockReadinessSnapshot,
  type AgentOwnershipDiagnosis,
  type ReadinessExecutor,
} from './readiness-facts.js';

export {
  startOnboardingRun,
  executeOnboardingStep,
  cancelOnboardingRun,
  getOnboardingRun,
  listOnboardingRuns,
  toRunView,
  deriveCommandId,
  DEFAULT_RUN_TTL_MS,
  ONBOARDING_CONTRACT_VERSION,
  type OnboardingActor,
  type OnboardingRunView,
  type StepOutcome,
  type WizardDeps,
  type PairingPort,
  type ReadinessEvaluator,
  type StepTx,
} from './wizard.js';

export {
  ONBOARDING_STATES,
  ONBOARDING_STEPS,
  STEP_DEFINITIONS,
  TERMINAL_STATES,
  allowedStepsFrom,
  getStepDefinition,
  isTerminalState,
  planCancellation,
  planTransition,
  type OnboardingState,
  type OnboardingStep,
  type StepDefinition,
  type TransitionPlan,
} from './state-machine.js';

export {
  ONBOARDING_ERROR_CODES,
  OnboardingError,
  toOnboardingErrorCode,
  type OnboardingErrorCode,
} from './errors.js';

export {
  canonicalJson,
  decideIdempotency,
  hashIdempotencyKey,
  hashPayload,
  type IdempotencyDecision,
} from './idempotency.js';

export {
  FORBIDDEN_SCOPE_LITERALS,
  assertAgentScope,
  assertProvisioningScope,
  assertTenantScope,
  isValidProvisioningScope,
} from './scope.js';

export { isDeniedKey, sanitizeForPersistence } from './sanitize.js';

export { STEP_PAYLOAD_SCHEMAS, parseStepPayload, type StepPayload } from './provisioning.js';

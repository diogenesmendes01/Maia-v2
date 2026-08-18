/**
 * `maia doctor` — public surface (issue #517).
 *
 * `scripts/doctor.ts` is the only in-repo consumer today. The module is a real
 * API rather than a script-local pile so a future Admin UI action can call the
 * same checks without shelling out — and so the read-only handles stay the ONLY
 * way a check touches a dependency.
 */
export * from './types.js';
export { runDoctor, exitCodeFor, errorClass, DEFAULT_CHECK_DEADLINE_MS, DEFAULT_TOTAL_DEADLINE_MS, DEFAULT_CONCURRENCY, type DoctorRun, type DoctorRunOptions, type DoctorRunSummary } from './runner.js';
export { renderHuman, renderJson, redactOutcome, DOCTOR_SCHEMA_VERSION, type DoctorReportMeta } from './report.js';
export { readOnlyPostgres, doctorPostgresPool, READ_ONLY_SQLSTATE, DEFAULT_STATEMENT_TIMEOUT_MS, DOCTOR_POOL_MAX, type PgPoolLike, type PgClientLike } from './postgres.js';
export { readOnlyRedis, parseRedisInfo, assertRedisCommandAllowed, allowlistKey, RedisCommandNotAllowedError, DOCTOR_REDIS_ALLOWED, type RedisCommandClient } from './redis.js';
export { DOCTOR_CHECKS, DOCTOR_CATEGORIES, checksForCategories, isDoctorCategory } from './registry.js';

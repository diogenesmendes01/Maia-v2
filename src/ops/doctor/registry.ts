/**
 * `maia doctor` — the check registry (issue #517 §1).
 *
 * Registry ORDER is output order, and it is not alphabetical: it goes from
 * what answers without a socket (runtime, config) to what needs one
 * (postgres, redis). An operator reading a failing report top-down meets the
 * cause before the consequence — a wrong `DATABASE_URL` shows up as a config
 * finding above the connectivity failure it produced.
 */
import { CONFIG_CHECKS } from './checks/config.js';
import { POSTGRES_CHECKS } from './checks/postgres.js';
import { REDIS_CHECKS } from './checks/redis.js';
import { RUNTIME_CHECKS } from './checks/runtime.js';
import type { DoctorCategory, DoctorCheck } from './types.js';

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  ...RUNTIME_CHECKS,
  ...CONFIG_CHECKS,
  ...POSTGRES_CHECKS,
  ...REDIS_CHECKS,
];

/** Categories in registry order — the vocabulary `--only` accepts. */
export const DOCTOR_CATEGORIES: readonly DoctorCategory[] = [
  'runtime',
  'config',
  'postgres',
  'redis',
];

export function isDoctorCategory(value: string): value is DoctorCategory {
  return (DOCTOR_CATEGORIES as readonly string[]).includes(value);
}

/** Registry narrowed to a set of categories; empty set means "everything". */
export function checksForCategories(
  categories: readonly DoctorCategory[],
): readonly DoctorCheck[] {
  if (categories.length === 0) return DOCTOR_CHECKS;
  const wanted = new Set(categories);
  return DOCTOR_CHECKS.filter((c) => wanted.has(c.category));
}

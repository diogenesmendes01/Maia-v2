/**
 * Issue #514 §6 — label sanitizer: the fail-closed gate between instrumentation
 * and the Prometheus registry.
 *
 * Contract:
 *   1. A key not on `ALLOWED_LABEL_KEYS` is DROPPED (never emitted).
 *   2. A key on the deny list / matching a deny substring is DROPPED even if
 *      someone adds it to the allowlist — the deny list wins.
 *   3. A value that looks like PII (phone, JID, e-mail, long digit run, URL,
 *      free-form text with spaces/newlines) is replaced by `__sanitized__`.
 *   4. A value beyond its (metric, key) cardinality budget collapses into
 *      `__overflow__` instead of minting a new series.
 *   5. Nothing here throws in production: instrumentation must never be able
 *      to break a turn. Violations are counted, logged at debug, and the
 *      metric is still emitted with the surviving labels.
 *
 * Rule 5 has one deliberate exception: `MAIA_STRICT_METRIC_LABELS=true` (set by
 * the unit suite) promotes a violation to a throw so a regression that
 * reintroduces a PII label fails a test instead of leaking silently in prod.
 */
import { config } from '@/config/env.js';
import {
  ALLOWED_LABEL_KEYS,
  CARDINALITY_OVERFLOW_VALUE,
  DEFAULT_LABEL_CARDINALITY_BUDGET,
  FORBIDDEN_KEY_SUBSTRINGS,
  FORBIDDEN_LABEL_KEYS,
  LABEL_CARDINALITY_BUDGET,
  MAX_LABEL_VALUE_LENGTH,
  METRIC,
  SANITIZED_VALUE,
} from './taxonomy.js';

export type LabelViolationReason =
  | 'key_not_allowed'
  | 'key_forbidden'
  | 'value_empty'
  | 'value_pii'
  | 'value_shape'
  | 'cardinality_overflow';

export interface LabelViolation {
  key: string;
  reason: LabelViolationReason;
}

export interface SanitizeResult {
  labels: Record<string, string>;
  violations: LabelViolation[];
}

// ---------------------------------------------------------------------------
// Value guards
// ---------------------------------------------------------------------------

/**
 * Values that are structurally fine for Prometheus. Deliberately narrow:
 * lowercase-ish identifiers, dots, colons, dashes, underscores. Tenant/agent
 * ids in this codebase are slugs or UUIDs, both of which fit.
 */
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:@/+-]{1,64}$/;

/**
 * PII shapes rejected even when the key is allowed. Order matters only for the
 * reason we report; any hit is fatal for the value.
 */
const PII_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /@s\.whatsapp\.net/i, // Baileys JID
  /@g\.us/i, // Baileys group JID
  /@lid\b/i, // Baileys linked-device JID
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // e-mail
  /\+?\d[\d\s().-]{7,}/, // phone-ish digit run (>=8 digits with separators)
  /^\d{8,}$/, // bare long digit run
  /\bhttps?:\/\//i, // URL
]);

/**
 * Exported (issue #535) so the span-attribute gate reuses the SAME value
 * patterns as the metric-label gate. Two copies of a PII regex list is how one
 * of them silently falls behind the other.
 */
export function looksLikePii(value: string): boolean {
  return PII_VALUE_PATTERNS.some((re) => re.test(value));
}

function keyIsForbidden(key: string): boolean {
  const k = key.toLowerCase();
  if (FORBIDDEN_LABEL_KEYS.has(k)) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((frag) => k.includes(frag));
}

// ---------------------------------------------------------------------------
// Cardinality budget
// ---------------------------------------------------------------------------

/**
 * Seen distinct values per `${metric}::${key}`. Bounded by construction:
 * once a bucket reaches its budget we stop inserting, so the map itself cannot
 * grow past `budget` entries per tracked pair.
 *
 * Separator rationale: `::` is TEXT. An earlier revision used a NUL byte,
 * which made git classify this whole file as binary — unreviewable diffs, and
 * unpredictable behaviour from any tool that assumes text. `::` cannot create
 * an ambiguous bucket key because `key` is always drawn from
 * `ALLOWED_LABEL_KEYS` (the allowlist gate in `sanitizeLabels` runs BEFORE
 * this function) and every entry there is a plain `[a-z_]` identifier with no
 * colon. So even if a metric name ever contained `::`, the split point stays
 * unambiguous: the separator is the LAST occurrence.
 */
const seenValues = new Map<string, Set<string>>();

function budgetFor(key: string): number {
  return LABEL_CARDINALITY_BUDGET[key] ?? DEFAULT_LABEL_CARDINALITY_BUDGET;
}

/**
 * @returns the value to emit — either `value` or the overflow sentinel.
 */
function applyCardinalityBudget(metric: string, key: string, value: string): string {
  const bucketKey = `${metric}::${key}`;
  let bucket = seenValues.get(bucketKey);
  if (!bucket) {
    bucket = new Set<string>();
    seenValues.set(bucketKey, bucket);
  }
  if (bucket.has(value)) return value;
  if (bucket.size >= budgetFor(key)) return CARDINALITY_OVERFLOW_VALUE;
  bucket.add(value);
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue #515 — read through the typed loader, not `process.env`. The contract
 * (`src/config/contract.ts`) declares `MAIA_STRICT_METRIC_LABELS` as a boolean
 * with default `false`, so this is a plain boolean here and the value is
 * validated at boot like every other Maia variable.
 */
function strictMode(): boolean {
  return config.MAIA_STRICT_METRIC_LABELS;
}

export class ForbiddenMetricLabelError extends Error {
  constructor(
    readonly metric: string,
    readonly violations: LabelViolation[],
  ) {
    super(
      `metric "${metric}" carries disallowed labels: ` +
        violations.map((v) => `${v.key} (${v.reason})`).join(', '),
    );
    this.name = 'ForbiddenMetricLabelError';
  }
}

/**
 * Sanitize a label set for `metric`.
 *
 * Never throws unless `MAIA_STRICT_METRIC_LABELS=true`.
 */
export function sanitizeLabels(
  metric: string,
  labels: Record<string, unknown> | undefined,
): SanitizeResult {
  const out: Record<string, string> = {};
  const violations: LabelViolation[] = [];
  if (!labels) return { labels: out, violations };

  for (const [rawKey, rawValue] of Object.entries(labels)) {
    const key = rawKey.trim();

    // 1 + 2 — key policy. Deny list is checked FIRST so it wins over the
    // allowlist even if the two ever disagree.
    if (keyIsForbidden(key)) {
      violations.push({ key, reason: 'key_forbidden' });
      continue;
    }
    if (!ALLOWED_LABEL_KEYS.has(key)) {
      violations.push({ key, reason: 'key_not_allowed' });
      continue;
    }

    // 3 — value policy.
    if (rawValue === null || rawValue === undefined) {
      violations.push({ key, reason: 'value_empty' });
      continue;
    }
    const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
    if (value.length === 0) {
      violations.push({ key, reason: 'value_empty' });
      continue;
    }
    if (looksLikePii(value)) {
      violations.push({ key, reason: 'value_pii' });
      out[key] = SANITIZED_VALUE;
      continue;
    }
    if (value.length > MAX_LABEL_VALUE_LENGTH || !SAFE_VALUE_RE.test(value)) {
      violations.push({ key, reason: 'value_shape' });
      out[key] = SANITIZED_VALUE;
      continue;
    }

    // 4 — cardinality budget.
    const bounded = applyCardinalityBudget(metric, key, value);
    if (bounded === CARDINALITY_OVERFLOW_VALUE && bounded !== value) {
      violations.push({ key, reason: 'cardinality_overflow' });
    }
    out[key] = bounded;
  }

  if (violations.length > 0 && strictMode()) {
    throw new ForbiddenMetricLabelError(metric, violations);
  }
  return { labels: out, violations };
}

/**
 * Metric names emitted by the sanitizer itself. Recorded here (rather than in
 * `metrics.ts`) so the accounting cannot recurse: these two counters are
 * emitted with hand-built, already-safe label sets.
 */
export const SELF_METRICS = Object.freeze({
  rejected: METRIC.LABEL_REJECTED,
  overflow: METRIC.LABEL_CARDINALITY_OVERFLOW,
});

/** Test-only: clear the cardinality memory between specs. */
export function _resetLabelGuardForTests(): void {
  seenValues.clear();
}

/** Test/diagnostic: how many distinct values a (metric, key) pair has seen. */
export function _cardinalityFor(metric: string, key: string): number {
  return seenValues.get(`${metric}::${key}`)?.size ?? 0;
}

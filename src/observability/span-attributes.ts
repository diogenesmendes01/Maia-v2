/**
 * Issue #535 §1 — the span-attribute gate.
 *
 * `labels.ts` is the gate for the Prometheus surface; this is the gate for the
 * OTLP surface. They share the value patterns (`looksLikePii`) on purpose, and
 * differ in exactly one axis: a span MAY carry the enumerated correlation ids
 * (`trace_id`, `turn_id`, `attempt_id`, `conversa_id`, `root_trace_id`) that a
 * metric label may never carry, because a span attribute costs no time series.
 *
 * Everything else is identical and non-negotiable: no message content, no
 * phone numbers, no JIDs, no e-mails, no person names, no URLs, no raw error
 * strings. The OTLP exporter ships to a collector we do not own, so a leak
 * here leaves the trust boundary — this gate runs BEFORE a span is queued for
 * export, never at export time, so an unsanitized span cannot exist in memory
 * waiting to be flushed.
 *
 * Failure posture matches `labels.ts`: nothing throws in production, the
 * offending attribute is dropped or replaced and counted; with
 * `MAIA_STRICT_METRIC_LABELS=true` (the unit suite) a violation throws so a
 * regression fails a test instead of leaking.
 */
import { config } from '@/config/env.js';
import {
  FORBIDDEN_SPAN_ATTRIBUTE_KEYS,
  FORBIDDEN_SPAN_KEY_SUBSTRINGS,
  MAX_SPAN_ATTRIBUTES,
  MAX_SPAN_ATTRIBUTE_VALUE_LENGTH,
  SANITIZED_VALUE,
  SPAN_ATTRIBUTE_KEYS,
} from './taxonomy.js';
import { looksLikePii } from './labels.js';

/** A value OTLP can encode without a nested structure. */
export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Record<
  string,
  string | number | boolean | null | undefined
>;

export type SpanAttributeViolationReason =
  | 'key_not_allowed'
  | 'key_forbidden'
  | 'value_empty'
  | 'value_pii'
  | 'value_shape'
  | 'too_many_attributes';

export interface SpanAttributeViolation {
  key: string;
  reason: SpanAttributeViolationReason;
}

export interface SanitizeSpanAttributesResult {
  attributes: Record<string, SpanAttributeValue>;
  violations: SpanAttributeViolation[];
}

/**
 * UUIDs are the ONLY reason this gate needs a shape exemption.
 *
 * `looksLikePii` rejects `\+?\d[\d\s().-]{7,}` as "phone-ish". A UUID's last
 * group (`446655440000`) matches that pattern, so without this check every
 * `trace_id`/`turn_id` — the exact fields a trace exists to carry — would be
 * replaced by `__sanitized__` and the exported spans would be unjoinable.
 * The exemption is narrow by construction: it only accepts a full canonical
 * UUID, which cannot encode a phone number, an e-mail or free text.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape guard for non-UUID string values. Same spirit as `SAFE_VALUE_RE` in
 * `labels.ts` but with the longer span budget: identifiers, dots, colons,
 * dashes, slashes — never whitespace, never newlines, so no prose gets through.
 */
const SAFE_SPAN_VALUE_RE = /^[A-Za-z0-9_.:@/+-]{1,128}$/;

function keyIsForbidden(key: string): boolean {
  const k = key.toLowerCase();
  if (FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(k)) return true;
  return FORBIDDEN_SPAN_KEY_SUBSTRINGS.some((frag) => k.includes(frag));
}

export class ForbiddenSpanAttributeError extends Error {
  constructor(
    readonly span: string,
    readonly violations: SpanAttributeViolation[],
  ) {
    super(
      `span "${span}" carries disallowed attributes: ` +
        violations.map((v) => `${v.key} (${v.reason})`).join(', '),
    );
    this.name = 'ForbiddenSpanAttributeError';
  }
}

/**
 * Sanitize the attribute bag of `span`.
 *
 * Numbers and booleans skip the string guards entirely — they cannot encode
 * PII and OTLP carries them as typed values, not text. Non-finite numbers are
 * dropped rather than serialised as `null`/`NaN`, which some collectors reject
 * outright and which would fail the whole batch, not just the bad span.
 */
export function sanitizeSpanAttributes(
  span: string,
  attributes: SpanAttributes | undefined,
): SanitizeSpanAttributesResult {
  const out: Record<string, SpanAttributeValue> = {};
  const violations: SpanAttributeViolation[] = [];
  if (!attributes) return { attributes: out, violations };

  for (const [rawKey, rawValue] of Object.entries(attributes)) {
    const key = rawKey.trim();

    // Deny list first — it wins over the allowlist even if the two disagree.
    if (keyIsForbidden(key)) {
      violations.push({ key, reason: 'key_forbidden' });
      continue;
    }
    if (!SPAN_ATTRIBUTE_KEYS.has(key)) {
      violations.push({ key, reason: 'key_not_allowed' });
      continue;
    }
    if (rawValue === null || rawValue === undefined) {
      violations.push({ key, reason: 'value_empty' });
      continue;
    }
    if (Object.keys(out).length >= MAX_SPAN_ATTRIBUTES) {
      violations.push({ key, reason: 'too_many_attributes' });
      continue;
    }

    if (typeof rawValue === 'boolean') {
      out[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'number') {
      if (!Number.isFinite(rawValue)) {
        violations.push({ key, reason: 'value_shape' });
        continue;
      }
      out[key] = rawValue;
      continue;
    }

    const value = rawValue.trim();
    if (value.length === 0) {
      violations.push({ key, reason: 'value_empty' });
      continue;
    }
    if (UUID_RE.test(value)) {
      out[key] = value.toLowerCase();
      continue;
    }
    if (looksLikePii(value)) {
      violations.push({ key, reason: 'value_pii' });
      out[key] = SANITIZED_VALUE;
      continue;
    }
    if (
      value.length > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH ||
      !SAFE_SPAN_VALUE_RE.test(value)
    ) {
      violations.push({ key, reason: 'value_shape' });
      out[key] = SANITIZED_VALUE;
      continue;
    }
    out[key] = value;
  }

  if (violations.length > 0 && config.MAIA_STRICT_METRIC_LABELS) {
    throw new ForbiddenSpanAttributeError(span, violations);
  }
  return { attributes: out, violations };
}

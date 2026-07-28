/**
 * Issue #509 §3 — per-provider adaptation of the canonical tool schema.
 *
 * `src/tools/schema-json.ts` produces ONE canonical, provider-portable JSON
 * Schema per tool. This module holds the small amount of knowledge that is
 * genuinely provider-specific:
 *
 *   - Anthropic takes the canonical schema as `input_schema` verbatim. It has
 *     no "strict mode" switch, so there is nothing to adapt.
 *   - OpenAI / OpenRouter take it as `function.parameters`, and MAY accept
 *     `function.strict: true` — a constrained-decoding mode that guarantees the
 *     emitted arguments match the schema. Strict mode only accepts a narrow
 *     JSON Schema subset, so a schema that does not fit it is sent WITHOUT
 *     `strict` rather than mangled.
 *
 * Two hard rules:
 *
 *   1. **The capability matrix is decided by the backend, never by the model.**
 *      `STRICT_CAPABLE_MODEL_PREFIXES` below is the whole matrix; nothing in a
 *      model response can extend it.
 *   2. **A downgrade is never a security event.** Losing `strict` only means
 *      the model is less constrained while GENERATING. Every argument is still
 *      revalidated by Zod in `_dispatcher.ts` and still passes every grant,
 *      permission, limit and approval gate.
 */
import { incCounter } from '@/lib/metrics.js';
// Deterministic, key-order-independent hashing — the same primitives the
// canonical converter uses, so the two hashes are directly comparable.
// `schema-json.ts` imports `_registry.ts` for TYPES ONLY, so there is no
// runtime cycle back into the tool registry from here.
import { schemaHash, canonicalStringify } from '@/tools/schema-json.js';

export type JsonObject = Record<string, unknown>;

/**
 * Models known to support strict function calling, matched by PREFIX against
 * the model id (OpenRouter ids look like `openai/gpt-4.1`).
 *
 * Deliberately conservative: a model absent from this list still receives the
 * full canonical schema, just without `strict: true`. Adding a family here is a
 * backend decision that should come with a canary — see the issue's rollout.
 */
export const STRICT_CAPABLE_MODEL_PREFIXES: readonly string[] = [
  'openai/gpt-4o',
  'openai/gpt-4.1',
  'openai/gpt-5',
  'openai/o3',
  'openai/o4',
  // Direct OpenAI ids (if a deployment ever points the OpenAI SDK at OpenAI).
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o3',
  'o4',
];

/**
 * Whether `strict: true` may be attached for this provider+model.
 *
 * Anthropic: always false — the Messages API has no strict-mode flag for tools;
 * the canonical schema is already what it expects.
 */
export function supportsStrictToolSchemas(
  provider: 'anthropic' | 'openrouter',
  model: string | undefined,
): boolean {
  if (provider !== 'openrouter' || !model) return false;
  const id = model.toLowerCase();
  return STRICT_CAPABLE_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * Keywords strict mode does not accept. They are REMOVED from the strict copy
 * and restated in `description`, so the constraint still reaches the model as
 * guidance and Zod still enforces it server-side.
 */
const STRICT_UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'format',
  'default',
] as const;

/**
 * Why a contract cannot be expressed in the strict subset. A CLOSED set — it is
 * a metric label. Each value names a property of the CONTRACT, so the metric
 * tells an operator exactly what to change to make a tool strict-eligible.
 */
export type StrictRejectReason =
  | 'union_root'
  | 'dynamic_map'
  | 'untyped_value'
  | 'optional_not_null_safe'
  | 'non_object_root';

export type StrictAdaptation =
  | { readonly ok: true; readonly schema: JsonObject }
  | { readonly ok: false; readonly reason: StrictRejectReason };

class NotStrictConvertible extends Error {
  constructor(readonly reason: StrictRejectReason) {
    super(reason);
  }
}

function humanizeDropped(dropped: Array<[string, unknown]>): string {
  return dropped.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

/**
 * Does this canonical node accept `null`?
 *
 * The canonical converter renders `.nullable()` as `anyOf: [T, {type:'null'}]`
 * (and a bare `z.null()` as `{type:'null'}`), so this is an exact read of the
 * Zod contract — not a guess.
 */
function admitsNull(node: JsonObject): boolean {
  if (node.type === 'null') return true;
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as JsonObject[]).some((branch) => admitsNull(branch));
  }
  return false;
}

function toStrictNode(node: JsonObject): JsonObject {
  // The permissive empty schema (`z.unknown()` / `z.any()`): strict mode
  // requires every subschema to be typed, so the tool cannot go strict.
  if (Object.keys(node).length === 0) throw new NotStrictConvertible('untyped_value');

  const out: JsonObject = {};
  const dropped: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(node)) {
    if ((STRICT_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      dropped.push([key, value]);
      continue;
    }
    out[key] = value;
  }

  if (Array.isArray(out.anyOf)) {
    out.anyOf = (out.anyOf as JsonObject[]).map(toStrictNode);
  }
  if (out.items !== undefined) {
    out.items = toStrictNode(out.items as JsonObject);
  }

  if (out.type === 'object') {
    // A dynamic map (`z.record`) becomes `additionalProperties: <schema>`,
    // which strict mode forbids — it demands exactly `false`.
    if (out.additionalProperties !== false && out.additionalProperties !== undefined) {
      throw new NotStrictConvertible('dynamic_map');
    }
    // A union-rooted contract has `anyOf` at the root; strict mode requires a
    // plain object with `properties` there.
    if (out.anyOf !== undefined) throw new NotStrictConvertible('union_root');
    out.additionalProperties = false;

    const properties = (out.properties ?? {}) as JsonObject;
    const previouslyRequired = new Set(((node.required ?? []) as string[]) ?? []);
    const strictProps: JsonObject = {};

    for (const [key, child] of Object.entries(properties)) {
      const childNode = child as JsonObject;
      // ────────────────────────────────────────────────────────────────────
      // The equivalence guard (PR #530 review round 1, P1).
      //
      // Strict mode CANNOT express "optional": it demands every property in
      // `required`. The obvious workaround — force the key and widen it with
      // `{type:'null'}` — silently INVERTS the direction of authority, which is
      // the whole point of this issue. `register_transaction.data_pagamento`
      // and `cancel_transaction.motivo` are `.optional()` but NOT `.nullable()`:
      // Zod accepts their ABSENCE and REJECTS `null`. Under constrained
      // decoding the model would be forced to emit the key, would legitimately
      // emit `null` to mean "absent", and `_dispatcher.ts` would then reject the
      // whole call as `invalid_args` — a failure the model could not avoid.
      //
      // So we refuse strict for the tool instead of shipping a schema that
      // contradicts the authoritative contract. A field that is `.nullable()`
      // already admits `null` in Zod, so forcing it IS faithful and stays
      // eligible. Making the Zod contract nullable to please a provider would
      // be the tail wagging the dog; making the provider envelope honest is not.
      // ────────────────────────────────────────────────────────────────────
      if (!previouslyRequired.has(key) && !admitsNull(childNode)) {
        throw new NotStrictConvertible('optional_not_null_safe');
      }
      strictProps[key] = toStrictNode(childNode);
    }

    out.properties = strictProps;
    // Every surviving optional already accepts `null` in Zod, so promoting all
    // keys to `required` does not widen or narrow what the backend accepts.
    const keys = Object.keys(strictProps);
    if (keys.length > 0) out.required = keys;
    else delete out.required;
  }

  if (dropped.length > 0) {
    const prev = typeof out.description === 'string' ? out.description : '';
    const note = `constraints: ${humanizeDropped(dropped)}`;
    out.description = prev ? `${prev} (${note})` : note;
  }
  return out;
}

/**
 * Rewrite a canonical schema into the strict-mode subset.
 *
 * INVARIANT: the strict copy must accept EXACTLY what the authoritative Zod
 * contract accepts. Anything that cannot be expressed faithfully is refused
 * (`ok: false` + a reason), which means "send the canonical schema without
 * `strict`" — a downgrade of GENERATION quality, never of enforcement, and
 * never a schema that contradicts the backend.
 *
 * Dropping the unsupported keywords is the one deliberate widening: the strict
 * copy becomes MORE permissive than Zod, so the worst case is an `invalid_args`
 * the model could already have produced without strict mode. The reverse
 * direction — a schema that forces the model into a value Zod rejects — is what
 * this function refuses to emit.
 */
export function toStrictJsonSchema(schema: JsonObject): StrictAdaptation {
  try {
    const out = toStrictNode(schema);
    if (out.type !== 'object') return { ok: false, reason: 'non_object_root' };
    return { ok: true, schema: out };
  } catch (err) {
    if (err instanceof NotStrictConvertible) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * Record a strict-mode downgrade. Labels are bounded (`provider`, configured
 * `model`, a closed `reason` set) and carry no arguments or payloads.
 */
export function recordStrictDowngrade(
  provider: string,
  model: string,
  reason: 'model_not_strict_capable' | StrictRejectReason,
): void {
  incCounter('maia_tool_schema_provider_downgrade_total', { provider, model, reason });
}

/**
 * Issue #509 / PR #530 review round 1, [P2] — identity of the tool payload that
 * ACTUALLY went on the wire.
 *
 * `runtime-filter.ts` audits the CANONICAL contract, which is computed before
 * any provider adaptation. In the strict path the envelope rewrites `required`,
 * drops keywords and rewrites descriptions, so the canonical hash alone does not
 * identify what the model saw. This records BOTH:
 *
 *   - `canonical_hash` — the same value the audit row carries, so a turn's audit
 *     row and its wire payload can be joined;
 *   - `provider_payload_hash` — the exact bytes handed to the SDK.
 *
 * Equal hashes ⇒ the envelope was a pass-through. Different hashes with
 * `mode: 'canonical'` would be a bug. Different hashes with `mode: 'strict'` is
 * expected, and comparing the two is how the P1 divergence class gets caught in
 * production rather than in an incident.
 *
 * Contract identity only: hashes, counts and bytes. No schema bodies, no
 * messages, no arguments.
 */
export interface ProviderPayloadDigest {
  provider: string;
  model: string;
  /** 'strict' = every tool strict; 'mixed' = some; 'canonical' = none. */
  mode: 'strict' | 'mixed' | 'canonical';
  tools: number;
  canonical_hash: string;
  provider_payload_hash: string;
  provider_payload_bytes: number;
}

export function describeProviderPayload(params: {
  provider: string;
  model: string;
  canonical: ReadonlyArray<{ name: string; input_schema: Record<string, unknown> }>;
  payload: unknown;
  strictCount: number;
}): ProviderPayloadDigest {
  const canonicalMap: Record<string, string> = {};
  for (const t of params.canonical) canonicalMap[t.name] = schemaHash(t.input_schema);
  const serialized = canonicalStringify(params.payload);
  return {
    provider: params.provider,
    model: params.model,
    mode:
      params.strictCount === 0
        ? 'canonical'
        : params.strictCount === params.canonical.length
          ? 'strict'
          : 'mixed',
    tools: params.canonical.length,
    canonical_hash: schemaHash(canonicalMap),
    provider_payload_hash: schemaHash(params.payload),
    provider_payload_bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

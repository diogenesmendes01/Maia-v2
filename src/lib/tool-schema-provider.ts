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

class NotStrictConvertible extends Error {}

function humanizeDropped(dropped: Array<[string, unknown]>): string {
  return dropped.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

function toStrictNode(node: JsonObject): JsonObject {
  // The permissive empty schema (`z.unknown()` / `z.any()`): strict mode
  // requires every subschema to be typed, so the tool cannot go strict.
  if (Object.keys(node).length === 0) throw new NotStrictConvertible();

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
      throw new NotStrictConvertible();
    }
    // A union-rooted contract has `anyOf` at the root; strict mode requires a
    // plain object with `properties` there.
    if (out.anyOf !== undefined) throw new NotStrictConvertible();
    out.additionalProperties = false;
    const properties = (out.properties ?? {}) as JsonObject;
    const strictProps: JsonObject = {};
    for (const [key, child] of Object.entries(properties)) {
      strictProps[key] = toStrictNode(child as JsonObject);
    }
    out.properties = strictProps;
    // Strict mode requires EVERY property in `required`. Optionality is not
    // representable, so an optional field becomes `anyOf: [T, {type:'null'}]`
    // and the model must send an explicit null instead of omitting the key.
    const previouslyRequired = new Set(((node.required ?? []) as string[]) ?? []);
    const keys = Object.keys(strictProps);
    for (const key of keys) {
      if (previouslyRequired.has(key)) continue;
      const child = strictProps[key] as JsonObject;
      strictProps[key] = Array.isArray(child.anyOf)
        ? { ...child, anyOf: [...(child.anyOf as unknown[]), { type: 'null' }] }
        : { anyOf: [child, { type: 'null' }] };
    }
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
 * Rewrite a canonical schema into the strict-mode subset, or return `null` when
 * the contract cannot be expressed there (union root, dynamic map, untyped
 * value). `null` means "send the canonical schema without `strict`" — a
 * DOWNGRADE of generation quality, never of enforcement.
 */
export function toStrictJsonSchema(schema: JsonObject): JsonObject | null {
  try {
    const out = toStrictNode(schema);
    if (out.type !== 'object') return null;
    return out;
  } catch (err) {
    if (err instanceof NotStrictConvertible) return null;
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
  reason: 'model_not_strict_capable' | 'schema_not_strict_convertible',
): void {
  incCounter('maia_tool_schema_provider_downgrade_total', { provider, model, reason });
}

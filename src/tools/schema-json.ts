/**
 * Issue #509 — canonical Zod → JSON Schema converter for LLM tool exposure.
 *
 * ## Why
 *
 * `toolToSchema()` used to hand every model the same stub:
 *
 * ```ts
 * input_schema: { type: 'object', additionalProperties: true }
 * ```
 *
 * The model therefore never saw which fields exist, which are required, which
 * enums are legal, or what the bounds are — it guessed, the dispatcher rejected
 * with `invalid_args`, and a whole ReAct iteration was burned. This module makes
 * the Zod contract the SINGLE SOURCE OF TRUTH for what the model is told.
 *
 * ## What this is NOT
 *
 * It is **not** a validator and it grants **nothing**. `tool.input_schema.safeParse`
 * in `_dispatcher.ts:172` stays the authority, together with grants, permissions,
 * PEPs, limits, approval, idempotency and context validation. A richer schema
 * shown to the model NEVER relaxes a gate (AGENTS.md §4 invariant #3 — backend
 * decides, LLM proposes).
 *
 * ## Why hand-rolled (no `zod-to-json-schema`)
 *
 * Same call as `describe-schema.ts` (see its header): the project deliberately
 * avoids the extra dependency. It also buys three properties a generic converter
 * does not give for free:
 *
 *   1. **Strict by default** — every closed object emits `additionalProperties:false`;
 *      the literal `additionalProperties: true` is never emitted anywhere.
 *   2. **Least-common-denominator output** — no `$ref`, no `$defs`, no `$schema`,
 *      no `oneOf`, no keyword Anthropic or OpenAI/OpenRouter would reject.
 *   3. **Fail-closed** — an unsupported Zod construct throws
 *      `ToolSchemaConversionError`. A tool whose contract cannot be described
 *      exactly is dropped from the exposed set (see `buildToolSchema`), never
 *      downgraded to a permissive stub.
 *
 * ## Determinism
 *
 * Object keys are emitted in a fixed canonical order and `schema_hash` is taken
 * over a recursively key-sorted serialization, so the same Zod contract always
 * produces byte-identical output and the same hash across processes.
 */
import type { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AnyTool } from './_registry.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';

// ============================================================
// Types
// ============================================================

export type JsonObject = Record<string, unknown>;

export interface CanonicalToolSchema {
  name: string;
  description: string;
  /** Root JSON Schema for the tool arguments. Always `type: 'object'`. */
  input_schema: JsonObject;
  /** 16 hex chars of sha256 over the canonical serialization of `input_schema`. */
  schema_hash: string;
  /** UTF-8 byte size of the serialized `input_schema` (schema budget accounting). */
  bytes: number;
}

/**
 * Raised when a Zod construct has no exact, provider-portable JSON Schema
 * representation, or when the produced schema would violate an invariant
 * (open object, authority-shaped field name, non-object root).
 *
 * Fail-closed: callers must DROP the tool, never fall back to a permissive
 * schema.
 */
export class ToolSchemaConversionError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = 'ToolSchemaConversionError';
  }
}

// ============================================================
// Policy constants
// ============================================================

/**
 * Defense in depth (issue #509 §5). Authority is decided by the backend from
 * session/grant state — the model must never be given a FIELD through which it
 * could ASSERT identity, tenancy, ownership, approval or credentials.
 *
 * Fase 0 already removed `dual_approval_granted` from the catalog; this list
 * makes a regression impossible to merge (the catalog lint test converts every
 * registered tool).
 *
 * Matching is exact on the property NAME, at any depth.
 */
export const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  'approved',
  'approval_granted',
  'dual_approval_granted',
  'is_owner',
  'tenant_id',
  'agent_id',
  'permission',
  'auth_token',
  'api_key',
]);

/**
 * Documented, justified exceptions to `FORBIDDEN_FIELD_NAMES`, keyed by
 * `<tool_name>.<field_name>`. Intentionally EMPTY: there is currently no tool
 * that legitimately takes an authority-shaped argument from the model. Adding an
 * entry requires a justification comment and a test.
 */
export const FORBIDDEN_FIELD_EXCEPTIONS: ReadonlySet<string> = new Set<string>();

/** Recursion guard — a tool contract this deep is a design smell, not a schema. */
const MAX_DEPTH = 12;

/**
 * Per-tool schema budget (issue #509 §7). Exceeding it is a DIAGNOSTIC, never a
 * silent truncation: the catalog lint test fails so the contract gets split or
 * simplified deliberately. Reduction of the VISIBLE SET must come from grants /
 * role scope / skill scope, never from dropping fields behind the model's back.
 */
export const MAX_TOOL_SCHEMA_BYTES = 16_384;

/**
 * Canonical key order for emitted nodes. Keys not listed sort alphabetically
 * after these. Purely cosmetic for validators, load-bearing for byte-stable
 * output and reviewable diffs.
 */
const KEY_ORDER = [
  'type',
  'format',
  'description',
  'enum',
  'default',
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
  'items',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
];

// ============================================================
// Structural view of zod@3 internals
// ============================================================

interface ZodCheck {
  kind?: string;
  value?: unknown;
  inclusive?: boolean;
  regex?: RegExp;
  version?: string;
}

interface ZodDefLike {
  typeName?: string;
  description?: string;
  checks?: ZodCheck[];
  // ZodOptional / ZodNullable / ZodDefault / ZodCatch / ZodReadonly
  innerType?: ZodLike;
  // ZodDefault / ZodCatch
  defaultValue?: () => unknown;
  // ZodEffects
  schema?: ZodLike;
  // ZodPipeline
  in?: ZodLike;
  // ZodArray element / ZodBranded inner / ZodPromise inner
  type?: ZodLike;
  // ZodArray bounds
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  // ZodObject
  unknownKeys?: 'strip' | 'strict' | 'passthrough';
  catchall?: ZodLike;
  shape?: () => Record<string, ZodLike>;
  // ZodRecord
  keyType?: ZodLike;
  valueType?: ZodLike;
  // ZodEnum / ZodNativeEnum
  values?: readonly unknown[] | Record<string, unknown>;
  // ZodLiteral
  value?: unknown;
  // ZodUnion / ZodDiscriminatedUnion
  options?: ReadonlyArray<ZodLike> | Map<unknown, ZodLike>;
  discriminator?: string;
}

interface ZodLike {
  _def?: ZodDefLike;
  shape?: Record<string, ZodLike>;
  isOptional?: () => boolean;
}

// ============================================================
// Canonical serialization + hashing
// ============================================================

/**
 * JSON serialization with recursively sorted object keys. Two structurally
 * equal schemas serialize identically regardless of insertion order, which is
 * what makes `schema_hash` a stable contract version across processes.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as JsonObject)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`)
    .join(',')}}`;
}

/** 16 hex chars of sha256 over `canonicalStringify(value)`. */
export function schemaHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex').slice(0, 16);
}

// ============================================================
// Conversion
// ============================================================

function defOf(schema: ZodLike | undefined): ZodDefLike {
  return schema?._def ?? {};
}

function orderKeys(node: JsonObject): JsonObject {
  const out: JsonObject = {};
  const keys = Object.keys(node).sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const k of keys) {
    if (node[k] !== undefined) out[k] = node[k];
  }
  return out;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Note appended to `description` for a constraint with no portable keyword. */
function addNote(node: JsonObject, note: string): void {
  const prev = typeof node.description === 'string' ? node.description : '';
  node.description = prev ? `${prev} (${note})` : note;
}

const IGNORED_STRING_CHECKS = new Set(['trim', 'toLowerCase', 'toUpperCase']);
/** Recognised zod string checks with no portable JSON Schema keyword. */
const NOTE_ONLY_STRING_CHECKS = new Set([
  'cuid',
  'cuid2',
  'ulid',
  'nanoid',
  'emoji',
  'base64',
  'base64url',
  'jwt',
  'cidr',
  'includes',
]);

function convertString(def: ZodDefLike, path: string): JsonObject {
  const node: JsonObject = { type: 'string' };
  const patterns: string[] = [];
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case 'min':
        node.minLength = check.value as number;
        break;
      case 'max':
        node.maxLength = check.value as number;
        break;
      case 'length':
        node.minLength = check.value as number;
        node.maxLength = check.value as number;
        break;
      case 'uuid':
        node.format = 'uuid';
        break;
      case 'email':
        node.format = 'email';
        break;
      case 'url':
        node.format = 'uri';
        break;
      case 'datetime':
        node.format = 'date-time';
        break;
      case 'date':
        node.format = 'date';
        break;
      case 'time':
        node.format = 'time';
        break;
      case 'duration':
        node.format = 'duration';
        break;
      case 'ip':
        node.format = check.version === 'v6' ? 'ipv6' : 'ipv4';
        break;
      case 'regex':
        if (check.regex instanceof RegExp) patterns.push(check.regex.source);
        break;
      case 'startsWith':
        patterns.push(`^${escapeRegExp(String(check.value))}`);
        break;
      case 'endsWith':
        patterns.push(`${escapeRegExp(String(check.value))}$`);
        break;
      default:
        if (IGNORED_STRING_CHECKS.has(check.kind ?? '')) break;
        if (NOTE_ONLY_STRING_CHECKS.has(check.kind ?? '')) {
          addNote(node, `${check.kind}`);
          break;
        }
        throw new ToolSchemaConversionError(
          `unsupported zod string check '${String(check.kind)}'`,
          path,
        );
    }
  }
  if (patterns.length === 1) {
    node.pattern = patterns[0];
  } else if (patterns.length > 1) {
    // JSON Schema allows a single `pattern` per node and `allOf` is outside the
    // provider least-common-denominator. Emit the first and surface the rest in
    // the description so the model still sees them; Zod remains authoritative.
    node.pattern = patterns[0];
    addNote(node, `also matches ${patterns.slice(1).join(', ')}`);
  }
  return node;
}

function convertNumber(def: ZodDefLike, path: string): JsonObject {
  const node: JsonObject = { type: 'number' };
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case 'int':
        node.type = 'integer';
        break;
      case 'min':
        if (check.inclusive === false) node.exclusiveMinimum = check.value as number;
        else node.minimum = check.value as number;
        break;
      case 'max':
        if (check.inclusive === false) node.exclusiveMaximum = check.value as number;
        else node.maximum = check.value as number;
        break;
      case 'multipleOf':
        node.multipleOf = check.value as number;
        break;
      case 'finite':
      case 'safe':
        break;
      default:
        throw new ToolSchemaConversionError(
          `unsupported zod number check '${String(check.kind)}'`,
          path,
        );
    }
  }
  return node;
}

function jsonTypeOf(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    default:
      throw new ToolSchemaConversionError(
        `literal of unsupported type '${typeof value}'`,
        path,
      );
  }
}

function unionOptions(def: ZodDefLike): ZodLike[] {
  const opts = def.options;
  if (opts === undefined) return [];
  if (opts instanceof Map) return Array.from(opts.values());
  return [...opts];
}

function convertObject(schema: ZodLike, def: ZodDefLike, path: string, depth: number): JsonObject {
  if (def.unknownKeys === 'passthrough') {
    throw new ToolSchemaConversionError(
      'passthrough objects would require additionalProperties:true, which is forbidden — ' +
        'close the object or model the dynamic part with z.record(<value schema>)',
      path,
    );
  }
  const shape: Record<string, ZodLike> =
    (schema.shape as Record<string, ZodLike> | undefined) ??
    (typeof def.shape === 'function' ? def.shape() : {});

  const properties: JsonObject = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = convertNode(field, `${path}.${key}`, depth + 1);
    // `isOptional()` is zod's own answer to "does undefined parse?", so
    // `required` can never drift from the authoritative Zod contract —
    // `.optional()`, `.default()`, `.catch()`, `z.unknown()` and `z.any()` all
    // report optional; `.nullable()` alone does not.
    if (field.isOptional?.() !== true) required.push(key);
  }

  const node: JsonObject = { type: 'object', properties };
  if (required.length > 0) node.required = required;

  const catchall = def.catchall;
  const catchallType = defOf(catchall).typeName;
  if (catchall !== undefined && catchallType !== undefined && catchallType !== 'ZodNever') {
    node.additionalProperties = convertNode(catchall, `${path}.<catchall>`, depth + 1);
  } else {
    node.additionalProperties = false;
  }
  return node;
}

/**
 * Convert one zod node. Wrapper types (`optional` / `nullable` / `default` /
 * `catch` / effects / pipeline / readonly / branded) are unwrapped here; a
 * `.describe()` on ANY layer lands on the emitted node, with the outermost
 * winning (it is the most field-specific).
 */
function convertNode(schema: ZodLike | undefined, path: string, depth: number): JsonObject {
  if (depth > MAX_DEPTH) {
    throw new ToolSchemaConversionError(`schema nesting exceeds ${MAX_DEPTH} levels`, path);
  }
  if (schema === undefined) {
    throw new ToolSchemaConversionError('missing schema node', path);
  }
  const def = defOf(schema);
  const node = convertByType(schema, def, path, depth);
  if (typeof def.description === 'string' && def.description.length > 0) {
    node.description = def.description;
  }
  return orderKeys(node);
}

function convertByType(
  schema: ZodLike,
  def: ZodDefLike,
  path: string,
  depth: number,
): JsonObject {
  switch (def.typeName) {
    // ---- wrappers -------------------------------------------------------
    case 'ZodOptional':
    case 'ZodReadonly':
      return convertNode(def.innerType, path, depth + 1);
    case 'ZodBranded':
      return convertNode(def.type ?? def.innerType, path, depth + 1);
    case 'ZodEffects':
      // `.refine()` / `.transform()` / `.preprocess()` — the JSON Schema
      // describes the INPUT, i.e. exactly what the model must emit.
      return convertNode(def.schema, path, depth + 1);
    case 'ZodPipeline':
      return convertNode(def.in, path, depth + 1);
    case 'ZodNullable': {
      const inner = convertNode(def.innerType, path, depth + 1);
      const keys = Object.keys(inner);
      if (keys.length === 1 && Array.isArray(inner.anyOf)) {
        return { anyOf: [...(inner.anyOf as unknown[]), { type: 'null' }] };
      }
      return { anyOf: [inner, { type: 'null' }] };
    }
    case 'ZodDefault': {
      const inner = convertNode(def.innerType, path, depth + 1);
      let value: unknown;
      try {
        value = def.defaultValue?.();
      } catch {
        value = undefined;
      }
      // "Preserve defaults only when semantically safe": a JSON primitive round
      // trips exactly and cannot smuggle structure the model would copy blindly.
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        inner.default = value;
      }
      return orderKeys(inner);
    }
    case 'ZodCatch':
      // `.catch()` is an ERROR fallback, not a documented default — describing
      // it as `default` would invite the model to omit the field on purpose.
      return convertNode(def.innerType, path, depth + 1);

    // ---- scalars --------------------------------------------------------
    case 'ZodString':
      return convertString(def, path);
    case 'ZodNumber':
      return convertNumber(def, path);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodAny':
    case 'ZodUnknown':
      // The permissive EMPTY SCHEMA — "any JSON value". Distinct from
      // `additionalProperties: true`, which this module never emits.
      return {};
    case 'ZodLiteral': {
      const value = def.value;
      // Single-value `enum` instead of `const`: both Anthropic and
      // OpenAI/OpenRouter accept `enum` everywhere, `const` is not universal.
      return { type: jsonTypeOf(value, path), enum: [value] };
    }
    case 'ZodEnum': {
      const values = (def.values ?? []) as readonly unknown[];
      if (!Array.isArray(values) || values.length === 0) {
        throw new ToolSchemaConversionError('enum with no values', path);
      }
      return { type: 'string', enum: [...values] };
    }
    case 'ZodNativeEnum': {
      const raw = def.values as Record<string, unknown> | undefined;
      const all = Object.values(raw ?? {});
      // TS numeric enums reverse-map (`{0:'A', A:0}`); keep only the values.
      const numeric = all.filter((v) => typeof v === 'number');
      const values = numeric.length > 0 ? numeric : all.filter((v) => typeof v === 'string');
      if (values.length === 0) {
        throw new ToolSchemaConversionError('native enum with no values', path);
      }
      return {
        type: typeof values[0] === 'number' ? 'number' : 'string',
        enum: values,
      };
    }

    // ---- containers -----------------------------------------------------
    case 'ZodArray': {
      const node: JsonObject = {
        type: 'array',
        items: convertNode(def.type, `${path}[]`, depth + 1),
      };
      if (def.exactLength) {
        node.minItems = def.exactLength.value;
        node.maxItems = def.exactLength.value;
      }
      if (def.minLength) node.minItems = def.minLength.value;
      if (def.maxLength) node.maxItems = def.maxLength.value;
      return node;
    }
    case 'ZodObject':
      return convertObject(schema, def, path, depth);
    case 'ZodRecord':
      // Intentionally dynamic map: `additionalProperties` carries the VALUE
      // schema (issue #509 §1). For `z.record(z.unknown())` the value schema is
      // the empty schema `{}` — still a schema, never boolean `true`.
      return {
        type: 'object',
        additionalProperties: convertNode(def.valueType, `${path}.<value>`, depth + 1),
      };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = unionOptions(def);
      if (options.length === 0) {
        throw new ToolSchemaConversionError('union with no options', path);
      }
      return {
        anyOf: options.map((opt, i) => convertNode(opt, `${path}|${i}`, depth + 1)),
      };
    }

    default:
      throw new ToolSchemaConversionError(
        `unsupported zod type '${String(def.typeName ?? 'unknown')}'`,
        path,
      );
  }
}

/**
 * Convert an arbitrary Zod schema into a portable JSON Schema node.
 *
 * Throws `ToolSchemaConversionError` for anything without an exact,
 * provider-portable representation. Exported for tests and for tooling that
 * needs sub-schemas; tool exposure goes through `toolInputToJsonSchema`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny, path = '$'): JsonObject {
  return convertNode(schema as unknown as ZodLike, path, 0);
}

// ============================================================
// Catalog-level checks
// ============================================================

/**
 * Walk the produced schema and reject authority-shaped property names at any
 * depth. This is defense in depth, NOT the security boundary: the boundary is
 * that the dispatcher derives identity/approval from backend state and never
 * from `args`.
 */
function assertNoForbiddenFields(node: unknown, toolName: string, path: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertNoForbiddenFields(child, toolName, `${path}[${i}]`));
    return;
  }
  const obj = node as JsonObject;
  const properties = obj.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const key of Object.keys(properties as JsonObject)) {
      if (FORBIDDEN_FIELD_NAMES.has(key) && !FORBIDDEN_FIELD_EXCEPTIONS.has(`${toolName}.${key}`)) {
        throw new ToolSchemaConversionError(
          `forbidden authority-shaped field '${key}' exposed to the model; authority comes ` +
            'from backend state (grants/permissions/approval store), never from tool args',
          `${path}.properties.${key}`,
        );
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    assertNoForbiddenFields(value, toolName, `${path}.${key}`);
  }
}

/** Reject `additionalProperties: true` anywhere — the invariant this issue exists for. */
function assertNoOpenObjects(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertNoOpenObjects(child, `${path}[${i}]`));
    return;
  }
  const obj = node as JsonObject;
  if (obj.additionalProperties === true) {
    throw new ToolSchemaConversionError(
      'additionalProperties:true is forbidden — close the object or use z.record(<value schema>)',
      path,
    );
  }
  for (const [key, value] of Object.entries(obj)) {
    assertNoOpenObjects(value, `${path}.${key}`);
  }
}

const cache = new WeakMap<AnyTool, CanonicalToolSchema>();

/**
 * Build the canonical, provider-portable schema for a tool's INPUT.
 *
 * Root contract: always `type: 'object'`. A union-rooted contract (e.g.
 * `generate_report`'s `z.discriminatedUnion('tipo', …)`) is emitted as
 * `{ type:'object', anyOf:[…closed object variants…] }` so Anthropic's
 * "input_schema.type must be object" requirement holds without losing the
 * variant structure.
 *
 * Memoized per tool object (module singletons), so conversion cost in the hot
 * path is zero after the first call.
 *
 * @throws ToolSchemaConversionError — the caller MUST drop the tool, not degrade it.
 */
export function toolInputToJsonSchema(tool: AnyTool): CanonicalToolSchema {
  const hit = cache.get(tool);
  if (hit) return hit;

  const root = zodToJsonSchema(tool.input_schema, `${tool.name}$`);

  let input_schema: JsonObject;
  if (root.type === 'object') {
    input_schema = root;
  } else if (Array.isArray(root.anyOf)) {
    const variants = root.anyOf as JsonObject[];
    if (!variants.every((v) => v.type === 'object')) {
      throw new ToolSchemaConversionError(
        'union-rooted tool input must have object-only variants',
        `${tool.name}$`,
      );
    }
    input_schema = orderKeys({ ...root, type: 'object' });
  } else {
    throw new ToolSchemaConversionError(
      `tool input root must be an object (got ${String(root.type ?? 'non-object')})`,
      `${tool.name}$`,
    );
  }

  assertNoOpenObjects(input_schema, `${tool.name}$`);
  assertNoForbiddenFields(input_schema, tool.name, `${tool.name}$`);

  const serialized = canonicalStringify(input_schema);
  const built: CanonicalToolSchema = {
    name: tool.name,
    description: tool.description,
    input_schema,
    schema_hash: schemaHash(input_schema),
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
  cache.set(tool, built);
  return built;
}

/**
 * Fail-closed wrapper used by the exposure surfaces.
 *
 * On conversion failure the tool is DROPPED from the exposed set (returns
 * `null`) — never downgraded to a permissive schema. A dropped tool is
 * invisible to the model, and the dispatcher's grant/permission guards remain
 * in force regardless. The catalog lint test (`tool-schema-catalog.spec.ts`)
 * converts every registered tool, so a conversion failure fails CI before it
 * can ever silently shrink the runtime catalog.
 */
export function buildToolSchema(tool: AnyTool): CanonicalToolSchema | null {
  const started = Date.now();
  try {
    const built = toolInputToJsonSchema(tool);
    incCounter('maia_tool_schema_build_total', { result: 'ok' });
    observeHistogram('maia_tool_schema_build_duration_ms', Date.now() - started);
    return built;
  } catch (err) {
    incCounter('maia_tool_schema_build_total', { result: 'error' });
    observeHistogram('maia_tool_schema_build_duration_ms', Date.now() - started);
    logger.error(
      { tool: tool.name, err: (err as Error).message },
      'tools.schema_build_failed',
    );
    return null;
  }
}

/** Test-only: drop the memoization so a spec can re-convert a mutated tool. */
export function _resetSchemaCacheForTests(tool: AnyTool): void {
  cache.delete(tool);
}

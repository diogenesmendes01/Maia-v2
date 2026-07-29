/**
 * Issue #509 — minimal JSON Schema validator for the EXACT subset
 * `src/tools/schema-json.ts` is allowed to emit.
 *
 * Why hand-rolled: the repo deliberately ships no JSON Schema validator
 * dependency (same call as `src/tools/describe-schema.ts`). Writing the
 * validator against our own emitted subset doubles as an executable
 * specification of that subset — if the converter ever emits a keyword this
 * file does not know, `assertOnlyKnownKeywords` fails the catalog lint and the
 * keyword gets reviewed for provider portability before it can ship.
 *
 * It is a TEST helper. Zod remains the authoritative runtime validator.
 */

export type JsonSchema = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Every keyword the canonical converter is allowed to produce. */
export const ALLOWED_KEYWORDS = new Set([
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
]);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Recursively assert the schema only uses keywords from `ALLOWED_KEYWORDS`.
 * Returns the list of offending `path: keyword` strings (empty = clean).
 */
export function unknownKeywords(schema: unknown, path = '$'): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const out: string[] = [];
  const obj = schema as JsonSchema;
  for (const [key, value] of Object.entries(obj)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      out.push(`${path}: ${key}`);
      continue;
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const [pk, pv] of Object.entries(value as JsonSchema)) {
        out.push(...unknownKeywords(pv, `${path}.${pk}`));
      }
    } else if (key === 'items' || key === 'additionalProperties') {
      out.push(...unknownKeywords(value, `${path}.${key}`));
    } else if (key === 'anyOf' && Array.isArray(value)) {
      value.forEach((v, i) => out.push(...unknownKeywords(v, `${path}|${i}`)));
    }
  }
  return out;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  // `{}` — the permissive empty schema (z.unknown()/z.any()): accepts anything.
  if (Object.keys(schema).length === 0) return;

  if (Array.isArray(schema.anyOf)) {
    const branchErrors: string[][] = [];
    for (const branch of schema.anyOf as JsonSchema[]) {
      const local: string[] = [];
      validateNode(branch, value, path, local);
      if (local.length === 0) return; // one branch matched
      branchErrors.push(local);
    }
    errors.push(`${path}: matches no anyOf branch (${branchErrors.length} tried)`);
    return;
  }

  if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected type ${schema.type}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, value))) {
    errors.push(`${path}: not in enum`);
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern`);
    }
    if (schema.format === 'uuid' && !UUID_RE.test(value)) {
      errors.push(`${path}: not a uuid`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: not a date-time`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: not above exclusiveMinimum`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: not below exclusiveMaximum`);
    }
    if (typeof schema.multipleOf === 'number' && value % schema.multipleOf !== 0) {
      errors.push(`${path}: not a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems`);
    }
    if (schema.items !== null && typeof schema.items === 'object') {
      value.forEach((item, i) =>
        validateNode(schema.items as JsonSchema, item, `${path}[${i}]`, errors),
      );
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as JsonSchema;
    for (const req of (schema.required ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${path}.${req}: required property missing`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const propSchema = properties[key];
      if (propSchema !== undefined) {
        validateNode(propSchema as JsonSchema, v, `${path}.${key}`, errors);
        continue;
      }
      const ap = schema.additionalProperties;
      if (ap === false) {
        errors.push(`${path}.${key}: additional property not allowed`);
      } else if (ap !== null && typeof ap === 'object') {
        validateNode(ap as JsonSchema, v, `${path}.${key}`, errors);
      }
    }
  }
}

/** Validate `value` against the emitted-subset `schema`. */
export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Dependency-free Zod object introspector.
 *
 * Used by the admin-ui Tools Catalog (`toolsCatalogRouter`) to render a
 * "how to use" view of each tool's input schema WITHOUT shipping Zod (or
 * the tool handlers) to the client. The tRPC procedure runs this server-side
 * and returns a plain JSON array; the page only ever consumes that.
 *
 * Why hand-rolled (not `zod-to-json-schema`): the catalog needs a flat field
 * list (`name · type · optional`), not a full JSON-Schema document, and the
 * spec (§1.3, open decision #4) deliberately avoids adding a new dependency.
 *
 * Scope: best-effort. We discriminate on Zod's internal `_def.typeName`
 * (stable across the zod@3 line). Unwraps Optional / Nullable / Default /
 * Effects (`.refine`/`.transform`); maps String / Number / Boolean / Enum /
 * Array / Object to a readable `type`. Anything unrecognised → `'unknown'`
 * rather than throwing — a catalog view must never crash on an exotic schema.
 */
import type { z } from 'zod';

export interface FieldDescriptor {
  /** The object key. */
  name: string;
  /** A short, human-readable type label (e.g. `string`, `number`, `enum(a|b)`, `string[]`). */
  type: string;
  /** True when the field is `.optional()`, `.nullable()`, or has a `.default()`. */
  optional: boolean;
}

/**
 * Minimal structural view of a zod def. We avoid importing zod's concrete
 * classes (keeps this resilient to minor-version internals) and read the
 * shape via the documented-enough `_def.typeName` discriminator.
 */
interface ZodDefLike {
  typeName?: string;
  // ZodOptional / ZodNullable / ZodReadonly / ZodBranded
  innerType?: { _def?: ZodDefLike };
  // ZodDefault
  defaultValue?: unknown;
  // ZodEffects (.refine / .transform / .preprocess)
  schema?: { _def?: ZodDefLike };
  // ZodArray
  type?: { _def?: ZodDefLike };
  // ZodEnum
  values?: readonly string[];
  // ZodNativeEnum
  values_?: unknown;
  // ZodLiteral
  value?: unknown;
}

function defOf(schema: { _def?: ZodDefLike } | undefined): ZodDefLike | undefined {
  return schema?._def;
}

/**
 * Render a base (already-unwrapped) zod def into a readable type label.
 */
function baseTypeLabel(def: ZodDefLike | undefined): string {
  switch (def?.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBigInt':
      return 'bigint';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodDate':
      return 'date';
    case 'ZodEnum': {
      const values = def.values ?? [];
      return values.length > 0 ? `enum(${values.join('|')})` : 'enum';
    }
    case 'ZodNativeEnum':
      return 'enum';
    case 'ZodLiteral':
      return `literal(${JSON.stringify(def.value)})`;
    case 'ZodArray': {
      const inner = baseTypeLabel(unwrap(defOf(def.type)));
      return `${inner}[]`;
    }
    case 'ZodObject':
      return 'object';
    case 'ZodRecord':
      return 'record';
    case 'ZodTuple':
      return 'tuple';
    case 'ZodUnion':
      return 'union';
    case 'ZodAny':
    case 'ZodUnknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Strip wrapper defs (Optional / Nullable / Default / Effects / Readonly /
 * Branded) down to the underlying base def, so `baseTypeLabel` sees the
 * concrete type. Bounded by a depth guard against pathological nesting.
 */
function unwrap(def: ZodDefLike | undefined, depth = 0): ZodDefLike | undefined {
  if (def === undefined || depth > 16) return def;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodBranded':
      return unwrap(defOf(def.innerType), depth + 1);
    case 'ZodDefault':
      return unwrap(defOf(def.innerType), depth + 1);
    case 'ZodEffects':
      return unwrap(defOf(def.schema), depth + 1);
    default:
      return def;
  }
}

/**
 * True when the field is effectively optional from a caller's perspective:
 * `.optional()`, `.nullable()`, or has a `.default()`. Looks through Effects
 * wrappers so `z.string().optional().refine(...)` still reads as optional.
 */
function isOptional(def: ZodDefLike | undefined, depth = 0): boolean {
  if (def === undefined || depth > 16) return false;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return true;
    case 'ZodReadonly':
    case 'ZodBranded':
      return isOptional(defOf(def.innerType), depth + 1);
    case 'ZodEffects':
      return isOptional(defOf(def.schema), depth + 1);
    default:
      return false;
  }
}

/**
 * Introspect a `ZodObject` into a flat field list.
 *
 * Accepts any zod type for robustness — if the schema is not a ZodObject
 * (or has no readable `.shape`), returns an empty list rather than throwing.
 */
export function describeZodObject(schema: z.ZodTypeAny): FieldDescriptor[] {
  // The input schema may itself be wrapped in Effects (e.g. a top-level
  // `.refine()` cross-field check). Unwrap to reach the ZodObject.
  const rootDef = unwrap(defOf(schema as { _def?: ZodDefLike }));
  if (rootDef?.typeName !== 'ZodObject') return [];

  // `shape` is a getter on ZodObject; reading it off the def avoids
  // depending on zod's public class surface.
  const shapeFn = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  const shape =
    typeof shapeFn === 'object' && shapeFn !== null
      ? (shapeFn as Record<string, { _def?: ZodDefLike }>)
      : undefined;
  if (!shape) return [];

  return Object.entries(shape).map(([name, fieldSchema]) => {
    const fieldDef = defOf(fieldSchema);
    return {
      name,
      type: baseTypeLabel(unwrap(fieldDef)),
      optional: isOptional(fieldDef),
    };
  });
}

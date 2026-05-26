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
  // ZodUnion / ZodDiscriminatedUnion — variant schemas. zod@3 stores these
  // as an array on `.options`; some builds key discriminated-union options by
  // their discriminator value in a Map, so we accept either.
  options?:
    | ReadonlyArray<{ _def?: ZodDefLike }>
    | Map<unknown, { _def?: ZodDefLike }>;
  // ZodDiscriminatedUnion — the field whose literal selects the variant.
  discriminator?: string;
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
 * Read the `.shape` record off a (possibly raw-def) ZodObject. Returns
 * undefined when the schema is not an object or exposes no readable shape.
 */
function shapeOf(
  schema: { _def?: ZodDefLike } | undefined,
): Record<string, { _def?: ZodDefLike }> | undefined {
  // `shape` is a getter on ZodObject; reading it off the instance avoids
  // depending on zod's public class surface.
  const shapeFn = (schema as unknown as { shape?: unknown } | undefined)?.shape;
  if (typeof shapeFn === 'object' && shapeFn !== null) {
    return shapeFn as Record<string, { _def?: ZodDefLike }>;
  }
  return undefined;
}

/** Flatten a single ZodObject's shape into field descriptors. */
function fieldsFromObject(
  schema: { _def?: ZodDefLike } | undefined,
): FieldDescriptor[] {
  const shape = shapeOf(schema);
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

/**
 * Normalise a union/discriminated-union's `.options` (array OR Map) into a
 * flat array of variant schemas.
 */
function unionOptions(
  def: ZodDefLike | undefined,
): Array<{ _def?: ZodDefLike }> {
  const opts = def?.options;
  if (opts === undefined) return [];
  if (opts instanceof Map) return Array.from(opts.values());
  if (Array.isArray(opts)) return [...opts];
  return [];
}

/**
 * Introspect a `ZodUnion` / `ZodDiscriminatedUnion` whose variants are objects
 * into a merged, deduped field list.
 *
 * Merge rules (so the catalog never shows "Inputs (0)" for a union):
 *   - The discriminator field (discriminated unions) is emitted once with a
 *     type label that enumerates the variant literals
 *     (`discriminator(extrato|comparativo)`), always required.
 *   - A field present in EVERY object variant keeps `required` only when it is
 *     non-optional in all of them; otherwise it reads as optional.
 *   - A field present in only SOME variants is marked optional (it differs by
 *     variant), with its type annotated `… (variant)`.
 * Field order follows first appearance across the variants (discriminator first).
 */
function describeUnion(def: ZodDefLike | undefined): FieldDescriptor[] {
  const variants = unionOptions(def)
    .map((v) => ({ schema: v, def: unwrap(defOf(v)) }))
    .filter((v) => v.def?.typeName === 'ZodObject');
  if (variants.length === 0) return [];

  const discriminator = def?.discriminator;
  const variantCount = variants.length;

  // Per-field accumulation across all object variants.
  type Acc = { type: string; presentIn: number; optionalIn: number };
  const order: string[] = [];
  const acc = new Map<string, Acc>();

  for (const { schema } of variants) {
    const fields = fieldsFromObject(schema);
    for (const f of fields) {
      let entry = acc.get(f.name);
      if (!entry) {
        entry = { type: f.type, presentIn: 0, optionalIn: 0 };
        acc.set(f.name, entry);
        order.push(f.name);
      }
      entry.presentIn += 1;
      if (f.optional) entry.optionalIn += 1;
    }
  }

  // The discriminator's per-variant literal values, for a readable label.
  const discriminatorLiterals: string[] = [];
  if (discriminator) {
    for (const { schema } of variants) {
      const shape = shapeOf(schema);
      const litDef = unwrap(defOf(shape?.[discriminator]));
      if (litDef?.typeName === 'ZodLiteral') {
        discriminatorLiterals.push(String(litDef.value));
      }
    }
  }

  const result: FieldDescriptor[] = [];

  // Emit the discriminator first (discriminated unions).
  if (discriminator && acc.has(discriminator)) {
    const literals = discriminatorLiterals.length > 0 ? discriminatorLiterals : undefined;
    result.push({
      name: discriminator,
      type: literals ? `discriminator(${literals.join('|')})` : 'discriminator',
      optional: false, // selecting a variant is always required
    });
  }

  for (const name of order) {
    if (name === discriminator) continue; // already emitted
    const entry = acc.get(name)!;
    const inAllVariants = entry.presentIn === variantCount;
    // Optional from the caller's perspective when: it's only in some variants,
    // OR it's optional in at least one variant it appears in.
    const optional = !inAllVariants || entry.optionalIn > 0;
    const type = inAllVariants ? entry.type : `${entry.type} (variant)`;
    result.push({ name, type, optional });
  }

  return result;
}

/**
 * Introspect a tool's input schema into a flat field list.
 *
 * Handles a top-level `ZodObject` (the common case) AND
 * `ZodUnion` / `ZodDiscriminatedUnion` of objects (e.g. `generate_report`'s
 * `z.discriminatedUnion('tipo', …)`), so a union input never silently renders
 * "Inputs (0)". Unwraps Optional/Nullable/Default/Effects wrappers first.
 *
 * Accepts any zod type for robustness — if the root is neither an object nor a
 * union of objects (or exposes no readable shape), returns an empty list
 * rather than throwing: a catalog view must never crash on an exotic schema.
 *
 * Name kept as `describeZodObject` for call-site compatibility
 * (`tools-catalog.ts`), though it now also covers unions.
 */
export function describeZodObject(schema: z.ZodTypeAny): FieldDescriptor[] {
  // The input schema may itself be wrapped in Effects (e.g. a top-level
  // `.refine()` cross-field check). Unwrap to reach the base type.
  const root = schema as { _def?: ZodDefLike };
  const rootDef = unwrap(defOf(root));

  if (rootDef?.typeName === 'ZodObject') {
    // After unwrapping, `schema` may be a wrapper (Effects/Default/…) whose
    // `.shape` getter is absent. Walk to the unwrapped instance for the shape.
    return fieldsFromObject(unwrappedInstance(root));
  }

  if (
    rootDef?.typeName === 'ZodDiscriminatedUnion' ||
    rootDef?.typeName === 'ZodUnion'
  ) {
    return describeUnion(rootDef);
  }

  return [];
}

/**
 * Walk a schema instance through its wrapper layers (Optional / Nullable /
 * Default / Effects / Readonly / Branded) to the underlying instance, so we
 * can read `.shape` off the actual ZodObject rather than a wrapper.
 */
function unwrappedInstance(
  schema: { _def?: ZodDefLike } | undefined,
  depth = 0,
): { _def?: ZodDefLike } | undefined {
  const def = defOf(schema);
  if (def === undefined || depth > 16) return schema;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodBranded':
    case 'ZodDefault':
      return unwrappedInstance(def.innerType, depth + 1);
    case 'ZodEffects':
      return unwrappedInstance(def.schema, depth + 1);
    default:
      return schema;
  }
}

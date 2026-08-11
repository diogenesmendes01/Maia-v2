/**
 * Issue #509 — canonical Zod → JSON Schema converter.
 *
 * The LLM must receive the REAL contract (names, types, required fields, enums,
 * bounds, descriptions) instead of the old generic
 * `{ type:'object', additionalProperties:true }` stub. Zod stays the single
 * source of truth AND the authoritative validator in the dispatcher; this
 * converter only DESCRIBES the input.
 *
 * These are the per-Zod-category unit tests demanded by the issue's
 * "Testes → Unitários" section.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  zodToJsonSchema,
  toolInputToJsonSchema,
  canonicalStringify,
  schemaHash,
  ToolSchemaConversionError,
} from '../../../src/tools/schema-json.js';

/** Convert a bare object schema and return the whole node. */
function conv(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema);
}

/** Convert `z.object({ f: <schema> })` and return the `f` property node. */
function prop(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = conv(z.object({ f: schema }));
  return (out.properties as Record<string, Record<string, unknown>>).f;
}

/** Convert `z.object({ f: <schema> })` and return the `required` list. */
function requiredOf(shape: z.ZodRawShape): string[] {
  return (conv(z.object(shape)).required as string[] | undefined) ?? [];
}

describe('#509 zodToJsonSchema — strings', () => {
  it('required string → type string, present in required', () => {
    expect(prop(z.string())).toEqual({ type: 'string' });
    expect(requiredOf({ f: z.string() })).toEqual(['f']);
  });

  it('optional string is NOT in required', () => {
    expect(requiredOf({ f: z.string().optional() })).toEqual([]);
  });

  it('nullable string stays required and unions with null', () => {
    expect(prop(z.string().nullable())).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(requiredOf({ f: z.string().nullable() })).toEqual(['f']);
  });

  it('min/max become minLength/maxLength', () => {
    expect(prop(z.string().min(1).max(280))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 280,
    });
  });

  it('uuid becomes format uuid', () => {
    expect(prop(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' });
  });

  it('datetime becomes format date-time', () => {
    expect(prop(z.string().datetime())).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('regex becomes pattern (source, no flags)', () => {
    expect(prop(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))).toEqual({
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    });
  });

  it('startsWith becomes an anchored pattern', () => {
    expect(prop(z.string().startsWith('br:'))).toEqual({
      type: 'string',
      pattern: '^br:',
    });
  });

  it('trim/toLowerCase are transforms with no JSON Schema keyword', () => {
    expect(prop(z.string().trim().toLowerCase())).toEqual({ type: 'string' });
  });
});

describe('#509 zodToJsonSchema — numbers', () => {
  it('plain number', () => {
    expect(prop(z.number())).toEqual({ type: 'number' });
  });

  it('int becomes integer', () => {
    expect(prop(z.number().int())).toEqual({ type: 'integer' });
  });

  it('min/max become minimum/maximum', () => {
    expect(prop(z.number().min(2).max(8))).toEqual({
      type: 'number',
      minimum: 2,
      maximum: 8,
    });
  });

  it('positive becomes exclusiveMinimum 0', () => {
    expect(prop(z.number().positive())).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
    });
  });

  it('nonnegative becomes minimum 0', () => {
    expect(prop(z.number().nonnegative())).toEqual({
      type: 'number',
      minimum: 0,
    });
  });
});

describe('#509 zodToJsonSchema — enums, literals, booleans, null', () => {
  it('enum preserves values and order', () => {
    expect(prop(z.enum(['receita', 'despesa', 'movimentacao']))).toEqual({
      type: 'string',
      enum: ['receita', 'despesa', 'movimentacao'],
    });
  });

  it('literal becomes a single-value enum (portable across providers)', () => {
    expect(prop(z.literal('extrato'))).toEqual({
      type: 'string',
      enum: ['extrato'],
    });
  });

  it('boolean', () => {
    expect(prop(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('null', () => {
    expect(prop(z.null())).toEqual({ type: 'null' });
  });
});

describe('#509 zodToJsonSchema — arrays, objects, records', () => {
  it('array with bounds', () => {
    expect(prop(z.array(z.string().uuid()).min(2).max(8))).toEqual({
      type: 'array',
      minItems: 2,
      maxItems: 8,
      items: { type: 'string', format: 'uuid' },
    });
  });

  it('nested object is CLOSED by default', () => {
    expect(prop(z.object({ a: z.string(), b: z.number().optional() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('object with no keys still closes', () => {
    expect(prop(z.object({}))).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('record maps to a TYPED additionalProperties, never boolean true', () => {
    expect(prop(z.record(z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('record of unknown maps to the permissive SCHEMA {} — still not boolean true', () => {
    expect(prop(z.record(z.unknown()))).toEqual({
      type: 'object',
      additionalProperties: {},
    });
  });

  it('passthrough objects are refused (fail-closed, no silent open object)', () => {
    expect(() => conv(z.object({ a: z.string() }).passthrough())).toThrow(
      ToolSchemaConversionError,
    );
  });
});

describe('#509 zodToJsonSchema — unions, wrappers, unknown', () => {
  it('union becomes anyOf', () => {
    expect(prop(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('discriminated union becomes anyOf of closed objects with const-like enums', () => {
    const schema = z.discriminatedUnion('tipo', [
      z.object({ tipo: z.literal('a'), x: z.string() }),
      z.object({ tipo: z.literal('b'), y: z.number() }),
    ]);
    expect(conv(schema)).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { tipo: { type: 'string', enum: ['a'] }, x: { type: 'string' } },
          required: ['tipo', 'x'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { tipo: { type: 'string', enum: ['b'] }, y: { type: 'number' } },
          required: ['tipo', 'y'],
          additionalProperties: false,
        },
      ],
    });
  });

  it('default is preserved for primitives and drops the field from required', () => {
    expect(prop(z.enum(['whatsapp', 'manual']).default('whatsapp'))).toEqual({
      type: 'string',
      enum: ['whatsapp', 'manual'],
      default: 'whatsapp',
    });
    expect(requiredOf({ f: z.string().default('x') })).toEqual([]);
  });

  it('catch behaves like default (not required)', () => {
    expect(requiredOf({ f: z.string().catch('x') })).toEqual([]);
  });

  it('refine/transform convert their INPUT schema (what the model sends)', () => {
    expect(prop(z.string().min(3).refine((s) => s !== 'no'))).toEqual({
      type: 'string',
      minLength: 3,
    });
  });

  it('unknown/any become the permissive empty schema and are NOT required', () => {
    expect(prop(z.unknown())).toEqual({});
    expect(requiredOf({ f: z.unknown() })).toEqual([]);
  });

  it('describe() lands on the node', () => {
    expect(prop(z.string().describe('ISO date, YYYY-MM-DD'))).toEqual({
      type: 'string',
      description: 'ISO date, YYYY-MM-DD',
    });
  });

  it('describe() on the wrapper still lands on the node', () => {
    expect(prop(z.string().optional().describe('opcional'))).toEqual({
      type: 'string',
      description: 'opcional',
    });
  });
});

describe('#509 zodToJsonSchema — fail-closed on unsupported constructs', () => {
  it('rejects a tuple', () => {
    expect(() => conv(z.object({ f: z.tuple([z.string()]) }))).toThrow(
      ToolSchemaConversionError,
    );
  });

  it('rejects a lazy/recursive schema', () => {
    const lazy: z.ZodTypeAny = z.lazy(() => z.object({ f: lazy.optional() }));
    expect(() => conv(z.object({ f: lazy }))).toThrow(ToolSchemaConversionError);
  });

  it('rejects a bigint', () => {
    expect(() => conv(z.object({ f: z.bigint() }))).toThrow(ToolSchemaConversionError);
  });
});

describe('#509 toolInputToJsonSchema — root contract, denylist, hash', () => {
  const baseTool = {
    name: 't',
    description: 'd',
    output_schema: z.object({}),
    required_actions: [],
    side_effect: 'none',
    redis_required: false,
    operation_type: 'read',
    audit_action: 'tool_called',
    handler: async () => ({}),
  } as unknown as Record<string, unknown>;

  function tool(input: z.ZodTypeAny, name = 't') {
    return { ...baseTool, name, input_schema: input } as never;
  }

  it('object root produces a closed object schema + deterministic hash', () => {
    const out = toolInputToJsonSchema(
      tool(z.object({ a: z.string() }), 'root_object'),
    );
    expect(out.input_schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(out.schema_hash).toMatch(/^[0-9a-f]{16}$/);
    // Same contract → same hash (deterministic, cache-safe).
    expect(
      toolInputToJsonSchema(tool(z.object({ a: z.string() }), 'root_object_2'))
        .schema_hash,
    ).toBe(out.schema_hash);
  });

  it('union root is wrapped so the root type stays "object" (Anthropic requires it)', () => {
    const out = toolInputToJsonSchema(
      tool(
        z.discriminatedUnion('tipo', [
          z.object({ tipo: z.literal('a'), x: z.string() }),
          z.object({ tipo: z.literal('b'), y: z.number() }),
        ]),
        'root_union',
      ),
    );
    expect(out.input_schema.type).toBe('object');
    expect(Array.isArray(out.input_schema.anyOf)).toBe(true);
  });

  it('refuses a non-object, non-union root', () => {
    expect(() => toolInputToJsonSchema(tool(z.string(), 'bad_root'))).toThrow(
      ToolSchemaConversionError,
    );
  });

  it('refuses authority-shaped property names (defense in depth)', () => {
    for (const forbidden of [
      'approved',
      'dual_approval_granted',
      'is_owner',
      'tenant_id',
      'agent_id',
      'auth_token',
      'api_key',
    ]) {
      expect(() =>
        toolInputToJsonSchema(
          tool(z.object({ [forbidden]: z.string() }), `deny_${forbidden}`),
        ),
      ).toThrow(ToolSchemaConversionError);
    }
  });

  it('refuses authority-shaped names nested deep in the schema', () => {
    expect(() =>
      toolInputToJsonSchema(
        tool(
          z.object({ outer: z.object({ inner: z.object({ approved: z.boolean() }) }) }),
          'deny_nested',
        ),
      ),
    ).toThrow(ToolSchemaConversionError);
  });

  it('caches per tool object (same reference returned)', () => {
    const t = tool(z.object({ a: z.string() }), 'cached');
    expect(toolInputToJsonSchema(t)).toBe(toolInputToJsonSchema(t));
  });
});

describe('#509 canonicalStringify / schemaHash', () => {
  it('is key-order independent', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
    expect(schemaHash({ b: 1, a: 2 })).toBe(schemaHash({ a: 2, b: 1 }));
  });

  it('is sensitive to values', () => {
    expect(schemaHash({ a: 1 })).not.toBe(schemaHash({ a: 2 }));
  });

  it('preserves array order', () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });
});

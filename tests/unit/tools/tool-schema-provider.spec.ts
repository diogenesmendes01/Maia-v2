/**
 * Issue #509 §3 — provider compatibility.
 *
 * Anthropic and OpenAI/OpenRouter must receive the EQUIVALENT contract from the
 * one canonical schema. Strict mode is attached only where the BACKEND
 * capability matrix confirms support; everywhere else the canonical schema goes
 * out unchanged and Zod revalidation carries the weight.
 */
import { describe, it, expect } from 'vitest';
import {
  supportsStrictToolSchemas,
  toStrictJsonSchema,
  STRICT_CAPABLE_MODEL_PREFIXES,
} from '../../../src/lib/tool-schema-provider.js';
import { toOpenAITools, type ToolSchema } from '../../../src/lib/claude.js';
import { toolInputToJsonSchema } from '../../../src/tools/schema-json.js';
import { REGISTRY } from '../../../src/tools/_registry.js';

describe('#509 capability matrix — decided by the backend, never by the model', () => {
  it('anthropic never claims strict support (no such flag on the Messages API)', () => {
    expect(supportsStrictToolSchemas('anthropic', 'claude-sonnet-4-6')).toBe(false);
    expect(supportsStrictToolSchemas('anthropic', 'openai/gpt-4.1')).toBe(false);
  });

  it('openrouter: only the allowlisted model families', () => {
    expect(supportsStrictToolSchemas('openrouter', 'openai/gpt-4.1')).toBe(true);
    expect(supportsStrictToolSchemas('openrouter', 'openai/gpt-4o-mini')).toBe(true);
    expect(supportsStrictToolSchemas('openrouter', 'anthropic/claude-sonnet-4.6')).toBe(false);
    expect(supportsStrictToolSchemas('openrouter', 'meta-llama/llama-3.1-70b')).toBe(false);
    expect(supportsStrictToolSchemas('openrouter', undefined)).toBe(false);
    expect(supportsStrictToolSchemas('openrouter', '')).toBe(false);
  });

  it('the matrix is a non-empty, lowercase, prefix-matched constant', () => {
    expect(STRICT_CAPABLE_MODEL_PREFIXES.length).toBeGreaterThan(0);
    for (const p of STRICT_CAPABLE_MODEL_PREFIXES) expect(p).toBe(p.toLowerCase());
  });
});

describe('#509 toStrictJsonSchema', () => {
  it('marks every property required and nulls the optional ones', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(strict).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('drops unsupported keywords but restates them in the description', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: {
        v: { type: 'number', exclusiveMinimum: 0, description: 'valor' },
        d: { type: 'string', pattern: '^x$' },
      },
      required: ['v', 'd'],
      additionalProperties: false,
    })!;
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.v.exclusiveMinimum).toBeUndefined();
    expect(String(props.v.description)).toContain('exclusiveMinimum=0');
    expect(props.d.pattern).toBeUndefined();
    expect(String(props.d.description)).toContain('pattern');
  });

  it('refuses a union-rooted contract (strict mode has no root anyOf)', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        anyOf: [
          { type: 'object', properties: {}, additionalProperties: false },
          { type: 'object', properties: {}, additionalProperties: false },
        ],
      }),
    ).toBeNull();
  });

  it('refuses a dynamic map (additionalProperties must be exactly false)', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: { m: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['m'],
        additionalProperties: false,
      }),
    ).toBeNull();
  });

  it('refuses an untyped value (z.unknown)', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: { any: {} },
        required: ['any'],
        additionalProperties: false,
      }),
    ).toBeNull();
  });

  it('recurses into arrays and closes nested objects', () => {
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          maxItems: 3,
          items: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
        },
      },
      required: ['list'],
      additionalProperties: false,
    })!;
    const list = (strict.properties as Record<string, Record<string, unknown>>).list;
    expect(list.maxItems).toBeUndefined();
    expect((list.items as Record<string, unknown>).additionalProperties).toBe(false);
  });
});

describe('#509 toOpenAITools — function shape + strict rollout', () => {
  const tools: ToolSchema[] = [
    {
      name: 't1',
      description: 'd1',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'string', maxLength: 3 } },
        required: ['a'],
        additionalProperties: false,
      },
    },
  ];

  it('without a model: unchanged legacy behaviour, no strict flag', () => {
    const out = toOpenAITools(tools)!;
    expect(out[0].function.parameters).toBe(tools[0].input_schema);
    expect((out[0].function as Record<string, unknown>).strict).toBeUndefined();
  });

  it('non-strict-capable model: canonical schema, no strict flag', () => {
    const out = toOpenAITools(tools, 'anthropic/claude-sonnet-4.6')!;
    expect(out[0].function.parameters).toEqual(tools[0].input_schema);
    expect((out[0].function as Record<string, unknown>).strict).toBeUndefined();
  });

  it('strict-capable model: strict subset + strict:true', () => {
    const out = toOpenAITools(tools, 'openai/gpt-4.1')!;
    expect((out[0].function as Record<string, unknown>).strict).toBe(true);
    const params = out[0].function.parameters as Record<string, unknown>;
    expect(params.additionalProperties).toBe(false);
    expect((params.properties as Record<string, Record<string, unknown>>).a.maxLength).toBeUndefined();
  });

  it('strict-capable model + non-convertible schema: falls back without strict', () => {
    const union: ToolSchema[] = [
      {
        name: 'u',
        description: 'u',
        input_schema: toolInputToJsonSchema(REGISTRY.register_transaction!).input_schema,
      },
    ];
    // register_transaction carries `metadata: z.record(z.unknown())` → a dynamic
    // map, which strict mode cannot express.
    const out = toOpenAITools(union, 'openai/gpt-4.1')!;
    expect((out[0].function as Record<string, unknown>).strict).toBeUndefined();
    expect(out[0].function.parameters).toEqual(union[0].input_schema);
  });
});

describe('#509 provider equivalence — both providers get the same contract', () => {
  it('anthropic input_schema === openai parameters when strict is not applied', () => {
    const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
    const anthropic = { name: built.name, description: built.description, input_schema: built.input_schema };
    const openai = toOpenAITools([anthropic], 'anthropic/claude-sonnet-4.6')!;
    expect(openai[0].function.name).toBe(anthropic.name);
    expect(openai[0].function.description).toBe(anthropic.description);
    expect(openai[0].function.parameters).toEqual(anthropic.input_schema);
  });

  it('strict adaptation never loosens: required only grows, objects stay closed', () => {
    const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
    const strict = toStrictJsonSchema(built.input_schema)!;
    const before = new Set((built.input_schema.required ?? []) as string[]);
    const after = new Set((strict.required ?? []) as string[]);
    for (const key of before) expect(after.has(key)).toBe(true);
    expect(strict.additionalProperties).toBe(false);
  });
});

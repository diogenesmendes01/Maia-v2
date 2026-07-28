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
  describeProviderPayload,
  STRICT_CAPABLE_MODEL_PREFIXES,
} from '../../../src/lib/tool-schema-provider.js';
import { toOpenAITools, type ToolSchema } from '../../../src/lib/claude.js';
import { toolInputToJsonSchema } from '../../../src/tools/schema-json.js';
import { REGISTRY } from '../../../src/tools/_registry.js';

const UUID = '11111111-2222-4333-8444-555555555555';

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
    // `b` is optional AND null-safe (`anyOf` already admits null), so promoting
    // it to `required` accepts exactly what Zod accepts.
    const strict = toStrictJsonSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['a'],
      additionalProperties: false,
    });
    expect(strict).toEqual({
      ok: true,
      schema: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    });
  });

  it('drops unsupported keywords but restates them in the description', () => {
    const res = toStrictJsonSchema({
      type: 'object',
      properties: {
        v: { type: 'number', exclusiveMinimum: 0, description: 'valor' },
        d: { type: 'string', pattern: '^x$' },
      },
      required: ['v', 'd'],
      additionalProperties: false,
    });
    expect(res.ok).toBe(true);
    const props = (res as { schema: Record<string, unknown> }).schema.properties as Record<
      string,
      Record<string, unknown>
    >;
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
    ).toEqual({ ok: false, reason: 'union_root' });
  });

  it('refuses a dynamic map (additionalProperties must be exactly false)', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: { m: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['m'],
        additionalProperties: false,
      }),
    ).toEqual({ ok: false, reason: 'dynamic_map' });
  });

  it('refuses an untyped value (z.unknown)', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: { any: {} },
        required: ['any'],
        additionalProperties: false,
      }),
    ).toEqual({ ok: false, reason: 'untyped_value' });
  });

  it('recurses into arrays and closes nested objects', () => {
    const res = toStrictJsonSchema({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
            additionalProperties: false,
          },
        },
      },
      required: ['list'],
      additionalProperties: false,
    });
    expect(res.ok).toBe(true);
    const schema = (res as { schema: Record<string, unknown> }).schema;
    const list = (schema.properties as Record<string, Record<string, unknown>>).list;
    expect(list.maxItems).toBeUndefined();
    expect((list.items as Record<string, unknown>).additionalProperties).toBe(false);
  });
});

/**
 * PR #530 review round 1, [P1] — the equivalence guard.
 *
 * Strict mode cannot express "optional". Forcing the key and widening it with
 * `{type:'null'}` (what the adapter used to do) makes the schema shown to the
 * model CONTRADICT the authoritative Zod contract: under constrained decoding
 * the model is forced to emit the key, legitimately emits `null` to mean
 * "absent", and the dispatcher rejects the whole call as `invalid_args`.
 *
 * The adapter must therefore REFUSE strict for such a contract instead of
 * shipping one that cannot be satisfied.
 */
describe('#530 P1 — strict never contradicts the Zod contract', () => {
  it('the divergence is real: Zod REJECTS null on an optional non-nullable field', () => {
    // `cancel_transaction.motivo` is `.optional()` and NOT `.nullable()`.
    const zod = REGISTRY.cancel_transaction!.input_schema;
    expect(zod.safeParse({ entidade_id: UUID, transacao_id: UUID }).success).toBe(true);
    expect(zod.safeParse({ entidade_id: UUID, transacao_id: UUID, motivo: null }).success).toBe(
      false,
    );
  });

  it('refuses strict for a contract with an optional non-nullable field', () => {
    const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
    expect(toStrictJsonSchema(built.input_schema)).toEqual({
      ok: false,
      reason: 'optional_not_null_safe',
    });
  });

  it('end to end: a strict-capable model gets NO strict flag for such a tool', () => {
    const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
    const out = toOpenAITools(
      [{ name: built.name, description: built.description, input_schema: built.input_schema }],
      'openai/gpt-4.1',
    )!;
    expect((out[0].function as Record<string, unknown>).strict).toBeUndefined();
    // And the canonical schema goes out untouched — `motivo` is NOT forced.
    const params = out[0].function.parameters as Record<string, unknown>;
    expect(params).toEqual(built.input_schema);
    expect(params.required).toEqual(['entidade_id', 'transacao_id']);
  });

  it('every field the strict copy forces is one Zod accepts as null', () => {
    // The only shape that survives: optional AND nullable.
    const nullSafe = toStrictJsonSchema({
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['req'],
      additionalProperties: false,
    });
    expect(nullSafe.ok).toBe(true);
    expect((nullSafe as { schema: Record<string, unknown> }).schema.required).toEqual([
      'req',
      'opt',
    ]);
  });

  it('a `.default()` field is refused too (Zod fills it on ABSENCE, not on null)', () => {
    // `register_transaction.origem` is `z.enum([...]).default('whatsapp')`:
    // optional to the caller, but `null` is not a legal value for it.
    const zod = REGISTRY.register_transaction!.input_schema;
    expect(
      zod.safeParse({
        entidade_id: UUID,
        conta_id: UUID,
        natureza: 'despesa',
        valor: 1,
        data_competencia: '2026-03-01',
        status: 'paga',
        descricao: 'x',
        origem: null,
      }).success,
    ).toBe(false);
    const built = toolInputToJsonSchema(REGISTRY.register_transaction!);
    expect(toStrictJsonSchema(built.input_schema).ok).toBe(false);
  });

  it('nested objects are guarded too, not just the root', () => {
    expect(
      toStrictJsonSchema({
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: { inner: { type: 'string' } },
            additionalProperties: false,
          },
        },
        required: ['outer'],
        additionalProperties: false,
      }),
    ).toEqual({ ok: false, reason: 'optional_not_null_safe' });
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
    // A null-safe contract — the only kind the adapter will now render strict.
    const canonical = {
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['req'],
      additionalProperties: false,
    };
    const res = toStrictJsonSchema(canonical);
    expect(res.ok).toBe(true);
    const strict = (res as { schema: Record<string, unknown> }).schema;
    const before = new Set(canonical.required);
    const after = new Set((strict.required ?? []) as string[]);
    for (const key of before) expect(after.has(key)).toBe(true);
    expect(strict.additionalProperties).toBe(false);
  });
});

/**
 * PR #530 review round 1, [P2] — the audited hash must identify the payload
 * that went on the wire, not the pre-adaptation contract.
 */
describe('#530 P2 — provider payload identity', () => {
  const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
  const canonical = [
    { name: built.name, description: built.description, input_schema: built.input_schema },
  ];

  it('canonical_hash matches the audited canonical digest for the same set', async () => {
    const { describeExposedSchemas } = await import('../../../src/tools/_registry.js');
    const audited = describeExposedSchemas(['cancel_transaction'], 'test');
    const digest = describeProviderPayload({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      canonical,
      payload: canonical,
      strictCount: 0,
    });
    // The join key between the audit row and the wire payload.
    expect(digest.canonical_hash).toBe(audited.set_hash);
  });

  it('a pass-through envelope (anthropic) reports mode canonical', () => {
    const digest = describeProviderPayload({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      canonical,
      payload: canonical,
      strictCount: 0,
    });
    expect(digest.mode).toBe('canonical');
    expect(digest.tools).toBe(1);
    expect(digest.provider_payload_bytes).toBeGreaterThan(0);
    expect(digest.provider_payload_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the OpenAI envelope has a DIFFERENT payload hash than the canonical one', () => {
    const payload = toOpenAITools(canonical, 'anthropic/claude-sonnet-4.6')!;
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      canonical,
      payload,
      strictCount: 0,
    });
    // This is the whole point of the finding: the two identify different things,
    // so recording only one of them cannot describe what the model saw.
    expect(digest.provider_payload_hash).not.toBe(digest.canonical_hash);
  });

  it('a strict rewrite changes the payload hash and reports mode strict', () => {
    const nullSafe = [
      {
        name: 'ns',
        description: 'ns',
        input_schema: {
          type: 'object',
          properties: {
            req: { type: 'string' },
            opt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['req'],
          additionalProperties: false,
        },
      },
    ];
    const plain = toOpenAITools(nullSafe, 'anthropic/claude-sonnet-4.6')!;
    const strict = toOpenAITools(nullSafe, 'openai/gpt-4.1')!;
    expect((strict[0] as { function: { strict?: boolean } }).function.strict).toBe(true);

    const base = { provider: 'openrouter', canonical: nullSafe };
    const plainDigest = describeProviderPayload({
      ...base,
      model: 'anthropic/claude-sonnet-4.6',
      payload: plain,
      strictCount: 0,
    });
    const strictDigest = describeProviderPayload({
      ...base,
      model: 'openai/gpt-4.1',
      payload: strict,
      strictCount: 1,
    });

    // Same contract on both sides…
    expect(strictDigest.canonical_hash).toBe(plainDigest.canonical_hash);
    // …different bytes on the wire, and the mode says why.
    expect(strictDigest.provider_payload_hash).not.toBe(plainDigest.provider_payload_hash);
    expect(strictDigest.mode).toBe('strict');
    expect(plainDigest.mode).toBe('canonical');
  });

  it('mode is "mixed" when only some tools went strict', () => {
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      canonical: [...canonical, { name: 'b', description: 'b', input_schema: { type: 'object' } }],
      payload: [],
      strictCount: 1,
    });
    expect(digest.mode).toBe('mixed');
  });

  it('the digest carries identity only — no schema bodies', () => {
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      canonical,
      payload: toOpenAITools(canonical, 'openai/gpt-4.1')!,
      strictCount: 0,
    });
    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain('properties');
    expect(serialized).not.toContain('entidade_id');
    expect(Object.keys(digest).sort()).toEqual([
      'canonical_hash',
      'mode',
      'model',
      'provider',
      'provider_payload_bytes',
      'provider_payload_hash',
      'tools',
    ]);
  });
});

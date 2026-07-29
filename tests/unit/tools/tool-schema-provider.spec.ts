/**
 * Issue #509 §3 — provider compatibility.
 *
 * Anthropic and OpenAI/OpenRouter must receive the EQUIVALENT contract from the
 * one canonical schema. Strict mode is attached only where the BACKEND
 * capability matrix confirms support; everywhere else the canonical schema goes
 * out unchanged and Zod revalidation carries the weight.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  supportsStrictToolSchemas,
  toStrictJsonSchema,
  describeProviderPayload,
  recordProviderPayload,
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
 * PR #530 review, [P2] — the recorded identity must describe the contract that
 * went on the wire, and the two hashes must be COMPARABLE (round 2: they were
 * taken over different domains, so equality was unreachable and the documented
 * "equal ⇒ pass-through" property was not real).
 *
 * `effective` is the schemas as they appear inside the payload, so both hashes
 * are now taken over the same `{name → schema hash}` projection.
 */
describe('#530 P2 — provider payload identity', () => {
  const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
  const canonical = [
    { name: built.name, description: built.description, input_schema: built.input_schema },
  ];
  const asEffective = (tools: typeof canonical) =>
    tools.map((t) => ({ name: t.name, schema: t.input_schema }));

  /** Extract the effective schemas out of an OpenAI-shaped payload. */
  const effectiveOfOpenAI = (payload: ReturnType<typeof toOpenAITools>) =>
    (payload ?? []).map((t) => {
      const fn = (t as { function?: { name?: string; parameters?: Record<string, unknown> } })
        .function;
      return { name: fn?.name ?? '', schema: fn?.parameters ?? {} };
    });

  it('canonical_hash matches the audited canonical digest for the same set', async () => {
    const { describeExposedSchemas } = await import('../../../src/tools/_registry.js');
    const audited = describeExposedSchemas(['cancel_transaction'], 'test');
    const digest = describeProviderPayload({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      canonical,
      effective: asEffective(canonical),
      payload: canonical,
      strictCount: 0,
    });
    // The join key between the audit row and the wire payload.
    expect(digest.canonical_hash).toBe(audited.set_hash);
  });

  it('anthropic pass-through: the two hashes are EQUAL and rewritten is false', () => {
    const digest = describeProviderPayload({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      canonical,
      effective: asEffective(canonical),
      payload: canonical,
      strictCount: 0,
    });
    expect(digest.mode).toBe('canonical');
    expect(digest.tools).toBe(1);
    expect(digest.provider_payload_bytes).toBeGreaterThan(0);
    expect(digest.provider_schema_hash).toMatch(/^[0-9a-f]{16}$/);
    // The property the docs claim — and it is now reachable.
    expect(digest.provider_schema_hash).toBe(digest.canonical_hash);
    expect(digest.rewritten).toBe(false);
  });

  it('openai pass-through (non-strict model): hashes EQUAL despite the different envelope', () => {
    // The envelope shape changes ({function:{parameters}}), the CONTRACT does
    // not. Round 1 hashed the envelope and so reported a false difference here.
    const payload = toOpenAITools(canonical, 'anthropic/claude-sonnet-4.6');
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      canonical,
      effective: effectiveOfOpenAI(payload),
      payload,
      strictCount: 0,
    });
    expect(digest.provider_schema_hash).toBe(digest.canonical_hash);
    expect(digest.rewritten).toBe(false);
  });

  it('a strict rewrite makes the hashes DIFFER and sets rewritten', () => {
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
    const plain = toOpenAITools(nullSafe, 'anthropic/claude-sonnet-4.6');
    const strict = toOpenAITools(nullSafe, 'openai/gpt-4.1')!;
    expect((strict[0] as { function: { strict?: boolean } }).function.strict).toBe(true);

    const plainDigest = describeProviderPayload({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      canonical: nullSafe,
      effective: effectiveOfOpenAI(plain),
      payload: plain,
      strictCount: 0,
    });
    const strictDigest = describeProviderPayload({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      canonical: nullSafe,
      effective: effectiveOfOpenAI(strict),
      payload: strict,
      strictCount: 1,
    });

    // Same contract on both sides…
    expect(strictDigest.canonical_hash).toBe(plainDigest.canonical_hash);
    // …but only the strict one rewrote it, and that is now DETECTABLE.
    expect(plainDigest.rewritten).toBe(false);
    expect(strictDigest.rewritten).toBe(true);
    expect(strictDigest.provider_schema_hash).not.toBe(strictDigest.canonical_hash);
    expect(strictDigest.mode).toBe('strict');
    expect(plainDigest.mode).toBe('canonical');
  });

  it('a dropped or renamed tool is caught too (the projection is keyed by name)', () => {
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'x',
      canonical,
      effective: [], // the envelope lost the tool
      payload: [],
      strictCount: 0,
    });
    expect(digest.rewritten).toBe(true);
  });

  it('mode is "mixed" when only some tools went strict', () => {
    const two = [...canonical, { name: 'b', description: 'b', input_schema: { type: 'object' } }];
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      canonical: two,
      effective: asEffective(two),
      payload: [],
      strictCount: 1,
    });
    expect(digest.mode).toBe('mixed');
    // `mode` and `rewritten` are independent axes: strict was requested for one
    // tool, yet no contract actually changed in this synthetic case.
    expect(digest.rewritten).toBe(false);
  });

  it('the digest carries identity only — no schema bodies', () => {
    const payload = toOpenAITools(canonical, 'openai/gpt-4.1');
    const digest = describeProviderPayload({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      canonical,
      effective: effectiveOfOpenAI(payload),
      payload,
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
      'provider_schema_hash',
      'rewritten',
      'tools',
    ]);
  });
});

/**
 * PR #530 review round 2, [P2 partial] — the digest must survive the DEFAULT log
 * level. `LOG_LEVEL` defaults to `info`, so a `logger.debug` line simply does
 * not exist in production, and nobody raises the level before an incident.
 *
 * This spec runs with NO log-level override — it asserts against whatever the
 * default config produces.
 */
describe('#530 P2 — the payload digest is retained at the DEFAULT log level', () => {
  const built = toolInputToJsonSchema(REGISTRY.cancel_transaction!);
  const canonical = [
    { name: built.name, description: built.description, input_schema: built.input_schema },
  ];

  it('the default LOG_LEVEL is info, so debug lines are dropped', async () => {
    const { config } = await import('../../../src/config/env.js');
    const { logger } = await import('../../../src/lib/logger.js');
    expect(config.LOG_LEVEL).toBe('info');
    // The precise reason the round-1 placement was invisible.
    expect(logger.isLevelEnabled('debug')).toBe(false);
    expect(logger.isLevelEnabled('info')).toBe(true);
  });

  it('recordProviderPayload emits at a retained level AND as a bounded metric', async () => {
    const { logger } = await import('../../../src/lib/logger.js');
    const { renderPrometheus, _resetForTests } = await import('../../../src/lib/metrics.js');
    _resetForTests();
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const digest = describeProviderPayload({
        provider: 'openrouter',
        model: 'openai/gpt-4.1',
        canonical,
        effective: [],
        payload: [],
        strictCount: 0,
      });
      recordProviderPayload(digest);

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0]![0]).toMatchObject({
        canonical_hash: digest.canonical_hash,
        provider_schema_hash: digest.provider_schema_hash,
        rewritten: true,
      });
      expect(infoSpy.mock.calls[0]![1]).toBe('llm.tool_payload');

      const scraped = await renderPrometheus();
      expect(scraped).toContain('maia_tool_schema_provider_payload_total');
      expect(scraped).toContain('rewritten="true"');
      // Bounded labels only — never a hash (unbounded cardinality).
      expect(scraped).not.toContain(digest.canonical_hash);
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      _resetForTests();
    }
  });
});

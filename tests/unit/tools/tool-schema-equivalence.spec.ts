/**
 * Issue #509 — CONTRACT tests: JSON Schema × Zod equivalence.
 *
 * The JSON Schema is what the model is told; Zod is what the dispatcher
 * enforces. Where they can disagree, the difference must be documented and
 * resolved in favour of the MORE RESTRICTIVE side (the issue's "Contrato"
 * section). Two divergences exist by construction and are asserted here:
 *
 *   1. `additionalProperties:false` — JSON Schema REJECTS unknown keys while
 *      Zod's default `.strip()` silently drops them. Stricter side wins: the
 *      model is told not to invent fields, and Zod still cannot be tricked into
 *      forwarding them to a handler.
 *   2. `.refine()` — a cross-field / semantic predicate has no JSON Schema
 *      keyword, so JSON Schema is more permissive there. Zod remains the
 *      authority (`_dispatcher.ts:172`), and the predicate is restated in the
 *      field `description` (see `schedule-reminder.ts`).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildToolCatalog, REGISTRY } from '../../../src/tools/_registry.js';
import { toolInputToJsonSchema } from '../../../src/tools/schema-json.js';
import { validate } from '../../helpers/json-schema-validator.js';

const catalog = buildToolCatalog();

/**
 * True when the tool's ROOT schema is a `ZodEffects` — i.e. it carries a
 * top-level `.refine()` such as "at least one of these optional fields".
 * That predicate has no portable JSON Schema keyword, so for these tools Zod is
 * legitimately STRICTER than the schema shown to the model. The tools in this
 * class must state the rule in the root `description` (issue #509 §6).
 */
function hasRootRefine(tool: { input_schema: { _def?: { typeName?: string } } }): boolean {
  return tool.input_schema._def?.typeName === 'ZodEffects';
}

describe('#509 equivalence — required-set never drifts from Zod', () => {
  it.each(catalog.map((e) => [e.tool.name, e.tool] as const))(
    '%s: the empty payload {} is accepted/rejected consistently',
    (_name, tool) => {
      const built = toolInputToJsonSchema(tool);
      const jsonOk = validate(built.input_schema, {}).valid;
      const zodOk = tool.input_schema.safeParse({}).success;
      if (hasRootRefine(tool as never)) {
        // Documented divergence, resolved in favour of the stricter side (Zod):
        // whatever Zod accepts, the schema must also accept — never the reverse
        // failing silently. And the cross-field rule must be stated in prose.
        if (zodOk) expect(jsonOk).toBe(true);
        expect(typeof built.input_schema.description).toBe('string');
      } else {
        expect(jsonOk).toBe(zodOk);
      }
    },
  );

  it.each(catalog.map((e) => [e.tool.name, e.tool] as const))(
    '%s: JSON Schema rejects an unknown field (stricter than Zod strip)',
    (_name, tool) => {
      const schema = toolInputToJsonSchema(tool).input_schema;
      expect(validate(schema, { __not_a_real_field__: 'x' }).valid).toBe(false);
    },
  );

  it.each(catalog.map((e) => [e.tool.name, e.tool] as const))(
    '%s: dropping any single required field is rejected by BOTH',
    (_name, tool) => {
      const built = toolInputToJsonSchema(tool);
      const required = (built.input_schema.required ?? []) as string[];
      if (required.length === 0) return;
      for (const missing of required) {
        // A payload carrying every required key EXCEPT one, with values that are
        // deliberately unconstrained-but-present. Both validators must reject
        // because of the MISSING key, whatever they think of the others.
        const payload: Record<string, unknown> = {};
        for (const key of required) if (key !== missing) payload[key] = null;
        expect(validate(built.input_schema, payload).valid).toBe(false);
        expect(tool.input_schema.safeParse(payload).success).toBe(false);
      }
    },
  );
});

const UUID = '11111111-2222-4333-8444-555555555555';

const VALID_REGISTER = {
  entidade_id: UUID,
  conta_id: UUID,
  natureza: 'despesa',
  valor: 12.5,
  data_competencia: '2026-03-01',
  status: 'paga',
  descricao: 'almoço',
};

describe('#509 equivalence — register_transaction golden payloads', () => {
  const tool = REGISTRY.register_transaction!;
  const schema = toolInputToJsonSchema(tool).input_schema;

  it('a valid payload passes BOTH', () => {
    expect(validate(schema, VALID_REGISTER).errors).toEqual([]);
    expect(tool.input_schema.safeParse(VALID_REGISTER).success).toBe(true);
  });

  it.each([
    ['missing required field', { ...VALID_REGISTER, descricao: undefined }],
    ['invalid enum', { ...VALID_REGISTER, natureza: 'transferencia' }],
    ['non-positive valor', { ...VALID_REGISTER, valor: 0 }],
    ['bad uuid', { ...VALID_REGISTER, entidade_id: 'not-a-uuid' }],
    ['bad date format', { ...VALID_REGISTER, data_competencia: '01/03/2026' }],
    ['descricao over maxLength', { ...VALID_REGISTER, descricao: 'x'.repeat(281) }],
    ['wrong type for valor', { ...VALID_REGISTER, valor: '12.5' }],
  ])('%s is rejected by BOTH', (_label, payload) => {
    const cleaned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(validate(schema, cleaned).valid).toBe(false);
    expect(tool.input_schema.safeParse(cleaned).success).toBe(false);
  });

  it('an extra field is rejected by JSON Schema and stripped by Zod (stricter side documented)', () => {
    const payload = { ...VALID_REGISTER, hacked: true };
    expect(validate(schema, payload).valid).toBe(false);
    const parsed = tool.input_schema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(Object.hasOwn(parsed.data as object, 'hacked')).toBe(false);
  });

  it('optional metadata accepts an arbitrary map in BOTH', () => {
    const payload = { ...VALID_REGISTER, metadata: { nfe: '123', tags: ['a'] } };
    expect(validate(schema, payload).errors).toEqual([]);
    expect(tool.input_schema.safeParse(payload).success).toBe(true);
  });
});

describe('#509 equivalence — generate_report discriminated union', () => {
  const entry = catalog.find((e) => e.tool.name === 'generate_report')!;
  const tool = entry.tool;
  const schema = toolInputToJsonSchema(tool).input_schema;

  it('the extrato variant passes BOTH', () => {
    const payload = {
      tipo: 'extrato',
      entidade_id: UUID,
      date_from: '2026-01-01',
      date_to: '2026-01-31',
    };
    expect(validate(schema, payload).errors).toEqual([]);
    expect(tool.input_schema.safeParse(payload).success).toBe(true);
  });

  it('mixing fields across variants is rejected by BOTH', () => {
    const payload = {
      tipo: 'extrato',
      entidade_ids: [UUID, UUID],
      date_from: '2026-01-01',
      date_to: '2026-01-31',
    };
    expect(validate(schema, payload).valid).toBe(false);
    expect(tool.input_schema.safeParse(payload).success).toBe(false);
  });

  it('an unknown discriminator is rejected by BOTH', () => {
    const payload = { tipo: 'balancete', entidade_id: UUID };
    expect(validate(schema, payload).valid).toBe(false);
    expect(tool.input_schema.safeParse(payload).success).toBe(false);
  });

  it('comparativo below minItems is rejected by BOTH', () => {
    const payload = {
      tipo: 'comparativo',
      entidade_ids: [UUID],
      date_from: '2026-01-01',
      date_to: '2026-01-31',
    };
    expect(validate(schema, payload).valid).toBe(false);
    expect(tool.input_schema.safeParse(payload).success).toBe(false);
  });
});

describe('#509 equivalence — schedule_reminder documented refine divergence', () => {
  const tool = REGISTRY.schedule_reminder!;
  const schema = toolInputToJsonSchema(tool).input_schema;

  it('a past instant passes JSON Schema but is REJECTED by Zod (backend is authority)', () => {
    const payload = { quando: '2001-01-01T09:00:00-03:00', texto: 'oi' };
    expect(validate(schema, payload).valid).toBe(true);
    expect(tool.input_schema.safeParse(payload).success).toBe(false);
    // The predicate has no JSON Schema keyword, so it is stated in prose.
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(String(props.quando.description)).toContain('futuro');
  });
});

describe('#509 equivalence — property-based (JSON Schema accept ⟹ Zod accept)', () => {
  const tool = REGISTRY.register_transaction!;
  const schema = toolInputToJsonSchema(tool).input_schema;

  it('holds over generated payloads (register_transaction has no refine)', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            entidade_id: fc.oneof(fc.constant(UUID), fc.constant('nope'), fc.constant(1)),
            conta_id: fc.oneof(fc.constant(UUID), fc.constant('')),
            natureza: fc.oneof(
              fc.constantFrom('receita', 'despesa', 'movimentacao'),
              fc.constant('outra'),
            ),
            valor: fc.oneof(fc.double({ min: -10, max: 1000, noNaN: true }), fc.constant('12')),
            data_competencia: fc.oneof(fc.constant('2026-03-01'), fc.constant('2026-3-1')),
            status: fc.oneof(fc.constantFrom('pendente', 'paga'), fc.constant('quitada')),
            descricao: fc.string({ minLength: 0, maxLength: 300 }),
          },
          { requiredKeys: [] },
        ),
        (payload) => {
          if (!validate(schema, payload).valid) return true; // only the implication
          return tool.input_schema.safeParse(payload).success;
        },
      ),
      { numRuns: 300 },
    );
  });
});

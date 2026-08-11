/**
 * Issue #509 — CATALOG LINT.
 *
 * This is the CI gate the issue asks for: it converts EVERY registered tool
 * (including config-flag-disabled ones, via `buildToolCatalog`) and fails when
 *
 *   - a schema does not compile / uses an unsupported Zod construct;
 *   - the root is not `type: 'object'`;
 *   - a keyword outside the provider least-common-denominator appears;
 *   - a closed object silently became open (`additionalProperties: true`);
 *   - a `required` entry has no matching property;
 *   - an authority-shaped field name is exposed;
 *   - a schema exceeds the per-tool byte budget without a diagnostic;
 *   - two tools share a name;
 *   - a golden tool's schema hash changed without a review of this table.
 *
 * A conversion failure here must be fixed at the CONTRACT (or in the
 * converter) — never by re-opening the schema.
 */
import { describe, it, expect } from 'vitest';
import { buildToolCatalog, REGISTRY } from '../../../src/tools/_registry.js';
import {
  toolInputToJsonSchema,
  MAX_TOOL_SCHEMA_BYTES,
  FORBIDDEN_FIELD_NAMES,
  schemaHash,
  canonicalStringify,
} from '../../../src/tools/schema-json.js';
import { unknownKeywords } from '../../helpers/json-schema-validator.js';

const catalog = buildToolCatalog();

/** Every object node in a schema tree (root + nested + anyOf variants + items). */
function objectNodes(node: unknown, path = '$'): Array<{ path: string; node: Record<string, unknown> }> {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => objectNodes(child, `${path}[${i}]`));
  }
  const obj = node as Record<string, unknown>;
  const here = obj.type === 'object' || obj.properties !== undefined ? [{ path, node: obj }] : [];
  const children: Array<{ path: string; node: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        children.push(...objectNodes(pv, `${path}.${pk}`));
      }
    } else if (key === 'items' || key === 'additionalProperties' || key === 'anyOf') {
      children.push(...objectNodes(value, `${path}.${key}`));
    }
  }
  return [...here, ...children];
}

describe('#509 catalog lint — every registered tool produces a strict JSON Schema', () => {
  it('the catalog is non-empty (guards against an accidentally mocked registry)', () => {
    expect(catalog.length).toBeGreaterThan(50);
  });

  it('no two tools share a name', () => {
    const names = catalog.map((e) => e.tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(catalog.map((e) => [e.tool.name, e.tool] as const))(
    '%s converts to a valid, strict, portable schema',
    (name, tool) => {
      const built = toolInputToJsonSchema(tool);

      // Root contract — Anthropic requires input_schema.type === 'object'.
      expect(built.input_schema.type).toBe('object');
      expect(built.name).toBe(name);
      expect(built.description.length).toBeGreaterThan(0);

      // Provider least-common-denominator: no $ref/$defs/oneOf/allOf/…
      expect(unknownKeywords(built.input_schema, name)).toEqual([]);

      for (const { path, node } of objectNodes(built.input_schema, name)) {
        // Never re-open an object.
        expect(`${path}:${String(node.additionalProperties)}`).not.toBe(`${path}:true`);
        // Every required entry must name a real property.
        const properties = (node.properties ?? {}) as Record<string, unknown>;
        for (const req of (node.required ?? []) as string[]) {
          expect(`${path}.${req}`, `required key "${req}" has no property at ${path}`).toBe(
            Object.hasOwn(properties, req) ? `${path}.${req}` : `${path}.<missing:${req}>`,
          );
        }
        // Defense in depth: no authority-shaped field names.
        for (const key of Object.keys(properties)) {
          expect(FORBIDDEN_FIELD_NAMES.has(key), `${path}.${key} is authority-shaped`).toBe(false);
        }
      }

      // Schema budget — diagnostic, never a silent truncation.
      expect(built.bytes).toBeLessThanOrEqual(MAX_TOOL_SCHEMA_BYTES);

      // Deterministic hash over the canonical serialization.
      expect(built.schema_hash).toBe(schemaHash(built.input_schema));
      expect(built.schema_hash).toMatch(/^[0-9a-f]{16}$/);
    },
  );

  it('required lists are exactly the non-optional Zod keys (no drift)', () => {
    for (const { tool } of catalog) {
      const built = toolInputToJsonSchema(tool);
      // Only meaningful for object-rooted contracts; union roots are covered by
      // the per-variant checks above.
      if (built.input_schema.anyOf !== undefined) continue;
      const shape = (tool.input_schema as unknown as { shape?: Record<string, { isOptional?: () => boolean }> })
        .shape;
      if (!shape) continue;
      const expected = Object.entries(shape)
        .filter(([, field]) => field.isOptional?.() !== true)
        .map(([key]) => key);
      expect((built.input_schema.required ?? []) as string[]).toEqual(expected);
    }
  });

  it('conversion is deterministic (same bytes across two independent builds)', () => {
    for (const { tool } of catalog) {
      const a = canonicalStringify(toolInputToJsonSchema(tool).input_schema);
      const b = canonicalStringify(toolInputToJsonSchema(tool).input_schema);
      expect(a).toBe(b);
    }
  });

  it('reports the total schema budget for the full catalog (diagnostic)', () => {
    const total = catalog.reduce((sum, e) => sum + toolInputToJsonSchema(e.tool).bytes, 0);
    // The FULL catalog is never sent to a model — the visible set is the
    // intersection of agent grant ∩ role/skill scope ∩ human permission ∩ flag.
    // This bound only catches a catastrophic catalog-wide blowup.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(catalog.length * MAX_TOOL_SCHEMA_BYTES);
  });
});

/**
 * Golden hashes (issue #509: "o hash mudar sem snapshot/review" must fail CI).
 *
 * Covers the tools the issue names explicitly plus a baseline.core tool, a
 * nested-object tool and a communication tool. Changing a contract legitimately
 * changes a hash — update the value HERE, in the same PR, so the contract change
 * is reviewed instead of silently shipped to the model.
 */
const GOLDEN_HASHES: Record<string, string> = {
  // the five tools the issue names explicitly
  register_transaction: '15f4414955a4511f',
  cancel_transaction: '812166353a37861a',
  query_balance: '8abba3e2aaf2dd05',
  schedule_reminder: '65e8872730c33a3f',
  generate_report: '36f25de2035ac723',
  // a baseline.core tool
  audit_decision: 'c4a39cc730f41c35',
  // a tool with a nested object
  start_recurring_payment: '7ada6b89b0f5e849',
  // a communication tool
  send_proactive_message: '314e35d6e67a0d55',
};

describe('#509 golden schemas', () => {
  it.each(Object.keys(GOLDEN_HASHES))('%s hash is pinned', (name) => {
    const entry = catalog.find((e) => e.tool.name === name);
    expect(entry, `${name} missing from the catalog`).toBeDefined();
    expect(toolInputToJsonSchema(entry!.tool).schema_hash).toBe(GOLDEN_HASHES[name]);
  });

  it('query_balance — both filters optional, closed object, uuid format, descriptions', () => {
    expect(toolInputToJsonSchema(REGISTRY.query_balance!).input_schema).toEqual({
      type: 'object',
      properties: {
        entidade_id: {
          type: 'string',
          format: 'uuid',
          description:
            'UUID opaco da entidade. Omita para consultar todas as entidades já no escopo.',
        },
        conta_id: {
          type: 'string',
          format: 'uuid',
          description:
            'UUID opaco da conta. Omita para somar todas as contas do escopo. Saldos em BRL.',
        },
      },
      additionalProperties: false,
    });
  });

  it('register_transaction — required set, enums, exclusiveMinimum, typed record', () => {
    const s = toolInputToJsonSchema(REGISTRY.register_transaction!).input_schema;
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(s.required).toEqual([
      'entidade_id',
      'conta_id',
      'natureza',
      'valor',
      'data_competencia',
      'status',
      'descricao',
    ]);
    expect(s.additionalProperties).toBe(false);
    expect(props.natureza.enum).toEqual(['receita', 'despesa', 'movimentacao']);
    expect(props.status.enum).toEqual(['pendente', 'agendada', 'paga', 'recebida']);
    // `z.number().positive()` — strictly greater than zero, not `minimum: 0`.
    expect(props.valor).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    expect(props.descricao).toMatchObject({ type: 'string', minLength: 1, maxLength: 280 });
    expect(props.data_competencia.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    // `.default('whatsapp')` → documented default AND absent from `required`.
    expect(props.origem.default).toBe('whatsapp');
    // `z.record(z.unknown())` → a SCHEMA as additionalProperties, never `true`.
    expect(props.metadata).toMatchObject({ type: 'object', additionalProperties: {} });
    // Every field carries a description (issue §6).
    for (const [key, node] of Object.entries(props)) {
      expect(typeof node.description, `${key} has no description`).toBe('string');
    }
  });

  it('generate_report — union root keeps type:object and closed variants', () => {
    const entry = catalog.find((e) => e.tool.name === 'generate_report')!;
    const s = toolInputToJsonSchema(entry.tool).input_schema;
    expect(s.type).toBe('object');
    const variants = s.anyOf as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    for (const v of variants) {
      expect(v.type).toBe('object');
      expect(v.additionalProperties).toBe(false);
    }
    // The discriminator is a single-value enum per variant.
    expect((variants[0].properties as Record<string, Record<string, unknown>>).tipo.enum).toEqual([
      'extrato',
    ]);
    expect((variants[1].properties as Record<string, Record<string, unknown>>).tipo.enum).toEqual([
      'comparativo',
    ]);
    expect(
      (variants[1].properties as Record<string, Record<string, unknown>>).entidade_ids,
    ).toMatchObject({ type: 'array', minItems: 2, maxItems: 8 });
  });
});

/**
 * Issue #509 — EXPOSURE surfaces.
 *
 * Every path that hands tool schemas to a model must ship the canonical strict
 * schema, not the old `{ type:'object', additionalProperties:true }` stub:
 *
 *   - `getToolSchemas`        — human-permission + feature-flag filter
 *   - `getAgentToolSchemas`   — agent grant ∩ skill scope ∩ human ∩ flag
 *   - `getToolSchemasByName`  — the `tool_mediated` skill executor
 *
 * The exposure payload must stay EXACTLY `{name, description, input_schema}`:
 * both provider SDKs reject unknown keys on a tool definition, so the schema
 * hash / byte accounting travels through `describeExposedSchemas`, never on the
 * wire.
 *
 * Filtering behaviour is unchanged and covered by
 * `registry-agent-tool-schemas.spec.ts`; this spec only pins the PAYLOAD.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResolvedPermission } from '../../../src/governance/permissions.js';

function byEntityWith(acoes: string[]): Map<string, ResolvedPermission> {
  return new Map([
    ['e1', { profile: { acoes } } as unknown as ResolvedPermission],
  ]);
}

const OWNER = () => byEntityWith(['*']);

describe('#509 exposure — strict schemas reach every model-facing surface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getToolSchemas returns strict, closed schemas (never the generic stub)', async () => {
    const { getToolSchemas } = await import('../../../src/tools/_registry.js');
    const schemas = getToolSchemas(OWNER());
    expect(schemas.length).toBeGreaterThan(10);
    for (const s of schemas) {
      expect(Object.keys(s).sort()).toEqual(['description', 'input_schema', 'name']);
      expect(s.input_schema.type).toBe('object');
      expect(s.input_schema.additionalProperties).not.toBe(true);
    }
    const rt = schemas.find((s) => s.name === 'register_transaction');
    expect(rt).toBeDefined();
    expect((rt!.input_schema.properties as Record<string, unknown>).valor).toBeDefined();
    expect(rt!.input_schema.required).toContain('descricao');
  });

  it('getAgentToolSchemas returns strict schemas for the granted subset', async () => {
    const { getAgentToolSchemas } = await import('../../../src/tools/_registry.js');
    const schemas = getAgentToolSchemas(new Set(['query_balance']), OWNER());
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('query_balance');
    expect(Object.keys(schemas[0]).sort()).toEqual(['description', 'input_schema', 'name']);
    expect(schemas[0].input_schema.additionalProperties).toBe(false);
    expect(Object.keys(schemas[0].input_schema.properties as object)).toEqual([
      'entidade_id',
      'conta_id',
    ]);
  });

  it('getToolSchemasByName (tool_mediated) returns strict schemas', async () => {
    const { getToolSchemasByName } = await import('../../../src/tools/_registry.js');
    const schemas = getToolSchemasByName(['cancel_transaction', 'does_not_exist']);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].input_schema.required).toEqual(['entidade_id', 'transacao_id']);
    expect(schemas[0].input_schema.additionalProperties).toBe(false);
  });

  it('describeExposedSchemas reports a deterministic set hash + byte budget', async () => {
    const { describeExposedSchemas } = await import('../../../src/tools/_registry.js');
    const a = describeExposedSchemas(['query_balance', 'cancel_transaction'], 'test');
    const b = describeExposedSchemas(['cancel_transaction', 'query_balance'], 'test');
    // Order-independent: the same VISIBLE SET always hashes the same.
    expect(a.set_hash).toBe(b.set_hash);
    expect(a.bytes).toBe(b.bytes);
    expect(a.bytes).toBeGreaterThan(0);
    expect(a.tools).toBe(2);
    expect(a.hashes.query_balance).toMatch(/^[0-9a-f]{16}$/);
    // A different set → a different hash.
    expect(describeExposedSchemas(['query_balance'], 'test').set_hash).not.toBe(a.set_hash);
  });

  it('unknown tool names are skipped by describeExposedSchemas (fail-closed, no throw)', async () => {
    const { describeExposedSchemas } = await import('../../../src/tools/_registry.js');
    const d = describeExposedSchemas(['query_balance', 'nope'], 'test');
    expect(d.tools).toBe(1);
    expect(d.hashes.nope).toBeUndefined();
  });
});

describe('#509 exposure — rollback flag', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('FEATURE_STRICT_TOOL_SCHEMAS=false restores the legacy generic stub', async () => {
    vi.resetModules();
    vi.stubEnv('FEATURE_STRICT_TOOL_SCHEMAS', 'false');
    const { getToolSchemas } = await import('../../../src/tools/_registry.js');
    const schemas = getToolSchemas(OWNER());
    expect(schemas.length).toBeGreaterThan(10);
    for (const s of schemas) {
      expect(s.input_schema).toEqual({ type: 'object', additionalProperties: true });
    }
  });

  it('the flag never changes WHICH tools are visible — only how they are described', async () => {
    vi.resetModules();
    const strict = (await import('../../../src/tools/_registry.js'))
      .getToolSchemas(OWNER())
      .map((s) => s.name)
      .sort();
    vi.resetModules();
    vi.stubEnv('FEATURE_STRICT_TOOL_SCHEMAS', 'false');
    const legacy = (await import('../../../src/tools/_registry.js'))
      .getToolSchemas(OWNER())
      .map((s) => s.name)
      .sort();
    expect(strict).toEqual(legacy);
  });
});

describe('#509 exposure — fail-closed on a broken contract', () => {
  it('a tool whose schema cannot be converted is DROPPED, never made permissive', async () => {
    vi.resetModules();
    const { z } = await import('zod');
    const registry = await import('../../../src/tools/_registry.js');
    const { _resetSchemaCacheForTests } = await import('../../../src/tools/schema-json.js');

    const victim = registry.REGISTRY.query_balance!;
    const original = victim.input_schema;
    _resetSchemaCacheForTests(victim);
    // A tuple has no portable JSON Schema representation in our emitted subset.
    (victim as { input_schema: unknown }).input_schema = z.object({
      bad: z.tuple([z.string()]),
    });
    try {
      const names = registry.getToolSchemas(OWNER()).map((s) => s.name);
      expect(names).not.toContain('query_balance');
      // Everything else still exposed — one broken contract does not blank the set.
      expect(names.length).toBeGreaterThan(10);
    } finally {
      (victim as { input_schema: unknown }).input_schema = original;
      _resetSchemaCacheForTests(victim);
    }
  });
});

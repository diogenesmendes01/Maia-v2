/**
 * FIX 3 — `describeZodObject` must handle union / discriminated-union inputs.
 *
 * Regression: a tool whose `input_schema` is a `z.discriminatedUnion(...)`
 * (e.g. `generate_report`) used to render "Inputs (0)" because the
 * introspector returned `[]` for any non-`ZodObject` root. The catalog must
 * NEVER silently show an empty field list for a union — it should enumerate a
 * sensible merged field list covering the discriminator + variant fields.
 *
 * This spec is backed by `generate_report`'s REAL discriminated-union schema
 * (the `tipo: 'extrato' | 'comparativo'` union) plus a couple of synthetic
 * unions to pin the merge rules.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { describeZodObject } from '../../src/tools/describe-schema.js';

// `generate-report.ts` transitively imports baileys (Redis/WhatsApp) and DB
// repos via the PDF helpers. We only need its `input_schema`, so stub those.
vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/maia-describe-union/.baileys', FEATURE_PDF_REPORTS: true },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-describe-union/media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../src/db/repositories.js', () => ({
  transacoesRepo: {},
  entidadesRepo: {},
  categoriasRepo: {},
  contasRepo: {},
}));

describe('describeZodObject — discriminated union (generate_report real schema)', () => {
  it('returns a non-empty field list covering tipo + variant fields', async () => {
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const fields = describeZodObject(generateReportTool.input_schema);

    // Must not be empty (the original bug).
    expect(fields.length).toBeGreaterThan(0);

    const byName = new Map(fields.map((f) => [f.name, f]));

    // Discriminator is present, required, and enumerates the variant literals.
    const tipo = byName.get('tipo');
    expect(tipo).toBeDefined();
    expect(tipo!.optional).toBe(false);
    expect(tipo!.type).toContain('extrato');
    expect(tipo!.type).toContain('comparativo');

    // Shared fields present in BOTH variants → still surfaced.
    expect(byName.has('date_from')).toBe(true);
    expect(byName.has('date_to')).toBe(true);

    // Variant-only fields are surfaced and marked optional (they differ).
    expect(byName.has('entidade_id')).toBe(true); // extrato only
    expect(byName.get('entidade_id')!.optional).toBe(true);
    expect(byName.has('entidade_ids')).toBe(true); // comparativo only
    expect(byName.get('entidade_ids')!.optional).toBe(true);

    // `natureza` is optional in the extrato variant + absent in comparativo.
    expect(byName.has('natureza')).toBe(true);
    expect(byName.get('natureza')!.optional).toBe(true);
  });
});

describe('describeZodObject — synthetic unions', () => {
  it('plain z.union of objects merges fields (no discriminator)', () => {
    const schema = z.union([
      z.object({ a: z.string(), shared: z.number() }),
      z.object({ b: z.boolean(), shared: z.number() }),
    ]);
    const fields = describeZodObject(schema);
    const byName = new Map(fields.map((f) => [f.name, f]));

    expect(fields.length).toBeGreaterThan(0);
    // shared is in both variants and required in both → required.
    expect(byName.get('shared')!.optional).toBe(false);
    // a / b appear in only one variant → optional.
    expect(byName.get('a')!.optional).toBe(true);
    expect(byName.get('b')!.optional).toBe(true);
  });

  it('field optional in one variant reads as optional overall', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('x'), v: z.string() }),
      z.object({ kind: z.literal('y'), v: z.string().optional() }),
    ]);
    const byName = new Map(describeZodObject(schema).map((f) => [f.name, f]));
    expect(byName.get('v')!.optional).toBe(true);
    expect(byName.get('kind')!.optional).toBe(false);
  });

  it('still handles a plain ZodObject (no regression)', () => {
    const schema = z.object({ a: z.string(), b: z.number().optional() });
    const byName = new Map(describeZodObject(schema).map((f) => [f.name, f]));
    expect(byName.get('a')!.optional).toBe(false);
    expect(byName.get('a')!.type).toBe('string');
    expect(byName.get('b')!.optional).toBe(true);
  });

  it('object wrapped in a top-level .refine() still introspects', () => {
    const schema = z
      .object({ a: z.string(), b: z.number() })
      .refine((o) => o.b > 0, 'b must be positive');
    const fields = describeZodObject(schema);
    expect(fields.map((f) => f.name).sort()).toEqual(['a', 'b']);
  });

  it('returns [] for a non-object, non-union root (never throws)', () => {
    expect(describeZodObject(z.string())).toEqual([]);
  });
});

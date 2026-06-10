/**
 * safeExtractAndParseJson — shared helper for the LLM-JSON-parsing pattern.
 *
 * The pattern (`text.match(/\{[\s\S]*\}/)` → `JSON.parse` → Zod `safeParse`
 * → null on any failure) was duplicated across cognition modules
 * (procedure-selector, memory-classifier, behavioral-hint-deriver, ...).
 * The helper is FAIL-CLOSED: any failure stage (no JSON object in the text,
 * malformed JSON, schema mismatch) returns `null` — it never throws. Callers
 * that need fail-loud behavior (e.g. `src/shared/risk/llm-gate.ts`, which
 * throws typed `LLMGateParseError`s so the cognitive runner records
 * status='error') intentionally do NOT use this helper.
 *
 * Contract guarantees covered below — if you change any of these you are
 * changing the parse semantics of every refactored call site:
 *  1. Extraction is FIRST `{` to LAST `}` (greedy), matching the original
 *     inline regex — surrounding prose / code fences are tolerated.
 *  2. Failures return null and never throw.
 *  3. Success returns the Zod OUTPUT (defaults/transforms applied), so it is
 *     a drop-in replacement for `Schema.safeParse(JSON.parse(m[0]))`.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { safeExtractAndParseJson } from '@/lib/json-safe.js';

const SampleSchema = z.object({
  matches: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

describe('safeExtractAndParseJson — success paths', () => {
  it('parses a bare JSON object', () => {
    const out = safeExtractAndParseJson('{"matches":true,"confidence":0.9}', SampleSchema);
    expect(out).toEqual({ matches: true, confidence: 0.9 });
  });

  it('extracts the JSON object out of surrounding LLM prose', () => {
    const text = 'Claro! Aqui está o JSON pedido:\n{"matches":false,"confidence":0.2,"reason":"x"}\nEspero ter ajudado.';
    const out = safeExtractAndParseJson(text, SampleSchema);
    expect(out).toEqual({ matches: false, confidence: 0.2, reason: 'x' });
  });

  it('extracts from a markdown code fence', () => {
    const text = '```json\n{"matches":true,"confidence":1}\n```';
    const out = safeExtractAndParseJson(text, SampleSchema);
    expect(out).toEqual({ matches: true, confidence: 1 });
  });

  it('matches greedily from first `{` to last `}` (same as the original inline regex)', () => {
    // Nested objects only parse because the match is greedy — a lazy match
    // would truncate at the first `}` and fail JSON.parse.
    const Nested = z.object({ a: z.object({ b: z.number() }), c: z.string() });
    const out = safeExtractAndParseJson('noise {"a":{"b":1},"c":"d"} noise', Nested);
    expect(out).toEqual({ a: { b: 1 }, c: 'd' });
  });

  it('applies Zod output transforms (defaults), returning the schema OUTPUT type', () => {
    const WithDefault = z.object({ level: z.string(), reason: z.string().optional().default('') });
    const out = safeExtractAndParseJson('{"level":"low"}', WithDefault);
    expect(out).toEqual({ level: 'low', reason: '' });
  });
});

describe('safeExtractAndParseJson — fail-closed paths (null, never throw)', () => {
  it('returns null when the text contains no JSON object at all', () => {
    expect(safeExtractAndParseJson('desculpe, não consigo responder', SampleSchema)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(safeExtractAndParseJson('', SampleSchema)).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', () => {
    expect(safeExtractAndParseJson('{"matches": true, "confidence":}', SampleSchema)).toBeNull();
  });

  it('returns null when JSON is valid but fails schema validation', () => {
    // confidence out of [0,1] range
    expect(safeExtractAndParseJson('{"matches":true,"confidence":7}', SampleSchema)).toBeNull();
    // missing required key
    expect(safeExtractAndParseJson('{"matches":true}', SampleSchema)).toBeNull();
  });

  it('never throws, even for pathological input (greedy match spanning two objects)', () => {
    // `{"a":1} junk {"b":2}` greedily matches `{"a":1} junk {"b":2}` which is
    // NOT valid JSON — the original inline pattern caught the JSON.parse
    // throw and returned null; the helper must do the same.
    expect(() => safeExtractAndParseJson('{"a":1} junk {"b":2}', SampleSchema)).not.toThrow();
    expect(safeExtractAndParseJson('{"a":1} junk {"b":2}', SampleSchema)).toBeNull();
  });
});

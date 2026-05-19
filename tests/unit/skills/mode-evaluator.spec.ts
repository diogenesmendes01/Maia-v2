/**
 * P9a Task 5 — evaluator mode tests.
 *
 * Verifica:
 *  - parseEvaluatorOutput rejeita score fora de 0..1
 *  - rejeita verdict que não é 'pass' / 'fail'
 *  - aceita JSON em fence
 *  - evaluatorMode chama callLLM com temperature=0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

import { evaluatorMode, parseEvaluatorOutput } from '@/skills/modes/evaluator.js';
import { callLLM } from '@/lib/claude.js';

const mockSkill = {
  id: 'eval-1',
  procedure: {},
  runtime_hints: {},
} as any;

describe('parseEvaluatorOutput', () => {
  it('parses valid output', () => {
    const out = parseEvaluatorOutput('{"score":0.85,"verdict":"pass","reasons":["clear","accurate"]}');
    expect(out.score).toBe(0.85);
    expect(out.verdict).toBe('pass');
    expect(out.reasons).toEqual(['clear', 'accurate']);
  });

  it('parses JSON in fence', () => {
    const text = '```json\n{"score":0.4,"verdict":"fail","reasons":["wrong"]}\n```';
    const out = parseEvaluatorOutput(text);
    expect(out.verdict).toBe('fail');
    expect(out.score).toBe(0.4);
  });

  it('throws on empty', () => {
    expect(() => parseEvaluatorOutput('')).toThrow('evaluator_empty_response');
  });

  it('throws on score out of range', () => {
    expect(() => parseEvaluatorOutput('{"score":1.5,"verdict":"pass","reasons":[]}')).toThrow(
      'evaluator_invalid_score',
    );
    expect(() => parseEvaluatorOutput('{"score":-0.1,"verdict":"pass","reasons":[]}')).toThrow(
      'evaluator_invalid_score',
    );
  });

  it('throws on invalid verdict', () => {
    expect(() =>
      parseEvaluatorOutput('{"score":0.7,"verdict":"maybe","reasons":[]}'),
    ).toThrow('evaluator_invalid_verdict');
  });

  it('coerces non-string reasons to strings', () => {
    const out = parseEvaluatorOutput('{"score":0.7,"verdict":"pass","reasons":[1,true,null]}');
    expect(out.reasons).toEqual(['1', 'true', 'null']);
  });
});

describe('evaluatorMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses temperature=0 (determinístico)', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"score":0.9,"verdict":"pass","reasons":[]}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    await evaluatorMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(callLLM).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.0 }));
  });

  it('returns shape { score, verdict, reasons }', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"score":0.9,"verdict":"pass","reasons":["good"]}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    const out = await evaluatorMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(out).toEqual({ score: 0.9, verdict: 'pass', reasons: ['good'] });
  });
});

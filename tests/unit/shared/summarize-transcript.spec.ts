/**
 * Issue #433 — `summarizeTranscript` shared helper
 * (src/shared/summary/summarize-transcript).
 *
 * The single summarizer reused by the cron worker AND the
 * `conversation_summary_compose` tool (and #431). Tested directly: transcript
 * rendering, the structured-JSON happy path, the prose fallback (worker's prior
 * behavior), the empty-input short-circuit, and the LLM-failure path. The LLM
 * call is injected via `opts.llmCall` so no Anthropic/runner mocking is needed
 * for the call itself — but runCognitiveModule is stubbed to just run the fn.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    status: 'success',
    output: await fn(),
  })),
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  summarizeTranscript,
  renderTranscript,
} from '@/shared/summary/summarize-transcript.js';
import type { LLMResponse } from '@/lib/claude.js';

const llmResp = (content: string | null): LLMResponse =>
  ({
    content,
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'stub',
  }) as LLMResponse;

describe('renderTranscript', () => {
  it('renders in → Usuário, out → Maia, null content → [mídia]', () => {
    expect(
      renderTranscript([
        { direcao: 'in', conteudo: 'oi' },
        { direcao: 'out', conteudo: 'olá' },
        { direcao: 'in', conteudo: null },
      ]),
    ).toBe('Usuário: oi\nMaia: olá\nUsuário: [mídia]');
  });
});

describe('summarizeTranscript', () => {
  it('empty transcript short-circuits without calling the LLM', async () => {
    const llmCall = vi.fn();
    const out = await summarizeTranscript([], { llmCall: llmCall as never });
    expect(out).toEqual({ summary: '', open_questions: [], decisions: [], pending_actions: [] });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('parses STRICT JSON into the structured contract', async () => {
    const llmCall = vi.fn(async () =>
      llmResp(
        JSON.stringify({
          summary: 'cliente pediu reembolso; aguardando validação',
          open_questions: ['qual o valor exato?'],
          decisions: ['reembolso aprovado em princípio'],
          pending_actions: ['validar comprovante'],
        }),
      ),
    );
    const out = await summarizeTranscript([{ direcao: 'in', conteudo: 'quero reembolso' }], {
      llmCall: llmCall as never,
    });
    expect(out.summary).toContain('reembolso');
    expect(out.open_questions).toEqual(['qual o valor exato?']);
    expect(out.decisions).toEqual(['reembolso aprovado em princípio']);
    expect(out.pending_actions).toEqual(['validar comprovante']);
  });

  it('caps the summary at maxChars', async () => {
    const long = 'a'.repeat(2000);
    const llmCall = vi.fn(async () => llmResp(JSON.stringify({ summary: long })));
    const out = await summarizeTranscript([{ direcao: 'in', conteudo: 'x' }], {
      maxChars: 100,
      llmCall: llmCall as never,
    });
    expect(out.summary).toHaveLength(100);
  });

  it('falls back to prose-as-summary when the model returns no JSON (worker behavior preserved)', async () => {
    const llmCall = vi.fn(async () => llmResp('Resumo em prosa, sem JSON.'));
    const out = await summarizeTranscript([{ direcao: 'in', conteudo: 'x' }], {
      llmCall: llmCall as never,
    });
    expect(out.summary).toBe('Resumo em prosa, sem JSON.');
    expect(out.open_questions).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.pending_actions).toEqual([]);
  });

  it('returns an empty result (no throw) when the LLM call yields null output', async () => {
    // A null content → parsed as empty summary.
    const llmCall = vi.fn(async () => llmResp(null));
    const out = await summarizeTranscript([{ direcao: 'in', conteudo: 'x' }], {
      llmCall: llmCall as never,
    });
    expect(out.summary).toBe('');
  });
});

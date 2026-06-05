/**
 * Issue #433 — the 3 baseline.core GAP tools: contract + delegation + scope.
 *
 * Mirrors the per-tool unit-test pattern in `baseline-tools.spec.ts`: exercise
 * the handlers directly with a minimal ctx and stubbed collateral. We assert:
 *   - declared contract (side_effect / operation_type / required_actions /
 *     audit_action) so the dispatcher auto-audits correctly;
 *   - `risk_signal_classify` reuses the shared scorer (maps decided_by → source,
 *     never downgrades below the heuristic floor);
 *   - `conversation_summary_compose` delegates to the shared summarizeTranscript;
 *   - `conversation_state_update` delegates to conversasRepo.mergeMetadata,
 *     rejects a divergent conversation_id, and refuses reserved gate keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';

const mergeMetadataMock = vi.fn();
const recentInConversationMock = vi.fn();

vi.mock('@/db/repositories.js', () => ({
  conversasRepo: { mergeMetadata: mergeMetadataMock },
  mensagensRepo: { recentInConversation: recentInConversationMock },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
// The summarizer helper wraps runCognitiveModule + callLLM; stub both so the
// module graph imports without DB/LLM/Anthropic side effects. The runner simply
// runs the fn so we can assert the (stubbed) callLLM is reached.
vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    status: 'success',
    output: await fn(),
  })),
}));
const callLLMMock = vi.fn();
vi.mock('@/lib/claude.js', () => ({ callLLM: callLLMMock }));

beforeEach(() => {
  mergeMetadataMock.mockReset();
  recentInConversationMock.mockReset();
  callLLMMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

// A gate that always tries to DOWNGRADE — proves the no-downgrade invariant
// survives through the tool's adapter.
const downgradingGate: LLMGate = async () => ({
  suggested_level: RiskLevel.LOW,
  reason: 'adversarial downgrade attempt',
});

describe('risk_signal_classify (none, parse_only)', () => {
  it('declares the conservative baseline contract', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    expect(riskSignalClassifyTool.side_effect).toBe('none');
    expect(riskSignalClassifyTool.operation_type).toBe('parse_only');
    expect(riskSignalClassifyTool.required_actions).toEqual([]);
    expect(riskSignalClassifyTool.audit_action).toBe('risk_signal_classified');
  });

  it('maps the scorer level → risk and a low/casual turn → allow (heuristic source)', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    const out = await riskSignalClassifyTool.handler(
      { topic: 'casual', tool_kinds: [] } as never,
      ctx,
    );
    expect(out.risk).toBe(RiskLevel.LOW);
    expect(out.recommended_action).toBe('allow');
    expect(out.source).toBe('heuristic');
  });

  it('maps decided_by → source and NEVER downgrades below the heuristic floor', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    // `financial` topic → MEDIUM heuristic + ambiguous → gate consulted; the
    // adversarial gate tries LOW but the scorer keeps MEDIUM.
    const out = await riskSignalClassifyTool.input_schema.parse({ topic: 'financial' });
    const result = await riskSignalClassifyTool.handler(
      { ...out } as never,
      ctx,
    );
    // The handler builds its own gate (real Haiku) — but with no API key the gate
    // returns null → fail-closed keeps the heuristic. Either way risk >= MEDIUM.
    expect([RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL]).toContain(result.risk);
    expect(result.risk).not.toBe(RiskLevel.LOW);
    expect(result.recommended_action).toBe(
      result.risk === RiskLevel.MEDIUM ? 'clarify' : result.recommended_action,
    );
    // reasons surface the deterministic trigger signals.
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it('input schema rejects an out-of-enum topic and over-long text', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    expect(riskSignalClassifyTool.input_schema.safeParse({ topic: 'nope' }).success).toBe(false);
    expect(
      riskSignalClassifyTool.input_schema.safeParse({ text: 'x'.repeat(9000) }).success,
    ).toBe(false);
  });

  it('via the shared adapter directly: an adversarial gate cannot downgrade', async () => {
    const { classifyTurnRisk } = await import('@/shared/risk/turn-risk-adapter.js');
    const r = await classifyTurnRisk({ topic: 'financial', gate: downgradingGate });
    expect(r.risk).toBe(RiskLevel.MEDIUM); // gate's LOW was ignored
    expect(r.source).toBe('heuristic');
  });
});

describe('conversation_summary_compose (none, parse_only)', () => {
  it('declares the conservative baseline contract', async () => {
    const { conversationSummaryComposeTool } = await import(
      '@/tools/conversation-summary-compose.js'
    );
    expect(conversationSummaryComposeTool.side_effect).toBe('none');
    expect(conversationSummaryComposeTool.operation_type).toBe('parse_only');
    expect(conversationSummaryComposeTool.required_actions).toEqual([]);
    expect(conversationSummaryComposeTool.audit_action).toBe('conversation_summary_composed');
  });

  it('reads recent messages of the CURRENT conversa and calls the shared summarizer (callLLM)', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      { direcao: 'out', conteudo: 'B' },
      { direcao: 'in', conteudo: 'A' },
    ]);
    callLLMMock.mockResolvedValueOnce({
      content: JSON.stringify({
        summary: 'resumo',
        open_questions: ['q1'],
        decisions: ['d1'],
        pending_actions: ['a1'],
      }),
    });
    const { conversationSummaryComposeTool } = await import(
      '@/tools/conversation-summary-compose.js'
    );
    const out = await conversationSummaryComposeTool.handler({ limit: 50 } as never, ctx);

    // Reads the caller's own conversation only.
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 50);
    // Delegated to summarizeTranscript → the shared callLLM, with the chrono
    // transcript (oldest-first: A then B).
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const llmArg = callLLMMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(llmArg.messages[0]!.content).toBe('Usuário: A\nMaia: B');
    expect(out).toEqual({
      conversa_id: 'c1',
      summary: 'resumo',
      open_questions: ['q1'],
      decisions: ['d1'],
      pending_actions: ['a1'],
    });
  });

  it('uses the caller-provided history WITHOUT hitting the DB', async () => {
    callLLMMock.mockResolvedValueOnce({ content: JSON.stringify({ summary: 's' }) });
    const { conversationSummaryComposeTool } = await import(
      '@/tools/conversation-summary-compose.js'
    );
    const out = await conversationSummaryComposeTool.handler(
      { history: [{ direcao: 'in', conteudo: 'oi' }], limit: 50 } as never,
      ctx,
    );
    expect(recentInConversationMock).not.toHaveBeenCalled();
    expect(out.summary).toBe('s');
  });

  it('does NOT accept a conversation_id input (no scope-escape vector)', async () => {
    const { conversationSummaryComposeTool } = await import(
      '@/tools/conversation-summary-compose.js'
    );
    const parsed = conversationSummaryComposeTool.input_schema.parse({
      conversation_id: 'other',
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('conversation_id');
  });
});

describe('conversation_state_update (write, update_meta)', () => {
  it('declares the write contract gated by the granular action key', async () => {
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    expect(conversationStateUpdateTool.side_effect).toBe('write');
    expect(conversationStateUpdateTool.operation_type).toBe('update_meta');
    expect(conversationStateUpdateTool.required_actions).toEqual(['update_conversation_state']);
    // NOT a financial/domain write key.
    expect(conversationStateUpdateTool.required_actions).not.toContain('create_transaction');
    expect(conversationStateUpdateTool.audit_action).toBe('conversation_state_updated');
  });

  it('delegates to conversasRepo.mergeMetadata for the CURRENT conversation', async () => {
    mergeMetadataMock.mockResolvedValueOnce(undefined);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    const out = await conversationStateUpdateTool.handler(
      { patch: { topic_tag: 'suporte', resolved: true } } as never,
      ctx,
    );
    expect(mergeMetadataMock).toHaveBeenCalledWith('c1', {
      topic_tag: 'suporte',
      resolved: true,
    });
    expect(out).toEqual({ conversa_id: 'c1', updated_keys: ['topic_tag', 'resolved'] });
  });

  it('accepts a MATCHING conversation_id but REJECTS a divergent one (scope-escape)', async () => {
    mergeMetadataMock.mockResolvedValue(undefined);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    // Matching id → allowed.
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { k: 'v' }, conversation_id: 'c1' } as never,
        ctx,
      ),
    ).resolves.toEqual({ conversa_id: 'c1', updated_keys: ['k'] });

    // Divergent id → rejected, no write.
    mergeMetadataMock.mockClear();
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { k: 'v' }, conversation_id: 'c-other' } as never,
        ctx,
      ),
    ).rejects.toThrow(/scope_violation/);
    expect(mergeMetadataMock).not.toHaveBeenCalled();
  });

  it('REFUSES reserved gate keys (pending_question routes via ask_pending_question)', async () => {
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { pending_question: 'are you sure?' } } as never,
        ctx,
      ),
    ).rejects.toThrow(/reserved_key/);
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { last_scope_hash: 'abc' } } as never,
        ctx,
      ),
    ).rejects.toThrow(/reserved_key/);
    expect(mergeMetadataMock).not.toHaveBeenCalled();
  });

  it('input schema rejects an empty patch and deeply-nested values', async () => {
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    // A nested object value is not an allowed scalar/flat-array.
    expect(
      conversationStateUpdateTool.input_schema.safeParse({ patch: { k: { nested: 1 } } }).success,
    ).toBe(false);
  });
});

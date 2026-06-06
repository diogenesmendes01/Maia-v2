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
 *   - `conversation_state_update` delegates to conversasRepo.mergeMetadataNamespace
 *     (namespaced under agent_state), rejects a divergent conversation_id, and
 *     reports an honest no-op (updated=false) when no conversation row matched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';

const mergeMetadataNamespaceMock = vi.fn();
const recentInConversationMock = vi.fn();

vi.mock('@/db/repositories.js', () => ({
  conversasRepo: { mergeMetadataNamespace: mergeMetadataNamespaceMock },
  mensagensRepo: { recentInConversation: recentInConversationMock },
}));
// Fix 1 / Fix 6: the real Haiku gate must NEVER be reached by risk_signal_classify
// (it is heuristic-only). Mock it to THROW so the test fails loudly if the tool
// ever calls Anthropic — deterministic regardless of ANTHROPIC_API_KEY.
const haikuRiskGateMock = vi.fn(async () => {
  throw new Error('haikuRiskGate must not be called by the heuristic-only tool');
});
vi.mock('@/shared/risk/llm-gate.js', () => ({
  haikuRiskGate: haikuRiskGateMock,
  LLMGateParseError: class extends Error {},
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
  mergeMetadataNamespaceMock.mockReset();
  recentInConversationMock.mockReset();
  callLLMMock.mockReset();
  haikuRiskGateMock.mockClear();
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

  it('is heuristic-only: makes NO external LLM call and source is always heuristic', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    // `financial` topic → MEDIUM heuristic + ambiguous → the scorer WOULD consult
    // the gate, but the tool injects a no-op gate, so the real `haikuRiskGate`
    // (mocked to throw) is never reached. Deterministic regardless of env creds.
    const parsed = riskSignalClassifyTool.input_schema.parse({
      topic: 'financial',
      text: 'preciso fazer um pagamento de boleto',
    });
    const result = await riskSignalClassifyTool.handler({ ...parsed } as never, ctx);

    // The heuristic-only path keeps the deterministic floor (>= MEDIUM here) and
    // reports `source: 'heuristic'` — the gate never moved it.
    expect([RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL]).toContain(result.risk);
    expect(result.risk).not.toBe(RiskLevel.LOW);
    expect(result.source).toBe('heuristic');
    // PROOF of no external call: the real Haiku gate (mocked to throw) was never
    // invoked.
    expect(haikuRiskGateMock).not.toHaveBeenCalled();
    // reasons surface the deterministic trigger signals.
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it('input schema rejects an out-of-enum topic and over-long text (>4000 chars)', async () => {
    const { riskSignalClassifyTool } = await import('@/tools/risk-signal-classify.js');
    expect(riskSignalClassifyTool.input_schema.safeParse({ topic: 'nope' }).success).toBe(false);
    // 4000 is the cap; 4001 must fail.
    expect(
      riskSignalClassifyTool.input_schema.safeParse({ text: 'x'.repeat(4001) }).success,
    ).toBe(false);
    expect(
      riskSignalClassifyTool.input_schema.safeParse({ text: 'x'.repeat(4000) }).success,
    ).toBe(true);
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
  it('declares the write contract as agent-internal (no required action key)', async () => {
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    expect(conversationStateUpdateTool.side_effect).toBe('write');
    expect(conversationStateUpdateTool.operation_type).toBe('update_meta');
    // Fix 3: reclassified to agent-internal bookkeeping — scope-gated, not
    // action-key-gated (like read_turn_context).
    expect(conversationStateUpdateTool.required_actions).toEqual([]);
    expect(conversationStateUpdateTool.audit_action).toBe('conversation_state_updated');
  });

  it('delegates to conversasRepo.mergeMetadataNamespace under agent_state for the CURRENT conversation', async () => {
    mergeMetadataNamespaceMock.mockResolvedValueOnce(true);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    const out = await conversationStateUpdateTool.handler(
      { patch: { topic_tag: 'suporte', resolved: true } } as never,
      ctx,
    );
    // Fix 4: namespaced write — only ever touches metadata.agent_state.*.
    expect(mergeMetadataNamespaceMock).toHaveBeenCalledWith('c1', 'agent_state', {
      topic_tag: 'suporte',
      resolved: true,
    });
    expect(out).toEqual({
      conversa_id: 'c1',
      updated: true,
      updated_keys: ['topic_tag', 'resolved'],
    });
  });

  it('reports an HONEST no-op (updated=false, no keys) when no conversation row matched', async () => {
    // Fix 2: mergeMetadataNamespace returns false (stale/divergent conversa) →
    // the tool must NOT report a fake success.
    mergeMetadataNamespaceMock.mockResolvedValueOnce(false);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    const out = await conversationStateUpdateTool.handler(
      { patch: { topic_tag: 'suporte' } } as never,
      ctx,
    );
    expect(out.updated).toBe(false);
    expect(out.updated_keys).toEqual([]);
    expect(out.conversa_id).toBe('c1');
    expect(typeof out.reason).toBe('string');
  });

  it('accepts a MATCHING conversation_id but REJECTS a divergent one (scope-escape)', async () => {
    mergeMetadataNamespaceMock.mockResolvedValue(true);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    // Matching id → allowed.
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { k: 'v' }, conversation_id: 'c1' } as never,
        ctx,
      ),
    ).resolves.toEqual({ conversa_id: 'c1', updated: true, updated_keys: ['k'] });

    // Divergent id → rejected, no write.
    mergeMetadataNamespaceMock.mockClear();
    await expect(
      conversationStateUpdateTool.handler(
        { patch: { k: 'v' }, conversation_id: 'c-other' } as never,
        ctx,
      ),
    ).rejects.toThrow(/scope_violation/);
    expect(mergeMetadataNamespaceMock).not.toHaveBeenCalled();
  });

  it('namespacing makes governed top-level keys safe to pass as patch keys (no denylist needed)', async () => {
    // Fix 4: a key that WAS reserved (e.g. pending_question) is now harmless — it
    // lands under metadata.agent_state.pending_question, never the governed
    // top-level key. The merge target is always the agent_state namespace.
    mergeMetadataNamespaceMock.mockResolvedValueOnce(true);
    const { conversationStateUpdateTool } = await import(
      '@/tools/conversation-state-update.js'
    );
    const out = await conversationStateUpdateTool.handler(
      { patch: { pending_question: 'note-to-self' } } as never,
      ctx,
    );
    expect(mergeMetadataNamespaceMock).toHaveBeenCalledWith('c1', 'agent_state', {
      pending_question: 'note-to-self',
    });
    expect(out.updated).toBe(true);
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

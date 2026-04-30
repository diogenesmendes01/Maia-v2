import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock and lets the mock factories close over
// shared mutable state. We use this for two reasons:
//   1. The Proxy-based config mock needs to read a flag value that the test
//      can flip per-case (Task 6 flag-off scenario).
//   2. The db/client mock needs to return a query-chain whose terminal
//      `.limit(1)` resolves to the conversa+pessoa row that
//      `loadConversaWithPessoa` (core.ts:368) returns. Production code uses
//      dynamic imports of `@/db/client.js` and `@/db/schema.js`; vitest
//      intercepts those, so the mock factories surface as the resolved
//      modules. Without this mock, the agent-loop tests in Tasks 6/7 would
//      throw `TypeError: db.select is not a function` at core.ts:373 before
//      reaching the no-tool-uses branch under test.
const { flagState, dbState } = vi.hoisted(() => ({
  flagState: { FEATURE_VIEW_ONCE_SENSITIVE: true },
  dbState: { conversaResult: [] as unknown[] },
}));

const sendOutboundText = vi.fn();
const findById = vi.fn();
const audit = vi.fn();
const createMensagem = vi.fn();
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const recentInConversation = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText,
  isBaileysConnected: () => true,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem,
    findById: findMensagem,
    markProcessed,
    recentInConversation,
    setConversaId: vi.fn(),
    createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
// Drizzle query-chain mock — see vi.hoisted block above for rationale.
vi.mock('../../src/db/client.js', () => {
  const fakeQuery = {
    from: () => fakeQuery,
    innerJoin: () => fakeQuery,
    where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return {
    db: { select: () => fakeQuery },
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});
vi.mock('../../src/db/schema.js', () => ({
  conversas: {} as unknown,
  pessoas: {} as unknown,
}));
vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
}));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy(
    {
      FEATURE_ONE_TAP: false,
      FEATURE_PENDING_GATE: false,
      OWNER_TELEFONE_WHATSAPP: '+5511999999999',
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop === 'FEATURE_VIEW_ONCE_SENSITIVE') return flagState.FEATURE_VIEW_ONCE_SENSITIVE;
        return target[prop as string];
      },
    },
  ),
}));

// Task 6: additional vi.mock calls for the agent-loop tests below.
const dispatchTool = vi.fn();
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const buildPrompt = vi.fn();
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt,
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));

vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));

vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(),
  handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll: vi.fn(),
}));
vi.mock('../../src/workflows/pending-questions.js', () => ({
  getActivePending: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

describe('sendOutbound — view_once threading', () => {
  beforeEach(() => {
    sendOutboundText.mockReset();
    findById.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    sendOutboundText.mockResolvedValue('WAID-1');
    findById.mockResolvedValue({ id: 'p1', telefone_whatsapp: '+5511888888888' });
  });

  it('forwards view_once to sendOutboundText when set', async () => {
    const core = await import('../../src/agent/core.js');
    // sendOutbound is module-private; expose via _internal hook
    await core._internal.sendOutbound('p1', 'c1', 'Saldo R$ 1k', 'in1', { view_once: true });
    expect(sendOutboundText).toHaveBeenCalledWith(
      '5511888888888@s.whatsapp.net',
      'Saldo R$ 1k',
      expect.objectContaining({ view_once: true }),
    );
  });

  it('omits view_once when not set', async () => {
    const core = await import('../../src/agent/core.js');
    await core._internal.sendOutbound('p1', 'c1', 'Lista', 'in1', {});
    const call = sendOutboundText.mock.calls[0]!;
    expect(call[2]?.view_once).toBeUndefined();
  });
});

describe('Tool.sensitive registry surface', () => {
  it('query_balance and compare_entities are flagged sensitive; others are not', async () => {
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.query_balance?.sensitive).toBe(true);
    expect(REGISTRY.compare_entities?.sensitive).toBe(true);
    // spot-check a few non-sensitive tools
    expect(REGISTRY.list_transactions?.sensitive).toBeFalsy();
    expect(REGISTRY.register_transaction?.sensitive).toBeFalsy();
    expect(REGISTRY.ask_pending_question?.sensitive).toBeFalsy();
  });
});

const PESSOA = {
  id: 'p1',
  telefone_whatsapp: '+5511888888888',
  nome: 'Test',
  tipo: 'owner',
  preferencias: {},
} as never;
const INBOUND = {
  id: 'in1',
  conversa_id: 'c1',
  direcao: 'in' as const,
  tipo: 'texto' as const,
  conteudo: 'qual o saldo?',
  metadata: { whatsapp_id: 'WAID-IN' },
  processada_em: null,
};

const CONVERSA = { id: 'c1', pessoa_id: 'p1', status: 'ativa' } as never;

describe('agent loop — view-once decision + audit', () => {
  beforeEach(() => {
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    findById.mockReset();
    findMensagem.mockReset();
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findMensagem.mockResolvedValue({ ...INBOUND });
    findById.mockResolvedValue(PESSOA);
    sendOutboundText.mockResolvedValue('WAID-OUT');
    // Drizzle query-chain returns the conversa+pessoa join row that
    // loadConversaWithPessoa expects. The shape `{ conversas, pessoas }`
    // matches drizzle's innerJoin result format used in core.ts:368-380.
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];
    // tools: query_balance is sensitive, list_transactions is not.
    // The test imports the real REGISTRY (Task 3 flagged the two tools).
  });

  async function runWithToolUses(toolNames: string[]) {
    // First LLM call: tool uses
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: toolNames.map((t, i) => ({ id: `tu-${i}`, tool: t, args: {} })),
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    // Second LLM call: final text
    callLLM.mockResolvedValueOnce({
      content: 'Saldo R$ 1.234,56',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
  }

  it('sensitive turn (query_balance) + flag on + preference unset → view-once + audit', async () => {
    await runWithToolUses(['query_balance']);
    expect(sendOutboundText).toHaveBeenCalledWith(
      expect.stringMatching(/@s\.whatsapp\.net$/),
      'Saldo R$ 1.234,56',
      expect.objectContaining({ view_once: true }),
    );
    const auditCalls = audit.mock.calls.map((c) => c[0]);
    expect(auditCalls).toContainEqual(
      expect.objectContaining({
        acao: 'outbound_sent_view_once',
        metadata: expect.objectContaining({
          sensitive_tools: ['query_balance'],
          whatsapp_id: 'WAID-OUT',
        }),
      }),
    );
  });

  it('mixed turn (query_balance + list_transactions) → still view-once', async () => {
    await runWithToolUses(['list_transactions', 'query_balance']);
    expect(sendOutboundText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ view_once: true }),
    );
  });

  it('non-sensitive turn → no view-once; no view-once audit', async () => {
    await runWithToolUses(['list_transactions']);
    const lastCall = sendOutboundText.mock.calls.at(-1)!;
    expect(lastCall[2]?.view_once).toBeUndefined();
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).not.toContain('outbound_sent_view_once');
    expect(acoes).not.toContain('outbound_view_once_skipped_by_preference');
  });

  it('null WAID (Baileys disconnected) → no outbound_sent_view_once audit', async () => {
    sendOutboundText.mockResolvedValueOnce(null); // disconnect simulated
    await runWithToolUses(['query_balance']);
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).not.toContain('outbound_sent_view_once');
  });

  it('FEATURE_VIEW_ONCE_SENSITIVE=false → no view-once, no audit (even on sensitive turn)', async () => {
    // The shared config mock uses a Proxy whose getter reads
    // `flagState.FEATURE_VIEW_ONCE_SENSITIVE`. Flip it for this test:
    flagState.FEATURE_VIEW_ONCE_SENSITIVE = false;
    try {
      await runWithToolUses(['query_balance']);
      const lastCall = sendOutboundText.mock.calls.at(-1)!;
      // Agent loop gates `view_once` on the flag (Task 6 Step 3), so view_once
      // is never set on the call when the flag is off — even on a sensitive turn.
      expect(lastCall[2]?.view_once).toBeUndefined();
      const acoes = audit.mock.calls.map((c) => c[0].acao);
      expect(acoes).not.toContain('outbound_sent_view_once');
      expect(acoes).not.toContain('outbound_view_once_skipped_by_preference');
    } finally {
      flagState.FEATURE_VIEW_ONCE_SENSITIVE = true;
    }
  });
});

describe('agent loop — preference override', () => {
  beforeEach(() => {
    // Replicate Task 6's beforeEach (mock resets, defaults, dbState), then
    // override pessoa with balance_view_once: false.
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    findById.mockReset();
    findMensagem.mockReset();
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findMensagem.mockResolvedValue({ ...INBOUND });
    const PESSOA_OPTED_OUT = { ...PESSOA, preferencias: { balance_view_once: false } };
    findById.mockResolvedValue(PESSOA_OPTED_OUT);
    sendOutboundText.mockResolvedValue('WAID-OUT');
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA_OPTED_OUT }];
  });

  it('preference=false on sensitive turn → no view-once; skipped audit fires', async () => {
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 't1', tool: 'query_balance', args: {} }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Saldo R$ 1.234',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    // Outbound went out as plain text — no view_once
    const lastCall = sendOutboundText.mock.calls.at(-1)!;
    expect(lastCall[2]?.view_once).toBeUndefined();

    // Skipped audit fired
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    expect(acoes).toContain('outbound_view_once_skipped_by_preference');
    // Success audit did NOT fire
    expect(acoes).not.toContain('outbound_sent_view_once');
  });

  it('preference=false + Baileys disconnected → skipped audit STILL fires (decision-time)', async () => {
    sendOutboundText.mockResolvedValueOnce(null);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 't1', tool: 'query_balance', args: {} }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Saldo',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({ ok: true });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const acoes = audit.mock.calls.map((c) => c[0].acao);
    // Skipped audit was emitted before the send attempt
    expect(acoes).toContain('outbound_view_once_skipped_by_preference');
  });
});

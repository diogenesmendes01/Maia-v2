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

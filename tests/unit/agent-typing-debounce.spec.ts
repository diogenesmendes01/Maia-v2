import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startTyping = vi.fn().mockReturnValue({ stop: vi.fn() });
const sendReaction = vi.fn();

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/baileys-test', FEATURE_PRESENCE: true },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findById: vi.fn(), setConversaId: vi.fn(), markProcessed: vi.fn(), create: vi.fn() },
  conversasRepo: { findActive: vi.fn(), create: vi.fn(), touch: vi.fn() },
  pessoasRepo: { findByPhone: vi.fn(), findById: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/governance/permissions.js', () => ({ resolveScope: vi.fn() }));
vi.mock('../../src/lib/claude.js', () => ({ callLLM: vi.fn() }));
vi.mock('../../src/gateway/baileys.js', () => ({ sendOutboundText: vi.fn() }));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool: vi.fn() }));
vi.mock('../../src/tools/_registry.js', () => ({ REGISTRY: {}, getToolSchemas: () => [] }));
vi.mock('../../src/agent/prompt-builder.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn(),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

vi.mock('../../src/gateway/presence.js', () => ({
  startTyping,
  sendReaction,
  quotedReplyContext: () => undefined,
}));

beforeEach(() => {
  vi.useFakeTimers();
  startTyping.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('agent — typing debounce', () => {
  it('does NOT call startTyping if the turn finishes before 1.5s', async () => {
    const { _internal } = await import('../../src/agent/core.js');
    const stop = _internal.scheduleTypingDebounce('jid', 'inbound-id');
    vi.advanceTimersByTime(1000);
    stop();
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('DOES call startTyping after 1.5s if the turn is still running', async () => {
    const { _internal } = await import('../../src/agent/core.js');
    _internal.scheduleTypingDebounce('jid', 'inbound-id');
    vi.advanceTimersByTime(1500);
    expect(startTyping).toHaveBeenCalledWith('jid', 'inbound-id');
  });
});

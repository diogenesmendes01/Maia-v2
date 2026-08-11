import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startTyping = vi.fn().mockReturnValue({ stop: vi.fn() });
const sendReaction = vi.fn();
// Fase 0 (spec roteamento §1.6): o typing sai pela fronteira LineOutput — o
// core resolve a line do canal da conversa e chama line.startTyping.
const forCurrentAgentChannel = vi.fn(async (_channel_id: string | null) => ({
  scope: { tenant_id: 't', agent_id: 'a', channel_id: 'ch-1' },
  startTyping,
}));

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
vi.mock('../../src/gateway/line-output.js', () => ({ forCurrentAgentChannel }));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool: vi.fn() }));
vi.mock('../../src/tools/_registry.js', () => ({ REGISTRY: {}, getToolSchemas: () => [] }));
vi.mock('../../src/agent/prompt-builder.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn(),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(),
  sendReaction,
  quotedReplyContext: () => undefined,
}));

beforeEach(() => {
  vi.useFakeTimers();
  startTyping.mockClear();
  forCurrentAgentChannel.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('agent — typing debounce', () => {
  it('does NOT call startTyping if the turn finishes before 1.5s', async () => {
    const { _internal } = await import('../../src/agent/core.js');
    const stop = _internal.scheduleTypingDebounce('jid', 'inbound-id', 'ch-1');
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.runAllTimersAsync();
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('DOES call startTyping after 1.5s if the turn is still running', async () => {
    const { _internal } = await import('../../src/agent/core.js');
    _internal.scheduleTypingDebounce('jid', 'inbound-id', 'ch-1');
    await vi.advanceTimersByTimeAsync(1500);
    expect(forCurrentAgentChannel).toHaveBeenCalledWith('ch-1');
    expect(startTyping).toHaveBeenCalledWith('jid', 'inbound-id');
  });

  it('suppresses typing (never throws) when the line cannot be resolved', async () => {
    forCurrentAgentChannel.mockRejectedValueOnce(
      Object.assign(new Error('channel_ambiguous'), { code: 'channel_ambiguous' }) as never,
    );
    const { _internal } = await import('../../src/agent/core.js');
    _internal.scheduleTypingDebounce('jid', 'inbound-id', null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(startTyping).not.toHaveBeenCalled();
  });

  it('stops typing even when stop() races the async line resolution', async () => {
    const stopSpy = vi.fn();
    startTyping.mockReturnValueOnce({ stop: stopSpy });
    const { _internal } = await import('../../src/agent/core.js');
    const stop = _internal.scheduleTypingDebounce('jid', 'inbound-id', 'ch-1');
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    // O handle já existia quando stop() rodou → stop() deve propagar.
    expect(stopSpy).toHaveBeenCalled();
  });
});

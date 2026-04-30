import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/test', FEATURE_VIEW_ONCE_SENSITIVE: true, LOG_LEVEL: 'info' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

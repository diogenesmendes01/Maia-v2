import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock the gateway/baileys module to avoid redis/config issues
vi.mock('../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/media',
}));

describe('REGISTRY — generate_report flag gating', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers generate_report when FEATURE_PDF_REPORTS=true', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: true },
    }));
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.generate_report).toBeDefined();
    expect(REGISTRY.generate_report?.name).toBe('generate_report');
  });

  it('omits generate_report when FEATURE_PDF_REPORTS=false', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: false },
    }));
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.generate_report).toBeUndefined();
  });

  it('getToolSchemas excludes generate_report when flag off (owner profile)', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: false },
    }));
    const { getToolSchemas } = await import('../../src/tools/_registry.js');
    const ownerByEntity = new Map([
      ['e1', { profile: { acoes: ['*'] }, effective_limits: {} } as never],
    ]);
    const schemas = getToolSchemas(ownerByEntity);
    expect(schemas.find((s) => s.name === 'generate_report')).toBeUndefined();
  });
});

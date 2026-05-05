/**
 * parse_receipt handler tests — spec 10 §5.3. Complements the existing
 * parse-image.spec.ts (which exercises the boleto/receipt decision tree)
 * by directly asserting cache + schema behavior of the standalone tool.
 *
 * Mocks: Vision client, _vision-cache, logger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const visionMock = vi.fn();
const getCachedMock = vi.fn();
const setCachedMock = vi.fn();

vi.mock('../../../src/lib/vision.js', () => ({
  parseImage: (...args: unknown[]) => visionMock(...args),
}));

vi.mock('../../../src/tools/_vision-cache.js', () => ({
  getCachedVision: (...args: unknown[]) => getCachedMock(...args),
  setCachedVision: (...args: unknown[]) => setCachedMock(...args),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

beforeEach(() => {
  visionMock.mockReset();
  getCachedMock.mockReset();
  setCachedMock.mockReset();
  getCachedMock.mockResolvedValue(null);
  setCachedMock.mockResolvedValue(undefined);
});

type HandlerCtx = Parameters<
  Awaited<typeof import('../../../src/tools/parse-receipt.js')>['parseReceiptTool']['handler']
>[1];
const fakeCtx = {} as HandlerCtx;

describe('parse_receipt — handler', () => {
  it('happy path: returns confianca 0.85 with full fields and writes cache', async () => {
    visionMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 1234.56,
      data: '2026-04-01',
      beneficiario_nome: 'Maria Silva',
      beneficiario_chave_pix: 'maria@example.com',
      banco_origem: 'Itaú',
      banco_destino: 'Nubank',
      endToEndId: 'E12345678202604011200000000000000',
    });
    const { parseReceiptTool } = await import('../../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake/receipt.png', file_sha256: 'sha-rok' },
      fakeCtx,
    );
    expect(out.tipo).toBe('pix');
    expect(out.valor).toBe(1234.56);
    expect(out.beneficiario_nome).toBe('Maria Silva');
    expect(out.banco_origem).toBe('Itaú');
    expect(out.endToEndId).toBe('E12345678202604011200000000000000');
    expect(out.confianca).toBe(0.85);
    expect(setCachedMock).toHaveBeenCalledWith(
      'parse_receipt',
      'sha-rok',
      expect.objectContaining({ confianca: 0.85 }),
    );
  });

  it('Vision returns null → empty result with confianca 0 (still cached)', async () => {
    visionMock.mockResolvedValueOnce(null);
    const { parseReceiptTool } = await import('../../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake/blurry.png', file_sha256: 'sha-empty' },
      fakeCtx,
    );
    expect(out).toEqual({ confianca: 0 });
    expect(setCachedMock).toHaveBeenCalledWith('parse_receipt', 'sha-empty', { confianca: 0 });
  });

  it('cache hit: returns cached value without calling Vision', async () => {
    getCachedMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 50,
      beneficiario_nome: 'Cached User',
      confianca: 0.85,
    });
    const { parseReceiptTool } = await import('../../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake/x.png', file_sha256: 'sha-cached' },
      fakeCtx,
    );
    expect(out.beneficiario_nome).toBe('Cached User');
    expect(visionMock).not.toHaveBeenCalled();
    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it('schema rejects empty media_local_path', async () => {
    const { parseReceiptTool } = await import('../../../src/tools/parse-receipt.js');
    const r = parseReceiptTool.input_schema.safeParse({
      media_local_path: '',
      file_sha256: 'sha',
    });
    expect(r.success).toBe(false);
  });
});

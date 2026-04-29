/**
 * parse_image router test — proves the deterministic decision tree per
 * spec 10 §4.3: try boleto first (validated linha digitável), fall back
 * to receipt only when boleto extraction does not yield a valid 47-digit
 * line. Uses vi.mock on the vision module — no real Anthropic call.
 *
 * The vision-cache module is mocked to a no-op so this spec doesn't touch
 * Redis. Cache behavior is exercised separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const visionMock = vi.fn();

vi.mock('../../src/lib/vision.js', () => ({
  parseImage: (...args: unknown[]) => visionMock(...args),
}));

vi.mock('../../src/tools/_vision-cache.js', () => ({
  getCachedVision: async () => null,
  setCachedVision: async () => undefined,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

vi.mock('../../src/lib/brazilian.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/brazilian.js')>(
    '../../src/lib/brazilian.js',
  );
  return {
    ...actual,
    isValidLinhaDigitavel: (s: string) => s === '1'.repeat(47),
    parseLinhaDigitavel: (s: string) =>
      s === '1'.repeat(47)
        ? {
            codigo_barras: '0'.repeat(44),
            valor: 100,
            vencimento_data: '2026-12-01',
            banco_codigo: '001',
          }
        : null,
    BANCOS_CODIGO: { '001': 'Banco do Brasil' },
  };
});

beforeEach(() => visionMock.mockReset());

type HandlerCtx = Parameters<
  Awaited<typeof import('../../src/tools/parse-image.js')>['parseImageTool']['handler']
>[1];
const fakeCtx = {} as HandlerCtx;

describe('parse_image — decision tree', () => {
  it('returns boleto when linha digitável validates', async () => {
    visionMock.mockResolvedValueOnce({
      linha_digitavel: '1'.repeat(47),
      beneficiario_nome: 'Cred',
    });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-boleto' },
      fakeCtx,
    );
    expect(out.kind).toBe('boleto');
    expect(out.boleto?.linha_digitavel).toBe('1'.repeat(47));
    expect(out.confianca).toBe(0.9);
    expect(visionMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to receipt when boleto path yields no valid linha', async () => {
    visionMock
      .mockResolvedValueOnce({ linha_digitavel: 'not-digits' })
      .mockResolvedValueOnce({
        tipo: 'pix',
        valor: 50,
        beneficiario_nome: 'João',
        endToEndId: 'E12345678202601011200000000000000',
      });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-receipt' },
      fakeCtx,
    );
    expect(out.kind).toBe('receipt');
    expect(out.receipt?.tipo).toBe('pix');
    expect(out.confianca).toBe(0.85);
    expect(visionMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to receipt with parseLinhaDigitavel returning null', async () => {
    // boleto raw has correct length but isValidLinhaDigitavel says no →
    // the receipt fallback path runs.
    visionMock
      .mockResolvedValueOnce({ linha_digitavel: '2'.repeat(47) })
      .mockResolvedValueOnce({ valor: 25, beneficiario_nome: 'Maria' });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-fallthrough' },
      fakeCtx,
    );
    expect(out.kind).toBe('receipt');
    expect(out.receipt?.valor).toBe(25);
    expect(out.confianca).toBe(0.85);
    expect(visionMock).toHaveBeenCalledTimes(2);
  });

  it('returns receipt with confianca 0.6 when only valor is present', async () => {
    visionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ valor: 10 });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-only-valor' },
      fakeCtx,
    );
    expect(out.kind).toBe('receipt');
    expect(out.receipt?.valor).toBe(10);
    expect(out.confianca).toBe(0.6);
  });

  it('returns receipt with confianca 0.6 when only beneficiario is present', async () => {
    visionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ beneficiario_nome: 'Pedro' });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-only-name' },
      fakeCtx,
    );
    expect(out.kind).toBe('receipt');
    expect(out.receipt?.beneficiario_nome).toBe('Pedro');
    expect(out.confianca).toBe(0.6);
  });

  it('returns unknown when both parsers yield nothing usable', async () => {
    visionMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-unknown' },
      fakeCtx,
    );
    expect(out.kind).toBe('unknown');
    expect(out.confianca).toBe(0);
  });
});

describe('parse_receipt — direct', () => {
  it('returns confianca 0.85 with both valor and beneficiario_nome', async () => {
    visionMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 100,
      beneficiario_nome: 'Ana',
      banco_origem: 'Itau',
      banco_destino: 'BB',
    });
    const { parseReceiptTool } = await import('../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-r-full' },
      fakeCtx,
    );
    expect(out.confianca).toBe(0.85);
    expect(out.banco_origem).toBe('Itau');
    expect(out.banco_destino).toBe('BB');
  });

  it('returns confianca 0.6 with only valor', async () => {
    visionMock.mockResolvedValueOnce({ valor: 50 });
    const { parseReceiptTool } = await import('../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-r-valor' },
      fakeCtx,
    );
    expect(out.confianca).toBe(0.6);
  });

  it('returns confianca 0.6 with only beneficiario_nome', async () => {
    visionMock.mockResolvedValueOnce({ beneficiario_nome: 'Joana' });
    const { parseReceiptTool } = await import('../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-r-name' },
      fakeCtx,
    );
    expect(out.confianca).toBe(0.6);
  });

  it('returns confianca 0 when vision yields nothing', async () => {
    visionMock.mockResolvedValueOnce(null);
    const { parseReceiptTool } = await import('../../src/tools/parse-receipt.js');
    const out = await parseReceiptTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha-r-empty' },
      fakeCtx,
    );
    expect(out.confianca).toBe(0);
  });
});

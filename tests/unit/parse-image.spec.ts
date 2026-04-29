/**
 * parse_image router test — proves the deterministic decision tree per
 * spec 10 §4.3: try boleto first (validated linha digitável), fall back
 * to receipt only when boleto extraction does not yield a valid 47-digit
 * line. Uses vi.mock on the vision module — no real Anthropic call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const visionMock = vi.fn();

vi.mock('../../src/lib/vision.js', () => ({
  parseImage: (...args: unknown[]) => visionMock(...args),
}));

vi.mock('../../src/lib/brazilian.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/brazilian.js')>(
    '../../src/lib/brazilian.js',
  );
  return {
    ...actual,
    // Force a known-valid linha digitável path so we don't depend on the real
    // mod-10/mod-11 algorithm for fixture data.
    isValidLinhaDigitavel: (s: string) => s === '1'.repeat(47),
    parseLinhaDigitavel: (s: string) =>
      s === '1'.repeat(47)
        ? { codigo_barras: '0'.repeat(44), valor: 100, vencimento_data: '2026-12-01', banco_codigo: '001' }
        : null,
    BANCOS_CODIGO: { '001': 'Banco do Brasil' },
  };
});

beforeEach(() => visionMock.mockReset());

describe('parse_image — decision tree', () => {
  it('returns boleto when linha digitável validates', async () => {
    visionMock.mockResolvedValueOnce({
      linha_digitavel: '1'.repeat(47),
      beneficiario_nome: 'Cred',
    });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha' },
      // ctx is unused by the handler
      {} as Parameters<typeof parseImageTool.handler>[1],
    );
    expect(out.kind).toBe('boleto');
    expect(out.boleto?.linha_digitavel).toBe('1'.repeat(47));
    expect(out.confianca).toBe(0.9);
    expect(visionMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to receipt when boleto path yields no valid linha', async () => {
    visionMock
      .mockResolvedValueOnce({ linha_digitavel: 'not-digits' }) // boleto attempt
      .mockResolvedValueOnce({
        tipo: 'pix',
        valor: 50,
        beneficiario_nome: 'João',
        endToEndId: 'E12345678202601011200000000000000',
      });
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha' },
      {} as Parameters<typeof parseImageTool.handler>[1],
    );
    expect(out.kind).toBe('receipt');
    expect(out.receipt?.tipo).toBe('pix');
    expect(out.confianca).toBe(0.85);
    expect(visionMock).toHaveBeenCalledTimes(2);
  });

  it('returns unknown when both parsers yield nothing usable', async () => {
    visionMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const { parseImageTool } = await import('../../src/tools/parse-image.js');
    const out = await parseImageTool.handler(
      { media_local_path: '/fake', file_sha256: 'sha' },
      {} as Parameters<typeof parseImageTool.handler>[1],
    );
    expect(out.kind).toBe('unknown');
    expect(out.confianca).toBe(0);
  });
});

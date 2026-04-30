import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-extrato-test-' + Date.now());

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys'),
    FEATURE_PDF_REPORTS: true,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeAll(async () => {
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});

afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

describe('generateExtratoPdf', () => {
  it('produces a valid PDF (magic bytes %PDF) at <MEDIA_ROOT>/tmp/*.pdf', async () => {
    const { generateExtratoPdf } = await import('../../src/lib/pdf/extrato.js');
    const result = await generateExtratoPdf({
      ownerName: 'Owner Test',
      entidadeName: 'Empresa X',
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      transactions: [
        { data_competencia: '2026-04-05', natureza: 'receita', valor: 1000, descricao: 'Cliente A', categoriaNome: 'Vendas' },
        { data_competencia: '2026-04-10', natureza: 'despesa', valor: 250, descricao: 'Aluguel', categoriaNome: 'Operacional' },
      ],
    });
    expect(result.path).toMatch(/[/\\]tmp[/\\][a-f0-9-]+\.pdf$/);
    expect(result.fileName).toMatch(/^extrato-empresa-x-2026-04\.pdf$/);
    const buf = await readFile(result.path);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(result.summary.period).toBe('01/04/2026 a 30/04/2026');
    expect(result.summary.rowCount).toBe(2);
    expect(result.summary.totals).toEqual({ receita: 1000, despesa: 250, lucro: 750 });
    await unlink(result.path);
  });

  it('truncates at 500 rows and reports it in summary.rowCount', async () => {
    const { generateExtratoPdf } = await import('../../src/lib/pdf/extrato.js');
    const txns = Array.from({ length: 600 }, (_, i) => ({
      data_competencia: `2026-04-${String((i % 30) + 1).padStart(2, '0')}`,
      natureza: 'receita' as const,
      valor: 10,
      descricao: `Tx ${i}`,
      categoriaNome: 'Vendas',
    }));
    const result = await generateExtratoPdf({
      ownerName: 'Owner', entidadeName: 'Empresa Y',
      date_from: '2026-04-01', date_to: '2026-04-30', transactions: txns,
    });
    expect(result.summary.rowCount).toBe(500);
    await unlink(result.path);
  });

  it('handles empty transaction list (header + empty table + zero totals)', async () => {
    const { generateExtratoPdf } = await import('../../src/lib/pdf/extrato.js');
    const result = await generateExtratoPdf({
      ownerName: 'Owner', entidadeName: 'Empresa Z',
      date_from: '2026-04-01', date_to: '2026-04-30', transactions: [],
    });
    expect(result.summary.rowCount).toBe(0);
    expect(result.summary.totals).toEqual({ receita: 0, despesa: 0, lucro: 0 });
    const buf = await readFile(result.path);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    await unlink(result.path);
  });
});

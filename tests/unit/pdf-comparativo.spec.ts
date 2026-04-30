import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-comparativo-test-' + Date.now());

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

describe('generateComparativoPdf', () => {
  it('produces valid PDF with rows per entidade and a consolidado row in summary', async () => {
    const { generateComparativoPdf } = await import('../../src/lib/pdf/comparativo.js');
    const result = await generateComparativoPdf({
      ownerName: 'Owner',
      date_from: '2026-04-01',
      date_to: '2026-04-30',
      rows: [
        { entidade_id: 'e1', entidade_nome: 'Empresa A', receita: 5000, despesa: 2000, lucro: 3000, caixa_final: 12000 },
        { entidade_id: 'e2', entidade_nome: 'Empresa B', receita: 3000, despesa: 1500, lucro: 1500, caixa_final: 8000 },
      ],
    });
    expect(result.path).toMatch(/[/\\]tmp[/\\][a-f0-9-]+\.pdf$/);
    expect(result.fileName).toMatch(/^comparativo-2026-04\.pdf$/);
    const buf = await readFile(result.path);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(result.summary.period).toBe('01/04/2026 a 30/04/2026');
    expect(result.summary.totals).toEqual({ receita: 8000, despesa: 3500, lucro: 4500 });
    await unlink(result.path);
  });
});

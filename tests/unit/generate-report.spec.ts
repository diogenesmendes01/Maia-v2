import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-generate-report-test-' + Date.now());

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys'),
    FEATURE_PDF_REPORTS: true,
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const byScope = vi.fn();
const entidadeById = vi.fn();
const entidadesByIds = vi.fn();
const categoriaById = vi.fn();
const contasByEntity = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  transacoesRepo: { byScope },
  entidadesRepo: { byId: entidadeById, byIds: entidadesByIds },
  categoriasRepo: { byId: categoriaById },
  contasRepo: { byEntity: contasByEntity },
}));

beforeAll(async () => {
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});
afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

const ctx = {
  pessoa: { id: 'p1', nome: 'Owner' } as never,
  scope: { entidades: ['e1', 'e2'], byEntity: new Map() },
  conversa: { id: 'c1' } as never,
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'k1',
};

describe('generate_report — schema validation', () => {
  it('rejects extrato with missing entidade_id', async () => {
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const parsed = generateReportTool.input_schema.safeParse({
      tipo: 'extrato', date_from: '2026-04-01', date_to: '2026-04-30',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects comparativo with only 1 entidade_ids', async () => {
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const parsed = generateReportTool.input_schema.safeParse({
      tipo: 'comparativo', entidade_ids: ['00000000-0000-0000-0000-000000000001'],
      date_from: '2026-04-01', date_to: '2026-04-30',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects comparativo with > 8 entidade_ids', async () => {
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const ids = Array.from({ length: 9 }, (_, i) =>
      `00000000-0000-0000-0000-00000000000${i + 1}`,
    );
    const parsed = generateReportTool.input_schema.safeParse({
      tipo: 'comparativo',
      entidade_ids: ids,
      date_from: '2026-04-01', date_to: '2026-04-30',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('generate_report — extrato handler', () => {
  beforeEach(() => {
    byScope.mockReset();
    entidadeById.mockReset();
    categoriaById.mockReset();
  });

  it('returns forbidden when entidade_id outside scope', async () => {
    const eOther = '00000000-0000-0000-0000-000000000099';
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'extrato', entidade_id: eOther, date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctx,
    );
    expect(out).toEqual(expect.objectContaining({ error: 'forbidden' }));
  });

  it('produces a valid PDF with summary on happy path', async () => {
    const eUuid = '00000000-0000-0000-0000-00000000000e';
    const ctxWithE = { ...ctx, scope: { entidades: [eUuid], byEntity: new Map() } };
    entidadeById.mockResolvedValue({ id: eUuid, nome: 'Empresa Teste' });
    byScope.mockResolvedValue([
      { data_competencia: '2026-04-05', natureza: 'receita', valor: '1500.00', descricao: 'X', categoria_id: 'cat1' },
      { data_competencia: '2026-04-10', natureza: 'despesa', valor: '300.00', descricao: 'Y', categoria_id: null },
    ]);
    categoriaById.mockResolvedValue({ id: 'cat1', nome: 'Vendas' });

    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = (await generateReportTool.handler(
      { tipo: 'extrato', entidade_id: eUuid, date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctxWithE,
    )) as { path: string; fileName: string; mimetype: string; tipo: string; summary: { totals: { receita: number; despesa: number; lucro: number } } };

    expect(out.mimetype).toBe('application/pdf');
    expect(out.tipo).toBe('extrato');
    expect(out.summary.totals).toEqual({ receita: 1500, despesa: 300, lucro: 1200 });
    const buf = await readFile(out.path);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});

describe('generate_report — comparativo handler', () => {
  beforeEach(() => {
    byScope.mockReset();
    entidadesByIds.mockReset();
    contasByEntity.mockReset();
  });

  it('returns forbidden when ALL entidade_ids outside scope', async () => {
    const eX = '00000000-0000-0000-0000-0000000000aa';
    const eY = '00000000-0000-0000-0000-0000000000bb';
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'comparativo', entidade_ids: [eX, eY], date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctx,
    );
    expect(out).toEqual(expect.objectContaining({ error: 'forbidden' }));
  });

  it('returns comparativo_needs_two when scope filter leaves only 1 entidade', async () => {
    const e1 = 'e1';
    const eOther = '00000000-0000-0000-0000-0000000000cc';
    const ctxOne = { ...ctx, scope: { entidades: [e1], byEntity: new Map() } };
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'comparativo', entidade_ids: [e1, eOther], date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctxOne,
    );
    expect(out).toEqual(expect.objectContaining({ error: 'comparativo_needs_two' }));
  });

  it('happy path: 2 entidades produces valid PDF', async () => {
    entidadesByIds.mockResolvedValue([
      { id: 'e1', nome: 'A' }, { id: 'e2', nome: 'B' },
    ]);
    byScope
      .mockResolvedValueOnce([{ natureza: 'receita', valor: '1000.00' }])
      .mockResolvedValueOnce([{ natureza: 'despesa', valor: '200.00' }]);
    contasByEntity
      .mockResolvedValueOnce([{ saldo_atual: '5000.00' }])
      .mockResolvedValueOnce([{ saldo_atual: '3000.00' }]);
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = (await generateReportTool.handler(
      { tipo: 'comparativo', entidade_ids: ['e1','e2'], date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctx,
    )) as { path: string; tipo: string; summary: { totals: { receita: number; despesa: number; lucro: number } } };
    expect(out.tipo).toBe('comparativo');
    expect(out.summary.totals).toEqual({ receita: 1000, despesa: 200, lucro: 800 });
    const buf = await readFile(out.path);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});

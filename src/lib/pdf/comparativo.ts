import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import {
  buildPdfHeader,
  PDF_STYLES,
  formatPeriodBR,
  fmtBRLSigned,
  renderPdfToBuffer,
} from './_helpers.js';

export type ComparativoRow = {
  entidade_id: string;
  entidade_nome: string;
  receita: number;
  despesa: number;
  lucro: number;
  caixa_final: number;
};

export type ComparativoInput = {
  ownerName: string;
  date_from: string;
  date_to: string;
  rows: ComparativoRow[];
};

export type ComparativoResult = {
  path: string;
  fileName: string;
  summary: {
    period: string;
    rowCount: number;
    totals: { receita: number; despesa: number; lucro: number };
  };
};

export async function generateComparativoPdf(input: ComparativoInput): Promise<ComparativoResult> {
  const period = formatPeriodBR(input.date_from, input.date_to);
  const generatedAtBR = fmtBR(new Date());

  const totals = input.rows.reduce(
    (acc, r) => {
      acc.receita += r.receita;
      acc.despesa += r.despesa;
      acc.lucro += r.lucro;
      acc.caixa_final += r.caixa_final;
      return acc;
    },
    { receita: 0, despesa: 0, lucro: 0, caixa_final: 0 },
  );

  const tableBody: unknown[][] = [
    [
      { text: 'Entidade', style: 'tableHeader' },
      { text: 'Receita', style: ['tableHeader', 'cellRight'] },
      { text: 'Despesa', style: ['tableHeader', 'cellRight'] },
      { text: 'Lucro', style: ['tableHeader', 'cellRight'] },
      { text: 'Caixa Final', style: ['tableHeader', 'cellRight'] },
    ],
  ];

  for (const r of input.rows) {
    tableBody.push([
      r.entidade_nome,
      { text: fmtBRLSigned(r.receita), style: 'cellRight' },
      { text: fmtBRLSigned(r.despesa), style: 'cellRight' },
      { text: fmtBRLSigned(r.lucro), style: ['cellRight', r.lucro < 0 ? 'cellNegative' : ''] },
      { text: fmtBRLSigned(r.caixa_final), style: 'cellRight' },
    ]);
  }

  // Consolidado row
  tableBody.push([
    { text: 'Consolidado', style: 'totalRow' },
    { text: fmtBRLSigned(totals.receita), style: ['totalRow', 'cellRight'] },
    { text: fmtBRLSigned(totals.despesa), style: ['totalRow', 'cellRight'] },
    { text: fmtBRLSigned(totals.lucro), style: ['totalRow', 'cellRight', totals.lucro < 0 ? 'cellNegative' : ''] },
    { text: fmtBRLSigned(totals.caixa_final), style: ['totalRow', 'cellRight'] },
  ]);

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    content: [
      buildPdfHeader({
        title: 'Comparativo entre Entidades',
        ownerName: input.ownerName,
        period,
        generatedAtBR,
      }),
      {
        table: {
          headerRows: 1,
          widths: ['*', 90, 90, 90, 100],
          body: tableBody,
        },
        layout: 'lightHorizontalLines',
      },
    ],
    styles: PDF_STYLES,
    defaultStyle: { fontSize: 10, font: 'Helvetica' },
  };

  const buf = await renderPdfToBuffer(docDefinition);
  const path = join(MEDIA_ROOT, 'tmp', `${randomUUID()}.pdf`);
  await writeFile(path, buf);

  const yearMonth = input.date_to.slice(0, 7);
  const fileName = `comparativo-${yearMonth}.pdf`;

  return {
    path,
    fileName,
    summary: {
      period,
      rowCount: input.rows.length,
      totals: { receita: totals.receita, despesa: totals.despesa, lucro: totals.lucro },
    },
  };
}

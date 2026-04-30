import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import {
  buildPdfHeader,
  PDF_STYLES,
  slugify,
  formatPeriodBR,
  fmtBRLSigned,
  renderPdfToBuffer,
} from './_helpers.js';

const HARD_LIMIT_ROWS = 500;
const MAX_DESCRICAO_LEN = 120;

export type ExtratoTransaction = {
  data_competencia: string; // yyyy-MM-dd
  natureza: 'receita' | 'despesa' | 'movimentacao';
  valor: number;
  descricao: string;
  categoriaNome: string | null;
};

export type ExtratoInput = {
  ownerName: string;
  entidadeName: string;
  date_from: string; // yyyy-MM-dd
  date_to: string;
  transactions: ExtratoTransaction[];
};

export type ExtratoResult = {
  path: string;
  fileName: string;
  summary: {
    period: string;
    rowCount: number;
    totals: { receita: number; despesa: number; lucro: number };
  };
};

export async function generateExtratoPdf(input: ExtratoInput): Promise<ExtratoResult> {
  // Sort ASC by data_competencia (the spec requires asc; transacoesRepo returns desc).
  const sorted = [...input.transactions].sort((a, b) =>
    a.data_competencia.localeCompare(b.data_competencia),
  );
  const truncated = sorted.slice(0, HARD_LIMIT_ROWS);
  const wasTruncated = sorted.length > HARD_LIMIT_ROWS;

  const totals = truncated.reduce(
    (acc, t) => {
      if (t.natureza === 'receita') acc.receita += t.valor;
      else if (t.natureza === 'despesa') acc.despesa += t.valor;
      return acc;
    },
    { receita: 0, despesa: 0 },
  );
  const lucro = totals.receita - totals.despesa;

  const period = formatPeriodBR(input.date_from, input.date_to);
  const generatedAtBR = fmtBR(new Date());
  const tableBody: unknown[][] = [
    [
      { text: 'Data', style: 'tableHeader' },
      { text: 'Natureza', style: 'tableHeader' },
      { text: 'Valor', style: ['tableHeader', 'cellRight'] },
      { text: 'Categoria', style: 'tableHeader' },
      { text: 'Descrição', style: 'tableHeader' },
    ],
  ];

  if (truncated.length === 0) {
    tableBody.push([
      { text: 'Sem transações no período', colSpan: 5, alignment: 'center', italics: true },
      {}, {}, {}, {},
    ]);
  } else {
    for (const t of truncated) {
      const isDespesa = t.natureza === 'despesa';
      tableBody.push([
        isoToBR(t.data_competencia),
        t.natureza,
        {
          text: fmtBRLSigned(isDespesa ? -t.valor : t.valor),
          style: isDespesa ? ['cellRight', 'cellNegative'] : 'cellRight',
        },
        t.categoriaNome ?? '—',
        { text: truncate(t.descricao, MAX_DESCRICAO_LEN), noWrap: false },
      ]);
    }
  }

  const footerLines: string[] = [
    `Total receitas: ${fmtBRLSigned(totals.receita)}`,
    `Total despesas: ${fmtBRLSigned(totals.despesa)}`,
    `Lucro do período: ${fmtBRLSigned(lucro)}`,
    `Total de transações: ${truncated.length}${wasTruncated ? ' (truncado em 500 — refine o filtro)' : ''}`,
  ];

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    content: [
      buildPdfHeader({
        title: `Extrato — ${input.entidadeName}`,
        ownerName: input.ownerName,
        period,
        generatedAtBR,
      }),
      {
        table: {
          headerRows: 1,
          widths: [55, 65, 70, '*', '*'],
          body: tableBody,
        },
        layout: 'lightHorizontalLines',
      },
      {
        margin: [0, 14, 0, 0],
        stack: footerLines.map((line) => ({ text: line, fontSize: 9 })),
      },
    ],
    styles: PDF_STYLES,
    defaultStyle: { fontSize: 9, font: 'Helvetica' },
  };

  const buf = await renderPdfToBuffer(docDefinition);
  const path = join(MEDIA_ROOT, 'tmp', `${randomUUID()}.pdf`);
  await writeFile(path, buf);

  const yearMonth = input.date_to.slice(0, 7); // yyyy-MM
  const fileName = `extrato-${slugify(input.entidadeName)}-${yearMonth}.pdf`;

  return {
    path,
    fileName,
    summary: { period, rowCount: truncated.length, totals: { ...totals, lucro } },
  };
}

function isoToBR(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

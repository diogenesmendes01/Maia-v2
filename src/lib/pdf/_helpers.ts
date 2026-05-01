import { formatBRL } from '@/lib/brazilian.js';

/**
 * Lowercases, strips diacritics (NFD + remove combining marks), replaces
 * non-alphanumerics with hyphens, collapses runs of hyphens, and trims
 * leading/trailing hyphens. Used to build human-readable filenames for the
 * WhatsApp document attachment (e.g., "extrato-empresa-x-2026-04.pdf").
 */
export function slugify(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'untitled';
  const normalized = trimmed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'untitled';
}

/**
 * Format an ISO-date range (yyyy-MM-dd) as "dd/MM/yyyy a dd/MM/yyyy" for the
 * PDF header period line.
 */
export function formatPeriodBR(date_from: string, date_to: string): string {
  return `${isoToBR(date_from)} a ${isoToBR(date_to)}`;
}

function isoToBR(iso: string): string {
  // iso is yyyy-MM-dd from the schema's regex; safe to slice without parsing.
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * Brazilian Real formatter that preserves the sign for negatives. Delegates
 * positive formatting to `src/lib/brazilian.ts` so we stay consistent with
 * the rest of the app.
 *
 * Note: `Intl.NumberFormat('pt-BR', { style: 'currency' })` emits a
 * non-breaking space (U+00A0) between `R$` and the number. We normalize
 * that to a regular space (U+0020) so the output is easy to assert against
 * in tests and renders predictably in pdfmake table cells.
 */
export function fmtBRLSigned(value: number): string {
  const positive = formatBRL(Math.abs(value)).replace(/\u00A0/g, ' ');
  if (value >= 0) return positive;
  return '-' + positive;
}

/**
 * pdfmake Content fragment that renders the shared report header.
 * Returns a typed-as-`unknown` so we don't need to depend on
 * pdfmake types in non-pdf-loading codepaths.
 */
export function buildPdfHeader(opts: {
  title: string;
  ownerName: string;
  period: string;
  generatedAtBR: string;
}): unknown {
  return {
    stack: [
      { text: 'Maia', style: 'wordmark' },
      { text: opts.title, style: 'reportTitle' },
      { text: `Para: ${opts.ownerName}`, style: 'meta' },
      { text: `Período: ${opts.period}`, style: 'meta' },
      { text: `Gerado em: ${opts.generatedAtBR}`, style: 'meta' },
      { text: ' ', margin: [0, 0, 0, 8] },
    ],
  };
}

/**
 * Shared style sheet for both generators. Returned as a plain object so it
 * can be spread into the pdfmake docDefinition.
 */
export const PDF_STYLES = {
  wordmark: { fontSize: 18, bold: true, color: '#0b3954', margin: [0, 0, 0, 4] },
  reportTitle: { fontSize: 14, bold: true, margin: [0, 0, 0, 6] },
  meta: { fontSize: 9, color: '#555555', margin: [0, 0, 0, 2] },
  tableHeader: { bold: true, fillColor: '#0b3954', color: '#ffffff', alignment: 'left' },
  totalRow: { bold: true, fillColor: '#f0f0f0' },
  cellRight: { alignment: 'right' },
  cellNegative: { color: '#bb0000' },
} as const;

/**
 * Font config for pdfmake on Node. Uses Helvetica (built into pdfkit, the
 * underlying engine) so we don't need to bundle external .ttf font files.
 * Helvetica handles Brazilian Portuguese characters (acentos, R$) fine.
 *
 * NOTE: the original spec mentioned `pdfmake/build/vfs_fonts.js` (Roboto via
 * VFS) — that's the BROWSER API. On Node we use pdfkit's built-in fonts via
 * the constructor's `fontDescriptors` argument.
 */
export const PDF_FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
} as const;

/**
 * Render a pdfmake docDefinition to a Buffer using the Node API. Lazy-loads
 * the pdfmake top-level module (~5MB) the first time it's called per process.
 *
 * Caller is responsible for setting `defaultStyle.font: 'Helvetica'` in the
 * docDefinition (or any custom font config consistent with PDF_FONTS above).
 */
export async function renderPdfToBuffer(docDefinition: unknown): Promise<Buffer> {
  // Top-level `pdfmake` resolves to `src/printer.js` (the Node entry per
  // pdfmake's package.json `main` field). The default export is the
  // PdfPrinter constructor.
  const mod = (await import('pdfmake')) as unknown as {
    default: new (fonts: unknown) => {
      createPdfKitDocument: (def: unknown) => {
        on: (e: string, cb: (...args: unknown[]) => void) => void;
        end: () => void;
      };
    };
  };
  const PdfPrinter = mod.default;
  const printer = new PdfPrinter(PDF_FONTS);
  const doc = printer.createPdfKitDocument(docDefinition);
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: unknown) => {
      chunks.push(chunk as Buffer);
    });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: unknown) => reject(err as Error));
    doc.end();
  });
}

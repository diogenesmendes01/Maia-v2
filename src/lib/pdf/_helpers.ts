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
 * Tight allowlist of local paths that renderPdfToBuffer is permitted to access.
 *
 * pdfmake calls localAccessPolicy(path) for every local resource:
 *   • built-in font names (e.g. 'Helvetica', 'Helvetica-Bold') — loaded by pdfkit
 *   • filesystem paths from docDefinition.images / .attachments / .files
 *
 * We allow ONLY the four Helvetica variants registered in PDF_FONTS.  All other
 * paths — including arbitrary OS paths like '/etc/passwd' or '.env' — are denied,
 * causing pdfmake to throw "Access to local file denied by resource access policy".
 *
 * SECURITY: do NOT broaden this set without a deliberate review.  Adding a wildcard
 * or directory prefix here would re-open the SSRF / local-file-embedding vector.
 */
const ALLOWED_LOCAL_PATHS = new Set<string>([
  // Exact font names used as PDF_FONTS values (pdfmake passes these to the policy
  // when it needs to resolve built-in pdfkit fonts — they are NOT filesystem paths).
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
]);

/**
 * Render a pdfmake docDefinition to a Buffer using the Node API. Lazy-loads
 * the pdfmake top-level module (~5MB) the first time it's called per process.
 *
 * Caller is responsible for setting `defaultStyle.font: 'Helvetica'` in the
 * docDefinition (or any custom font config consistent with PDF_FONTS above).
 *
 * IMPORTANT: pdfmake's top-level export (`js/index.js`, the package `main`) is
 * a runtime *instance* of the pdfmake class, not the PdfPrinter constructor.
 * We use the instance API: setFonts() + createPdf() + getBuffer(). Do NOT try
 * to use `new pdfmake.default()` — it will throw "PdfPrinter is not a
 * constructor". See: https://github.com/diogenesmendes01/Maia-v2/issues/138
 */
export async function renderPdfToBuffer(docDefinition: unknown): Promise<Buffer> {
  // The `pdfmake` CommonJS module exports a singleton instance (not a class).
  // We must use require() here because the module's `main` is a CommonJS file
  // that uses `module.exports = new pdfmake()`, which dynamic import() wraps
  // differently across bundlers. Using createRequire keeps the instance stable.
  // `(await import('node:module')).default` em vez do destructuring nomeado, e a
  // razão não é estética: o `src/admin-ui` fixa `@types/node` em 22.9.0 enquanto
  // a raiz está em 25.x, e este arquivo entra no programa do `tsc` do admin por
  // import transitivo. Sob os typings 22.9.0 o namespace de `node:module` não
  // expõe `createRequire` como named export, e `npm run admin:typecheck`
  // reprovava com TS2339 — um comando que o `AGENTS.md` manda rodar, quebrado no
  // `main`. Ir pelo `default` compila sob os DOIS conjuntos de typings.
  //
  // Isto é a correção cirúrgica; a divergência de `@types/node` continua aberta
  // na issue #550. Alinhar o admin ao 25.x não é óbvio: o runtime mínimo do
  // projeto é Node 22, e typings mais novos liberam APIs que não existem nele.
  const Module = (await import('node:module')).default;
  const req = Module.createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfmakeInstance = req('pdfmake') as any;

  // Configure fonts and access policies on the shared instance.
  pdfmakeInstance.setFonts(PDF_FONTS);
  // Only allow access to the exact built-in Helvetica font names registered in
  // PDF_FONTS.  All other local paths (including docDefinition.images / attachments
  // / files with filesystem paths) are denied by default — this blocks arbitrary
  // local file embedding.  Block all external URL fetches too.
  pdfmakeInstance.setLocalAccessPolicy((path: string) => ALLOWED_LOCAL_PATHS.has(path));
  pdfmakeInstance.setUrlAccessPolicy(() => false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDoc = pdfmakeInstance.createPdf(docDefinition as any);
  return outputDoc.getBuffer() as Promise<Buffer>;
}

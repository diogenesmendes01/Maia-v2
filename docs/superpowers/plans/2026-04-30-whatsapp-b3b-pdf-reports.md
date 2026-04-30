# WhatsApp B3b — PDF Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `generate_report` tool that produces PDF documents (extrato + comparativo) sent via WhatsApp as document attachments with LLM-written captions. Feature-flagged behind `FEATURE_PDF_REPORTS` (default false).

**Architecture:** New tool `generate_report` writes a PDF to `<media_root>/tmp/<uuid>.pdf` via `pdfmake` (lazily imported). The agent ReAct loop tracks `latestReportPdf` (mirrors B0's `latestPending`). At the no-tool-uses branch, if a PDF was generated this turn, the loop calls a new `sendOutboundDocument` (in `baileys.ts`) instead of `sendOutboundText`, with the LLM's final text as the document caption. After send (success or failure), the tmp file is unlinked. A boot sweeper handles orphans from process crashes. View-once is **never** applied to PDFs (per spec §11).

**Tech Stack:** TypeScript, `pdfmake@^0.2.x` (new dep, ~5MB), `@whiskeysockets/baileys` 6.7.0 (existing), vitest.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `FEATURE_PDF_REPORTS` (default `false`) after `FEATURE_VIEW_ONCE_SENSITIVE` |
| `.env.example` | Modify | Document the new feature flag |
| `src/governance/audit-actions.ts` | Modify | Append `'outbound_sent_document'` |
| `package.json` | Modify | Add `pdfmake` to `dependencies` and `@types/pdfmake` to `devDependencies` |
| `src/gateway/baileys.ts` | Modify | Export `MEDIA_ROOT`; ensure `<MEDIA_ROOT>/tmp` exists; new `sendOutboundDocument` function |
| `src/lib/pdf/_helpers.ts` | Create | Shared header/footer/styles, BRL/date formatters, slug helper for filenames |
| `src/lib/pdf/extrato.ts` | Create | `generateExtratoPdf(input): Promise<{ path, fileName, summary }>` |
| `src/lib/pdf/comparativo.ts` | Create | `generateComparativoPdf(input): Promise<{ path, fileName, summary }>` |
| `src/lib/pdf/_sweeper.ts` | Create | `sweepPdfTmp()`: removes `*.pdf` in `<MEDIA_ROOT>/tmp` older than 1h |
| `src/tools/generate-report.ts` | Create | New tool with discriminated input by `tipo` |
| `src/tools/_registry.ts` | Modify | Conditionally register `generate_report` based on `FEATURE_PDF_REPORTS` |
| `src/agent/core.ts` | Modify | Track `latestReportPdf`; route to `sendOutboundDocument` in no-tool-uses branch; emit `outbound_sent_document` audit; unlink tmp file in finally |
| `src/index.ts` | Modify | Call `sweepPdfTmp()` once at boot |
| `tests/unit/pdf-helpers.spec.ts` | Create | Unit tests for `_helpers.ts` (slugify, formatBRL coverage on negatives) |
| `tests/unit/pdf-extrato.spec.ts` | Create | Verify extrato PDF magic bytes + summary correctness |
| `tests/unit/pdf-comparativo.spec.ts` | Create | Verify comparativo PDF magic bytes + summary correctness |
| `tests/unit/pdf-sweeper.spec.ts` | Create | Sweeper happy path + idempotency |
| `tests/unit/baileys-send-document.spec.ts` | Create | Contract test: `socket.sendMessage` receives `{ document, mimetype, fileName, caption }` |
| `tests/unit/generate-report.spec.ts` | Create | Schema validation, scope filtering, error paths |
| `tests/unit/registry-pdf-flag.spec.ts` | Create | `getToolSchemas` excludes `generate_report` when flag off |
| `tests/unit/pdf-flow.spec.ts` | Create | Agent loop integration: tracks `latestReportPdf`, calls `sendOutboundDocument`, emits audit, unlinks tmp |

No DB migrations. No new tables. The `mensagens.tipo` text column already accepts `'documento'`.

---

## Task 1: Foundation — env flag, audit action, .env.example

**Files:**
- Modify: `src/config/env.ts` (insert at line 113, before the closing `})` of the schema object)
- Modify: `src/governance/audit-actions.ts` (insert after line 89 `'outbound_view_once_skipped_by_preference'`, before `] as const;`)
- Modify: `.env.example` (extend the existing `# ---- Feature flags ----` section)

- [ ] **Step 1: Add `FEATURE_PDF_REPORTS` to env schema**

In `src/config/env.ts`, locate the `FEATURE_VIEW_ONCE_SENSITIVE` block (currently the last `FEATURE_*` entry). Insert the new flag after it, before the closing `})`:

```typescript
    FEATURE_VIEW_ONCE_SENSITIVE: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    FEATURE_PDF_REPORTS: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
  })
```

- [ ] **Step 2: Append `outbound_sent_document` audit action**

In `src/governance/audit-actions.ts`, locate the `'outbound_view_once_skipped_by_preference'` line (currently the last entry before `] as const;`). Append:

```typescript
  'outbound_view_once_skipped_by_preference',
  'outbound_sent_document',
] as const;
```

- [ ] **Step 3: Document in `.env.example`**

In `.env.example`, locate the existing `# ---- Feature flags ----` section (added by B3a). Append:

```bash
# PDF reports (extrato + comparativo) sent as WhatsApp documents. Default false.
# When true: the LLM can invoke `generate_report` to produce a PDF and send it
# with an LLM-written caption. View-once is NEVER applied to PDFs (spec B3b §11).
# FEATURE_PDF_REPORTS=false
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: zero NEW TypeScript errors. (Pre-existing errors in `src/db/client.ts`, `src/gateway/queue.ts`, `src/lib/alerts.ts` are unchanged.)

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/governance/audit-actions.ts .env.example
git commit -m "feat(b3b): foundation — FEATURE_PDF_REPORTS flag + outbound_sent_document audit"
```

---

## Task 2: Install `pdfmake` dependency

**Files:**
- Modify: `package.json`
- Auto-modified: `package-lock.json`

- [ ] **Step 1: Install pdfmake + types**

Run from project root:

```bash
npm install pdfmake@^0.2.0
npm install --save-dev @types/pdfmake@^0.2.0
```

This appends `"pdfmake": "^0.2.x"` to `dependencies` and `"@types/pdfmake": "^0.2.x"` to `devDependencies` in `package.json`.

- [ ] **Step 2: Verify `node_modules/pdfmake` exists**

Run: `ls node_modules/pdfmake/build/`
Expected output should include `pdfmake.js` and `vfs_fonts.js`.

- [ ] **Step 3: Sanity check via tsx eval**

Run:
```bash
npx tsx -e "import('pdfmake/build/pdfmake.js').then(m => console.log('pdfmake load ok:', typeof (m.default ?? m).createPdfKitDocument))"
```
Expected: `pdfmake load ok: function`. (Confirms the dynamic import path used in §6 of the spec works.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(b3b): install pdfmake dependency for B3b PDF generation"
```

---

## Task 3: Export `MEDIA_ROOT` and ensure `<MEDIA_ROOT>/tmp/` at boot

**Files:**
- Modify: `src/gateway/baileys.ts:30-31` (export the const, add tmp dir creation)

This unblocks `src/lib/pdf/*` from re-deriving the path convention. Per spec §4.2 advisory item.

- [ ] **Step 1: Export `MEDIA_ROOT` and create the tmp subdir**

In `src/gateway/baileys.ts`, replace lines 30-31:

```typescript
const MEDIA_ROOT = join(config.BAILEYS_AUTH_DIR, '..', 'media');
mkdirSync(MEDIA_ROOT, { recursive: true });
```

with:

```typescript
export const MEDIA_ROOT = join(config.BAILEYS_AUTH_DIR, '..', 'media');
mkdirSync(MEDIA_ROOT, { recursive: true });
// B3b: tmp subdir for in-flight PDF reports. Created here (idempotent) so any
// caller importing MEDIA_ROOT can rely on `<MEDIA_ROOT>/tmp` existing.
mkdirSync(join(MEDIA_ROOT, 'tmp'), { recursive: true });
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: zero new TS errors. Existing imports of `MEDIA_ROOT` from outside `baileys.ts` (there are currently none) still work.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/baileys.ts
git commit -m "feat(b3b): export MEDIA_ROOT and ensure <MEDIA_ROOT>/tmp/ exists at boot"
```

---

## Task 4: PDF helpers (`src/lib/pdf/_helpers.ts`)

**Files:**
- Create: `src/lib/pdf/_helpers.ts`
- Create: `tests/unit/pdf-helpers.spec.ts`

Shared utilities for the two generators: header/footer factories (returning pdfmake `Content` arrays), Brazilian formatters delegating to `src/lib/brazilian.ts`, filename slugifier.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pdf-helpers.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { slugify, formatPeriodBR, fmtBRLSigned } from '../../src/lib/pdf/_helpers.js';

describe('pdf helpers — slugify', () => {
  it('lowercases, strips diacritics, collapses spaces to hyphens', () => {
    expect(slugify('Empresa Açaí & Cia')).toBe('empresa-acai-cia');
    expect(slugify('  São Paulo  ')).toBe('sao-paulo');
    expect(slugify('A')).toBe('a');
  });

  it('handles empty / whitespace-only input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('pdf helpers — formatPeriodBR', () => {
  it('formats a date range as "dd/MM/yyyy a dd/MM/yyyy"', () => {
    expect(formatPeriodBR('2026-04-01', '2026-04-30')).toBe('01/04/2026 a 30/04/2026');
  });
});

describe('pdf helpers — fmtBRLSigned', () => {
  it('positive values format with R$ prefix', () => {
    expect(fmtBRLSigned(1234.56)).toBe('R$ 1.234,56');
  });

  it('negative values keep the minus sign', () => {
    expect(fmtBRLSigned(-99.9)).toContain('-');
    expect(fmtBRLSigned(-99.9)).toContain('99,90');
  });

  it('zero formats as R$ 0,00', () => {
    expect(fmtBRLSigned(0)).toBe('R$ 0,00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pdf-helpers.spec.ts`
Expected: FAIL — module `../../src/lib/pdf/_helpers.js` does not exist.

- [ ] **Step 3: Create `src/lib/pdf/_helpers.ts`**

Create the file with:

```typescript
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
 */
export function fmtBRLSigned(value: number): string {
  if (value >= 0) return formatBRL(value);
  return '-' + formatBRL(-value);
}

/**
 * pdfmake Content fragment that renders the shared report header.
 * Returns a typed-as-`unknown` array so we don't need to depend on
 * pdfmake types in a non-pdf-loading codepath.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pdf-helpers.spec.ts`
Expected: PASS — all three describe blocks (3 + 1 + 3 = 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf/_helpers.ts tests/unit/pdf-helpers.spec.ts
git commit -m "feat(b3b): pdf helpers — slugify, formatPeriodBR, fmtBRLSigned, header builder"
```

---

## Task 5: PDF generator — `src/lib/pdf/extrato.ts`

**Files:**
- Create: `src/lib/pdf/extrato.ts`
- Create: `tests/unit/pdf-extrato.spec.ts`

`generateExtratoPdf(input)` builds a pdfmake document, writes the bytes to `<MEDIA_ROOT>/tmp/<uuid>.pdf`, and returns `{ path, fileName, summary }`. Lazily imports pdfmake.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pdf-extrato.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Override BAILEYS_AUTH_DIR before importing anything that reads MEDIA_ROOT,
// so the tmp PDF lands in a sandbox we control and clean up.
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

import { vi } from 'vitest';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pdf-extrato.spec.ts`
Expected: FAIL — module `../../src/lib/pdf/extrato.js` does not exist.

- [ ] **Step 3: Create `src/lib/pdf/extrato.ts`**

```typescript
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import { buildPdfHeader, PDF_STYLES, slugify, formatPeriodBR, fmtBRLSigned } from './_helpers.js';

const HARD_LIMIT_ROWS = 500;

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
        { text: truncate(t.descricao, 120), noWrap: false },
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
    defaultStyle: { fontSize: 9 },
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

/**
 * Lazy-loads pdfmake (~4MB total — main + vfs_fonts) only when called. With
 * `FEATURE_PDF_REPORTS=false` the tool is unregistered and this function is
 * never called, so the bundles never load. See spec §6.
 */
async function renderPdfToBuffer(docDefinition: unknown): Promise<Buffer> {
  const pdfMakeModule = (await import('pdfmake/build/pdfmake.js')) as unknown as {
    default?: { createPdfKitDocument: (def: unknown) => unknown; vfs?: unknown };
    createPdfKitDocument?: (def: unknown) => unknown;
    vfs?: unknown;
  };
  const vfsModule = (await import('pdfmake/build/vfs_fonts.js')) as unknown as {
    default?: { pdfMake?: { vfs: unknown } };
    pdfMake?: { vfs: unknown };
  };
  const pdfMake = pdfMakeModule.default ?? pdfMakeModule;
  const vfs = vfsModule.default?.pdfMake?.vfs ?? vfsModule.pdfMake?.vfs;
  (pdfMake as { vfs?: unknown }).vfs = vfs;
  const fonts = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  };
  const doc = (pdfMake as { createPdfKitDocument: (d: unknown, o?: unknown) => unknown }).createPdfKitDocument(
    docDefinition,
    { fonts },
  ) as { on: (e: string, cb: (...args: unknown[]) => void) => void; end: () => void };
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pdf-extrato.spec.ts`
Expected: PASS — 3/3 tests. (May take 2-4s for first run as pdfmake/vfs are loaded lazily.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf/extrato.ts tests/unit/pdf-extrato.spec.ts
git commit -m "feat(b3b): generateExtratoPdf — pdfmake template for transaction extrato"
```

---

## Task 6: PDF generator — `src/lib/pdf/comparativo.ts`

**Files:**
- Create: `src/lib/pdf/comparativo.ts`
- Create: `tests/unit/pdf-comparativo.spec.ts`

Mirrors Task 5's structure but with the per-entidade table.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pdf-comparativo.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pdf-comparativo.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/lib/pdf/comparativo.ts`**

```typescript
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { fmtBR } from '@/lib/brazilian.js';
import { buildPdfHeader, PDF_STYLES, formatPeriodBR, fmtBRLSigned } from './_helpers.js';

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
    defaultStyle: { fontSize: 10 },
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

// (Same renderPdfToBuffer as in extrato.ts — duplicated intentionally to keep
// modules self-contained. If a third PDF generator lands later, factor into
// `_pdfmake.ts`.)
async function renderPdfToBuffer(docDefinition: unknown): Promise<Buffer> {
  const pdfMakeModule = (await import('pdfmake/build/pdfmake.js')) as unknown as {
    default?: { createPdfKitDocument: (def: unknown) => unknown; vfs?: unknown };
    createPdfKitDocument?: (def: unknown) => unknown;
    vfs?: unknown;
  };
  const vfsModule = (await import('pdfmake/build/vfs_fonts.js')) as unknown as {
    default?: { pdfMake?: { vfs: unknown } };
    pdfMake?: { vfs: unknown };
  };
  const pdfMake = pdfMakeModule.default ?? pdfMakeModule;
  const vfs = vfsModule.default?.pdfMake?.vfs ?? vfsModule.pdfMake?.vfs;
  (pdfMake as { vfs?: unknown }).vfs = vfs;
  const fonts = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  };
  const doc = (pdfMake as { createPdfKitDocument: (d: unknown, o?: unknown) => unknown }).createPdfKitDocument(
    docDefinition,
    { fonts },
  ) as { on: (e: string, cb: (...args: unknown[]) => void) => void; end: () => void };
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pdf-comparativo.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf/comparativo.ts tests/unit/pdf-comparativo.spec.ts
git commit -m "feat(b3b): generateComparativoPdf — pdfmake template for entity comparison"
```

---

## Task 7: Boot sweeper — `src/lib/pdf/_sweeper.ts`

**Files:**
- Create: `src/lib/pdf/_sweeper.ts`
- Create: `tests/unit/pdf-sweeper.spec.ts`
- Modify: `src/index.ts` (call `sweepPdfTmp()` once at boot)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pdf-sweeper.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-sweeper-test-' + Date.now());

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys') },
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

beforeEach(async () => {
  // Clean tmp dir between tests
  const dir = join(SANDBOX, 'media', 'tmp');
  for (const f of await readdir(dir)) {
    await rm(join(dir, f));
  }
});

describe('sweepPdfTmp', () => {
  it('removes *.pdf files older than 1 hour, keeps fresh ones', async () => {
    const dir = join(SANDBOX, 'media', 'tmp');
    const oldPath = join(dir, 'old.pdf');
    const freshPath = join(dir, 'fresh.pdf');
    const nonPdfPath = join(dir, 'old.txt');
    await writeFile(oldPath, '%PDF-fake');
    await writeFile(freshPath, '%PDF-fake');
    await writeFile(nonPdfPath, 'not a pdf');
    // Backdate old.pdf and old.txt by 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldPath, twoHoursAgo, twoHoursAgo);
    await utimes(nonPdfPath, twoHoursAgo, twoHoursAgo);

    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    const swept = await sweepPdfTmp();
    expect(swept).toBe(1); // only old.pdf removed (non-pdf ignored, fresh kept)

    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(['fresh.pdf', 'old.txt']);
  });

  it('returns 0 when tmp dir is empty', async () => {
    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    expect(await sweepPdfTmp()).toBe(0);
  });

  it('does not throw when tmp dir does not exist (idempotent)', async () => {
    const ghostDir = join(SANDBOX, 'no-such-dir');
    // We force the missing-dir scenario by sweeping a path that doesn't exist.
    // The implementation must catch ENOENT and return 0.
    const { sweepPdfTmp } = await import('../../src/lib/pdf/_sweeper.js');
    // The sweeper reads MEDIA_ROOT/tmp; we already cleaned it. Remove parent
    // tmp to simulate first-boot-on-fresh-install:
    await rm(join(SANDBOX, 'media', 'tmp'), { recursive: true, force: true });
    expect(await sweepPdfTmp()).toBe(0);
    // Restore for any later tests in this file (none here, but defensive):
    await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pdf-sweeper.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/lib/pdf/_sweeper.ts`**

```typescript
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { logger } from '@/lib/logger.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Removes orphan PDF files in `<MEDIA_ROOT>/tmp/` whose mtime is older than
 * `TTL_MS`. Called once at process boot from `src/index.ts`. Idempotent —
 * runs cleanly on an empty or missing directory.
 *
 * Returns the number of files swept (for logging / observability). Errors
 * are logged but never thrown — sweeper failures must not crash startup.
 */
export async function sweepPdfTmp(): Promise<number> {
  const tmpDir = join(MEDIA_ROOT, 'tmp');
  let entries: string[];
  try {
    entries = await readdir(tmpDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    logger.warn({ err, tmpDir }, 'pdf.sweeper.readdir_failed');
    return 0;
  }

  const cutoff = Date.now() - TTL_MS;
  let swept = 0;
  for (const name of entries) {
    if (!name.endsWith('.pdf')) continue;
    const full = join(tmpDir, name);
    try {
      const s = await stat(full);
      if (s.mtimeMs < cutoff) {
        await unlink(full);
        swept++;
      }
    } catch (err) {
      logger.warn({ err, path: full }, 'pdf.sweeper.unlink_failed');
    }
  }

  if (swept > 0) {
    logger.info({ swept, tmpDir }, 'pdf.sweeper.completed');
  }
  return swept;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pdf-sweeper.spec.ts`
Expected: PASS — 3/3.

- [ ] **Step 5: Wire into boot in `src/index.ts`**

In `src/index.ts`, locate the `main()` function. After `await ensureRedisConnect();` (currently right before `await startServer();`), add a sweeper call:

```typescript
async function main() {
  logger.info({ env: config.NODE_ENV, port: config.APP_PORT }, 'maia.starting');
  await audit({ acao: 'system_started' });

  await ensureRedisConnect();

  // B3b: clean up any orphan PDF reports from a prior crash. Best-effort.
  const { sweepPdfTmp } = await import('@/lib/pdf/_sweeper.js');
  await sweepPdfTmp().catch((err) => logger.warn({ err }, 'pdf.sweeper.boot_failed'));

  await startServer();
  // ...rest unchanged
```

(Use a dynamic import so the sweeper module is only loaded once at boot — keeps the static import graph clean.)

- [ ] **Step 6: Verify build still passes**

Run: `npm run build`
Expected: zero new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pdf/_sweeper.ts tests/unit/pdf-sweeper.spec.ts src/index.ts
git commit -m "feat(b3b): boot sweeper for orphan PDF tmp files; wired into src/index.ts"
```

---

## Task 8: `sendOutboundDocument` in `baileys.ts` + contract test

**Files:**
- Modify: `src/gateway/baileys.ts` (append the new function near `sendOutboundText`)
- Create: `tests/unit/baileys-send-document.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/baileys-send-document.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-baileys-doc-test-' + Date.now());

const sendMessage = vi.fn();
const fakeSocket = { sendMessage };

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys'),
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_PDF_REPORTS: true,
  },
}));

beforeEach(async () => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ key: { id: 'WAID-DOC-1' } });
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});

describe('sendOutboundDocument', () => {
  it('passes { document: Buffer, mimetype, fileName, caption } to socket.sendMessage', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'sample.pdf');
    await writeFile(path, '%PDF-1.4 sample bytes\n%%EOF');
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const wid = await mod.sendOutboundDocument('5511999999999@s.whatsapp.net', path, {
      mimetype: 'application/pdf',
      fileName: 'extrato-teste-2026-04.pdf',
      caption: 'Aqui está o extrato',
    });
    expect(wid).toBe('WAID-DOC-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jidArg, contentArg, miscArg] = sendMessage.mock.calls[0]!;
    expect(jidArg).toBe('5511999999999@s.whatsapp.net');
    expect(contentArg).toMatchObject({
      mimetype: 'application/pdf',
      fileName: 'extrato-teste-2026-04.pdf',
      caption: 'Aqui está o extrato',
    });
    expect(Buffer.isBuffer(contentArg.document)).toBe(true);
    expect(miscArg).toBeUndefined();
  });

  it('forwards quoted as third arg when provided', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'q.pdf');
    await writeFile(path, '%PDF-1.4');
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const quoted = { key: { id: 'WAID-IN' } } as never;
    await mod.sendOutboundDocument('jid', path, {
      mimetype: 'application/pdf', fileName: 'q.pdf', quoted,
    });
    const [, , miscArg] = sendMessage.mock.calls[0]!;
    expect(miscArg).toEqual({ quoted });
  });

  it('returns null when not connected; sendMessage NOT called', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'nc.pdf');
    await writeFile(path, '%PDF-1.4');
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(null, false);
    const wid = await mod.sendOutboundDocument('jid', path, {
      mimetype: 'application/pdf', fileName: 'nc.pdf',
    });
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns null and logs error when readFile throws (file vanished)', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const wid = await mod.sendOutboundDocument('jid', '/no/such/file.pdf', {
      mimetype: 'application/pdf', fileName: 'gone.pdf',
    });
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

import { afterAll } from 'vitest';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/baileys-send-document.spec.ts`
Expected: FAIL — `mod.sendOutboundDocument` is not a function.

- [ ] **Step 3: Append `sendOutboundDocument` to `src/gateway/baileys.ts`**

In `src/gateway/baileys.ts`, locate the existing `sendOutboundText` function (around line 249-265). Add a new function right after it:

```typescript
import { readFile } from 'node:fs/promises';
// (existing imports unchanged)

// ...sendOutboundText() definition...

/**
 * B3b: send a document (PDF) to the recipient. Reads the file into a Buffer
 * (PDFs are bounded by the 500-row hard limit at <500KB, well within memory),
 * eliminating the partially-sent-on-error edge case. View-once is intentionally
 * NOT supported here — see B3b spec §11 for rationale.
 */
export async function sendOutboundDocument(
  jid: string,
  path: string,
  opts: {
    mimetype: string;
    fileName: string;
    caption?: string;
    quoted?: WAQuotedContext;
  },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send document');
    return null;
  }
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    logger.error({ err, path }, 'baileys.send_document.read_failed');
    return null;
  }
  const result = await socket.sendMessage(
    jid,
    {
      document: buf,
      mimetype: opts.mimetype,
      fileName: opts.fileName,
      caption: opts.caption,
    },
    opts.quoted ? { quoted: opts.quoted } : undefined,
  );
  return result?.key.id ?? null;
}
```

Add `import { readFile } from 'node:fs/promises';` to the top of the file (alongside the existing `import { mkdirSync, writeFileSync, existsSync } from 'node:fs';`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/baileys-send-document.spec.ts`
Expected: PASS — 4/4 tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npx vitest run tests/unit/baileys-view-once.spec.ts tests/unit/view-once.spec.ts tests/unit/baileys-send-document.spec.ts`
Expected: All tests pass. (B3a tests still green.)

- [ ] **Step 6: Commit**

```bash
git add src/gateway/baileys.ts tests/unit/baileys-send-document.spec.ts
git commit -m "feat(b3b): sendOutboundDocument in baileys.ts + envelope contract test"
```

---

## Task 9: `generate_report` tool — `src/tools/generate-report.ts`

**Files:**
- Create: `src/tools/generate-report.ts`
- Create: `tests/unit/generate-report.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/generate-report.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
      tipo: 'comparativo', entidade_ids: ['e1'],
      date_from: '2026-04-01', date_to: '2026-04-30',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects comparativo with > 8 entidade_ids', async () => {
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const parsed = generateReportTool.input_schema.safeParse({
      tipo: 'comparativo',
      entidade_ids: ['1','2','3','4','5','6','7','8','9'],
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
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'extrato', entidade_id: 'eOTHER', date_from: '2026-04-01', date_to: '2026-04-30' } as never,
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
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'comparativo', entidade_ids: ['eX','eY'], date_from: '2026-04-01', date_to: '2026-04-30' } as never,
      ctx,
    );
    expect(out).toEqual(expect.objectContaining({ error: 'forbidden' }));
  });

  it('returns comparativo_needs_two when scope filter leaves only 1 entidade', async () => {
    const ctxOne = { ...ctx, scope: { entidades: ['e1'], byEntity: new Map() } };
    const { generateReportTool } = await import('../../src/tools/generate-report.js');
    const out = await generateReportTool.handler(
      { tipo: 'comparativo', entidade_ids: ['e1','eOTHER'], date_from: '2026-04-01', date_to: '2026-04-30' } as never,
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

import { beforeEach } from 'vitest';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/generate-report.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/tools/generate-report.ts`**

```typescript
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo, entidadesRepo, categoriasRepo, contasRepo } from '@/db/repositories.js';
import { generateExtratoPdf, type ExtratoTransaction } from '@/lib/pdf/extrato.js';
import { generateComparativoPdf, type ComparativoRow } from '@/lib/pdf/comparativo.js';
import { logger } from '@/lib/logger.js';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('extrato'),
    entidade_id: z.string().uuid(),
    date_from: z.string().regex(dateRegex),
    date_to: z.string().regex(dateRegex),
    natureza: z.enum(['receita', 'despesa', 'movimentacao']).optional(),
  }),
  z.object({
    tipo: z.literal('comparativo'),
    entidade_ids: z.array(z.string().uuid()).min(2).max(8),
    date_from: z.string().regex(dateRegex),
    date_to: z.string().regex(dateRegex),
  }),
]);

const outputSchema = z.union([
  z.object({
    path: z.string(),
    fileName: z.string(),
    mimetype: z.literal('application/pdf'),
    tipo: z.enum(['extrato', 'comparativo']),
    summary: z.object({
      period: z.string(),
      rowCount: z.number().int().nonnegative().optional(),
      totals: z
        .object({
          receita: z.number(),
          despesa: z.number(),
          lucro: z.number(),
        })
        .optional(),
    }),
  }),
  z.object({
    error: z.string(),
    message: z.string().optional(),
  }),
]);

export const generateReportTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'generate_report',
  description:
    'Gera um relatório financeiro em PDF e o envia como anexo no WhatsApp. Use quando o owner pedir "extrato", "relatório", "manda em PDF", "comparativo", ou quando a resposta seria uma tabela longa (>20 linhas). Caption do envio é o texto que você devolver depois do tool result. Não use para saldo (responder em texto direto).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  // Permission: extrato uses read_transactions; comparativo uses read_reports.
  // Dispatcher checks ALL required_actions, so listing both forces the LLM
  // to be authorized for either path. (Single-user Maia: owner has both.)
  required_actions: ['read_transactions', 'read_reports'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested', // generic read action; the actual send is audited separately as `outbound_sent_document`
  sensitive: false, // per spec §11: no view-once for PDFs
  handler: async (args, ctx) => {
    if (args.tipo === 'extrato') {
      if (!ctx.scope.entidades.includes(args.entidade_id)) {
        return { error: 'forbidden', message: 'Entidade fora do escopo' };
      }
      const ent = await entidadesRepo.byId(args.entidade_id);
      if (!ent) return { error: 'forbidden', message: 'Entidade não encontrada' };

      const rawTxns = await transacoesRepo.byScope(
        { pessoa_id: ctx.pessoa.id, entidades: [args.entidade_id] },
        {
          date_from: args.date_from,
          date_to: args.date_to,
          natureza: args.natureza,
          limit: 600, // intentionally larger than the 500 hard limit so we KNOW we hit it
        },
      );

      // Resolve unique categoria names in one batch
      const catIds = Array.from(
        new Set(rawTxns.map((t) => t.categoria_id).filter((x): x is string => !!x)),
      );
      const catNameById = new Map<string, string>();
      for (const cid of catIds) {
        const cat = await categoriasRepo.byId(cid);
        if (cat) catNameById.set(cid, cat.nome);
      }

      const transactions: ExtratoTransaction[] = rawTxns.map((t) => ({
        data_competencia: t.data_competencia,
        natureza: t.natureza as 'receita' | 'despesa' | 'movimentacao',
        valor: Number(t.valor),
        descricao: t.descricao ?? '',
        categoriaNome: t.categoria_id ? catNameById.get(t.categoria_id) ?? null : null,
      }));

      try {
        const result = await generateExtratoPdf({
          ownerName: ctx.pessoa.nome,
          entidadeName: ent.nome,
          date_from: args.date_from,
          date_to: args.date_to,
          transactions,
        });
        return {
          path: result.path,
          fileName: result.fileName,
          mimetype: 'application/pdf' as const,
          tipo: 'extrato' as const,
          summary: result.summary,
        };
      } catch (err) {
        logger.error({ err }, 'generate_report.extrato_failed');
        return { error: 'pdf_generation_failed', message: (err as Error).message };
      }
    }

    // comparativo
    const allowedIds = args.entidade_ids.filter((id) => ctx.scope.entidades.includes(id));
    if (allowedIds.length === 0) {
      return { error: 'forbidden', message: 'Nenhuma das entidades está no escopo' };
    }
    if (allowedIds.length === 1) {
      return {
        error: 'comparativo_needs_two',
        message: 'Comparativo precisa de pelo menos 2 entidades acessíveis',
      };
    }

    const ents = await entidadesRepo.byIds(allowedIds);
    const entById = new Map(ents.map((e) => [e.id, e]));

    const rows: ComparativoRow[] = [];
    for (const id of allowedIds) {
      const ent = entById.get(id);
      if (!ent) continue;
      const txns = await transacoesRepo.byScope(
        { pessoa_id: ctx.pessoa.id, entidades: [id] },
        { date_from: args.date_from, date_to: args.date_to, limit: 5000 },
      );
      const receita = txns
        .filter((t) => t.natureza === 'receita')
        .reduce((s, t) => s + Number(t.valor), 0);
      const despesa = txns
        .filter((t) => t.natureza === 'despesa')
        .reduce((s, t) => s + Number(t.valor), 0);
      const contas = await contasRepo.byEntity(id);
      const caixa_final = contas.reduce((s, c) => s + Number(c.saldo_atual), 0);
      rows.push({
        entidade_id: id,
        entidade_nome: ent.nome,
        receita,
        despesa,
        lucro: receita - despesa,
        caixa_final,
      });
    }

    try {
      const result = await generateComparativoPdf({
        ownerName: ctx.pessoa.nome,
        date_from: args.date_from,
        date_to: args.date_to,
        rows,
      });
      return {
        path: result.path,
        fileName: result.fileName,
        mimetype: 'application/pdf' as const,
        tipo: 'comparativo' as const,
        summary: result.summary,
      };
    } catch (err) {
      logger.error({ err }, 'generate_report.comparativo_failed');
      return { error: 'pdf_generation_failed', message: (err as Error).message };
    }
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/generate-report.spec.ts`
Expected: PASS — schema (3) + extrato (2) + comparativo (3) = 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/generate-report.ts tests/unit/generate-report.spec.ts
git commit -m "feat(b3b): generate_report tool — extrato + comparativo with scope filtering"
```

---

## Task 10: Register tool conditionally + filter test

**Files:**
- Modify: `src/tools/_registry.ts:57-77` (conditional registration)
- Create: `tests/unit/registry-pdf-flag.spec.ts`

The tool must be ABSENT from `getToolSchemas` when `FEATURE_PDF_REPORTS=false` (spec §6 + AC). Easiest: register or skip based on flag at module load.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/registry-pdf-flag.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('REGISTRY — generate_report flag gating', () => {
  it('registers generate_report when FEATURE_PDF_REPORTS=true', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: true },
    }));
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.generate_report).toBeDefined();
    expect(REGISTRY.generate_report?.name).toBe('generate_report');
  });

  it('omits generate_report when FEATURE_PDF_REPORTS=false', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: false },
    }));
    const { REGISTRY } = await import('../../src/tools/_registry.js');
    expect(REGISTRY.generate_report).toBeUndefined();
  });

  it('getToolSchemas excludes generate_report when flag off (owner profile)', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PDF_REPORTS: false },
    }));
    const { getToolSchemas } = await import('../../src/tools/_registry.js');
    const ownerByEntity = new Map([
      ['e1', { profile: { acoes: ['*'] }, effective_limits: {} } as never],
    ]);
    const schemas = getToolSchemas(ownerByEntity);
    expect(schemas.find((s) => s.name === 'generate_report')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/registry-pdf-flag.spec.ts`
Expected: FAIL — `REGISTRY.generate_report` is currently always undefined (tool isn't wired yet).

- [ ] **Step 3: Wire conditional registration in `src/tools/_registry.ts`**

In `src/tools/_registry.ts`:

a) Add the import near the other tool imports (around lines 4-22):

```typescript
import { generateReportTool } from './generate-report.js';
import { config } from '@/config/env.js';
```

b) Replace the `REGISTRY` declaration (lines 57-77) with:

```typescript
export const REGISTRY: Record<string, AnyTool> = {
  register_transaction: registerTransactionTool as unknown as AnyTool,
  cancel_transaction: cancelTransactionTool as unknown as AnyTool,
  query_balance: queryBalanceTool as unknown as AnyTool,
  list_transactions: listTransactionsTool as unknown as AnyTool,
  classify_transaction: classifyTransactionTool as unknown as AnyTool,
  identify_entity: identifyEntityTool as unknown as AnyTool,
  parse_boleto: parseBoletoTool as unknown as AnyTool,
  parse_receipt: parseReceiptTool as unknown as AnyTool,
  parse_image: parseImageTool as unknown as AnyTool,
  transcribe_audio: transcribeAudioTool as unknown as AnyTool,
  schedule_reminder: scheduleReminderTool as unknown as AnyTool,
  send_proactive_message: sendProactiveMessageTool as unknown as AnyTool,
  compare_entities: compareEntitiesTool as unknown as AnyTool,
  recall_memory: recallMemoryTool as unknown as AnyTool,
  save_fact: saveFactTool as unknown as AnyTool,
  save_rule: saveRuleTool as unknown as AnyTool,
  list_pending: listPendingTool as unknown as AnyTool,
  start_workflow: startWorkflowTool as unknown as AnyTool,
  ask_pending_question: askPendingQuestionTool as unknown as AnyTool,
  // B3b: gated by feature flag. When false, the LLM never sees this tool.
  ...(config.FEATURE_PDF_REPORTS
    ? { generate_report: generateReportTool as unknown as AnyTool }
    : {}),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/registry-pdf-flag.spec.ts`
Expected: PASS — 3/3.

- [ ] **Step 5: Run full test suite to check no regression in other registry-using tests**

Run: `npx vitest run tests/unit/view-once.spec.ts tests/unit/registry-pdf-flag.spec.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/_registry.ts tests/unit/registry-pdf-flag.spec.ts
git commit -m "feat(b3b): register generate_report conditionally on FEATURE_PDF_REPORTS"
```

---

## Task 11: Wire agent loop — `latestReportPdf` tracking + no-tool-uses branch

**Files:**
- Modify: `src/agent/core.ts`
- Create: `tests/unit/pdf-flow.spec.ts`

The agent loop must:
1. Declare `latestReportPdf` turn-local variable (mirrors `latestPending` and `turnHasSensitive`).
2. After each `dispatchTool`, capture `generate_report` results into `latestReportPdf`.
3. In the no-tool-uses branch, BEFORE the existing `usePoll` check, route to `sendOutboundDocument` if a PDF was generated.
4. Use `try/finally` around the no-tool-uses branch to unlink the tmp file.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pdf-flow.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-flow-test-' + Date.now());

const { flagState, dbState } = vi.hoisted(() => ({
  flagState: { FEATURE_PDF_REPORTS: true, FEATURE_VIEW_ONCE_SENSITIVE: false, FEATURE_ONE_TAP: false, FEATURE_PENDING_GATE: false },
  dbState: { conversaResult: [] as unknown[] },
}));

const sendOutboundText = vi.fn();
const sendOutboundDocument = vi.fn();
const findById = vi.fn();
const audit = vi.fn();
const createMensagem = vi.fn();
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const recentInConversation = vi.fn();
const dispatchTool = vi.fn();
const callLLM = vi.fn();
const buildPrompt = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText, sendOutboundDocument, isBaileysConnected: () => true,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem,
    findById: findMensagem,
    markProcessed,
    recentInConversation,
    setConversaId: vi.fn(),
    createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/db/client.js', () => {
  const fakeQuery = {
    from: () => fakeQuery, innerJoin: () => fakeQuery, where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return { db: { select: () => fakeQuery }, withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) };
});
vi.mock('../../src/db/schema.js', () => ({ conversas: {}, pessoas: {} }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'FEATURE_PDF_REPORTS') return flagState.FEATURE_PDF_REPORTS;
      if (prop === 'FEATURE_VIEW_ONCE_SENSITIVE') return flagState.FEATURE_VIEW_ONCE_SENSITIVE;
      if (prop === 'FEATURE_ONE_TAP') return flagState.FEATURE_ONE_TAP;
      if (prop === 'FEATURE_PENDING_GATE') return flagState.FEATURE_PENDING_GATE;
      if (prop === 'OWNER_TELEFONE_WHATSAPP') return '+5511999999999';
      return undefined;
    },
  }),
}));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt, PROMPT_TOKEN_BUDGET_INPUT: 11000, PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));
vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(), handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(), quotedReplyContext: vi.fn(), sendPoll: vi.fn(),
}));
vi.mock('../../src/workflows/pending-questions.js', () => ({ getActivePending: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(), findPreviousAssistantMessage: vi.fn(),
}));

const PESSOA = { id: 'p1', telefone_whatsapp: '+5511888888888', nome: 'Owner', tipo: 'owner', preferencias: {} } as never;
const CONVERSA = { id: 'c1', pessoa_id: 'p1', status: 'ativa' } as never;
const INBOUND = { id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'texto' as const, conteudo: 'manda extrato', metadata: { whatsapp_id: 'WAID-IN' }, processada_em: null };

describe('agent loop — PDF flow (B3b)', () => {
  let pdfPath: string;

  beforeAll(async () => {
    await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
  });
  afterAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true });
  });

  beforeEach(async () => {
    callLLM.mockReset(); dispatchTool.mockReset();
    sendOutboundText.mockReset(); sendOutboundDocument.mockReset();
    audit.mockReset(); createMensagem.mockReset();
    findById.mockReset(); findMensagem.mockReset(); markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findMensagem.mockResolvedValue({ ...INBOUND });
    findById.mockResolvedValue(PESSOA);
    sendOutboundDocument.mockResolvedValue('WAID-OUT');
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];

    pdfPath = join(SANDBOX, 'media', 'tmp', `${Math.random().toString(36).slice(2)}.pdf`);
    await writeFile(pdfPath, '%PDF-1.4 sample\n%%EOF');
  });

  it('routes to sendOutboundDocument when generate_report ran; emits outbound_sent_document audit; unlinks tmp', async () => {
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Aqui está o extrato de Outubro:',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath,
      fileName: 'extrato-empresa-x-2026-04.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026', rowCount: 3, totals: { receita: 100, despesa: 50, lucro: 50 } },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    // sendOutboundText must NOT have been called (PDF route taken instead)
    expect(sendOutboundText).not.toHaveBeenCalled();
    // sendOutboundDocument WAS called with the right shape
    expect(sendOutboundDocument).toHaveBeenCalledTimes(1);
    const [jid, path, opts] = sendOutboundDocument.mock.calls[0]!;
    expect(jid).toMatch(/@s\.whatsapp\.net$/);
    expect(path).toBe(pdfPath);
    expect(opts).toMatchObject({
      mimetype: 'application/pdf',
      fileName: 'extrato-empresa-x-2026-04.pdf',
      caption: 'Aqui está o extrato de Outubro:',
    });
    // audit fired
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).toContain('outbound_sent_document');
    // mensagens row created with tipo=documento, midia_url=null
    const docMensagem = createMensagem.mock.calls.find((c) => c[0].tipo === 'documento')?.[0];
    expect(docMensagem).toBeDefined();
    expect(docMensagem.midia_url).toBeNull();
    // tmp file unlinked
    await expect(import('node:fs/promises').then((m) => m.access(pdfPath))).rejects.toThrow();
  });

  it('null WAID (Baileys disconnected) → no audit; tmp file STILL unlinked', async () => {
    sendOutboundDocument.mockResolvedValueOnce(null);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Aqui está', tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath, fileName: 'x.pdf', mimetype: 'application/pdf', tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026' },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).not.toContain('outbound_sent_document');
    await expect(import('node:fs/promises').then((m) => m.access(pdfPath))).rejects.toThrow();
  });

  it('caption truncated to 1024 chars', async () => {
    const longText = 'x'.repeat(2000);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: longText, tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath, fileName: 'x.pdf', mimetype: 'application/pdf', tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026' },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const [, , opts] = sendOutboundDocument.mock.calls[0]!;
    expect(opts.caption.length).toBe(1024);
  });

  it('non-generate_report turn falls through to sendOutboundText (existing behaviour)', async () => {
    callLLM.mockResolvedValueOnce({
      content: 'plain reply', tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(sendOutboundDocument).not.toHaveBeenCalled();
  });
});

import { beforeAll, afterAll } from 'vitest';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pdf-flow.spec.ts`
Expected: FAIL — `sendOutboundDocument` is never called by `runAgentForMensagem` (the wiring doesn't exist yet).

- [ ] **Step 3: Modify `src/agent/core.ts`**

Three edits:

a) **Import `sendOutboundDocument`.** Replace line 11:

```typescript
import { sendOutboundText } from '@/gateway/baileys.js';
```

with:

```typescript
import { sendOutboundText, sendOutboundDocument } from '@/gateway/baileys.js';
```

Also add at the top with other node imports (alongside reflection imports):

```typescript
import { stat, unlink } from 'node:fs/promises';
```

b) **Declare `latestReportPdf`.** After line 150 (`const sensitiveTools: string[] = [];`), add:

```typescript
  let latestReportPdf: {
    path: string;
    fileName: string;
    mimetype: string;
    tipo: 'extrato' | 'comparativo';
  } | null = null;
```

c) **Capture from dispatchTool result.** Right after the existing B0 `ask_pending_question` capture block (around lines 253-281), but BEFORE the `const tool = REGISTRY[tu.tool];` (line 284), add:

```typescript
        // B3b: capture PDF report result for outbound document send.
        if (
          tu.tool === 'generate_report' &&
          !isError &&
          typeof out === 'object' &&
          out !== null &&
          'path' in out &&
          'fileName' in out &&
          'mimetype' in out &&
          'tipo' in out
        ) {
          const r = out as {
            path: string;
            fileName: string;
            mimetype: string;
            tipo: 'extrato' | 'comparativo';
          };
          latestReportPdf = {
            path: r.path,
            fileName: r.fileName,
            mimetype: r.mimetype,
            tipo: r.tipo,
          };
        }
```

d) **Insert PDF branch in no-tool-uses path.** Replace the entire `if (res.tool_uses.length === 0)` block (lines 159-222) with the version below. The new branch (`if (latestReportPdf)`) goes FIRST, before `usePoll`. The whole block is wrapped in `try/finally` so `unlink` runs even on send failure:

```typescript
      if (res.tool_uses.length === 0) {
        const text = res.content?.trim() ?? '';
        try {
          if (text) {
            // B3b: PDF report path — takes precedence over poll/text. The LLM's
            // text becomes the document caption (truncated to WhatsApp's 1024-
            // char limit).
            if (latestReportPdf) {
              const captionText = text.slice(0, 1024);
              const shouldQuote =
                (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                getActivePending(c) !== null;
              const wid = await sendOutboundDocument(jid, latestReportPdf.path, {
                mimetype: latestReportPdf.mimetype,
                fileName: latestReportPdf.fileName,
                caption: captionText,
                quoted: shouldQuote
                  ? quotedReplyContext(
                      inbound.metadata as Record<string, unknown> | null,
                      inbound.conteudo,
                    )
                  : undefined,
              });
              if (wid) {
                const file_size_bytes = await stat(latestReportPdf.path)
                  .then((s) => s.size)
                  .catch(() => 0);
                await audit({
                  acao: 'outbound_sent_document',
                  pessoa_id: pessoa.id,
                  conversa_id: c.id,
                  mensagem_id: inbound.id,
                  metadata: {
                    whatsapp_id: wid,
                    tipo: latestReportPdf.tipo,
                    file_size_bytes,
                  },
                });
                await mensagensRepo.create({
                  conversa_id: c.id,
                  direcao: 'out',
                  tipo: 'documento',
                  conteudo: captionText,
                  midia_url: null,
                  metadata: {
                    whatsapp_id: wid,
                    in_reply_to: inbound.id,
                    document_tipo: latestReportPdf.tipo,
                    document_filename: latestReportPdf.fileName,
                  },
                  processada_em: new Date(),
                  ferramentas_chamadas: [],
                  tokens_usados: null,
                });
              }
            } else {
              const usePoll =
                latestPending &&
                config.FEATURE_ONE_TAP &&
                latestPending.opcoes_validas.length >= 3 &&
                latestPending.opcoes_validas.length <= 12;
              if (usePoll && latestPending) {
                await sendOutboundPoll(pessoa.id, c.id, text, inbound.id, latestPending);
              } else {
                const shouldQuote =
                  (inbound.conteudo && detectCorrection(inbound.conteudo)) ||
                  getActivePending(c) !== null;
                const prefDisabled =
                  (pessoa.preferencias as { balance_view_once?: boolean } | null)
                    ?.balance_view_once === false;
                const view_once =
                  config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && !prefDisabled;
                if (config.FEATURE_VIEW_ONCE_SENSITIVE && turnHasSensitive && prefDisabled) {
                  await audit({
                    acao: 'outbound_view_once_skipped_by_preference',
                    pessoa_id: pessoa.id,
                    conversa_id: c.id,
                    mensagem_id: inbound.id,
                    metadata: { sensitive_tools: sensitiveTools },
                  });
                }
                const wid = await sendOutbound(pessoa.id, c.id, text, inbound.id, {
                  pending_question_id: latestPending?.id ?? null,
                  quoted: shouldQuote
                    ? quotedReplyContext(
                        inbound.metadata as Record<string, unknown> | null,
                        inbound.conteudo,
                      )
                    : undefined,
                  view_once,
                });
                if (wid && view_once) {
                  await audit({
                    acao: 'outbound_sent_view_once',
                    pessoa_id: pessoa.id,
                    conversa_id: c.id,
                    mensagem_id: inbound.id,
                    metadata: { whatsapp_id: wid, sensitive_tools: sensitiveTools },
                  });
                }
              }
            }
          }
        } finally {
          // B3b: always unlink the tmp PDF, even if send failed. Boot sweeper
          // is the safety net for crash-mid-send.
          if (latestReportPdf) {
            await unlink(latestReportPdf.path).catch((err) => {
              logger.warn({ err, path: latestReportPdf?.path }, 'pdf.unlink_failed_will_be_swept');
            });
          }
        }
        break;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pdf-flow.spec.ts`
Expected: PASS — 4/4 tests.

- [ ] **Step 5: Run the full B3 test suite to verify no regressions**

Run: `npx vitest run tests/unit/view-once.spec.ts tests/unit/baileys-view-once.spec.ts tests/unit/pdf-flow.spec.ts tests/unit/pdf-extrato.spec.ts tests/unit/pdf-comparativo.spec.ts tests/unit/baileys-send-document.spec.ts tests/unit/generate-report.spec.ts tests/unit/pdf-helpers.spec.ts tests/unit/pdf-sweeper.spec.ts tests/unit/registry-pdf-flag.spec.ts`
Expected: ALL pass. (B3a's view-once tests should still be green since the new PDF branch precedes them and is only taken when `latestReportPdf` is set.)

- [ ] **Step 6: Commit**

```bash
git add src/agent/core.ts tests/unit/pdf-flow.spec.ts
git commit -m "feat(b3b): agent loop — track latestReportPdf, route to sendOutboundDocument"
```

---

## Task 12: Final pass — typecheck, full suite, manual checklist, PR open

**Files:**
- None modified. This task is verification + the PR description.

- [ ] **Step 1: Full typecheck**

Run: `npm run build`
Expected: zero NEW errors. (Pre-existing 3 errors in `db/client.ts`, `gateway/queue.ts`, `lib/alerts.ts` are unchanged.)

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all NEW tests pass (Tasks 4-11 add tests). Pre-existing 1 unrelated failure in `pending-deprecation.spec.ts` is unchanged.

Cross-check that the 16 B3a tests still pass (5 in `baileys-view-once.spec.ts`, 11 in `view-once.spec.ts`).

- [ ] **Step 3: Push the branch and open the PR**

Branch off the design branch (per the project convention):

```bash
git checkout -b feat/whatsapp-b3b-pdf-reports
git push -u origin feat/whatsapp-b3b-pdf-reports
gh pr create --title "feat(whatsapp-b3b): PDF reports — extrato + comparativo" --body "$(cat <<'EOF'
## Summary

WhatsApp B3b — `generate_report` tool produces PDF reports (extrato, comparativo) and sends them as WhatsApp document attachments with LLM-written captions.

- New `Tool` `generate_report` with discriminated input by `tipo` (extrato | comparativo).
- New `pdfmake`-based generators in `src/lib/pdf/` (extrato, comparativo, helpers, sweeper).
- New `sendOutboundDocument` in `baileys.ts` — reads tmp file, ships via Baileys document API.
- Agent loop tracks `latestReportPdf` (mirrors B0's `latestPending`); no-tool-uses branch routes to document send when a PDF was generated; LLM's final text becomes the caption (truncated to 1024 chars).
- Tmp file lifecycle: `<media_root>/tmp/<uuid>.pdf` → send → `unlink` (in `finally`); boot sweeper handles orphans.
- New audit `outbound_sent_document` with `whatsapp_id`, `tipo`, `file_size_bytes`.
- Outbound `mensagens` row written with `tipo: 'documento'` and `midia_url: null` (no on-disk retention of financial PDFs).
- View-once is **never** applied to PDFs (per spec §11). PDFs are about UX, not privacy.

## Spec & Plan

- Spec: `docs/superpowers/specs/2026-04-30-whatsapp-b3b-pdf-reports-design.md`
- Plan: `docs/superpowers/plans/2026-04-30-whatsapp-b3b-pdf-reports.md`

## Acceptance criteria

All verified by code inspection + new unit tests:

- [x] `FEATURE_PDF_REPORTS=false` → `getToolSchemas` does NOT include `generate_report`
- [x] `FEATURE_PDF_REPORTS=true` + valid extrato → PDF generated; `sendOutboundDocument` called with the right shape; audit `outbound_sent_document` fires
- [x] `FEATURE_PDF_REPORTS=true` + valid comparativo → PDF generated with consolidado footer; sent
- [x] LLM caption appears in the WhatsApp message
- [x] `mensagens` row created with `tipo: 'documento'` and `midia_url: null`
- [x] Tmp file unlinked after send (success or failure)
- [x] Boot sweeper removes `*.pdf` files older than 1h on startup
- [x] Filename matches `<tipo>-<entidade-slug>-<yyyy-mm>.pdf`
- [x] pdfmake output passes `%PDF` magic-bytes check
- [x] Entidade outside scope → `{ error: 'forbidden' }`, no PDF, no send
- [x] Baileys disconnected (null wid) → no audit, tmp file still unlinked
- [x] Pre-existing tests (B3a view-once, etc.) do not regress
- [x] `FEATURE_PDF_REPORTS` documented in `.env.example`

## Test plan

- [x] `npx vitest run tests/unit/pdf-*.spec.ts tests/unit/baileys-send-document.spec.ts tests/unit/generate-report.spec.ts tests/unit/registry-pdf-flag.spec.ts` — all pass
- [ ] **Manual on Android receiver**: set `FEATURE_PDF_REPORTS=true`, message "manda extrato da Empresa X de outubro" — verify document opens in Android PDF viewer with header + table + totals; caption appears.
- [ ] **Manual flag-off**: set `FEATURE_PDF_REPORTS=false`, repeat — verify the LLM responds in plain text (tool no longer in `getToolSchemas`).
- [ ] **Manual sweeper**: leave a `<MEDIA_ROOT>/tmp/old.pdf` with `mtime` > 1h, restart — log shows "swept N tmp pdfs".

## Notes

- New `pdfmake` dependency (~5MB). Loaded lazily — only when `generate_report` actually runs. With the flag off, never loaded.
- B4 (voice polish) is the last sub-project remaining after this.
- Pre-existing TS errors in `db/client.ts`, `gateway/queue.ts`, `lib/alerts.ts` are unchanged.
- Pre-existing ESLint v9 config migration is also unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification matrix (maps to spec §12 acceptance criteria)

| AC bullet | Plan task | Test |
|---|---|---|
| Flag off → tool absent from schemas | 10 | `tests/unit/registry-pdf-flag.spec.ts` |
| Extrato → PDF + sendOutboundDocument + audit | 5, 9, 11 | `pdf-extrato.spec.ts`, `generate-report.spec.ts`, `pdf-flow.spec.ts` |
| Comparativo → PDF + consolidado | 6, 9 | `pdf-comparativo.spec.ts`, `generate-report.spec.ts` |
| Caption from LLM | 11 | `pdf-flow.spec.ts` "caption" |
| `mensagens.tipo='documento'`, `midia_url=null` | 11 | `pdf-flow.spec.ts` first scenario |
| Tmp file unlinked | 11 | `pdf-flow.spec.ts` first + null-WAID scenarios |
| Boot sweeper | 7 | `pdf-sweeper.spec.ts` |
| Filename convention | 5 | `pdf-extrato.spec.ts` |
| `%PDF` magic bytes | 5, 6 | `pdf-extrato.spec.ts`, `pdf-comparativo.spec.ts` |
| Forbidden on out-of-scope | 9 | `generate-report.spec.ts` |
| Null WAID → no audit | 11 | `pdf-flow.spec.ts` second scenario |
| `FEATURE_PDF_REPORTS` in .env.example | 1 | manual grep on commit |

---

## Dependencies and prerequisites

- B0 (`Tool` type at `_registry.ts`, agent loop tracking pattern) — **merged** (PR #12).
- Sub-A (`sendOutboundText` opts pattern) — **merged** (PR #11).
- B1 (one-tap polls/reactions) — **merged** (PR #15).
- B2 (message updates + outbound quoting + reminders) — **merged** (PR #16).
- B3a (view-once) — **merged** (PR #17). The B3b PDF branch in `core.ts` precedes the B3a view-once branch and bypasses it (per spec §11).

If main moves significantly between this plan and execution, Tasks 1, 7 (`src/index.ts`), and 11 (`src/agent/core.ts`) may need a small rebase against the latest line numbers.

---

## Out of scope (carry to follow-ups)

- Charts/gráficos (Q1=A locked PDF-only). Possible B5+ if requested.
- Saldo as PDF (Q3=C). Permanece texto.
- View-once for PDFs (Q5=2). Indefinido pelo cliente WA.
- Cache content-addressed (Q6=B → tmp + unlink). Not pursued for single-user.
- OFX/CSV export. Different canal.
- Owner runtime toggle of `FEATURE_PDF_REPORTS`. Post-B.

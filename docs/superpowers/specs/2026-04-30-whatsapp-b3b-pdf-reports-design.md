# WhatsApp B3b — PDF Reports — Design

**Date:** 2026-04-30
**Status:** Approved (in brainstorm), pending spec review and user review.
**Scope:** Sub-project B3b. Charts/gráficos deferred (out of scope per brainstorm Q1=A).
**Depends on:** sub-A (`sendOutboundText` opts pattern), B0 (`Tool` type, agent loop tracking pattern), B3a (`Tool.sensitive` field — referenced for symmetry, not used).

---

## 1. Purpose

When the agent's reply for an `extrato` (transaction list) or `comparativo` (multi-entity financial summary) request would otherwise be a long text dump (50–200 lines), produce a **PDF document** instead. The LLM writes a short caption that travels alongside the PDF as the WhatsApp document caption.

Reduces:
- WhatsApp history pollution from long tabular text replies.
- Cognitive load on the owner (the table's primary axes — date / value / category — are easier to scan in a paginated, monospaced PDF).

This is **not** a privacy feature. PDFs are NEVER wrapped in view-once (see §11 and B3a §1's caveats about platform support).

## 2. Goals

- A single declarative tool (`generate_report`) that the LLM can invoke when the owner asks for an extrato or comparativo.
- Two report types: `extrato` (one entidade × period) and `comparativo` (multiple entidades × period).
- LLM-written caption travels with the PDF.
- Feature-flagged: `FEATURE_PDF_REPORTS=false` by default.
- New `outbound_sent_document` audit so PDF deliveries are observable.
- No regression: with the flag off, the tool is absent from `getToolSchemas` and the agent's behaviour is unchanged.

## 3. Non-goals

- **Charts / graphs.** Brainstorm Q1=A locked PDF-only. If charts become wanted later, they ship as a separate sub-project (B5+).
- **PDF for `query_balance`.** Brainstorm Q3=C explicitly excluded saldo from PDF — saldos already render in 3-5 lines of text and forcing a PDF makes the UX worse.
- **View-once for PDFs.** WhatsApp client support for view-once on documents is undocumented/inconsistent; the spec deliberately does not pretend otherwise. See §11 for rationale.
- **Cache / content-addressed storage.** Brainstorm Q6=B picked tmp-file-and-unlink. Sub-second regeneration cost on a single-user app does not justify cache complexity or persistent disk traces of financial data.
- **Owner runtime toggle of the feature flag** ("manda em PDF de agora em diante"). Post-B if requested.
- **OFX/CSV export.** Different canal; not "report".

## 4. Architecture

### 4.1 New tool — `generate_report`

In `src/tools/generate-report.ts`. Discriminated union by `tipo`:

```typescript
const inputSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('extrato'),
    entidade_id: z.string().uuid(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    natureza: z.enum(['receita', 'despesa', 'movimentacao']).optional(),
  }),
  z.object({
    tipo: z.literal('comparativo'),
    entidade_ids: z.array(z.string().uuid()).min(2).max(8),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

const outputSchema = z.object({
  path: z.string(),                              // <media_root>/tmp/<uuid>.pdf
  fileName: z.string(),                          // 'extrato-empresa-x-2026-04.pdf'
  mimetype: z.literal('application/pdf'),
  tipo: z.enum(['extrato', 'comparativo']),
  summary: z.object({
    period: z.string(),                          // '01/04 a 30/04/2026' (display-formatted)
    rowCount: z.number().int().nonnegative().optional(),
    totals: z
      .object({
        receita: z.number(),
        despesa: z.number(),
        lucro: z.number(),
      })
      .optional(),
  }),
});
```

`required_actions`:
- `extrato` → `read_transactions`
- `comparativo` → `read_reports`

Both have `side_effect: 'read'`, `redis_required: false`, `operation_type: 'read'`. `sensitive: false` (not view-once eligible — per §11).

### 4.2 PDF generation library — `pdfmake`

New devDependency (production runtime — moves to `dependencies`): `pdfmake@^0.2.x`. Construído em cima do pdfkit, declarative API for tables. Brainstorm Q4=A. Bundle size ~5MB. Produces valid PDF/A-1-compatible output by default.

Two generator modules in `src/lib/pdf/`:

- `extrato.ts` — exports `generateExtratoPdf(data: ExtratoInput): Promise<{ path: string; summary: ... }>`
- `comparativo.ts` — exports `generateComparativoPdf(data: ComparativoInput): Promise<{ path: string; summary: ... }>`
- `_helpers.ts` — shared header/footer/styles, currency formatter (delegates to `src/lib/brazilian.ts`), date formatter, column-width calculator.

Both helpers internally:
1. Build the pdfmake document definition (declarative JSON).
2. Generate `Buffer` via `pdfMake.createPdfKitDocument(...).end()`.
3. Write to `<media_root>/tmp/<uuid>.pdf`. The `<media_root>` is the existing module-private `MEDIA_ROOT` constant in `src/gateway/baileys.ts:30`. Implementation note: that constant is currently NOT exported. The implementer SHOULD export it (`export const MEDIA_ROOT = ...`) so `src/lib/pdf/` can reuse it without re-deriving from `config.BAILEYS_AUTH_DIR`. Re-deriving would duplicate the path-resolution logic and risk drift if the convention changes.
4. Return `{ path, summary }`.

### 4.3 PDF templates

**Shared header** (both report types):
- Wordmark "**Maia**" (text, no image asset — keeps zero-asset design).
- Report title in Portuguese: "Extrato — {Entidade Nome}" or "Comparativo entre Entidades".
- Owner name from `pessoa.nome`.
- Period: "{date_from_br} a {date_to_br}" using Brazilian dd/MM/yyyy formatting.
- Generation timestamp (UTC + TZ).

**`extrato` body:**

Single table, columns:

| Data | Natureza | Valor | Categoria | Descrição |
|---|---|---|---|---|

- Sorted by `data_competencia` ascending.
- One row per transaction.
- Currency in Brazilian format (R$ 1.234,56). Negatives in red for `despesa` natureza.
- Categories shown by name (resolved from `categoria_id`) or "—" if null.
- Long descriptions wrap to 3 lines max with ellipsis.

**Page break:** automatic, header repeated on each page (pdfmake's `headerRows: 1`).

**Footer (last page only):**
```
Total receitas: R$ X.XXX,XX
Total despesas: R$ Y.YYY,YY
Lucro do período: R$ Z.ZZZ,ZZ
Total de transações: N
```

**Hard limit:** 500 rows. If `transacoesRepo.byScope` returns more, truncate to 500 and the footer reads "Truncado em 500 transações — refine o filtro para um período menor". This protects against PDFs that take 30+ seconds to render.

**`comparativo` body:**

Single table, columns:

| Entidade | Receita | Despesa | Lucro | Caixa Final |
|---|---|---|---|---|

- One row per entidade in `entidade_ids` (filtered by scope per §4.6).
- Final row "Consolidado" (bold) with the sum across all visible entidades.
- Same currency formatting as extrato.

### 4.4 Agent loop tracking — `latestReportPdf`

`src/agent/core.ts` adds a turn-local variable mirroring B0's `latestPending` pattern:

```typescript
let latestReportPdf: {
  path: string;
  fileName: string;
  mimetype: string;
  tipo: 'extrato' | 'comparativo';
} | null = null;
```

After each `dispatchTool` in the for-loop, if `tu.tool === 'generate_report'` and the output is non-error, capture the result. (Mirrors the B0 capture of `pending_question_id` from `ask_pending_question`'s output.)

### 4.5 No-tool-uses branch routing

In the no-tool-uses branch (currently the path that calls `sendOutbound`/`sendOutboundPoll`), insert a new third branch BEFORE the existing two:

```typescript
if (latestReportPdf) {
  // PDF send path: agent loop's text becomes the document caption
  const captionText = text.slice(0, 1024); // WhatsApp document caption max
  const wid = await sendOutboundDocument(jid, latestReportPdf.path, {
    mimetype: latestReportPdf.mimetype,
    fileName: latestReportPdf.fileName,
    caption: captionText,
    quoted: shouldQuote
      ? quotedReplyContext(inbound.metadata as Record<string, unknown> | null, inbound.conteudo)
      : undefined,
  });
  if (wid) {
    // file_size_bytes is read BEFORE unlink (the unlink is in finally below).
    const file_size_bytes = await fs
      .stat(latestReportPdf.path)
      .then((s) => s.size)
      .catch(() => 0); // defensive: never let stat-failure block the audit
    await audit({
      acao: 'outbound_sent_document',
      pessoa_id: pessoa.id,
      conversa_id: c.id,
      mensagem_id: inbound.id,
      metadata: { whatsapp_id: wid, tipo: latestReportPdf.tipo, file_size_bytes },
    });
    await mensagensRepo.create({
      conversa_id: c.id,
      direcao: 'out',
      tipo: 'documento',
      conteudo: captionText,
      midia_url: null, // we DO NOT keep the PDF after send (Q6=B)
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
  // unlink in finally — see §4.7
} else if (usePoll && latestPending) {
  // existing B1 path
} else {
  // existing B3a path: sendOutbound (text) with view_once decision
}
```

Note `mensagens.tipo: 'documento'` and `midia_url: null`. The `midia_url` is intentionally null because the PDF was deleted from disk after send (Q6=B). The audit row plus `mensagens.metadata.document_tipo` carry the structured evidence; the document content is irreversibly outbound-only.

### 4.6 Scope filtering

Inside `generate_report` handler, before generation:

- `extrato`: if `args.entidade_id` not in `ctx.scope.entidades`, return `{ error: 'forbidden' }`.
- `comparativo`: filter `args.entidade_ids` by `ctx.scope.entidades`. If filtered list is empty, return `{ error: 'forbidden' }`. If filtered list has 1 element, return `{ error: 'comparativo_needs_two', message: 'Comparativo precisa de pelo menos 2 entidades acessíveis' }`.

The 2-entity minimum is enforced both by the input schema (`min(2)`) and the post-scope-filter check.

### 4.7 Cleanup (tmp file lifecycle)

```typescript
try {
  // sendOutboundDocument + audit + mensagens.create as above
} finally {
  if (latestReportPdf) {
    await fs.unlink(latestReportPdf.path).catch((err) => {
      logger.warn({ err, path: latestReportPdf?.path }, 'pdf.unlink_failed_will_be_swept');
    });
  }
}
```

The `.catch()` keeps a failed unlink from masking the original outcome — the boot sweeper (§4.8) is the safety net.

### 4.8 Boot sweeper

`src/lib/pdf/_sweeper.ts` exports `sweepPdfTmp(): Promise<void>`:

- Reads `<media_root>/tmp/`.
- For each `*.pdf` file with `mtime` older than 1 hour, `unlink`.
- Logs total swept count.

Called once at process startup from `src/index.ts` (where `startBaileys` is called). Idempotent — sweeping an empty directory is a no-op. Errors logged but not re-thrown (we don't want sweeper failures to crash startup).

### 4.9 New `sendOutboundDocument` (baileys.ts)

```typescript
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
    buf = await fs.readFile(path);
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

The function reads the file into a buffer rather than streaming — for our 500-row hard limit, PDFs are <500KB, well within memory budget. Eliminates the partially-sent-on-error edge case.

## 5. Schema / migrations

None. No new DB tables. New audit_action `outbound_sent_document` appended to `src/governance/audit-actions.ts`. The `mensagens.tipo` column (free-form `text`, see `src/db/schema.ts:177`) already accepts `'documento'` — that string value is in use today for inbound documents (see `src/gateway/baileys.ts:231` and `src/gateway/types.ts`). No DDL change needed.

## 6. Configuration

`FEATURE_PDF_REPORTS` (default `false`).

When `false`:
- `getToolSchemas` filters out `generate_report`. The LLM never sees the tool exists. Behaviourally identical to pre-B3b.
- The `latestReportPdf` tracking code still exists but `tu.tool === 'generate_report'` never fires (LLM can't invoke).
- The PDF flow branch in core.ts is unreachable.
- pdfmake is loaded lazily — the dynamic import lives inside the `generate_report` handler (and the helpers it calls). Concretely:
  - `const pdfMakeModule = await import('pdfmake/build/pdfmake.js');`
  - `const vfsModule = await import('pdfmake/build/vfs_fonts.js');`
  - Then attach the VFS to the pdfMake instance (idiomatic pdfmake bootstrap).
  - The `pdfmake/build/pdfmake.js` core is ~2.5MB; `vfs_fonts.js` (default Roboto fonts) is ~1.5MB. Both load only on first PDF generation per process. With the flag off, the `generate_report` handler is unreachable, so neither loads.

When `true`:
- Tool registered, PDF flow active.

Validation criteria for default-on flip:
- 5+ extrato/comparativo turns observed in trial week.
- Owner reports the report quality "good enough" (one short check-in).
- Average generation time < 1s per PDF.

## 7. Audit-action additions

In `src/governance/audit-actions.ts`:

```typescript
'outbound_sent_document',
```

(Single action. The "skipped" or "failed" cases reuse existing audit conventions: `error` keys in tool result, generic warn-log on send failure.)

## 8. Concurrency

`latestReportPdf` is a turn-local variable; no cross-turn or cross-process concurrency. The tmp file path is UUID-based — no collision risk between concurrent requests.

If two concurrent ReAct loops both generate PDFs (e.g., owner sends two requests in rapid succession), both write to distinct UUIDs in `<media_root>/tmp/` and both unlink independently. No shared state.

## 9. Error handling

| Failure | Tratamento |
|---|---|
| pdfmake throws (bad input, font load fail) | Tool returns `{ error: 'pdf_generation_failed', message }`. LLM has the chance to fall back to a text reply. |
| Disk write failure (`tmp/` not writable) | Tool returns `{ error: 'pdf_io_failed', message }`. Same fallback. |
| `transacoesRepo.byScope` returns 0 rows for extrato | Tool still generates PDF — header + empty table + footer "Sem transações no período". Caption from LLM contextualizes. |
| Comparativo filtered scope yields <2 entidades | Tool returns `{ error: 'comparativo_needs_two', message: ... }`. LLM apologizes / asks for more entidades. |
| `sendOutboundDocument` returns null (Baileys disconnected) | Audit NOT emitted. tmp file still unlink'd in finally. LLM next turn (if any) can reformulate. |
| `fs.readFile` fails inside `sendOutboundDocument` (file vanished between generation and send — should be impossible but defensive) | Returns null, same as disconnect. |
| Caption > 1024 chars | Silently truncated in core.ts (WhatsApp's hard limit). |
| Crash between `sendOutboundDocument` and `unlink` | Sweeper (§4.8) cleans up on next boot. |

## 10. Testing

### Unit (`tests/unit/generate-report.spec.ts` — new)

- Schema validation: extrato with valid args → no throw; extrato with `entidade_ids` → schema error; comparativo with 1 entidade → schema error (min(2)); comparativo with 9 → schema error (max(8)).
- Scope filtering: extrato with `entidade_id` outside scope → `{ error: 'forbidden' }`; comparativo with all entidades outside scope → `{ error: 'forbidden' }`; comparativo with mixed → filters silently to allowed.
- pdfmake produces valid PDF: Buffer's first 4 bytes are `%PDF`.
- Summary correctness: extrato totals match input transactions; comparativo summary fields match the row consolidado.
- Truncation: 600 transactions in scope → output PDF row count = 500, footer reads "truncado".

### Unit (`tests/unit/baileys-send-document.spec.ts` — new)

- Contract: `socket.sendMessage` receives `{ document: Buffer, mimetype, fileName, caption }` exactly.
- `quoted` is forwarded as third arg when provided; `undefined` otherwise.
- Returns null when not connected; `sendMessage` not called.
- Returns null when `fs.readFile` throws (file vanished); logged at error level.

### Unit (`tests/unit/pdf-flow.spec.ts` — new)

- `dispatchTool` returns `generate_report` result → `latestReportPdf` populated.
- No-tool-uses branch: with `latestReportPdf` set, calls `sendOutboundDocument` (NOT `sendOutboundText`).
- Caption equals the LLM's final text, truncated to 1024 chars.
- Audit `outbound_sent_document` fired with `wid`, `tipo`, `file_size_bytes` metadata.
- Outbound `mensagens.tipo === 'documento'` and `midia_url === null`.
- `unlink` called in finally even when `sendOutboundDocument` returns null.

### Manual (PR checklist)

- Set `FEATURE_PDF_REPORTS=true`. Send a request from real Android receiver: "manda o extrato da Empresa X de Outubro".
- Verify document appears in WhatsApp, opens in Android's PDF viewer, layout looks correct.
- Verify caption text appears.
- Verify boot sweeper logs "swept N tmp pdfs" on restart with leftover orphans.

## 11. Out of scope

| Item | Defer to |
|---|---|
| Charts (bar, line, pie) embedded in PDF | B5+ if requested |
| Standalone PNG charts | B5+ |
| `query_balance` as PDF | not pursued (UX worse than text) |
| View-once for PDFs | indefinido pelo cliente WA — não pursued |
| Cache content-addressed | not pursued (single-user) |
| OFX/CSV export | separate canal |
| Owner runtime toggle of `FEATURE_PDF_REPORTS` | post-B |
| Per-pessoa PDF preference (e.g., timezone, currency override) | post-B |
| PDF/A archival format compliance | not pursued |
| PDF password protection | not pursued (the privacy story is "delete after read", not "encrypt at rest") |

## 12. Acceptance criteria

- [ ] `FEATURE_PDF_REPORTS=false` → `getToolSchemas` does NOT include `generate_report`. The LLM has no surface to invoke it.
- [ ] `FEATURE_PDF_REPORTS=true` + valid extrato → PDF generated with header + table + footer (totals); `sendOutboundDocument` called with the path, `mimetype: 'application/pdf'`, fileName like `extrato-empresa-x-2026-04.pdf`, and the LLM's caption; audit `outbound_sent_document` fires with `whatsapp_id` and `tipo`.
- [ ] `FEATURE_PDF_REPORTS=true` + valid comparativo → PDF generated with rows per entidade + consolidado footer row; sent.
- [ ] LLM caption appears in the WhatsApp message (verified via mock asserting `caption` field on the `socket.sendMessage` call).
- [ ] `mensagens` row created with `tipo: 'documento'` and `midia_url: null`.
- [ ] Tmp file unlinked after send (success or failure path).
- [ ] Boot sweeper removes `*.pdf` files in `<media_root>/tmp/` older than 1h on startup.
- [ ] Filename in WhatsApp matches the `<tipo>-<entidade-slug>-<yyyy-mm>.pdf` convention.
- [ ] pdfmake output passes the magic-bytes check (`%PDF`).
- [ ] Entidade outside scope → `{ error: 'forbidden' }`, no PDF generated, no send.
- [ ] Baileys disconnected (null wid) → no audit, no `mensagens` row, tmp file still unlinked.
- [ ] Pre-existing tests do not regress (specifically: agent-typing-debounce, pending-gate, view-once, baileys-view-once).
- [ ] `FEATURE_PDF_REPORTS` documented in `.env.example`.

## 13. References

- Sub-A design — `docs/superpowers/specs/2026-04-29-whatsapp-ux-polish-design.md` (`sendOutboundText` opts pattern, mirrored here)
- B0 design — `docs/superpowers/specs/2026-04-29-whatsapp-b0-pending-gate-design.md` (`Tool` type, agent loop tracking pattern)
- B3a design — `docs/superpowers/specs/2026-04-29-whatsapp-b3a-view-once-design.md` (referenced in §11 for the explicit "no view-once for PDFs" decision)
- Spec 09 — audit taxonomy
- Spec 10 — multimedia (inbound only — outbound media is new)
- Spec 14 — Brazilian formatting (`src/lib/brazilian.ts`)
- pdfmake docs: <https://pdfmake.github.io/docs/>
- Baileys docs: `sendMessage` document content type accepts `{ document: Buffer, mimetype, fileName, caption }`.

# Spec 13 — OFX & CSV Import: Parsing & Reconciliation

**Status:** Phase 4 • **Depends on:** 00, 02, 09, 14

---

## 1. Purpose

Allow Maia to ingest bank statements (OFX, OFX-2, CSV) — typically downloaded from internet banking and shared via WhatsApp or web upload — and **reconcile** them against transactions already recorded by the user. Reconciliation produces three outcomes per statement entry: matched, candidate, or new; user confirms ambiguous cases; new entries are auto-registered with a confidence score.

## 2. Goals

- Parse OFX 1.x (SGML) and OFX 2.x (XML), and bank-CSV formats from major Brazilian banks.
- Match statement entries to existing `transacoes` deterministically when possible.
- For ambiguous matches, surface a candidate list and ask the user.
- Treat the bank statement as the authoritative source of `data_pagamento` and reconciled balance.
- Write a `import_runs` audit row per import.

## 3. Non-goals

- Open Banking integrations (Belvo, Pluggy). Postponed.
- Direct OAuth scraping of bank portals.
- Investment statements (CDB, ações). Phase 4 covers only checking accounts.

## 4. Architecture

### 4.1 New table: `import_runs`

```sql
CREATE TABLE import_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id),
  entidade_id     UUID NOT NULL REFERENCES entidades(id),
  conta_id        UUID NOT NULL REFERENCES contas_bancarias(id),
  fonte           TEXT NOT NULL CHECK (fonte IN ('ofx','csv','pdf-extrato')),
  arquivo_sha256  TEXT NOT NULL,
  arquivo_nome    TEXT,
  periodo_de      DATE,
  periodo_ate     DATE,
  total_lancamentos INT NOT NULL DEFAULT 0,
  matched         INT NOT NULL DEFAULT 0,
  candidates      INT NOT NULL DEFAULT 0,
  novos           INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('pending_review','aplicado','cancelado','falhou')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conta_id, arquivo_sha256)              -- idempotency
);

CREATE TABLE import_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_run_id   UUID NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  ordem           INT NOT NULL,
  tipo_oper       TEXT NOT NULL,                -- 'credit' | 'debit'
  valor           NUMERIC(15,2) NOT NULL,
  data_oper       DATE NOT NULL,
  fitid           TEXT,                          -- OFX FITID (unique per statement)
  memo            TEXT,
  contraparte_raw TEXT,
  status          TEXT NOT NULL CHECK (status IN ('matched','candidate','new','rejected')),
  matched_transacao_id UUID REFERENCES transacoes(id),
  candidates      JSONB,                         -- array of { transacao_id, score, reason }
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.2 Pipeline

```
[1] Owner uploads file:
    - WhatsApp: sends file as document → gateway saves under media/<sha256>
    - CLI: npm run import:ofx -- --conta=E1-Inter --file=path/to.ofx
   │
   ▼
[2] Pre-parse:
    detect format (OFX vs CSV); parse header; extract account info;
    verify account against the conta_id (raise on mismatch)
   │
   ▼
[3] Normalize entries to a common shape
   │
   ▼
[4] For each entry:
       try match (FITID first, then heuristic)
       classify status: matched / candidate / new
   │
   ▼
[5] Persist import_runs (status='pending_review') and import_entries
   │
   ▼
[6] Send summary to owner:
    "Extrato Itaú E1, 124 lançamentos — 100 matched, 12 candidatos, 12 novos. Revisa?"
   │
   ▼
[7] Owner walks through candidates / new (in WhatsApp or via CLI)
   │
   ▼
[8] Apply: write matched FITIDs to transacoes.metadata; create new transacoes;
    update saldos atomicamente
   │
   ▼
[9] import_runs.status='aplicado'
```

## 5. Matching algorithm

For each statement entry, compute a **match score** against existing `transacoes` filtered by `conta_id` and date window `[data_oper - 7d, data_oper + 2d]`:

```typescript
function matchScore(entry: ImportEntry, t: Transacao): number {
  let score = 0;
  // FITID exact match (when bank provides it consistently)
  if (entry.fitid && t.metadata?.fitid === entry.fitid) return 1.0;
  // Same value: strong
  if (Math.abs(entry.valor - t.valor) < 0.01) score += 0.4;
  // Same nature
  if ((entry.tipo_oper === 'debit'  && t.natureza === 'despesa') ||
      (entry.tipo_oper === 'credit' && t.natureza === 'receita')) score += 0.1;
  // Description similarity
  score += 0.4 * trigramSim(normalize(entry.memo + ' ' + entry.contraparte_raw),
                            normalize(t.descricao + ' ' + (t.contraparte ?? '')));
  // Date proximity (penalize far)
  const days = Math.abs(daysBetween(entry.data_oper, t.data_competencia));
  score += Math.max(0, 0.1 - days * 0.02);
  return Math.min(1, score);
}
```

Decision:

| Score | Status | Action |
|---|---|---|
| ≥ 0.9 with single best match | `matched` | Auto-link |
| ≥ 0.6 with one or more matches | `candidate` | Ask user |
| < 0.6 best | `new` | Will create new `transacoes` on apply |

For `matched`: update `transacoes.data_pagamento = entry.data_oper`, `metadata.fitid = entry.fitid`, `status='paga'/'recebida'`.

## 6. Schemas

### 6.1 OFX entry (post-normalization)

```typescript
const ImportEntry = z.object({
  fitid: z.string().optional(),          // OFX FITID
  tipo_oper: z.enum(['credit','debit']),
  valor: z.number().positive(),
  data_oper: z.string(),                  // ISO date
  memo: z.string().optional(),
  contraparte_raw: z.string().optional(),
  saldo_apos: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});
```

### 6.2 CSV format detection

The first row is inspected for known column patterns from major banks (Itaú, Bradesco, Inter, Nubank, BB, Caixa, Santander). A registry of `CSV_PROFILES` maps each profile to a column extractor function.

## 7. Reconciliation UX (WhatsApp)

After step [6]:

```
Maia: "Extrato Itaú E1 — 124 lançamentos:
        ✓ 100 já estavam lançados
        ? 12 com candidatos
        + 12 novos a criar
        Tudo automático ou quer revisar candidatos?"

Owner: "revisar"

Maia (item 1/12):
  "07/04 — débito R$ 412,80
   Memo: 'COMPRA CARTAO MERCADO'
   Candidatos:
   1. Mercado, R$ 412,80, 06/04, descrição 'Mercado Pão de Açúcar'  (score 0.84)
   2. Compra cartão, R$ 412,80, 07/04, descrição 'Cartão XYZ'        (score 0.61)
   1 / 2 / nenhum / pula"

Owner: "1"

Maia: "Marcado. Próximo..."
```

When all candidates are resolved, Maia summarizes the new entries and asks for confirmation to apply.

## 8. Behavior & Rules

### 8.1 Idempotency on file

`UNIQUE (conta_id, arquivo_sha256)` on `import_runs` ensures the same file is not imported twice. Re-uploading the same OFX returns the existing run (in whichever status) and a polite message.

### 8.2 Anti-duplication on entries

Even within one import, entries may be duplicates (rare, but happens with poor exports). FITID uniqueness is checked; without FITID, semantic dedup applies.

### 8.3 Entity & account safety

The OFX file's account number must match the `contas_bancarias` row's `numero` (or `metadata.match_hint` if numero is partial). Mismatch raises an error and refuses import.

### 8.4 Permissions

Importing is a **dual-approval** action when the resulting auto-create would write transactions > `VALOR_DUAL_APPROVAL` in aggregate, or when `novos > 50`. Otherwise single-sig (owner-only).

## 9. LLM Boundaries

The LLM may:

- Help the user pick among candidates by asking clarifying questions.
- Phrase the import summary and progress.

The LLM may not:

- Edit OFX parsing logic.
- Pick the candidate on its own when score < 0.9; only the user picks.
- Bypass dual approval thresholds.

## 10. Failure modes

| Failure | Behavior |
|---|---|
| OFX malformed | Reject with line/column hint; ask user to retry |
| CSV format unknown | List known profiles; ask user to pick or contribute mapping |
| Account number mismatch | Reject; suggest the right account |
| Re-upload of identical file | Return idempotent reference to existing run |
| User abandons mid-review | Run stays `'pending_review'` for 7 days; reminder; auto-cancel after 14 days |

## 11. Acceptance criteria

- [ ] Itaú, Inter, Nubank OFX files parse correctly on test fixtures.
- [ ] Same OFX uploaded twice does not create duplicate import runs.
- [ ] FITID-based matching achieves > 95% match rate on hand-labeled fixtures.
- [ ] Auto-apply marks `data_pagamento` and `status` correctly.
- [ ] Aggregate value > `VALOR_DUAL_APPROVAL` triggers 4-eyes; otherwise single-sig.

## 12. References

- Spec 02 — schemas
- Spec 09 — dual approval triggers
- Spec 14 — currency/date parsing
- Spec 11 — workflow `fechamento_mes` consumes `import_runs`

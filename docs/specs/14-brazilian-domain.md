# Spec 14 — Brazilian Domain: PIX, Boleto, CNPJ/CPF, BRL, Holidays

**Status:** Foundation (validation), Phase 2 (parsing) • **Depends on:** 00, 02, 07, 10

---

## 1. Purpose

Centralize all Brazil-specific business rules that would otherwise leak into multiple specs (tools, parsers, governance). This spec is the **single source of truth** for currency formatting, document validation, PIX semantics, boleto parsing, banking holidays, timezone handling, and phone number canonicalization.

Modules consuming these rules: `tools/register-transaction`, `tools/parse-boleto`, `tools/parse-receipt`, `gateway`, `reconciliation`, `wizard`, `governance`.

## 2. Goals

- Pure functions, deterministic, fully tested. No external dependency for validations (the algorithms are short).
- A single TypeScript module: `src/lib/brazilian.ts`.
- Comprehensive test fixtures using real-world examples.
- Hold the bank/holiday tables current; update is a code change.

## 3. Non-goals

- Multi-currency. BRL only.
- Tax calculations (DAS, IRPF). Out of scope; accountants handle.
- Brazilian tax-document parsing (NF-e, NFC-e). Out of scope.

## 4. Currency — BRL

### 4.1 Formatting

```typescript
function formatBRL(value: number, opts?: { sign?: 'auto'|'always'|'never' }): string {
  // 1234.56 → "R$ 1.234,56"
  // 0       → "R$ 0,00"
  // -50     → "-R$ 50,00"
  // sign='always' → "+R$ 50,00"
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
```

### 4.2 Parsing

```typescript
function parseBRL(input: string): number | null {
  // Handles: "R$ 1.234,56", "1.234,56", "1234,56", "R$50", "50,00", "50.00" (US fallback)
  const cleaned = input.replace(/[^0-9.,\-]/g, '').trim();
  if (!cleaned) return null;
  // Heuristic: Brazilian uses '.' as thousand and ',' as decimal.
  // If the string has both: '.' is thousand, ',' is decimal.
  // If only '.', and it appears once with 2 digits after: it's decimal (US-like, accept).
  // If only ',', always decimal.
  // ...
}
```

Edge cases covered by tests: `"R$ 1.234,56"`, `"1.234,56"`, `"1234,56"`, `"R$50"`, `"50,00"`, `"R$ 1.234.567,89"`.

### 4.3 Always store cents internally

For the idempotency key normalization (spec 09), values are always converted to integer cents. Intermediate calculations may use `number`, but persistence uses `NUMERIC(15,2)`.

## 5. Documents — CPF & CNPJ

### 5.1 CPF (11 digits)

```typescript
function isValidCPF(input: string): boolean {
  const d = input.replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;          // all same digit
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i]) * (10 - i);
  let check1 = (sum * 10) % 11; if (check1 === 10) check1 = 0;
  if (check1 !== parseInt(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i]) * (11 - i);
  let check2 = (sum * 10) % 11; if (check2 === 10) check2 = 0;
  return check2 === parseInt(d[10]);
}

function formatCPF(input: string): string {
  const d = input.replace(/\D/g, '').padStart(11, '0');
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}
```

### 5.2 CNPJ (14 digits)

```typescript
function isValidCNPJ(input: string): boolean {
  const d = input.replace(/\D/g, '');
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  const sum = (n: number, weights: number[]) =>
    [...d.slice(0, weights.length)].reduce((s, ch, i) => s + parseInt(ch) * weights[i], 0);
  const check1 = (sum(0, w1) % 11 < 2) ? 0 : 11 - (sum(0, w1) % 11);
  if (check1 !== parseInt(d[12])) return false;
  const check2 = (sum(0, w2) % 11 < 2) ? 0 : 11 - (sum(0, w2) % 11);
  return check2 === parseInt(d[13]);
}

function formatCNPJ(input: string): string {
  const d = input.replace(/\D/g, '').padStart(14, '0');
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
}
```

### 5.3 Generic identifier

```typescript
function classifyDocument(input: string): { kind: 'cpf'|'cnpj'|'invalid'; canonical?: string } {
  const d = input.replace(/\D/g, '');
  if (d.length === 11) return isValidCPF(d) ? { kind: 'cpf', canonical: d } : { kind: 'invalid' };
  if (d.length === 14) return isValidCNPJ(d) ? { kind: 'cnpj', canonical: d } : { kind: 'invalid' };
  return { kind: 'invalid' };
}
```

## 6. PIX

### 6.1 Key types

```typescript
type PixKeyKind = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

function detectPixKey(input: string): { kind: PixKeyKind; canonical: string } | null {
  const t = input.trim();
  // CPF
  if (classifyDocument(t).kind === 'cpf') return { kind: 'cpf', canonical: classifyDocument(t).canonical! };
  // CNPJ
  if (classifyDocument(t).kind === 'cnpj') return { kind: 'cnpj', canonical: classifyDocument(t).canonical! };
  // Email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'email', canonical: t.toLowerCase() };
  // Phone (E.164 strict for stored, but accept Brazilian common formats)
  const phone = normalizePhoneBR(t);
  if (phone) return { kind: 'phone', canonical: phone };
  // Random key (UUID-ish)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t))
    return { kind: 'random', canonical: t.toLowerCase() };
  return null;
}
```

### 6.2 endToEndId format

PIX official format:
```
E + ISPB(8 digits, sender bank) + YYYYMMDDHHMM(12 digits) + checksum/random(12 alphanumeric)
total: 32 chars starting with 'E'
```

```typescript
const PIX_E2E_RE = /^E\d{8}\d{12}[A-Za-z0-9]{12}$/;
function isValidEndToEndId(s: string): boolean { return PIX_E2E_RE.test(s); }
```

### 6.3 Receipt → transaction mapping

`ReceiptParse` (spec 10) → `register_transaction.args`:

```typescript
function receiptToTransactionIntent(r: ReceiptParse, ctx: { entidade_id: string; conta_id: string }): RegisterTransactionInput {
  return {
    entidade_id: ctx.entidade_id,
    conta_id: ctx.conta_id,
    natureza: r.tipo === 'pix' || r.tipo === 'ted' ? 'despesa' : 'movimentacao',
    valor: r.valor,
    data_competencia: r.data.slice(0, 10),
    data_pagamento: r.data.slice(0, 10),
    status: 'paga',
    descricao: r.descricao ?? `${r.tipo.toUpperCase()} para ${r.beneficiario_nome ?? '?'}`,
    contraparte_nome: r.beneficiario_nome,
    metadata: {
      tipo: r.tipo,
      endToEndId: r.endToEndId,
      chave_pix_destino: r.beneficiario_chave_pix,
      banco_destino: r.banco_destino,
      origem: 'comprovante_ocr',
    },
    origem: 'whatsapp',
  };
}
```

## 7. Boleto

### 7.1 Linha digitável (47 digits, 5 fields)

Format: `AAAAA.AAAAA BBBBB.BBBBBB CCCCC.CCCCCC D EEEEEEEEEEEEEE`

```
Field 1: positions 1–5  — banco(3) + moeda(1) + first 5 of campo livre
Field 2: positions 6–9  — DV1
Field 3: positions 10–24
Field 4: positions 25–29
Field 5: positions 30–43 — fator vencimento(4) + valor(10)
```

### 7.2 Validation

```typescript
function isValidLinhaDigitavel(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length !== 47) return false;
  // Compute DV per field using mod-10 (alternating 2/1 weights) for fields 1–3, mod-11 for general DV
  // (Implementation detail: full algorithm in code; this spec carries the contract.)
  // ...
  return true;
}

function parseLinhaDigitavel(s: string): {
  banco_codigo: string;
  vencimento_data: string;          // ISO date
  valor: number;
  campo_livre: string;
  codigo_barras: string;
} | null;
```

### 7.3 Vencimento

`fator_vencimento` is the number of days since 07/10/1997 (Itau base date, used by FEBRABAN). To convert:

```
date = base(1997-10-07) + fator * 1 day
```

After 2025-02-22 the fator wraps; algorithm handles the wrap correctly.

### 7.4 Valor

10 digits in cents, `valor = parseInt(digits) / 100`. Some convênios may have `valor=0` (consult-only boletos); these are rejected for `register_transaction`.

## 8. Phone (E.164, Brazilian)

```typescript
function normalizePhoneBR(input: string): string | null {
  // Strips non-digits + '+'.
  // Accepts: '+5511999999999', '5511999999999', '11999999999', '999999999' (raises ambiguous)
  // Returns canonical '+55DDNNNNNNNNN' (DD = DDD 2 digits, N = 8 or 9 digits)
}
```

Rejects:
- Less than 10 digits after country code
- DDD not in valid Brazilian ranges (11–99 with gaps)
- Invalid mobile prefix (must start with 9 if mobile)

## 9. Timezone & dates

### 9.1 TZ rule

All persisted timestamps are `TIMESTAMPTZ` in UTC. All **display** uses `config.TZ` (default `America/Sao_Paulo`). All **business-day** calculations use `config.TZ`.

```typescript
import { formatInTimeZone } from 'date-fns-tz';
function fmtBR(date: Date, pattern = 'dd/MM/yyyy'): string {
  return formatInTimeZone(date, config.TZ, pattern);
}
```

### 9.2 Daylight saving

Brazil abolished DST in 2019. `America/Sao_Paulo` is UTC-3 year-round. We do **not** check for DST transitions; if Brazil ever reinstates it, this section is updated.

## 10. Banking holidays

### 10.1 Holiday table

Static list maintained in `src/lib/brazilian-holidays.ts`, regenerated yearly. Sources: Banco Central calendar.

```typescript
const NATIONAL_HOLIDAYS_2026 = [
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21',
  '2026-05-01', '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02',
  '2026-11-15', '2026-11-20',  // black consciousness day (federal since 2024)
  '2026-12-25',
];
```

### 10.2 Business day

```typescript
function isBusinessDayBR(date: Date): boolean {
  const local = formatInTimeZone(date, config.TZ, 'yyyy-MM-dd');
  const weekday = getDayInTZ(date, config.TZ);  // 0=Sun, 6=Sat
  if (weekday === 0 || weekday === 6) return false;
  return !NATIONAL_HOLIDAYS.includes(local);
}

function nextBusinessDayBR(date: Date): Date;
function previousBusinessDayBR(date: Date): Date;
```

### 10.3 Boleto due date semantics

A boleto vencendo num feriado/fim de semana paga no próximo dia útil. The reconciliation worker uses `nextBusinessDayBR` to compute expected `data_pagamento`.

## 11. Bank codes

Common Brazilian banks (FEBRABAN code, 3 digits):

```typescript
const BANCOS_CODIGO = {
  '001': 'Banco do Brasil',
  '033': 'Santander',
  '104': 'Caixa Econômica Federal',
  '237': 'Bradesco',
  '341': 'Itaú',
  '260': 'Nubank',
  '077': 'Inter',
  '380': 'PicPay',
  // ... extend as encountered
} as const;
```

Used by boleto and OFX parsers to enrich entries with the bank's friendly name.

## 12. LLM Boundaries

The LLM may:

- Read formatted strings and recognize them in user input.
- Ask the user to confirm a CPF/CNPJ when the input is ambiguous.

The LLM may not:

- Validate documents itself. It must call `isValidCPF` / `isValidCNPJ` via a tool / dispatcher helper. In practice, validation runs inside the tool's pre-execution; LLM only sees the result.
- Override holiday tables.
- Compute boleto checksums "by hand".

## 13. Behavior & Rules

### 13.1 Storage canonical forms

| Field | Storage form |
|---|---|
| CPF | 11 digits, no punctuation |
| CNPJ | 14 digits, no punctuation |
| Phone | E.164 with `+` |
| Email | lowercase |
| Date | ISO `YYYY-MM-DD` |
| Datetime | UTC ISO 8601 |
| Currency | NUMERIC(15,2) BRL |

Display uses formatted versions per locale.

### 13.2 PIX collision detection

When registering a `contraparte`, `chave_pix` is checked for uniqueness within the same entidade. A new key matching an existing one prompts confirmation (could be intentional update, but worth confirming).

## 14. Error cases

| Failure | Behavior |
|---|---|
| Invalid CPF / CNPJ provided | Tool returns `invalid_args` with a clear message |
| Invalid `linha_digitavel` from OCR | Confidence < threshold, surface to user |
| Phone number with international country code other than Brazil | Reject with explanation; we are domestic-only |
| Holiday list out-of-date (year not present) | Logger warns; isBusinessDayBR conservatively assumes business day; alert owner to update |

## 15. Acceptance criteria

- [ ] CPF and CNPJ validators agree with official examples (Receita Federal samples).
- [ ] BRL parser handles all 6 documented edge cases.
- [ ] Linha digitável validator agrees with FEBRABAN reference data (10 fixtures).
- [ ] PIX endToEndId regex matches Banco Central spec.
- [ ] Holiday table for current year is present at startup.
- [ ] Phone normalizer rejects 10 documented invalid inputs and accepts 10 valid ones.

## 16. References

- Spec 02 — schema fields requiring these formats
- Spec 07 — `register_transaction`, `parse_boleto`, `parse_receipt`
- Spec 10 — multimedia parsing produces values that must validate here
- Spec 13 — OFX reconciliation uses banking holidays for `data_pagamento`

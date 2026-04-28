# Spec 10 — Multimedia: Audio (Whisper) & Vision (Boletos / Receipts)

**Status:** Phase 2 • **Depends on:** 00, 02, 04, 06, 07, 09, 14

---

## 1. Purpose

Define how Maia handles non-text WhatsApp messages: voice notes, photographed receipts, photographed bills (boletos), and PDF documents. This spec covers transcription, OCR, file storage, content-addressed deduplication, and failure handling.

## 2. Goals

- Audio messages transcribed via OpenAI Whisper; result fed back into the agent loop as text.
- Boleto images parsed via Claude Vision; structured output validated against Brazilian boleto rules (spec 14).
- Receipts (comprovantes PIX/TED) parsed via Claude Vision; structured fields extracted.
- Files stored content-addressed (`sha256` filenames) to support attachment idempotency.
- Graceful degradation when external services fail.

## 3. Non-goals

- Self-hosted Whisper / Vision. Phase 2 uses APIs.
- Live audio transcription / streaming. WhatsApp delivers entire audio file.
- Video messages. Out of scope.

## 4. Architecture

### 4.1 File storage

```
<media_root>/
  yyyy-mm/
    <sha256>.<ext>          // canonical filename
    <sha256>.<ext>.json     // metadata sidecar (mime, original_name, size, parsed_at)
```

`media_root` is set via `BAILEYS_AUTH_DIR/../media` by default (mounted as a Docker volume). The same `sha256` may be referenced by multiple `mensagens.midia_url` rows — we never duplicate the file on disk.

### 4.2 Pipeline for inbound media

```
Gateway (spec 04) saves file → mensagens.midia_url, mensagens.metadata.media_sha256
   │
   ▼
Agent worker reads message → sees tipo='audio' or 'imagem'
   │
   ▼
Tool dispatch:
  audio → transcribe_audio (spec 07 §6.7)
  imagem → first try parse_boleto, then heuristic for receipt
   │
   ▼
Result returned to LLM as tool_result; LLM proceeds (often with register_transaction next)
```

### 4.3 Parser routing for images

Images may be boletos, PIX/TED receipts, or generic photos. Decision tree:

```
1. parse_boleto attempts: looks for linha_digitável (47 digits) and/or barcode.
   Confidence > 0.7 → return BoletoParse.
2. Else parse_receipt: looks for "PIX", "TED", "Comprovante", value, beneficiary.
   Confidence > 0.6 → return ReceiptParse.
3. Else generic_image: returns "I see an image; could you describe?"
```

Each step calls Claude Vision with a different prompt and constrained output schema.

## 5. Schemas

### 5.1 Audio transcription output

```typescript
const TranscriptionResult = z.object({
  texto: z.string(),
  idioma: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),  // 'pt' or 'pt-BR'
  duracao_segundos: z.number().nonnegative(),
  confianca: z.number().min(0).max(1),
  segments: z.array(z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })).optional(),
});
```

### 5.2 Boleto parse output

```typescript
const BoletoParse = z.object({
  linha_digitavel: z.string().regex(/^\d{47}$/),
  codigo_barras: z.string().regex(/^\d{44}$/).optional(),
  valor: z.number().positive(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  beneficiario_nome: z.string(),
  beneficiario_cnpj_cpf: z.string().optional(),
  banco_emissor_codigo: z.string().regex(/^\d{3}$/).optional(),
  // confianca: per-field
  confianca: z.object({
    linha_digitavel: z.number().min(0).max(1),
    valor: z.number().min(0).max(1),
    vencimento: z.number().min(0).max(1),
    beneficiario: z.number().min(0).max(1),
  }),
});
```

The parsed `linha_digitavel` is **revalidated** by the Brazilian-domain module (spec 14) — a string that "looks like" 47 digits but fails the modulo-10 / modulo-11 checks is rejected.

### 5.3 Receipt parse output

```typescript
const ReceiptParse = z.object({
  tipo: z.enum(['pix', 'ted', 'doc', 'transferencia_propria', 'outro']),
  valor: z.number().positive(),
  data: z.string(),                              // ISO date or datetime
  beneficiario_nome: z.string().optional(),
  beneficiario_documento: z.string().optional(),  // CPF/CNPJ
  beneficiario_chave_pix: z.string().optional(),
  pagador_nome: z.string().optional(),
  banco_origem: z.string().optional(),
  banco_destino: z.string().optional(),
  endToEndId: z.string().regex(/^E\d{8}\d{12}\d{12}$/).optional(),  // PIX official format
  descricao: z.string().optional(),
  confianca: z.number().min(0).max(1),
});
```

## 6. Behavior & Rules

### 6.1 Idempotency for media tools

Both `transcribe_audio` and `parse_boleto` are **`operation_type = 'parse_only'`** with idempotency key keyed on `(pessoa_id, entity_id, tool, operation_type, file_sha256)` — no time bucket. The same audio sent again yields the cached transcription with no additional API cost.

### 6.2 Privacy & file lifetime

Media files persist on disk until **either**:

- The owner runs `npm run media:purge --older=180d` (manual housekeeping), **or**
- The originating `mensagens` row is deleted (cascading cleanup; not done in Phase 1).

There is no automatic purge in Phase 1 because audit value > storage cost for a personal deployment.

### 6.3 Owner can re-OCR with override

Sometimes the OCR misreads. Owner command: `"Maia, parse de novo essa foto"` invalidates the idempotency cache for that file's parse and re-invokes Vision.

### 6.4 Confidence thresholds

| Tool | Auto-action threshold | Below threshold |
|---|---|---|
| `transcribe_audio` | confianca >= 0.85 → use as-is | < 0.85: include warning "Achei essa fala 'X', mas não tenho certeza. Confirma?" |
| `parse_boleto` | per-field >= 0.9 | Below: surface fields with `?` and ask user |
| `parse_receipt` | confianca >= 0.8 | Below: ask user to retype the key fields |

These thresholds are configurable via `agent_facts['threshold.confidence.*']` and can be tuned over time.

### 6.5 Whisper provider selection

Phase 2 uses OpenAI Whisper API (`WHISPER_PROVIDER=openai`, `WHISPER_MODEL=whisper-1`). Other providers (Deepgram, Azure) are out of scope until OpenAI shows reliability issues.

### 6.6 Vision provider selection

Phase 2 uses Claude Vision (Sonnet) for OCR — already authorized via Anthropic key. No separate Vision API.

## 7. LLM Boundaries

The LLM may:

- Trigger `transcribe_audio`, `parse_boleto`, `parse_receipt` (Phase 2 — bundled into `parse_image`).
- Phrase the natural-language summary of the parsed result.
- Ask clarification when confidence is low.

The LLM may not:

- Read raw audio bytes or image pixels. Tools mediate.
- Decide which parser to try; the dispatcher's decision tree is deterministic.
- Override confidence thresholds.

## 8. Failure modes

| Failure | Behavior |
|---|---|
| Whisper API down | Tool returns `kind='execution_failed'`; LLM tells user "Não consegui transcrever; pode mandar em texto?" Audio file kept for retry |
| Vision returns malformed JSON | Retry once with stricter prompt; if still bad, report `'execution_failed'` |
| File hash collision attempted (different content, same sha256) | Effectively impossible with sha256, but defensive check on file size mismatch |
| Audio > 25 min | Refuse with informational message (Whisper API limit) |
| Image too large (> 20 MB) | Compress to 2048px max edge before sending to Vision |

## 9. Acceptance criteria

- [ ] An audio of 30 seconds in pt-BR is transcribed in < 10s p95.
- [ ] A boleto image parsed yields a `linha_digitavel` that passes spec 14 validation in 90% of clean photos.
- [ ] Sending the same audio twice does not double-bill the OpenAI quota (idempotency hit).
- [ ] Confidence < threshold surfaces a confirmation question to the user.
- [ ] Owner command `parse de novo` invalidates the cache and re-runs the parser.

## 10. References

- Spec 04 — gateway media handling
- Spec 06 — agent loop tool dispatch
- Spec 07 — tool contracts (`transcribe_audio`, `parse_boleto`)
- Spec 09 — idempotency key formula
- Spec 14 — Brazilian-domain validation (boleto, PIX)

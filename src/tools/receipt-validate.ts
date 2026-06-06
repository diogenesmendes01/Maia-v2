/**
 * Issue #431 — `receipt_validate` (boleto proposal domain adapter).
 *
 * Validates a payment receipt sent by the customer and normalizes operational
 * signals for refund/payment workflows. This is NOT a new OCR/vision
 * implementation and does NOT call the vision model directly.
 *
 * Reuse boundary (the whole point):
 *   - It DELEGATES to `parse_receipt` (`parseReceiptTool.handler`), which is the
 *     single source of truth for receipt OCR: it reads the
 *     `maia:vision:v3:${tenant}:${agent}:parse_receipt:${sha}` cache, calls
 *     `parseImage()` (`src/lib/vision.ts`) ONLY on a miss, sanitizes the fields,
 *     and writes the cache back — under the `parse_receipt` tool NAME. Because
 *     the vision cache is keyed BY TOOL NAME, delegating through `parse_receipt`
 *     (rather than calling `parseImage` under our own name) means a prior
 *     `parse_receipt` call's cached result is REUSED here (a real hit), and our
 *     parse is reused by a later `parse_receipt` — no second vision call site,
 *     tenant-scoped cache preserved.
 *   - This adapter adds ONLY domain logic on top: authenticity heuristics,
 *     warnings for suspicious/missing fields, and the boleto result shape. It
 *     never approves a refund.
 *
 * FAIL-CLOSED (issue #431): a receipt is `valid: true` ONLY when authenticity is
 * POSITIVE (`plausible`, the highest band the heuristic can assert) AND every
 * essential field (amount, date, recipient identification) is present. Any other
 * case — 'unknown' / 'low_confidence' / 'suspicious' authenticity, or a missing
 * essential field — returns `valid: false` WITH `reasons` explaining the block.
 * A positive verdict is a PRECONDITION the policy layer still gates, never an
 * authorization (this tool never approves a refund).
 *
 * Input sources (the issue allows several; the underlying parser needs a local
 * path + sha):
 *   - `media_local_path + file_sha256` directly, OR
 *   - `conversation_id + attachment_hint` / `attachment_ref` → resolved from the
 *     CURRENT conversation's messages via `mensagensRepo.recentInConversation`
 *     (ALS-scoped). The gateway stores the local path in the `midia_url` column
 *     and the sha in `metadata.media_sha256` (NOT a `file_sha256` column).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseReceiptTool } from './parse-receipt.js';
import { mensagensRepo } from '@/db/repositories.js';

const inputSchema = z
  .object({
    // Direct path — the underlying parser's native inputs.
    media_local_path: z.string().max(1024).optional(),
    file_sha256: z.string().max(128).optional(),
    // Indirect: resolve the attachment from the current conversation's messages.
    // `conversation_id` is accepted for API parity but the read is ALWAYS pinned
    // to the ALS conversation (invariant #1); a divergent id is ignored.
    conversation_id: z.string().max(120).optional(),
    attachment_ref: z.string().max(256).optional(),
    attachment_hint: z.string().max(256).optional(),
  })
  .refine(
    (v) =>
      Boolean(
        (v.media_local_path && v.file_sha256) ||
          v.attachment_ref ||
          v.attachment_hint ||
          v.conversation_id,
      ),
    { message: 'provide media_local_path+file_sha256 or an attachment reference/hint' },
  );

const outputSchema = z.object({
  valid: z.boolean(),
  identified_amount: z.number().optional(),
  identified_date: z.string().optional(),
  payer_signals: z.unknown().optional(),
  recipient_signals: z.unknown().optional(),
  receipt_type: z.string().optional(),
  authenticity: z.enum(['unknown', 'low_confidence', 'plausible', 'suspicious']),
  warnings: z.array(z.string()),
  // FAIL-CLOSED rationale: the specific blockers that kept `valid` false. Empty
  // when (and only when) `valid` is true.
  reasons: z.array(z.string()),
  source_parser: z.enum(['parse_receipt', 'parse_image']),
  parser_confidence: z.number().optional(),
});

type Output = z.infer<typeof outputSchema>;

/** Resolve a local media path + sha from the CURRENT conversation. Picks the
 * most recent media message whose stored fields are present; when a hint is
 * given, prefers a message whose caption/url/sha contains it. ALS-scoped read. */
async function resolveAttachment(
  conversaId: string,
  hint: string | undefined,
): Promise<{ path: string; sha: string } | null> {
  const rows = await mensagensRepo.recentInConversation(conversaId, 50);
  const needle = hint?.toLowerCase();
  let fallback: { path: string; sha: string } | null = null;
  for (const m of rows) {
    const path = m.midia_url;
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const sha = typeof meta.media_sha256 === 'string' ? meta.media_sha256 : null;
    if (!path || !sha) continue;
    const candidate = { path, sha };
    if (fallback === null) fallback = candidate; // newest-first → first usable is newest
    if (!needle) continue;
    const hay = [
      m.conteudo ?? '',
      path,
      sha,
      typeof meta.whatsapp_id === 'string' ? meta.whatsapp_id : '',
    ]
      .join(' ')
      .toLowerCase();
    if (hay.includes(needle)) return candidate;
  }
  return fallback;
}

export const receiptValidateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'receipt_validate',
  description:
    'Valida um comprovante de pagamento enviado pelo cliente e normaliza sinais operacionais (valor, data, beneficiário, autenticidade) para fluxos de pagamento/reembolso. Delega o OCR para parse_receipt (reuso de cache de visão) — não chama o modelo de visão diretamente. FAIL-CLOSED: só é válido com autenticidade positiva e campos essenciais; nunca aprova reembolso.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'receipt_validated',
  handler: async (args, ctx) => {
    const warnings: string[] = [];

    // Resolve the (path, sha) — either directly or from the conversation.
    let path = args.media_local_path;
    let sha = args.file_sha256;
    if (!path || !sha) {
      const resolved = await resolveAttachment(
        ctx.conversa.id,
        args.attachment_hint ?? args.attachment_ref,
      );
      if (!resolved) {
        // No receipt to validate → fail-closed with an explicit reason.
        return {
          valid: false,
          authenticity: 'unknown',
          warnings: ['no_receipt_attachment_found_in_conversation'],
          reasons: ['no_receipt_attachment_found_in_conversation'],
          source_parser: 'parse_receipt',
        };
      }
      path = resolved.path;
      sha = resolved.sha;
    }

    // Delegate to parse_receipt — shared vision cache (keyed by its tool name)
    // + shared sanitization. ctx is forwarded though parse_receipt ignores it.
    const parsed = await parseReceiptTool.handler({ media_local_path: path, file_sha256: sha }, ctx);

    const amount = typeof parsed.valor === 'number' ? parsed.valor : undefined;
    const date = parsed.data;
    const confidence = parsed.confianca;
    const hasRecipient = Boolean(
      parsed.beneficiario_nome || parsed.beneficiario_chave_pix || parsed.beneficiario_documento,
    );

    if (amount === undefined) warnings.push('missing_amount');
    if (!date) warnings.push('missing_or_invalid_date');
    if (!hasRecipient) warnings.push('missing_recipient_identification');

    const authenticity = classifyAuthenticity(confidence, warnings.length);

    // FAIL-CLOSED gate: every blocker that prevents a positive verdict is
    // collected into `reasons`. `valid` is true ONLY when there are none — i.e.
    // authenticity is `plausible` AND amount/date/recipient are all present.
    const reasons: string[] = [];
    if (amount === undefined) reasons.push('missing_amount');
    if (!date) reasons.push('missing_or_invalid_date');
    if (!hasRecipient) reasons.push('missing_recipient_identification');
    if (authenticity !== 'plausible') reasons.push(`authenticity_not_positive:${authenticity}`);

    const valid = reasons.length === 0;

    return {
      valid,
      identified_amount: amount,
      identified_date: date,
      payer_signals: { banco_origem: parsed.banco_origem ?? null },
      recipient_signals: {
        nome: parsed.beneficiario_nome ?? null,
        documento: parsed.beneficiario_documento ?? null,
        chave_pix: parsed.beneficiario_chave_pix ?? null,
        banco_destino: parsed.banco_destino ?? null,
      },
      receipt_type: parsed.tipo,
      authenticity,
      warnings,
      reasons,
      source_parser: 'parse_receipt',
      parser_confidence: confidence,
    };
  },
};

/**
 * Map parser confidence + how many fields were missing to a coarse authenticity
 * band. NEVER returns a positive verdict that an agent could read as "approved"
 * — the highest band is `plausible`, and a zero-confidence/empty parse is
 * `suspicious` so it surfaces for human review rather than silently passing.
 */
function classifyAuthenticity(
  confidence: number,
  warningCount: number,
): Output['authenticity'] {
  if (confidence <= 0) return 'suspicious';
  if (warningCount >= 2) return 'low_confidence';
  if (confidence >= 0.8 && warningCount === 0) return 'plausible';
  if (confidence >= 0.5) return 'low_confidence';
  return 'unknown';
}

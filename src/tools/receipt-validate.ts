/**
 * Issue #416 — `receipt_validate` (boleto proposal vertical, read-only).
 *
 * Analyse a receipt sent by the customer: extract amount/date, payer/recipient
 * signals, and produce a BASIC authenticity validation + warnings.
 *
 * CRITICAL (taxonomy §6, issue #416): this tool MUST NOT introduce a new
 * OCR/vision capability. It REUSES the existing registered parsers
 * `parse_receipt` (`./parse-receipt.ts`) and `parse_image` (`./parse-image.ts`):
 * it delegates extraction to `parseImageTool.handler` (which routes boleto vs
 * receipt) and falls back to `parseReceiptTool.handler` for the receipt branch,
 * then layers a validation verdict on top of their already-sanitised output.
 * The Vision call + per-image cache live entirely in those parsers — this tool
 * adds zero new vision surface (anti-pattern §7).
 *
 * Conservative: side_effect 'read'. The authenticity verdict here is heuristic
 * (presence/consistency of extracted fields) — a real fraud check is out of
 * scope for #416; the warnings make the limitation explicit to the agent.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseImageTool } from './parse-image.js';
import { parseReceiptTool } from './parse-receipt.js';

const inputSchema = z.object({
  // The receipt to validate. We require the same (path, sha256) the existing
  // parsers consume so we can delegate to them without a new ingestion path.
  media_local_path: z.string().min(1),
  file_sha256: z.string().min(1),
  // Optional: how the attachment arrived (image vs pdf vs an already-resolved
  // attachment reference). Informational — extraction is delegated regardless.
  attachment_kind: z.enum(['image', 'pdf', 'attachment_ref']).optional(),
});

const outputSchema = z.object({
  // Heuristic authenticity verdict over the extracted, sanitised fields.
  valid: z.boolean(),
  amount: z.number().optional(),
  date: z.string().optional(),
  payer_signal: z.string().optional(),
  recipient_signal: z.string().optional(),
  // The parser confidence carried through (0..1) so the agent can gate on it.
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).default([]),
});

type Output = z.infer<typeof outputSchema>;

export const receiptValidateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'receipt_validate',
  description:
    'Analisa um comprovante enviado pelo cliente (valor, data, pagador/recebedor) e faz validação básica de autenticidade. REUTILIZA os parsers parse_receipt/parse_image — não é um novo OCR. Apenas leitura.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'receipt_validated',
  handler: async (args, ctx) => {
    const parserInput = {
      media_local_path: args.media_local_path,
      file_sha256: args.file_sha256,
    };

    // Delegate extraction to the existing registered parsers (NO new vision
    // tool). `parse_image` routes boleto-vs-receipt; for a receipt-typed image
    // it already returns the receipt fields, so we prefer it and fall back to
    // `parse_receipt` when the routed kind is not a receipt.
    const routed = await parseImageTool.handler(parserInput, ctx);

    let amount: number | undefined;
    let date: string | undefined;
    let payer_signal: string | undefined;
    let recipient_signal: string | undefined;
    let confidence = routed.confianca;
    const warnings: string[] = [];

    if (routed.kind === 'receipt' && routed.receipt) {
      amount = routed.receipt.valor;
      date = routed.receipt.data;
      recipient_signal = routed.receipt.beneficiario_nome ?? routed.receipt.beneficiario_chave_pix;
      payer_signal = routed.receipt.banco_origem;
    } else {
      // Not routed as a receipt (boleto/unknown) — ask the dedicated receipt
      // parser directly before giving up, reusing the same registered tool.
      const receipt = await parseReceiptTool.handler(parserInput, ctx);
      amount = receipt.valor;
      date = receipt.data;
      recipient_signal = receipt.beneficiario_nome ?? receipt.beneficiario_chave_pix;
      payer_signal = receipt.banco_origem;
      confidence = receipt.confianca;
      if (routed.kind === 'boleto') {
        warnings.push('attachment_parsed_as_boleto_not_receipt');
      }
    }

    if (amount === undefined) warnings.push('amount_not_identified');
    if (date === undefined) warnings.push('date_not_identified');

    // Basic, conservative authenticity heuristic: an amount AND a recipient
    // signal at a usable confidence. A real fraud/authenticity check is out of
    // scope for #416 — the warnings keep that limitation explicit.
    const valid = amount !== undefined && Boolean(recipient_signal) && confidence >= 0.6;
    if (!valid) warnings.push('authenticity_unverified');

    const out: Output = {
      valid,
      amount,
      date,
      payer_signal,
      recipient_signal,
      confidence,
      warnings,
    };
    return out;
  },
};

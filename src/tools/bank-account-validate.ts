/**
 * Issue #431 — `bank_account_validate` (boleto proposal domain adapter).
 *
 * Validates whether REFUND banking data is complete and internally consistent.
 * LOCAL / structural validation ONLY — no external bank integration, executes
 * nothing, no side effects.
 *
 * Reuse boundary (issue anti-duplication): CPF/CNPJ is validated by the SHARED
 * `classifyDocument` / `detectPixKey` from `@/lib/brazilian.ts` (the SAME
 * CHECKSUM validators the parsers and PIX-key detector use) — NOT a private
 * length-only check. A right-length but bad-check-digit document is rejected.
 *
 * Schema reality (verified): `contrapartes` banking is ONLY `chave_pix` +
 * `banco_padrao` — the counterparty's own destination accounts (agency /
 * account / holder) are NOT stored (`contas_bancarias` are the ENTITY's own
 * accounts, not the counterparty's). So there is nothing in `contrapartes` to
 * cross-check a refund account against; this tool validates the SUPPLIED data
 * locally: required fields for PIX vs bank transfer (SEPARATELY), CPF/CNPJ
 * checksum, and marks inconsistencies as `warnings`.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { classifyDocument, detectPixKey } from '@/lib/brazilian.js';

const PIX_KEY_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'evp', 'unknown'] as const;

const inputSchema = z
  .object({
    method: z.enum(['pix', 'bank_transfer']),
    // PIX fields.
    pix_key: z.string().max(140).optional(),
    pix_key_type: z.enum(PIX_KEY_TYPES).optional(),
    // Bank-transfer fields.
    bank_code: z.string().max(10).optional(),
    bank_name: z.string().max(140).optional(),
    agency: z.string().max(20).optional(),
    account_number: z.string().max(30).optional(),
    account_type: z.string().max(30).optional(),
    holder_name: z.string().max(200).optional(),
    holder_document: z.string().max(40).optional(),
  })
  .strip();

const outputSchema = z.object({
  valid: z.boolean(),
  method: z.enum(['pix', 'bank_transfer']),
  missing_fields: z.array(z.string()),
  warnings: z.array(z.string()),
  normalized: z
    .object({
      holder_document_digits: z.string().optional(),
      inferred_document_type: z.enum(['cpf', 'cnpj', 'unknown']).optional(),
      detected_pix_key_type: z.enum(PIX_KEY_TYPES).optional(),
    })
    .optional(),
});

type Output = z.infer<typeof outputSchema>;

/**
 * Reuse the shared Brazilian document validator (CPF/CNPJ CHECKSUM, not just
 * length) from `@/lib/brazilian.ts`. Distinguishes a wrong-length document from
 * a right-length-but-failed-check-digit one so the warning is actionable.
 */
function inferDocumentType(raw: string): {
  type: 'cpf' | 'cnpj' | 'unknown';
  warning?: string;
} {
  const digits = raw.replace(/\D/g, '');
  const classified = classifyDocument(raw);
  if (classified.kind === 'cpf') return { type: 'cpf' };
  if (classified.kind === 'cnpj') return { type: 'cnpj' };
  if (digits.length !== 11 && digits.length !== 14) {
    return { type: 'unknown', warning: 'holder_document_invalid_length' };
  }
  return { type: 'unknown', warning: 'holder_document_failed_checksum' };
}

/**
 * Best-effort PIX-key-type detection reusing the shared `detectPixKey` (which
 * itself reuses `classifyDocument`). Maps its `random` UUID kind to the `evp`
 * vocabulary this contract exposes; an undetectable key is `unknown`.
 */
function detectPixKeyType(key: string): (typeof PIX_KEY_TYPES)[number] {
  const detected = detectPixKey(key);
  if (!detected) return 'unknown';
  if (detected.kind === 'random') return 'evp';
  return detected.kind; // 'cpf' | 'cnpj' | 'email' | 'phone'
}

export const bankAccountValidateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'bank_account_validate',
  description:
    'Valida localmente se os dados bancários de reembolso estão completos e consistentes (campos obrigatórios para PIX vs transferência, checksum de CPF/CNPJ via lib compartilhada). Apenas validação estrutural — sem integração bancária externa e sem executar nada.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'bank_account_validated',
  handler: async (args) => {
    const missing: string[] = [];
    const warnings: string[] = [];
    const normalized: NonNullable<Output['normalized']> = {};

    if (args.holder_document) {
      const digits = args.holder_document.replace(/\D/g, '');
      normalized.holder_document_digits = digits;
      const { type, warning } = inferDocumentType(args.holder_document);
      normalized.inferred_document_type = type;
      if (warning) warnings.push(warning);
    }

    if (args.method === 'pix') {
      if (!args.pix_key || args.pix_key.trim().length === 0) {
        missing.push('pix_key');
      } else {
        const detected = detectPixKeyType(args.pix_key);
        normalized.detected_pix_key_type = detected;
        if (
          args.pix_key_type &&
          args.pix_key_type !== 'unknown' &&
          detected !== 'unknown' &&
          detected !== args.pix_key_type
        ) {
          warnings.push('pix_key_type_mismatch');
        }
        if (detected === 'unknown' && (!args.pix_key_type || args.pix_key_type === 'unknown')) {
          warnings.push('pix_key_type_undetermined');
        }
      }
    } else {
      // bank_transfer: required structural fields.
      if (!args.bank_code && !args.bank_name) missing.push('bank_code_or_bank_name');
      if (!args.agency) missing.push('agency');
      if (!args.account_number) missing.push('account_number');
      if (!args.holder_name) missing.push('holder_name');
      if (!args.holder_document) missing.push('holder_document');

      if (args.agency && !/^\d{1,5}(-?\d)?$/.test(args.agency.trim())) {
        warnings.push('agency_format_suspicious');
      }
      if (args.account_number && !/^\d{1,12}(-?[\dxX])?$/.test(args.account_number.trim())) {
        warnings.push('account_number_format_suspicious');
      }
      if (args.bank_code && !/^\d{3}$/.test(args.bank_code.trim())) {
        warnings.push('bank_code_not_three_digits');
      }
    }

    const valid = missing.length === 0 && warnings.length === 0;
    return {
      valid,
      method: args.method,
      missing_fields: missing,
      warnings,
      ...(Object.keys(normalized).length > 0 ? { normalized } : {}),
    };
  },
};

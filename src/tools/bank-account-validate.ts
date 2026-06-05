/**
 * Issue #431 — `bank_account_validate` (boleto proposal domain adapter).
 *
 * Validates whether REFUND banking data is complete and internally consistent.
 * LOCAL / structural validation ONLY — no external bank integration, executes
 * nothing.
 *
 * Schema reality (verified): `contrapartes` banking is ONLY `chave_pix` +
 * `banco_padrao` — the counterparty's own destination accounts (agency /
 * account / holder) are NOT stored (`contas_bancarias` are the ENTITY's own
 * accounts, not the counterparty's). So there is nothing in `contrapartes` to
 * cross-check a refund account against; this tool validates the SUPPLIED data
 * locally: required fields for PIX vs bank transfer (separately), basic CPF/CNPJ
 * shape, and marks inconsistencies as `warnings`.
 *
 * side_effect: 'none', operation_type: 'parse_only' — pure structural check.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

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

/** CPF = 11 digits, CNPJ = 14 digits. Shape-only (NOT a checksum / Receita
 * lookup) — the issue scopes this to structural validation. */
function inferDocumentType(digits: string): 'cpf' | 'cnpj' | 'unknown' {
  if (digits.length === 11) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  return 'unknown';
}

/** Best-effort PIX-key-type detection from the raw key (used to flag a mismatch
 * with a caller-declared `pix_key_type`, not to reject). */
function detectPixKeyType(key: string): (typeof PIX_KEY_TYPES)[number] {
  const k = key.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k)) return 'email';
  const digits = k.replace(/\D/g, '');
  if (/^\+?\d{12,13}$/.test(k.replace(/\s/g, '')) || (digits.length >= 12 && digits.length <= 13 && /^\+?55/.test(digits)))
    return 'phone';
  if (digits.length === 11 && !k.includes('+')) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  if (/^[0-9a-fA-F-]{32,36}$/.test(k)) return 'evp';
  return 'unknown';
}

export const bankAccountValidateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'bank_account_validate',
  description:
    'Valida localmente se os dados bancários de reembolso estão completos e consistentes (campos obrigatórios para PIX vs transferência, formato de CPF/CNPJ). Apenas validação estrutural — sem integração bancária externa e sem executar nada.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'bank_account_validated',
  handler: async (args) => {
    const missing: string[] = [];
    const warnings: string[] = [];
    const normalized: NonNullable<Output['normalized']> = {};

    if (args.holder_document) {
      const digits = args.holder_document.replace(/\D/g, '');
      normalized.holder_document_digits = digits;
      const docType = inferDocumentType(digits);
      normalized.inferred_document_type = docType;
      if (docType === 'unknown') {
        warnings.push('holder_document_invalid_length');
      }
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

/**
 * Issue #416 — `bank_account_validate` (boleto proposal vertical, read-only).
 *
 * Check whether refund banking data is complete and consistent (PIX key, bank,
 * branch/agência, account, account type, holder name + optional document).
 * Returns valid/invalid, missing fields, consistency warnings, and a normalised
 * payment-data view when possible.
 *
 * Conservative: side_effect 'read' — it validates/normalises input data; it does
 * NOT persist anything (that is `refund_create`). Out of scope (#416): a real
 * bank-data verification service — the consistency check is structural only.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  pix_key: z.string().max(140).optional(),
  bank: z.string().max(120).optional(),
  branch: z.string().max(20).optional(),
  account: z.string().max(30).optional(),
  account_type: z.enum(['corrente', 'poupanca', 'pagamento']).optional(),
  holder_name: z.string().max(200).optional(),
  holder_document: z.string().max(20).optional(),
});

const outputSchema = z.object({
  valid: z.boolean(),
  missing_fields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  normalized: z
    .object({
      method: z.enum(['pix', 'bank_transfer']).optional(),
      pix_key: z.string().optional(),
      bank: z.string().optional(),
      branch: z.string().optional(),
      account: z.string().optional(),
      account_type: z.string().optional(),
      holder_name: z.string().optional(),
      holder_document: z.string().optional(),
    })
    .optional(),
});

type Output = z.infer<typeof outputSchema>;

export const bankAccountValidateTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'bank_account_validate',
  description:
    'Verifica se os dados bancários para reembolso estão completos e consistentes (PIX ou banco/agência/conta + titular). Retorna valid/invalid, campos faltantes, alertas e dados normalizados. Apenas leitura — não persiste nada.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'bank_account_validated',
  handler: async (args) => {
    const missing_fields: string[] = [];
    const warnings: string[] = [];

    // Two acceptable shapes: a PIX key, OR a full bank/branch/account triple.
    const hasPix = Boolean(args.pix_key);
    const hasBankTriple = Boolean(args.bank && args.branch && args.account);

    if (!hasPix && !hasBankTriple) {
      if (!args.pix_key) missing_fields.push('pix_key_or_bank_account');
      if (!args.bank) missing_fields.push('bank');
      if (!args.branch) missing_fields.push('branch');
      if (!args.account) missing_fields.push('account');
    }
    if (!args.holder_name) missing_fields.push('holder_name');
    if (hasBankTriple && !args.account_type) warnings.push('account_type_unspecified');
    if (hasPix && hasBankTriple) warnings.push('both_pix_and_bank_provided');

    const valid = missing_fields.length === 0;
    const method = hasPix ? ('pix' as const) : hasBankTriple ? ('bank_transfer' as const) : undefined;

    const out: Output = {
      valid,
      missing_fields,
      warnings,
      normalized: valid
        ? {
            method,
            pix_key: args.pix_key,
            bank: args.bank,
            branch: args.branch,
            account: args.account,
            account_type: args.account_type,
            holder_name: args.holder_name,
            holder_document: args.holder_document,
          }
        : undefined,
    };
    return out;
  },
};

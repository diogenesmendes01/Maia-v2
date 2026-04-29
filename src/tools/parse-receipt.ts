import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseImage } from '@/lib/vision.js';

const inputSchema = z.object({
  media_local_path: z.string().min(1),
  file_sha256: z.string().min(1),
});

const outputSchema = z.object({
  tipo: z.enum(['pix', 'ted', 'doc', 'transferencia_propria', 'outro']).optional(),
  valor: z.number().optional(),
  data: z.string().optional(),
  beneficiario_nome: z.string().optional(),
  beneficiario_documento: z.string().optional(),
  beneficiario_chave_pix: z.string().optional(),
  banco_origem: z.string().optional(),
  banco_destino: z.string().optional(),
  endToEndId: z.string().optional(),
  confianca: z.number().min(0).max(1),
});

/**
 * Spec 10 §5.3 — extracts structured fields from a PIX/TED/DOC receipt
 * via Claude Vision. Idempotency keyed on file_sha256 → same image yields
 * cached parse with no extra API cost.
 */
export const parseReceiptTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'parse_receipt',
  description:
    'Extrai dados estruturados de uma imagem de comprovante (PIX, TED, DOC, etc.): tipo, valor, beneficiário, chave PIX, endToEndId.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'boleto_parsed',
  handler: async (args) => {
    const result = await parseImage({ path: args.media_local_path, kind: 'receipt' });
    if (!result) return { confianca: 0 };
    return {
      tipo: result.tipo,
      valor: result.valor,
      data: result.data,
      beneficiario_nome: result.beneficiario_nome,
      beneficiario_documento: result.beneficiario_documento,
      beneficiario_chave_pix: result.beneficiario_chave_pix,
      banco_origem: result.banco_origem,
      banco_destino: result.banco_destino,
      endToEndId: result.endToEndId,
      confianca: result.valor && result.beneficiario_nome ? 0.85 : 0.5,
    };
  },
};

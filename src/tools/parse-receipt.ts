import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseImage } from '@/lib/vision.js';
import { getCachedVision, setCachedVision } from './_vision-cache.js';

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

type Output = z.infer<typeof outputSchema>;

/**
 * Spec 10 §5.3 — extracts structured fields from a PIX/TED/DOC receipt via
 * Claude Vision. Idempotency: the dispatcher keys on
 * (pessoa_id, entity_id, file_sha256); on top of that, this handler caches
 * the Vision parse keyed on file_sha256 alone so the same image uploaded
 * by different pessoas doesn't pay the Vision API cost twice.
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
  audit_action: 'receipt_parsed',
  handler: async (args) => {
    const cached = await getCachedVision<Output>('parse_receipt', args.file_sha256);
    if (cached) return cached;

    const result = await parseImage({ path: args.media_local_path, kind: 'receipt' });
    if (!result) {
      const empty: Output = { confianca: 0 };
      await setCachedVision('parse_receipt', args.file_sha256, empty);
      return empty;
    }
    const out: Output = {
      tipo: result.tipo,
      valor: result.valor,
      data: result.data,
      beneficiario_nome: result.beneficiario_nome,
      beneficiario_documento: result.beneficiario_documento,
      beneficiario_chave_pix: result.beneficiario_chave_pix,
      banco_origem: result.banco_origem,
      banco_destino: result.banco_destino,
      endToEndId: result.endToEndId,
      confianca: result.valor && result.beneficiario_nome ? 0.85 : 0.6,
    };
    await setCachedVision('parse_receipt', args.file_sha256, out);
    return out;
  },
};

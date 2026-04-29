import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseImage as visionParse } from '@/lib/vision.js';
import { isValidLinhaDigitavel, parseLinhaDigitavel, BANCOS_CODIGO } from '@/lib/brazilian.js';
import { logger } from '@/lib/logger.js';

const inputSchema = z.object({
  media_local_path: z.string().min(1),
  file_sha256: z.string().min(1),
});

const outputSchema = z.object({
  kind: z.enum(['boleto', 'receipt', 'unknown']),
  boleto: z
    .object({
      linha_digitavel: z.string().optional(),
      codigo_barras: z.string().optional(),
      valor: z.number().optional(),
      vencimento: z.string().optional(),
      beneficiario_nome: z.string().optional(),
      beneficiario_cnpj_cpf: z.string().optional(),
      banco_emissor_codigo: z.string().optional(),
      banco_emissor_nome: z.string().optional(),
    })
    .optional(),
  receipt: z
    .object({
      tipo: z.enum(['pix', 'ted', 'doc', 'transferencia_propria', 'outro']).optional(),
      valor: z.number().optional(),
      data: z.string().optional(),
      beneficiario_nome: z.string().optional(),
      beneficiario_documento: z.string().optional(),
      beneficiario_chave_pix: z.string().optional(),
      endToEndId: z.string().optional(),
    })
    .optional(),
  confianca: z.number().min(0).max(1),
});

/**
 * Spec 10 §4.3 — deterministic decision tree for inbound image attachments.
 * Tries boleto first (47-digit linha digitável is highly distinctive); falls
 * back to receipt parsing if confidence is below the boleto threshold. The
 * LLM does NOT pick the parser — that's a backend concern per spec 10 §7.
 */
export const parseImageTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'parse_image',
  description:
    'Identifica o tipo da imagem (boleto vs comprovante PIX/TED) e extrai os campos. Use quando o usuário envia uma foto e você não tem certeza do tipo.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'boleto_parsed',
  handler: async (args) => {
    const boletoRaw = await visionParse({ path: args.media_local_path, kind: 'boleto' }).catch(
      () => null,
    );
    if (boletoRaw) {
      const linha = (boletoRaw.linha_digitavel ?? '').replace(/\D/g, '');
      if (linha.length === 47 && isValidLinhaDigitavel(linha)) {
        const parsed = parseLinhaDigitavel(linha);
        return {
          kind: 'boleto' as const,
          boleto: {
            linha_digitavel: linha,
            codigo_barras: parsed?.codigo_barras,
            valor: parsed?.valor ?? boletoRaw.valor,
            vencimento: parsed?.vencimento_data ?? boletoRaw.vencimento,
            beneficiario_nome: boletoRaw.beneficiario_nome,
            beneficiario_cnpj_cpf: boletoRaw.beneficiario_cnpj_cpf,
            banco_emissor_codigo: parsed?.banco_codigo,
            banco_emissor_nome: parsed?.banco_codigo
              ? BANCOS_CODIGO[parsed.banco_codigo]
              : undefined,
          },
          confianca: 0.9,
        };
      }
    }

    const receiptRaw = await visionParse({
      path: args.media_local_path,
      kind: 'receipt',
    }).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'parse_image.receipt_failed');
      return null;
    });
    if (receiptRaw && (receiptRaw.valor || receiptRaw.beneficiario_nome)) {
      return {
        kind: 'receipt' as const,
        receipt: {
          tipo: receiptRaw.tipo,
          valor: receiptRaw.valor,
          data: receiptRaw.data,
          beneficiario_nome: receiptRaw.beneficiario_nome,
          beneficiario_documento: receiptRaw.beneficiario_documento,
          beneficiario_chave_pix: receiptRaw.beneficiario_chave_pix,
          endToEndId: receiptRaw.endToEndId,
        },
        confianca: receiptRaw.valor && receiptRaw.beneficiario_nome ? 0.85 : 0.6,
      };
    }

    return { kind: 'unknown' as const, confianca: 0 };
  },
};

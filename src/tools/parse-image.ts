import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseImage as visionParse } from '@/lib/vision.js';
import { isValidLinhaDigitavel, parseLinhaDigitavel, BANCOS_CODIGO } from '@/lib/brazilian.js';
import { logger } from '@/lib/logger.js';
import { getCachedVision, setCachedVision } from './_vision-cache.js';
import { wrapWithTag, validateOrDrop, OCR_REGEXES } from '@/agent/sanitize.js';

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
      banco_origem: z.string().optional(),
      banco_destino: z.string().optional(),
      endToEndId: z.string().optional(),
    })
    .optional(),
  confianca: z.number().min(0).max(1),
});

type Output = z.infer<typeof outputSchema>;

/**
 * Spec 10 §4.3 — deterministic decision tree for inbound image attachments.
 * Tries boleto first (47-digit linha digitável is highly distinctive); falls
 * back to receipt parsing if confidence is below the boleto threshold. The
 * LLM does NOT pick the parser — that's a backend concern per spec 10 §7.
 *
 * Idempotency: caches the final routed result keyed on file_sha256. Two
 * pessoas uploading the same image avoid the 1–2 Vision calls per attempt.
 *
 * Sanitization strategy (PR #38 review #3189933385):
 * Both boleto and receipt branches apply the same strategy:
 *   - Free-text fields (nome, banco_origem, etc.): wrap with <ocr>
 *   - Structured fields (documento, código_barras, endToEndId, etc.): validate via regex, drop if invalid
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
  audit_action: 'image_parsed',
  handler: async (args) => {
    const cached = await getCachedVision<Output>('parse_image', args.file_sha256);
    if (cached) return cached;

    const boletoRaw = await visionParse({ path: args.media_local_path, kind: 'boleto' }).catch(
      () => null,
    );
    if (boletoRaw) {
      const linha = (boletoRaw.linha_digitavel ?? '').replace(/\D/g, '');
      if (linha.length === 47 && isValidLinhaDigitavel(linha)) {
        const parsed = parseLinhaDigitavel(linha);
        const out: Output = {
          kind: 'boleto',
          boleto: {
            linha_digitavel: linha,
            codigo_barras: validateOrDrop(parsed?.codigo_barras, OCR_REGEXES.codigo_barras),
            valor: parsed?.valor ?? boletoRaw.valor,
            vencimento: validateOrDrop(
              parsed?.vencimento_data ?? boletoRaw.vencimento,
              OCR_REGEXES.data,
            ),
            beneficiario_nome: boletoRaw.beneficiario_nome
              ? wrapWithTag(boletoRaw.beneficiario_nome, 'ocr')
              : undefined,
            beneficiario_cnpj_cpf: validateOrDrop(
              boletoRaw.beneficiario_cnpj_cpf,
              OCR_REGEXES.cpf_or_cnpj,
            ),
            banco_emissor_codigo: validateOrDrop(parsed?.banco_codigo, OCR_REGEXES.banco_codigo),
            banco_emissor_nome: parsed?.banco_codigo
              ? BANCOS_CODIGO[parsed.banco_codigo]
              : undefined,
          },
          confianca: 0.9,
        };
        await setCachedVision('parse_image', args.file_sha256, out);
        return out;
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
      const out: Output = {
        kind: 'receipt',
        receipt: {
          tipo: receiptRaw.tipo,
          valor: receiptRaw.valor,
          data: validateOrDrop(receiptRaw.data, OCR_REGEXES.data),
          beneficiario_nome: receiptRaw.beneficiario_nome
            ? wrapWithTag(receiptRaw.beneficiario_nome, 'ocr')
            : undefined,
          beneficiario_documento: validateOrDrop(
            receiptRaw.beneficiario_documento,
            OCR_REGEXES.cpf_or_cnpj,
          ),
          beneficiario_chave_pix: receiptRaw.beneficiario_chave_pix
            ? wrapWithTag(receiptRaw.beneficiario_chave_pix, 'ocr')
            : undefined,
          banco_origem: receiptRaw.banco_origem
            ? wrapWithTag(receiptRaw.banco_origem, 'ocr')
            : undefined,
          banco_destino: receiptRaw.banco_destino
            ? wrapWithTag(receiptRaw.banco_destino, 'ocr')
            : undefined,
          endToEndId: validateOrDrop(receiptRaw.endToEndId, OCR_REGEXES.end_to_end_id),
        },
        confianca: receiptRaw.valor && receiptRaw.beneficiario_nome ? 0.85 : 0.6,
      };
      await setCachedVision('parse_image', args.file_sha256, out);
      return out;
    }

    const unknown: Output = { kind: 'unknown', confianca: 0 };
    await setCachedVision('parse_image', args.file_sha256, unknown);
    return unknown;
  },
};

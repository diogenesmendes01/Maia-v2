import { z } from 'zod';
import type { Tool } from './_registry.js';
import { parseLinhaDigitavel, isValidLinhaDigitavel, BANCOS_CODIGO } from '@/lib/brazilian.js';
import { parseImage } from '@/lib/vision.js';

const inputSchema = z.object({
  media_local_path: z.string().min(1),
  file_sha256: z.string().min(1),
});

const outputSchema = z.object({
  linha_digitavel: z.string().optional(),
  codigo_barras: z.string().optional(),
  valor: z.number().optional(),
  vencimento: z.string().optional(),
  beneficiario_nome: z.string().optional(),
  beneficiario_cnpj_cpf: z.string().optional(),
  banco_emissor_codigo: z.string().optional(),
  banco_emissor_nome: z.string().optional(),
  confianca: z.number().min(0).max(1),
});

export const parseBoletoTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'parse_boleto',
  description:
    'Extrai dados estruturados de uma imagem de boleto: linha digitável, valor, vencimento, beneficiário, banco emissor.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'boleto_parsed',
  handler: async (args) => {
    const result = await parseImage({
      path: args.media_local_path,
      kind: 'boleto',
    });
    if (!result) return { confianca: 0 };

    const linha = (result.linha_digitavel ?? '').replace(/\D/g, '');
    const linhaValid = linha.length === 47 && isValidLinhaDigitavel(linha);
    const parsed = linhaValid ? parseLinhaDigitavel(linha) : null;
    return {
      linha_digitavel: linhaValid ? linha : undefined,
      codigo_barras: parsed?.codigo_barras,
      valor: parsed?.valor ?? result.valor,
      vencimento: parsed?.vencimento_data ?? result.vencimento,
      beneficiario_nome: result.beneficiario_nome,
      beneficiario_cnpj_cpf: result.beneficiario_cnpj_cpf,
      banco_emissor_codigo: parsed?.banco_codigo,
      banco_emissor_nome: parsed?.banco_codigo ? BANCOS_CODIGO[parsed.banco_codigo] : undefined,
      confianca: linhaValid ? 0.9 : 0.5,
    };
  },
};

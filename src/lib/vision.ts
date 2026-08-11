import { logger } from '@/lib/logger.js';
import { executeLLM } from '@/lib/llm/index.js';
import type { LLMImageMediaType } from '@/lib/llm/index.js';

export type BoletoFields = {
  linha_digitavel?: string;
  valor?: number;
  vencimento?: string;
  beneficiario_nome?: string;
  beneficiario_cnpj_cpf?: string;
};

export type ReceiptFields = {
  tipo: 'pix' | 'ted' | 'doc' | 'transferencia_propria' | 'outro';
  valor?: number;
  data?: string;
  beneficiario_nome?: string;
  beneficiario_documento?: string;
  beneficiario_chave_pix?: string;
  endToEndId?: string;
  banco_origem?: string;
  banco_destino?: string;
};

const BOLETO_PROMPT = `Esta imagem é um boleto bancário brasileiro. Extraia os campos abaixo em JSON estrito.
Campos: linha_digitavel (47 dígitos sem pontuação), valor (number), vencimento (YYYY-MM-DD),
beneficiario_nome, beneficiario_cnpj_cpf (apenas dígitos).
Se algum campo não estiver legível, omita-o. Retorne APENAS o JSON, sem texto adicional.`;

const RECEIPT_PROMPT = `Esta imagem é um comprovante de transação bancária brasileira (PIX, TED, DOC, ou outro).
Extraia em JSON estrito: tipo (pix|ted|doc|transferencia_propria|outro), valor (number), data (YYYY-MM-DD),
beneficiario_nome, beneficiario_documento (CPF/CNPJ apenas dígitos), beneficiario_chave_pix,
endToEndId (formato Banco Central E + 32 chars), banco_origem, banco_destino.
Se algum campo não estiver legível, omita-o. Retorne APENAS o JSON.`;

/**
 * P0 audit chapter 4: takes the ALREADY-VALIDATED bytes + SNIFFED mime from
 * `readValidatedMedia` (src/lib/media-guard.ts). This module no longer reads
 * the filesystem, and the media type is never derived from a file extension.
 */
export async function parseImage(input: {
  buf: Buffer;
  mime: string;
  kind: 'boleto' | 'receipt';
}): Promise<(BoletoFields & ReceiptFields) | null> {
  // media-guard's 'image' kind only yields the sniffed types below.
  const mime = input.mime as LLMImageMediaType;
  const data = input.buf.toString('base64');

  const prompt = input.kind === 'boleto' ? BOLETO_PROMPT : RECEIPT_PROMPT;
  const t0 = Date.now();
  let text: string;
  try {
    // Issue #508: visão passa pela MESMA fronteira do chat. O bloco de imagem
    // é provider-neutral — o adapter OpenRouter converte para `image_url` com
    // data URI, então trocar de provider não exige mexer aqui. O modelo vem do
    // tier `vision`, resolvido pelo backend.
    const res = await executeLLM({
      workload: 'vision',
      system: '',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    text = res.content ?? '';
  } catch (err) {
    // A mensagem já vem redigida pelo gateway (sem chave, sem prompt).
    logger.warn({ err: (err as Error).message }, 'vision.failed');
    return null;
  }
  logger.debug({ ms: Date.now() - t0, kind: input.kind }, 'vision.done');

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as BoletoFields & ReceiptFields;
  } catch {
    return null;
  }
}

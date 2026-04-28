import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

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

export async function parseImage(input: { path: string; kind: 'boleto' | 'receipt' }): Promise<
  (BoletoFields & ReceiptFields) | null
> {
  const buf = await readFile(input.path);
  const ext = input.path.split('.').pop()?.toLowerCase() ?? 'jpeg';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const data = buf.toString('base64');

  const prompt = input.kind === 'boleto' ? BOLETO_PROMPT : RECEIPT_PROMPT;
  const t0 = Date.now();
  let text = '';
  try {
    const res = await anthropic.messages.create({
      model: config.CLAUDE_MODEL_FAST,
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
    for (const b of res.content) if (b.type === 'text') text += b.text;
  } catch (err) {
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

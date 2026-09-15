/**
 * P00.3 (spec §4.1 “Compatibilidade de contexto”) — NORMALIZADOR DE CONTEXTO.
 *
 * `EngineRequestV1.context.messages` usa o DTO da Maia (`LLMMessage`, dialeto de
 * blocos do Anthropic). O adaptador não pode entregá-lo cru ao motor: o piloto
 * envia **histórico conversacional textual canônico** (user/assistant) mais o
 * `user_message` atual, uma única vez.
 *
 * ─── As três regras, e o que cada uma impede ────────────────────────────────
 *
 * **1. O inbound é separado por POSIÇÃO, não por texto.** Quem já removeu a
 * cópia do inbound do histórico foi o `prompt-builder` (`if (m.id ===
 * ctx.inbound.id) continue`), por ID canônico, e o reanexou uma vez no fim.
 * Aqui a última mensagem É o inbound, por construção — e o contrato exige que
 * ela seja `role:'user'`. Procurar o inbound comparando texto seria o erro que
 * a spec proíbe: um cliente que manda “oi” duas vezes faria a heurística
 * remover a ocorrência errada do histórico.
 *
 * **2. Formato não suportado RECUSA.** `tool_use`/`tool_result` de turnos
 * anteriores não atravessam: seus IDs pertencem ao loop antigo da Maia e não
 * existem no motor de destino; reconstruir pares “equivalentes” seria inventar
 * correlação. Imagem também não: o piloto é textual, e o pipeline de ingestão
 * multimodal continua na Maia. O rastro de ferramentas de turnos passados já
 * chega ao modelo por outro caminho — o bloco “Eventos confirmados pelo
 * backend”, que o `prompt-builder` renderiza dentro do `system`.
 *
 * **3. Estouro de limite RECUSA, não trunca.** “Coorte só entra se o prompt
 * real couber” (§5.3.4). Cortar histórico em silêncio muda o que o modelo vê
 * sem que ninguém tenha decidido isso, e some com a evidência de que mudou.
 *
 * O envelope `<user_message>…</user_message>` do prompt-builder é preservado
 * VERBATIM: ele é resultado de `sanitizeBlock`, e desfazê-lo aqui devolveria ao
 * texto do cliente a chance de se parecer com instrução do sistema.
 */
import type { LLMMessage, LLMContentBlock } from '@/lib/llm/types.js';

/** Limites desta V1 (§5.3.4). Recusa determinística; nunca truncamento. */
export const HISTORY_LIMITS = {
  /** Mensagens de histórico (sem contar o inbound). */
  max_history_messages: 400,
  /** Soma de caracteres do histórico. */
  max_total_chars: 262_144,
  /** Teto por mensagem, `system` e `user_message`. */
  max_message_chars: 262_144,
} as const;

export type EngineHistoryItemV1 = { role: 'user' | 'assistant'; text: string };

export type EngineContextV1 = {
  system: string;
  user_message: string;
  history: EngineHistoryItemV1[];
};

export type NormalizeRejectionCode =
  | 'empty_messages'
  | 'last_not_user'
  | 'unsupported_block'
  | 'empty_user_message'
  | 'empty_system'
  | 'history_too_long'
  | 'history_too_large'
  | 'user_message_too_large'
  | 'system_too_large';

export type NormalizeResult =
  | { kind: 'ok'; context: EngineContextV1 }
  | { kind: 'rejected'; code: NormalizeRejectionCode; detail: string };

const reject = (code: NormalizeRejectionCode, detail: string): NormalizeResult => ({
  kind: 'rejected',
  code,
  detail,
});

/**
 * Texto de uma mensagem, ou a recusa do formato.
 *
 * Blocos SÓ de texto são aceitos e juntados com `\n` — a mesma regra que o
 * adapter OpenAI da Maia já aplica ao texto do assistente. Qualquer outro tipo
 * de bloco recusa a normalização inteira.
 */
function extractText(
  content: LLMMessage['content'],
): { ok: true; text: string } | { ok: false; blockType: string } {
  if (typeof content === 'string') return { ok: true, text: content };
  const partes: string[] = [];
  for (const bloco of content as LLMContentBlock[]) {
    if (bloco && typeof bloco === 'object' && bloco.type === 'text') {
      partes.push(bloco.text);
      continue;
    }
    const tipo =
      bloco && typeof bloco === 'object' && typeof bloco.type === 'string'
        ? bloco.type
        : 'desconhecido';
    return { ok: false, blockType: tipo };
  }
  return { ok: true, text: partes.join('\n') };
}

/**
 * Projeta o prompt da Maia no contexto que o `start` do protocolo carrega.
 *
 * Recebe exatamente o que `buildPrompt` devolve. Não lê banco, não chama
 * modelo, não conhece tenant: é uma função pura de projeção — o que permite
 * exercitá-la inteira em teste unitário, que é onde as regras acima precisam
 * estar presas.
 */
export function normalizeEngineContext(input: {
  system: string;
  messages: LLMMessage[];
}): NormalizeResult {
  const { system, messages } = input;

  if (system.trim().length === 0) {
    return reject('empty_system', 'system vazio: o piloto não roda sem instruções aprovadas');
  }
  if (system.length > HISTORY_LIMITS.max_message_chars) {
    return reject('system_too_large', `system com ${system.length} caracteres`);
  }
  if (messages.length === 0) {
    return reject('empty_messages', 'nenhuma mensagem: não há turno a delegar');
  }

  const ultima = messages[messages.length - 1];
  if (!ultima || ultima.role !== 'user') {
    return reject(
      'last_not_user',
      `última mensagem é ${ultima?.role ?? 'ausente'}; por construção o inbound é a última`,
    );
  }

  const inbound = extractText(ultima.content);
  if (!inbound.ok) {
    return reject('unsupported_block', `bloco "${inbound.blockType}" no user_message atual`);
  }
  if (inbound.text.trim().length === 0) {
    return reject('empty_user_message', 'user_message vazio após trim');
  }
  if (inbound.text.length > HISTORY_LIMITS.max_message_chars) {
    return reject('user_message_too_large', `user_message com ${inbound.text.length} caracteres`);
  }

  const history: EngineHistoryItemV1[] = [];
  let totalChars = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (!m) continue;
    const extraido = extractText(m.content);
    if (!extraido.ok) {
      return reject(
        'unsupported_block',
        `bloco "${extraido.blockType}" na mensagem de histórico ${i}`,
      );
    }
    // Mensagem sem conteúdo não carrega informação e só gasta contexto; o
    // próprio prompt-builder já pula as linhas “event_only”. Descartar aqui é
    // explícito e testado — não é truncamento de conteúdo.
    if (extraido.text.trim().length === 0) continue;
    if (extraido.text.length > HISTORY_LIMITS.max_message_chars) {
      return reject(
        'history_too_large',
        `mensagem de histórico ${i} com ${extraido.text.length} caracteres`,
      );
    }
    totalChars += extraido.text.length;
    history.push({ role: m.role, text: extraido.text });
  }

  if (history.length > HISTORY_LIMITS.max_history_messages) {
    return reject('history_too_long', `${history.length} mensagens de histórico`);
  }
  if (totalChars > HISTORY_LIMITS.max_total_chars) {
    return reject('history_too_large', `histórico com ${totalChars} caracteres`);
  }

  return {
    kind: 'ok',
    context: { system, user_message: inbound.text, history },
  };
}

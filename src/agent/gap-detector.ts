/**
 * Detecta auto-reconhecimento de lacuna na resposta do ReAct.
 * Frases típicas: "não sei isso", "preciso verificar", "não tenho como X agora".
 * Trigger pra INTERNAL_GAP event.
 *
 * False-positive filter: frases como "não sei se você quer X ou Y?" ou
 * "não consigo precisar agora — pode confirmar?" são perguntas ao usuário,
 * não declarações de lacuna. Quando a janela ao redor do signal contém um
 * `?` consideramos a frase uma pergunta e ignoramos. Isso reduz reflexão
 * espúria (custo de tokens + ruído em cognitive_candidates).
 */
const GAP_SIGNALS = [
  /\bn[ãa]o\s+(sei|tenho|consigo)\b/i,
  /\bprecisaria\s+(de|verificar)\b/i,
  /\bn[ãa]o\s+tenho\s+como\b/i,
  /\bsem\s+acesso\s+a\b/i,
  /\bme\s+falta\b/i,
];

/** Janela (em chars) ao redor do signal usada pra checar `?`. */
const QUESTION_WINDOW_CHARS = 80;

export function detectGap(responseText: string): { detected: boolean; signal?: string } {
  for (const re of GAP_SIGNALS) {
    const m = responseText.match(re);
    if (!m || m.index === undefined) continue;
    // Filter: if a question mark sits within `QUESTION_WINDOW_CHARS` of the
    // signal (either side), treat as a question to the user, not a gap.
    const start = Math.max(0, m.index - QUESTION_WINDOW_CHARS);
    const end = Math.min(responseText.length, m.index + m[0].length + QUESTION_WINDOW_CHARS);
    const window = responseText.slice(start, end);
    if (window.includes('?')) continue;
    return { detected: true, signal: m[0] };
  }
  return { detected: false };
}

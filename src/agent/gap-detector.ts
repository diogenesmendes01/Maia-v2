/**
 * Detecta auto-reconhecimento de lacuna na resposta do ReAct.
 * Frases típicas: "não sei isso", "preciso verificar", "não tenho como X agora".
 * Trigger pra INTERNAL_GAP event.
 */
const GAP_SIGNALS = [
  /\bn[ãa]o\s+(sei|tenho|consigo)\b/i,
  /\bprecisaria\s+(de|verificar)\b/i,
  /\bn[ãa]o\s+tenho\s+como\b/i,
  /\bsem\s+acesso\s+a\b/i,
  /\bme\s+falta\b/i,
];

export function detectGap(responseText: string): { detected: boolean; signal?: string } {
  for (const re of GAP_SIGNALS) {
    const m = responseText.match(re);
    if (m) return { detected: true, signal: m[0] };
  }
  return { detected: false };
}

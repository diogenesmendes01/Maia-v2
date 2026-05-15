/**
 * Detecção determinística de sinal explícito do usuário.
 *
 * P3c Task 5: avalia se a MENSAGEM DO USUÁRIO (não a resposta do agente)
 * contém um sinal de concordância (`agreement`), discordância (`denial`)
 * ou padrão customizado (`custom`). Sem LLM — apenas regex.
 *
 * Patterns negativos SEMPRE checados primeiro: "não, mas pode ser" deve
 * pontuar como negativo, não positivo (denial overrides accidental
 * positive token).
 *
 * Modes:
 * - `agreement`: positivo = sim/ok/claro/etc.; negativo = não/recuso/etc.
 * - `denial`: inverte agreement — "não quero" passa.
 * - `custom`: usa positive_patterns / negative_patterns fornecidos.
 */

const AGREEMENT_POSITIVE: RegExp[] = [
  /\b(sim|ok|claro|combinado|fechado|aceito|topo|pode ser|tudo bem|tudo certo|beleza|show|positivo|concordo|confirmo|confirmado)\b/i,
];
const AGREEMENT_NEGATIVE: RegExp[] = [
  /\b(n[ãa]o|nope|de jeito nenhum|negativo|n[ãa]o quero|n[ãa]o aceito|recuso)\b/i,
];
const DENIAL_POSITIVE: RegExp[] = AGREEMENT_NEGATIVE;
const DENIAL_NEGATIVE: RegExp[] = AGREEMENT_POSITIVE;

export type UserSignalInput = {
  signal: 'agreement' | 'denial' | 'custom';
  positive_patterns?: string[];
  negative_patterns?: string[];
  user_message: string;
};

export type UserSignalResult = {
  passed: boolean;
  matched: 'positive' | 'negative' | 'none';
  evidence: string;
};

export function detectUserSignal(input: UserSignalInput): UserSignalResult {
  const msg = (input.user_message ?? '').trim();
  if (msg.length === 0) {
    return { passed: false, matched: 'none', evidence: 'no user message' };
  }
  let pos: RegExp[] = [];
  let neg: RegExp[] = [];
  if (input.signal === 'agreement') {
    pos = AGREEMENT_POSITIVE;
    neg = AGREEMENT_NEGATIVE;
  } else if (input.signal === 'denial') {
    pos = DENIAL_POSITIVE;
    neg = DENIAL_NEGATIVE;
  } else {
    pos = (input.positive_patterns ?? []).map((p) => safeRegex(p));
    neg = (input.negative_patterns ?? []).map((p) => safeRegex(p));
  }
  // Negative checked first — denial overrides accidental positive
  for (const r of neg) {
    if (r.test(msg)) {
      return { passed: false, matched: 'negative', evidence: 'matched negative pattern' };
    }
  }
  for (const r of pos) {
    if (r.test(msg)) {
      return { passed: true, matched: 'positive', evidence: 'matched positive pattern' };
    }
  }
  return { passed: false, matched: 'none', evidence: 'no pattern matched' };
}

function safeRegex(p: string): RegExp {
  try {
    return new RegExp(p, 'i');
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

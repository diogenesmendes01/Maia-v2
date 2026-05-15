/**
 * P6 Task 6 — Deterministic Suggester (regex).
 *
 * Sugestor barato e auditável que cobre o "long tail" de cenários óbvios sem
 * pagar latência de LLM. Útil quando feature flag desabilita o LLM ou quando
 * a confiança regex já é alta o bastante. Suggested_by = DETERMINISTIC_CLASSIFIER.
 *
 * Patterns são heurísticas em PT-BR ancoradas em vocabulário canônico:
 *  - suporte:     problema / erro / não funciona / bug / ajuda
 *  - comercial:   comprar / preço / venda / orçamento / cotação
 *  - financeiro:  boleto / pagamento / pix / fatura / cobrança (STRONG)
 *
 * Se o role_key candidato NÃO estiver em `available_roles` (e.g. tenant não
 * configurou esse role), a entrada é pulada — não crash. Primeiro match vence
 * (ordem da lista define prioridade).
 */
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { RoleSuggester, RoleCandidate, RoleSelectorInput } from './types.js';

const PATTERNS: Array<{
  role_key: string;
  regex: RegExp;
  strength: RoleSelectorStrength;
  confidence: number;
}> = [
  {
    role_key: 'suporte',
    regex: /\b(suporte|problema|n[ãa]o funciona|erro|ajuda|bug|reclama)\b/i,
    strength: RoleSelectorStrength.MEDIUM,
    confidence: 0.7,
  },
  {
    role_key: 'comercial',
    regex: /\b(comprar|pre[çc]o|vender|valor|or[çc]amento|cota[çc][ãa]o|venda)\b/i,
    strength: RoleSelectorStrength.MEDIUM,
    confidence: 0.7,
  },
  {
    role_key: 'financeiro',
    regex: /\b(boleto|pagamento|fatura|pix|cobran[çc]a|d[íi]vida)\b/i,
    strength: RoleSelectorStrength.STRONG,
    confidence: 0.85,
  },
];

export const deterministicSuggester: RoleSuggester = {
  async suggest(input: RoleSelectorInput): Promise<RoleCandidate | null> {
    for (const p of PATTERNS) {
      if (p.regex.test(input.inbound_text)) {
        const role = input.available_roles.find((r) => r.role_key === p.role_key);
        if (!role) continue;
        return {
          role_id: role.id,
          role_key: role.role_key,
          confidence: p.confidence,
          strength: p.strength,
          suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
          reason: `regex match: ${p.regex.source}`,
        };
      }
    }
    return null;
  },
};

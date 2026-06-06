/**
 * Issue #431 — `company_identity_resolver` (boleto proposal domain adapter).
 *
 * Resolves an INFORMAL / ambiguous company identity (partial name, trade name,
 * legal name, partner/owner hint, free-text message, CNPJ) to a `contraparte`
 * BEFORE a formal lookup. This is NOT a duplicate of `identify_entity`:
 *   - `identify_entity` resolves an `entidade` from the user's OWN scope, with
 *     its matching composed inline over `entidades`.
 *   - This resolves a COUNTERPARTY (`contrapartes`) and reuses only the honest
 *     primitives — `fuzzyMatchByName` (which itself wraps `trigramSim` +
 *     `stripDiacritics` and the SAME ambiguity gate) — never copying the
 *     entity-matching composition.
 *
 * Reuse boundary:
 *   - Candidate fetch: `contrapartesRepo.searchByName` / `.byDocumento`, both
 *     tenant+agent+entidade pinned (invariant #1).
 *   - Scoring + ambiguity gate: `fuzzyMatchByName` (`@/lib/utils.js`).
 *
 * Behavior (per the issue contract):
 *   - Exact CNPJ match OUTRANKS fuzzy name matching (and resolves with high
 *     confidence even if the name is ambiguous).
 *   - Ambiguous fuzzy result → `needs_confirmation = true`, NO resolved
 *     `company_id`, and a `question` the agent can ask.
 *   - High-confidence unambiguous match → `needs_confirmation = false`.
 *   - Read-only, tenant/agent scoped. No write.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { contrapartesRepo } from '@/db/repositories.js';
import type { Contraparte } from '@/db/schema.js';
import { fuzzyMatchByName, FUZZY_SCORE_FLOOR } from '@/lib/utils.js';

const inputSchema = z.object({
  partial_company_name: z.string().max(300).optional(),
  trade_name: z.string().max(300).optional(),
  legal_name: z.string().max(300).optional(),
  partner_or_owner_name: z.string().max(300).optional(),
  customer_message: z.string().max(4000).optional(),
  phone: z.string().max(40).optional(),
  // Accepted but NOT used to scope reads — the conversation is pinned from the
  // ALS context (invariant #1). A divergent id is rejected by the dispatcher's
  // scope, not honored here; we only read it as a weak text hint if present.
  conversation_id: z.string().max(120).optional(),
  previous_context: z.string().max(4000).optional(),
  cnpj: z.string().max(40).optional(),
});

const alternativeSchema = z.object({
  company_id: z.string(),
  name: z.string(),
  cnpj: z.string().optional(),
  score: z.number().optional(),
});

const outputSchema = z.object({
  resolved: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
  company_id: z.string().optional(),
  cnpj: z.string().optional(),
  matched_by: z.array(z.string()),
  match_reasons: z.array(z.string()),
  alternatives: z.array(alternativeSchema),
  needs_confirmation: z.boolean(),
  question: z.string().optional(),
});

type Output = z.infer<typeof outputSchema>;

/** Map a trigram score to the coarse confidence band the contract exposes. */
function bandFromScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.7) return 'high';
  if (score >= FUZZY_SCORE_FLOOR) return 'medium';
  return 'low';
}

/** The textual query: the most specific provided name signal, falling back to
 * the trade/legal/partner hints and finally the free-text message. */
function buildQuery(args: z.infer<typeof inputSchema>): { query: string; matchedBy: string[] } {
  const matchedBy: string[] = [];
  // Prefer the most identity-bearing field first.
  const order: Array<[string | undefined, string]> = [
    [args.trade_name, 'trade_name'],
    [args.legal_name, 'legal_name'],
    [args.partial_company_name, 'partial_company_name'],
    [args.partner_or_owner_name, 'partner_or_owner_name'],
    [args.customer_message, 'customer_message'],
    [args.previous_context, 'previous_context'],
  ];
  let query = '';
  for (const [value, label] of order) {
    if (value && value.trim().length > 0) {
      if (query.length === 0) query = value.trim();
      matchedBy.push(label);
    }
  }
  return { query, matchedBy };
}

function alt(c: Contraparte, score?: number): z.infer<typeof alternativeSchema> {
  return {
    company_id: c.id,
    name: c.nome,
    cnpj: c.documento ?? undefined,
    score,
  };
}

export const companyIdentityResolverTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_identity_resolver',
  description:
    'Resolve a identidade informal/ambígua de uma empresa (contraparte) a partir de nome parcial, nome fantasia, razão social, sócio, CNPJ ou texto livre, antes da busca formal. CNPJ exato tem prioridade sobre nome; resultado ambíguo pede confirmação. Apenas leitura, escopo tenant/agente.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_identity_resolved',
  handler: async (args, ctx) => {
    const scope = { pessoa_id: ctx.pessoa.id, entidades: ctx.scope.entidades };
    if (scope.entidades.length === 0) {
      return emptyResult();
    }

    // 1) Exact CNPJ — outranks fuzzy. A single exact hit resolves with high
    //    confidence; multiple hits (shouldn't happen for a real CNPJ, but the
    //    column is non-unique) fall back to confirmation.
    const cnpj = args.cnpj;
    if (cnpj && cnpj.replace(/\D/g, '').length > 0) {
      const byDoc = await contrapartesRepo.byDocumento(scope, cnpj);
      if (byDoc.length === 1) {
        const hit = byDoc[0]!;
        return {
          resolved: true,
          confidence: 'high',
          company_id: hit.id,
          cnpj: hit.documento ?? undefined,
          matched_by: ['cnpj'],
          match_reasons: ['exact_cnpj_match'],
          alternatives: [],
          needs_confirmation: false,
        };
      }
      if (byDoc.length > 1) {
        return {
          resolved: false,
          confidence: 'low',
          matched_by: ['cnpj'],
          match_reasons: ['multiple_contrapartes_share_documento'],
          alternatives: byDoc.slice(0, 5).map((c) => alt(c)),
          needs_confirmation: true,
          question:
            'Encontrei mais de uma empresa com esse CNPJ no seu cadastro. Pode confirmar qual delas?',
        };
      }
      // No exact CNPJ hit → fall through to fuzzy by name.
    }

    // 2) Fuzzy by name over the in-scope candidate set.
    const { query, matchedBy } = buildQuery(args);
    if (query.length === 0) {
      return {
        resolved: false,
        confidence: 'low',
        matched_by: [],
        match_reasons: ['no_identifying_signal'],
        alternatives: [],
        needs_confirmation: true,
        question: 'Sobre qual empresa você está falando? Pode me dizer o nome ou o CNPJ?',
      };
    }

    const candidates = await contrapartesRepo.searchByName(scope);
    if (candidates.length === 0) {
      return {
        resolved: false,
        confidence: 'low',
        matched_by: matchedBy,
        match_reasons: ['no_contrapartes_in_scope'],
        alternatives: [],
        needs_confirmation: true,
        question: 'Não encontrei essa empresa no cadastro. Pode confirmar o nome ou o CNPJ?',
      };
    }

    const match = fuzzyMatchByName(
      query,
      candidates.map((c) => ({ id: c.id, name: c.nome, extra: c })),
    );
    const top = match.top;
    const alternatives = match.ranked
      .slice(0, 5)
      .map((r) => alt(r.extra as Contraparte, Number(r.score.toFixed(3))));

    if (top === null || match.ambiguous) {
      return {
        resolved: false,
        confidence: top ? bandFromScore(top.score) : 'low',
        company_id: undefined,
        cnpj: undefined,
        matched_by: matchedBy,
        match_reasons: top
          ? ['fuzzy_name_ambiguous']
          : ['no_fuzzy_candidate'],
        alternatives,
        needs_confirmation: true,
        question:
          'Encontrei mais de uma empresa parecida. Pode confirmar qual é a correta (ou informar o CNPJ)?',
      };
    }

    const winner = top.extra as Contraparte;
    return {
      resolved: true,
      confidence: bandFromScore(top.score),
      company_id: winner.id,
      cnpj: winner.documento ?? undefined,
      matched_by: matchedBy,
      match_reasons: ['fuzzy_name_match'],
      alternatives: alternatives.filter((a) => a.company_id !== winner.id),
      needs_confirmation: false,
    };
  },
};

function emptyResult(): Output {
  return {
    resolved: false,
    confidence: 'low',
    matched_by: [],
    match_reasons: ['empty_scope'],
    alternatives: [],
    needs_confirmation: true,
    question: 'Sobre qual empresa você está falando?',
  };
}

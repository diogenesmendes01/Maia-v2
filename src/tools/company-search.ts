/**
 * Issue #431 — `company_search` (boleto proposal domain adapter).
 *
 * FORMAL company lookup by a resolved identifier (`company_id`), CNPJ, legal /
 * trade name, or partner name — returning registration/status data from
 * `contrapartes`. Separate from `company_identity_resolver`: the resolver
 * handles informal/ambiguous identity and asks for confirmation; this returns
 * the formal record (or alternatives) for an already-narrowed query.
 *
 * Reuse boundary:
 *   - Extends `contrapartesRepo` (NEW `.byIdScoped` / `.byDocumento` /
 *     `.searchByName`, all tenant+agent+entidade pinned — invariant #1) rather
 *     than creating a second repository.
 *   - Fuzzy ranking shares `fuzzyMatchByName` with the resolver / `identify_entity`.
 *
 * Behavior (per the issue contract):
 *   - Prefer EXACT `company_id`, then EXACT CNPJ, before any fuzzy text search.
 *   - Read-only. Does not reproduce the resolver's confirmation flow — it only
 *     returns `alternatives` when there's no exact hit.
 *
 * Schema reality (`contrapartes`): usable columns are `nome`, `tipo`,
 * `documento` (nullable, non-unique), `status` (default 'ativa'), `metadata`.
 * There is no separate registration/registry table for a counterparty, so
 * `registration_data` surfaces `tipo`/`status`/`documento` and
 * `internal_identifiers` surfaces the row id + entidade — honest about what the
 * schema actually holds.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { contrapartesRepo } from '@/db/repositories.js';
import type { Contraparte } from '@/db/schema.js';
import { fuzzyMatchByName } from '@/lib/utils.js';

const inputSchema = z
  .object({
    company_id: z.string().max(120).optional(),
    cnpj: z.string().max(40).optional(),
    legal_name: z.string().max(300).optional(),
    trade_name: z.string().max(300).optional(),
    partner_or_owner_name: z.string().max(300).optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.company_id || v.cnpj || v.legal_name || v.trade_name || v.partner_or_owner_name,
      ),
    { message: 'at least one search field is required' },
  );

const companyShape = z.object({
  company_id: z.string(),
  name: z.string(),
  cnpj: z.string().optional(),
  status: z.string().optional(),
  metadata: z.unknown().optional(),
});

const outputSchema = z.object({
  found: z.boolean(),
  company: companyShape.optional(),
  registration_data: z.unknown().optional(),
  internal_identifiers: z.unknown().optional(),
  alternatives: z.array(companyShape).optional(),
  matched_by: z.string().optional(),
});

type Output = z.infer<typeof outputSchema>;

function toCompany(c: Contraparte): z.infer<typeof companyShape> {
  return {
    company_id: c.id,
    name: c.nome,
    cnpj: c.documento ?? undefined,
    status: c.status,
    metadata: c.metadata,
  };
}

function hit(c: Contraparte, matchedBy: string): Output {
  return {
    found: true,
    company: toCompany(c),
    registration_data: { tipo: c.tipo, status: c.status, documento: c.documento ?? null },
    internal_identifiers: { company_id: c.id, entidade_id: c.entidade_id },
    matched_by: matchedBy,
  };
}

export const companySearchTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'company_search',
  description:
    'Busca formal de empresa (contraparte) por company_id, CNPJ, razão social, nome fantasia ou sócio. Prioriza company_id e CNPJ exatos antes de busca textual. Apenas leitura, escopo tenant/agente.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'company_searched',
  handler: async (args, ctx) => {
    const scope = { pessoa_id: ctx.pessoa.id, entidades: ctx.scope.entidades };
    if (scope.entidades.length === 0) {
      return { found: false, alternatives: [] };
    }

    // 1) Exact company_id (scoped — a leaked/guessed id from another tenant or
    //    out-of-scope entidade returns null).
    if (args.company_id) {
      const byId = await contrapartesRepo.byIdScoped(scope, args.company_id);
      if (byId) return hit(byId, 'company_id');
    }

    // 2) Exact CNPJ.
    if (args.cnpj && args.cnpj.replace(/\D/g, '').length > 0) {
      const byDoc = await contrapartesRepo.byDocumento(scope, args.cnpj);
      if (byDoc.length === 1) return hit(byDoc[0]!, 'cnpj');
      if (byDoc.length > 1) {
        return {
          found: false,
          alternatives: byDoc.slice(0, 10).map(toCompany),
          matched_by: 'cnpj',
        };
      }
    }

    // 3) Fuzzy by the best available name signal.
    const query =
      args.trade_name?.trim() ||
      args.legal_name?.trim() ||
      args.partner_or_owner_name?.trim() ||
      '';
    if (query.length === 0) {
      return { found: false, alternatives: [] };
    }

    const candidates = await contrapartesRepo.searchByName(scope);
    if (candidates.length === 0) {
      return { found: false, alternatives: [] };
    }
    const match = fuzzyMatchByName(
      query,
      candidates.map((c) => ({ id: c.id, name: c.nome, extra: c })),
    );

    // Exact-name fast path: a perfect/near-perfect unambiguous fuzzy hit counts
    // as found; otherwise return ranked alternatives without resolving.
    if (match.top && !match.ambiguous) {
      return hit(match.top.extra as Contraparte, 'name');
    }
    return {
      found: false,
      alternatives: match.ranked.slice(0, 10).map((r) => toCompany(r.extra as Contraparte)),
      matched_by: 'name',
    };
  },
};

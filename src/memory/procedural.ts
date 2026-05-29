/**
 * Procedural memory — `learned_rules` mutation facade.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #230, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Every function in this module operates on a raw `rule_id` (UUID). The
 * underlying `rulesRepo` methods are SCOPE-AUTHORITATIVE — `listActive`,
 * `findByContext`, `byId`, `incrementAcerto`, `incrementErro`, and `setStatus`
 * all pin `tenant_id = <ctx> AND agent_id = <ctx>` into the WHERE clause.
 *
 * If a caller passes a `rule_id` that exists but belongs to a DIFFERENT
 * tenant/agent, the mutation throws `TypedError('rule_not_in_scope', ...)`.
 * That is a LOUD failure, not a silent no-op (see the INVARIANT block on
 * rulesRepo in src/db/repositories.ts for rationale). Callers running inside
 * a normal `runWithTenantContext` boundary will never see this for legitimate
 * ids resolved from their OWN reads — by construction, `listActive` /
 * `byId` only ever return same-scope rules. A `rule_not_in_scope` from this
 * module signals either (a) caller bug — id sourced from outside the scoped
 * read path, or (b) ATTEMPTED CROSS-TENANT MUTATION — both warrant a stack
 * trace, not a no-op.
 *
 * Reflection / promotion logic (recordAcerto / recordErro below) chains
 * `incrementAcerto/Erro` → `byId` → `setStatus`. The throw on the first
 * mutator short-circuits the chain so the policy side-effects (promote to
 * 0.8 confidence, deactivate after 2 errors) never fire on out-of-scope rows.
 */
import { rulesRepo } from '@/db/repositories.js';

export async function listRulesForType(tipo: string) {
  return rulesRepo.listActive(tipo);
}

export async function recordAcerto(rule_id: string) {
  await rulesRepo.incrementAcerto(rule_id);
  // Promotion check: 4 consecutive acertos OR 10 days since creation
  const r = await rulesRepo.byId(rule_id);
  if (!r) return;
  const ageDays = (Date.now() - new Date(r.created_at).getTime()) / 86_400_000;
  if (r.acertos >= 4 && r.erros === 0 && Number(r.confianca) < 0.8) {
    await rulesRepo.setStatus(rule_id, { confianca: 0.8 });
  } else if (ageDays >= 10 && r.erros === 0 && r.acertos >= 1) {
    await rulesRepo.setStatus(rule_id, { confianca: Math.max(Number(r.confianca), 0.8) });
  }
}

export async function recordErro(rule_id: string) {
  await rulesRepo.incrementErro(rule_id);
  const r = await rulesRepo.byId(rule_id);
  if (!r) return;
  if (r.erros >= 2) {
    await rulesRepo.setStatus(rule_id, { ativa: false });
  }
}

export async function markFirm(rule_id: string) {
  await rulesRepo.setStatus(rule_id, { ativa: true, confianca: 1.0 });
}

export async function banRule(rule_id: string) {
  await rulesRepo.setStatus(rule_id, { ativa: false, confianca: 0.0 });
}

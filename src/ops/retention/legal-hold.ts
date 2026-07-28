/**
 * Issue #520 §11 — legal hold evaluator.
 *
 * "Hold ativo bloqueia purge aplicável"; "corrida hold versus purge possui
 * lock/ordenação determinística"; "hold não torna dados visíveis a atores não
 * autorizados"; "logs não expõem motivo sensível".
 *
 * The evaluator is PURE and DETERMINISTIC: it takes the hold rows the caller
 * already read (inside its tenant scope) and returns a verdict. It is the
 * BACKEND deciding — no LLM is anywhere near this path (invariant 3).
 */
import { TypedError } from '@/lib/utils.js';

export interface HoldRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  /** `'*'` freezes every class in scope. */
  data_class: string;
  /** Pseudonymised subject; `null` = broad hold covering every subject. */
  subject_ref: string | null;
  status: 'active' | 'released';
  effective_from: Date;
  /** `null` = open-ended, until explicitly released. */
  effective_until: Date | null;
  /** Stable code — NEVER free text (a sensitive reason must not reach a log). */
  reason_code: string;
}

export interface HoldQuery {
  tenant_id: string;
  agent_id: string;
  data_class: string;
  /** Pseudonymised subject the purge would touch; `null` for class-wide purges. */
  subject_ref: string | null;
  at: Date;
}

export interface HoldVerdict {
  held: boolean;
  /** Sorted for determinism — two evaluations of the same input are identical. */
  hold_ids: string[];
  /** Distinct reason CODES only. No case reference, no free text. */
  reason_codes: string[];
}

/**
 * Fail-closed scope guard. A purge evaluated without a tenant/agent could
 * silently miss the hold rows of the tenant it is about to delete from — the
 * worst possible failure for this module. Missing scope throws.
 */
function assertScoped(q: HoldQuery): void {
  for (const [field, value] of [
    ['tenant_id', q.tenant_id],
    ['agent_id', q.agent_id],
    ['data_class', q.data_class],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      throw new TypedError(
        'legal_hold_unscoped',
        `legal-hold evaluation requires a non-empty, trimmed ${field}`,
        { field },
      );
    }
  }
  if (q.tenant_id === 'default' || q.agent_id === 'default') {
    throw new TypedError(
      'legal_hold_default_literal',
      'legal-hold evaluation refuses the legacy `default` sentinel — the caller is on an unmigrated path',
      {},
    );
  }
  if (!(q.at instanceof Date) || Number.isNaN(q.at.getTime())) {
    throw new TypedError('legal_hold_unscoped', 'legal-hold evaluation requires a valid instant', {});
  }
}

function applies(hold: HoldRecord, q: HoldQuery): boolean {
  // Cross-tenant holds NEVER apply, and — just as importantly — a hold from
  // another tenant must never be counted as protecting this one.
  if (hold.tenant_id !== q.tenant_id || hold.agent_id !== q.agent_id) return false;
  if (hold.status !== 'active') return false;
  if (hold.effective_from.getTime() > q.at.getTime()) return false;
  if (hold.effective_until !== null && hold.effective_until.getTime() <= q.at.getTime()) {
    return false;
  }
  if (hold.data_class !== '*' && hold.data_class !== q.data_class) return false;
  // A hold with no subject is BROAD: it covers every subject of the class.
  if (hold.subject_ref === null) return true;
  // A subject-scoped hold blocks a class-wide purge too — that purge would
  // otherwise sweep the held subject away (§11 "hold ativo bloqueia purge
  // aplicável"). This is the conservative direction, and it is deliberate.
  if (q.subject_ref === null) return true;
  return hold.subject_ref === q.subject_ref;
}

/**
 * Evaluate every candidate hold against one purge target.
 *
 * The caller MUST pass the holds it read within its own tenant scope; the
 * evaluator still re-checks the scope of each row (defence in depth against a
 * repository that forgets its WHERE clause).
 */
export function evaluateHold(holds: readonly HoldRecord[], q: HoldQuery): HoldVerdict {
  assertScoped(q);
  const matched = holds.filter((h) => applies(h, q));
  return {
    held: matched.length > 0,
    hold_ids: matched.map((h) => h.id).sort(),
    reason_codes: [...new Set(matched.map((h) => h.reason_code))].sort(),
  };
}

/**
 * Gate for the destructive path. Throws when a hold applies, so a purge cannot
 * proceed by accidentally ignoring a boolean.
 */
export function assertPurgeAllowed(holds: readonly HoldRecord[], q: HoldQuery): void {
  const verdict = evaluateHold(holds, q);
  if (verdict.held) {
    throw new TypedError(
      'legal_hold_active',
      `purge blocked by ${verdict.hold_ids.length} active legal hold(s)`,
      {
        data_class: q.data_class,
        hold_ids: verdict.hold_ids,
        reason_codes: verdict.reason_codes,
      },
    );
  }
}

/**
 * Deterministic ordering for the hold-vs-purge race (§11).
 *
 * Both operations take the same per-(tenant, agent, data_class) key, so the
 * database serialises them and the outcome no longer depends on which
 * transaction happened to arrive first within a millisecond.
 */
export function holdRaceLockKey(tenant_id: string, agent_id: string, data_class: string): string {
  return `maia_ops_hold:${tenant_id}:${agent_id}:${data_class}`;
}

/**
 * §11 "release não dispara deleção imediata sem reavaliação". Releasing a hold
 * does NOT make the data eligible on its own: the retention policy must be
 * re-evaluated afterwards, and this helper is what the caller checks before
 * touching anything.
 */
export function requiresReevaluationAfterRelease(hold: HoldRecord): boolean {
  return hold.status === 'released';
}

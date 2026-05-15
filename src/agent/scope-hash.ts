import { createHash } from 'node:crypto';
import type { ResolvedPermission } from '@/governance/permissions.js';

/**
 * Fingerprint of the resolved scope for a turn. Captures the fields that
 * influence what the LLM is told about the conversation in `buildPrompt`:
 * the set of entidades, the profile_id assigned to each, the permission
 * status, and the effective valor_max. Order-independent across entidades.
 *
 * Used by issue #73 to detect when scope changed between turns and inject
 * a sentinel reminder telling the LLM to re-read the scope block.
 */
export function hashScope(scope: {
  entidades: string[];
  byEntity: Map<string, ResolvedPermission>;
}): string {
  const entries = [...scope.byEntity.entries()]
    .map(([entidade_id, rp]) => ({
      entidade_id,
      profile_id: rp.profile.id,
      permissao_status: rp.permissao.status,
      valor_max: rp.effective_limits.valor_max ?? 0,
    }))
    .sort((a, b) => a.entidade_id.localeCompare(b.entidade_id));

  const canonical = JSON.stringify(entries);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

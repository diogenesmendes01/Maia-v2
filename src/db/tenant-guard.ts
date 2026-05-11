import { getCurrentTenant, getCurrentAgent, MissingTenantContextError } from './tenant-context.js';

export { MissingTenantContextError } from './tenant-context.js';

/**
 * applyTenantGuard — injeta tenant_id e agent_id do contexto atual
 * em um objeto de input (insert/update/where clause). Se o input já
 * tem tenant_id explícito e não bate com o contexto, lança erro.
 *
 * Uso típico em repository methods:
 *   create(input) {
 *     const guarded = applyTenantGuard(input);
 *     return db.insert(table).values(guarded).returning();
 *   }
 */
export function applyTenantGuard<T extends { tenant_id?: string; agent_id?: string }>(
  input: T,
): T & { tenant_id: string; agent_id: string } {
  const ctxTenant = getCurrentTenant(); // pode lançar MissingTenantContextError
  const ctxAgent = getCurrentAgent();

  if (input.tenant_id && input.tenant_id !== ctxTenant) {
    throw new Error(
      `tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`,
    );
  }
  if (input.agent_id && input.agent_id !== ctxAgent) {
    throw new Error(
      `agent mismatch: input ${input.agent_id} vs context ${ctxAgent}`,
    );
  }

  return {
    ...input,
    tenant_id: ctxTenant,
    agent_id: ctxAgent,
  };
}

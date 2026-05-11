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
export function applyTenantGuard<T extends Record<string, unknown>>(
  input: T,
): T & { tenant_id: string; agent_id: string } {
  const ctxTenant = getCurrentTenant(); // pode lançar MissingTenantContextError
  const ctxAgent = getCurrentAgent();

  const inputTenant = input.tenant_id as string | undefined;
  const inputAgent = input.agent_id as string | undefined;

  if (inputTenant && inputTenant !== ctxTenant) {
    throw new Error(
      `tenant mismatch: input ${inputTenant} vs context ${ctxTenant}`,
    );
  }
  if (inputAgent && inputAgent !== ctxAgent) {
    throw new Error(
      `agent mismatch: input ${inputAgent} vs context ${ctxAgent}`,
    );
  }

  return {
    ...input,
    tenant_id: ctxTenant,
    agent_id: ctxAgent,
  };
}

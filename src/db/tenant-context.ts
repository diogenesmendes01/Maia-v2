import { AsyncLocalStorage } from 'async_hooks';

export class MissingTenantContextError extends Error {
  constructor() {
    super('Tenant context não está disponível — toda query precisa rodar dentro de runWithTenantContext');
    this.name = 'MissingTenantContextError';
  }
}

type TenantContext = {
  tenant_id: string;
  agent_id: string;
};

const storage = new AsyncLocalStorage<TenantContext>();

export async function runWithTenantContext<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getCurrentTenant(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx.tenant_id;
}

export function getCurrentAgent(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx.agent_id;
}

export function tryGetCurrentContext(): TenantContext | null {
  return storage.getStore() ?? null;
}

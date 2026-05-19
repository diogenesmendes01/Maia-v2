/**
 * P9a — In-process slice cache.
 *
 * Cache simples para `SkillSlice` (5-10min TTL). Em produção, este
 * provider pode ser substituído por Redis (mantendo a mesma interface);
 * em P9a o cache in-process é suficiente porque o slice é determinístico
 * a partir de (tenant_id, decision routing) e a invalidação por evento
 * (skill_activated/rolled_back) já garante consistência.
 */

interface CacheEntry<T> {
  value: T;
  expires_at: number;
}

class InMemorySliceCache {
  private store = new Map<string, CacheEntry<unknown>>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires_at) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expires_at: Date.now() + ttlSeconds * 1000 });
  }

  async invalidate(prefix: string): Promise<void> {
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /** Test-only: snapshot current size. */
  size(): number {
    return this.store.size;
  }
}

export const sliceCache = new InMemorySliceCache();

/**
 * Invalida todas as entradas de slice para um tenant. Chamado quando uma
 * skill ativa/rola para trás (mantém cache consistente sem esperar TTL).
 */
export async function invalidateSkillSliceCacheForTenant(tenant_id: string): Promise<void> {
  await sliceCache.invalidate(`skill_slice:${tenant_id}:`);
}

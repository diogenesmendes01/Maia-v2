/**
 * LRU cache tenant-aware para conjuntos de feriados aplicáveis.
 *
 * Cache key inclui tenant_id (invariant: P0 — sem cross-tenant leak), entidade
 * (NULL = global/só nacionais), ano e kind (standard | clt).
 *
 * Invalidação: broad por tenant (MVP). Spec §4.5 lista regras finer-grained
 * mas a broad invalidation é correta + simples + tenant-scoped (não vaza).
 * Otimização específica entra quando cache miss rate medido >5%.
 */
import { getCurrentTenant } from '../db/tenant-context.js';

export type BusinessDayKind = 'standard' | 'clt';
export type CacheKey = string;
export type CachedSet = Set<string>;

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

interface Entry {
  value: CachedSet;
  expiresAt: number;
}

const _cache = new Map<CacheKey, Entry>();

export const _internal_cache = {
  clear: () => _cache.clear(),
  get: (k: string) => _cache.get(k)?.value,
  set: (k: string, v: CachedSet) => _cache.set(k, { value: v, expiresAt: Date.now() + TTL_MS }),
  size: () => _cache.size,
};

export function cacheKey(
  tenant_id: string,
  entidadeId: string | undefined,
  year: number,
  kind: BusinessDayKind,
): CacheKey {
  return `${tenant_id}:${entidadeId ?? 'global'}:${year}:${kind}`;
}

function lruGet(k: CacheKey): CachedSet | undefined {
  const entry = _cache.get(k);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(k);
    return undefined;
  }
  // re-insert para LRU recency
  _cache.delete(k);
  _cache.set(k, entry);
  return entry.value;
}

function lruSet(k: CacheKey, v: CachedSet): void {
  if (_cache.size >= MAX_ENTRIES) {
    const first = _cache.keys().next().value;
    if (first) _cache.delete(first);
  }
  _cache.set(k, { value: v, expiresAt: Date.now() + TTL_MS });
}

export async function getApplicableHolidaysSet(
  year: number,
  options: { entidadeId?: string; kind?: BusinessDayKind },
  loader: (tenant_id: string) => Promise<CachedSet>,
): Promise<CachedSet> {
  const tenant_id = getCurrentTenant();
  const key = cacheKey(tenant_id, options.entidadeId, year, options.kind ?? 'standard');
  const hit = lruGet(key);
  if (hit) return hit;
  const fresh = await loader(tenant_id);
  lruSet(key, fresh);
  return fresh;
}

export interface HolidayChangeRef {
  tenant_id: string;
  type: 'national' | 'state' | 'municipal' | 'entity_custom' | 'holding_recess';
  uf?: string | null;
  cidade?: string | null;
  entidade_ids?: string[];
}

export function invalidateCacheForHolidayChange(
  ref: HolidayChangeRef,
  _meta: { changeKind: 'create' | 'update' | 'delete' | 'status_change' },
): void {
  // Broad invalidation por tenant (MVP). Tenant-scoped — nunca vaza.
  const prefix = `${ref.tenant_id}:`;
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

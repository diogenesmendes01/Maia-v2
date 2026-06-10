/**
 * LRU cache tenant-aware para conjuntos de feriados aplicáveis.
 *
 * Cache key inclui tenant_id + agent_id (invariant: P0 — sem cross-tenant nem
 * cross-agent leak), entidade (NULL = global/só nacionais), ano e kind
 * (standard | clt).
 *
 * Layout: `holidays:v3:{enc(tenant_id)}:{enc(agent_id)}:{enc(entidade)}:{year}:{kind}`
 *
 * Padrão arquitetural #235 / PR #242: TODA cache key tenant-scoped também
 * inclui agent_id por consistência.
 *
 * **Encoding seguro de segmentos (#272 reval — Codex convergente):** cada
 * segmento de ID livre-forma (`tenant_id`, `agent_id`, `entidadeId`) passa
 * por `encodeURIComponent` para que o delimitador `:` nunca apareça cru
 * dentro de um segmento. Sem isso, `tenant="T", agent="A:B", entity="E"`
 * colide com `tenant="T", agent="A", entity="B:E"` — vazamento cross-agent
 * que defeats o invariant de isolamento. Mesmo padrão usado em
 * `src/tools/_vision-cache.ts` (#257) e `src/lib/embedding-cache.ts` (#258).
 *
 * **Bump v2 → v3:** invalida caches pré-existentes (intencional — entradas
 * v2 não-encodadas ficam inalcançáveis, próximo miss reconstrói com a chave
 * encodada). Idempotent com TTL de 24h.
 *
 * Invalidação: broad por tenant (MVP). Spec §4.5 lista regras finer-grained
 * mas a broad invalidation é correta + simples + tenant-scoped (não vaza).
 * Wildcard no agent_id mantém invalidação tenant-wide (limpa todos os agents
 * do tenant). Otimização específica entra quando cache miss rate medido >5%.
 */
import { getCurrentAgent, getCurrentTenant } from '../db/tenant-context.js';
import { buildCacheKey } from './cache-key.js';

export type BusinessDayKind = 'standard' | 'clt';
export type CacheKey = string;
export type CachedSet = Set<string>;

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;
const KEY_PREFIX = 'holidays:v3';

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

/**
 * Build the (tenant, agent, entidade)-scoped cache key via the centralized
 * `buildCacheKey` helper (issue #287 consolidation). Each segment is
 * URI-encoded so the `:` delimiter is unambiguous, and Redis glob
 * metacharacters (`* ? [ ] !`) are neutralized. `year` and `kind` are
 * controlled values (number / enum) whose encoding is the identity.
 *
 * Key-compatibility note (#287): this is a process-local LRU (no Redis
 * persistence), so the consolidation carries zero invalidation risk — and
 * for segments without `*`/`!` the output is byte-identical to the previous
 * inline `encodeURIComponent` concat anyway. `v3` prefix unchanged.
 */
function buildKey(
  tenant_id: string,
  agent_id: string,
  entidadeId: string | undefined,
  year: number,
  kind: BusinessDayKind,
): CacheKey {
  return buildCacheKey(
    `${KEY_PREFIX}:`,
    tenant_id,
    agent_id,
    entidadeId ?? 'global',
    year,
    kind,
  );
}

// Public alias for buildKey() preserved as `cacheKey` for backwards-compat
// with existing tests and any downstream caller importing it. The function
// itself is the same — `buildKey` is the canonical internal name (mirrors
// #257/#258), `cacheKey` is the named export contract.
export const cacheKey = buildKey;

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
  const agent_id = getCurrentAgent();
  const key = buildKey(tenant_id, agent_id, options.entidadeId, year, options.kind ?? 'standard');
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
  // Wildcard no agent_id: limpa TODOS os agents do tenant — porque holidays
  // tenant-wide mudam dados de qualquer agent_id no mesmo tenant.
  //
  // **Prefix encoding (#272 reval, #287):** o tenant_id no prefix passa pelo
  // MESMO encoder de `buildKey()` — `buildCacheKey` com um único segmento —
  // para que o prefixo case byte-a-byte com as chaves escritas. Sem isso,
  // `tenant="acme"` limparia também `tenant="acme:dev"` (cross-tenant
  // invalidation) e vice-versa um `tenant="acme%3Adev"` literal mal-encodado
  // escaparia.
  const prefix = `${buildCacheKey(`${KEY_PREFIX}:`, ref.tenant_id)}:`;
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

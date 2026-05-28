/**
 * Issue #250 — Cross-tenant (cross-empresa) isolation invariant for the
 * Vision-result cache (`src/tools/_vision-cache.ts`).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Vision-cache-specific contract this spec PROVES:
 *   `getCachedVision` / `setCachedVision` namespace EVERY Redis key with the
 *   active `tenant_id` (resolved from AsyncLocalStorage via
 *   `@/db/tenant-context`). A file with the same `sha256` cached under tenant
 *   A is NOT served to tenant B, even when the cached value contains
 *   tenant-A-specific artefacts (the adversarial case).
 *
 * Before this fix the key was `maia:vision:${tool}:${sha256}` — any tenant
 * receiving the same image would read another tenant's cached result. This
 * was a compliance gap (no separate audit for the second tenant's processing
 * event) and a latent semantic gap (if any future prompt customisation per
 * tenant were introduced, the leak would become a verbal one).
 *
 * Strategy:
 *   - Mock `@/lib/redis.js` with an in-memory `Map`-backed stub that captures
 *     the EXACT `get` / `setex` key strings emitted by production. Tests
 *     assert against those keys directly so a future code edit that drops
 *     the tenant segment surfaces as a test failure on the key shape, not
 *     just on read/write outcomes.
 *   - Wrap every call in `runWithTenantContext({tenant_id, agent_id}, ...)`
 *     so `getCurrentTenant()` returns the routed value.
 *
 * Coverage:
 *   - WRITE keys are scoped: tenant-A vs tenant-B writes for the same
 *     (tool, sha256) produce DIFFERENT Redis keys.
 *   - READ keys are scoped: a tenant-A `get` looks in the tenant-A namespace,
 *     never tenant-B's.
 *   - SYMMETRY: A↔B and B↔A both isolated.
 *   - ADVERSARIAL: tenant-B writes a recognisable artefact under
 *     (tool, sha256); tenant-A read for the SAME (tool, sha256) returns
 *     `null` (cache miss), never B's payload.
 *   - MISSING CONTEXT: a call outside `runWithTenantContext` throws
 *     `MissingTenantContextError` AND emits ZERO Redis ops.
 *   - REDIS DOWN with valid context: returns `null` / no-ops gracefully
 *     (preserves the "best-effort cache" contract).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory Redis stub. Captures (op, key, args) tuples so tests can assert
// the EXACT key strings emitted by production, not just read/write outcomes.
// ---------------------------------------------------------------------------
type Op = { op: 'get' | 'setex'; key: string; value?: string; ttl?: number };
let ops: Op[] = [];
let store = new Map<string, string>();
let connected = true;

const redisStub = {
  async get(key: string): Promise<string | null> {
    ops.push({ op: 'get', key });
    return store.get(key) ?? null;
  },
  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    ops.push({ op: 'setex', key, value, ttl });
    store.set(key, value);
    return 'OK';
  },
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => connected,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// We import these AFTER `vi.mock` registrations.
import { runWithTenantContext, MissingTenantContextError } from '@/db/tenant-context.js';

const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

beforeEach(() => {
  ops = [];
  store = new Map();
  connected = true;
});

describe('Issue #250 — vision cache is tenant-scoped', () => {
  // ---------------------------------------------------------------------
  // Key shape — production emits `maia:vision:${tenant_id}:${tool}:${sha}`.
  // ---------------------------------------------------------------------
  describe('WRITE key shape', () => {
    it('setCachedVision under tenant-A uses tenant-A in the key', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-X', { kind: 'boleto' });
      });
      const writes = ops.filter((o) => o.op === 'setex');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.key).toBe('maia:vision:tenant-A:parse_image:sha-X');
      expect(writes[0]!.ttl).toBe(3600);
    });

    it('setCachedVision under tenant-B uses tenant-B in the key (SYMMETRY)', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(B_CTX, async () => {
        await setCachedVision('parse_image', 'sha-X', { kind: 'receipt' });
      });
      const writes = ops.filter((o) => o.op === 'setex');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.key).toBe('maia:vision:tenant-B:parse_image:sha-X');
    });

    it('same (tool, sha256) under A vs B → DIFFERENT keys', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-COMMON', { kind: 'boleto', tag: 'A' });
      });
      await runWithTenantContext(B_CTX, async () => {
        await setCachedVision('parse_image', 'sha-COMMON', { kind: 'receipt', tag: 'B' });
      });
      const writeKeys = ops.filter((o) => o.op === 'setex').map((o) => o.key);
      expect(writeKeys).toEqual([
        'maia:vision:tenant-A:parse_image:sha-COMMON',
        'maia:vision:tenant-B:parse_image:sha-COMMON',
      ]);
      // Two independent store entries, never overwritten by each other.
      expect(store.size).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // Read key shape — getCachedVision looks in the tenant-scoped namespace.
  // ---------------------------------------------------------------------
  describe('READ key shape', () => {
    it('getCachedVision under tenant-A reads from tenant-A namespace', async () => {
      const { getCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await getCachedVision('parse_image', 'sha-X');
      });
      const reads = ops.filter((o) => o.op === 'get');
      expect(reads).toHaveLength(1);
      expect(reads[0]!.key).toBe('maia:vision:tenant-A:parse_image:sha-X');
    });

    it('round-trip within tenant-A returns the cached payload', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-RT', { kind: 'boleto', valor: 100 });
        const got = await getCachedVision<{ kind: string; valor: number }>(
          'parse_image',
          'sha-RT',
        );
        expect(got).toEqual({ kind: 'boleto', valor: 100 });
      });
    });
  });

  // ---------------------------------------------------------------------
  // Cross-tenant isolation — the core invariant.
  // ---------------------------------------------------------------------
  describe('CROSS-TENANT ISOLATION', () => {
    it('tenant-A WRITE then tenant-B READ for same (tool, sha) → cache MISS', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-LEAK', { kind: 'boleto', tenant_tag: 'A' });
      });
      const fromB = await runWithTenantContext(B_CTX, async () => {
        return getCachedVision<{ kind: string; tenant_tag: string }>('parse_image', 'sha-LEAK');
      });
      // Tenant B must NOT see tenant A's payload.
      expect(fromB).toBeNull();
    });

    it('SYMMETRY: tenant-B WRITE then tenant-A READ → cache MISS', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(B_CTX, async () => {
        await setCachedVision('parse_image', 'sha-LEAK', { kind: 'boleto', tenant_tag: 'B' });
      });
      const fromA = await runWithTenantContext(A_CTX, async () => {
        return getCachedVision<{ kind: string; tenant_tag: string }>('parse_image', 'sha-LEAK');
      });
      expect(fromA).toBeNull();
    });

    it('ADVERSARIAL — tenant-B caches a result with B-specific artefact; tenant-A read must NOT see it', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      // Tenant-B caches a recognisable artefact. If the cache leaked, a
      // tenant-A read for the same (tool, sha256) would surface this exact
      // payload — including the "beneficiario_nome" that belongs to B's
      // pessoa list.
      await runWithTenantContext(B_CTX, async () => {
        await setCachedVision('parse_receipt', 'sha-RECEIPT', {
          tipo: 'pix',
          valor: 999_999,
          beneficiario_nome: '<ocr>Tenant-B Customer</ocr>',
          confianca: 0.85,
        });
      });
      // Verify the entry actually landed under tenant-B's namespace.
      expect(store.has('maia:vision:tenant-B:parse_receipt:sha-RECEIPT')).toBe(true);
      // Tenant-A read for the SAME (tool, sha256) — must surface as a
      // miss, never as B's payload.
      const fromA = await runWithTenantContext(A_CTX, async () => {
        return getCachedVision<Record<string, unknown>>('parse_receipt', 'sha-RECEIPT');
      });
      expect(fromA).toBeNull();
      // Defense in depth: the read MUST have probed the A namespace, not
      // the B one.
      const reads = ops.filter((o) => o.op === 'get');
      expect(reads).toHaveLength(1);
      expect(reads[0]!.key).toBe('maia:vision:tenant-A:parse_receipt:sha-RECEIPT');
    });

    it('two tenants caching different results for same sha do NOT overwrite each other', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-DUAL', { kind: 'boleto', tag: 'A' });
      });
      await runWithTenantContext(B_CTX, async () => {
        await setCachedVision('parse_image', 'sha-DUAL', { kind: 'receipt', tag: 'B' });
      });
      const fromA = await runWithTenantContext(A_CTX, async () => {
        return getCachedVision<{ kind: string; tag: string }>('parse_image', 'sha-DUAL');
      });
      const fromB = await runWithTenantContext(B_CTX, async () => {
        return getCachedVision<{ kind: string; tag: string }>('parse_image', 'sha-DUAL');
      });
      expect(fromA).toEqual({ kind: 'boleto', tag: 'A' });
      expect(fromB).toEqual({ kind: 'receipt', tag: 'B' });
    });
  });

  // ---------------------------------------------------------------------
  // Missing context — fail-closed, no Redis ops.
  // ---------------------------------------------------------------------
  describe('MISSING TENANT CONTEXT', () => {
    it('getCachedVision throws MissingTenantContextError outside runWithTenantContext', async () => {
      const { getCachedVision } = await import('@/tools/_vision-cache.js');
      await expect(getCachedVision('parse_image', 'sha-X')).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
      // Defense in depth: NO Redis ops were issued.
      expect(ops).toHaveLength(0);
    });

    it('setCachedVision throws MissingTenantContextError outside runWithTenantContext', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await expect(
        setCachedVision('parse_image', 'sha-X', { kind: 'boleto' }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
      expect(ops).toHaveLength(0);
    });

    it('the error carries the stable code MISSING_TENANT_CONTEXT', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await expect(
        setCachedVision('parse_image', 'sha-X', { kind: 'boleto' }),
      ).rejects.toMatchObject({ code: 'MISSING_TENANT_CONTEXT' });
    });
  });

  // ---------------------------------------------------------------------
  // Best-effort contract is preserved when Redis is unavailable.
  // ---------------------------------------------------------------------
  describe('REDIS DISCONNECTED (best-effort contract)', () => {
    it('getCachedVision returns null without throwing when Redis is down', async () => {
      connected = false;
      const { getCachedVision } = await import('@/tools/_vision-cache.js');
      const got = await runWithTenantContext(A_CTX, async () => {
        return getCachedVision('parse_image', 'sha-X');
      });
      expect(got).toBeNull();
      // No Redis ops issued — the check happens after tenant resolution.
      expect(ops).toHaveLength(0);
    });

    it('setCachedVision no-ops without throwing when Redis is down', async () => {
      connected = false;
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha-X', { kind: 'boleto' });
      });
      expect(ops).toHaveLength(0);
    });

    it('but a Redis-down call STILL throws when tenant context is missing', async () => {
      connected = false;
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      // Fail-closed wins over best-effort: the tenant guard fires first.
      await expect(
        setCachedVision('parse_image', 'sha-X', { kind: 'boleto' }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    // SYMMETRY of the fail-closed guard: getCachedVision must also throw
    // when tenant context is missing even when Redis is down. This closes
    // the asymmetric-coverage gap flagged by the review (#257 LOW).
    it('but a Redis-down GET STILL throws when tenant context is missing', async () => {
      connected = false;
      const { getCachedVision } = await import('@/tools/_vision-cache.js');
      // Fail-closed wins over best-effort: the tenant guard fires before
      // the `isRedisConnected()` early return, so the missing-context
      // signal is preserved even in the degraded mode.
      await expect(getCachedVision('parse_image', 'sha-X')).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
      // Defense in depth: NO Redis ops issued — the guard fires before
      // any Redis call would have been attempted.
      expect(ops).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Key delimiter aliasing (review #257 MEDIUM).
  //
  // `tenants.id` is text/free-form (slug), so a tenant whose id contains
  // `:` would otherwise collide with a different tuple if keys were
  // built by raw `${tenant}:${tool}:${sha}` interpolation. Each segment
  // is URI-encoded so `:` becomes `%3A` and the segment boundary stays
  // unambiguous. These tests ASSERT the encoding so a future regression
  // (someone removing the encode call) trips on the EXACT collision case
  // the review flagged.
  // ---------------------------------------------------------------------
  describe('KEY ALIASING (delimiter escape)', () => {
    it('tenant id with `:` is URI-encoded so the segment boundary stays unambiguous', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'agent-X' },
        async () => {
          await setCachedVision('parse_image', 'sha-X', { kind: 'boleto' });
        },
      );
      const writes = ops.filter((o) => o.op === 'setex');
      expect(writes).toHaveLength(1);
      // `:` in the tenant id MUST be encoded — otherwise the key is
      // ambiguous with `(tenant='acme', tool='dev', sha='parse_image:sha-X')`.
      expect(writes[0]!.key).toBe('maia:vision:acme%3Adev:parse_image:sha-X');
    });

    it('two ambiguous tuples that would alias under raw interpolation produce DIFFERENT encoded keys', async () => {
      // Pre-fix raw interpolation would yield IDENTICAL keys for these two
      // tuples — the very collision the review (#257 MEDIUM) called out:
      //   T1 = ('acme:dev',   'parse_image',     'sha-X')
      //        →  maia:vision:acme:dev:parse_image:sha-X
      //   T2 = ('acme',       'dev:parse_image', 'sha-X')
      //        →  maia:vision:acme:dev:parse_image:sha-X   ← SAME!
      // Post-fix the `:` in each segment is encoded as `%3A`, so the two
      // tuples land in distinct cache buckets.
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'agent-1' },
        async () => {
          await setCachedVision('parse_image', 'sha-X', { tag: 'T1' });
        },
      );
      await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-2' }, async () => {
        await setCachedVision('dev:parse_image', 'sha-X', { tag: 'T2' });
      });
      const writeKeys = ops.filter((o) => o.op === 'setex').map((o) => o.key);
      expect(writeKeys).toEqual([
        'maia:vision:acme%3Adev:parse_image:sha-X',
        'maia:vision:acme:dev%3Aparse_image:sha-X',
      ]);
      // Defence in depth: store has TWO distinct entries, not one
      // overwritten — exactly the property the cross-tenant invariant
      // demands.
      expect(store.size).toBe(2);
    });

    it('tenant id with `:` does NOT receive another tenant`s cached payload (aliasing → ISOLATION)', async () => {
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      // T1 caches under (tenant='acme:dev', tool='parse_image').
      await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'agent-1' },
        async () => {
          await setCachedVision('parse_image', 'sha-X', { tag: 'T1' });
        },
      );
      // T2 reads from the would-be-aliased tuple
      // (tenant='acme', tool='dev:parse_image'). Under raw interpolation
      // this would have served T1's payload; post-fix it MUST miss.
      const fromT2 = await runWithTenantContext(
        { tenant_id: 'acme', agent_id: 'agent-2' },
        async () => {
          return getCachedVision<{ tag: string }>('dev:parse_image', 'sha-X');
        },
      );
      expect(fromT2).toBeNull();
    });

    it('tool name with `:` is URI-encoded (segment boundary stays unambiguous)', async () => {
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('weird:tool', 'sha-X', { kind: 'boleto' });
      });
      const writes = ops.filter((o) => o.op === 'setex');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.key).toBe('maia:vision:tenant-A:weird%3Atool:sha-X');
    });

    it('sha256 with `:` is URI-encoded (segment boundary stays unambiguous)', async () => {
      // file_sha256 is `z.string().min(1)` (parse-image.ts), so the schema
      // does NOT enforce a hex shape — any non-empty string is accepted.
      // Encode it too: defence in depth against a future caller passing a
      // delimiter-bearing identifier here.
      const { setCachedVision } = await import('@/tools/_vision-cache.js');
      await runWithTenantContext(A_CTX, async () => {
        await setCachedVision('parse_image', 'sha:with:colons', { kind: 'boleto' });
      });
      const writes = ops.filter((o) => o.op === 'setex');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.key).toBe(
        'maia:vision:tenant-A:parse_image:sha%3Awith%3Acolons',
      );
    });

    it('round-trip with delimiter-bearing tenant id works (encode is reversible-shaped)', async () => {
      // The encode is consistent across get/set, so a write+read in the
      // SAME (delimiter-bearing) tenant still round-trips correctly.
      const { setCachedVision, getCachedVision } = await import('@/tools/_vision-cache.js');
      const got = await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'agent-1' },
        async () => {
          await setCachedVision('parse_image', 'sha-RT', { kind: 'boleto', tag: 'rt' });
          return getCachedVision<{ kind: string; tag: string }>('parse_image', 'sha-RT');
        },
      );
      expect(got).toEqual({ kind: 'boleto', tag: 'rt' });
    });
  });
});

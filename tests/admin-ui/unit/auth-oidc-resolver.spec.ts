/**
 * Issue #164 — OIDC sign-in must reject ambiguous tenant bindings.
 *
 * Surfaced by Codex Adversarial Review round 3 on PR #163. The bug was
 * introduced by PR #162: `resolveOidcAppUser(email)` iterated
 * `OIDC_TENANT_SLUGS` and returned the FIRST verified `app_users` row that
 * matched the IdP-provided email. Because `app_users` is only unique on
 * (tenant_id, email), the same email can legitimately exist in multiple
 * tenants — a real OIDC IdP wired against `OIDC_TENANT_SLUGS=acme,foundry,demo`
 * would silently bind a colliding user to whichever slug appeared first. That
 * is a tenant-isolation failure.
 *
 * Fix (this PR): fail-closed when the email matches in more than one allowed
 * tenant; sign-in returns null → NextAuth surfaces AccessDenied.
 *
 * These tests would all have FALSELY PASSED on the pre-fix "first wins"
 * implementation only for the "0 tenants" and "1 tenant" cases. The "≥ 2
 * tenants" case is the regression guard.
 *
 * Test harness note: `auth.ts` imports `next-auth` at module top, which is
 * only installed inside `src/admin-ui/node_modules/`, NOT at the repo root
 * where vitest runs. We mock `next-auth`, `next-auth/providers/credentials`,
 * and the repositories module so `auth.ts` is loadable from the root test
 * runner. This matches the indirection already used in `auth-gating.spec.ts`
 * (which avoids the problem by importing from the sibling `auth-gating.ts`
 * module — that file's existence is itself a precedent for this pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth: () => null }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: () => ({}) }));
vi.mock('@/db/repositories.js', () => ({
  appUsersRepo: {
    getByEmail: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
  },
  tenantsRepo: { findById: vi.fn() },
}));

// Static import is fine because the mocks above are hoisted by vi.mock.
import { resolveOidcAppUser, type ResolveOidcAppUserDeps } from '@/admin-ui/lib/auth.js';

type AppUserRow = {
  id: string;
  tenant_id: string;
  email: string;
  email_verified: Date | null;
  role: string | null;
  name: string | null;
  image: string | null;
};

type TenantRow = {
  id: string;
  status: 'active' | 'suspended';
};

/**
 * Build a deps bag backed by in-memory maps keyed by (tenant_id, email) /
 * tenant_id. Mirrors the production repos' contracts narrowly — we only need
 * `getByEmail` and `findById`.
 */
function makeDeps(opts: {
  appUsers?: AppUserRow[];
  tenants?: TenantRow[];
}): ResolveOidcAppUserDeps & {
  _logger: { warnings: Array<{ msg: string; meta?: Record<string, unknown> }> };
} {
  const usersByKey = new Map<string, AppUserRow>();
  for (const u of opts.appUsers ?? []) {
    usersByKey.set(`${u.tenant_id}::${u.email}`, u);
  }
  const tenantsById = new Map<string, TenantRow>();
  for (const t of opts.tenants ?? []) tenantsById.set(t.id, t);

  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

  return {
    appUsersRepo: {
      async getByEmail(tenant_id: string, email: string) {
        return usersByKey.get(`${tenant_id}::${email}`) ?? null;
      },
    },
    tenantsRepo: {
      async findById(id: string) {
        const row = tenantsById.get(id);
        return row
          ? ({
              ...row,
              nome: id,
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            } as unknown as TenantRow)
          : null;
      },
    },
    logger: {
      warn(msg: string, meta?: Record<string, unknown>) {
        warnings.push({ msg, meta });
      },
    },
    _logger: { warnings },
  };
}

function makeOwner(tenant_id: string, email: string, overrides: Partial<AppUserRow> = {}): AppUserRow {
  return {
    id: `user-${tenant_id}-${email}`,
    tenant_id,
    email,
    email_verified: new Date('2025-01-01T00:00:00Z'),
    role: 'owner',
    name: null,
    image: null,
    ...overrides,
  };
}

const SAVED_OIDC_TENANT_SLUGS = process.env.OIDC_TENANT_SLUGS;
beforeEach(() => {
  process.env.OIDC_TENANT_SLUGS = 'acme,foundry,demo';
});
afterEach(() => {
  if (SAVED_OIDC_TENANT_SLUGS === undefined) delete process.env.OIDC_TENANT_SLUGS;
  else process.env.OIDC_TENANT_SLUGS = SAVED_OIDC_TENANT_SLUGS;
});

describe('resolveOidcAppUser — issue #164 ambiguous-tenant fix', () => {
  it('email present in exactly 1 allowed tenant ⇒ user resolved (happy path preserved)', async () => {
    const deps = makeDeps({
      appUsers: [makeOwner('foundry', 'alice@example.com')],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('alice@example.com', deps);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-foundry-alice@example.com');
    expect(result!.email).toBe('alice@example.com');
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('email present in 2 allowed tenants ⇒ sign-in REJECTED (fail-closed)', async () => {
    const deps = makeDeps({
      appUsers: [
        makeOwner('foundry', 'collision@example.com'),
        makeOwner('demo', 'collision@example.com'),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('collision@example.com', deps);
    expect(result).toBeNull();

    // The operator-facing warning must fire and name the colliding tenants,
    // so on-call can disambiguate at the IdP / app_users level.
    expect(deps._logger.warnings).toHaveLength(1);
    const w = deps._logger.warnings[0]!;
    expect(w.msg).toMatch(/ambiguous binding/i);
    expect((w.meta as { tenant_count: number }).tenant_count).toBe(2);
    expect(((w.meta as { tenants: string[] }).tenants).sort()).toEqual(['demo', 'foundry']);
  });

  it('email present in all 3 allowed tenants ⇒ sign-in REJECTED', async () => {
    const deps = makeDeps({
      appUsers: [
        makeOwner('acme', 'everywhere@example.com'),
        makeOwner('foundry', 'everywhere@example.com'),
        makeOwner('demo', 'everywhere@example.com'),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('everywhere@example.com', deps);
    expect(result).toBeNull();
    expect(deps._logger.warnings).toHaveLength(1);
    expect((deps._logger.warnings[0]!.meta as { tenant_count: number }).tenant_count).toBe(3);
  });

  it('email present in 0 allowed tenants ⇒ null (no warning — not ambiguous, just unknown)', async () => {
    const deps = makeDeps({
      appUsers: [],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('ghost@example.com', deps);
    expect(result).toBeNull();
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('email in 2 tenants but ONE is filtered out by unverified email ⇒ resolves (only 1 valid candidate)', async () => {
    // Verifies that ambiguity is computed on the POST-FILTER candidate set,
    // not on the raw row matches. A row that can't sign in anyway must not
    // contribute to the ambiguity count.
    const deps = makeDeps({
      appUsers: [
        makeOwner('foundry', 'mixed@example.com'),
        makeOwner('demo', 'mixed@example.com', { email_verified: null }),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('mixed@example.com', deps);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-foundry-mixed@example.com');
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('email in 2 tenants but ONE has unknown role ⇒ resolves to the other (only 1 valid candidate)', async () => {
    const deps = makeDeps({
      appUsers: [
        makeOwner('foundry', 'rolecheck@example.com', { role: 'superuser' }),
        makeOwner('demo', 'rolecheck@example.com'),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('rolecheck@example.com', deps);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-demo-rolecheck@example.com');
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('email in 2 tenants but ONE tenant is suspended (non-founder) ⇒ resolves to the active one', async () => {
    const deps = makeDeps({
      appUsers: [
        makeOwner('foundry', 'tcheck@example.com'),
        makeOwner('demo', 'tcheck@example.com'),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'suspended' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('tcheck@example.com', deps);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-demo-tcheck@example.com');
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('two FOUNDERs with the same email across tenants ⇒ still ambiguous, still rejected', async () => {
    // Founders bypass the active-tenant check (so they can recover a suspended
    // tenant) but they DO NOT bypass the ambiguity check — otherwise a
    // foundry+demo collision in the founder role would still pick whichever
    // tenant comes first in the env list. Tenant isolation is the higher
    // invariant.
    const deps = makeDeps({
      appUsers: [
        makeOwner('foundry', 'founder@example.com', { role: 'founder' }),
        makeOwner('demo', 'founder@example.com', { role: 'founder' }),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'suspended' },
        { id: 'demo', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('founder@example.com', deps);
    expect(result).toBeNull();
    expect(deps._logger.warnings).toHaveLength(1);
    expect((deps._logger.warnings[0]!.meta as { tenant_count: number }).tenant_count).toBe(2);
  });

  it('OIDC_TENANT_SLUGS empty ⇒ null (no slugs to search)', async () => {
    process.env.OIDC_TENANT_SLUGS = '';
    const deps = makeDeps({
      appUsers: [makeOwner('foundry', 'alice@example.com')],
      tenants: [{ id: 'foundry', status: 'active' }],
    });
    const result = await resolveOidcAppUser('alice@example.com', deps);
    expect(result).toBeNull();
    expect(deps._logger.warnings).toHaveLength(0);
  });

  it('OIDC_TENANT_SLUGS=acme (single-tenant) ⇒ ambiguity impossible by construction', async () => {
    // Smoke test for the recommended single-tenant deployment. There's only
    // one tenant in the search space, so ambiguity cannot arise.
    process.env.OIDC_TENANT_SLUGS = 'acme';
    const deps = makeDeps({
      appUsers: [
        makeOwner('acme', 'single@example.com'),
        // Even though `foundry` has the same email, it's not in OIDC_TENANT_SLUGS,
        // so the resolver never sees it.
        makeOwner('foundry', 'single@example.com'),
      ],
      tenants: [
        { id: 'acme', status: 'active' },
        { id: 'foundry', status: 'active' },
      ],
    });
    const result = await resolveOidcAppUser('single@example.com', deps);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-acme-single@example.com');
    expect(deps._logger.warnings).toHaveLength(0);
  });
});

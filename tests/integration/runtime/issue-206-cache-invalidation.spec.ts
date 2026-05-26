/**
 * Issue #206 follow-up (Codex round 2, [HIGH]) — Stale identity cache after
 * profile state change (freeze / rollback / new activation).
 *
 * PR #206 wired the real `OperationalProfilePort` into the production builder
 * singleton, but `IdentitySliceBuilder` still caches by `(tenant, agent, depth)`
 * only — NOT by the active profile version's id/status. The identity cache
 * TTL is 300s (jittered). Result: once a profile body is cached, a later
 * freeze / rollback / new-activation does NOT cause the next packet build to
 * re-enter `repo.getActive()` until TTL expires. The agent keeps serving
 * revoked operational instructions for minutes after the control-plane state
 * declared them inactive.
 *
 * `wireDefaultInvalidationHandlers` exists in
 * `src/runtime/context-packet/cache/invalidation-bus.ts` but is NOT wired in
 * production — no caller in `src/` dispatches any `identity_profile_*` event
 * (`grep -r 'identity_profile_activated\|identity_profile_rolled_back' src`
 * returns only the bus's own taxonomy literal). Wiring the event bus would
 * require:
 *   (a) injecting a bus singleton into every `operationalProfileVersionsRepo`
 *       write path (transition/seedNewActiveAtomic/escalateRollback),
 *   (b) dispatching post-tx (which can fail / race the cached turn between
 *       commit and delivery), and
 *   (c) booting `wireDefaultInvalidationHandlers` at agent core startup.
 *
 * This PR takes the simpler self-healing approach (option B in the rescue
 * brief): include the active profile's `id+status` in the identity cache
 * key. When state changes (freeze → frozen, rollback → null, new active →
 * different id), the cache key naturally differs and the next `build()` call
 * misses, re-reading the post-state-change row. No event bus, no missed
 * events, no race between commit and dispatch.
 *
 * Tenant isolation: the cache key still embeds `(tenant_id, agent_id)`, so
 * profile ids from a different tenant cannot collide with ours.
 *
 * Test strategy:
 *   - prime the production singleton's identity cache by invoking
 *     `builders.identity.build()` (NOT `buildContextPacket` — keeps the test
 *     focused on the identity slice surface)
 *   - flip the mocked `getActive()` to a different state (frozen, rolled-back,
 *     or new active row) without touching the cache directly
 *   - assert the NEXT `build()` call reports `cache_hit: false` AND returns
 *     a slice consistent with the post-flip state
 *
 * Each test uses a unique `(tenant_id, agent_id)` pair so the
 * production-builder-set's process-lifetime singleton cache cannot leak
 * primed entries between cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type {
  AgentOperationalProfileVersion,
  ProfileBody,
} from '@/db/schema.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

// ─── Hoisted mock: operationalProfileVersionsRepo.getActive ───────────────────

const { getActiveMock } = vi.hoisted(() => ({
  getActiveMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    operationalProfileVersionsRepo: {
      ...actual.operationalProfileVersionsRepo,
      getActive: getActiveMock,
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const profileBody = (role: string): ProfileBody =>
  ({
    schema_version: 'v3.1.1-2026-05-15',
    identity: {
      role_descriptor: role,
      voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      priorities: [],
      principles: ['transparência radical'],
      learned_voice_modifiers: [],
    },
  }) as unknown as ProfileBody;

const buildRow = (args: {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: 'active' | 'frozen' | 'rolled_back' | 'proposed';
  role: string;
  version?: number;
}): AgentOperationalProfileVersion => ({
  id: args.id,
  tenant_id: args.tenant_id,
  agent_id: args.agent_id,
  version: args.version ?? 1,
  status: args.status,
  profile_body: profileBody(args.role) as unknown as Record<string, unknown>,
  proposed_by: 'system',
  proposed_reason: null,
  approved_by: 'system',
  approved_at: new Date('2026-01-01T00:00:00Z'),
  activated_at: new Date('2026-01-01T00:00:00Z'),
  frozen_at: args.status === 'frozen' ? new Date('2026-01-02T00:00:00Z') : null,
  rolled_back_at:
    args.status === 'rolled_back' ? new Date('2026-01-02T00:00:00Z') : null,
  rollback_reason: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
});

const buildBase = (tenant_id: string, agent_id: string): BaseContextPacket => ({
  trace_id: `trace-${tenant_id}`,
  tenant_id,
  agent_id,
  session_id: 's1',
  conversation_id: `conv-${tenant_id}`,
  channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
  actor: {
    user_id: 'u1',
    pessoa_id: 'p1',
    role: 'end_user',
    is_authenticated: true,
  },
  input: {
    kind: 'text',
    content_ref: 'r1',
    content_hmac: 'h1',
    received_at: new Date().toISOString(),
  },
  active_procedure_execution_id: null,
  feature_flags_snapshot: { FEATURE_CONTEXT_PACKET_V1: true },
  entered_at_ms: 0,
  active_sensitive_memory_count: 0,
});

const buildIdentityInput = (tenant_id: string, agent_id: string) => ({
  base: buildBase(tenant_id, agent_id),
  requirements: { depth: 'full' as const },
  // IdentitySliceBuilder doesn't use `decision` — minimal stub.
  decision: undefined as unknown as Parameters<
    import('@/runtime/context-assembly/slice-builders/_types.js').SliceBuilder<
      unknown,
      unknown
    >['build']
  >[0]['decision'],
  signal: AbortSignal.timeout(600),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Issue #206 — identity cache invalidation on profile state change', () => {
  beforeEach(async () => {
    getActiveMock.mockReset();
    // The production-builder-set singleton's InMemorySliceCache persists
    // across tests (and across vitest retries) by design. Clearing it before
    // each test gives a clean slate — otherwise a retry would observe the
    // primed cache from the failed first attempt.
    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { cache } = getProductionBuilderSet();
    cache.clear();
  });

  it('freeze of the active profile causes next build() to miss the cache (no stale identity)', async () => {
    const tenant_id = 'tenant-issue206-freeze';
    const agent_id = 'agent-issue206-freeze';
    const profile_id = 'profile-issue206-freeze-v1';

    // Step 1: profile A is active — prime cache via first build().
    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: profile_id,
        tenant_id,
        agent_id,
        status: 'active',
        role: 'Assistente A',
      }),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    const first = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );

    expect(first.cache_hit).toBe(false);
    expect(first.slice.role_descriptor).toBe('Assistente A');
    expect(first.slice.version_id).toBe(profile_id);

    // Step 2: profile A is now frozen — the real port returns null (its
    // `status !== 'active'` guard). With version-keyed cache, the cache key
    // for "no-active" is different from "active=profile_id" → MISS.
    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: profile_id,
        tenant_id,
        agent_id,
        status: 'frozen',
        role: 'Assistente A',
      }),
    );

    const second = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );

    // (a) The builder MUST NOT return the stale "Assistente A" slice from
    //     the cache primed when profile A was still active.
    expect(second.cache_hit).toBe(false);

    // (b) The slice reflects the post-freeze state (EMPTY_IDENTITY-shaped:
    //     role_descriptor='' when no active profile).
    expect(second.slice.role_descriptor).toBe('');
    expect(second.slice.principles).toBeUndefined();

    // (c) The repo was re-queried (proving cache did not short-circuit).
    expect(getActiveMock).toHaveBeenCalledTimes(2);
  });

  it('rollback of the active profile causes next build() to miss the cache', async () => {
    const tenant_id = 'tenant-issue206-rollback';
    const agent_id = 'agent-issue206-rollback';
    const profile_id = 'profile-issue206-rollback-v1';

    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: profile_id,
        tenant_id,
        agent_id,
        status: 'active',
        role: 'Antes do rollback',
      }),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    const first = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );
    expect(first.slice.role_descriptor).toBe('Antes do rollback');

    // Profile A rolled back → port returns null (no active row).
    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: profile_id,
        tenant_id,
        agent_id,
        status: 'rolled_back',
        role: 'Antes do rollback',
      }),
    );

    const second = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );

    expect(second.cache_hit).toBe(false);
    expect(second.slice.role_descriptor).toBe('');
  });

  it('new active profile (different id) causes next build() to miss the cache and return the new slice', async () => {
    const tenant_id = 'tenant-issue206-new-active';
    const agent_id = 'agent-issue206-new-active';

    // v1 active.
    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: 'profile-v1',
        tenant_id,
        agent_id,
        status: 'active',
        role: 'Versão 1',
        version: 1,
      }),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    const first = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );
    expect(first.slice.role_descriptor).toBe('Versão 1');
    expect(first.slice.version_id).toBe('profile-v1');

    // v1 frozen + v2 promoted to active (same caller, different row).
    getActiveMock.mockImplementationOnce(async () =>
      buildRow({
        id: 'profile-v2',
        tenant_id,
        agent_id,
        status: 'active',
        role: 'Versão 2',
        version: 2,
      }),
    );

    const second = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );

    // (a) MUST be a cache miss — different active row id.
    expect(second.cache_hit).toBe(false);
    // (b) Fresh data, not stale v1.
    expect(second.slice.role_descriptor).toBe('Versão 2');
    expect(second.slice.version_id).toBe('profile-v2');
  });

  it('cache hit still occurs when state has NOT changed (same active id between calls)', async () => {
    // Regression guard: the fix must not pessimize the steady-state. With
    // identical mock results between calls, the second build() MUST report
    // cache_hit=true. Without this assertion, a naive "disable cache" fix
    // would pass the freeze tests above while destroying performance.
    const tenant_id = 'tenant-issue206-stable';
    const agent_id = 'agent-issue206-stable';
    const profile_id = 'profile-issue206-stable-v1';

    getActiveMock.mockImplementation(async () =>
      buildRow({
        id: profile_id,
        tenant_id,
        agent_id,
        status: 'active',
        role: 'Steady state',
      }),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    const first = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );
    expect(first.cache_hit).toBe(false);
    expect(first.slice.role_descriptor).toBe('Steady state');

    const second = await runWithTenantContext({ tenant_id, agent_id }, () =>
      builders.identity.build(buildIdentityInput(tenant_id, agent_id)),
    );
    expect(second.cache_hit).toBe(true);
    expect(second.slice.role_descriptor).toBe('Steady state');
  });
});

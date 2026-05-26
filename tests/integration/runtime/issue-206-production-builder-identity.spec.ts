/**
 * Issue #206 — Wire real OperationalProfilePort in production-builder-set.
 *
 * Surfaced by codex round 2 review on PR #200. PR #200 correctly populates
 * `slice.principles` from migrated profile_body, but the production packet
 * factory in `src/runtime/context-packet/production-builder-set.ts` still
 * injected a `stubIdentityPort` whose `getActive()` always returned `null`.
 *
 * Net effect: with FEATURE_CONTEXT_PACKET_V1=true, the IdentitySliceBuilder
 * always saw "no active profile" → returned EMPTY_IDENTITY → migrated rows'
 * `identity.principles` (post-061 backfill) never reached the renderer, and
 * `identity.priorities` was always [] in production regardless of DB state.
 *
 * This test wires the production builder set end-to-end with a mocked
 * `operationalProfileVersionsRepo` returning a migrated row (priorities=[],
 * principles=[...]) and asserts that the rendered system prompt:
 *  (a) renders the principle text under "## Princípios"
 *  (b) does NOT leak that text into a "## Prioridades"-like line under the
 *      "## Identidade operacional" heading
 *  (c) the IdentitySliceBuilder is invoked within an AsyncLocalStorage
 *      tenant/agent context — i.e. the real port resolves tenant via
 *      runWithTenantContext, never via a passed argument.
 *
 * Pattern: vi.mock hoisted module + DIFFERENT tenant_id per test so the
 * production-builder-set's singleton cache cannot return a stale slice
 * across tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import type {
  AgentOperationalProfileVersion,
  ProfileBody,
} from '@/db/schema.js';
import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// We mock `operationalProfileVersionsRepo.getActive()`. The mock body reads
// the AsyncLocalStorage via the test file's statically-imported tenant
// context functions — the production builder set imports the same module
// instance, so both share the same storage cell.
const { getActiveMock, capturedContexts } = vi.hoisted(() => ({
  getActiveMock: vi.fn(),
  capturedContexts: [] as Array<{ tenant_id: string; agent_id: string }>,
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

// We DO NOT mock `@/db/tenant-context.js` — the test must exercise the real
// `runWithTenantContext` and `getCurrentTenant/getCurrentAgent` so we prove
// the production wiring resolves tenant via AsyncLocalStorage, not via a
// passed argument.

// ─── Fixture ──────────────────────────────────────────────────────────────────

const buildMigratedProfileBody = (): ProfileBody =>
  ({
    schema_version: 'v3.1.1-2026-05-15',
    identity: {
      role_descriptor: 'Assistente financeira',
      voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      // Migration 061: legacy rows are backfilled with priorities=[] +
      // principles=[<human-readable text>]. canonical priority slugs come
      // later via scripts/p8d-migration-priorities.ts.
      priorities: [],
      principles: ['transparência radical', 'preservar a evidência'],
      learned_voice_modifiers: [],
    },
  }) as unknown as ProfileBody;

const buildMigratedRow = (
  tenant_id: string,
  agent_id: string,
  status: 'active' | 'frozen' | 'rolled_back' | 'proposed' = 'active',
): AgentOperationalProfileVersion => ({
  id: `profile-${tenant_id}-${agent_id}`,
  tenant_id,
  agent_id,
  version: 1,
  status,
  profile_body: buildMigratedProfileBody() as unknown as Record<string, unknown>,
  proposed_by: 'system-migration-061',
  proposed_reason: null,
  approved_by: 'system-migration-061',
  approved_at: new Date('2026-01-01T00:00:00Z'),
  activated_at: new Date('2026-01-01T00:00:00Z'),
  frozen_at: status === 'frozen' ? new Date('2026-01-02T00:00:00Z') : null,
  rolled_back_at: null,
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

const buildDecision = async (): Promise<DecisionPacket> => {
  const { DEFAULT_CONTEXT_REQUIREMENTS } = await import(
    '@/runtime/context-packet/types.js'
  );
  return {
    trace_id: 't',
    intent: { label: 'x', confidence: 0.8 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: { agent_id: 'agent-maia', candidate_skill_ids: [] },
    action_mode: 'respond',
    tool_permissions: {
      allowed_tools: [],
      blocked_tools: [],
      requires_confirmation: [],
    },
    context_requirements: { ...DEFAULT_CONTEXT_REQUIREMENTS },
    evaluation_plan: {
      validators: [],
      llm_judge_required: false,
      human_review_required: false,
    },
    policy_decisions: [],
    rationale: 'test',
  };
};

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('Issue #206 — production-builder-set wires real OperationalProfilePort', () => {
  beforeEach(() => {
    getActiveMock.mockReset();
    capturedContexts.length = 0;
  });

  it('IdentitySliceBuilder calls operationalProfileVersionsRepo.getActive (NOT stubIdentityPort)', async () => {
    // Each test uses a unique tenant_id so the production-builder-set's
    // singleton SliceCache cannot serve a stale slice from another test.
    const tenant_id = 'tenant-issue206-a';
    const agent_id = 'agent-issue206-a';

    getActiveMock.mockImplementation(async () => {
      // The mock body inspects the AsyncLocalStorage. The real
      // operationalProfileVersionsRepo.getActive() does the same internally
      // via getCurrentTenant() — we mirror that contract here to prove the
      // call site is inside the tenant context (instead of leaking
      // tenant_id via an argument).
      capturedContexts.push({
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
      });
      return buildMigratedRow(tenant_id, agent_id, 'active');
    });

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    await runWithTenantContext({ tenant_id, agent_id }, async () => {
      const result = await builders.identity.build({
        base: buildBase(tenant_id, agent_id),
        requirements: { depth: 'full' },
        // The IdentitySliceBuilder doesn't actually use `decision` — pass a
        // minimal stub to satisfy the type.
        decision: undefined as unknown as Parameters<
          typeof builders.identity.build
        >[0]['decision'],
        signal: AbortSignal.timeout(600),
      });

      // (1) The real port was called — stubIdentityPort would have
      //     returned null without ever invoking getActive.
      expect(getActiveMock).toHaveBeenCalled();

      // (2) The slice reflects the migrated row (not EMPTY_IDENTITY).
      expect(result.slice.role_descriptor).toBe('Assistente financeira');
      expect(result.slice.principles).toEqual([
        'transparência radical',
        'preservar a evidência',
      ]);
      // (3) Anti-leak: principles do NOT bleed into priorities.
      expect(result.slice.priorities).toEqual([]);
    });

    // (4) The port resolved tenant via AsyncLocalStorage, not via argument.
    expect(capturedContexts).toEqual([{ tenant_id, agent_id }]);
  });

  it('FEATURE_CONTEXT_PACKET_V1=true: rendered system prompt has "## Princípios" with text; no leak under "Prioridades:"', async () => {
    const tenant_id = 'tenant-issue206-b';
    const agent_id = 'agent-issue206-b';

    getActiveMock.mockImplementation(async () =>
      buildMigratedRow(tenant_id, agent_id, 'active'),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { buildContextPacket } = await import(
      '@/runtime/context-packet/build-context-packet.js'
    );
    const { buildPromptFromPacket } = await import(
      '@/runtime/prompt/build-prompt-from-packet.js'
    );

    const { builders } = getProductionBuilderSet();
    const base = buildBase(tenant_id, agent_id);
    const decision = await buildDecision();

    const packet = await runWithTenantContext(
      { tenant_id, agent_id },
      () =>
        buildContextPacket(
          { base, decision },
          {
            builders,
            historyLoader: async () => ({ turns: [], truncated: false }),
          },
        ),
    );

    const { system } = buildPromptFromPacket(packet);

    // (1) Identity block present.
    expect(system).toContain('## Identidade operacional');

    // (2) Princípios block rendered with both principle texts.
    expect(system).toContain('## Princípios');
    expect(system).toContain('- transparência radical');
    expect(system).toContain('- preservar a evidência');

    // (3) Anti-leak: NO line that starts with "- Prioridades:" (the legacy
    //     channel) may contain the principle text.
    const lines = system.split('\n');
    for (const line of lines) {
      if (line.startsWith('- Prioridades:')) {
        expect(line).not.toContain('transparência radical');
        expect(line).not.toContain('preservar a evidência');
      }
    }

    // (4) Packet identity slice carries the data (sanity check).
    expect(packet.identity.role_descriptor).toBe('Assistente financeira');
    expect(packet.identity.principles).toEqual([
      'transparência radical',
      'preservar a evidência',
    ]);
    expect(packet.identity.priorities).toEqual([]);
  });

  it('non-active profile (status drifted to frozen) → port returns null → empty identity slice', async () => {
    // Defense-in-depth: the real port checks status === 'active' and
    // returns null for frozen/rolled_back. This guards against a freeze
    // landing between the active-row lookup in the DB query and the
    // builder reading the result.
    const tenant_id = 'tenant-issue206-c';
    const agent_id = 'agent-issue206-c';

    getActiveMock.mockImplementation(async () =>
      // Simulate a profile that drifted to frozen between the row query
      // and the status check. The real repo's getActive query already
      // filters on status='active', but we also defend in the port adapter
      // so a future repo refactor cannot silently leak a non-active row.
      buildMigratedRow(tenant_id, agent_id, 'frozen'),
    );

    const { getProductionBuilderSet } = await import(
      '@/runtime/context-packet/production-builder-set.js'
    );
    const { builders } = getProductionBuilderSet();

    await runWithTenantContext({ tenant_id, agent_id }, async () => {
      const result = await builders.identity.build({
        base: buildBase(tenant_id, agent_id),
        requirements: { depth: 'full' },
        decision: undefined as unknown as Parameters<
          typeof builders.identity.build
        >[0]['decision'],
        signal: AbortSignal.timeout(600),
      });

      expect(result.slice.role_descriptor).toBe('');
      expect(result.slice.priorities).toEqual([]);
      expect(result.slice.principles).toBeUndefined();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa } from '../../src/db/schema.js';

/**
 * Issues #511 / #525 — the warm-cache query budget.
 *
 * The cold number (4 prompt statements) is asserted in
 * `turn-context-baseline.spec.ts` with the cache feature OFF. This spec turns it
 * ON and pins what the cache is actually worth on the second turn of an agent.
 *
 * History of the number, because it is the part that keeps moving:
 *   - #511 round 1 cached identity + capabilities + gaps → 8. Withdrawn: only
 *     profile activation published, so a revoked skill or a resolved gap stayed
 *     visible on other replicas for up to a full TTL.
 *   - #511 round 2 cached identity only → 12 (self_state path) / 11 (v2 path).
 *   - #525 batches the reads (13 statements → 4) and brings skills+gaps back as
 *     ONE `self_awareness` resource, now that every writer of both tables
 *     publishes an invalidation after commit. Warm: 3 (self_state) / 2 (v2).
 *
 * It also pins the property that makes the cache safe to enable at all: every
 * surviving read is one nothing may cache — recent messages, entities, entity
 * states (financial), facts, rules, per-subject memories and hints, and the
 * `self_state` identity fallback, which has no publisher.
 */

type Counters = Record<string, number>;

const h = vi.hoisted(() => {
  const calls: Counters = {};
  const count = <T>(name: string, impl: (...args: never[]) => T) =>
    vi.fn((...args: never[]): T => {
      calls[name] = (calls[name] ?? 0) + 1;
      return impl(...args);
    });
  return {
    calls,
    count,
    /**
     * When set, the agent has an ACTIVE operational profile v2 and identity
     * takes the cached branch. `null` (default) exercises the legacy
     * `self_state` fallback, which is deliberately NOT cached.
     */
    activeProfile: null as { version: number; status: string; profile_body: unknown } | null,
    /** Skill catalogue the batched self-awareness read returns. */
    skills: [] as Array<{ skill_name: string; confidence: string }>,
  };
});

vi.mock('../../src/config/env.js', () => ({
  config: {
    TZ: 'America/Sao_Paulo',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    FEATURE_TURN_CONTEXT_CACHE: true,
    TURN_CONTEXT_CACHE_TTL_MS: 300_000,
    TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS: 30_000,
    TURN_CONTEXT_CACHE_MAX_ENTRIES: 5_000,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  turnContextRepo: {
    loadIdentity: h.count('turnContextRepo.loadIdentity', async () => ({
      profile: h.activeProfile,
      self: { system_prompt: 'Você é a Maia.', versao: 1, resumo_aprendizados: '(vazio)' },
    })),
    loadCore: h.count('turnContextRepo.loadCore', async () => ({
      history: [],
      entities: [],
      entity_states: [],
      facts: [],
      rules: [],
    })),
    loadEnrichment: h.count('turnContextRepo.loadEnrichment', async () => ({
      memories: [],
      hints: [],
      procedure: null,
    })),
    loadSelfAwareness: h.count('turnContextRepo.loadSelfAwareness', async () => ({
      skills: h.skills,
      gaps: [],
    })),
  },
  memoryEntryRepo: { findRelevant: h.count('memoryEntryRepo.findRelevant', async () => []) },
  behavioralHintRepo: {
    findActiveForScopes: h.count('behavioralHintRepo.findActiveForScopes', async () => []),
  },
  capabilitiesSkillRepo: { listAll: h.count('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: { listByLevels: h.count('capabilityGapsRepo.listByLevels', async () => []) },
  procedureExecutionsRepo: {
    findActiveForConversa: h.count('procedureExecutionsRepo.findActiveForConversa', async () => null),
  },
  procedureDefinitionsRepo: { findById: h.count('procedureDefinitionsRepo.findById', async () => null) },
}));

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import {
  turnContextCache,
  publishTurnContextInvalidation,
  startTurnContextCacheInvalidationSubscriber,
  _resetTurnContextSubscriberForTests,
  _setTurnContextSubscriberFactoryForTests,
} from '../../src/agent/turn-context/cache.js';

const SCOPE = { tenant_id: 'acme', agent_id: 'agent-1' };

function mkCtx(): PromptContext {
  return {
    pessoa: {
      id: 'pessoa-1',
      nome: 'Owner',
      apelido: null,
      telefone_whatsapp: '+5511999999999',
      tipo: 'dono',
      status: 'ativa',
      metadata: {},
      created_at: new Date('2026-01-01T00:00:00Z'),
    } as Pessoa,
    conversa: {
      id: 'conv-1',
      pessoa_id: 'pessoa-1',
      escopo_entidades: [],
      status: 'ativa',
      metadata: {},
      created_at: new Date('2026-05-11T14:00:00Z'),
    } as Conversa,
    scope: { entidades: [], byEntity: new Map() },
    inbound: {
      id: 'msg-inbound',
      conversa_id: 'conv-1',
      direcao: 'in',
      tipo: 'texto',
      conteudo: 'oi',
      metadata: {},
      ferramentas_chamadas: [],
      created_at: new Date('2026-05-11T15:00:00Z'),
    } as Mensagem,
  };
}

function totalCalls(): number {
  return Object.values(h.calls).reduce((a, b) => a + b, 0);
}

function resetCalls(): void {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
}

describe('#511/#525 warm-cache query budget', () => {
  beforeEach(() => {
    resetCalls();
    h.activeProfile = null;
    h.skills = [];
    turnContextCache.resetForTests();
    // #511 round-1 review (P2): the cache refuses to STORE until it holds a
    // confirmed subscription to the tenant's invalidation channel. Stand up a
    // fake bus so these tests measure the cache, not the refusal — and so the
    // wiring they exercise matches production's.
    _resetTurnContextSubscriberForTests();
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
    }));
    startTurnContextCacheInvalidationSubscriber();
  });

  afterEach(() => {
    _resetTurnContextSubscriberForTests();
  });

  it('caches NOTHING while the invalidation bus is unconfirmed', async () => {
    // The safety property behind the numbers below: without a confirmed
    // subscription there is no cache at all, so there is no window in which a
    // replica serves a value it can never be told to drop.
    _resetTurnContextSubscriberForTests();
    turnContextCache.resetForTests();
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    resetCalls();
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));

    expect(totalCalls()).toBe(4);
  });

  it('drops from 4 to 3 statements on the legacy self_state path', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const cold = totalCalls();

    resetCalls();
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const warm = totalCalls();

    expect(cold).toBe(4);
    expect(warm).toBe(3);

    // Only self-awareness is served from cache on this path. Identity is
    // re-read because the answer it produced was the UNCACHEABLE `self_state`
    // fallback; everything else must be re-read every turn.
    expect(Object.keys(h.calls).sort()).toEqual([
      'turnContextRepo.loadCore',
      'turnContextRepo.loadEnrichment',
      'turnContextRepo.loadIdentity',
    ]);
  });

  /**
   * #511 round-2 review, P2. `identity` used to cache the DERIVED value across
   * both branches, including the `self_state` fallback — but
   * `selfStateRepo.appendLearning` rewrites `resumo_aprendizados` from the
   * fire-and-forget reflection path with no publisher, so another replica could
   * render a stale summary until the TTL.
   *
   * #525 keeps that, and adds the reason the negative answer is not cached
   * either: a cached "no active profile v2" would not save the round-trip,
   * because the uncacheable fallback lives in the same statement.
   */
  it('re-reads self_state every turn, so a new learning shows up immediately', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    resetCalls();

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));

    expect(h.calls['turnContextRepo.loadIdentity']).toBe(1);
  });

  it('caches the rendered profile when an operational profile v2 IS active', async () => {
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const cold = totalCalls();
    resetCalls();
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const warm = totalCalls();

    expect(cold).toBe(4);
    // Identity AND self-awareness are both served from cache: the warm turn is
    // two statements — core and enrichment, neither of which may ever be cached.
    expect(warm).toBe(2);
    expect(h.calls['turnContextRepo.loadIdentity']).toBeUndefined();
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBeUndefined();
  });

  /**
   * Issue #525 — the property that lets `capabilities`/`gaps` be cached at all.
   *
   * #511 pulled them out because a revoked skill could survive in cache for a
   * TTL. The trade is only acceptable if an invalidation makes it disappear on
   * the NEXT turn, so that is what is asserted — the publisher, not the TTL.
   */
  it('a revoked skill is gone on the very next turn after invalidation', async () => {
    h.skills = [{ skill_name: 'conciliar_extrato', confidence: '0.910' }];

    const first = await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    expect(first.system).toContain('conciliar_extrato');

    // Second turn WITHOUT invalidation: served from cache, no re-read.
    resetCalls();
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBeUndefined();

    // The revocation commits and publishes (this is what
    // `capabilitiesSkillRepo.upsertConfidence` does after its write).
    h.skills = [];
    await publishTurnContextInvalidation({
      ...SCOPE,
      resource: 'self_awareness',
      publisher: { publish: async () => 1 },
    });

    resetCalls();
    const third = await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBe(1);
    expect(third.system).not.toContain('conciliar_extrato');
  });

  it('does NOT reuse one agent cached context for another agent', async () => {
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    resetCalls();

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-2' }, () =>
      buildPrompt(mkCtx()),
    );

    // A second agent in the same tenant is a cold cache, not a free ride.
    expect(h.calls['turnContextRepo.loadIdentity']).toBe(1);
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBe(1);
    expect(totalCalls()).toBe(4);
  });

  it('does NOT reuse one tenant cached context for another tenant', async () => {
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    resetCalls();

    await runWithTenantContext({ tenant_id: 'globex', agent_id: 'agent-1' }, () =>
      buildPrompt(mkCtx()),
    );

    expect(totalCalls()).toBe(4);
  });

  it('invalidating one tenant self-awareness leaves another tenant cache intact', async () => {
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    await runWithTenantContext({ tenant_id: 'globex', agent_id: 'agent-1' }, () =>
      buildPrompt(mkCtx()),
    );

    await publishTurnContextInvalidation({
      tenant_id: 'acme',
      agent_id: 'agent-1',
      resource: 'self_awareness',
      publisher: { publish: async () => 1 },
    });

    resetCalls();
    await runWithTenantContext({ tenant_id: 'globex', agent_id: 'agent-1' }, () =>
      buildPrompt(mkCtx()),
    );
    // globex was untouched: still fully warm.
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBeUndefined();

    resetCalls();
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    expect(h.calls['turnContextRepo.loadSelfAwareness']).toBe(1);
  });
});

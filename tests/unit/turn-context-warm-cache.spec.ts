import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa } from '../../src/db/schema.js';

/**
 * Issue #511 — the warm-cache query budget.
 *
 * The cold number is asserted in `turn-context-round-trips.spec.ts` with the
 * cache feature OFF. This spec turns it ON and pins what the cache is actually
 * worth on the second turn of an agent: exactly ONE query, the operational
 * profile lookup.
 *
 * Round-1 review, P1: this used to be 8, because `capabilities` and `gaps` were
 * cached too. They were removed — only profile activation published an
 * invalidation, so a revoked skill or a resolved gap could stay visible on
 * another replica for a full TTL. Three queries back is the price of not
 * showing an agent a capability it no longer has.
 *
 * It also pins the property that makes the cache safe to enable at all — every
 * surviving read is one nothing may cache: recent messages, entities, entity
 * states (financial), facts, rules, the per-subject memory/hint reads, and the
 * capability/gap reads that now have no publisher coverage.
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
     * When set, the agent has an ACTIVE operational profile v2 and the prompt
     * takes the cached branch. `null` (default) exercises the legacy
     * `self_state` fallback, which is deliberately NOT cached.
     */
    activeProfile: null as { version: number; status: string; profile_body: unknown } | null,
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
  operationalProfileVersionsRepo: {
    getActive: h.count('operationalProfileVersionsRepo.getActive', async () => h.activeProfile),
  },
  selfStateRepo: {
    getActive: h.count('selfStateRepo.getActive', async () => ({
      system_prompt: 'Você é a Maia.',
      versao: 1,
      resumo_aprendizados: '(vazio)',
    })),
  },
  mensagensRepo: {
    recentInConversation: h.count('mensagensRepo.recentInConversation', async () => []),
  },
  entidadesRepo: {
    byIds: h.count('entidadesRepo.byIds', async () => []),
    // Issue #525 — entity rows and their state rows in ONE statement.
    byIdsWithState: h.count('entidadesRepo.byIdsWithState', async () => []),
  },
  entityStatesRepo: { byIds: h.count('entityStatesRepo.byIds', async () => []) },
  factsRepo: { listMentionableForScopes: h.count('factsRepo.listMentionableForScopes', async () => []) },
  rulesRepo: { listActive: h.count('rulesRepo.listActive', async () => []) },
  memoryEntryRepo: { findRelevant: h.count('memoryEntryRepo.findRelevant', async () => []) },
  behavioralHintRepo: {
    findActiveForScopes: h.count('behavioralHintRepo.findActiveForScopes', async () => []),
  },
  capabilitiesSkillRepo: { listAll: h.count('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: {
    listByLevel: h.count('capabilityGapsRepo.listByLevel', async () => []),
    listByLevels: h.count('capabilityGapsRepo.listByLevels', async () => []),
  },
  procedureExecutionsRepo: {
    findActiveForConversa: h.count('procedureExecutionsRepo.findActiveForConversa', async () => null),
  },
  procedureDefinitionsRepo: { findById: h.count('procedureDefinitionsRepo.findById', async () => null) },
}));

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import {
  turnContextCache,
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

describe('#511 warm-cache query budget', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.calls)) delete h.calls[k];
    h.activeProfile = null;
    turnContextCache.resetForTests();
    // Round-1 review (P2): the cache refuses to STORE until it holds a
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
    // replica serves an identity it can never be told to drop.
    _resetTurnContextSubscriberForTests();
    turnContextCache.resetForTests();

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    for (const k of Object.keys(h.calls)) delete h.calls[k];
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));

    expect(totalCalls()).toBe(11);
  });

  it('drops from 11 to 10 queries on the legacy self_state path', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const cold = totalCalls();

    for (const k of Object.keys(h.calls)) delete h.calls[k];
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const warm = totalCalls();

    expect(cold).toBe(11);
    expect(warm).toBe(10);

    // Only the operational-profile lookup is served from cache (as a negative
    // entry: "no active profile v2"). Everything else is re-read every turn —
    // because it must be (conversation state, financial state, per-subject
    // knowledge) or because it has no invalidation publisher (capabilities,
    // gaps, and the self_state fallback).
    expect(Object.keys(h.calls).sort()).toEqual([
      'behavioralHintRepo.findActiveForScopes',
      'capabilitiesSkillRepo.listAll',
      'capabilityGapsRepo.listByLevels',
      'entidadesRepo.byIdsWithState',
      'factsRepo.listMentionableForScopes',
      'memoryEntryRepo.findRelevant',
      'mensagensRepo.recentInConversation',
      'procedureExecutionsRepo.findActiveForConversa',
      'rulesRepo.listActive',
      'selfStateRepo.getActive',
    ]);
  });

  /**
   * Round-2 review, P2. `identity` used to cache the DERIVED value across both
   * branches, including the `self_state` fallback — but
   * `selfStateRepo.appendLearning` rewrites `resumo_aprendizados` from the
   * fire-and-forget reflection path with no publisher, so another replica could
   * render a stale summary until the TTL.
   */
  it('re-reads self_state every turn, so a new learning shows up immediately', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    for (const k of Object.keys(h.calls)) delete h.calls[k];

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));

    expect(h.calls['selfStateRepo.getActive']).toBe(1);
    // The profile lookup IS still cached — only the uncovered branch was pulled
    // out, not the whole resource.
    expect(h.calls['operationalProfileVersionsRepo.getActive']).toBeUndefined();
  });

  it('caches the rendered profile when an operational profile v2 IS active', async () => {
    h.activeProfile = { version: 7, status: 'active', profile_body: {} };

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const cold = totalCalls();
    for (const k of Object.keys(h.calls)) delete h.calls[k];
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    const warm = totalCalls();

    // The v2 path never reads self_state at all, so cold is one lower and the
    // cache removes the remaining identity query.
    expect(cold).toBe(10);
    expect(warm).toBe(9);
    expect(h.calls['operationalProfileVersionsRepo.getActive']).toBeUndefined();
    expect(h.calls['selfStateRepo.getActive']).toBeUndefined();
  });

  it('a revoked skill is visible on the very next turn (no TTL window)', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    for (const k of Object.keys(h.calls)) delete h.calls[k];

    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));

    // The catalogue is re-read every turn, so a revocation that commits
    // between two turns takes effect on the next one — not after a TTL.
    expect(h.calls['capabilitiesSkillRepo.listAll']).toBe(1);
    // Issue #525 — ONE gap read now serves both gap blocks.
    expect(h.calls['capabilityGapsRepo.listByLevels']).toBe(1);
    expect(h.calls['capabilityGapsRepo.listByLevel']).toBeUndefined();
  });

  it('does NOT reuse one agent cached identity for another agent', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    for (const k of Object.keys(h.calls)) delete h.calls[k];

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-2' }, () =>
      buildPrompt(mkCtx()),
    );

    // A second agent in the same tenant is a cold cache, not a free ride.
    expect(h.calls['operationalProfileVersionsRepo.getActive']).toBe(1);
    expect(h.calls['selfStateRepo.getActive']).toBe(1);
    expect(totalCalls()).toBe(11);
  });

  it('does NOT reuse one tenant cached identity for another tenant', async () => {
    await runWithTenantContext(SCOPE, () => buildPrompt(mkCtx()));
    for (const k of Object.keys(h.calls)) delete h.calls[k];

    await runWithTenantContext({ tenant_id: 'globex', agent_id: 'agent-1' }, () =>
      buildPrompt(mkCtx()),
    );

    expect(totalCalls()).toBe(11);
  });
});

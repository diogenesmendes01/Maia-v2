import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa, Permissao, PermissionProfile } from '../../src/db/schema.js';

/**
 * Issue #511 — TURN-CONTEXT QUERY BUDGET (kept as the SLOPE guard).
 *
 * Issue #525 moved the exact-count budget to
 * `tests/unit/turn-context-round-trips.spec.ts`, which counts the loader-backed
 * read set and enforces `TURN_ROUND_TRIP_BUDGET`. This file keeps the property
 * #511 was really about — the cost does not grow with scope size — plus the
 * `resolveScope` batching and its cross-tenant counterfactual.
 *
 * The numbers here are the FALLBACK numbers: these mocks stub only
 * `entidadesRepo.byIds` + `entityStatesRepo.byIds`, so the loader takes its
 * two-read compatibility path. Production stubs `byIdsWithState` and pays one.
 *
 * "Reduce queries by at least 50%" is meaningless without a number, so this
 * spec is the number. It counts every repository round-trip the turn-context
 * path makes and asserts the exact figure, for 1 / 10 / 100 entities.
 *
 * Measured baseline (commit 1 of this issue, before any batching):
 *
 *   entities |  1  |  10  |  100
 *   ---------+-----+------+------
 *   prompt   | 15  |  24  |  114
 *   scope    |  2  |  11  |  101
 *   turn     | 17  |  35  |  215
 *
 * The cost was AFFINE in scope size: one `entityStatesRepo.byId` per entity in
 * the prompt builder, one `profilesRepo.byId` per permission in `resolveScope`,
 * and one behavioural-hint query per scope. That slope was the N+1.
 *
 * Current budget, asserted below (loader compatibility path):
 *
 *   entities |  1  |  10  |  100  | vs baseline
 *   ---------+-----+------+-------+------------
 *   prompt   | 12  |  12  |   12  |
 *   scope    |  2  |   2  |    2  |
 *   turn     | 14  |  14  |   14  | -18% / -60% / -93%
 *
 * With the batched entity read wired (production), the same turn is 13.
 *
 * The slope is now ZERO — the property that actually matters, because it is
 * what stops one "elephant" tenant from monopolising the fixed 10-connection
 * pool (`src/db/client.ts`) and stalling every other tenant's turn.
 *
 * Counting is done at the repository boundary rather than against a live
 * Postgres because every repo method here is exactly one statement, so the two
 * numbers coincide — and this spec then runs in the unit suite with no DB.
 * The production counter (`src/db/query-counter.ts`) measures the real
 * round-trips and is asserted separately.
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
    /** Scope tuples handed to the batched hint query, per call. */
    hintScopeCalls: [] as Array<Array<{ scope_type: string }>>,
    /**
     * Profile ids the batch read must NOT return — models a profile that
     * exists in `permissoes` but not under the running tenant.
     */
    missingProfiles: new Set<string>(),
  };
});

/** Entity ids for a scope of size `n`. */
function entityIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `ent-${i}`);
}

vi.mock('../../src/db/repositories.js', () => ({
  // --- identity ---------------------------------------------------------
  operationalProfileVersionsRepo: {
    getActive: h.count('operationalProfileVersionsRepo.getActive', async () => null),
  },
  selfStateRepo: {
    getActive: h.count('selfStateRepo.getActive', async () => ({
      system_prompt: 'Você é a Maia.',
      versao: 1,
      resumo_aprendizados: '(vazio)',
    })),
  },
  // --- conversation -----------------------------------------------------
  mensagensRepo: {
    recentInConversation: h.count('mensagensRepo.recentInConversation', async () => []),
  },
  // --- scope ------------------------------------------------------------
  entidadesRepo: {
    byIds: h.count('entidadesRepo.byIds', async (ids: string[]) =>
      ids.map((id) => ({ id, nome: `Entidade ${id}` })),
    ),
  },
  entityStatesRepo: {
    byId: h.count('entityStatesRepo.byId', async (id: string) => ({
      entidade_id: id,
      saldo_consolidado: '100',
      proximo_vencimento: null,
    })),
    byIds: h.count('entityStatesRepo.byIds', async (ids: string[]) =>
      ids.map((id) => ({ entidade_id: id, saldo_consolidado: '100', proximo_vencimento: null })),
    ),
  },
  // --- knowledge --------------------------------------------------------
  factsRepo: {
    listMentionableForScopes: h.count('factsRepo.listMentionableForScopes', async () => []),
  },
  rulesRepo: { listActive: h.count('rulesRepo.listActive', async () => []) },
  // --- memory -----------------------------------------------------------
  memoryEntryRepo: { findRelevant: h.count('memoryEntryRepo.findRelevant', async () => []) },
  behavioralHintRepo: {
    findActiveForScope: h.count('behavioralHintRepo.findActiveForScope', async () => []),
    findActiveForScopes: h.count(
      'behavioralHintRepo.findActiveForScopes',
      async (scopes: Array<{ scope_type: string }>) => {
        h.hintScopeCalls.push(scopes);
        return [];
      },
    ),
  },
  // --- capabilities -----------------------------------------------------
  capabilitiesSkillRepo: { listAll: h.count('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: {
    listByLevel: h.count('capabilityGapsRepo.listByLevel', async () => []),
    listParaOTurno: h.count('capabilityGapsRepo.listParaOTurno', async () => []),
  },
  // --- procedures -------------------------------------------------------
  procedureExecutionsRepo: {
    findActiveForConversa: h.count('procedureExecutionsRepo.findActiveForConversa', async () => null),
  },
  procedureDefinitionsRepo: {
    findById: h.count('procedureDefinitionsRepo.findById', async () => null),
  },
  // --- permissions (resolveScope) --------------------------------------
  permissoesRepo: {
    forPessoa: h.count('permissoesRepo.forPessoa', async () => permissoesFixture),
  },
  profilesRepo: {
    byId: h.count('profilesRepo.byId', async (id: string) => mkProfile(id)),
    byIds: h.count('profilesRepo.byIds', async (ids: string[]) =>
      ids.filter((id) => !h.missingProfiles.has(id)).map(mkProfile),
    ),
  },
  pessoasRepo: { list: h.count('pessoasRepo.list', async () => []) },
}));

vi.mock('../../src/config/env.js', () => ({ config: { TZ: 'America/Sao_Paulo' } }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { resolveScope, type ResolvedPermission } from '../../src/governance/permissions.js';

// `permissoesFixture` is reassigned per scope size before each resolveScope run.
let permissoesFixture: Permissao[] = [];

function mkProfile(id: string): PermissionProfile {
  return {
    id,
    nome: id,
    acoes: ['*'],
    limite_default: '1000',
  } as unknown as PermissionProfile;
}

function mkPessoa(): Pessoa {
  return {
    id: 'pessoa-1',
    nome: 'Owner',
    apelido: null,
    telefone_whatsapp: '+5511999999999',
    tipo: 'dono',
    status: 'ativa',
    profile_id: null,
    metadata: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
  } as Pessoa;
}

function mkConversa(): Conversa {
  return {
    id: 'conv-1',
    pessoa_id: 'pessoa-1',
    escopo_entidades: [],
    status: 'ativa',
    contexto_resumido: null,
    ultima_atividade_em: new Date('2026-05-11T15:00:00Z'),
    metadata: {},
    created_at: new Date('2026-05-11T14:00:00Z'),
  } as Conversa;
}

function mkInbound(): Mensagem {
  return {
    id: 'msg-inbound',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    midia_url: null,
    metadata: {},
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
    created_at: new Date('2026-05-11T15:00:00Z'),
  } as Mensagem;
}

function mkScope(n: number): PromptContext['scope'] {
  const entidades = entityIds(n);
  const byEntity = new Map<string, ResolvedPermission>();
  for (const id of entidades) {
    byEntity.set(id, {
      permissao: { id: `perm-${id}`, entidade_id: id, profile_id: `profile-${id}`, status: 'ativa', limites: {} } as unknown as Permissao,
      profile: mkProfile(`profile-${id}`),
      effective_limits: { valor_max: 1000 },
    });
  }
  return { entidades, byEntity };
}

function totalCalls(): number {
  return Object.values(h.calls).reduce((a, b) => a + b, 0);
}

function resetCalls(): void {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
  h.hintScopeCalls.length = 0;
  h.missingProfiles.clear();
}

describe('#511 baseline — turn-context query cost', () => {
  beforeEach(() => {
    resetCalls();
  });

  describe('prompt builder', () => {
    /**
     * Cost of the typical turn (no operational profile v2 → self_state
     * fallback, no active role/channel, no active procedure):
     *
     *   operationalProfileVersionsRepo.getActive        1
     *   selfStateRepo.getActive                         1
     *   mensagensRepo.recentInConversation              1
     *   entidadesRepo.byIds                             1
     *   entityStatesRepo.byIds                          1  (was: 1 per entity)
     *   factsRepo.listMentionableForScopes              1
     *   rulesRepo.listActive                            1
     *   memoryEntryRepo.findRelevant                    1
     *   behavioralHintRepo.findActiveForScopes          1  (was: 1 per scope)
     *   capabilitiesSkillRepo.listAll                   1
     *   procedureExecutionsRepo.findActiveForConversa   1
     *   capabilityGapsRepo.listParaOTurno                 1  (was TWO gap reads)
     *                                                  --
     *                                                  12, independent of N
     *
     * Issue #525 removed `capabilityGapsRepo.listByLevel`: the mentionable-only
     * list is a filter over the mentionable-OR-proposed rows this already
     * loads, so the second statement bought nothing.
     */
    const PROMPT_BUDGET = 12;

    it.each([1, 10, 100])('costs a CONSTANT %i-independent budget for %i entities', async (n) => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(n),
        inbound: mkInbound(),
      });

      // The N+1 is gone: one batched statement, whatever the scope size.
      expect(h.calls['entityStatesRepo.byIds']).toBe(1);
      expect(h.calls['entityStatesRepo.byId']).toBeUndefined();
      expect(totalCalls()).toBe(PROMPT_BUDGET);
    });

    it('requests every hint scope in ONE query, not one per scope', async () => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(1),
        inbound: mkInbound(),
        current_role_id: 'role-1',
        current_channel_id: 'chan-1',
      });
      expect(h.calls['behavioralHintRepo.findActiveForScope']).toBeUndefined();
      expect(h.calls['behavioralHintRepo.findActiveForScopes']).toBe(1);
      // …and it still asks for all five scopes.
      const scopes = (h.hintScopeCalls.at(-1) ?? []).map((s) => s.scope_type);
      expect(scopes).toEqual([
        'interlocutor',
        'conversation',
        'role',
        'channel',
        'agent',
      ]);
    });
  });

  describe('resolveScope', () => {
    it.each([1, 10, 100])('costs 2 queries for %i permissions', async (n) => {
      permissoesFixture = entityIds(n).map(
        (id) =>
          ({
            id: `perm-${id}`,
            entidade_id: id,
            profile_id: `profile-${id}`,
            status: 'ativa',
            limites: {},
          }) as unknown as Permissao,
      );

      const resolved = await resolveScope(mkPessoa());

      // Same resolved scope as the per-permission loop produced, at constant cost.
      expect(resolved.entidades).toHaveLength(n);
      expect(h.calls['permissoesRepo.forPessoa']).toBe(1);
      expect(h.calls['profilesRepo.byId']).toBeUndefined();
      expect(h.calls['profilesRepo.byIds']).toBe(1);
      expect(totalCalls()).toBe(2);
    });

    it('skips a permission whose profile does not resolve (fail-closed)', async () => {
      permissoesFixture = [
        {
          id: 'perm-ok',
          entidade_id: 'ent-ok',
          profile_id: 'profile-ok',
          status: 'ativa',
          limites: {},
        },
        {
          id: 'perm-orphan',
          entidade_id: 'ent-orphan',
          // Not returned by the batch read — e.g. it belongs to another tenant.
          profile_id: 'profile-missing',
          status: 'ativa',
          limites: {},
        },
      ] as unknown as Permissao[];
      h.missingProfiles.add('profile-missing');

      const resolved = await resolveScope(mkPessoa());

      expect(resolved.entidades).toEqual(['ent-ok']);
      expect(resolved.byEntity.has('ent-orphan')).toBe(false);
    });

    /**
     * COUNTERFACTUAL for the cross-tenant assertion in
     * `tests/integration/turn-context-batch-repos.spec.ts`
     * ("resolveScope no longer resolves a foreign profile into a grant").
     *
     * That integration test asserts `scope.entidades` is `[]` when the only
     * permission points at a profile owned by ANOTHER tenant. An assertion is
     * only worth having if it can go red, and the pre-#511 code is gone, so
     * this pins the other half: when the profile lookup DOES return the foreign
     * row — exactly what the old unscoped `profilesRepo.byId(id)` did, matching
     * on `WHERE id = $1` with no tenant predicate — the permission resolves
     * into a real grant carrying that other tenant's action list and spend
     * limit, and `entidades` is `['ent-foreign']`, not `[]`.
     *
     * So: old lookup behaviour ⇒ the integration assertion fails; scoped lookup
     * ⇒ it passes. The assertion discriminates.
     *
     * What this does NOT prove is that the SQL predicate in
     * `profilesRepo.byIds` really excludes the other tenant's row — that needs
     * a real Postgres and is the integration test's own job in CI.
     */
    it('COUNTERFACTUAL: an unscoped profile lookup WOULD have granted the foreign profile', async () => {
      permissoesFixture = [
        {
          id: 'perm-foreign',
          entidade_id: 'ent-foreign',
          profile_id: 'profile-of-other-tenant',
          status: 'ativa',
          limites: {},
        },
      ] as unknown as Permissao[];
      // `missingProfiles` deliberately NOT set: the lookup returns the foreign
      // profile, which is precisely the old unscoped `byId` behaviour.

      const resolved = await resolveScope(mkPessoa());

      expect(resolved.entidades).toEqual(['ent-foreign']);
      const grant = resolved.byEntity.get('ent-foreign');
      expect(grant?.profile.id).toBe('profile-of-other-tenant');
      // The leak was never abstract: the foreign profile carries the action
      // list and the spend ceiling this person would have been allowed.
      expect(grant?.profile.acoes).toEqual(['*']);
      expect(grant?.effective_limits.valor_max).toBe(1000);
    });
  });

  describe('whole turn', () => {
    it.each([
      [1, 14],
      [10, 14],
      [100, 14],
    ])('for %i entities the turn costs %i queries', async (n, expected) => {
      permissoesFixture = entityIds(n).map(
        (id) =>
          ({
            id: `perm-${id}`,
            entidade_id: id,
            profile_id: `profile-${id}`,
            status: 'ativa',
            limites: {},
          }) as unknown as Permissao,
      );

      const scope = await resolveScope(mkPessoa());
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope,
        inbound: mkInbound(),
      });

      expect(totalCalls()).toBe(expected);
    });
  });
});

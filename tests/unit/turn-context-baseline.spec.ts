import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa, Permissao, PermissionProfile } from '../../src/db/schema.js';

/**
 * Issues #511 / #525 — TURN-CONTEXT QUERY BUDGET.
 *
 * "Reduce queries by at least 50%" is meaningless without a number, so this
 * spec is the number. It counts every repository round-trip the turn-context
 * path makes and asserts the EXACT figure, for 1 / 10 / 100 entities.
 *
 *   entities        |  1  |  10  |  100  | what changed
 *   ----------------+-----+------+-------+---------------------------------
 *   pre-#511        | 17  |  35  |  215  | affine in scope size (the N+1)
 *   #511 (cold)     | 15  |  15  |   15  | slope zero, constant still 15
 *   #525 (cold)     |  6  |   6  |    6  | 4 batched statements + 2 scope
 *   #525 (warm)     |  4  |   4  |    4  | identity + self_awareness cached
 *
 * The slope went to zero in #511 — the property that actually matters, because
 * it is what stops one "elephant" tenant from monopolising the fixed
 * 10-connection pool (`src/db/client.ts`). #525 attacks the CONSTANT, which is
 * what the typical 1-entity turn actually pays: 17 → 6 is −65%, and the issue's
 * ≤8 round-trip ceiling is met with two to spare.
 *
 * Counting is done at the repository boundary rather than against a live
 * Postgres because every method counted here is exactly ONE statement — a
 * property asserted independently, without a database, in
 * `tests/unit/turn-context-statements.spec.ts` (no `;` outside a literal), and
 * against a real Postgres by the production counter
 * (`src/db/query-counter.ts`) in `tests/integration/turn-context-batch-repos.spec.ts`.
 *
 * The 4 batched statements are grouped by FAILURE SEMANTICS, not by table:
 * `core` holds the reads whose failure fails the turn, `enrichment` and
 * `self_awareness` the ones that degrade their own sections.
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
    /** Scope tuples handed to the batched enrichment read, per call. */
    hintScopeCalls: [] as Array<Array<{ scope_type: string }>>,
    /** Procedure mode the loader asked for, per call. */
    procedureModes: [] as string[],
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
  // --- #525 batched turn-context surface --------------------------------
  turnContextRepo: {
    loadIdentity: h.count('turnContextRepo.loadIdentity', async () => ({
      profile: null,
      self: { system_prompt: 'Você é a Maia.', versao: 1, resumo_aprendizados: '(vazio)' },
    })),
    loadCore: h.count(
      'turnContextRepo.loadCore',
      async (args: { entidade_ids: string[] }) => ({
        history: [],
        entities: args.entidade_ids.map((id) => ({ id, nome: `Entidade ${id}` })),
        entity_states: args.entidade_ids.map((id) => ({
          entidade_id: id,
          saldo_consolidado: '100',
          proximo_vencimento: null,
        })),
        facts: [],
        rules: [],
      }),
    ),
    loadEnrichment: h.count(
      'turnContextRepo.loadEnrichment',
      async (args: {
        hint_scopes: Array<{ scope_type: string }>;
        procedure: { mode: string };
      }) => {
        h.hintScopeCalls.push(args.hint_scopes);
        h.procedureModes.push(args.procedure.mode);
        return { memories: [], hints: [], procedure: null };
      },
    ),
    loadSelfAwareness: h.count('turnContextRepo.loadSelfAwareness', async () => ({
      skills: [],
      gaps: [],
    })),
  },

  // --- per-section fallbacks (used only when a batch fails) -------------
  memoryEntryRepo: { findRelevant: h.count('memoryEntryRepo.findRelevant', async () => []) },
  behavioralHintRepo: {
    findActiveForScopes: h.count('behavioralHintRepo.findActiveForScopes', async () => []),
  },
  capabilitiesSkillRepo: { listAll: h.count('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: {
    listByLevels: h.count('capabilityGapsRepo.listByLevels', async () => []),
  },
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

vi.mock('../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo', FEATURE_TURN_CONTEXT_CACHE: false },
}));
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
  h.procedureModes.length = 0;
  h.missingProfiles.clear();
}

describe('#511/#525 baseline — turn-context query cost', () => {
  beforeEach(() => {
    resetCalls();
  });

  describe('prompt builder', () => {
    /**
     * Cost of the typical turn (no operational profile v2 → self_state
     * fallback, no active role/channel, no active procedure):
     *
     *   turnContextRepo.loadIdentity        1  (was 2: profile + self_state)
     *   turnContextRepo.loadCore           1  (was 5: history, entidades,
     *                                          entity_states, facts, rules)
     *   turnContextRepo.loadEnrichment     1  (was 3: memories, hints,
     *                                          procedure execution)
     *   turnContextRepo.loadSelfAwareness  1  (was 3: skills + gaps ×2)
     *                                     --
     *                                      4, independent of N
     */
    const PROMPT_BUDGET = 4;

    it.each([1, 10, 100])('costs a CONSTANT %i-independent budget for %i entities', async (n) => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(n),
        inbound: mkInbound(),
      });

      expect(h.calls['turnContextRepo.loadCore']).toBe(1);
      expect(totalCalls()).toBe(PROMPT_BUDGET);
    });

    it('never reaches a repository directly — the renderer is pure', async () => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(1),
        inbound: mkInbound(),
      });
      // The per-section methods exist only as the failure-path retry. On the
      // happy path NONE of them runs; if one does, a read leaked back into the
      // renderer or a batch silently fell back.
      for (const name of [
        'memoryEntryRepo.findRelevant',
        'behavioralHintRepo.findActiveForScopes',
        'capabilitiesSkillRepo.listAll',
        'capabilityGapsRepo.listByLevels',
        'procedureExecutionsRepo.findActiveForConversa',
        'procedureDefinitionsRepo.findById',
      ]) {
        expect(h.calls[name], name).toBeUndefined();
      }
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
      expect(h.calls['turnContextRepo.loadEnrichment']).toBe(1);
      // …and it still asks for all five scopes.
      const scopes = (h.hintScopeCalls.at(-1) ?? []).map((s) => s.scope_type);
      expect(scopes).toEqual(['interlocutor', 'conversation', 'role', 'channel', 'agent']);
    });

    it('does not ask for a procedure the caller already ruled out', async () => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(1),
        inbound: mkInbound(),
        // `null` = the caller looked and found none.
        activeExecution: null,
      });
      expect(h.procedureModes.at(-1)).toBe('skip');
      expect(totalCalls()).toBe(PROMPT_BUDGET);
    });

    it('resolves a running procedure and its definition in the SAME statement', async () => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(1),
        inbound: mkInbound(),
      });
      // `undefined` = the caller did not look, so the loader looks — and the
      // definition comes back in the same round-trip (pre-#525 that was a
      // second query, issued only after the first returned).
      expect(h.procedureModes.at(-1)).toBe('lookup');
      expect(h.calls['procedureDefinitionsRepo.findById']).toBeUndefined();
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
    /**
     * THE acceptance number of issue #525: ≤8 round-trips for the typical turn
     * with no procedure. Asserted as an exact figure, not a bound, so a
     * regression that adds one back fails here instead of eroding the margin
     * silently.
     */
    it.each([
      [1, 6],
      [10, 6],
      [100, 6],
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
      expect(totalCalls()).toBeLessThanOrEqual(8);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Mensagem, Pessoa, Conversa, Permissao, PermissionProfile } from '../../src/db/schema.js';

/**
 * Issue #525 — THE ROUND-TRIP BUDGET, and its enforcement.
 *
 * `turn-context-baseline.spec.ts` (#511) established that the turn's cost has a
 * number and that the number no longer grows with scope size. This spec is the
 * half that makes the number stick: it counts every repository round-trip the
 * turn makes, asserts the EXACT figure for each path, and fails the build the
 * moment a new read appears. The budget itself lives in
 * `src/agent/turn-context/types.ts` so production code and this spec cannot
 * drift apart.
 *
 * Why the repository boundary and not a live Postgres: every repo method
 * exercised here is exactly one statement, so the two counts coincide — and
 * this spec then runs in the unit suite with no database. The production
 * counter (`src/db/query-counter.ts`, fed by the instrumented drizzle client)
 * measures the real round-trips and publishes them on
 * `maia_turn_context_db_queries{phase="loader"}`.
 *
 * Measured history of the typical turn (1 entity, no active procedure, legacy
 * `self_state` identity path — the most expensive one):
 *
 *   before #511      17
 *   after  #511/#524 15
 *   after  #525      13   ← asserted below
 *
 * The two round-trips #525 removed, and why they were removable at all:
 *
 *   - the gap catalogue was read TWICE, once as `listByLevel('mentionable')`
 *     for the self-awareness clause and once as
 *     `listParaOTurno([mentionable, proposed])` for the "known limitations"
 *     block. The second is a strict superset, so the first is a filter.
 *   - entity NAMES and entity STATES were two reads of the same entity set,
 *     joined on `entity_states.entidade_id = entidades.id`. That is a LEFT
 *     JOIN, and now it is one (`entidadesRepo.byIdsWithState`).
 *
 * Neither changes what the prompt says; both are pure duplication removal.
 * `TURN_ROUND_TRIP_TARGET` (8) is NOT met — the remaining reads are all
 * distinct tables whose merge needs a cross-table statement. See the module doc.
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
    /** Non-null → the agent has an ACTIVE operational profile v2. */
    activeProfile: null as { version: number; status: string; profile_body: unknown } | null,
    /** Repositories whose next call must reject (degradation scenarios). */
    failing: new Set<string>(),
  };
});

function entityIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `ent-${i}`);
}

/** Wrap a counted impl so `h.failing` can make it reject. */
function failable<T>(name: string, impl: (...args: never[]) => Promise<T>) {
  return h.count(name, (async (...args: never[]) => {
    if (h.failing.has(name)) throw new Error(`${name} exploded`);
    return impl(...args);
  }) as (...args: never[]) => Promise<T>);
}

vi.mock('../../src/db/repositories.js', () => ({
  operationalProfileVersionsRepo: {
    getActive: failable('operationalProfileVersionsRepo.getActive', async () => h.activeProfile),
  },
  selfStateRepo: {
    getActive: failable('selfStateRepo.getActive', async () => ({
      system_prompt: 'Você é a Maia.',
      versao: 1,
      resumo_aprendizados: '(vazio)',
    })),
  },
  mensagensRepo: {
    recentInConversation: failable('mensagensRepo.recentInConversation', async () => []),
  },
  entidadesRepo: {
    byIds: failable('entidadesRepo.byIds', async (ids: string[]) =>
      ids.map((id) => ({ id, nome: `Entidade ${id}` })),
    ),
    // The batched read the loader actually uses in production: entity rows and
    // their state rows in ONE statement.
    byIdsWithState: failable('entidadesRepo.byIdsWithState', async (ids: string[]) =>
      ids.map((id) => ({
        entidade: { id, nome: `Entidade ${id}` },
        state: { entidade_id: id, saldo_consolidado: '100', proximo_vencimento: null },
      })),
    ),
  },
  entityStatesRepo: {
    byIds: failable('entityStatesRepo.byIds', async (ids: string[]) =>
      ids.map((id) => ({ entidade_id: id, saldo_consolidado: '100', proximo_vencimento: null })),
    ),
  },
  factsRepo: { listMentionableForScopes: failable('factsRepo.listMentionableForScopes', async () => []) },
  rulesRepo: { listActive: failable('rulesRepo.listActive', async () => []) },
  memoryEntryRepo: { findRelevant: failable('memoryEntryRepo.findRelevant', async () => []) },
  behavioralHintRepo: {
    findActiveForScopes: failable('behavioralHintRepo.findActiveForScopes', async () => []),
  },
  capabilitiesSkillRepo: { listAll: failable('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: {
    listByLevel: failable('capabilityGapsRepo.listByLevel', async () => []),
    listParaOTurno: failable('capabilityGapsRepo.listParaOTurno', async () => []),
  },
  procedureExecutionsRepo: {
    findActiveForConversa: failable('procedureExecutionsRepo.findActiveForConversa', async () => null),
  },
  procedureDefinitionsRepo: { findById: failable('procedureDefinitionsRepo.findById', async () => null) },
  permissoesRepo: { forPessoa: failable('permissoesRepo.forPessoa', async () => permissoesFixture) },
  profilesRepo: {
    byId: failable('profilesRepo.byId', async (id: string) => mkProfile(id)),
    byIds: failable('profilesRepo.byIds', async (ids: string[]) => ids.map(mkProfile)),
  },
  pessoasRepo: { list: failable('pessoasRepo.list', async () => []) },
}));

vi.mock('../../src/config/env.js', () => ({ config: { TZ: 'America/Sao_Paulo' } }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildPrompt, renderTurnPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { loadTurnContext } from '../../src/agent/turn-context/loader.js';
import {
  TURN_ROUND_TRIP_BUDGET,
  TURN_ROUND_TRIP_TARGET,
} from '../../src/agent/turn-context/types.js';
import { resolveScope, type ResolvedPermission } from '../../src/governance/permissions.js';

let permissoesFixture: Permissao[] = [];

function mkProfile(id: string): PermissionProfile {
  return { id, nome: id, acoes: ['*'], limite_default: '1000' } as unknown as PermissionProfile;
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
  return { id: 'conv-1', pessoa_id: 'pessoa-1', metadata: {} } as Conversa;
}

function mkInbound(): Mensagem {
  return {
    id: 'msg-inbound',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    ferramentas_chamadas: [],
    created_at: new Date('2026-05-11T15:00:00Z'),
  } as Mensagem;
}

function mkScope(n: number): PromptContext['scope'] {
  const entidades = entityIds(n);
  const byEntity = new Map<string, ResolvedPermission>();
  for (const id of entidades) {
    byEntity.set(id, {
      permissao: { id: `perm-${id}`, entidade_id: id } as unknown as Permissao,
      profile: mkProfile(`profile-${id}`),
      effective_limits: { valor_max: 1000 },
    });
  }
  return { entidades, byEntity };
}

function mkCtx(n: number, extra: Partial<PromptContext> = {}): PromptContext {
  return {
    pessoa: mkPessoa(),
    conversa: mkConversa(),
    scope: mkScope(n),
    inbound: mkInbound(),
    ...extra,
  };
}

function totalCalls(): number {
  return Object.values(h.calls).reduce((a, b) => a + b, 0);
}

function resetCalls(): void {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
}

/** The 11 reads a prompt build makes on the legacy `self_state` path. */
const PROMPT_READS_SELF_STATE = [
  'behavioralHintRepo.findActiveForScopes',
  'capabilitiesSkillRepo.listAll',
  'capabilityGapsRepo.listParaOTurno',
  'entidadesRepo.byIdsWithState',
  'factsRepo.listMentionableForScopes',
  'memoryEntryRepo.findRelevant',
  'mensagensRepo.recentInConversation',
  'operationalProfileVersionsRepo.getActive',
  'procedureExecutionsRepo.findActiveForConversa',
  'rulesRepo.listActive',
  'selfStateRepo.getActive',
];

describe('#525 turn round-trip budget', () => {
  beforeEach(() => {
    resetCalls();
    h.activeProfile = null;
    h.failing.clear();
    permissoesFixture = [];
  });

  describe('the read set is exactly this, and no more', () => {
    it('names every read a prompt build makes on the self_state path', async () => {
      await buildPrompt(mkCtx(1));
      expect(Object.keys(h.calls).sort()).toEqual(PROMPT_READS_SELF_STATE);
      // Every read is issued ONCE. A repeated read is the duplication #525
      // removed for gaps and entity states, and it must not come back.
      expect(Object.values(h.calls)).toEqual(PROMPT_READS_SELF_STATE.map(() => 1));
    });

    it('reads the gap catalogue ONCE for both gap blocks', async () => {
      await buildPrompt(mkCtx(1));
      // `listParaOTurno([mentionable, proposed])` is a superset of
      // `listByLevel('mentionable')`, so the self-awareness clause filters the
      // rows it already has instead of paying a second statement.
      expect(h.calls['capabilityGapsRepo.listParaOTurno']).toBe(1);
      expect(h.calls['capabilityGapsRepo.listByLevel']).toBeUndefined();
    });

    it('reads entity names and entity states in ONE joined statement', async () => {
      await buildPrompt(mkCtx(1));
      expect(h.calls['entidadesRepo.byIdsWithState']).toBe(1);
      expect(h.calls['entidadesRepo.byIds']).toBeUndefined();
      expect(h.calls['entityStatesRepo.byIds']).toBeUndefined();
    });

    it('never falls back to the per-entity reads that were the old N+1', async () => {
      await buildPrompt(mkCtx(100));
      expect(h.calls['profilesRepo.byId']).toBeUndefined();
      expect(h.calls['entityStatesRepo.byIds']).toBeUndefined();
    });
  });

  describe('exact counts', () => {
    it.each([1, 10, 100])('the whole turn costs 13 round-trips for %i entities', async (n) => {
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

      expect(totalCalls()).toBe(13);
      // The ceiling, and the reason this file exists: a new read fails here.
      expect(totalCalls()).toBeLessThanOrEqual(TURN_ROUND_TRIP_BUDGET);
    });

    it('costs 12 with an active operational profile v2 (no self_state fallback)', async () => {
      h.activeProfile = { version: 7, status: 'active', profile_body: {} };
      permissoesFixture = [
        {
          id: 'perm-1',
          entidade_id: 'ent-0',
          profile_id: 'profile-0',
          status: 'ativa',
          limites: {},
        } as unknown as Permissao,
      ];

      const scope = await resolveScope(mkPessoa());
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope,
        inbound: mkInbound(),
      });

      expect(h.calls['selfStateRepo.getActive']).toBeUndefined();
      expect(totalCalls()).toBe(12);
    });

    it('costs one less when core.ts already resolved the active procedure', async () => {
      // `core.ts` loads the execution before the Decision Engine gate and hands
      // it over (`activeExecution: null` = "I looked, there is none"), so the
      // prompt build must NOT look again.
      await buildPrompt(mkCtx(1, { activeExecution: null }));
      expect(h.calls['procedureExecutionsRepo.findActiveForConversa']).toBeUndefined();
      expect(totalCalls()).toBe(10);
    });

    it('costs the same with a resolved role and channel as without', async () => {
      await buildPrompt(mkCtx(1));
      const withoutRole = totalCalls();
      resetCalls();

      await buildPrompt(mkCtx(1, { current_role_id: 'role-1', current_channel_id: 'chan-1' }));

      // Hints used to be one round-trip PER SCOPE; a resolved role + channel
      // added two. `findActiveForScopes` ORs the tuples into one statement.
      expect(totalCalls()).toBe(withoutRole);
      expect(h.calls['behavioralHintRepo.findActiveForScopes']).toBe(1);
    });
  });

  /**
   * The point of a pure renderer, stated as a number: rendering is worth ZERO
   * round-trips. If a future edit reintroduces a lazy read inside a render
   * helper, this goes red — and it goes red without needing to know WHERE the
   * read was hidden.
   */
  describe('the renderer is worth zero round-trips', () => {
    it('renders a full prompt with the counters at zero', async () => {
      const ctx = mkCtx(3, { current_role_id: 'role-1', activeExecution: null });
      const snapshot = await loadTurnContext({
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        entidade_ids: ctx.scope.entidades,
        current_role_id: ctx.current_role_id,
        activeExecution: null,
      });

      resetCalls();
      const { system, messages } = renderTurnPrompt(ctx, snapshot);

      expect(totalCalls()).toBe(0);
      expect(system).toContain('## Escopo desta conversa');
      expect(messages.at(-1)?.content).toContain('oi');
    });

    it('produces the same bytes as buildPrompt for the same snapshot', async () => {
      const ctx = mkCtx(2, { activeExecution: null });
      const snapshot = await loadTurnContext({
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        entidade_ids: ctx.scope.entidades,
        activeExecution: null,
      });
      resetCalls();

      const direct = renderTurnPrompt(ctx, snapshot);
      const viaBuild = await buildPrompt(ctx);

      // The only difference between the two is the wall-clock line in
      // "## Estado atual"; normalise it and the rest must match byte for byte.
      const strip = (s: string): string => s.replace(/- Agora: .*\n/, '');
      expect(strip(direct.system)).toBe(strip(viaBuild.system));
      expect(direct.messages).toEqual(viaBuild.messages);
    });

    it('prompt-builder.ts imports NO repository', async () => {
      const src = await readFile(
        new URL('../../src/agent/prompt-builder.ts', import.meta.url),
        'utf8',
      );
      // Acceptance criterion #1 of issue #525, checked at the source level
      // because it is a structural claim, not a behavioural one.
      expect(src).not.toMatch(/from '@\/db\/repositories/);
      expect(src).not.toMatch(/from '\.\.\/db\/repositories/);
    });
  });

  /**
   * Degradation is a budget question too: a failing OPTIONAL section must not
   * make the turn cheaper by silently skipping the rest, nor more expensive by
   * retrying, and a failing CRITICAL section must fail the turn rather than
   * render a prompt that quietly omits the agent's identity.
   */
  describe('degradation does not change the budget', () => {
    it('a failed memory read degrades ONE section and costs the same', async () => {
      h.failing.add('memoryEntryRepo.findRelevant');
      const { system } = await buildPrompt(mkCtx(1));
      expect(totalCalls()).toBe(11);
      expect(system).not.toContain('## Memória relevante');
      // …and the neighbouring optional sections still ran.
      expect(h.calls['behavioralHintRepo.findActiveForScopes']).toBe(1);
      expect(h.calls['capabilitiesSkillRepo.listAll']).toBe(1);
    });

    it('a failed gap read degrades the gap blocks but NOT the skills clause', async () => {
      h.failing.add('capabilityGapsRepo.listParaOTurno');
      const { system } = await buildPrompt(mkCtx(1));
      expect(system).not.toContain('## Limitações conhecidas');
      expect(h.calls['capabilitiesSkillRepo.listAll']).toBe(1);
    });

    it('a failed CRITICAL read fails the turn (fail-closed, no partial prompt)', async () => {
      h.failing.add('factsRepo.listMentionableForScopes');
      await expect(buildPrompt(mkCtx(1))).rejects.toThrow(
        'factsRepo.listMentionableForScopes exploded',
      );
    });
  });

  it('the declared budget is above the goal issue #525 still targets', () => {
    // Honest bookkeeping rather than a green tick on a goal that is not met:
    // the ceiling this suite enforces is 13, the goal is 8, and the gap is
    // documented in docs/architecture/modules/agent.md with the merge each
    // remaining round-trip would need.
    expect(TURN_ROUND_TRIP_BUDGET).toBe(13);
    expect(TURN_ROUND_TRIP_TARGET).toBe(8);
    expect(TURN_ROUND_TRIP_BUDGET).toBeGreaterThan(TURN_ROUND_TRIP_TARGET);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mensagem, Pessoa, Conversa, Permissao, PermissionProfile } from '../../src/db/schema.js';

/**
 * Issue #511 — INSTRUMENTED BASELINE.
 *
 * "Reduce queries by at least 50%" is meaningless without a number, so this
 * spec is the number. It counts every repository round-trip the turn-context
 * path makes today and asserts the exact figure, for 1 / 10 / 100 entities.
 *
 * Two properties are locked here:
 *
 *  1. The ABSOLUTE cost of the typical turn (the value the optimisation is
 *     measured against). If it moves, this test fails and whoever moved it has
 *     to say so in the diff.
 *
 *  2. The GROWTH RATE. Today the cost is affine in the entity count — the
 *     prompt builder runs one `entityStatesRepo.byId` per entity
 *     (`src/agent/prompt-builder.ts`, entityStateBlocks loop) and `resolveScope`
 *     runs one `profilesRepo.byId` per permission
 *     (`src/governance/permissions.ts`). That slope IS the N+1 the issue is
 *     about. The post-optimisation spec asserts slope zero against these same
 *     fixtures.
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
  return { calls, count };
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
  },
  // --- capabilities -----------------------------------------------------
  capabilitiesSkillRepo: { listAll: h.count('capabilitiesSkillRepo.listAll', async () => []) },
  capabilityGapsRepo: {
    listByLevel: h.count('capabilityGapsRepo.listByLevel', async () => []),
    listByLevels: h.count('capabilityGapsRepo.listByLevels', async () => []),
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
}

describe('#511 baseline — turn-context query cost', () => {
  beforeEach(() => {
    resetCalls();
  });

  describe('prompt builder waterfall', () => {
    /**
     * Fixed cost of the typical turn (no operational profile v2 → self_state
     * fallback, no active role/channel, no active procedure):
     *
     *   operationalProfileVersionsRepo.getActive        1
     *   selfStateRepo.getActive                         1
     *   mensagensRepo.recentInConversation              1
     *   entidadesRepo.byIds                             1
     *   factsRepo.listMentionableForScopes              1
     *   rulesRepo.listActive                            1
     *   memoryEntryRepo.findRelevant                    1
     *   behavioralHintRepo.findActiveForScope           3  (interlocutor, conversation, agent)
     *   capabilitiesSkillRepo.listAll                   1
     *   capabilityGapsRepo.listByLevel                  1
     *   procedureExecutionsRepo.findActiveForConversa   1
     *   capabilityGapsRepo.listByLevels                 1
     *                                                  --
     *                                                  14
     *
     * plus ONE `entityStatesRepo.byId` per entity — the N+1.
     */
    const FIXED = 14;

    it.each([1, 10, 100])('costs FIXED + N queries for %i entities', async (n) => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(n),
        inbound: mkInbound(),
      });

      expect(h.calls['entityStatesRepo.byId']).toBe(n);
      expect(totalCalls()).toBe(FIXED + n);
    });

    it('issues exactly one behavioural-hint query PER SCOPE (not one batched query)', async () => {
      await buildPrompt({
        pessoa: mkPessoa(),
        conversa: mkConversa(),
        scope: mkScope(1),
        inbound: mkInbound(),
        current_role_id: 'role-1',
        current_channel_id: 'chan-1',
      });
      // interlocutor + conversation + role + channel + agent
      expect(h.calls['behavioralHintRepo.findActiveForScope']).toBe(5);
    });
  });

  describe('resolveScope permission waterfall', () => {
    it.each([1, 10, 100])('costs 1 + N queries for %i permissions', async (n) => {
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

      expect(resolved.entidades).toHaveLength(n);
      expect(h.calls['permissoesRepo.forPessoa']).toBe(1);
      expect(h.calls['profilesRepo.byId']).toBe(n);
      expect(totalCalls()).toBe(1 + n);
    });
  });

  describe('whole-turn baseline (the number #511 must beat)', () => {
    it.each([
      [1, 17],
      [10, 35],
      [100, 215],
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

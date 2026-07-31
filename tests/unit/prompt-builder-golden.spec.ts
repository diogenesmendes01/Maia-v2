import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Conversa, Mensagem, Permissao, PermissionProfile, Pessoa, Role } from '../../src/db/schema.js';

/**
 * Issue #525 — BYTE-IDENTITY of the rendered prompt across the loader cutover.
 *
 * The issue's hard acceptance criterion is "prompt byte-idêntico ao atual para
 * um conjunto de fixtures representativo". This spec is that proof, and it is
 * designed to survive the cutover unchanged:
 *
 *   - `tests/unit/prompt-golden-world.ts` holds the fixture data, once.
 *   - the mock below exposes BOTH loading surfaces from that same data: the
 *     per-repository methods the pre-#525 waterfall called, and the batched
 *     `turnContextRepo` the `TurnContextLoader` calls.
 *   - the goldens in `tests/fixtures/prompt-golden.json` were generated from
 *     the pre-#525 implementation and are asserted verbatim afterwards.
 *
 * So the file is a genuine before/after comparison rather than a snapshot of
 * whatever the code happens to do today: the recorded bytes predate the change.
 *
 * Regenerate deliberately (and only when a prompt change is INTENDED) with
 * `UPDATE_PROMPT_GOLDEN=1 npx vitest run tests/unit/prompt-builder-golden.spec.ts`.
 */

// The mock factory is hoisted above the imports, so it cannot close over the
// fixture module. It closes over this holder instead and reads it at CALL time,
// which is after the spec body has selected the scenario.
const h = vi.hoisted(() => ({ current: null as unknown as import('./prompt-golden-world.js').GoldenScenario }));

vi.mock('../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo', FEATURE_TURN_CONTEXT_CACHE: false },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const OPTIONAL_FAILURE = new Error('optional read failed');

vi.mock('../../src/db/repositories.js', () => {
  const w = () => h.current;
  const failIfAsked = (): void => {
    if (w().failOptional) throw OPTIONAL_FAILURE;
  };
  const mentionable = () => w().gaps.filter((g) => g.current_level === 'mentionable');

  return {
    // ---- pre-#525 per-section surface -----------------------------------
    operationalProfileVersionsRepo: { getActive: async () => w().profile },
    selfStateRepo: { getActive: async () => w().self },
    mensagensRepo: { recentInConversation: async () => w().history },
    entidadesRepo: { byIds: async () => w().entities },
    entityStatesRepo: { byIds: async () => w().entityStates },
    factsRepo: { listMentionableForScopes: async () => w().facts },
    rulesRepo: { listActive: async () => w().rules },
    memoryEntryRepo: {
      findRelevant: async () => {
        failIfAsked();
        return w().memories;
      },
    },
    behavioralHintRepo: {
      findActiveForScopes: async () => {
        failIfAsked();
        return w().hints;
      },
    },
    capabilitiesSkillRepo: {
      listAll: async () => {
        failIfAsked();
        return w().skills;
      },
    },
    capabilityGapsRepo: {
      listByLevel: async () => {
        failIfAsked();
        return mentionable();
      },
      listByLevels: async () => {
        failIfAsked();
        return w().gaps;
      },
    },
    procedureExecutionsRepo: {
      findActiveForConversa: async () => {
        failIfAsked();
        return w().procedure?.execution ?? null;
      },
    },
    procedureDefinitionsRepo: {
      findById: async () => {
        failIfAsked();
        return w().procedure?.definition ?? null;
      },
    },

    // ---- #525 batched surface -------------------------------------------
    turnContextRepo: {
      loadIdentity: async () => ({ profile: w().profile, self: w().self }),
      loadCore: async () => ({
        history: w().history,
        entities: w().entities,
        entity_states: w().entityStates,
        facts: w().facts,
        rules: w().rules,
      }),
      loadEnrichment: async () => {
        failIfAsked();
        return {
          memories: w().memories,
          hints: w().hints,
          procedure: w().procedure,
        };
      },
      loadSelfAwareness: async () => {
        failIfAsked();
        return { skills: w().skills, gaps: w().gaps };
      },
    },
  };
});

import { buildPrompt, type PromptContext } from '../../src/agent/prompt-builder.js';
import { SCENARIOS, type GoldenScenario } from './prompt-golden-world.js';

const GOLDEN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/prompt-golden.json',
);
const UPDATING = process.env.UPDATE_PROMPT_GOLDEN === '1';

type Golden = Record<string, { system: string; messages: Array<{ role: string; content: string }> }>;

function loadGoldens(): Golden {
  if (!existsSync(GOLDEN_PATH)) return {};
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
}

const goldens = loadGoldens();
const produced: Golden = {};

function mkProfile(id: string): PermissionProfile {
  return { id, nome: id, acoes: ['*'], limite_default: '1000' } as unknown as PermissionProfile;
}

function mkCtx(s: GoldenScenario): PromptContext {
  const byEntity = new Map();
  for (const [i, id] of s.ctx.entidades.entries()) {
    byEntity.set(id, {
      permissao: { id: `perm-${id}`, entidade_id: id, profile_id: `profile-${id}` } as unknown as Permissao,
      profile: mkProfile(`profile-${id}`),
      // Alternate so both limit renderings ("sem limite individual" and a
      // concrete ceiling) appear in the goldens.
      effective_limits: { valor_max: i % 2 === 0 ? 1000 : null },
    });
  }
  return {
    pessoa: {
      id: 'pessoa-1',
      nome: 'Owner',
      apelido: 'Chefe',
      telefone_whatsapp: '+5511999999999',
      tipo: 'dono',
      status: 'ativa',
      preferencias: {},
      metadata: {},
      created_at: new Date('2026-01-01T00:00:00Z'),
    } as unknown as Pessoa,
    conversa: {
      id: 'conv-1',
      pessoa_id: 'pessoa-1',
      escopo_entidades: [],
      status: 'ativa',
      metadata: s.ctx.last_scope_hash ? { last_scope_hash: s.ctx.last_scope_hash } : {},
      created_at: new Date('2026-05-11T14:00:00Z'),
    } as unknown as Conversa,
    scope: { entidades: s.ctx.entidades, byEntity },
    inbound: {
      id: 'msg-inbound',
      conversa_id: 'conv-1',
      direcao: 'in',
      tipo: 'texto',
      conteudo: s.ctx.inbound_conteudo ?? 'oi',
      metadata: {},
      ferramentas_chamadas: [],
      created_at: new Date('2026-05-11T15:00:00.000Z'),
    } as unknown as Mensagem,
    activeRole: (s.ctx.activeRole ?? null) as Role | null,
    current_role_id: s.ctx.current_role_id ?? null,
    current_channel_id: s.ctx.current_channel_id ?? null,
  };
}

describe('#525 prompt byte-identity across the loader cutover', () => {
  beforeAll(() => {
    // `## Estado atual` renders `Agora: <now>`. Only Date is faked so the
    // async machinery keeps running normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-11T18:04:05.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    if (UPDATING) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, JSON.stringify(produced, null, 2) + '\n', 'utf8');
    }
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    'renders %s byte-for-byte as recorded',
    async (name, scenario) => {
      h.current = scenario;
      const built = await buildPrompt(mkCtx(scenario));
      produced[name] = built as Golden[string];

      if (UPDATING) {
        expect(built.system.length).toBeGreaterThan(0);
        return;
      }

      const expected = goldens[name];
      expect(
        expected,
        `no golden recorded for "${name}" — run with UPDATE_PROMPT_GOLDEN=1`,
      ).toBeDefined();
      // Compare the SYSTEM block first: it is the part the loader rewrite
      // touches, and a byte diff here is the failure the issue cares about.
      expect(built.system).toBe(expected!.system);
      expect(Buffer.byteLength(built.system, 'utf8')).toBe(
        Buffer.byteLength(expected!.system, 'utf8'),
      );
      expect(built.messages).toEqual(expected!.messages);
    },
  );
});

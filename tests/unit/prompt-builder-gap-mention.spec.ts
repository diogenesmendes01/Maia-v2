/**
 * P5 Task 10 — prompt-builder injeta seção de "Limitações conhecidas" para
 * gaps em nível mentionable/proposed (transparência: o agente pode mencionar
 * limitações com honestidade se o usuário tocar nos temas).
 *
 * Cenários:
 *   1. Flag OFF → seção ausente (sem consulta ao repo).
 *   2. Flag ON + zero gaps mentionable/proposed → seção ausente.
 *   3. Flag ON + 2 gaps mentionable → seção presente com ambas as linhas.
 *   4. Flag ON + 1 gap proposed → seção presente com sufixo "(proposta de melhoria já enviada)".
 *   5. Flag ON + apenas silent/dashboard → seção ausente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentCapabilityGap } from '../../src/db/schema.js';

const selfStateGetActive = vi.fn();
const operationalProfileVersionsGetActive = vi.fn();
const mensagensRecent = vi.fn();
const entidadesByIds = vi.fn();
const factsListMentionableForScopes = vi.fn();
const rulesListActive = vi.fn();
const entityStatesById = vi.fn();
const memoryEntryFindRelevant = vi.fn();
const behavioralHintFindActiveForScope = vi.fn();
const capabilitiesSkillListAll = vi.fn();
const capabilityGapsListByLevel = vi.fn();
const capabilityGapsListByLevels = vi.fn();
const procedureExecutionsFindActiveForConversa = vi.fn();
const procedureDefinitionsFindById = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  selfStateRepo: { getActive: selfStateGetActive },
  operationalProfileVersionsRepo: { getActive: operationalProfileVersionsGetActive },
  mensagensRepo: { recentInConversation: mensagensRecent },
  entidadesRepo: { byIds: entidadesByIds },
  factsRepo: { listMentionableForScopes: factsListMentionableForScopes },
  rulesRepo: { listActive: rulesListActive },
  entityStatesRepo: { byId: entityStatesById },
  memoryEntryRepo: { findRelevant: memoryEntryFindRelevant },
  behavioralHintRepo: { findActiveForScope: behavioralHintFindActiveForScope },
  capabilitiesSkillRepo: { listAll: capabilitiesSkillListAll },
  capabilityGapsRepo: {
    listByLevel: capabilityGapsListByLevel,
    listByLevels: capabilityGapsListByLevels,
  },
  procedureExecutionsRepo: { findActiveForConversa: procedureExecutionsFindActiveForConversa },
  procedureDefinitionsRepo: { findById: procedureDefinitionsFindById },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {},
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const pessoa = { id: 'p1', nome: 'Mendes', tipo: 'dono', apelido: null } as never;
const conversa = { id: 'c1' } as never;
const inbound = { id: 'm-1', conteudo: 'oi', direcao: 'in' } as never;
const ctx = {
  pessoa,
  conversa,
  scope: { entidades: [], byEntity: new Map() },
  inbound,
} as never;

function makeGap(
  level: string,
  description: string,
  overrides: Partial<AgentCapabilityGap> = {},
): AgentCapabilityGap {
  const now = new Date();
  return {
    id: `gap-${description.slice(0, 8)}`,
    tenant_id: 'default',
    agent_id: 'default',
    capability_description: description,
    tipo: 'tool',
    contexto: null,
    frequency_score: 3,
    severity_score: 3,
    current_level: level,
    source_candidate_id: null,
    last_observed: now,
    last_level_change_at: now,
    created_at: now,
    ...overrides,
  } as AgentCapabilityGap;
}

beforeEach(async () => {
  selfStateGetActive.mockReset();
  operationalProfileVersionsGetActive.mockReset();
  mensagensRecent.mockReset();
  entidadesByIds.mockReset();
  factsListMentionableForScopes.mockReset();
  rulesListActive.mockReset();
  entityStatesById.mockReset();
  memoryEntryFindRelevant.mockReset();
  behavioralHintFindActiveForScope.mockReset();
  capabilitiesSkillListAll.mockReset();
  capabilityGapsListByLevel.mockReset();
  capabilityGapsListByLevels.mockReset();
  procedureExecutionsFindActiveForConversa.mockReset();
  procedureDefinitionsFindById.mockReset();

  selfStateGetActive.mockResolvedValue({
    versao: 1,
    system_prompt: 'BODY',
    resumo_aprendizados: '(vazio)',
  });
  operationalProfileVersionsGetActive.mockResolvedValue(null);
  mensagensRecent.mockResolvedValue([]);
  entidadesByIds.mockResolvedValue([]);
  factsListMentionableForScopes.mockResolvedValue([]);
  rulesListActive.mockResolvedValue([]);
  entityStatesById.mockResolvedValue(null);
  memoryEntryFindRelevant.mockResolvedValue([]);
  behavioralHintFindActiveForScope.mockResolvedValue([]);
  capabilitiesSkillListAll.mockResolvedValue([]);
  capabilityGapsListByLevel.mockResolvedValue([]);
  capabilityGapsListByLevels.mockResolvedValue([]);
  procedureExecutionsFindActiveForConversa.mockResolvedValue(null);
  procedureDefinitionsFindById.mockResolvedValue(null);
});

describe('buildPrompt — injeção de "Limitações conhecidas" (P5 Task 10)', () => {
  it('zero gaps mentionable/proposed → seção ausente', async () => {
    capabilityGapsListByLevels.mockResolvedValue([]);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).not.toContain('## Limitações conhecidas');
    expect(capabilityGapsListByLevels).toHaveBeenCalledTimes(1);
  });

  it('3. Flag ON + 2 gaps mentionable → seção com ambas as linhas, sem sufixo de proposta', async () => {
    capabilityGapsListByLevels.mockResolvedValue([
      makeGap('mentionable', 'gerar relatório fiscal trimestral'),
      makeGap('mentionable', 'fazer cobrança automática de inadimplentes'),
    ]);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('## Limitações conhecidas (mencionar com transparência se vier à tona)');
    expect(system).toContain(
      'Se o usuário perguntar sobre gerar relatório fiscal trimestral, você pode explicar honestamente que isso é uma limitação atual.',
    );
    expect(system).toContain(
      'Se o usuário perguntar sobre fazer cobrança automática de inadimplentes, você pode explicar honestamente que isso é uma limitação atual.',
    );
    // mentionable não recebe o sufixo de proposta.
    expect(system).not.toContain('(proposta de melhoria já enviada)');
  });

  it('4. Flag ON + 1 gap proposed → seção com sufixo "(proposta de melhoria já enviada)"', async () => {
    capabilityGapsListByLevels.mockResolvedValue([
      makeGap('proposed', 'pagamento recorrente via PIX'),
    ]);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('## Limitações conhecidas (mencionar com transparência se vier à tona)');
    expect(system).toContain(
      'Se o usuário perguntar sobre pagamento recorrente via PIX, você pode explicar honestamente que isso é uma limitação atual (proposta de melhoria já enviada).',
    );
  });

  it('5. Flag ON + apenas silent/dashboard → seção ausente (listByLevels retorna [])', async () => {
    // O contrato do repo: listByLevels(['mentionable','proposed']) filtra esses
    // níveis. Gaps em silent/dashboard nem chegam aqui — simulamos retorno [].
    capabilityGapsListByLevels.mockResolvedValue([]);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).not.toContain('## Limitações conhecidas');
    // E confirma que a query passou apenas mentionable+proposed (gate #7
    // implícito: silent NUNCA aparece como argumento do listByLevels aqui).
    expect(capabilityGapsListByLevels).toHaveBeenCalledTimes(1);
    const [levelsArg] = capabilityGapsListByLevels.mock.calls[0]!;
    expect(levelsArg).toEqual(['mentionable', 'proposed']);
    expect(levelsArg).not.toContain('silent');
    expect(levelsArg).not.toContain('dashboard');
  });
});

/**
 * P6 Task 9 — prompt-builder injeta seção "## Modo operacional" entre
 * selfAwarenessSection e procedureSection (precedência da spec §10.7:
 * CHANNEL POLICY > PROCEDURE).
 *
 * Cenários:
 *   1. Flag OFF (MULTI_CHANNEL) + activeRole presente → seção AUSENTE.
 *   2. Flag ON + activeRole null/undefined           → seção AUSENTE.
 *   3. Flag ON + role com description + prompt_addendum → seção PRESENTE com ambos.
 *   4. Flag ON + role só com description             → seção PRESENTE (display_name + description).
 *   5. Flag ON + role sem description e sem addendum → seção AUSENTE.
 *
 * Bônus: validamos precedência (roleSection vem ANTES de procedureSection
 * quando ambos presentes) — defesa da invariant §10.7.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Role } from '../../src/db/schema.js';

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
  entityStatesRepo: { byId: entityStatesById, byIds: vi.fn(async () => []) },
  memoryEntryRepo: { findRelevant: memoryEntryFindRelevant },
  behavioralHintRepo: {
    findActiveForScope: behavioralHintFindActiveForScope,
    findActiveForScopes: vi.fn(async () => []),
  },
  capabilitiesSkillRepo: { listAll: capabilitiesSkillListAll },
  capabilityGapsRepo: {
    listByLevel: capabilityGapsListByLevel,
    listParaOTurno: capabilityGapsListByLevels,
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

function makeRole(overrides: Partial<Role> = {}): Role {
  const now = new Date();
  return {
    id: 'role-1',
    tenant_id: 'default',
    agent_id: 'default',
    role_key: 'comercial',
    display_name: 'Comercial',
    description: null,
    prompt_addendum: null,
    active: true,
    is_default: false,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Role;
}

function makeCtx(activeRole?: Role | null) {
  return {
    pessoa,
    conversa,
    scope: { entidades: [], byEntity: new Map() },
    inbound,
    activeRole,
  } as never;
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

describe('buildPrompt — injeção de "Modo operacional" (P6 Task 9)', () => {
  it('activeRole null/undefined → seção AUSENTE', async () => {
    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');

    const { system: systemNull } = await buildPrompt(makeCtx(null));
    expect(systemNull).not.toContain('## Modo operacional');

    const { system: systemUndef } = await buildPrompt(makeCtx(undefined));
    expect(systemUndef).not.toContain('## Modo operacional');
  });

  it('3. Flag ON + role com description + prompt_addendum → seção PRESENTE com ambos', async () => {
    const role = makeRole({
      display_name: 'Comercial',
      description: 'modo vendas consultivas',
      prompt_addendum: 'foque em qualificação BANT antes de propor preço',
    });

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(makeCtx(role));

    expect(system).toContain('## Modo operacional');
    expect(system).toContain('Você está operando como **Comercial**.');
    expect(system).toContain('modo vendas consultivas');
    expect(system).toContain('foque em qualificação BANT antes de propor preço');
  });

  it('4. Flag ON + role só com description (sem addendum) → seção PRESENTE com display_name + description', async () => {
    const role = makeRole({
      display_name: 'Onboarding',
      description: 'modo onboarding de novos clientes',
      prompt_addendum: null,
    });

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(makeCtx(role));

    expect(system).toContain('## Modo operacional');
    expect(system).toContain('Você está operando como **Onboarding**.');
    expect(system).toContain('modo onboarding de novos clientes');
  });

  it('5. Flag ON + role sem description e sem prompt_addendum → seção AUSENTE', async () => {
    const role = makeRole({
      display_name: 'Default',
      description: null,
      prompt_addendum: null,
    });

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(makeCtx(role));

    expect(system).not.toContain('## Modo operacional');
    // display_name vazio sem conteúdo concreto = nada a injetar.
    expect(system).not.toContain('Você está operando como **Default**.');
  });

  it('bonus: roleSection precede procedureSection no system prompt (spec §10.7)', async () => {
    // Mock a procedure execution active so procedureSection renders too.
    procedureExecutionsFindActiveForConversa.mockResolvedValue({
      id: 'exec-1',
      definition_id: 'def-1',
      current_step_id: 'step-1',
      status: 'in_progress',
      execution_state: {},
    });
    procedureDefinitionsFindById.mockResolvedValue({
      id: 'def-1',
      nome: 'Proc Teste',
      version_number: 1,
      steps: [
        {
          id: 'step-1',
          intencao: 'fazer X',
          como: 'do X',
          sucesso_criteria_ref: null,
          armadilhas: [],
        },
      ],
      success_criteria: [],
    });

    const role = makeRole({
      display_name: 'Comercial',
      description: 'modo vendas',
      prompt_addendum: null,
    });

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(makeCtx(role));

    const rolePos = system.indexOf('## Modo operacional');
    const procPos = system.indexOf('## Procedimento em execução');
    expect(rolePos).toBeGreaterThan(-1);
    expect(procPos).toBeGreaterThan(-1);
    expect(rolePos).toBeLessThan(procPos);
  });
});

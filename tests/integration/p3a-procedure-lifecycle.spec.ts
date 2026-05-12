import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { transitionProcedureStatus, canTransition } from '@/cognition/procedure-status.js';

// In-memory state for mocked repo. Acts as the procedure_definitions table.
const state: Record<string, any> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    procedureDefinitionsRepo: {
      findActiveByName: vi.fn(async (nome: string) => {
        return (
          Object.values(state).find(
            (d: any) => d.nome === nome && d.status === 'active',
          ) ?? null
        );
      }),
      findById: vi.fn(async (id: string) => state[id] ?? null),
      updateStatus: vi.fn(async (id: string, updates: any) => {
        if (state[id]) state[id] = { ...state[id], ...updates };
      }),
      create: vi.fn(async (input: any) => {
        const id = `def-${Math.random().toString(36).slice(2)}`;
        state[id] = { id, ...input };
        return state[id];
      }),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(state).filter((d: any) => d.status === status),
      ),
      listAllVersionsByName: vi.fn(async (nome: string) =>
        Object.values(state)
          .filter((d: any) => d.nome === nome)
          .sort((a: any, b: any) => b.version_number - a.version_number),
      ),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

describe('P3a procedure lifecycle integration', () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) delete state[k];
    vi.clearAllMocks();
  });

  it('cenário 1: draft criado com estrutura válida', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const created = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'test-proc',
          version_number: 1,
          status: 'draft',
          intencao: 'X',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);
        expect(created.id).toBeDefined();
        expect(created.status).toBe('draft');
      },
    );
  });

  it('cenário 2: draft -> proposed -> active', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const def = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'flow-test',
          version_number: 1,
          status: 'draft',
          intencao: 'X',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);

        await transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'owner-1' });
        expect(state[def.id].status).toBe('proposed');
        expect(state[def.id].proposed_by).toBe('owner-1');

        const proposed = state[def.id];
        await transitionProcedureStatus({
          definition: proposed,
          to: 'active',
          actor: 'owner-1',
        });
        expect(state[def.id].status).toBe('active');
        expect(state[def.id].approved_by).toBe('owner-1');
        expect(state[def.id].activated_at).toBeDefined();
      },
    );
  });

  it('cenário 3: nova versão active deactiva versão anterior do mesmo nome', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const v1 = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'same-name',
          version_number: 1,
          status: 'active',
          intencao: 'v1',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
          activated_at: new Date(),
        } as any);

        const v2 = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'same-name',
          version_number: 2,
          status: 'proposed',
          intencao: 'v2',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);

        await transitionProcedureStatus({ definition: v2, to: 'active', actor: 'owner-2' });
        expect(state[v2.id].status).toBe('active');
        // v1 should be deactivated (frozen)
        expect(state[v1.id].status).toBe('frozen');
        expect(state[v1.id].deactivated_at).toBeDefined();
      },
    );
  });

  it('cenário 4: transition inválida throws', async () => {
    expect(canTransition('rolled_back', 'active')).toBe(false);
    expect(canTransition('draft', 'active')).toBe(false); // pula proposed
  });

  it('cenário 5: rolled_back é terminal', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const def = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'terminal-test',
          version_number: 1,
          status: 'rolled_back',
          intencao: 'X',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);

        await expect(
          transitionProcedureStatus({ definition: def, to: 'active', actor: 'X' }),
        ).rejects.toThrow();
      },
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { transitionProcedureStatus, canTransition } from '@/cognition/procedure-status.js';

// In-memory state for mocked repo. Acts as the procedure_definitions table.
const state: Record<string, any> = {};
// Event-sourced status log capture (PR #83 H2).
const events: Array<{
  definition_id: string;
  from_status: string;
  to_status: string;
  actor: string;
  reason?: string;
}> = [];

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
        if (state[id]) {
          state[id] = { ...state[id], ...updates };
          return 1;
        }
        return 0;
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
      // P83-C4: atomic activation in a single transaction.
      atomicActivate: vi.fn(
        async (args: {
          target_id: string;
          actor: string;
          preserve_activated_at?: boolean;
        }) => {
          const target = state[args.target_id];
          if (!target) throw new Error('not found');
          const now = new Date();

          // Freeze any sibling that is currently active (same nome).
          let deactivated: any = null;
          for (const k of Object.keys(state)) {
            const row = state[k];
            if (
              row.nome === target.nome &&
              row.status === 'active' &&
              row.id !== target.id
            ) {
              state[k] = { ...row, status: 'frozen', deactivated_at: now };
              events.push({
                definition_id: row.id,
                from_status: 'active',
                to_status: 'frozen',
                actor: args.actor,
                reason: `superseded by ${target.id}`,
              });
              if (!deactivated) deactivated = state[k];
            }
          }

          const fromStatus = target.status;
          const patch: any = {
            status: 'active',
            approved_by: args.actor,
            approved_at: now,
            deactivated_at: null,
          };
          if (!args.preserve_activated_at || target.activated_at == null) {
            patch.activated_at = now;
          }
          state[args.target_id] = { ...target, ...patch };
          events.push({
            definition_id: target.id,
            from_status: fromStatus,
            to_status: 'active',
            actor: args.actor,
          });
          return { activated: state[args.target_id], deactivated };
        },
      ),
    },
    procedureStatusEventsRepo: {
      record: vi.fn(async (input: any) => {
        events.push(input);
      }),
      listByDefinition: vi.fn(async (definition_id: string) =>
        events.filter((e) => e.definition_id === definition_id),
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
    events.length = 0;
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
        // PR #83 H2: status event recorded.
        expect(
          events.find((e) => e.definition_id === def.id && e.to_status === 'proposed'),
        ).toBeDefined();

        const proposed = state[def.id];
        await transitionProcedureStatus({
          definition: proposed,
          to: 'active',
          actor: 'owner-1',
        });
        expect(state[def.id].status).toBe('active');
        expect(state[def.id].approved_by).toBe('owner-1');
        expect(state[def.id].activated_at).toBeDefined();
        expect(
          events.find((e) => e.definition_id === def.id && e.to_status === 'active'),
        ).toBeDefined();
      },
    );
  });

  it('cenário 3: nova versão active deactiva versão anterior do mesmo nome', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const firstActivatedAt = new Date('2025-01-01T00:00:00.000Z');
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
          activated_at: firstActivatedAt,
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
        // PR #83 H1: original activation timestamp preserved on v1.
        expect(state[v1.id].activated_at).toEqual(firstActivatedAt);
        // PR #83 H2: both transitions recorded in event log.
        const v1Events = events.filter((e) => e.definition_id === v1.id);
        const v2Events = events.filter((e) => e.definition_id === v2.id);
        expect(v1Events.some((e) => e.to_status === 'frozen')).toBe(true);
        expect(v2Events.some((e) => e.to_status === 'active')).toBe(true);
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

  it('cenário 6: transitionProcedureStatus rejeita sem tenant context (P83-M6)', async () => {
    const def = {
      id: 'def-x',
      status: 'draft',
      nome: 'no-ctx',
    } as any;
    // No runWithTenantContext wrapper — should fail because the function
    // calls getCurrentTenant() / getCurrentAgent() as a guard.
    await expect(
      transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'owner' }),
    ).rejects.toThrow();
  });

  it('cenário 7: updateStatus retorna 0 quando o id pertence a outro tenant (P83-H5)', async () => {
    // Simulate the in-memory state having a definition that does NOT
    // exist in our state map → updateStatus returns 0 → transition throws.
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const ghost = { id: 'does-not-exist', status: 'draft', nome: 'x' } as any;
        await expect(
          transitionProcedureStatus({ definition: ghost, to: 'proposed', actor: 'owner' }),
        ).rejects.toThrow(/not updated/);
      },
    );
  });
});

/**
 * P6 Task 4 — repo tests for roleSelectorDecisionsRepo.
 *
 * Mock-based pattern (matches tests/unit/capability-test-results-repo.spec.ts).
 * Validates: record() insere mesmo keep_current (append-only audit),
 * listByConversation() ordena DESC, countSwitchesInConversation conta
 * apenas action='switch', e o RUNTIME GUARD anti-llm_classifier dispara
 * antes mesmo da chamada ao DB (defense in depth).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type {
  SuggestedBy,
  DecidedBy,
  RoleSelectorStrength,
  RoleDecisionAction,
} from '@/types/enums.js';

type DecisionRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id: string | null;
  turno_id: string | null;
  channel_id: string | null;
  policy_id: string | null;
  current_role_id: string | null;
  suggested_role_id: string | null;
  decided_role_id: string;
  action: RoleDecisionAction;
  candidates: unknown;
  conflicts: unknown;
  suggested_by: SuggestedBy;
  decided_by: DecidedBy;
  suggested_strength: RoleSelectorStrength | null;
  suggested_confidence: string | null;
  reason: string | null;
  switch_count_in_conversation: number;
  decided_at: Date;
};

const decisionsState: Record<string, DecisionRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  const { getCurrentTenant, getCurrentAgent } = await import(
    '@/db/tenant-context.js'
  );

  return {
    ...actual,
    roleSelectorDecisionsRepo: {
      record: vi.fn(
        async (input: {
          conversa_id?: string;
          turno_id?: string;
          channel_id?: string;
          policy_id?: string;
          current_role_id?: string;
          suggested_role_id?: string;
          decided_role_id: string;
          action: RoleDecisionAction;
          candidates: unknown[];
          conflicts: unknown[];
          suggested_by: SuggestedBy;
          decided_by: DecidedBy;
          suggested_strength?: RoleSelectorStrength;
          suggested_confidence?: number;
          reason?: string;
          switch_count_in_conversation?: number;
        }) => {
          // CRITICAL runtime guard — mimic real repo
          if ((input.decided_by as string) === 'llm_classifier') {
            throw new Error('decided_by_cannot_be_llm_classifier');
          }
          const tenant_id = getCurrentTenant();
          const agent_id = getCurrentAgent();
          const id = `dec-${Math.random().toString(36).slice(2)}`;
          const row: DecisionRow = {
            id,
            tenant_id,
            agent_id,
            conversa_id: input.conversa_id ?? null,
            turno_id: input.turno_id ?? null,
            channel_id: input.channel_id ?? null,
            policy_id: input.policy_id ?? null,
            current_role_id: input.current_role_id ?? null,
            suggested_role_id: input.suggested_role_id ?? null,
            decided_role_id: input.decided_role_id,
            action: input.action,
            candidates: input.candidates,
            conflicts: input.conflicts,
            suggested_by: input.suggested_by,
            decided_by: input.decided_by,
            suggested_strength: input.suggested_strength ?? null,
            suggested_confidence:
              input.suggested_confidence !== undefined
                ? String(input.suggested_confidence)
                : null,
            reason: input.reason ?? null,
            switch_count_in_conversation:
              input.switch_count_in_conversation ?? 0,
            decided_at: new Date(),
          };
          decisionsState[id] = row;
          return row;
        },
      ),
      listByConversation: vi.fn(async (conversa_id: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return Object.values(decisionsState)
          .filter(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.conversa_id === conversa_id,
          )
          .sort((a, b) => b.decided_at.getTime() - a.decided_at.getTime());
      }),
      countSwitchesInConversation: vi.fn(async (conversa_id: string) => {
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return Object.values(decisionsState).filter(
          (r) =>
            r.tenant_id === tenant_id &&
            r.agent_id === agent_id &&
            r.conversa_id === conversa_id &&
            r.action === 'switch',
        ).length;
      }),
    },
  };
});

describe('roleSelectorDecisionsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(decisionsState)) delete decisionsState[k];
    vi.clearAllMocks();
  });

  it('record com action=keep_current insere row (audit append-only de tudo)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        const row = await roleSelectorDecisionsRepo.record({
          conversa_id: 'conv-1',
          decided_role_id: 'role-default',
          current_role_id: 'role-default',
          action: 'keep_current' as RoleDecisionAction,
          candidates: [],
          conflicts: [],
          suggested_by: 'none' as SuggestedBy,
          decided_by: 'policy_default' as DecidedBy,
          reason: 'no signal, mantém atual',
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.action).toBe('keep_current');
        expect(row.decided_role_id).toBe('role-default');
        expect(row.suggested_confidence).toBeNull();
        expect(row.switch_count_in_conversation).toBe(0);
      },
    );
  });

  it('record com action=switch insere row com suggested_confidence', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        const row = await roleSelectorDecisionsRepo.record({
          conversa_id: 'conv-2',
          turno_id: 'turn-1',
          decided_role_id: 'role-comercial',
          current_role_id: 'role-default',
          suggested_role_id: 'role-comercial',
          action: 'switch' as RoleDecisionAction,
          candidates: [{ role_id: 'role-comercial', score: 0.9 }],
          conflicts: [],
          suggested_by: 'llm_classifier' as SuggestedBy,
          decided_by: 'policy_rule' as DecidedBy,
          suggested_strength: 'strong' as RoleSelectorStrength,
          suggested_confidence: 0.92,
          reason: 'mensagem com claros sinais de venda',
          switch_count_in_conversation: 1,
        });
        expect(row.action).toBe('switch');
        expect(row.suggested_by).toBe('llm_classifier');
        expect(row.decided_by).toBe('policy_rule');
        expect(row.suggested_confidence).toBe('0.92'); // numeric column -> string
        expect(row.suggested_strength).toBe('strong');
        expect(row.switch_count_in_conversation).toBe(1);
      },
    );
  });

  it('listByConversation retorna decisions ordenadas por decided_at DESC', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        const a = await roleSelectorDecisionsRepo.record({
          conversa_id: 'conv-order',
          decided_role_id: 'role-default',
          action: 'keep_current' as RoleDecisionAction,
          candidates: [],
          conflicts: [],
          suggested_by: 'none' as SuggestedBy,
          decided_by: 'policy_default' as DecidedBy,
        });
        await new Promise((r) => setTimeout(r, 5));
        const b = await roleSelectorDecisionsRepo.record({
          conversa_id: 'conv-order',
          decided_role_id: 'role-comercial',
          action: 'switch' as RoleDecisionAction,
          candidates: [],
          conflicts: [],
          suggested_by: 'deterministic_classifier' as SuggestedBy,
          decided_by: 'policy_rule' as DecidedBy,
        });
        const list = await roleSelectorDecisionsRepo.listByConversation(
          'conv-order',
        );
        expect(list.length).toBe(2);
        // mais recente primeiro
        expect(list[0]!.id).toBe(b.id);
        expect(list[1]!.id).toBe(a.id);
      },
    );
  });

  it('countSwitchesInConversation conta apenas action=switch', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        // 2x keep_current + 3x switch
        for (let i = 0; i < 2; i++) {
          await roleSelectorDecisionsRepo.record({
            conversa_id: 'conv-count',
            decided_role_id: 'role-default',
            action: 'keep_current' as RoleDecisionAction,
            candidates: [],
            conflicts: [],
            suggested_by: 'none' as SuggestedBy,
            decided_by: 'policy_default' as DecidedBy,
          });
        }
        for (let i = 0; i < 3; i++) {
          await roleSelectorDecisionsRepo.record({
            conversa_id: 'conv-count',
            decided_role_id: 'role-comercial',
            action: 'switch' as RoleDecisionAction,
            candidates: [],
            conflicts: [],
            suggested_by: 'deterministic_classifier' as SuggestedBy,
            decided_by: 'policy_rule' as DecidedBy,
          });
        }
        const count =
          await roleSelectorDecisionsRepo.countSwitchesInConversation(
            'conv-count',
          );
        expect(count).toBe(3);
      },
    );
  });

  it('CRITICAL: record com decided_by=llm_classifier LANÇA decided_by_cannot_be_llm_classifier', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        await expect(
          roleSelectorDecisionsRepo.record({
            conversa_id: 'conv-violation',
            decided_role_id: 'role-comercial',
            action: 'switch' as RoleDecisionAction,
            candidates: [],
            conflicts: [],
            suggested_by: 'llm_classifier' as SuggestedBy,
            decided_by: 'llm_classifier' as unknown as DecidedBy, // forçar bypass do type-check
          }),
        ).rejects.toThrow('decided_by_cannot_be_llm_classifier');
      },
    );
  });

  it('listByConversation é tenant-scoped (não vaza)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'agent-a' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        await roleSelectorDecisionsRepo.record({
          conversa_id: 'conv-leak',
          decided_role_id: 'role-x',
          action: 'keep_current' as RoleDecisionAction,
          candidates: [],
          conflicts: [],
          suggested_by: 'none' as SuggestedBy,
          decided_by: 'policy_default' as DecidedBy,
        });
      },
    );
    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'agent-b' },
      async () => {
        const { roleSelectorDecisionsRepo } = await import(
          '@/db/repositories.js'
        );
        const list = await roleSelectorDecisionsRepo.listByConversation(
          'conv-leak',
        );
        expect(list.length).toBe(0);
      },
    );
  });
});

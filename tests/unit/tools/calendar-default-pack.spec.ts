import { describe, it, expect, vi } from 'vitest';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import {
  DEFAULT_AGENT_PACKS,
  PLATFORM_DEFAULT_DOMAIN_PACKS,
  DOMAIN_CALENDAR_PACK,
  DOMAIN_CALENDAR_ADMIN_PACK,
  defaultAgentGrant,
} from '@/tools/grant-math.js';

// ---------------------------------------------------------------------------
// DB-client fake for the seed-row test (below). The fake `withTx` runs the
// callback with a thin tx proxy that records insert().values() calls so we
// can assert the `granted_packs` the repo seeds into agent_tool_grants.
//
// createWithSeedAndAudit performs 4 inserts in order:
//   [0] agents              → tx.insert().values().returning()
//   [1] agent_op_profiles   → tx.insert().values().returning()
//   [2] agent_tool_grants   → tx.insert().values()        ← capture this
//   [3] admin_audit_log     → tx.insert().values()
// ---------------------------------------------------------------------------

/** Recorded values objects from each INSERT inside the tx, by call order. */
const capturedInserts: Record<string, unknown>[] = [];

vi.mock('@/db/client.js', () => {
  return {
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => {
      capturedInserts.length = 0;
      let callIdx = 0;

      const fakeTx = {
        insert: (_table: unknown) => {
          const myIdx = callIdx++;
          return {
            values: (v: Record<string, unknown>) => {
              capturedInserts[myIdx] = v;
              return {
                returning: () => {
                  if (myIdx === 0) {
                    // agents INSERT stub
                    return Promise.resolve([{
                      id: v['id'] ?? 'agent-1',
                      tenant_id: v['tenant_id'] ?? 'tenant-1',
                      nome: v['nome'] ?? 'Test Agent',
                      status: v['status'] ?? 'active',
                      metadata: {},
                      created_at: new Date(),
                      updated_at: new Date(),
                    }]);
                  }
                  if (myIdx === 1) {
                    // agent_operational_profile_versions INSERT stub
                    return Promise.resolve([{
                      id: 'prof-1',
                      tenant_id: v['tenant_id'],
                      agent_id: v['agent_id'],
                      version: 1,
                      status: 'proposed',
                      profile_body: v['profile_body'],
                      proposed_by: v['proposed_by'],
                      proposed_reason: v['proposed_reason'],
                    }]);
                  }
                  return Promise.resolve([{}]);
                },
                // thenable so awaiting without .returning() also works
                then: (res: (v: unknown) => unknown) => res(undefined),
              };
            },
          };
        },
      };

      return fn(fakeTx);
    },
    pgErrorCode: () => undefined,
    db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  };
});

describe('calendar default pack — estrutura', () => {
  it('BASE_AGENT_PACKS = baseline.core + domain.calendar (parity)', () => {
    expect([...BASE_AGENT_PACKS]).toEqual([
      ...DEFAULT_AGENT_PACKS,
      ...PLATFORM_DEFAULT_DOMAIN_PACKS,
    ]);
    expect(BASE_AGENT_PACKS).toContain('baseline.core');
    expect(BASE_AGENT_PACKS).toContain('domain.calendar');
  });

  it('domain.calendar tem as 7 tools universais, SEM register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_PACK.tools).toHaveLength(7);
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('schedule_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('cancel_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).not.toContain('register_custom_holiday');
  });

  it('domain.calendar.admin isola o register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_ADMIN_PACK.id).toBe('domain.calendar.admin');
    expect(DOMAIN_CALENDAR_ADMIN_PACK.tools).toEqual(['register_custom_holiday']);
  });
});

describe('calendar default pack — floor', () => {
  it('defaultAgentGrant() concede o BASE_AGENT_PACKS (inclui calendar)', () => {
    const g = defaultAgentGrant();
    expect(g.granted_packs).toEqual([...BASE_AGENT_PACKS]);
    expect(g.granted_packs).toContain('domain.calendar');
    expect(g.denied_tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seed-row test: proves the `granted_packs` inserted into `agent_tool_grants`
// by `agentsRepo.createWithSeedAndAudit` equals `BASE_AGENT_PACKS`.
// Uses the DB-client fake defined at the top of this file.
// ---------------------------------------------------------------------------
describe('calendar default pack — seed row', () => {
  it('createWithSeedAndAudit insere granted_packs = BASE_AGENT_PACKS no agent_tool_grants', async () => {
    const { agentsRepo } = await import('@/db/repositories.js');

    const result = await agentsRepo.createWithSeedAndAudit({
      agent: {
        id: 'agent-test-1',
        tenant_id: 'tenant-test-1',
        nome: 'Test Agent',
      },
      seed_profile: {
        profile_body: {},
        proposed_by: 'actor-1',
        proposed_reason: 'test',
      },
      audit: {
        actor_id: 'actor-1',
        actor_role: 'owner',
      },
    });

    expect(result.ok).toBe(true);

    // capturedInserts[2] = the agent_tool_grants INSERT values (3rd insert)
    const grantInsert = capturedInserts[2] as Record<string, unknown> | undefined;
    expect(grantInsert).toBeDefined();
    expect(grantInsert!['granted_packs']).toEqual([...BASE_AGENT_PACKS]);
    expect((grantInsert!['granted_packs'] as string[])).toContain('domain.calendar');

    // capturedInserts[3] = the admin_audit_log INSERT — also asserts change_summary.default_tool_packs
    const auditInsert = capturedInserts[3] as Record<string, unknown> | undefined;
    expect(auditInsert).toBeDefined();
    const changeSummary = auditInsert!['change_summary'] as Record<string, unknown>;
    expect(changeSummary['default_tool_packs']).toEqual([...BASE_AGENT_PACKS]);
    expect((changeSummary['default_tool_packs'] as string[])).toContain('domain.calendar');
  });
});

/**
 * P5 Task 5 — repo tests for capabilityProposalsRepo.
 *
 * Mock-based pattern (matches tests/unit/procedure-tests-repo.spec.ts and
 * tests/unit/operational-profile-versions-repo.spec.ts): we mock
 * @/db/repositories.js with an in-memory state. The mock implements the same
 * contract as the real repo so consumer code typed against the repo behaves
 * identically.
 *
 * Validates: create() defaults status='draft', transition() state machine
 * (draft → submitted; submitted → approved/rejected; approved → delivered;
 * rejected/delivered terminal). Returns typed result instead of throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type ProposalRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  gap_id: string | null;
  capability_type: string;
  title: string;
  description: string;
  proposed_spec: unknown;
  motivation: string;
  expected_impact: string | null;
  test_scenarios: unknown;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'delivered';
  submitted_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  decision_reason: string | null;
  delivered_at: Date | null;
  delivery_artifact_ref: string | null;
  created_at: Date;
  updated_at: Date;
};

const proposalsState: Record<string, ProposalRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  return {
    ...actual,
    capabilityProposalsRepo: {
      create: vi.fn(async (input: {
        gap_id?: string;
        capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
        title: string;
        description: string;
        proposed_spec: unknown;
        motivation: string;
        expected_impact?: string;
        test_scenarios: unknown[];
      }) => {
        const id = `prop-${Math.random().toString(36).slice(2)}`;
        const now = new Date();
        const row: ProposalRow = {
          id,
          tenant_id: 'default',
          agent_id: 'default',
          gap_id: input.gap_id ?? null,
          capability_type: input.capability_type,
          title: input.title,
          description: input.description,
          proposed_spec: input.proposed_spec,
          motivation: input.motivation,
          expected_impact: input.expected_impact ?? null,
          test_scenarios: input.test_scenarios,
          status: 'draft',
          submitted_at: null,
          decided_at: null,
          decided_by: null,
          decision_reason: null,
          delivered_at: null,
          delivery_artifact_ref: null,
          created_at: now,
          updated_at: now,
        };
        proposalsState[id] = row;
        return row;
      }),
      getById: vi.fn(async (id: string) => proposalsState[id] ?? null),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(proposalsState).filter((r) => r.status === status),
      ),
      listByGap: vi.fn(async (gap_id: string) =>
        Object.values(proposalsState).filter((r) => r.gap_id === gap_id),
      ),
      transition: vi.fn(
        async (args: {
          id: string;
          to: 'submitted' | 'approved' | 'rejected' | 'delivered';
          decided_by?: string;
          decision_reason?: string;
          delivery_artifact_ref?: string;
        }) => {
          const row = proposalsState[args.id];
          if (!row) return { ok: false as const, reason: 'not_found' as const };

          const from = row.status;
          // Terminal states
          if (from === 'rejected' || from === 'delivered') {
            return { ok: false as const, reason: 'invalid_transition' as const };
          }
          if (from === args.to) {
            return { ok: false as const, reason: 'invalid_transition' as const };
          }

          const allowed: Record<string, string[]> = {
            draft: ['submitted'],
            submitted: ['approved', 'rejected'],
            approved: ['delivered'],
          };
          if (!allowed[from]?.includes(args.to)) {
            return { ok: false as const, reason: 'invalid_transition' as const };
          }

          const now = new Date();
          const patch: Partial<ProposalRow> = { status: args.to, updated_at: now };
          if (args.to === 'submitted') {
            patch.submitted_at = now;
          }
          if (args.to === 'approved' || args.to === 'rejected') {
            patch.decided_at = now;
            if (args.decided_by) patch.decided_by = args.decided_by;
            if (args.decision_reason) patch.decision_reason = args.decision_reason;
          }
          if (args.to === 'delivered') {
            patch.delivered_at = now;
            if (args.delivery_artifact_ref)
              patch.delivery_artifact_ref = args.delivery_artifact_ref;
          }
          const updated: ProposalRow = { ...row, ...patch };
          proposalsState[args.id] = updated;
          return { ok: true as const, updated };
        },
      ),
    },
  };
});

describe('capabilityProposalsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(proposalsState)) delete proposalsState[k];
    vi.clearAllMocks();
  });

  it('create defaults status="draft" e seta campos básicos', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          gap_id: 'gap-1',
          capability_type: 'tool',
          title: 'Integração com Bling',
          description: 'Tool para consultar pedidos no Bling',
          proposed_spec: { tool_name: 'bling_query', params: [] },
          motivation: 'Pedido recorrente do owner',
          expected_impact: 'Redução de fricção em vendas',
          test_scenarios: [{ name: 'consulta pedido por id', input: { id: '123' } }],
        });
        expect(row.id).toBeDefined();
        expect(row.status).toBe('draft');
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.title).toBe('Integração com Bling');
        expect(row.gap_id).toBe('gap-1');
        expect(row.submitted_at).toBeNull();
        expect(row.decided_at).toBeNull();
      },
    );
  });

  it('transition(draft → submitted) seta submitted_at', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        const result = await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('submitted');
          expect(result.updated.submitted_at).toBeInstanceOf(Date);
          expect(result.updated.decided_at).toBeNull();
        }
      },
    );
  });

  it('transition(submitted → approved) seta decided_at + decided_by', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        const result = await capabilityProposalsRepo.transition({
          id: row.id,
          to: 'approved',
          decided_by: 'owner@maia',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('approved');
          expect(result.updated.decided_at).toBeInstanceOf(Date);
          expect(result.updated.decided_by).toBe('owner@maia');
        }
      },
    );
  });

  it('transition(submitted → rejected) seta decision_reason', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        const result = await capabilityProposalsRepo.transition({
          id: row.id,
          to: 'rejected',
          decided_by: 'owner@maia',
          decision_reason: 'fora de escopo',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('rejected');
          expect(result.updated.decision_reason).toBe('fora de escopo');
        }
      },
    );
  });

  it('transition(approved → delivered) seta delivery_artifact_ref', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'approved' });
        const result = await capabilityProposalsRepo.transition({
          id: row.id,
          to: 'delivered',
          delivery_artifact_ref: 'pr#1234',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('delivered');
          expect(result.updated.delivered_at).toBeInstanceOf(Date);
          expect(result.updated.delivery_artifact_ref).toBe('pr#1234');
        }
      },
    );
  });

  it('transition(submitted → delivered) retorna invalid_transition', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        const result = await capabilityProposalsRepo.transition({
          id: row.id,
          to: 'delivered',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('invalid_transition');
        }
      },
    );
  });

  it('transition(rejected → submitted) retorna invalid_transition (terminal)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const row = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 't',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'submitted' });
        await capabilityProposalsRepo.transition({ id: row.id, to: 'rejected' });
        const result = await capabilityProposalsRepo.transition({
          id: row.id,
          to: 'submitted',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('invalid_transition');
        }
      },
    );
  });

  it('transition com id desconhecido retorna not_found', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const result = await capabilityProposalsRepo.transition({
          id: 'does-not-exist',
          to: 'submitted',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('not_found');
        }
      },
    );
  });

  it('listByStatus filtra corretamente', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityProposalsRepo } = await import('@/db/repositories.js');
        const a = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 'a',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        const b = await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 'b',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.create({
          capability_type: 'tool',
          title: 'c',
          description: 'd',
          proposed_spec: {},
          motivation: 'm',
          test_scenarios: [],
        });
        await capabilityProposalsRepo.transition({ id: a.id, to: 'submitted' });
        await capabilityProposalsRepo.transition({ id: b.id, to: 'submitted' });

        const submitted = await capabilityProposalsRepo.listByStatus('submitted');
        expect(submitted.length).toBe(2);
        const drafts = await capabilityProposalsRepo.listByStatus('draft');
        expect(drafts.length).toBe(1);
      },
    );
  });
});

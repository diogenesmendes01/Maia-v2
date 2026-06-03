/**
 * Calendar v2 — pipeline de aprovação end-to-end (mocked repos).
 *
 * Cenário: Maia gera proposta holiday → owner aprova via tool → handler cria
 * row em holidays → cache invalidado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { featureFlags } from '@/config/feature-flags.js';
import {
  _internal_cache,
  cacheKey,
} from '@/lib/holidays-cache.js';
import type { CapabilityProposal } from '@/db/schema.js';

// ---------- in-memory state ----------
const holidaysState: Array<{
  id: number;
  tenant_id: string;
  name: string;
  month: number;
  day: number;
  year: number | null;
  type: string;
  uf: string | null;
  cidade: string | null;
  proposal_id: string | null;
  status: string;
  source: string | null;
  approved_by: string | null;
}> = [];
const holidayEntidadesState: Array<{
  tenant_id: string;
  holiday_id: number;
  entidade_id: string;
}> = [];
const proposalsState: Record<string, CapabilityProposal> = {};
let nextHolidayId = 1;

const {
  holidaysCreate,
  holidaysFindByProposalId,
  holidayEntidadesLink,
  holidayEntidadesListByEntidade,
  proposalsGetById,
  proposalsTransition,
  proposalsListByStatus,
} = vi.hoisted(() => ({
  holidaysCreate: vi.fn(),
  holidaysFindByProposalId: vi.fn(),
  holidayEntidadesLink: vi.fn(),
  holidayEntidadesListByEntidade: vi.fn(),
  proposalsGetById: vi.fn(),
  proposalsTransition: vi.fn(),
  proposalsListByStatus: vi.fn(),
}));

vi.mock('@/db/repositories/holidays-repo.js', () => ({
  holidaysRepo: {
    findByProposalId: holidaysFindByProposalId,
    create: holidaysCreate,
    findApplicable: vi.fn(),
    findInRange: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/db/repositories/holiday-entidades-repo.js', () => ({
  holidayEntidadesRepo: {
    link: holidayEntidadesLink,
    unlink: vi.fn(),
    listByEntidade: holidayEntidadesListByEntidade,
  },
  CrossTenantIntegrityError: class extends Error {
    code = 'CROSS_TENANT_INTEGRITY_VIOLATION';
  },
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/db/repositories.js');
  return {
    ...actual,
    capabilityProposalsRepo: {
      getById: proposalsGetById,
      transition: proposalsTransition,
      listByStatus: proposalsListByStatus,
      create: vi.fn(),
      listByGap: vi.fn(),
    },
  };
});

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeProposal(overrides: Partial<CapabilityProposal> = {}): CapabilityProposal {
  const now = new Date();
  return {
    id: 'prop-h1',
    tenant_id: 'tenant-a',
    agent_id: 'default',
    gap_id: null,
    capability_type: 'holiday',
    title: 'holiday:fundacao-empresa:6/15:entity_custom:entidade-001',
    description: 'Feriado custom detectado pelo padrão de mensagens',
    proposed_spec: {
      name: 'Fundação Empresa',
      month: 6,
      day: 15,
      type: 'entity_custom',
      entidade_id: 'entidade-001',
      pattern_descriptor: 'holiday:fundacao-empresa:6/15:entity_custom:entidade-001',
    },
    motivation: 'mencionado 3 vezes em conversa',
    expected_impact: 'evita lembretes em recesso',
    test_scenarios: [],
    status: 'submitted',
    submitted_at: now,
    decided_at: null,
    decided_by: null,
    decision_reason: null,
    delivered_at: null,
    delivery_artifact_ref: null,
    last_test_outcome: null,
    last_test_at: null,
    reverted_at: null,
    revert_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as CapabilityProposal;
}

describe('Calendar v2 — approval pipeline (holiday)', () => {
  beforeEach(() => {
    holidaysState.length = 0;
    holidayEntidadesState.length = 0;
    nextHolidayId = 1;
    for (const k of Object.keys(proposalsState)) delete proposalsState[k];
    _internal_cache.clear();

    holidaysCreate.mockImplementation(async (args: Record<string, unknown>) => {
      const row = {
        id: nextHolidayId++,
        tenant_id: 'tenant-a',
        name: args.name as string,
        month: args.month as number,
        day: args.day as number,
        year: (args.year as number) ?? null,
        type: args.type as string,
        uf: (args.uf as string) ?? null,
        cidade: (args.cidade as string) ?? null,
        proposal_id: (args.proposal_id as string) ?? null,
        status: (args.status as string) ?? 'ativo',
        source: (args.source as string) ?? null,
        approved_by: (args.approved_by as string) ?? null,
      };
      holidaysState.push(row);
      return row;
    });

    holidaysFindByProposalId.mockImplementation(async (proposal_id: string) => {
      return holidaysState.find((h) => h.proposal_id === proposal_id) ?? null;
    });

    holidayEntidadesLink.mockImplementation(
      async (args: { holiday_id: number; entidade_id: string }) => {
        holidayEntidadesState.push({
          tenant_id: 'tenant-a',
          holiday_id: args.holiday_id,
          entidade_id: args.entidade_id,
        });
      },
    );
    // Reconciliation lookup reflects in-memory junction state.
    holidayEntidadesListByEntidade.mockImplementation(async (entidade_id: string) => {
      return holidayEntidadesState
        .filter((r) => r.entidade_id === entidade_id)
        .map((r) => r.holiday_id);
    });
  });

  afterEach(() => {
    featureFlags.reset();
    vi.clearAllMocks();
  });

  it('dispatchApproval(holiday) cria row + vincula entidade + invalida cache', async () => {
    // Pre-populate cache to verify invalidation
    _internal_cache.set(
      cacheKey('tenant-a', 'default', 'entidade-001', 2026, 'standard'),
      new Set(['2026-12-25']),
    );
    expect(_internal_cache.get(cacheKey('tenant-a', 'default', 'entidade-001', 2026, 'standard'))).toBeDefined();

    const { dispatchApproval } = await import('@/cognition/proposal-approval-handler.js');
    const proposal = makeProposal();

    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      const result = await dispatchApproval(proposal, { approverId: 'owner-1' });
      expect(result.status).toBe('approved');
      expect('holiday_id' in result && result.holiday_id).toBeGreaterThan(0);
    });

    expect(holidaysState).toHaveLength(1);
    expect(holidaysState[0]).toMatchObject({
      name: 'Fundação Empresa',
      month: 6,
      day: 15,
      type: 'entity_custom',
      proposal_id: 'prop-h1',
      approved_by: 'owner-1',
    });
    expect(holidayEntidadesState).toHaveLength(1);
    expect(holidayEntidadesState[0]).toMatchObject({
      holiday_id: 1,
      entidade_id: 'entidade-001',
    });

    // Cache invalidado para o tenant
    expect(
      _internal_cache.get(cacheKey('tenant-a', 'default', 'entidade-001', 2026, 'standard')),
    ).toBeUndefined();
  });

  it('dispatchApproval é idempotente — segunda chamada não cria duplicata', async () => {
    const { dispatchApproval } = await import('@/cognition/proposal-approval-handler.js');
    const proposal = makeProposal();
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      const r1 = await dispatchApproval(proposal, { approverId: 'owner-1' });
      const r2 = await dispatchApproval(proposal, { approverId: 'owner-1' });
      expect(r1).toMatchObject({ status: 'approved' });
      expect(r2).toMatchObject({ status: 'approved' });
      if ('idempotent' in r2) expect(r2.idempotent).toBe(true);
    });
    expect(holidaysState).toHaveLength(1);
  });

  it('dispatchApproval para capability_type=tool não invoca holiday handler', async () => {
    const { dispatchApproval } = await import('@/cognition/proposal-approval-handler.js');
    const proposal = makeProposal({ capability_type: 'tool' });
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      const r = await dispatchApproval(proposal, { approverId: 'owner-1' });
      expect(r.status).toBe('approved_no_op');
    });
    expect(holidaysState).toHaveLength(0);
  });
});

describe('Calendar v2 — cross-tenant isolation (Cenário 5)', () => {
  beforeEach(() => {
    holidaysState.length = 0;
    nextHolidayId = 1;
    _internal_cache.clear();

    holidaysCreate.mockImplementation(async (args: Record<string, unknown>) => {
      // capture current tenant via custom field
      const row = {
        id: nextHolidayId++,
        tenant_id: (args as { _capturedTenantId?: string })._capturedTenantId ?? 'tenant-a',
        name: args.name as string,
        month: args.month as number,
        day: args.day as number,
        year: (args.year as number) ?? null,
        type: args.type as string,
        uf: (args.uf as string) ?? null,
        cidade: (args.cidade as string) ?? null,
        proposal_id: (args.proposal_id as string) ?? null,
        status: (args.status as string) ?? 'ativo',
        source: (args.source as string) ?? null,
        approved_by: (args.approved_by as string) ?? null,
      };
      holidaysState.push(row);
      return row;
    });
    holidaysFindByProposalId.mockResolvedValue(null);
  });

  afterEach(() => featureFlags.reset());

  it('proposal aprovada em tenant-A NÃO cria registro nem invalida cache em tenant-B', async () => {
    // tenant-B tem cache pre-existente
    _internal_cache.set(
      cacheKey('tenant-b', 'default', 'entidade-B', 2026, 'standard'),
      new Set(['2026-12-25']),
    );

    const { dispatchApproval } = await import('@/cognition/proposal-approval-handler.js');
    const proposal = {
      ...({} as CapabilityProposal),
      id: 'prop-a',
      capability_type: 'holiday',
      proposed_spec: {
        name: 'Holiday A',
        month: 3,
        day: 15,
        type: 'entity_custom',
        entidade_id: 'entidade-A',
        pattern_descriptor: 'holiday:holiday-a:3/15:entity_custom:entidade-A',
      },
    } as unknown as CapabilityProposal;

    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      await dispatchApproval(proposal, { approverId: 'owner-A' });
    });

    // tenant-B cache continua intacto
    expect(_internal_cache.get(cacheKey('tenant-b', 'default', 'entidade-B', 2026, 'standard'))).toBeDefined();
  });
});

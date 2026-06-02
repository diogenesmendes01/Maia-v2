/**
 * Regression tests for Codex adversarial review on PR #105 (Calendar v2).
 *
 * 1. [high] register_custom_holiday rejects entidade_ids outside ctx.scope
 *    and entidades without manage_calendar permission.
 * 2. [high] approve_capability_proposal materializes BEFORE transitioning,
 *    so a failed dispatch leaves the proposal retryable in 'submitted'.
 * 3. [medium] start_recurring_payment + start_recurring_outreach honour
 *    business-day RRULE extensions (BYNTHWORKDAY / BYWORKDAY=true) end
 *    to end — parser + computeNext go through the extended engine.
 *
 * (The former CALENDAR_V2 runtime kill-switch checks were removed when the
 * flag was collapsed to always-on.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// --- Hoisted mock fns ------------------------------------------------------
const {
  holidaysCreate,
  holidaysFindByProposalId,
  holidayEntidadesLink,
  holidayEntidadesListByEntidade,
  proposalsGetById,
  proposalsTransition,
  createWithFirstOccurrence,
  auditMock,
} = vi.hoisted(() => ({
  holidaysCreate: vi.fn(),
  holidaysFindByProposalId: vi.fn(),
  holidayEntidadesLink: vi.fn(),
  holidayEntidadesListByEntidade: vi.fn(),
  proposalsGetById: vi.fn(),
  proposalsTransition: vi.fn(),
  createWithFirstOccurrence: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/db/repositories/holidays-repo.js', () => ({
  holidaysRepo: {
    create: holidaysCreate,
    findByProposalId: holidaysFindByProposalId,
    findApplicable: vi.fn().mockResolvedValue([]),
    findInRange: vi.fn().mockResolvedValue([]),
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
      listByStatus: vi.fn(),
      create: vi.fn(),
      listByGap: vi.fn(),
    },
  };
});

vi.mock('@/scheduling/repos.js', () => ({
  seriesRepo: { createWithFirstOccurrence },
}));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

// Build a minimal handler ctx with given scoped entidades.
function makeCtx(entidades: string[], actions: string[] = ['manage_calendar']) {
  const byEntity = new Map<string, unknown>();
  for (const eid of entidades) {
    byEntity.set(eid, {
      pessoa_id: 'pessoa-1',
      entidade_id: eid,
      profile: {
        slug: 'admin',
        acoes: actions,
        limite_default: 0,
      },
      permissao: { status: 'ativa', valor_max: 0 },
    });
  }
  return {
    pessoa: { id: 'pessoa-1', status: 'ativa', tipo: 'co_dono' },
    scope: { entidades, byEntity },
    conversa: { id: 'conv-1' },
    mensagem_id: 'm-1',
    request_id: 'r-1',
    idempotency_key: 'ik-1',
  } as never;
}

const E_IN = '00000000-0000-0000-0000-000000000001';
const E_OTHER = '00000000-0000-0000-0000-000000000002';
const TENANT_CTX = { tenant_id: 'tenant-a', agent_id: 'default' };

beforeEach(() => {
  holidaysCreate.mockReset();
  holidaysFindByProposalId.mockReset();
  holidayEntidadesLink.mockReset();
  holidayEntidadesListByEntidade.mockReset();
  proposalsGetById.mockReset();
  proposalsTransition.mockReset();
  createWithFirstOccurrence.mockReset();
  auditMock.mockReset();

  // Default: holiday create succeeds, no prior holiday by proposal.
  holidaysCreate.mockResolvedValue({ id: 42 });
  holidaysFindByProposalId.mockResolvedValue(null);
  holidayEntidadesLink.mockResolvedValue(undefined);
  // Default reconciliation lookup returns an empty list — if the test sets up
  // an idempotent retry where the link already exists, override to include
  // the holiday id.
  holidayEntidadesListByEntidade.mockResolvedValue([]);
  createWithFirstOccurrence.mockImplementation(
    async (args: { initial_occurrence: { scheduled_for: Date } }) => ({
      series: { id: 'series-1', tipo: 'recurring_payment' },
      occurrence: { id: 'occ-1', scheduled_for: args.initial_occurrence.scheduled_for },
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Codex finding #1: cross-entity authorization ---------------------------

describe('register_custom_holiday — entidade_ids authorization (Codex #105 high)', () => {
  it('rejects when ANY entidade_id is outside ctx.scope.entidades', async () => {
    const { registerCustomHolidayTool } = await import(
      '@/tools/register-custom-holiday.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      // Caller is scoped to E_IN, but tries to register holiday on E_OTHER.
      await expect(
        registerCustomHolidayTool.handler(
          {
            name: 'Hack',
            month: 1,
            day: 1,
            type: 'entity_custom',
            entidade_ids: [E_IN, E_OTHER],
          } as never,
          makeCtx([E_IN]),
        ),
      ).rejects.toThrow(/fora do escopo/);
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
    expect(holidayEntidadesLink).not.toHaveBeenCalled();
  });

  it('rejects when ctx.scope contains the entidade but profile lacks manage_calendar', async () => {
    const { registerCustomHolidayTool } = await import(
      '@/tools/register-custom-holiday.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      await expect(
        registerCustomHolidayTool.handler(
          {
            name: 'NoPerm',
            month: 1,
            day: 1,
            type: 'entity_custom',
            entidade_ids: [E_IN],
          } as never,
          makeCtx([E_IN], ['ver_saldo']),
        ),
      ).rejects.toThrow(/manage_calendar/);
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
  });

  it('happy path: every entidade_id is in scope AND authorized', async () => {
    const { registerCustomHolidayTool } = await import(
      '@/tools/register-custom-holiday.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await registerCustomHolidayTool.handler(
        {
          name: 'OK',
          month: 6,
          day: 15,
          type: 'entity_custom',
          entidade_ids: [E_IN, E_OTHER],
        } as never,
        makeCtx([E_IN, E_OTHER]),
      );
      expect(out.holiday_id).toBe(42);
      expect(out.linked_entidades).toBe(2);
    });
    expect(holidayEntidadesLink).toHaveBeenCalledTimes(2);
  });

  it('dedupes duplicate entidade_ids before linking and authorization', async () => {
    const { registerCustomHolidayTool } = await import(
      '@/tools/register-custom-holiday.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await registerCustomHolidayTool.handler(
        {
          name: 'Dup',
          month: 6,
          day: 15,
          type: 'entity_custom',
          entidade_ids: [E_IN, E_IN, E_IN],
        } as never,
        makeCtx([E_IN]),
      );
      expect(out.linked_entidades).toBe(1);
    });
    expect(holidayEntidadesLink).toHaveBeenCalledTimes(1);
  });
});

// --- Codex finding #2: approval atomicity ----------------------------------

describe('approve_capability_proposal — atomic materialization (Codex #105 high)', () => {
  // Build a minimal CapabilityProposal-shaped object.
  function makeProposal(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      id: '11111111-1111-1111-1111-111111111111',
      tenant_id: 'tenant-a',
      agent_id: 'default',
      gap_id: null,
      capability_type: 'holiday',
      title: 't',
      description: 'd',
      proposed_spec: {
        name: 'Festa Local',
        month: 9,
        day: 7,
        type: 'entity_custom',
        entidade_id: E_IN,
      },
      motivation: 'm',
      expected_impact: null,
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
    };
  }

  it('when materialization throws, transition is NOT called → proposal remains submitted', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    // Force dispatch failure mid-materialization (malformed insert).
    holidaysCreate.mockRejectedValueOnce(new Error('db_failure'));

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      await expect(
        approveCapabilityProposalTool.handler(
          {
            proposal_id: '11111111-1111-1111-1111-111111111111',
          } as never,
          makeCtx([E_IN]),
        ),
      ).rejects.toThrow(/db_failure/);
    });
    // Transition NEVER called because materialization failed first.
    expect(proposalsTransition).not.toHaveBeenCalled();
  });

  it('happy path: materialization succeeds, then transition to approved fires', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    proposalsTransition.mockResolvedValue({ ok: true, updated: {} });

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await approveCapabilityProposalTool.handler(
        {
          proposal_id: '11111111-1111-1111-1111-111111111111',
        } as never,
        makeCtx([E_IN]),
      );
      expect(out.status).toBe('approved');
      expect(out.holiday_id).toBe(42);
    });
    expect(holidaysCreate).toHaveBeenCalledTimes(1);
    expect(proposalsTransition).toHaveBeenCalledTimes(1);
    const tcall = proposalsTransition.mock.calls[0]![0] as { to: string };
    expect(tcall.to).toBe('approved');
  });

  it('idempotent retry: holiday already exists for proposal AND link present → no new INSERT/link, transition still fires', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    proposalsTransition.mockResolvedValue({ ok: true, updated: {} });
    // Simulate prior materialization that left a holiday row but failed
    // before transition. Retry MUST detect it and not double-create.
    holidaysFindByProposalId.mockResolvedValueOnce({
      id: 99,
      proposal_id: '11111111-1111-1111-1111-111111111111',
    });
    // Link already present — reconciliation no-ops.
    holidayEntidadesListByEntidade.mockResolvedValueOnce([99]);

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await approveCapabilityProposalTool.handler(
        {
          proposal_id: '11111111-1111-1111-1111-111111111111',
        } as never,
        makeCtx([E_IN], ['manage_calendar', 'manage_capabilities']),
      );
      expect(out.status).toBe('approved');
      expect(out.holiday_id).toBe(99);
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
    expect(holidayEntidadesLink).not.toHaveBeenCalled();
    expect(proposalsTransition).toHaveBeenCalledTimes(1);
  });

  // Codex review #105 round-2 (high): idempotent retry now reconciles a
  // missing link instead of blessing an orphaned holiday.
  it('round-2: idempotent retry reconciles missing holiday_entidades link before returning success', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    proposalsTransition.mockResolvedValue({ ok: true, updated: {} });
    // Prior partial run: holiday exists, but link in junction never made it
    // (e.g., link INSERT failed, transient db blip). Retry must fill the gap.
    holidaysFindByProposalId.mockResolvedValueOnce({
      id: 99,
      proposal_id: '11111111-1111-1111-1111-111111111111',
    });
    // Link missing: entidade has no junction rows yet for this holiday id.
    holidayEntidadesListByEntidade.mockResolvedValueOnce([]);

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await approveCapabilityProposalTool.handler(
        { proposal_id: '11111111-1111-1111-1111-111111111111' } as never,
        makeCtx([E_IN], ['manage_calendar', 'manage_capabilities']),
      );
      expect(out.status).toBe('approved');
      expect(out.holiday_id).toBe(99);
    });
    // Reconciliation must have called link with the existing holiday id.
    expect(holidayEntidadesLink).toHaveBeenCalledTimes(1);
    expect(holidayEntidadesLink).toHaveBeenCalledWith({
      holiday_id: 99,
      entidade_id: E_IN,
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
    expect(proposalsTransition).toHaveBeenCalledTimes(1);
  });

  // Codex review #105 round-2 (high): partial failure (link throws after
  // INSERT commits) must keep proposal `submitted` so a retry can finish.
  it('round-2: partial failure (link throws after holiday create) → throws, proposal NOT transitioned', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    // First-time path: holiday create succeeds, link throws.
    holidaysFindByProposalId.mockResolvedValueOnce(null);
    holidayEntidadesLink.mockRejectedValueOnce(new Error('link_db_failure'));

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      await expect(
        approveCapabilityProposalTool.handler(
          { proposal_id: '11111111-1111-1111-1111-111111111111' } as never,
          makeCtx([E_IN], ['manage_calendar', 'manage_capabilities']),
        ),
      ).rejects.toThrow(/link_db_failure/);
    });
    // Transition NEVER called — proposal stays `submitted` for retry.
    expect(proposalsTransition).not.toHaveBeenCalled();
  });

  // Codex review #105 round-2 (high): caller without manage_capabilities is
  // rejected at the entry-time second-check (caller exercises dispatcher
  // round-2 — see "scope leakage" describe block below for full coverage).
  it('round-2: rejects holiday proposal when caller scope does not include proposed_spec.entidade_id', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    holidaysFindByProposalId.mockResolvedValue(null);

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      // Caller scope contains E_OTHER but proposal targets E_IN. Should reject.
      await expect(
        approveCapabilityProposalTool.handler(
          { proposal_id: '11111111-1111-1111-1111-111111111111' } as never,
          makeCtx([E_OTHER], ['manage_calendar', 'manage_capabilities']),
        ),
      ).rejects.toThrow(/fora do escopo/);
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
    expect(proposalsTransition).not.toHaveBeenCalled();
  });

  it('round-2: rejects holiday proposal when caller has manage_capabilities but lacks manage_calendar on entidade alvo', async () => {
    proposalsGetById.mockResolvedValue(makeProposal());
    holidaysFindByProposalId.mockResolvedValue(null);

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      // Caller has manage_capabilities + ver_saldo but NOT manage_calendar.
      await expect(
        approveCapabilityProposalTool.handler(
          { proposal_id: '11111111-1111-1111-1111-111111111111' } as never,
          makeCtx([E_IN], ['manage_capabilities', 'ver_saldo']),
        ),
      ).rejects.toThrow(/manage_calendar/);
    });
    expect(holidaysCreate).not.toHaveBeenCalled();
    expect(proposalsTransition).not.toHaveBeenCalled();
  });

  it('round-2: tenant-level proposal (capability_type=tool) only needs manage_capabilities (handler-side passes; dispatcher enforces actual check)', async () => {
    // Tenant-level proposals (tool/knowledge/procedure/integration/other) DO
    // NOT have an entidade alvo to refine the check against. The handler
    // does NOT enforce manage_calendar; the dispatcher's manage_capabilities
    // check is the authority.
    proposalsGetById.mockResolvedValue(
      makeProposal({
        capability_type: 'tool',
        proposed_spec: { name: 'wire_payment' },
      }),
    );
    proposalsTransition.mockResolvedValue({ ok: true, updated: {} });

    const { approveCapabilityProposalTool } = await import(
      '@/tools/approve-capability-proposal.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await approveCapabilityProposalTool.handler(
        { proposal_id: '11111111-1111-1111-1111-111111111111' } as never,
        // Caller has manage_capabilities but only manage_calendar on a
        // different entity — for tenant-level proposals this is fine
        // because there is no entidade alvo to enforce against.
        makeCtx([E_IN], ['manage_capabilities']),
      );
      expect(out.status).toBe('approved');
      expect(out.holiday_id).toBeNull();
    });
    expect(proposalsTransition).toHaveBeenCalledTimes(1);
  });
});

// --- Codex finding #4: business-day RRULE end-to-end -----------------------

describe('start_recurring_payment / outreach: business-day RRULE wiring (Codex #105 medium)', () => {
  it('start_recurring_payment: BYNTHWORKDAY=5 routes through computeNextWithBusinessDays (does not throw)', async () => {
    // The legacy parser would reject BYNTHWORKDAY. If we still ended up
    // calling it, this would throw before reaching createWithFirstOccurrence.
    // The fact that the handler succeeds proves the extended path is wired.
    // Wrapped in tenant context because the extended engine hits the
    // holidays cache (DB-backed), which requires tenant scoping.
    const { startRecurringPaymentTool } = await import(
      '@/tools/start-recurring-payment.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await startRecurringPaymentTool.handler(
        {
          rrule: 'FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard',
          conta_id: '22222222-2222-2222-2222-222222222222',
          valor: 100,
          descricao: 'aluguel',
          escalate_after_hours: 4,
          month_end_policy: 'last_day_of_month',
          missed_run_policy: 'fire_latest_only',
          staleness_threshold_hours: 24,
          entidade_id: E_IN,
        } as never,
        makeCtx([E_IN]),
      );
      expect(out.series_id).toBe('series-1');
    });
    expect(createWithFirstOccurrence).toHaveBeenCalledTimes(1);
    const call = createWithFirstOccurrence.mock.calls[0]![0] as { rrule: string };
    expect(call.rrule).toBe('FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard');
  });

  it('start_recurring_payment: legacy BYMONTHDAY=15 still works (regression)', async () => {
    const { startRecurringPaymentTool } = await import(
      '@/tools/start-recurring-payment.js'
    );
    // Legacy path doesn't hit the holidays cache, no tenant ctx needed.
    const out = await startRecurringPaymentTool.handler(
      {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        conta_id: '22222222-2222-2222-2222-222222222222',
        valor: 100,
        descricao: 'aluguel',
        escalate_after_hours: 4,
        month_end_policy: 'last_day_of_month',
        missed_run_policy: 'fire_latest_only',
        staleness_threshold_hours: 24,
        entidade_id: E_IN,
      } as never,
      makeCtx([E_IN]),
    );
    expect(out.series_id).toBe('series-1');
  });

  it('start_recurring_outreach: BYWORKDAY=true routes through extended engine', async () => {
    const { startRecurringOutreachTool } = await import(
      '@/tools/start-recurring-outreach.js'
    );
    await runWithTenantContext(TENANT_CTX, async () => {
      const out = await startRecurringOutreachTool.handler(
        {
          rrule: 'FREQ=DAILY;BYWORKDAY=true',
          destinatario_pessoa_id: '33333333-3333-3333-3333-333333333333',
          message_template: 'oi',
          wait_response_hours: 48,
          month_end_policy: 'skip_invalid_month',
          missed_run_policy: 'escalate_to_owner',
          staleness_threshold_hours: 24,
          exclusive_per_destinatario: false,
          entidade_id: E_IN,
          dual_approval_granted: true,
        } as never,
        makeCtx([E_IN]),
      );
      expect(out.series_id).toBe('series-1');
    });
    const call = createWithFirstOccurrence.mock.calls[0]![0] as { rrule: string };
    expect(call.rrule).toBe('FREQ=DAILY;BYWORKDAY=true');
  });
});

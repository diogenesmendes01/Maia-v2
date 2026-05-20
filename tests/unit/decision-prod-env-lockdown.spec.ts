/**
 * Tests for LockdownReaderProdAdapter (Camada 3, stub #2/4).
 *
 * Verifies that the production LockdownReader correctly translates
 * governance/lockdown.ts entity/permissao state into the DE port interface.
 *
 * DESIGN NOTE: dual-layer lockdown
 * - Channel lockdown → checked via BaseContextPacket.channel.is_locked_down
 *   (Early PEP hardcoded short-circuit, already works).
 * - Entity/permissao lockdown → checked via LockdownReaderProdAdapter (this file).
 *
 * The entity/permissao layer looks at:
 *  - entity_states.flags['lockdown_snapshot'] (non-empty = active lockdown)
 *    for isTenantInGlobalLockdown.
 *  - permissoes with status='suspensa' for tenantHasSensitiveContext.
 *  - isChannelLockedDown always false at this layer — handled upstream.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We import the class under test directly from prod-env.
import { LockdownReaderProdAdapter } from '@/runtime/decision/prod-env.js';

// ---------------------------------------------------------------------------
// DB mocks
// ---------------------------------------------------------------------------

vi.mock('@/db/repositories.js', () => ({
  entityStatesRepo: {
    byId: vi.fn(),
    upsert: vi.fn(),
  },
  procedureExecutionsRepo: {
    findById: vi.fn(),
  },
}));

vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: vi.fn().mockReturnValue('default'),
  getCurrentAgent: vi.fn().mockReturnValue('default'),
  tryGetCurrentContext: vi.fn().mockReturnValue(null),
}));

// Mock the DB client — we control what .select().from().where() returns.
vi.mock('@/db/client.js', () => {
  const mockDb = {
    select: vi.fn(),
  };
  return { db: mockDb };
});

import { db } from '@/db/client.js';

const LOCKDOWN_KEY = 'lockdown_snapshot';

/**
 * Build a drizzle-style chainable mock that resolves to `rows` when awaited.
 * Supports .select().from(table).where(condition) → Promise<rows>
 */
function mockSelectReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

describe('LockdownReaderProdAdapter — entity/permissao layer (Camada 3 #2/4)', () => {
  let adapter: LockdownReaderProdAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LockdownReaderProdAdapter();
  });

  // -------------------------------------------------------------------------
  // T1: entity IS locked down → isTenantInGlobalLockdown returns true
  // -------------------------------------------------------------------------
  it('T1: isTenantInGlobalLockdown → true when entity_states has lockdown_snapshot', async () => {
    mockSelectReturning([
      {
        entidade_id: 'ent-uuid-1',
        tenant_id: 'tenant-A',
        flags: {
          [LOCKDOWN_KEY]: [{ id: 'perm-1', status_before: 'ativa' }],
        },
      },
    ]);

    const result = await adapter.isTenantInGlobalLockdown('tenant-A');
    expect(result).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // T2: entity NOT locked → isTenantInGlobalLockdown returns false
  // -------------------------------------------------------------------------
  it('T2: isTenantInGlobalLockdown → false when no entity_states have lockdown_snapshot', async () => {
    // Entity exists but no lockdown_snapshot in flags
    mockSelectReturning([
      {
        entidade_id: 'ent-uuid-2',
        tenant_id: 'tenant-B',
        flags: { some_other_key: 'value' },
      },
    ]);

    const result = await adapter.isTenantInGlobalLockdown('tenant-B');
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T3: isChannelLockedDown — always false at entity/permissao layer
  // -------------------------------------------------------------------------
  it('T3: isChannelLockedDown → always false at entity/permissao layer (handled upstream)', async () => {
    // This layer does NOT check channel lockdown — that is BaseContextPacket.channel.is_locked_down.
    // We verify no DB query is made.
    const result = await adapter.isChannelLockedDown('ch-1', 'tenant-C');
    expect(result).toBe(false);
    // No DB call should happen for channel-level check
    expect(db.select).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T4 (regression): channel lockdown in Early PEP uses BaseContextPacket,
  // NOT LockdownReader. The lockdownReader must not be called for channel checks.
  // -------------------------------------------------------------------------
  it('T4 (regression): Early PEP channel lockdown uses BaseContextPacket, not LockdownReader', async () => {
    const { EarlyPepImpl } = await import('@/runtime/decision/early-pep.ts');
    const lockdownReader = {
      isChannelLockedDown: vi.fn().mockResolvedValue(false),
      isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
      tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
    };
    const pep = new EarlyPepImpl({
      lockdownReader,
      policyRepo: {
        getBody: vi.fn().mockResolvedValue(null),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
      },
    });

    const result = await pep.evaluate({
      base: {
        trace_id: 't_reg',
        tenant_id: 'tn1',
        agent_id: 'ag1',
        // Channel is_locked_down = true → Early PEP must block immediately via
        // BaseContextPacket short-circuit, not via LockdownReader.
        channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: true },
        actor: { id: 'a1', is_authenticated: true },
        input: { content_ref: 'cref', received_at: new Date('2026-05-20T00:00:00Z') },
      },
      resolved_policies: [],
    });

    // Must be a block decision
    expect('decision' in result).toBe(true);
    expect((result as { decision: string }).decision).toBe('block');
    // LockdownReader must NOT have been consulted — channel check is independent
    expect(lockdownReader.isTenantInGlobalLockdown).not.toHaveBeenCalled();
    expect(lockdownReader.isChannelLockedDown).not.toHaveBeenCalled();
  });
});

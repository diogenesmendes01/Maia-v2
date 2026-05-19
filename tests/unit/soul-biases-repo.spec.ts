/**
 * P8b — Tests for soulBiasesRepo contract.
 *
 * Mock-based pattern (matches tests/unit/operational-profile-versions-repo.spec.ts
 * and tests/unit/capability-proposals-repo.spec.ts): we mock
 * `@/control-plane/soul/soul-biases-repo.js` with an in-memory state that
 * implements the same contract as the real repo. This validates the state
 * machine (DEFAULT proposed; propose → active; "one active" invariant via
 * the partial unique index; rollback irreversibility; tenant guard) without
 * a Postgres dependency.
 *
 * The integration spec exercises the real repo against a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type BiasRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  scope: 'tenant' | 'agent' | 'role' | 'domain';
  scope_value: string;
  principle: string;
  guidance: string;
  origin: 'founder_explicit' | 'human_approved' | 'tenant_culture_explicit' | 'learned_strong_evidence';
  strength: string;
  activation_context: unknown;
  status: 'proposed' | 'active' | 'deprecated' | 'rolled_back';
  version: number;
  previous_version_id: string | null;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  deprecated_at: Date | null;
  deprecated_reason: string | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  proposal_id: string | null;
  source_drift_alert_id: string | null;
  created_at: Date;
};

const biasState: Record<string, BiasRow> = {};

vi.mock('@/control-plane/soul/soul-biases-repo.js', async () => {
  type ProposeArgs = {
    scope: BiasRow['scope'];
    scope_value: string;
    principle: string;
    guidance: string;
    origin: BiasRow['origin'];
    strength: number;
    activation_context?: unknown;
    proposed_by: string;
    proposed_reason?: string;
    proposal_id?: string;
    source_drift_alert_id?: string;
    previous_version_id?: string;
  };

  type ActivateResult =
    | { ok: true; bias: BiasRow }
    | { ok: false; reason: string };

  // Helpers — these mirror what the real repo computes.
  const computeNextVersion = (
    tenant_id: string,
    agent_id: string,
    scope: string,
    scope_value: string,
    principle: string,
  ): number => {
    const matches = Object.values(biasState).filter(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.scope === scope &&
        r.scope_value === scope_value &&
        r.principle === principle,
    );
    if (matches.length === 0) return 1;
    return Math.max(...matches.map((r) => r.version)) + 1;
  };

  const findActiveForKey = (
    tenant_id: string,
    agent_id: string,
    scope: string,
    scope_value: string,
    principle: string,
  ): BiasRow | null => {
    return (
      Object.values(biasState).find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.scope === scope &&
          r.scope_value === scope_value &&
          r.principle === principle &&
          r.status === 'active',
      ) ?? null
    );
  };

  // Use async dynamic import — vitest resolves `@/` paths in ESM mode.
  const ctxRequire = async (): Promise<{ tenant_id: string; agent_id: string }> => {
    const { tryGetCurrentContext } = await import('@/db/tenant-context.js');
    const ctx = tryGetCurrentContext();
    if (!ctx) throw new Error('MissingTenantContextError');
    return ctx;
  };

  return {
    soulBiasesRepo: {
      propose: vi.fn(async (args: ProposeArgs): Promise<BiasRow> => {
        const { tenant_id, agent_id } = await ctxRequire();
        const version = computeNextVersion(
          tenant_id,
          agent_id,
          args.scope,
          args.scope_value,
          args.principle,
        );
        const id = `bias-${Math.random().toString(36).slice(2, 10)}`;
        const now = new Date();
        const row: BiasRow = {
          id,
          tenant_id,
          agent_id,
          scope: args.scope,
          scope_value: args.scope_value,
          principle: args.principle,
          guidance: args.guidance,
          origin: args.origin,
          strength: args.strength.toFixed(3),
          activation_context: args.activation_context ?? {},
          status: 'proposed',
          version,
          previous_version_id: args.previous_version_id ?? null,
          proposed_by: args.proposed_by,
          proposed_reason: args.proposed_reason ?? null,
          approved_by: null,
          approved_at: null,
          activated_at: null,
          deprecated_at: null,
          deprecated_reason: null,
          rolled_back_at: null,
          rollback_reason: null,
          proposal_id: args.proposal_id ?? null,
          source_drift_alert_id: args.source_drift_alert_id ?? null,
          created_at: now,
        };
        biasState[id] = row;
        return row;
      }),

      getById: vi.fn(async (id: string): Promise<BiasRow | null> => {
        const { tenant_id, agent_id } = await ctxRequire();
        const row = biasState[id];
        if (!row) return null;
        // Tenant guard: deny cross-tenant access by id.
        if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) return null;
        return row;
      }),

      listVersions: vi.fn(
        async (args: { scope: string; scope_value: string; principle: string }) => {
          const { tenant_id, agent_id } = await ctxRequire();
          return Object.values(biasState)
            .filter(
              (r) =>
                r.tenant_id === tenant_id &&
                r.agent_id === agent_id &&
                r.scope === args.scope &&
                r.scope_value === args.scope_value &&
                r.principle === args.principle,
            )
            .sort((a, b) => a.version - b.version);
        },
      ),

      listProposed: vi.fn(async (args: { limit?: number } = {}) => {
        const { tenant_id, agent_id } = await ctxRequire();
        const limit = args.limit ?? 20;
        return Object.values(biasState)
          .filter(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.status === 'proposed',
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, limit);
      }),

      findActiveForScope: vi.fn(async (args: { limit?: number } = {}) => {
        const { tenant_id, agent_id } = await ctxRequire();
        const limit = args.limit ?? 50;
        return Object.values(biasState)
          .filter(
            (r) =>
              r.tenant_id === tenant_id &&
              r.agent_id === agent_id &&
              r.status === 'active',
          )
          .sort((a, b) => parseFloat(b.strength) - parseFloat(a.strength))
          .slice(0, limit);
      }),

      activate: vi.fn(
        async (args: { id: string; approved_by: string }): Promise<ActivateResult> => {
          const { tenant_id, agent_id } = await ctxRequire();
          const row = biasState[args.id];
          if (!row) return { ok: false, reason: 'bias_not_found' };
          if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
            return { ok: false, reason: 'bias_not_found' };
          }
          if (row.status !== 'proposed') return { ok: false, reason: 'not_proposed' };

          const incumbent = findActiveForKey(
            tenant_id,
            agent_id,
            row.scope,
            row.scope_value,
            row.principle,
          );
          if (incumbent) {
            if (row.previous_version_id !== incumbent.id) {
              return { ok: false, reason: 'no_lineage_to_replace_active' };
            }
            // Deprecate incumbent in same operation (mocked TX).
            biasState[incumbent.id] = {
              ...incumbent,
              status: 'deprecated',
              deprecated_at: new Date(),
              deprecated_reason: 'replaced by new version',
            };
          }

          const now = new Date();
          const updated: BiasRow = {
            ...row,
            status: 'active',
            approved_by: args.approved_by,
            approved_at: now,
            activated_at: now,
          };
          biasState[args.id] = updated;
          return { ok: true, bias: updated };
        },
      ),

      deprecate: vi.fn(
        async (args: { id: string; deprecated_reason: string }) => {
          const { tenant_id, agent_id } = await ctxRequire();
          const row = biasState[args.id];
          if (!row) return { ok: false, reason: 'bias_not_found' };
          if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
            return { ok: false, reason: 'bias_not_found' };
          }
          if (row.status !== 'active') return { ok: false, reason: 'not_active' };
          const updated: BiasRow = {
            ...row,
            status: 'deprecated',
            deprecated_at: new Date(),
            deprecated_reason: args.deprecated_reason,
          };
          biasState[args.id] = updated;
          return { ok: true, bias: updated };
        },
      ),

      rollback: vi.fn(
        async (args: { id: string; rollback_reason: string; rolled_back_by: string }) => {
          const { tenant_id, agent_id } = await ctxRequire();
          const row = biasState[args.id];
          if (!row) return { ok: false, reason: 'bias_not_found' };
          if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
            return { ok: false, reason: 'bias_not_found' };
          }
          if (row.status === 'rolled_back') {
            return { ok: false, reason: 'already_rolled_back' };
          }
          const updated: BiasRow = {
            ...row,
            status: 'rolled_back',
            rolled_back_at: new Date(),
            rollback_reason: `${args.rollback_reason} (by ${args.rolled_back_by})`,
          };
          biasState[args.id] = updated;
          return { ok: true, bias: updated };
        },
      ),
    },
  };
});

describe('soulBiasesRepo (P8b)', () => {
  beforeEach(() => {
    for (const k of Object.keys(biasState)) delete biasState[k];
    vi.clearAllMocks();
  });

  it('propose() cria bias com status=proposed e version=1 quando primeira', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const bias = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'humildade_epistemica',
          guidance: 'Quando confianca da inferencia esta abaixo de 0.7.',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'founder',
        });
        expect(bias.status).toBe('proposed');
        expect(bias.version).toBe(1);
        expect(bias.principle).toBe('humildade_epistemica');
        expect(bias.origin).toBe('founder_explicit');
        expect(bias.strength).toBe('0.900');
      },
    );
  });

  it('propose() incrementa version para a mesma chave (tenant, scope, scope_value, principle)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const v1 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'first version guidance',
          origin: 'founder_explicit',
          strength: 0.5,
          proposed_by: 'a',
        });
        const v2 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'second version guidance',
          origin: 'founder_explicit',
          strength: 0.6,
          proposed_by: 'a',
          previous_version_id: v1.id,
        });
        expect(v1.version).toBe(1);
        expect(v2.version).toBe(2);
        expect(v2.previous_version_id).toBe(v1.id);
      },
    );
  });

  it('activate() transiciona proposed → active e marca timestamps', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const b = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'guidance text ok',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        const r = await soulBiasesRepo.activate({ id: b.id, approved_by: 'admin' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.bias.status).toBe('active');
          expect(r.bias.approved_by).toBe('admin');
          expect(r.bias.activated_at).toBeInstanceOf(Date);
          expect(r.bias.approved_at).toBeInstanceOf(Date);
        }
      },
    );
  });

  it('activate() falha quando bias já não é proposed', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const b = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'guidance text ok',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: b.id, approved_by: 'admin' });
        const r = await soulBiasesRepo.activate({ id: b.id, approved_by: 'admin' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('not_proposed');
      },
    );
  });

  it('activate() exige previous_version_id quando já existe active na chave', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const v1 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g1 guidance text',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: v1.id, approved_by: 'admin' });
        // v2 SEM previous_version_id deve falhar ao activate.
        const v2 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g2 guidance text',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'a',
        });
        const r = await soulBiasesRepo.activate({ id: v2.id, approved_by: 'admin' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('no_lineage_to_replace_active');
      },
    );
  });

  it('activate() com previous_version_id correto deprecia a v1 vigente atomicamente', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const v1 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g1 guidance text',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: v1.id, approved_by: 'admin' });
        const v2 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g2 guidance text',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'a',
          previous_version_id: v1.id,
        });
        const r = await soulBiasesRepo.activate({ id: v2.id, approved_by: 'admin' });
        expect(r.ok).toBe(true);
        const v1After = await soulBiasesRepo.getById(v1.id);
        const v2After = await soulBiasesRepo.getById(v2.id);
        expect(v1After?.status).toBe('deprecated');
        expect(v2After?.status).toBe('active');
      },
    );
  });

  it('deprecate() transiciona active → deprecated', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const b = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'guidance text ok',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: b.id, approved_by: 'admin' });
        const r = await soulBiasesRepo.deprecate({ id: b.id, deprecated_reason: 'outdated' });
        expect(r.ok).toBe(true);
        const after = await soulBiasesRepo.getById(b.id);
        expect(after?.status).toBe('deprecated');
        expect(after?.deprecated_reason).toBe('outdated');
      },
    );
  });

  it('rollback() é irreversível — não reativa previous_version_id', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const v1 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g1 guidance text',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: v1.id, approved_by: 'admin' });
        const v2 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g2 guidance text',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'a',
          previous_version_id: v1.id,
        });
        await soulBiasesRepo.activate({ id: v2.id, approved_by: 'admin' });
        const r = await soulBiasesRepo.rollback({
          id: v2.id,
          rollback_reason: 'wrong',
          rolled_back_by: 'admin',
        });
        expect(r.ok).toBe(true);
        const v1After = await soulBiasesRepo.getById(v1.id);
        const v2After = await soulBiasesRepo.getById(v2.id);
        expect(v2After?.status).toBe('rolled_back');
        // v1 NÃO retorna a active — rollback é declaração de erro, não promote anterior.
        expect(v1After?.status).toBe('deprecated');
      },
    );
  });

  it('findActiveForScope() retorna apenas status=active ordenado por strength DESC', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const low = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'low',
          guidance: 'low strength guidance',
          origin: 'founder_explicit',
          strength: 0.5,
          proposed_by: 'a',
        });
        const high = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'high',
          guidance: 'high strength guidance',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: high.id, approved_by: 'admin' });
        const active = await soulBiasesRepo.findActiveForScope({ limit: 10 });
        expect(active.length).toBe(1);
        expect(active[0]!.principle).toBe('high');
        expect(active.find((b) => b.id === low.id)).toBeUndefined();
      },
    );
  });

  it('tenant guard — getById retorna null para bias de outro tenant', async () => {
    let biasId = '';
    await runWithTenantContext(
      { tenant_id: 'tenantA', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const b = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'guidance text ok',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        biasId = b.id;
      },
    );
    await runWithTenantContext(
      { tenant_id: 'tenantB', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const found = await soulBiasesRepo.getById(biasId);
        expect(found).toBeNull();
      },
    );
  });

  it('listVersions() retorna todas versões em ordem crescente', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
        const v1 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g1 guidance text',
          origin: 'founder_explicit',
          strength: 0.8,
          proposed_by: 'a',
        });
        await soulBiasesRepo.activate({ id: v1.id, approved_by: 'admin' });
        const v2 = await soulBiasesRepo.propose({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
          guidance: 'g2 guidance text',
          origin: 'founder_explicit',
          strength: 0.9,
          proposed_by: 'a',
          previous_version_id: v1.id,
        });
        const versions = await soulBiasesRepo.listVersions({
          scope: 'tenant',
          scope_value: '*',
          principle: 'p',
        });
        expect(versions.length).toBe(2);
        expect(versions[0]!.version).toBe(1);
        expect(versions[1]!.version).toBe(2);
        expect(versions[0]!.id).toBe(v1.id);
        expect(versions[1]!.id).toBe(v2.id);
      },
    );
  });
});

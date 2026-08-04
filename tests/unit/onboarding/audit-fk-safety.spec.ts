/**
 * Issue #519 — prova SEM BANCO de que a saga nunca escreve em
 * `admin_audit_log.tenant_id` um tenant que ainda não existe.
 *
 * `admin_audit_log.tenant_id` é `TEXT NOT NULL REFERENCES tenants(id)`
 * (`migrations/047_admin_audit_log.sql:10`). O código original escrevia
 * `run.tenant_id ?? 'system'` — o comentário no repo dizia "é NOT NULL" e
 * parou aí. Numa run `tenant_onboarding` o `tenant_id` da run é o tenant que a
 * saga ainda VAI criar (`provision_tenant` é um passo), então a FK estourava
 * 23503 já na CRIAÇÃO da run, e de novo no CANCELAMENTO de uma run em
 * `created`. Todos os testes com store falso passavam: um store falso não tem
 * integridade referencial.
 *
 * A correção deste teste é o `tx` FALSO COM INTEGRIDADE REFERENCIAL: ele
 * conhece o conjunto de tenants existentes e recusa a inserção em
 * `admin_audit_log` exatamente como o Postgres, com `code='23503'`. É a
 * propriedade que faltava — não "o insert foi chamado", mas "o insert era
 * LEGAL".
 *
 * O teste também trava as duas metades do contrato de correção:
 *   - a linha de auditoria SEMPRE existe (não some numa run sem tenant);
 *   - o tenant PRETENDIDO continua recuperável em
 *     `change_summary.target_tenant_id` — a trilha segue atribuível.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ── O banco falso com FK de verdade ──────────────────────────────────────────

type Row = Record<string, unknown>;

class FkViolation extends Error {
  code = '23503';
  constructor(tenant: string) {
    super(
      `insert or update on table "admin_audit_log" violates foreign key constraint ` +
        `"admin_audit_log_tenant_id_fkey" — Key (tenant_id)=(${tenant}) is not present in table "tenants".`,
    );
  }
}

/** Estado do "banco" entre os testes. */
const state = {
  tenants: new Set<string>(),
  runs: [] as Row[],
  events: [] as Row[],
  stepResults: [] as Row[],
  audit: [] as Row[],
  /** `true` enquanto uma transação estiver aberta (para provar o rollback). */
  committed: true,
};

function paramsOf(where: SQL): unknown[] {
  return new PgDialect().sqlToQuery(where).params;
}

function makeTx(schema: {
  tenants: object;
  onboarding_runs: object;
  onboarding_events: object;
  onboarding_step_results: object;
  admin_audit_log: object;
}) {
  const tableOf = (t: object): string => {
    if (t === schema.tenants) return 'tenants';
    if (t === schema.onboarding_runs) return 'onboarding_runs';
    if (t === schema.onboarding_events) return 'onboarding_events';
    if (t === schema.onboarding_step_results) return 'onboarding_step_results';
    if (t === schema.admin_audit_log) return 'admin_audit_log';
    throw new Error('tabela inesperada no tx falso');
  };

  function selectChain(table: string) {
    let params: unknown[] = [];
    const chain: Record<string, unknown> = {
      where: (w: SQL) => {
        params = paramsOf(w);
        return chain;
      },
      for: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows()),
      then: (resolve: (v: unknown) => unknown) => resolve(rows()),
    };
    function rows(): Row[] {
      if (table === 'tenants') {
        const id = params[0] as string;
        return state.tenants.has(id) ? [{ id }] : [];
      }
      if (table === 'onboarding_runs') {
        return state.runs.filter((r) => params.includes(r.id));
      }
      // O ledger de idempotência começa sempre vazio nestes casos.
      return [];
    }
    return chain;
  }

  return {
    select: (_fields?: unknown) => ({ from: (t: object) => selectChain(tableOf(t)) }),
    insert: (t: object) => ({
      values: (v: Row) => {
        const table = tableOf(t);
        if (table === 'admin_audit_log') {
          const tenant = String(v.tenant_id);
          // ESTA é a linha que faltava em qualquer fake anterior.
          if (!state.tenants.has(tenant)) throw new FkViolation(tenant);
          state.audit.push(v);
        } else if (table === 'tenants') {
          state.tenants.add(String(v.id));
        } else if (table === 'onboarding_events') {
          state.events.push(v);
        } else if (table === 'onboarding_step_results') {
          state.stepResults.push(v);
        } else if (table === 'onboarding_runs') {
          const row: Row = {
            id: 'run-uuid-0001',
            current_step: null,
            completed_at: null,
            cancelled_at: null,
            last_error_code: null,
            created_at: new Date(),
            updated_at: new Date(),
            ...v,
          };
          state.runs.push(row);
          const ret = Promise.resolve([row]) as Promise<Row[]> & { returning: () => Promise<Row[]> };
          ret.returning = () => Promise.resolve([row]);
          return ret;
        }
        const done = Promise.resolve([]) as Promise<Row[]> & { returning: () => Promise<Row[]> };
        done.returning = () => Promise.resolve([]);
        return done;
      },
    }),
    update: (t: object) => ({
      set: (patch: Row) => {
        const table = tableOf(t);
        let params: unknown[] = [];
        const chain: Record<string, unknown> = {
          where: (w: SQL) => {
            params = paramsOf(w);
            return chain;
          },
          returning: () => {
            if (table !== 'onboarding_runs') return Promise.resolve([]);
            const hit = state.runs.find((r) => params.includes(r.id));
            if (!hit) return Promise.resolve([]);
            Object.assign(hit, patch);
            return Promise.resolve([{ ...hit }]);
          },
          then: (resolve: (v: unknown) => unknown) => resolve([]),
        };
        return chain;
      },
    }),
  };
}

vi.mock('../../../src/db/client.js', async () => {
  const schema = await import('../../../src/db/schema.js');
  return {
    db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) },
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.committed = false;
      // Snapshot para emular o ROLLBACK: se `fn` lançar, nada persiste.
      const snapshot = {
        tenants: new Set(state.tenants),
        runs: state.runs.map((r) => ({ ...r })),
        events: [...state.events],
        stepResults: [...state.stepResults],
        audit: [...state.audit],
      };
      try {
        const out = await fn(makeTx(schema as never) as never);
        state.committed = true;
        return out;
      } catch (err) {
        state.tenants = snapshot.tenants;
        state.runs = snapshot.runs;
        state.events = snapshot.events;
        state.stepResults = snapshot.stepResults;
        state.audit = snapshot.audit;
        throw err;
      }
    },
    pgErrorCode: (err: unknown) => (err as { code?: string })?.code,
  };
});

const TARGET_TENANT = 'acme';

beforeEach(() => {
  state.tenants = new Set(['system']); // semeado por migrations/014
  state.runs = [];
  state.events = [];
  state.stepResults = [];
  state.audit = [];
  state.committed = true;
});

async function repo() {
  return (await import('../../../src/db/repositories/onboarding-repos.js')).onboardingRunsRepo;
}

function baseCreate() {
  return {
    kind: 'tenant_onboarding' as const,
    tenant_id: TARGET_TENANT,
    agent_id: null,
    created_by: 'op-1',
    actor_role: 'owner',
    correlation_id: 'corr-1',
    expires_at: new Date(Date.now() + 3_600_000),
    configuration_contract_version: '1',
    schema_version: 'sf',
  };
}

describe('onboarding — auditoria não viola a FK de admin_audit_log', () => {
  it('o tx falso REALMENTE recusa um tenant inexistente (guarda do próprio teste)', async () => {
    const schema = await import('../../../src/db/schema.js');
    const tx = makeTx(schema as never);
    expect(() =>
      tx.insert(schema.admin_audit_log).values({ tenant_id: 'nao-existe' }),
    ).toThrow(/admin_audit_log_tenant_id_fkey/);
  });

  it('criar a run do tenant que AINDA NÃO EXISTE não viola a FK', async () => {
    const r = await repo();
    await expect(r.create(baseCreate())).resolves.toBeTruthy();
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.tenant_id).toBe('system');
  });

  it('e a trilha continua ATRIBUÍVEL: o tenant pretendido fica em change_summary', async () => {
    const r = await repo();
    const run = await r.create(baseCreate());
    const summary = state.audit[0]!.change_summary as Record<string, unknown>;
    expect(summary.target_tenant_id).toBe(TARGET_TENANT);
    expect(summary.run_id).toBe(run.id);
    expect(state.audit[0]!.action).toBe('onboarding_run_started');
  });

  it('quando o tenant JÁ existe, a auditoria vai para ele, não para o bucket', async () => {
    state.tenants.add(TARGET_TENANT);
    const r = await repo();
    await r.create(baseCreate());
    expect(state.audit[0]!.tenant_id).toBe(TARGET_TENANT);
  });

  it('cancelar uma run em `created` (antes de provision_tenant) não viola a FK', async () => {
    const r = await repo();
    const run = await r.create(baseCreate());
    state.audit.length = 0;

    const out = await r.cancel({
      run_id: run.id,
      tenant_id: TARGET_TENANT,
      expected_version: 1,
      actor_id: 'op-1',
      actor_role: 'owner',
      correlation_id: 'corr-2',
      reason_code: 'desistiu',
    });

    expect(out.outcome).toBe('committed');
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.tenant_id).toBe('system');
    expect(
      (state.audit[0]!.change_summary as Record<string, unknown>).target_tenant_id,
    ).toBe(TARGET_TENANT);
  });

  it('depois de provision_tenant, a auditoria do MESMO tx já usa o tenant real', async () => {
    // Prova a razão de o SELECT rodar dentro do `tx`: o tenant inserido pelo
    // `apply` deste passo é visível para a resolução da auditoria do passo.
    const r = await repo();
    const schema = await import('../../../src/db/schema.js');
    const run = await r.create(baseCreate());
    state.audit.length = 0;

    const out = await r.commitStep({
      run_id: run.id,
      tenant_id: TARGET_TENANT,
      expected_version: 1,
      step: 'provision_tenant',
      idempotency_key_hash: 'a'.repeat(64),
      payload_hash: 'b'.repeat(64),
      actor_id: 'op-1',
      actor_role: 'owner',
      correlation_id: 'corr-3',
      apply: async (tx) => {
        await (tx as unknown as ReturnType<typeof makeTx>)
          .insert(schema.tenants)
          .values({ id: TARGET_TENANT, nome: 'Acme' });
        return {
          result: { tenant_id: TARGET_TENANT },
          scope_patch: { tenant_id: TARGET_TENANT },
          audit: {
            action: 'onboarding_tenant_provisioned',
            resource_type: 'tenant',
            resource_id: TARGET_TENANT,
          },
        };
      },
    });

    expect(out.outcome).toBe('committed');
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.tenant_id).toBe(TARGET_TENANT);
  });

  it('uma run de bootstrap SEM tenant também audita no bucket', async () => {
    const r = await repo();
    await r.create({ ...baseCreate(), kind: 'global_bootstrap', tenant_id: null });
    expect(state.audit[0]!.tenant_id).toBe('system');
    expect(
      (state.audit[0]!.change_summary as Record<string, unknown>).target_tenant_id,
    ).toBeNull();
  });
});

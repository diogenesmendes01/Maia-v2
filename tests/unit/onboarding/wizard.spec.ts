/**
 * Issue #519 — o ORQUESTRADOR, contra um store de saga em memória.
 *
 * O store falso reproduz FIELMENTE a ordem de decisão do `commitStep` real
 * (ledger → versão → transição → apply → commit/deny), que é o que dá sentido
 * a testar o wizard sem Postgres: o que muda entre os dois é só o mecanismo de
 * durabilidade (transação + `FOR UPDATE`), coberto pela suíte de integração.
 *
 * O que provamos aqui:
 *   - RBAC por comando e isolamento horizontal (run de outro tenant não é
 *     descoberta nem mutável);
 *   - retomada: um comando novo parte do estado PERSISTIDO, não de memória;
 *   - replay da mesma chave devolve o resultado persistido sem re-executar;
 *   - mesma chave com payload divergente é conflito;
 *   - double-click com DUAS chaves não duplica provisionamento;
 *   - concorrência otimista (dois operadores, um avanço);
 *   - ativação reavalia readiness e falha FECHADA;
 *   - o par confirmado precisa bater com o escopo da run;
 *   - o `command_id` de pareamento é derivado (retry idempotente).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingRunRow } from '../../../src/db/schema.js';
import type {
  CommitStepInput,
  CommitStepOutcome,
  StepApplication,
} from '../../../src/db/repositories/onboarding-repos.js';
import { planTransition, type OnboardingState } from '../../../src/onboarding/state-machine.js';

// ── Store de saga em memória ─────────────────────────────────────────────────

type LedgerRow = { payload_hash: string; result: Record<string, unknown> };

const runs = new Map<string, OnboardingRunRow>();
const ledger = new Map<string, LedgerRow>();
/** Quantas vezes o `apply` de cada passo REALMENTE rodou. */
const applyCalls: string[] = [];

function ledgerKey(run_id: string, step: string, hash: string): string {
  return `${run_id}:${step}:${hash}`;
}

function makeRun(over: Partial<OnboardingRunRow> = {}): OnboardingRunRow {
  const now = new Date();
  return {
    id: 'run-1',
    kind: 'tenant_onboarding',
    tenant_id: 'acme',
    agent_id: 'acme-bot',
    state: 'created',
    current_step: null,
    version: 1,
    created_by: 'u1',
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
    expires_at: new Date(Date.now() + 3_600_000),
    last_error_code: null,
    metadata: {},
    configuration_contract_version: '1',
    schema_version: 'sf',
    ...over,
  } as OnboardingRunRow;
}

const fakeRepo = {
  async getForScope(input: { run_id: string; tenant_id: string | null }) {
    const run = runs.get(input.run_id);
    if (!run) return null;
    // MESMO predicado do repo real: o tenant do chamador entra no WHERE.
    // `null` = SEM FILTRO (privilégio exclusivo do founder).
    if (input.tenant_id !== null && run.tenant_id !== input.tenant_id) return null;
    return run;
  },

  async commitStep(input: CommitStepInput): Promise<CommitStepOutcome> {
    const run = runs.get(input.run_id);
    if (!run) return { outcome: 'not_found' };
    if (input.tenant_id !== null && run.tenant_id !== null && run.tenant_id !== input.tenant_id) {
      return { outcome: 'not_found' };
    }
    if (run.expires_at.getTime() <= Date.now()) {
      return { outcome: 'invalid_transition', run, code: 'run_expired', message: 'expirada' };
    }

    // (1) LEDGER antes da versão — um retry após commit perdido traz a versão antiga.
    const key = ledgerKey(run.id, input.step, input.idempotency_key_hash);
    const previous = ledger.get(key);
    if (previous) {
      if (previous.payload_hash !== input.payload_hash) {
        return { outcome: 'payload_conflict', run };
      }
      return { outcome: 'replayed', run, result: previous.result };
    }

    // (2) Concorrência otimista.
    if (run.version !== input.expected_version) return { outcome: 'version_conflict', run };

    // (3) Transição contra o estado persistido.
    let plan;
    try {
      plan = planTransition({ step: input.step, from: run.state as OnboardingState });
    } catch (err) {
      return {
        outcome: 'invalid_transition',
        run,
        code: (err as { code?: string }).code ?? 'invalid_transition',
        message: (err as Error).message,
      };
    }

    // (4) A escrita do passo.
    applyCalls.push(input.step);
    const applied: StepApplication = await input.apply({} as never, run);

    if (applied.deny) {
      const denied = { ...run, state: plan.onDeny, version: run.version + 1, current_step: input.step, last_error_code: applied.deny.code };
      runs.set(run.id, denied as OnboardingRunRow);
      return { outcome: 'denied', run: denied as OnboardingRunRow, code: applied.deny.code, message: applied.deny.message };
    }

    ledger.set(key, { payload_hash: input.payload_hash, result: applied.result });
    const updated = {
      ...run,
      state: plan.to,
      version: run.version + 1,
      current_step: input.step,
      tenant_id: applied.scope_patch?.tenant_id ?? run.tenant_id,
      agent_id: applied.scope_patch?.agent_id ?? run.agent_id,
      last_error_code: null,
      ...(applied.completes ? { completed_at: new Date() } : {}),
    };
    runs.set(run.id, updated as OnboardingRunRow);
    return { outcome: 'committed', run: updated as OnboardingRunRow, result: applied.result };
  },

  async cancel(input: { run_id: string; expected_version: number; reason_code: string }) {
    const run = runs.get(input.run_id);
    if (!run) return { outcome: 'not_found' as const };
    if (['active', 'cancelled', 'failed_terminal'].includes(run.state)) {
      return { outcome: 'invalid_transition' as const, run, code: 'run_terminal', message: 'terminal' };
    }
    if (run.version !== input.expected_version) return { outcome: 'version_conflict' as const, run };
    const cancelled = { ...run, state: 'cancelled', version: run.version + 1, cancelled_at: new Date(), last_error_code: input.reason_code };
    runs.set(run.id, cancelled as OnboardingRunRow);
    return { outcome: 'committed' as const, run: cancelled as OnboardingRunRow, result: {} };
  },

  async create() {
    throw new Error('não usado nestes testes');
  },
  async listForTenant() {
    return [...runs.values()];
  },
  async listEvents() {
    return [];
  },
  async expireStale() {
    return 0;
  },
};

vi.mock('@/db/repositories/onboarding-repos.js', () => ({ onboardingRunsRepo: fakeRepo }));

// As escritas de provisionamento reais precisam de Postgres; aqui só nos
// interessa a ORQUESTRAÇÃO. Cada `apply*` vira um stub que devolve a mesma
// forma de `StepApplication`.
vi.mock('@/onboarding/provisioning.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/onboarding/provisioning.js')>();
  const stub = (action: string, result: Record<string, unknown> = {}) =>
    vi.fn(async () => ({ result, audit: { action, resource_type: 'x', resource_id: null } }));
  return {
    ...original,
    applyProvisionTenant: vi.fn(async (_tx: unknown, _run: unknown, payload: { tenant_id: string }) => ({
      result: { tenant_id: payload.tenant_id },
      scope_patch: { tenant_id: payload.tenant_id },
      audit: { action: 'onboarding_tenant_provisioned', resource_type: 'tenant', resource_id: payload.tenant_id },
    })),
    applyProvisionAdmin: stub('onboarding_admin_provisioned'),
    applyProvisionAgent: vi.fn(async (_tx: unknown, _run: unknown, payload: { agent_id: string }) => ({
      result: { agent_id: payload.agent_id },
      scope_patch: { agent_id: payload.agent_id },
      audit: { action: 'onboarding_agent_provisioned', resource_type: 'agent', resource_id: payload.agent_id },
    })),
    applyConfigureProfile: stub('onboarding_profile_activated'),
    applyCapabilityPacks: stub('onboarding_packs_applied'),
    applyConfigureRole: stub('onboarding_role_configured', { role_id: 'r1' }),
    applyDeclareChannel: stub('onboarding_channel_declared', { channel_id: 'c1' }),
    applyConfirmChannelReady: stub('onboarding_channel_confirmed'),
    applyActivate: vi.fn(async () => ({
      result: { activated: true },
      completes: true,
      audit: { action: 'onboarding_agent_activated', resource_type: 'agent', resource_id: 'acme-bot' },
    })),
  };
});

// `audit()` grava em Postgres; aqui só precisamos saber que foi chamado.
const auditSpy = vi.fn(async () => undefined);
vi.mock('@/governance/audit.js', () => ({ audit: auditSpy, auditTx: vi.fn() }));

const {
  executeOnboardingStep,
  cancelOnboardingRun,
  getOnboardingRun,
  deriveCommandId,
} = await import('../../../src/onboarding/wizard.js');
const { OnboardingError } = await import('../../../src/onboarding/errors.js');

const OWNER = { actor_id: 'u1', actor_role: 'owner' as const, tenant_id: 'acme' };
const FOUNDER = { actor_id: 'root', actor_role: 'founder' as const, tenant_id: null };

/** Readiness sempre verde, injetado. */
const readyReport = (over: Record<string, unknown> = {}) =>
  ({
    tenant_id: 'acme',
    agent_id: 'acme-bot',
    ready: true,
    checks: [],
    evaluated_at: new Date().toISOString(),
    configuration_fingerprint: 'cfg',
    schema_fingerprint: 'sch',
    ...over,
  }) as never;

beforeEach(() => {
  runs.clear();
  ledger.clear();
  applyCalls.length = 0;
  auditSpy.mockClear();
});

describe('RBAC e isolamento horizontal', () => {
  beforeEach(() => runs.set('run-1', makeRun()));

  it('operador de OUTRO tenant não descobre a run (not_found, não forbidden)', async () => {
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'provision_tenant',
      payload: { tenant_id: 'acme', nome: 'Acme' },
      idempotency_key: 'chave-suficiente-1',
      expected_version: 1,
      actor: { actor_id: 'u9', actor_role: 'owner', tenant_id: 'globex' },
    });
    expect(out).toEqual({ status: 'not_found' });
    expect(applyCalls).toEqual([]);
  });

  it('papel sem permissão de mutação é recusado', async () => {
    await expect(
      executeOnboardingStep({
        run_id: 'run-1',
        step: 'provision_tenant',
        payload: { tenant_id: 'acme', nome: 'Acme' },
        idempotency_key: 'chave-suficiente-1',
        expected_version: 1,
        actor: { actor_id: 'u2', actor_role: 'viewer', tenant_id: 'acme' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('leitura de outro tenant devolve null', async () => {
    expect(
      await getOnboardingRun({
        run_id: 'run-1',
        actor: { actor_id: 'u9', actor_role: 'owner', tenant_id: 'globex' },
      }),
    ).toBeNull();
    expect(await getOnboardingRun({ run_id: 'run-1', actor: OWNER })).not.toBeNull();
  });

  it('founder global alcança a run', async () => {
    expect(await getOnboardingRun({ run_id: 'run-1', actor: FOUNDER })).not.toBeNull();
  });

  it('sessão SEM tenant de um papel não-global é recusada — nunca vira "vê tudo"', async () => {
    // O `null` de filtro é privilégio exclusivo do founder. Um owner com
    // sessão sem tenant cairia em "sem filtro" se a derivação fosse ingênua.
    await expect(
      getOnboardingRun({
        run_id: 'run-1',
        actor: { actor_id: 'u3', actor_role: 'owner', tenant_id: null },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('retomada, idempotência e concorrência', () => {
  beforeEach(() => runs.set('run-1', makeRun()));

  const provision = (key: string, version: number, nome = 'Acme') =>
    executeOnboardingStep({
      run_id: 'run-1',
      step: 'provision_tenant',
      payload: { tenant_id: 'acme', nome },
      idempotency_key: key,
      expected_version: version,
      actor: OWNER,
    });

  it('o comando parte do estado PERSISTIDO — retomada após reinício', async () => {
    // Simula o processo tendo morrido: a run está em `tenant_ready` no banco e
    // o wizard nunca viu o passo anterior nesta "instância".
    runs.set('run-1', makeRun({ state: 'tenant_ready', version: 2 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'provision_admin',
      payload: { user_id: 'admin-1', email: 'a@acme.com' },
      idempotency_key: 'chave-suficiente-2',
      expected_version: 2,
      actor: OWNER,
    });
    expect(out.status).toBe('completed');
    expect(runs.get('run-1')!.state).toBe('admin_ready');
  });

  it('retry com a MESMA chave devolve o resultado persistido SEM re-executar', async () => {
    const first = await provision('chave-suficiente-1', 1);
    expect(first).toMatchObject({ status: 'completed', replayed: false });
    // O cliente não viu a resposta e repete com a versão ANTIGA.
    const retry = await provision('chave-suficiente-1', 1);
    expect(retry).toMatchObject({ status: 'completed', replayed: true });
    expect(applyCalls).toEqual(['provision_tenant']); // rodou UMA vez
  });

  it('mesma chave com payload DIVERGENTE é conflito', async () => {
    await provision('chave-suficiente-1', 1);
    const out = await provision('chave-suficiente-1', 1, 'Outro Nome');
    expect(out).toMatchObject({ status: 'conflict', code: 'idempotency_payload_mismatch' });
  });

  it('double-click com DUAS chaves não duplica o provisionamento', async () => {
    await provision('chave-suficiente-1', 1);
    const second = await provision('chave-suficiente-9', 1);
    // O ledger não cobre a chave nova; quem barra é a máquina de estados.
    expect(second.status).toBe('conflict');
    expect(applyCalls).toEqual(['provision_tenant']);
  });

  it('dois operadores na mesma versão: um avança, o outro vê version_conflict', async () => {
    runs.set('run-1', makeRun({ state: 'tenant_ready', version: 2 }));
    const a = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'provision_admin',
      payload: { user_id: 'admin-1', email: 'a@acme.com' },
      idempotency_key: 'chave-operador-a',
      expected_version: 2,
      actor: OWNER,
    });
    const b = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'provision_admin',
      payload: { user_id: 'admin-2', email: 'b@acme.com' },
      idempotency_key: 'chave-operador-b',
      expected_version: 2,
      actor: { ...OWNER, actor_id: 'u2' },
    });
    expect(a.status).toBe('completed');
    expect(b).toMatchObject({ status: 'conflict', code: 'version_conflict' });
  });

  it('run expirada não avança', async () => {
    runs.set('run-1', makeRun({ expires_at: new Date(Date.now() - 1000) }));
    const out = await provision('chave-suficiente-1', 1);
    expect(out).toMatchObject({ status: 'conflict', code: 'run_expired' });
  });

  it('chave de idempotência ausente/curta é recusada antes de qualquer escrita', async () => {
    await expect(provision('curta', 1)).rejects.toBeInstanceOf(OnboardingError);
    expect(applyCalls).toEqual([]);
  });

  it('payload fora do contrato é recusado antes de qualquer escrita', async () => {
    await expect(
      executeOnboardingStep({
        run_id: 'run-1',
        step: 'provision_tenant',
        payload: { tenant_id: 'acme' }, // falta `nome`
        idempotency_key: 'chave-suficiente-1',
        expected_version: 1,
        actor: OWNER,
      }),
    ).rejects.toBeInstanceOf(OnboardingError);
    expect(applyCalls).toEqual([]);
  });
});

describe('readiness e ativação — fail-closed', () => {
  it('readiness reprovado leva a `readiness_failed` e NÃO ativa', async () => {
    runs.set('run-1', makeRun({ state: 'channel_ready', version: 5 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: 'chave-readiness-1',
      expected_version: 5,
      actor: OWNER,
      deps: {
        evaluateReadiness: async () =>
          readyReport({
            ready: false,
            checks: [
              {
                code: 'profile_active',
                status: 'fail',
                severity: 'blocking',
                message: 'sem profile',
                remediation: 'aprove',
              },
            ],
          }),
      },
    });
    expect(out).toMatchObject({ status: 'denied', code: 'readiness_blocked' });
    expect(runs.get('run-1')!.state).toBe('readiness_failed');
  });

  it('readiness aprovado leva a `ready_for_activation`', async () => {
    runs.set('run-1', makeRun({ state: 'channel_ready', version: 5 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: 'chave-readiness-2',
      expected_version: 5,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport() },
    });
    expect(out.status).toBe('completed');
    expect(runs.get('run-1')!.state).toBe('ready_for_activation');
  });

  it('a ativação REAVALIA readiness: verde há cinco minutos não ativa agora', async () => {
    runs.set('run-1', makeRun({ state: 'ready_for_activation', version: 6 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'activate',
      payload: { confirm_tenant_id: 'acme', confirm_agent_id: 'acme-bot' },
      idempotency_key: 'chave-ativacao-1',
      expected_version: 6,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport({ ready: false }) },
    });
    expect(out).toMatchObject({ status: 'denied', code: 'readiness_blocked' });
    expect(runs.get('run-1')!.state).toBe('readiness_failed');
  });

  it('o par CONFIRMADO precisa bater com o escopo da run', async () => {
    runs.set('run-1', makeRun({ state: 'ready_for_activation', version: 6 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'activate',
      payload: { confirm_tenant_id: 'acme', confirm_agent_id: 'agente-errado' },
      idempotency_key: 'chave-ativacao-2',
      expected_version: 6,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport() },
    });
    expect(out).toMatchObject({ status: 'denied', code: 'scope_mismatch' });
  });

  it('ativação bem-sucedida conclui a run e audita a decisão no escopo do agente', async () => {
    runs.set('run-1', makeRun({ state: 'ready_for_activation', version: 6 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'activate',
      payload: { confirm_tenant_id: 'acme', confirm_agent_id: 'acme-bot' },
      idempotency_key: 'chave-ativacao-3',
      expected_version: 6,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport() },
    });
    expect(out.status).toBe('completed');
    expect(runs.get('run-1')!.state).toBe('active');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'agent_activation_approved',
        // `alvo_id` é coluna `uuid` em `audit_log` e `agents.id` é TEXT: mandar
        // o id do agente ali é 22P02, e `audit()` engole a exceção — a linha
        // sumia em silêncio. Esta asserção ANTES afirmava `alvo_id: 'acme-bot'`,
        // ou seja, o teste falso PINAVA o defeito. O agente segue atribuível
        // pela coluna `agent_id` (TEXT, via ALS) e por `metadata`.
        alvo_id: null,
        metadata: expect.objectContaining({ agent_id: 'acme-bot', tenant_id: 'acme' }),
      }),
    );
  });

  it('nenhum campo uuid da trilha do agente recebe um id textual', async () => {
    // Asserção tipada pelo SCHEMA, não por literal: lê de `migrations/*.sql`
    // quais colunas de `audit_log` são `uuid` e exige `null` ou uuid canônico
    // em cada campo correspondente do payload. É o que faltava — um `vi.fn()`
    // aceita qualquer string, e por isso a lacuna sobreviveu à suíte inteira.
    const { UUID_RE, uuidColumnsOf } = await import('./_migration-schema.js');
    const PAYLOAD_TO_COLUMN: Record<string, string> = {
      pessoa_id: 'pessoa_id',
      alvo_id: 'alvo_id',
      conversa_id: 'conversa_id',
      mensagem_id: 'mensagem_id',
      occurrence_id: 'occurrence_id',
    };
    const uuidCols = uuidColumnsOf('audit_log');
    expect(uuidCols.has('alvo_id'), 'guarda do parser: alvo_id deveria ser uuid').toBe(true);

    for (const [step, from, version] of [
      ['evaluate_readiness', 'channel_ready', 5],
      ['activate', 'ready_for_activation', 6],
    ] as const) {
      auditSpy.mockClear();
      runs.set('run-1', makeRun({ state: from, version }));
      await executeOnboardingStep({
        run_id: 'run-1',
        step,
        payload:
          step === 'activate'
            ? { confirm_tenant_id: 'acme', confirm_agent_id: 'acme-bot' }
            : {},
        idempotency_key: `chave-uuid-${step}`,
        expected_version: version,
        actor: OWNER,
        deps: { evaluateReadiness: async () => readyReport() },
      });

      expect(auditSpy, `o passo ${step} não emitiu audit()`).toHaveBeenCalledTimes(1);
      const payload = auditSpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      for (const [field, column] of Object.entries(PAYLOAD_TO_COLUMN)) {
        if (!uuidCols.has(column)) continue;
        const value = payload[field];
        if (value === undefined || value === null) continue;
        expect(
          String(value),
          `audit_log.${column} é coluna uuid, mas o passo ${step} mandou ` +
            `${JSON.stringify(value)} — 22P02, engolido por audit(), trilha perdida.`,
        ).toMatch(UUID_RE);
      }
    }
  });

  it('uma segunda ativação concorrente não produz uma segunda transição conclusiva', async () => {
    runs.set('run-1', makeRun({ state: 'ready_for_activation', version: 6 }));
    const payload = { confirm_tenant_id: 'acme', confirm_agent_id: 'acme-bot' };
    const deps = { evaluateReadiness: async () => readyReport() };
    const first = await executeOnboardingStep({
      run_id: 'run-1', step: 'activate', payload, idempotency_key: 'chave-ativacao-a',
      expected_version: 6, actor: OWNER, deps,
    });
    const second = await executeOnboardingStep({
      run_id: 'run-1', step: 'activate', payload, idempotency_key: 'chave-ativacao-b',
      expected_version: 6, actor: OWNER, deps,
    });
    expect(first.status).toBe('completed');
    expect(second.status).toBe('conflict');
  });

  it('a denegação de ativação também vai para a trilha do agente', async () => {
    runs.set('run-1', makeRun({ state: 'ready_for_activation', version: 6 }));
    await executeOnboardingStep({
      run_id: 'run-1',
      step: 'activate',
      payload: { confirm_tenant_id: 'acme', confirm_agent_id: 'acme-bot' },
      idempotency_key: 'chave-ativacao-4',
      expected_version: 6,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport({ ready: false }) },
    });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'agent_activation_denied' }),
    );
  });
});

describe('pareamento (#518)', () => {
  it('usa um `command_id` DERIVADO — o retry re-enfileira idempotentemente', async () => {
    runs.set('run-1', makeRun({ state: 'channel_declared', version: 7 }));
    const seen: string[] = [];
    const deps = {
      requestPairing: async (i: { command_id: string }) => {
        seen.push(i.command_id);
        return { ok: true };
      },
    };
    const call = () =>
      executeOnboardingStep({
        run_id: 'run-1',
        step: 'start_pairing',
        payload: { channel_id: '11111111-1111-4111-8111-111111111111', method: 'qr' },
        idempotency_key: 'chave-pareamento-1',
        expected_version: runs.get('run-1')!.version,
        actor: OWNER,
        deps,
      });
    await call();
    await call();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('recusa do runtime vira `denied` sem mover a run', async () => {
    runs.set('run-1', makeRun({ state: 'channel_declared', version: 7 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'start_pairing',
      payload: { channel_id: '11111111-1111-4111-8111-111111111111', method: 'qr' },
      idempotency_key: 'chave-pareamento-2',
      expected_version: 7,
      actor: OWNER,
      deps: { requestPairing: async () => ({ ok: false, reason: 'pairing_in_progress' }) },
    });
    expect(out).toMatchObject({ status: 'denied', code: 'pairing_in_progress' });
    expect(runs.get('run-1')!.state).toBe('channel_declared');
  });

  it('deriveCommandId é estável e sensível a cada componente', () => {
    const a = deriveCommandId('run-1', 'start_pairing', 'hash-a');
    expect(deriveCommandId('run-1', 'start_pairing', 'hash-a')).toBe(a);
    expect(deriveCommandId('run-2', 'start_pairing', 'hash-a')).not.toBe(a);
    expect(deriveCommandId('run-1', 'start_pairing', 'hash-b')).not.toBe(a);
  });
});

describe('cancelamento', () => {
  it('cancela uma run viva e preserva o motivo', async () => {
    runs.set('run-1', makeRun({ state: 'policy_ready', version: 4 }));
    const out = await cancelOnboardingRun({
      run_id: 'run-1',
      expected_version: 4,
      actor: OWNER,
      reason_code: 'operator_abort',
    });
    expect(out.status).toBe('completed');
    expect(runs.get('run-1')!.state).toBe('cancelled');
    expect(runs.get('run-1')!.last_error_code).toBe('operator_abort');
  });

  it('run cancelada não é retomada implicitamente', async () => {
    runs.set('run-1', makeRun({ state: 'cancelled', version: 5 }));
    const out = await executeOnboardingStep({
      run_id: 'run-1',
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: 'chave-suficiente-3',
      expected_version: 5,
      actor: OWNER,
      deps: { evaluateReadiness: async () => readyReport() },
    });
    expect(out).toMatchObject({ status: 'conflict', code: 'run_terminal' });
  });

  it('operador de outro tenant não cancela a run alheia', async () => {
    runs.set('run-1', makeRun({ state: 'policy_ready', version: 4 }));
    const out = await cancelOnboardingRun({
      run_id: 'run-1',
      expected_version: 4,
      actor: { actor_id: 'u9', actor_role: 'owner', tenant_id: 'globex' },
      reason_code: 'x',
    });
    expect(out).toEqual({ status: 'not_found' });
    expect(runs.get('run-1')!.state).toBe('policy_ready');
  });
});

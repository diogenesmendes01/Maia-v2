/**
 * Trilha durável do disjuntor de LLM contra Postgres REAL — achado 2 (High) da
 * revisão adversarial da PR #541.
 *
 * ## O defeito que esta suíte trava
 *
 * `src/governance/audit-actions.ts` declarava `llm_circuit_opened` /
 * `llm_circuit_closed` e `src/workers/audit-watcher.ts` tinha a regra
 * `llm_circuit_long_open` procurando exatamente esse par — mas
 * `grep -rn "audit(" src/lib/llm/` devolvia ZERO. O alerta durável de
 * "disjuntor aberto há mais de 5 minutos" era um consumidor sem produtor:
 * nunca podia disparar, e o silêncio dele era indistinguível de "nada
 * aconteceu".
 *
 * ## Por que contra banco REAL, e não com `audit()` mockado
 *
 * Porque a armadilha desta PR não está em CHAMAR `audit()` — está no que
 * acontece depois. `audit()` engole falhas por design (log + contador, sem
 * propagar), e `audit_log.alvo_id` é **UUID**: um alvo em TEXT (o par
 * `provider:workload` seria o candidato óbvio) faz o INSERT estourar e a linha
 * some EM SILÊNCIO. Um teste com `audit()` mockado ficaria verde exatamente
 * nesse cenário — provaria que a função foi chamada e não que a linha existe.
 * Já houve esse buraco nesta mesma PR.
 *
 * Então o que se afirma aqui é o fim da cadeia:
 *
 *  1. uma transição REAL do disjuntor deixa LINHA em `audit_log`;
 *  2. a linha está no contexto `system` (ADR 0002) e carrega
 *     provider/workload/reason/mode nos metadados;
 *  3. o watcher ENCONTRA o par e detecta o caso "stuck";
 *  4. um `closed` posterior desarma a regra — o par fecha de verdade.
 *
 * ## Sem `TEST_DB_URL` este arquivo dá skip
 *
 * Mesmo gate de `channel-role-create-with-audit.spec.ts` e dos outros
 * `*-real-db`: sem banco não há nada honesto a afirmar.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const CIRCUIT_ACTIONS = [
  'llm_circuit_opened',
  'llm_circuit_closed',
  'llm_circuit_mode_override_applied',
  'llm_circuit_mode_override_cleared',
  'llm_circuit_mode_override_expired',
  'llm_circuit_mode_override_rejected',
] as const;

const sendAlertMock = vi.fn(async () => undefined);
vi.mock('@/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));

let pool: pg.Pool;

type AuditRow = {
  acao: string;
  tenant_id: string;
  agent_id: string;
  entidade_alvo: string | null;
  alvo_id: string | null;
  metadata: Record<string, unknown>;
};

async function rows(): Promise<AuditRow[]> {
  const r = await pool.query<AuditRow>(
    `SELECT acao, tenant_id, agent_id, entidade_alvo, alvo_id, metadata
       FROM audit_log WHERE acao = ANY($1::text[]) ORDER BY created_at ASC`,
    [CIRCUIT_ACTIONS as unknown as string[]],
  );
  return r.rows;
}

async function wipe(): Promise<void> {
  await pool.query(`DELETE FROM audit_log WHERE acao = ANY($1::text[])`, [
    CIRCUIT_ACTIONS as unknown as string[],
  ]);
}

if (SHOULD_RUN) {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await wipe();
    await pool.end();
  });
  beforeEach(async () => {
    await wipe();
    sendAlertMock.mockClear();
  });
}

d('disjuntor → audit_log (Postgres real)', () => {
  /** Leva o disjuntor de `closed` a `open` pelo caminho de verdade. */
  async function openCircuit(): Promise<void> {
    const { acquireCircuit, releaseCircuit, circuitState, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    _internal.reset();
    _internal.setMode('enforce');
    const key = { provider: 'anthropic', workload: 'reasoner' } as const;
    // Tempestade de timeout terminal — o cenário do achado 1. Passa pela mesma
    // decisão de abertura que o gateway dispara em produção.
    for (let i = 0; i < _internal.MIN_SAMPLES; i++) {
      releaseCircuit(acquireCircuit(key), 'terminal_fault');
    }
    expect(circuitState(key)).toBe('open');
    await drainCircuitAudits();
  }

  /** Fecha o disjuntor com uma sonda bem sucedida. */
  async function closeCircuit(): Promise<void> {
    const { acquireCircuit, releaseCircuit, circuitState, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    const key = { provider: 'anthropic', workload: 'reasoner' } as const;
    const entry = _internal.circuits.get(JSON.stringify([key.provider, key.workload]))!;
    entry.opened_at -= _internal.OPEN_MS + 1;
    releaseCircuit(acquireCircuit(key), 'ok');
    expect(circuitState(key)).toBe('closed');
    await drainCircuitAudits();
  }

  it('uma transição REAL para `open` deixa linha em audit_log', async () => {
    await openCircuit();

    const found = (await rows()).filter((r) => r.acao === 'llm_circuit_opened');
    // A asserção que um mock de `audit()` não consegue fazer: a linha EXISTE.
    expect(found).toHaveLength(1);
    const row = found[0]!;

    // ADR 0002: saúde de dependência externa compartilhada é estado `system`.
    // Sem o `runWithSystemContext` explícito a linha herdaria o tenant que por
    // acaso estava em voo — atribuição errada é pior que atribuição nenhuma.
    expect(row.tenant_id).toBe('system');
    expect(row.agent_id).toBe('system');

    // A armadilha: `alvo_id` é UUID. O alvo (`provider`,`workload`) é TEXT e
    // vive em `entidade_alvo` + metadata. Se alguém mover para `alvo_id`, o
    // INSERT estoura, `audit()` engole, e este `toHaveLength(1)` acima fica
    // vermelho — que é exatamente o que se quer.
    expect(row.entidade_alvo).toBe('llm_circuit');
    expect(row.alvo_id).toBeNull();

    expect(row.metadata).toMatchObject({
      provider: 'anthropic',
      workload: 'reasoner',
      from: 'closed',
      to: 'open',
      reason: 'error_rate_exceeded',
      mode: 'enforce',
    });
  });

  it('o par open → closed fica registrado na ordem', async () => {
    await openCircuit();
    await closeCircuit();
    expect((await rows()).map((r) => r.acao)).toEqual([
      'llm_circuit_opened',
      'llm_circuit_closed',
    ]);
  });

  it('`half_open` NÃO audita — auditá-lo quebraria o casamento open/closed', async () => {
    const { acquireCircuit, _internal } = await import('@/lib/llm/circuit-breaker.js');
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    await openCircuit();

    const key = { provider: 'anthropic', workload: 'reasoner' } as const;
    const entry = _internal.circuits.get(JSON.stringify([key.provider, key.workload]))!;
    entry.opened_at -= _internal.OPEN_MS + 1;
    acquireCircuit(key); // open → half_open
    await drainCircuitAudits();

    expect((await rows()).map((r) => r.acao)).toEqual(['llm_circuit_opened']);
  });
});

d('audit-watcher encontra o par (Postgres real)', () => {
  /**
   * Envelhece a linha de abertura para além da janela da regra. A alternativa
   * seria esperar 5 minutos de relógio — que não é teste, é castigo.
   */
  async function ageOpenedRow(minutes: number): Promise<void> {
    const r = await pool.query(
      `UPDATE audit_log SET created_at = NOW() - ($1 || ' minutes')::interval
        WHERE acao = 'llm_circuit_opened'`,
      [String(minutes)],
    );
    expect(r.rowCount, 'não havia linha de abertura para envelhecer').toBeGreaterThan(0);
  }

  async function runWatcher(): Promise<string[]> {
    const { runAuditWatcher, _internal } = await import('@/workers/audit-watcher.js');
    // O throttle é in-memory e de 30 min: sem zerar, a segunda execução do
    // arquivo nunca alertaria e o teste ficaria verde por acidente.
    _internal.lastAlertedAt.clear();
    sendAlertMock.mockClear();
    await runAuditWatcher();
    return sendAlertMock.mock.calls.map((c) => (c[0] as { subject: string }).subject);
  }

  it('detecta o caso "stuck": aberto há mais de 5 min sem `closed`', async () => {
    const { acquireCircuit, releaseCircuit, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    _internal.reset();
    _internal.setMode('enforce');
    const key = { provider: 'anthropic', workload: 'reasoner' } as const;
    for (let i = 0; i < _internal.MIN_SAMPLES; i++) {
      releaseCircuit(acquireCircuit(key), 'terminal_fault');
    }
    await drainCircuitAudits();
    await ageOpenedRow(10);

    const subjects = await runWatcher();
    expect(subjects.some((s) => s.includes('llm_circuit_long_open'))).toBe(true);
    expect(subjects.some((s) => s.includes('URGENT'))).toBe(true);
  });

  it('um `closed` posterior desarma a regra', async () => {
    const { acquireCircuit, releaseCircuit, circuitState, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    _internal.reset();
    _internal.setMode('enforce');
    const key = { provider: 'anthropic', workload: 'reasoner' } as const;
    for (let i = 0; i < _internal.MIN_SAMPLES; i++) {
      releaseCircuit(acquireCircuit(key), 'terminal_fault');
    }
    await drainCircuitAudits();
    await ageOpenedRow(10);

    const entry = _internal.circuits.get(JSON.stringify([key.provider, key.workload]))!;
    entry.opened_at -= _internal.OPEN_MS + 1;
    releaseCircuit(acquireCircuit(key), 'ok');
    expect(circuitState(key)).toBe('closed');
    await drainCircuitAudits();

    const subjects = await runWatcher();
    expect(subjects.some((s) => s.includes('llm_circuit_long_open'))).toBe(false);
  });
});

d('kill switch → audit_log (Postgres real)', () => {
  /**
   * Ator único por execução. `llm-circuit-kill-switch-redis.spec.ts` vira a
   * mesma chave contra o mesmo banco e, desde que o override passou a auditar,
   * escreve as mesmas ações — outro worker do vitest rodando em paralelo
   * poluiria uma asserção que só filtrasse por `acao`.
   */
  const ACTOR = `sre:audit-real-db-${process.pid}`;

  it('override aplicado e recusado viram linhas com ator e motivo', async () => {
    const { applyCircuitOverride, _internal: modeInternal } = await import(
      '@/lib/llm/circuit-mode.js'
    );
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    modeInternal.reset();

    applyCircuitOverride({ mode: 'off', actor: ACTOR, reason: 'INC-4412', ttl_ms: 60_000 });
    applyCircuitOverride({ mode: 'off', reason: `sem ator ${ACTOR}` });
    await drainCircuitAudits();
    modeInternal.reset();

    const found = (await rows()).filter(
      (r) =>
        r.metadata.actor === ACTOR || String(r.metadata.reason ?? '').includes(ACTOR),
    );
    expect(found.map((r) => r.acao)).toEqual([
      'llm_circuit_mode_override_applied',
      'llm_circuit_mode_override_rejected',
    ]);
    expect(found[0]!.tenant_id).toBe('system');
    expect(found[0]!.entidade_alvo).toBe('llm_circuit');
    expect(found[0]!.alvo_id).toBeNull();
    expect(found[0]!.metadata).toMatchObject({
      actor: ACTOR,
      reason: 'INC-4412',
      mode: 'off',
    });
    expect(String(found[1]!.metadata.error)).toContain('actor obrigatório');
  });
});

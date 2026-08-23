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

d('correlação do watcher por circuito e réplica (Postgres real)', () => {
  /**
   * Achado 4 da re-review do owner na PR #541.
   *
   * A regra `llm_circuit_long_open` aceitava QUALQUER `llm_circuit_closed`
   * posterior como par de QUALQUER `llm_circuit_opened`. Mas o estado do
   * disjuntor é por `(provider, workload)` (`keyOf` em `circuit-breaker.ts`) e,
   * além disso, por RÉPLICA — a janela de amostras vive na memória de cada
   * processo. Consequência: um circuito que abriu e fechou normalmente
   * DESARMAVA o alerta de outro que continuava preso aberto. O alerta de
   * "aberto há mais de 5 min" ficava cego exatamente no cenário que existe
   * para pegar.
   *
   * Estes casos falham contra a versão sem correlação — é essa a única razão
   * de existirem.
   */
  async function ageOpened(minutes: number, where = 'TRUE'): Promise<number> {
    const r = await pool.query(
      `UPDATE audit_log SET created_at = NOW() - ($1 || ' minutes')::interval
        WHERE acao = 'llm_circuit_opened' AND ${where}`,
      [String(minutes)],
    );
    return r.rowCount ?? 0;
  }

  async function runWatcher(): Promise<Array<{ subject: string; body: string }>> {
    const { runAuditWatcher, _internal } = await import('@/workers/audit-watcher.js');
    _internal.lastAlertedAt.clear();
    sendAlertMock.mockClear();
    await runAuditWatcher();
    return sendAlertMock.mock.calls.map((c) => c[0] as { subject: string; body: string });
  }

  function circuitAlert(
    alerts: Array<{ subject: string; body: string }>,
  ): { subject: string; body: string } | undefined {
    return alerts.find((a) => a.subject.includes('llm_circuit_long_open'));
  }

  /** Abre o disjuntor de `workload` pelo caminho real (tempestade terminal). */
  async function open(workload: 'reasoner' | 'summarizer'): Promise<void> {
    const { acquireCircuit, releaseCircuit, circuitState, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const key = { provider: 'anthropic', workload } as const;
    for (let i = 0; i < _internal.MIN_SAMPLES; i++) {
      releaseCircuit(acquireCircuit(key), 'terminal_fault');
    }
    expect(circuitState(key)).toBe('open');
  }

  /** Fecha o disjuntor de `workload` com uma sonda bem sucedida. */
  async function close(workload: 'reasoner' | 'summarizer'): Promise<void> {
    const { acquireCircuit, releaseCircuit, circuitState, _internal } = await import(
      '@/lib/llm/circuit-breaker.js'
    );
    const key = { provider: 'anthropic', workload } as const;
    const entry = _internal.circuits.get(JSON.stringify([key.provider, key.workload]))!;
    entry.opened_at -= _internal.OPEN_MS + 1;
    releaseCircuit(acquireCircuit(key), 'ok');
    expect(circuitState(key)).toBe('closed');
  }

  it('o produtor grava a identidade da réplica em `metadata.replica`', async () => {
    const { _internal } = await import('@/lib/llm/circuit-breaker.js');
    const { drainCircuitAudits, REPLICA_METADATA_KEY, _internal: auditInternal } = await import(
      '@/lib/llm/circuit-audit.js'
    );
    _internal.reset();
    _internal.setMode('enforce');
    await open('reasoner');
    await drainCircuitAudits();

    const found = (await rows()).filter((r) => r.acao === 'llm_circuit_opened');
    expect(found).toHaveLength(1);
    // Sem esta chave a correlação abaixo não tem como existir: o watcher
    // importa a MESMA constante do produtor.
    expect(REPLICA_METADATA_KEY).toBe('replica');
    expect(found[0]!.metadata[REPLICA_METADATA_KEY]).toBe(auditInternal.replicaIdentity());
    // `<hostname>:<pid>#<boot>` — o sufixo de boot é o que impede um processo
    // novo de herdar a identidade do que morreu com o circuito aberto.
    expect(String(found[0]!.metadata[REPLICA_METADATA_KEY])).toMatch(/^.+:\d+#[0-9a-f-]{4,}$/);
  });

  it('CASO DECISIVO: circuito B abrindo e fechando NÃO desarma o circuito A preso', async () => {
    const { _internal } = await import('@/lib/llm/circuit-breaker.js');
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    _internal.reset();
    _internal.setMode('enforce');

    // A = anthropic/reasoner: abre e FICA aberto.
    await open('reasoner');
    // B = anthropic/summarizer: abre e fecha normalmente, DEPOIS de A.
    await open('summarizer');
    await close('summarizer');
    await drainCircuitAudits();

    // As duas aberturas envelhecem para além da janela de 5 min da regra; o
    // `closed` de B fica no presente, ou seja, POSTERIOR a ambas — que é
    // exatamente a condição que a versão sem correlação casava com A.
    expect(await ageOpened(10)).toBe(2);

    const alert = circuitAlert(await runWatcher());
    expect(alert, 'o watcher parou de acusar o circuito preso').toBeDefined();
    // E nomeia QUEM está preso: A sim, B não.
    expect(alert!.body).toContain('anthropic/reasoner/');
    expect(alert!.body).not.toContain('anthropic/summarizer/');
    expect(alert!.body).toContain('1 instance(s)');
  });

  it('réplica: o `closed` de uma réplica não fecha o `opened` de outra', async () => {
    const { _internal } = await import('@/lib/llm/circuit-breaker.js');
    const { drainCircuitAudits, REPLICA_METADATA_KEY } = await import(
      '@/lib/llm/circuit-audit.js'
    );
    _internal.reset();
    _internal.setMode('enforce');

    // Mesmo (provider, workload) — só a réplica difere. Um processo só emite
    // uma identidade, então a segunda réplica é forjada no banco a partir da
    // linha real: é a única forma honesta de simular DUAS réplicas aqui, e o
    // que se afirma é a correlação do watcher, não a emissão (coberta acima).
    await open('reasoner');
    await close('reasoner');
    await drainCircuitAudits();

    const other = 'other-host:4242#deadbeef';
    // Reetiqueta o par real como vindo da réplica `other`…
    await pool.query(
      `UPDATE audit_log SET metadata = jsonb_set(metadata, $1, to_jsonb($2::text))
        WHERE acao LIKE 'llm_circuit_%' AND metadata->>'provider' = 'anthropic'`,
      [`{${REPLICA_METADATA_KEY}}`, other],
    );
    // …e cria a abertura ÓRFÃ desta réplica, anterior ao `closed` da outra.
    await pool.query(
      `INSERT INTO audit_log (tenant_id, agent_id, acao, entidade_alvo, metadata, created_at)
       SELECT tenant_id, agent_id, acao, entidade_alvo,
              jsonb_set(metadata, $1, to_jsonb($2::text)), NOW()
         FROM audit_log WHERE acao = 'llm_circuit_opened' LIMIT 1`,
      [`{${REPLICA_METADATA_KEY}}`, 'stuck-host:7#cafe1234'],
    );
    expect(await ageOpened(10)).toBe(2);

    const alert = circuitAlert(await runWatcher());
    expect(alert, 'a abertura órfã da outra réplica sumiu do alerta').toBeDefined();
    expect(alert!.body).toContain('stuck-host:7#cafe1234');
    expect(alert!.body).not.toContain(other);
    expect(alert!.body).toContain('1 instance(s)');
  });

  it('o par COMPLETO da mesma réplica continua desarmando a regra', async () => {
    // O contrapeso: correlacionar não pode transformar a regra num alarme que
    // nunca desliga. Mesmo circuito, mesma réplica, par fechado → silêncio.
    const { _internal } = await import('@/lib/llm/circuit-breaker.js');
    const { drainCircuitAudits } = await import('@/lib/llm/circuit-audit.js');
    _internal.reset();
    _internal.setMode('enforce');
    await open('reasoner');
    await close('reasoner');
    await drainCircuitAudits();
    expect(await ageOpened(10)).toBe(1);

    expect(circuitAlert(await runWatcher())).toBeUndefined();
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
    // NAO se afirma ORDEM aqui, e a razao e CONCORRENCIA, nao empate de relogio.
    //
    // `recordCircuitAudit()` e fire-and-forget: ele dispara `writeCircuitAudit()`
    // e guarda a promise num set (`circuit-audit.ts`). As duas escritas sao
    // INDEPENDENTES -- cada `auditRepo.write()` faz o proprio INSERT, em
    // autocommit -- e `drainCircuitAudits()` so espera as promises pendentes.
    // Nao ha transacao comum, nao ha ordem imposta: elas chegam ao banco na
    // ordem que o event loop e o pool decidirem, e podem empatar em
    // `created_at` OU inverter.
    //
    // Por isso trocar `now()` por `clock_timestamp()` NAO resolveria: daria
    // instantes distintos, mas refletindo a ordem de CHEGADA ao banco, que nao
    // e a ordem logica aplicada -> recusada. Ordem causal aqui exigiria
    // serializacao explicita ou uma sequencia monotonica no proprio registro --
    // relogio nao serve. Enquanto ordem nao for requisito de produto, o teste
    // nao deve afirma-la.
    //
    // A assercao abaixo e mais forte que a de ordem: ela amarra cada acao a
    // evidencia que a IDENTIFICA (o ator na linha aplicada, o motivo na
    // recusada), em vez de a uma posicao que nada promete.
    const aplicada = found.filter((r) => r.metadata.actor === ACTOR);
    const recusada = found.filter((r) => String(r.metadata.reason ?? '').includes(ACTOR));

    expect(aplicada).toHaveLength(1);
    expect(recusada).toHaveLength(1);
    expect(aplicada[0]!.acao).toBe('llm_circuit_mode_override_applied');
    expect(recusada[0]!.acao).toBe('llm_circuit_mode_override_rejected');
    // E o conjunto continua sendo exatamente estes dois, sem terceiro evento.
    expect([...found.map((r) => r.acao)].sort()).toEqual([
      'llm_circuit_mode_override_applied',
      'llm_circuit_mode_override_rejected',
    ]);

    expect(aplicada[0]!.tenant_id).toBe('system');
    expect(aplicada[0]!.entidade_alvo).toBe('llm_circuit');
    expect(aplicada[0]!.alvo_id).toBeNull();
    expect(aplicada[0]!.metadata).toMatchObject({
      actor: ACTOR,
      reason: 'INC-4412',
      mode: 'off',
    });
    expect(String(recusada[0]!.metadata.error)).toContain('actor obrigatório');
  });
});

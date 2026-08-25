/**
 * Issue #627 (fatia D da #505) — PROMOÇÃO DO SUCESSOR, contra PostgreSQL REAL
 * (migrations 120 + 122 + 124 + 126 + 127).
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é um UPDATE que roda DENTRO da transação do CAS terminal.
 * Um harness que reconstruísse a conclusão com SQL próprio passaria feliz com a
 * promoção REMOVIDA do código de produção — estaria provando o harness. Por
 * isso toda entrada é pela porta real (`beginTurnExecution`, `concludeTurn`,
 * `deadLetterTurn`, `acquireTurnLease`, `runMessageRecovery`), carregada por
 * `moduloDeProducao`.
 *
 * A ÚNICA coisa dublada é o transporte: `@/gateway/queue.js` abre conexão
 * `ioredis` no import e a asserção que interessa é "o wake-up foi disparado
 * para ESTE turno" — que se lê no argumento, não no Redis. A decisão, que é o
 * que a fatia persiste, é verificada NO BANCO em todos os casos.
 *
 * O que se prova:
 *   1. a conclusão do head PROMOVE o sucessor: banco + wake-up, sem varredor;
 *   2. a promoção não fura a ordem — só o NOVO head, nunca um turno qualquer;
 *   3. um worker ZUMBI (fence stale) não promove ninguém, e a recusa é auditada;
 *   4. `promoted` é produzido de fato, em `maia_stream_promotion_total{result}`;
 *   5. LATÊNCIA: a janela de até 2 min do runbook §11.5 fechou, com número medido;
 *   6. "commit feito, enqueue não feito" é reconciliado pelo varredor;
 *   7. `dead_letter` (terminal por esgotamento) também libera a conversa;
 *   8. backoff em aberto NÃO é ultrapassado pela promoção;
 *   9. `outbound_pending` não é promovido — quem o move é o outbox (#506);
 *  10. a recuperação de claim expirado re-arma o HEAD na hora (a §11.5).
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

/**
 * O transporte, e SÓ ele. `enqueueAgent` é espionado para que a asserção seja
 * "o wake-up foi armado para ESTE turno" — a única coisa que a promoção pede à
 * fila. Nada mais do caminho de produção é substituído.
 */
const enqueueAgentMock = vi.fn(async () => {});
vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: (...args: unknown[]) => enqueueAgentMock(...(args as [])),
  QueueRedisUnavailableError: class QueueRedisUnavailableError extends Error {},
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'promo627-tenant-a';
const A_A = 'promo627-agent-a';

const LEASE_MS = 60_000;

/**
 * A janela que esta fatia fecha, em ms — `STUCK_AFTER_MS` de
 * `src/workers/message-recovery.ts`, o número que o runbook §11.5 documenta
 * como "até 2 min".
 */
const JANELA_DO_VARREDOR_MS = 2 * 60 * 1000;

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);

async function ensureTenantAgent(): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    T_A,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [A_A, T_A],
  );
}

async function mkInbound(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, T_A, A_A],
  );
  return id;
}

/**
 * Turno `received` numa stream NOMEADA, com a fronteira de sequência carimbada
 * — o mesmo helper da suíte da fatia C. A CRIAÇÃO é a de produção
 * (`ensureTurnForMessage`); só as colunas de shadow são carimbadas depois, como
 * o ingresso da fatia A as carimbaria.
 */
async function turnInStream(args: {
  stream_key: string;
  seq: number;
  repos: typeof import('../../src/db/repositories.js');
}): Promise<string> {
  const mensagem_id = await mkInbound();
  const turn = await inA(() =>
    args.repos.agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T_A,
      agent_id: A_A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  await pool.query(
    `UPDATE agent_turns
        SET stream_key = $2, stream_key_version = 1,
            first_ingress_seq = $3, last_ingress_seq = $3
      WHERE id = $1`,
    [turn.id, args.stream_key, args.seq],
  );
  return turn.id;
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

async function setStatus(turn_id: string, status: string): Promise<void> {
  await pool.query(`UPDATE agent_turns SET status = $2 WHERE id = $1`, [turn_id, status]);
}

async function expireLease(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
}

const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

type Handle = {
  turn_id: string;
  status: string;
  state_version: number;
  attempt_count: number;
  conversa_id: string | null;
  lease?: unknown;
};

const handleFor = (turn_id: string): Handle => ({
  turn_id,
  status: 'received',
  state_version: 0,
  attempt_count: 0,
  conversa_id: null,
  lease: null,
});

/** Todos os handles com lease viva criados no caso, para parar o heartbeat. */
const abertos: Handle[] = [];

function rastrear(handle: Handle): Handle {
  abertos.push(handle);
  return handle;
}

d('#627 — promoção do sucessor (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const turns = moduloDeProducao(() => import('@/runtime/turns/lifecycle.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  const streamMetrics = moduloDeProducao(() => import('@/runtime/turns/stream-metrics.js'));
  const recovery = moduloDeProducao(() => import('@/workers/message-recovery.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent();
  }, 30_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [T_A]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [T_A]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [T_A]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T_A]);
    await pool?.query(`DELETE FROM agents WHERE id = $1`, [A_A]);
    await pool?.query(`DELETE FROM tenants WHERE id = $1`, [T_A]);
    await pool?.end();
  });

  beforeEach(async () => {
    for (const h of abertos.splice(0)) {
      (h.lease as { stop?: () => void } | null)?.stop?.();
    }
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [T_A]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [T_A]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [T_A]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T_A]);
    enqueueAgentMock.mockClear();
    enqueueAgentMock.mockImplementation(async () => {});
    // Métrica ZERADA e RE-SEMEADA a cada caso: as asserções abaixo são
    // ABSOLUTAS (`... 1`), não deltas. Uma asserção por delta sobre estado
    // global mutável fica verde na SEGUNDA tentativa do `retry: 1` do vitest,
    // porque ela herda a mutação da primeira como linha de base — e o processo
    // sai com falharam=0 escondendo um vermelho real.
    metricas()._resetForTests();
    streamMetrics()._resetSeedForTests();
    streamMetrics().registrarSeriesDeStream();
  });

  /** Um contador do Prometheus, como número absoluto. */
  async function contador(result: string): Promise<number> {
    const body = await metricas().renderPrometheus();
    const m = new RegExp(`^maia_stream_promotion_total\\{result="${result}"\\} (\\d+)`, 'm').exec(
      body,
    );
    return m ? Number(m[1]) : -1;
  }

  /** Executa o head até `running`, pela porta de produção. */
  async function executarHead(turn_id: string): Promise<Handle> {
    const handle = rastrear(handleFor(turn_id));
    const inicio = await inA(() => turns().beginTurnExecution(handle as never));
    expect(inicio.started).toBe(true);
    return handle;
  }

  // ─── SONDA 1 — a promoção acontece ────────────────────────────────────────

  it('concluir o head PROMOVE o sucessor: decisão no banco E wake-up, sem varredor', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    // O sucessor está `queued` desde o ingresso e o job dele JÁ FOI CONSUMIDO —
    // acordou, o claim recusou com `not_head` (#626) e o job terminou. É o caso
    // NORMAL, e é por isso que a promoção precisa re-armar quem já está
    // `queued`: sem isso ela não promoveria quase ninguém.
    await setStatus(m2, 'queued');

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();

    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    // A DECISÃO, no banco. É ela — e não o job — que sobrevive a um crash.
    const sucessor = await readTurn(m2);
    expect(sucessor['status']).toBe('queued');
    expect(sucessor['promoted_at']).not.toBeNull();
    expect(sucessor['promoted_by_turn_id']).toBe(m1);

    // O SINAL, depois do commit. O payload carrega `turn_id`, que é o que torna
    // o `jobId` determinístico (#504) e a promoção idempotente no transporte.
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    const payload = enqueueAgentMock.mock.calls[0]![0] as {
      turn_id: string;
      mensagem_id: string;
    };
    expect(payload.turn_id).toBe(m2);
    expect(payload.mensagem_id).toBe(sucessor['representative_message_id']);

    // E o sucessor é REIVINDICÁVEL agora — a fila andou de verdade, não só a
    // coluna. Sem isto, "promovido" poderia ser um carimbo sem consequência.
    const claim = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(true);
  }, 30_000);

  // ─── SONDA 2 — a promoção não fura a ordem ───────────────────────────────

  it('promove SÓ o novo head — nunca um turno qualquer da stream', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });
    const m3 = await turnInStream({ stream_key: key, seq: 3, repos: repos() });

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    // EXATAMENTE UM promovido, e é o menor `first_ingress_seq` vivo.
    const promovidos = await pool.query(
      `SELECT id FROM agent_turns WHERE tenant_id = $1 AND promoted_at IS NOT NULL`,
      [T_A],
    );
    expect(promovidos.rows.map((r: { id: string }) => r.id)).toEqual([m2]);

    // m3 não foi tocado: nem estado, nem carimbo, nem wake-up.
    const terceiro = await readTurn(m3);
    expect(terceiro['status']).toBe('received');
    expect(terceiro['promoted_at']).toBeNull();
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect((enqueueAgentMock.mock.calls[0]![0] as { turn_id: string }).turn_id).toBe(m2);

    // E o terceiro continua RECUSADO — a ordem que a fatia C impôs sobreviveu à
    // promoção. Se a promoção furasse a fila, este claim passaria.
    const r3 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m3,
        worker_id: 'w3',
        lease_ms: LEASE_MS,
      }),
    );
    expect(r3.ok).toBe(false);
    expect(r3.ok === false && r3.reason).toBe('not_head');
  }, 30_000);

  // ─── SONDA 3 — o fence: um zumbi não promove ninguém ─────────────────────

  it('worker ZUMBI (lease tomada) não promove o sucessor, e a recusa é auditada', async () => {
    // A falha nº 9 da issue-mãe, literal: "takeover após lease expirado permite
    // ao worker antigo liberar o sucessor".
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    const zumbi = await executarHead(m1);

    // A lease do zumbi vence e OUTRO worker assume o mesmo turno — o token
    // vigente no banco passa a ser o do sucessor.
    await expireLease(m1);
    const takeover = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m1,
        worker_id: 'worker-novo',
        lease_ms: LEASE_MS,
      }),
    );
    expect(takeover.ok).toBe(true);
    // O dono NOVO começa a executar: a linha volta a `running`, agora com o
    // token dele.
    const novo = takeover.ok === true ? takeover.claim : null;
    await inA(() =>
      repos().agentTurnsRepo.markRunning({
        turn_id: m1,
        expected_version: novo!.state_version,
        expected_claim_token: novo!.claim_token,
        bump_attempt: false,
      }),
    );

    // O PIOR CASO, e é ele que isola o FENCE. O zumbi releu a linha antes de
    // concluir, então status e `state_version` BATEM: nem a origem da transição
    // nem o CAS otimista têm como recusá-lo. A única coisa que ele não tem — e
    // não pode ter — é o `claim_token` vigente. Sem esse isolamento, a sonda
    // ficaria verde por causa de qualquer um dos outros dois guardas, e provaria
    // o guarda errado.
    const linha = await readTurn(m1);
    zumbi.status = String(linha['status']);
    zumbi.state_version = Number(linha['state_version']);

    enqueueAgentMock.mockClear();
    // O zumbi volta do GC com o trabalho pronto e tenta concluir.
    await inA(() => turns().concludeTurn(zumbi as never, 'reply_delivered'));

    // NADA aconteceu com a fila: o CAS terminal foi recusado pelo fence, então a
    // promoção — que roda DENTRO daquela transação — nunca chegou a existir.
    const sucessor = await readTurn(m2);
    expect(sucessor['promoted_at']).toBeNull();
    expect(sucessor['status']).toBe('received');
    expect(enqueueAgentMock).not.toHaveBeenCalled();
    // E o head continua vivo, com o dono NOVO — o zumbi não o concluiu.
    expect((await readTurn(m1))['status']).toBe('running');

    // A TRILHA. Métrica e `audit_log`: sem elas, um zumbi barrado e uma stream
    // sem sucessor produziriam exatamente o mesmo silêncio.
    expect(await contador('fence_rejected')).toBe(1);
    expect(await contador('promoted')).toBe(0);
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'turn_promotion_rejected' AND alvo_id = $2`,
      [T_A, m1],
    );
    expect(trilha.rows).toHaveLength(1);
    expect((trilha.rows[0] as { metadata: Record<string, unknown> }).metadata['reason']).toBe(
      'stale_claim',
    );
  }, 30_000);

  // ─── SONDA 4 — `promoted` é produzido, onde o contrato diz ───────────────

  it('produz `maia_stream_promotion_total{result="promoted"}` e a audit_log turn_promoted', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    // ANTES: a série existe e está em ZERO (semeada no boot da observabilidade).
    // "Zero" só é uma afirmação quando a série existe — ausente, ela é
    // indistinguível de "nunca medimos".
    expect(await contador('promoted')).toBe(0);

    const head = await executarHead(m1);
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    expect(await contador('promoted')).toBe(1);
    expect(await contador('no_successor')).toBe(0);
    expect(await contador('fence_rejected')).toBe(0);

    const trilha = await pool.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND acao = 'turn_promoted' AND alvo_id = $2`,
      [T_A, m2],
    );
    expect(trilha.rows).toHaveLength(1);
    const meta = (trilha.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta['source']).toBe('terminal');
    expect(meta['promoted_by_turn_id']).toBe(m1);
    // A issue-mãe restringe `stream_key` a log protegido — ela não entra na
    // audit_log nem como label de métrica.
    expect(JSON.stringify(meta)).not.toContain(key);
  }, 30_000);

  it('uma conclusão SEM sucessor conta `no_successor` — o denominador da razão', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const head = await executarHead(m1);
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));
    expect(await contador('no_successor')).toBe(1);
    expect(await contador('promoted')).toBe(0);
  }, 30_000);

  // ─── SONDA 5 — a latência medida ─────────────────────────────────────────

  it('LATÊNCIA: o sucessor é acordado em milissegundos, não no ciclo do varredor', async () => {
    // O que esta sonda mede, e por que ela é o coração da fatia: o runbook
    // §11.5 documenta que, depois da fatia C, quem avança é o head "na vez
    // dele, quando o varredor o rearmar, o que leva até STUCK_AFTER_MS (2 min)".
    // Aqui o intervalo medido é entre a CONCLUSÃO do head e o wake-up do
    // sucessor, pelo caminho de produção.
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });
    await setStatus(m2, 'queued');

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();

    let acordadoEm = 0;
    const t0 = Date.now();
    enqueueAgentMock.mockImplementation(async () => {
      acordadoEm = Date.now();
    });
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));
    const latencia = acordadoEm - t0;

    // INVARIANTE ABSOLUTA, não delta: o sinal ACONTECEU dentro da chamada de
    // conclusão (nenhum varredor rodou nesta spec) e o número medido está uma
    // ordem de grandeza abaixo da janela documentada. O teto é generoso de
    // propósito — a afirmação é "milissegundos, não minutos", e apertá-lo até o
    // limite do relógio transformaria a sonda numa fonte de flake.
    expect(acordadoEm).toBeGreaterThan(0);
    expect(latencia).toBeLessThan(JANELA_DO_VARREDOR_MS / 20);
    console.log(
      `[#627] latência medida da promoção: ${latencia}ms ` +
        `(janela do varredor documentada na §11.5: ${JANELA_DO_VARREDOR_MS}ms)`,
    );
  }, 30_000);

  it('LATÊNCIA: recuperar claim expirado re-arma o HEAD na hora (a janela da §11.5)', async () => {
    // O outro lado da mesma janela. Fatia C: o head morre com a lease vencida, o
    // SUCESSOR tenta reivindicar, a transação recupera o morto (⇒ `retryable`) e
    // recusa o sucessor com `not_head`. A stream destrava e ninguém acorda o
    // head — ele espera o varredor. Aqui a dívida é paga no mesmo instante.
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    await executarHead(m1);
    await expireLease(m1);
    enqueueAgentMock.mockClear();

    // O SUCESSOR tenta — e é recusado. Pela porta de produção (`acquireTurnLease`),
    // que é quem sinaliza a recuperação.
    const { acquireTurnLease } = await import('@/runtime/turns/lease.js');
    const t0 = Date.now();
    const tentativa = await inA(() => acquireTurnLease(m2));
    const latencia = Date.now() - t0;

    expect(tentativa.lease).toBeNull();
    expect(tentativa.result.ok === false && tentativa.result.reason).toBe('not_head');

    // O head foi recuperado E ACORDADO — o wake-up é dele, não do sucessor.
    const head = await readTurn(m1);
    expect(head['status']).toBe('retryable');
    expect(head['promoted_at']).not.toBeNull();
    // Sem promotor: o dono morreu, ninguém promoveu — o turno foi re-armado.
    expect(head['promoted_by_turn_id']).toBeNull();
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect((enqueueAgentMock.mock.calls[0]![0] as { turn_id: string }).turn_id).toBe(m1);
    expect(await contador('promoted')).toBe(1);
    expect(latencia).toBeLessThan(JANELA_DO_VARREDOR_MS / 20);
    console.log(
      `[#627] latência medida do re-arme por claim expirado: ${latencia}ms ` +
        `(janela do varredor documentada na §11.5: ${JANELA_DO_VARREDOR_MS}ms)`,
    );
  }, 30_000);

  // ─── 6. Crash entre commit e enqueue ─────────────────────────────────────

  it('"commit feito, enqueue não feito" sobrevive ao crash e é reconciliado pelo varredor', async () => {
    // O critério de pronto literal da issue. A fila é WAKE-UP, não fonte de
    // verdade: o turno promovido existe no banco e não existe na fila, e só um
    // recovery que consulta o BANCO recupera isso.
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });
    await setStatus(m2, 'queued');

    const head = await executarHead(m1);
    // O "crash": o processo morre entre o COMMIT da promoção e o `enqueueAgent`.
    // Aqui isso é uma falha do transporte, que produz exatamente o mesmo estado.
    enqueueAgentMock.mockImplementation(async () => {
      throw new Error('redis morreu entre o commit e o enqueue');
    });
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    // A conclusão NÃO falhou por causa da fila — e a decisão está no banco.
    expect((await readTurn(m1))['status']).toBe('completed');
    const sucessor = await readTurn(m2);
    expect(sucessor['promoted_at']).not.toBeNull();
    expect(await contador('enqueue_failed')).toBe(1);
    expect(await contador('promoted')).toBe(0);

    // O VARREDOR fecha o buraco. `created_at` recuado porque ele exige
    // `STUCK_AFTER_MS` para turnos `queued` — recuar o relógio da linha é o
    // único jeito honesto de exercitar isso sem esperar dois minutos.
    await pool.query(
      `UPDATE agent_turns SET created_at = now() - interval '5 minutes' WHERE id = $1`,
      [m2],
    );
    enqueueAgentMock.mockClear();
    enqueueAgentMock.mockImplementation(async () => {});

    await recovery().runMessageRecovery();

    expect(enqueueAgentMock).toHaveBeenCalled();
    expect(
      enqueueAgentMock.mock.calls.some(
        (c) => (c[0] as { turn_id?: string }).turn_id === m2,
      ),
    ).toBe(true);
    expect(await contador('recovered')).toBe(1);
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND acao = 'turn_promoted' AND alvo_id = $2`,
      [T_A, m2],
    );
    expect(
      trilha.rows.some(
        (r: { metadata: Record<string, unknown> }) =>
          r.metadata['source'] === 'recovery_reconciliation',
      ),
    ).toBe(true);
  }, 60_000);

  it('o claim ZERA a dívida — um turno acordado com sucesso não vira "recuperado"', async () => {
    // Sem isto, o varredor contaria como reconciliação de falha todo turno que a
    // promoção acordou com SUCESSO: `maia_stream_promotion_total{result="recovered"}`
    // mediria o caminho feliz e deixaria de ser sinal.
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    const head = await executarHead(m1);
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));
    expect((await readTurn(m2))['promoted_at']).not.toBeNull();

    await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w2',
        lease_ms: LEASE_MS,
      }),
    );
    expect((await readTurn(m2))['promoted_at']).toBeNull();
  }, 30_000);

  // ─── 7..9. As fronteiras da promoção ─────────────────────────────────────

  it('dead_letter TAMBÉM libera a conversa — turno envenenado não a prende para sempre', async () => {
    // Falha nº 5 da issue-mãe: "um turno em DLQ bloqueia a stream para sempre".
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'retry_exhausted', summary: null }),
    );

    expect((await readTurn(m1))['status']).toBe('dead_letter');
    expect((await readTurn(m2))['promoted_at']).not.toBeNull();
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect(await contador('promoted')).toBe(1);
  }, 30_000);

  it('backoff em aberto NÃO é ultrapassado: o sucessor retryable espera a vez dele', async () => {
    // Cláusula literal da issue-mãe: "backoff não autoriza ultrapassagem
    // silenciosa por mensagens posteriores". Promover um turno cujo
    // `next_attempt_at` está no futuro apagaria o backoff dele.
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });
    await pool.query(
      `UPDATE agent_turns SET status = 'retryable', next_attempt_at = now() + interval '10 minutes'
        WHERE id = $1`,
      [m2],
    );

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    const sucessor = await readTurn(m2);
    expect(sucessor['status']).toBe('retryable');
    expect(sucessor['promoted_at']).toBeNull();
    expect(sucessor['next_attempt_at']).not.toBeNull();
    expect(enqueueAgentMock).not.toHaveBeenCalled();
    expect(await contador('no_successor')).toBe(1);
  }, 30_000);

  it('sucessor em outbound_pending NÃO é promovido — quem o move é o outbox (#506)', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });
    await setStatus(m2, 'outbound_pending');

    const head = await executarHead(m1);
    enqueueAgentMock.mockClear();
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    expect((await readTurn(m2))['promoted_at']).toBeNull();
    expect((await readTurn(m2))['status']).toBe('outbound_pending');
    expect(enqueueAgentMock).not.toHaveBeenCalled();
  }, 30_000);

  it('a promoção não atravessa STREAMS — a conversa vizinha não é acordada', async () => {
    const keyA = streamKey();
    const keyB = streamKey();
    const a1 = await turnInStream({ stream_key: keyA, seq: 1, repos: repos() });
    const b1 = await turnInStream({ stream_key: keyB, seq: 1, repos: repos() });

    const head = await executarHead(a1);
    enqueueAgentMock.mockClear();
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    expect((await readTurn(b1))['promoted_at']).toBeNull();
    expect(enqueueAgentMock).not.toHaveBeenCalled();
  }, 30_000);

  it('KILL SWITCH: com FEATURE_TURN_STREAM_PROMOTION=false a conversa volta ao varredor', async () => {
    // O rollback desta fatia precisa ser barato e precisa ser VERDADE. Com a
    // flag OFF a ordem continua correta (o head-of-line não depende da
    // promoção) e a conversa volta a andar na cadência do varredor: latência,
    // não inversão. Um kill switch que não desliga nada é pior que nenhum.
    const { _resetContractEnvCacheForTests } = await import('@/config/contract-env.js');
    const anterior = process.env['FEATURE_TURN_STREAM_PROMOTION'];
    process.env['FEATURE_TURN_STREAM_PROMOTION'] = 'false';
    _resetContractEnvCacheForTests();
    try {
      const key = streamKey();
      const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
      const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

      const head = await executarHead(m1);
      enqueueAgentMock.mockClear();
      await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

      // O turno concluiu normalmente — só a promoção não aconteceu.
      expect((await readTurn(m1))['status']).toBe('completed');
      expect((await readTurn(m2))['promoted_at']).toBeNull();
      expect(enqueueAgentMock).not.toHaveBeenCalled();
      // E a ORDEM continua de pé: o sucessor é reivindicável (o head saiu da
      // frente), só que ninguém o acordou.
      const claim = await inA(() =>
        repos().agentTurnsRepo.claimNextEligibleTurn({
          turn_id: m2,
          worker_id: 'w2',
          lease_ms: LEASE_MS,
        }),
      );
      expect(claim.ok).toBe(true);
    } finally {
      if (anterior === undefined) delete process.env['FEATURE_TURN_STREAM_PROMOTION'];
      else process.env['FEATURE_TURN_STREAM_PROMOTION'] = anterior;
      _resetContractEnvCacheForTests();
    }
  }, 30_000);

  it('promoção IDEMPOTENTE: concluir duas vezes não promove duas vezes', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ stream_key: key, seq: 1, repos: repos() });
    const m2 = await turnInStream({ stream_key: key, seq: 2, repos: repos() });

    const head = await executarHead(m1);
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));
    const primeiro = await readTurn(m2);
    enqueueAgentMock.mockClear();

    // A segunda conclusão é recusada pelo CAS (o turno já é terminal), então a
    // promoção — que roda dentro daquela transação — não roda de novo.
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    const segundo = await readTurn(m2);
    expect(segundo['promoted_at']).toEqual(primeiro['promoted_at']);
    expect(segundo['state_version']).toEqual(primeiro['state_version']);
    expect(enqueueAgentMock).not.toHaveBeenCalled();
    expect(await contador('promoted')).toBe(1);
  }, 30_000);
});

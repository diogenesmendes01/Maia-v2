/**
 * Issue #629 (fatia F da #505) — POISON, DLQ E REPLAY, contra PostgreSQL REAL
 * (migrations 120 + 122 + 124 + 126 + 127 + 133).
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é uma política que decide DENTRO da transação do CAS
 * terminal e um predicado que roda no `WHERE` do claim. Um harness que
 * reconstruísse o `dead_letter` com SQL próprio passaria feliz com o bloqueio
 * REMOVIDO do código de produção — estaria provando o harness. Por isso toda
 * entrada é pela porta real (`beginTurnExecution`, `deadLetterTurn`,
 * `claimNextEligibleTurn`, `replayTurnByOperator`, `unblockStreamByOperator`,
 * `runMessageRecovery`), carregada por `moduloDeProducao`.
 *
 * A ÚNICA coisa dublada é o transporte: `@/gateway/queue.js` abre conexão
 * `ioredis` no import, e a asserção que interessa é "o wake-up foi disparado
 * para ESTE turno" — que se lê no argumento, não no Redis.
 *
 * ─── Como os DOIS MODOS são exercidos sem mexer em `process.env` ──────────
 *
 * A política é `(código, outcome) -> categoria -> saída`, e a configuração
 * default (`TURN_POISON_BLOCK_CATEGORIES=effect_committed`) já separa os dois
 * caminhos:
 *
 *   - `outcome: 'unsafe_to_retry'` ⇒ categoria `effect_committed` ⇒ BLOQUEIA;
 *   - `outcome: 'retry_exhausted'` + `code: 'reasoner_failed'` ⇒ `model` ⇒ LIBERA.
 *
 * Isso é melhor do que injetar env: `config` é um singleton carregado no
 * import, então mutar `process.env` num caso mediria o valor que o processo de
 * teste tinha, não a política — e o classificador de produção (o pedaço que de
 * fato decide) ficaria de fora. A configurabilidade em si é coberta sem banco
 * em `tests/unit/runtime/poison-policy-contract.spec.ts`.
 *
 * O que se prova:
 *   1. MODO `release`: `dead_letter` promove o sucessor e NÃO cria bloqueio;
 *   2. MODO `block_stream`: `dead_letter` interdita a conversa, NÃO promove, e
 *      o claim do sucessor é recusado com `stream_poisoned`, auditado;
 *   3. ATOMICIDADE: uma falha ENTRE as duas escritas desfaz as duas;
 *   4. o bloqueio é IDEMPOTENTE — duas conclusões produzem UMA interdição;
 *   5. o varredor de recovery não churna numa conversa interditada;
 *   6. o DESBLOQUEIO libera, re-arma o head e audita — e o turno envenenado
 *      continua morto;
 *   7. ISOLAMENTO: a MESMA `stream_key` literal em dois tenants, e dois agents
 *      no mesmo tenant, não compartilham interdição;
 *   8. REPLAY é RECUSADO quando a ordem já está comprometida, e ATRAVESSA em
 *      modo de reconciliação — auditado dos dois lados;
 *   9. RETRY ANTIGO bloqueia turno novo (não o contrário), e o backoff em
 *      aberto não autoriza ultrapassagem.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const enqueueAgentMock = vi.fn(async () => {});
vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: (...args: unknown[]) => enqueueAgentMock(...(args as [])),
  agentQueue: {},
  QueueRedisUnavailableError: class QueueRedisUnavailableError extends Error {},
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'poison629-tenant-a';
const A_A = 'poison629-agent-a';
/** Segundo agente DO MESMO tenant — a colisão que `agents.id` global esconde. */
const A_A2 = 'poison629-agent-a2';
/** Segundo tenant — a colisão que a `stream_key` derivada esconde. */
const T_B = 'poison629-tenant-b';
const A_B = 'poison629-agent-b';

const LEASE_MS = 60_000;

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inA2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A2 }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

async function ensureScopes(): Promise<void> {
  for (const [t, a] of [
    [T_A, A_A],
    [T_A, A_A2],
    [T_B, A_B],
  ] as const) {
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
      t,
    ]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [a, t],
    );
  }
}

async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, tenant, agent],
  );
  return id;
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

async function setStatus(turn_id: string, status: string): Promise<void> {
  await pool.query(`UPDATE agent_turns SET status = $2 WHERE id = $1`, [turn_id, status]);
}

/** Uma `stream_key` do formato real (v1 + hash), longa o bastante para não colidir. */
const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

async function blocosAtivos(tenant: string, agent: string): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `SELECT * FROM agent_stream_blocks
      WHERE tenant_id = $1 AND agent_id = $2 AND unblocked_at IS NULL
      ORDER BY blocked_at`,
    [tenant, agent],
  );
  return r.rows as Array<Record<string, unknown>>;
}

async function auditoria(tenant: string, acao: string): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `SELECT * FROM audit_log WHERE tenant_id = $1 AND acao = $2 ORDER BY created_at`,
    [tenant, acao],
  );
  return r.rows as Array<Record<string, unknown>>;
}

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

const abertos: Handle[] = [];

d('#629 — poison, DLQ e replay (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const turns = moduloDeProducao(() => import('@/runtime/turns/lifecycle.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  const streamMetrics = moduloDeProducao(() => import('@/runtime/turns/stream-metrics.js'));
  const replayOps = moduloDeProducao(() => import('@/ops/turn-replay.js'));
  const unblockOps = moduloDeProducao(() => import('@/ops/stream-unblock.js'));

  /**
   * Turno `received` numa stream NOMEADA, escopado. A CRIAÇÃO é a de produção
   * (`ensureTurnForMessage`); só as colunas de shadow são carimbadas depois,
   * como o ingresso da fatia A as carimbaria.
   */
  async function turnInStream(args: {
    tenant: string;
    agent: string;
    stream_key: string;
    seq: number;
  }): Promise<string> {
    const mensagem_id = await mkInbound(args.tenant, args.agent);
    const turn = await runWithTenantContext(
      { tenant_id: args.tenant, agent_id: args.agent },
      () =>
        repos().agentTurnsRepo.ensureTurnForMessage({
          id: mensagem_id,
          tenant_id: args.tenant,
          agent_id: args.agent,
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

  /** Executa um turno até `running`, pela porta de produção. */
  async function executar(turn_id: string, scope = inA): Promise<Handle> {
    const handle = handleFor(turn_id);
    abertos.push(handle);
    const inicio = await scope(() => turns().beginTurnExecution(handle as never));
    expect(inicio.started).toBe(true);
    return handle;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureScopes();
  }, 30_000);

  afterAll(async () => {
    for (const t of [T_A, T_B]) {
      await pool?.query(`DELETE FROM agent_stream_blocks WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_A2, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    for (const h of abertos.splice(0)) {
      (h.lease as { stop?: () => void } | null)?.stop?.();
    }
    for (const t of [T_A, T_B]) {
      await pool.query(`DELETE FROM agent_stream_blocks WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    enqueueAgentMock.mockClear();
    enqueueAgentMock.mockImplementation(async () => {});
    // Métrica ZERADA e RE-SEMEADA a cada caso: as asserções abaixo são
    // ABSOLUTAS, não deltas. Uma asserção por delta sobre estado global mutável
    // fica verde na SEGUNDA tentativa do `retry: 1` do vitest, porque herda a
    // mutação da primeira como linha de base — e o processo sai com falharam=0
    // escondendo um vermelho real.
    metricas()._resetForTests();
    streamMetrics()._resetSeedForTests();
    streamMetrics().registrarSeriesDeStream();
    turns()._resetPoisonPolicyCacheForTests();
  });

  /** Um contador do Prometheus, como número ABSOLUTO. */
  async function contador(nome: string, labels: string): Promise<number> {
    const body = await metricas().renderPrometheus();
    const m = new RegExp(`^${nome}\\{${labels}\\} (\\d+)`, 'm').exec(body);
    return m ? Number(m[1]) : -1;
  }

  // ─── SONDA 1 — MODO `release` ─────────────────────────────────────────────

  it('modo release: `dead_letter` de categoria não-crítica LIBERA a conversa', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });

    const head = await executar(m1);
    enqueueAgentMock.mockClear();

    // `reasoner_failed` classifica como `model`, que NÃO está na lista de
    // categorias que bloqueiam. É o comportamento da #627, agora nomeado.
    await inA(() =>
      turns().deadLetterTurn(head as never, {
        code: 'reasoner_failed',
        outcome: 'retry_exhausted',
      }),
    );

    expect((await readTurn(m1))['status']).toBe('dead_letter');
    // NENHUMA interdição. Invariante ABSOLUTA: a lista está vazia, não "não
    // cresceu".
    expect(await blocosAtivos(T_A, A_A)).toEqual([]);
    // E o sucessor foi PROMOVIDO — a conversa anda.
    const sucessor = await readTurn(m2);
    expect(sucessor['status']).toBe('queued');
    expect(sucessor['promoted_at']).not.toBeNull();
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);

    // A DECISÃO é contada, e `release` não é "nada aconteceu": é a escolha de
    // deixar a conversa seguir depois de um turno ter morrido.
    expect(await contador('maia_stream_poison_total', 'category="model",disposition="release"')).toBe(
      1,
    );
    expect(
      await contador('maia_stream_poison_total', 'category="model",disposition="block_stream"'),
    ).toBe(0);

    // E o sucessor é REIVINDICÁVEL agora — a fila andou de verdade.
    const claim = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w-release',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(true);
  });

  // ─── SONDA 2 — MODO `block_stream` ────────────────────────────────────────

  it('modo block: `unsafe_to_retry` INTERDITA a conversa, não promove, e o claim recusa', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    await setStatus(m2, 'queued');

    const head = await executar(m1);
    enqueueAgentMock.mockClear();

    await inA(() =>
      turns().deadLetterTurn(head as never, {
        code: 'outbound_failure',
        outcome: 'unsafe_to_retry',
      }),
    );

    expect((await readTurn(m1))['status']).toBe('dead_letter');

    // A INTERDIÇÃO, no banco. Exatamente uma, com a categoria que DECIDIU.
    const blocos = await blocosAtivos(T_A, A_A);
    expect(blocos).toHaveLength(1);
    expect(blocos[0]!['reason']).toBe('poison');
    expect(blocos[0]!['category']).toBe('effect_committed');
    expect(blocos[0]!['blocked_by_turn_id']).toBe(m1);
    expect(blocos[0]!['error_code']).toBe('outbound_failure');

    // O sucessor NÃO foi promovido e NÃO recebeu wake-up. A ordem entre as duas
    // escritas é o que garante isto: o bloqueio entra ANTES da eleição, e a
    // eleição carrega `streamNotPoisoned`.
    const sucessor = await readTurn(m2);
    expect(sucessor['promoted_at']).toBeNull();
    expect(enqueueAgentMock).not.toHaveBeenCalled();

    // E o claim do sucessor é RECUSADO com o código próprio — não `not_head`
    // (que diria "espere") nem `not_eligible` (que falaria do turno).
    const claim = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w-poison',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(false);
    expect(claim.ok === false && claim.reason).toBe('stream_poisoned');
    // E o diagnóstico aponta QUEM envenenou, sem recorrer à `stream_key`.
    expect(claim.ok === false && claim.head_block?.turn_id).toBe(m1);

    expect(
      await contador(
        'maia_stream_poison_total',
        'category="effect_committed",disposition="block_stream"',
      ),
    ).toBe(1);
    expect(await contador('maia_stream_blocked_total', 'reason="stream_poisoned"')).toBe(1);
    expect(await contador('maia_turn_claim_total', 'result="stream_poisoned"')).toBe(1);

    // A trilha: a DECISÃO auditada, com a categoria que a produziu.
    const rows = await auditoria(T_A, 'stream_poisoned');
    expect(rows).toHaveLength(1);
    const meta = rows[0]!['metadata'] as Record<string, unknown>;
    expect(meta['category']).toBe('effect_committed');
    expect(meta['disposition']).toBe('block_stream');
    expect(meta['blocked_by_turn_id']).toBe(m1);
    // E NUNCA a `stream_key`.
    expect(JSON.stringify(rows[0])).not.toContain(key);
  });

  // ─── SONDA 3 — ATOMICIDADE ────────────────────────────────────────────────

  it('ATOMICIDADE: falha ENTRE as duas escritas desfaz as duas', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const head = await executar(m1);
    const antes = await readTurn(m1);

    // O ponto de falha é ENTRE o `UPDATE agent_turns` (dead_letter) e o
    // `INSERT agent_stream_blocks` — e não DENTRO de nenhuma das duas. Uma
    // falha na PRÓPRIA primeira escrita deixaria o caso verde com a transação
    // quebrada: nada teria sido escrito de qualquer jeito. O gatilho abaixo
    // dispara depois de a primeira já ter acontecido na transação.
    await pool.query(`
      CREATE OR REPLACE FUNCTION poison629_falha() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'poison629: falha injetada ENTRE as duas escritas'; END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER poison629_falha_trg BEFORE INSERT ON agent_stream_blocks
      FOR EACH ROW EXECUTE FUNCTION poison629_falha();
    `);
    try {
      await inA(() =>
        turns().deadLetterTurn(head as never, {
          code: 'outbound_failure',
          outcome: 'unsafe_to_retry',
        }),
      ).catch(() => undefined);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS poison629_falha_trg ON agent_stream_blocks`);
      await pool.query(`DROP FUNCTION IF EXISTS poison629_falha()`);
    }

    // INVARIANTE ABSOLUTA, não delta: o turno NÃO está morto e NÃO há bloqueio.
    // Se as duas escritas não fossem um átomo, o turno estaria `dead_letter`
    // com a conversa LIVRE — a falha nº 5 da issue-mãe pela porta dos fundos.
    const depois = await readTurn(m1);
    expect(depois['status']).toBe(antes['status']);
    expect(depois['status']).not.toBe('dead_letter');
    expect(await blocosAtivos(T_A, A_A)).toEqual([]);
    // E o sucessor continua exatamente onde estava.
    expect((await readTurn(m2))['promoted_at']).toBeNull();
  });

  // ─── SONDA 4 — IDEMPOTÊNCIA ───────────────────────────────────────────────

  it('duas conclusões envenenadas da MESMA conversa produzem UMA interdição', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });

    const h1 = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(h1 as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );
    // O segundo só consegue rodar porque o teste o executa à força — em
    // produção o claim dele seria recusado. É exatamente o caso que o índice
    // único parcial existe para cobrir: duas conclusões terminais simultâneas
    // da mesma stream (o head e um irmão absorvido que também esgotou).
    await pool.query(
      `UPDATE agent_turns SET status='running', claim_token=gen_random_uuid(),
              claimed_by='w', claimed_at=now(), lease_expires_at=now()+interval '60 s'
        WHERE id = $1`,
      [m2],
    );
    const row2 = await readTurn(m2);
    const h2: Handle = {
      turn_id: m2,
      status: 'running',
      state_version: Number(row2['state_version']),
      attempt_count: Number(row2['attempt_count']),
      conversa_id: null,
      lease: null,
    };
    await inA(() =>
      turns().deadLetterTurn(h2 as never, { code: 'y', outcome: 'unsafe_to_retry' }),
    );

    // UMA linha ativa. O `ON CONFLICT DO NOTHING` sobre o índice único parcial
    // é o que garante isso NO BANCO — não a ordem em que os callers rodam.
    expect(await blocosAtivos(T_A, A_A)).toHaveLength(1);
    // E UMA auditoria: uma segunda row de bloqueio faria o operador procurar
    // dois incidentes onde há um.
    expect(await auditoria(T_A, 'stream_poisoned')).toHaveLength(1);
  });

  // ─── SONDA 5 — o varredor não churna ──────────────────────────────────────

  it('o recovery NÃO rearma turnos de uma conversa interditada', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const head = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );

    // Envelhece o sucessor para além de STUCK_AFTER_MS: sem a interdição ele
    // seria candidato óbvio do varredor.
    await pool.query(
      `UPDATE agent_turns SET status='queued', created_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [m2],
    );

    const candidatos = await inA(() =>
      repos().agentTurnsRepo.findRecoverableTurns(2 * 60 * 1000, 200),
    );
    // INVARIANTE ABSOLUTA: nenhum candidato desta conversa. Sem o filtro, o
    // varredor rearmaria a cada ciclo um turno que o claim vai recusar —
    // trabalho infinito com aparência de recuperação.
    expect(candidatos.map((c) => c.turn.id)).not.toContain(m2);
  });

  // ─── SONDA 6 — DESBLOQUEIO ────────────────────────────────────────────────

  it('o desbloqueio libera a conversa, re-arma o head e audita — o morto continua morto', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const head = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );
    enqueueAgentMock.mockClear();

    const out = await unblockOps().unblockStreamByOperator({
      turn_id: m1,
      actor: 'operador-teste',
      reason: 'efeito conciliado à mão',
    });
    expect(out.unblocked).toBe(true);
    expect(out.unblocked === true && out.rearmed_turn_id).toBe(m2);

    // A interdição saiu, e o histórico FICOU com autor e justificativa.
    expect(await blocosAtivos(T_A, A_A)).toEqual([]);
    const hist = await pool.query(
      `SELECT * FROM agent_stream_blocks WHERE tenant_id = $1`,
      [T_A],
    );
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0]!.unblocked_by).toBe('operador-teste');
    expect(hist.rows[0]!.unblock_reason).toBe('efeito conciliado à mão');

    // O head foi re-armado no transporte.
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect((enqueueAgentMock.mock.calls[0]![0] as { turn_id: string }).turn_id).toBe(m2);

    // E agora o claim PASSA — a conversa voltou a andar de verdade.
    const claim = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w-unblocked',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(true);

    // O turno ENVENENADO continua em `dead_letter`: desbloquear e ressuscitar
    // são decisões diferentes, e fundi-las faria a segunda acontecer por
    // acidente.
    expect((await readTurn(m1))['status']).toBe('dead_letter');

    const rows = await auditoria(T_A, 'stream_unblocked');
    expect(rows).toHaveLength(1);
    const meta = rows[0]!['metadata'] as Record<string, unknown>;
    expect(meta['actor']).toBe('operador-teste');
    expect(meta['operator_reason']).toBe('efeito conciliado à mão');
    expect(JSON.stringify(rows[0])).not.toContain(key);
  });

  it('desbloquear duas vezes: a segunda é recusada e NÃO audita de novo', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const head = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );

    const primeiro = await unblockOps().unblockStreamByOperator({
      turn_id: m1,
      actor: 'op-1',
      reason: 'r1',
    });
    expect(primeiro.unblocked).toBe(true);
    const segundo = await unblockOps().unblockStreamByOperator({
      turn_id: m1,
      actor: 'op-2',
      reason: 'r2',
    });
    expect(segundo.unblocked).toBe(false);

    // UMA decisão humana, UMA row. E o `unblocked_by` do histórico continua
    // sendo o de quem de fato destravou — um `UPDATE` cego o teria sobrescrito.
    const rows = await auditoria(T_A, 'stream_unblocked');
    expect(rows).toHaveLength(1);
    const hist = await pool.query(`SELECT * FROM agent_stream_blocks WHERE tenant_id = $1`, [T_A]);
    expect(hist.rows[0]!.unblocked_by).toBe('op-1');
  });

  // ─── SONDA 7 — ISOLAMENTO, com a colisão FORÇADA ──────────────────────────

  it('a MESMA `stream_key` literal em dois tenants NÃO compartilha interdição', async () => {
    // A colisão é FORÇADA: a mesma string, letra por letra, nos dois escopos.
    // Sem forçá-la, a `stream_key` derivada já seria seletiva sozinha e a sonda
    // passaria sem provar nada.
    const key = streamKey();
    const a1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const a2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const b1 = await turnInStream({ tenant: T_B, agent: A_B, stream_key: key, seq: 1 });
    const b2 = await turnInStream({ tenant: T_B, agent: A_B, stream_key: key, seq: 2 });

    const head = await executar(a1);
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );

    // A do tenant A está interditada.
    const claimA = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: a2,
        worker_id: 'w-a',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimA.ok === false && claimA.reason).toBe('stream_poisoned');

    // A do tenant B, com a MESMA chave, NÃO está.
    expect(await blocosAtivos(T_B, A_B)).toEqual([]);
    const claimB = await inB(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: b1,
        worker_id: 'w-b',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimB.ok).toBe(true);
    expect(b2).toBeTruthy();
  });

  it('dois AGENTS do MESMO tenant, mesma `stream_key`, não compartilham interdição', async () => {
    // A segunda colisão que já mordeu esta leva: `agents.id` é PK GLOBAL, então
    // um predicado que separasse só por agente passaria verde sem provar nada
    // sobre tenant — e um que separasse só por tenant passaria verde sem provar
    // nada sobre agente. Este caso fecha o segundo eixo.
    const key = streamKey();
    const a1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const a2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const x1 = await turnInStream({ tenant: T_A, agent: A_A2, stream_key: key, seq: 1 });

    const head = await executar(a1);
    await inA(() =>
      turns().deadLetterTurn(head as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );

    const claimA = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: a2,
        worker_id: 'w-a',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimA.ok === false && claimA.reason).toBe('stream_poisoned');

    expect(await blocosAtivos(T_A, A_A2)).toEqual([]);
    const claimX = await inA2(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: x1,
        worker_id: 'w-a2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimX.ok).toBe(true);
  });

  // ─── SONDA 8 — REPLAY e a ordem já comprometida ───────────────────────────

  it('replay é RECUSADO quando um turno POSTERIOR já terminou, e a recusa é auditada', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });

    const head = await executar(m1);
    // `reasoner_failed` LIBERA a conversa (modo release), que é o cenário em
    // que a ordem pode de fato ser comprometida depois.
    await inA(() =>
      turns().deadLetterTurn(head as never, {
        code: 'reasoner_failed',
        outcome: 'retry_exhausted',
      }),
    );
    // O sucessor roda e TERMINA: daqui em diante, a plataforma já respondeu uma
    // mensagem POSTERIOR à do turno morto.
    const seg = await executar(m2);
    await inA(() => turns().concludeTurn(seg as never, 'reply_delivered'));
    expect((await readTurn(m2))['status']).toBe('completed');

    enqueueAgentMock.mockClear();
    const out = await replayOps().replayTurnByOperator({
      turn_id: m1,
      actor: 'op',
      reason: 'quero de volta',
    });
    expect(out.replayed).toBe(false);
    expect(out.replayed === false && out.reason).toBe('order_committed');
    expect(out.replayed === false && out.reason === 'order_committed' && out.committed_after).toBe(
      1,
    );

    // INVARIANTE ABSOLUTA: NADA mudou. O turno continua morto e nenhum job foi
    // armado — a recusa não pode ser "recusou e rearmou mesmo assim".
    expect((await readTurn(m1))['status']).toBe('dead_letter');
    expect(enqueueAgentMock).not.toHaveBeenCalled();

    const rows = await auditoria(T_A, 'turn_replay_refused');
    expect(rows).toHaveLength(1);
    expect((rows[0]!['metadata'] as Record<string, unknown>)['committed_after']).toBe(1);
  });

  it('replay PASSA em modo de reconciliação, e a travessia tem row própria', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const head = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(head as never, {
        code: 'reasoner_failed',
        outcome: 'retry_exhausted',
      }),
    );
    const seg = await executar(m2);
    await inA(() => turns().concludeTurn(seg as never, 'reply_delivered'));

    const out = await replayOps().replayTurnByOperator({
      turn_id: m1,
      actor: 'op',
      reason: 'reconciliação manual autorizada',
      reconcile: true,
    });
    expect(out.replayed).toBe(true);
    expect((await readTurn(m1))['status']).toBe('queued');

    // A row que existe SÓ para a travessia. É a única evidência de que a
    // plataforma processou algo fora da ordem que já havia entregue.
    const reconciliados = await auditoria(T_A, 'turn_replay_reconciled');
    expect(reconciliados).toHaveLength(1);
    expect((reconciliados[0]!['metadata'] as Record<string, unknown>)['actor']).toBe('op');
    // E o modo também fica na row de rotina, para que ela seja legível sozinha.
    const replays = await auditoria(T_A, 'turn_replayed');
    expect(replays).toHaveLength(1);
    expect((replays[0]!['metadata'] as Record<string, unknown>)['mode']).toBe('reconcile');
    // Nenhuma recusa foi registrada — a travessia não passa pelo caminho de
    // recusa.
    expect(await auditoria(T_A, 'turn_replay_refused')).toHaveLength(0);
  });

  it('replay NÃO é recusado quando o posterior está apenas VIVO (e não terminal)', async () => {
    // A distinção que a regra faz, e que um `EXISTS` sobre "qualquer posterior"
    // apagaria: um posterior ainda vivo não comprometeu nada — ele será
    // recusado com `not_head` assim que o turno replayado voltar a ser o head,
    // que é o protocolo funcionando.
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const head = await executar(m1);
    await inA(() =>
      turns().deadLetterTurn(head as never, {
        code: 'reasoner_failed',
        outcome: 'retry_exhausted',
      }),
    );
    expect((await readTurn(m2))['status']).toBe('queued');

    const out = await replayOps().replayTurnByOperator({
      turn_id: m1,
      actor: 'op',
      reason: 'ainda dá tempo',
    });
    expect(out.replayed).toBe(true);
    expect((await readTurn(m1))['status']).toBe('queued');
    expect(await auditoria(T_A, 'turn_replay_reconciled')).toHaveLength(0);
  });

  // ─── SONDA 9 — RETRY ANTIGO BLOQUEIA TURNO NOVO ───────────────────────────

  it('retry antigo com backoff EM ABERTO bloqueia o turno novo — nunca o contrário', async () => {
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });

    // M1 falha de forma recuperável, pela porta de produção: vai a `retryable`
    // com `next_attempt_at` no FUTURO (o backoff é do PostgreSQL, não da fila).
    const head = await executar(m1);
    await inA(() => turns().failTurnRetryable(head as never, { code: 'reasoner_failed' }));
    const antigo = await readTurn(m1);
    expect(antigo['status']).toBe('retryable');
    expect(new Date(antigo['next_attempt_at'] as string).getTime()).toBeGreaterThan(Date.now());

    // O turno NOVO tenta passar na frente. A issue-mãe é literal: "backoff não
    // autoriza ultrapassagem silenciosa por mensagens posteriores".
    const claimNovo = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w-novo',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimNovo.ok).toBe(false);
    expect(claimNovo.ok === false && claimNovo.reason).toBe('not_head');
    expect(claimNovo.ok === false && claimNovo.head_block?.turn_id).toBe(m1);

    // E o ANTIGO também não roda ainda — o backoff é dele, e ele o respeita.
    // Sem esta metade, "bloqueia o novo" seria compatível com "o antigo furou o
    // próprio backoff", que é outra inversão.
    const claimAntigoCedo = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m1,
        worker_id: 'w-antigo',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimAntigoCedo.ok === false && claimAntigoCedo.reason).toBe('not_eligible');

    // Vencido o backoff, quem anda é o ANTIGO — na vez dele.
    await pool.query(
      `UPDATE agent_turns SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [m1],
    );
    const claimAntigo = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m1,
        worker_id: 'w-antigo',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimAntigo.ok).toBe(true);

    // E o novo CONTINUA atrás, agora porque o antigo está ativo.
    const claimNovo2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: m2,
        worker_id: 'w-novo-2',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claimNovo2.ok).toBe(false);
    expect(claimNovo2.ok === false && claimNovo2.reason).toBe('not_head');
  });

  it('a promoção NÃO ultrapassa um `retryable` com backoff em aberto', async () => {
    // O espelho da sonda anterior, pelo lado da promoção: o head morre, o
    // sucessor imediato está em backoff, e o turno SEGUINTE a ele não pode ser
    // eleito. É a cláusula da #627 ("a conversa espera o varredor") vista da
    // #629, e a latência que ela custa é reportada de propósito.
    const key = streamKey();
    const m1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const m2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    const m3 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 3 });

    await pool.query(
      `UPDATE agent_turns SET status='retryable', next_attempt_at = now() + interval '10 minutes'
        WHERE id = $1`,
      [m2],
    );
    const head = await executar(m1);
    enqueueAgentMock.mockClear();
    await inA(() => turns().concludeTurn(head as never, 'reply_delivered'));

    // Nenhum dos dois foi promovido: nem o sucessor (backoff em aberto) nem o
    // terceiro (furaria a ordem).
    expect((await readTurn(m2))['promoted_at']).toBeNull();
    expect((await readTurn(m3))['promoted_at']).toBeNull();
    expect(enqueueAgentMock).not.toHaveBeenCalled();
    expect(await contador('maia_stream_promotion_total', 'result="no_successor"')).toBe(1);
    expect(await contador('maia_stream_promotion_total', 'result="promoted"')).toBe(0);
  });
});

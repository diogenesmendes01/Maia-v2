/**
 * SC07 (§5.1.3, §5.8.1, §5.10.3, §11.2/T15) — HEARTBEAT LIMITADO E SERIALIZADO,
 * contra Postgres real.
 *
 * ─── O que esta suíte é, e o que ela NÃO é ──────────────────────────────────
 *
 * A suíte irmã `tests/integration/turn-lease-heartbeat-renew-real-db.spec.ts`
 * (#504) prova que o heartbeat RENOVA de fato. Esta prova o que a §5.8.1
 * endurece depois disso, e cada caso existe porque uma propriedade NÃO é
 * observável sem banco:
 *
 *   · SERIALIZAÇÃO: o `setInterval` original agendava a batida seguinte pelo
 *     relógio, não pela conclusão da anterior. Com uma renovação mais lenta que
 *     o intervalo, N consultas convivem e a resposta atrasada reescreve o
 *     horizonte com um vencimento mais VELHO. Aqui a renovação REAL é envolvida
 *     por uma sonda que conta quantas estão em voo, e a asserção é `max === 1`.
 *   · TETO DA CONSULTA no SERVIDOR: a renovação travada é cancelada por
 *     `statement_timeout` (SQLSTATE `57014`) — não por um `Promise.race` que
 *     abandona a promessa e deixa a consulta viva. A prova é o CÓDIGO DE ERRO do
 *     PostgreSQL e a conexão voltando utilizável.
 *   · DEADLINE ABSOLUTO: `agent_turns.deadline_at` entra no `context().deadline`
 *     como teto. Renovação saudável empurra `lease_expires_at` e NÃO move o
 *     teto — que é o defeito de "turno sem fim" da AC03/AC06.
 *   · PERDA DE POSSE: recusa de token, duas falhas consecutivas, e a margem
 *     esgotada DURANTE a batida (relógio monotônico controlado) — os três
 *     caminhos que a AC04 nomeia.
 *   · ENCERRAMENTO: `settle()` aguarda a batida em voo e desarma o loop;
 *     `cleanupTurnClaim` devolve APENAS a posse quando não há terminal e não
 *     escreve nada além disso (AC05) — com um run durável em `submission_unknown`
 *     no journal para provar que o "efeito desconhecido" continua lá.
 *
 * O relógio monotônico é INJETÁVEL (`mono_ms`) porque o tempo real não pode ser
 * controlado de forma determinística com Postgres real: os casos de expiração
 * falham ou passam por sorte de agendamento. O par (lease_expires_at − heartbeat
 * do BANCO) continua sendo a verdade; o que a injeção controla é o DECORRIDO.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { pgErrorCode, pool as appPool } from '@/db/client.js';
import { renderPrometheus } from '@/lib/metrics.js';
import { cleanupTurnClaim } from '@/agent/core.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { TurnClaim } from '@/runtime/turns/claim.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/** Tenant próprio: `default` é proibido pelos CHECKs do journal do engine. */
const T = 'sc07hb-tenant';
const A = 'sc07hb-agent';

let pool: pg.Pool;

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

/**
 * Corpo de teste DENTRO do contexto de tenant.
 *
 * `renewTurnLease`/`releaseTurnClaim` montam o `WHERE` por tenant/agent a partir
 * do ALS, e os timers de heartbeat herdam o contexto em que a lease foi criada:
 * uma lease construída fora do escopo faria TODA renovação cair no catch, e o
 * teste passaria a medir o erro errado. Mesmo requisito das specs #504.
 */
const itT = (name: string, fn: () => Promise<void>, timeout = 30_000): void =>
  it(
    name,
    async () => {
      await inT(fn);
    },
    timeout,
  );

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Espera por EVIDÊNCIA, nunca por relógio de parede. O prazo generoso existe só
 * para não pendurar a suíte; quem decide é a condição.
 */
async function waitFor(
  cond: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`prazo estourou esperando: ${label}`);
    await sleep(25);
  }
}

async function mkTurn(): Promise<{ turn_id: string; mensagem_id: string }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [mensagem_id, T, A],
  );
  const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');
  const turn = await inT(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T,
      agent_id: A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return { turn_id: turn.id, mensagem_id };
}

/** A linha INTEIRA do turno — a única fonte de verdade sobre o que foi escrito. */
async function turnRow(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `SELECT * FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
    [T, A, turn_id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`turno ${turn_id} sumiu do banco`);
  return row as Record<string, unknown>;
}

async function claimTurn(
  turn_id: string,
  lease_ms: number,
  worker_id = `sc07-${randomUUID().slice(0, 8)}`,
) {
  const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');
  const result = await inT(() =>
    agentTurnsRepo.claimNextEligibleTurn({ turn_id, worker_id, lease_ms }),
  );
  if (!result.ok) throw new Error(`claim recusado: ${result.reason}`);
  return result.claim;
}

/** DELTA de uma série do registry, somando TODOS os labels (SLO lê por sum()). */
async function counterTotal(name: string): Promise<number> {
  const text = await renderPrometheus();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * Um run DURÁVEL no journal, no estágio em que a submissão é INCERTA.
 *
 * É o artefato que a AC05 manda preservar: `submission_unknown` é literalmente
 * "não se sabe se o efeito remoto aconteceu". Se o encerramento da posse
 * apagasse/alterasse esta linha — ou declarasse o turno retryável —, o recovery
 * reenviaria um run que pode já ter produzido efeito no provedor.
 */
async function mkUnknownSubmissionRun(turn_id: string): Promise<string> {
  const control = await pool.query<{ id: string }>(
    `INSERT INTO conversation_controls (tenant_id, agent_id, stream_key, stream_key_version, channel_id, mode)
     VALUES ($1, $2, $3, 1, gen_random_uuid(), 'bot')
     RETURNING id`,
    [T, A, `sc07-stream-${randomUUID().slice(0, 8)}`],
  );
  const control_id = control.rows[0]!.id;
  await pool.query(
    `INSERT INTO engine_turn_bindings
       (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest, protocol_version, max_generations)
     VALUES ($1, $2, $3, 'hermes', 'sc07-rev', repeat('a', 64), 1, 3)`,
    [T, A, turn_id],
  );
  const run = await pool.query<{ id: string }>(
    `INSERT INTO engine_runs
       (tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt, origin_claim_token,
        origin_worker_id, control_id, control_epoch, mode, manifest_digest, phase, request_key,
        remote_instance_id, request_json, request_hash, host_context_json, host_context_hash,
        deadline_at, reconcile_deadline_at)
     VALUES ($1, $2, $3, 1, 1, gen_random_uuid(), 'sc07-origin', $4, 0, 'live', repeat('b', 64),
             'submission_unknown', gen_random_uuid(), 'sc07-instance', '{}'::jsonb, repeat('c', 64),
             '{}'::jsonb, repeat('d', 64), now() + interval '30 seconds', now() + interval '60 seconds')
     RETURNING id`,
    [T, A, turn_id, control_id],
  );
  return run.rows[0]!.id;
}

d('SC07 — heartbeat limitado e serializado (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [T]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [A, T],
    );
  }, 30_000);

  afterAll(async () => {
    // Teardown em ORDEM de FK e por TENANT/AGENT — não pela lista de ids criados.
    //
    // O tenant deste spec é exclusivo, então o filtro por (tenant, agent) é
    // isolado por construção; e limpar por escopo, em vez de por id, faz a
    // rodada seguinte apagar qualquer sobra de uma rodada ANTERIOR que tenha
    // morrido no meio (um caso que falha não pode deixar o banco sujo para o
    // próximo — foi exatamente o que aconteceu aqui: uma sobra de `engine_runs`
    // de uma rodada anterior quebrou o DELETE de `conversation_controls` por FK,
    // e o erro no teardown contamina a rodada seguinte).
    //
    // Ordem: `engine_runs` (referenciado por engine_tool_calls/events/projections)
    // → `engine_turn_bindings` → `agent_turns` (leva `agent_turn_inputs` por
    // ON DELETE CASCADE, que é quem segura `mensagens`) → `mensagens` →
    // `conversation_controls` (referenciado por `engine_runs.control_id`).
    await pool.query(`DELETE FROM engine_runs WHERE tenant_id = $1 AND agent_id = $2`, [T, A]);
    await pool.query(`DELETE FROM engine_turn_bindings WHERE tenant_id = $1 AND agent_id = $2`, [
      T,
      A,
    ]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2`, [T, A]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1 AND agent_id = $2`, [T, A]);
    await pool.query(`DELETE FROM conversation_controls WHERE tenant_id = $1 AND agent_id = $2`, [
      T,
      A,
    ]);
    await pool.end();
  }, 30_000);

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC01 — uma única instância por claim; no máximo uma renew em voo
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC01 — o segundo claim do mesmo turno NÃO cria uma segunda lease',
    async () => {
      const { acquireTurnLease } = await import('@/runtime/turns/lease.js');
      const { turn_id } = await mkTurn();

      const primeira = await inT(() => acquireTurnLease(turn_id));
      expect(primeira.lease, 'o claim inicial deveria conceder a posse').not.toBeNull();
      if (!primeira.lease) throw new Error('sem lease');

      try {
        const segunda = await inT(() => acquireTurnLease(turn_id));
        expect(segunda.lease, 'uma segunda lease para o MESMO claim é execução dupla').toBeNull();
        expect(segunda.result.ok).toBe(false);
        if (!segunda.result.ok) expect(segunda.result.reason).toBe('not_eligible');
        // A primeira continua sendo a única dona.
        expect(primeira.lease.alive).toBe(true);
        expect(primeira.lease.lostReason).toBeNull();
      } finally {
        await primeira.lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC01/AC06 — com renovação mais lenta que o intervalo, no máximo UMA renew fica em voo',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const TTL = 8_000;
      const HEARTBEAT = 100;
      const DELAY = 60; // > metade do intervalo: o `setInterval` sobreporia.
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, TTL);
      const antes = await turnRow(turn_id);

      const real = agentTurnsRepo.renewTurnLease.bind(agentTurnsRepo);
      let emVoo = 0;
      let maxEmVoo = 0;
      let total = 0;
      const spy = vi
        .spyOn(agentTurnsRepo, 'renewTurnLease')
        .mockImplementation(async (input: Parameters<typeof real>[0]) => {
          emVoo += 1;
          total += 1;
          maxEmVoo = Math.max(maxEmVoo, emVoo);
          try {
            await sleep(DELAY);
            return await real(input);
          } finally {
            emVoo -= 1;
          }
        });

      const lease = new TurnLease(claim, { ttl_ms: TTL, heartbeat_ms: HEARTBEAT });
      try {
        await waitFor(async () => {
          const r = await turnRow(turn_id);
          return (r.heartbeat_at as Date).getTime() > (antes.heartbeat_at as Date).getTime();
        }, 'primeira renovação no banco');
        await waitFor(() => total >= 4, 'quatro batidas');
        expect(
          maxEmVoo,
          'duas renovações simultâneas: a batida seguinte foi agendada pelo relógio, não pela conclusão da anterior',
        ).toBe(1);
        // O loop ANDOU de verdade (não é um verde por ausência de batidas).
        expect(total).toBeGreaterThanOrEqual(4);
        expect(lease.alive).toBe(true);
        // A conexão é a mesma para todas: nada de N consultas na mesma pool.
        const depois = await turnRow(turn_id);
        expect((depois.heartbeat_at as Date).getTime()).toBeGreaterThan(
          (antes.heartbeat_at as Date).getTime(),
        );
      } finally {
        await lease.settle();
        spy.mockRestore();
        expect(emVoo, 'nenhuma renovação pode sobrar em voo depois do encerramento').toBe(0);
      }
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC02 — teto da consulta finito e menor que o heartbeat; cancelamento
  //              no SERVIDOR, com a conexão limpa
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC02 — a aritmética é fail-closed: heartbeat ≤ TTL/3 e teto da consulta < heartbeat',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { checkLeaseTiming, leaseQueryTimeoutMs, UnsafeLeaseTimingError } =
        await import('@/runtime/turns/claim.js');
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 8_000);
      const base: TurnClaim = claim;

      // O teto derivado é finito e ESTRITAMENTE menor que o intervalo.
      for (const hb of [100, 400, 15_000]) {
        const teto = leaseQueryTimeoutMs(hb);
        expect(Number.isFinite(teto)).toBe(true);
        expect(teto).toBeGreaterThan(0);
        expect(teto).toBeLessThan(hb);
        expect(teto).toBe(Math.floor(hb / 2));
      }
      expect(checkLeaseTiming(60_000, 15_000).ok, 'default de produção continua válido').toBe(true);
      expect(
        checkLeaseTiming(60_000, 30_000).ok,
        'metade do TTL não deixa duas falhas caberem',
      ).toBe(false);

      // O construtor RECUSA um teto que não limita nada (0 = "sem teto" no PG,
      // `Infinity`, ou >= heartbeat). Fail-closed, não decoração.
      for (const inseguro of [0, -1, Number.POSITIVE_INFINITY, 400, 401]) {
        expect(
          () =>
            new TurnLease(base, { ttl_ms: 8_000, heartbeat_ms: 400, query_timeout_ms: inseguro }),
        ).toThrow(UnsafeLeaseTimingError);
      }
      // E um teto explícito válido é aceito.
      const ok = new TurnLease(base, { ttl_ms: 8_000, heartbeat_ms: 400, query_timeout_ms: 150 });
      await ok.settle();
    },
    30_000,
  );

  itT(
    'AC02/AC06 — renovação travada é cancelada NO SERVIDOR (57014) e a conexão volta ao pool',
    async () => {
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 8_000);
      const TETO = 200;

      // Trava a LINHA do turno numa segunda conexão: a renovação vai ESPERAR o
      // lock, e é aí que o teto do statement precisa agir.
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          `SELECT id FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 FOR UPDATE`,
          [T, A, turn_id],
        );

        const t0 = Date.now();
        let erro: unknown = null;
        try {
          await inT(() =>
            agentTurnsRepo.renewTurnLease({
              turn_id,
              claim_token: claim.claim_token,
              lease_ms: 8_000,
              statement_timeout_ms: TETO,
            }),
          );
        } catch (err) {
          erro = err;
        }
        const decorrido = Date.now() - t0;

        expect(
          erro,
          'a consulta travada precisa FALHAR no teto, não pendurar a batida',
        ).not.toBeNull();
        expect(
          pgErrorCode(erro),
          'quem cancelou foi o PostgreSQL (statement_timeout), não um Promise.race abandonado',
        ).toBe('57014');
        expect(decorrido, 'a falha precisa caber no teto, com folga').toBeGreaterThanOrEqual(
          TETO - 50,
        );
        expect(decorrido).toBeLessThan(2_000);

        // A conexão foi DEVOLVIDA ao pool pelo `withTx` (ROLLBACK + release): o
        // statement cancelado não deixa transação aberta nem cliente preso.
        expect(appPool.waitingCount).toBe(0);
        expect(appPool.idleCount).toBeGreaterThanOrEqual(1);
        await appPool.query('SELECT 1');

        // E, destravada, a MESMA operação volta a funcionar — o cancelamento não
        // corrompeu nada.
        await locker.query('ROLLBACK');
        const renovada = await inT(() =>
          agentTurnsRepo.renewTurnLease({
            turn_id,
            claim_token: claim.claim_token,
            lease_ms: 8_000,
            statement_timeout_ms: TETO,
          }),
        );
        expect(renovada.ok, 'sem o lock, a renovação volta a ser concedida').toBe(true);
      } finally {
        try {
          await locker.query('ROLLBACK');
        } catch {
          /* já revertida */
        }
        locker.release();
      }
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC03 — deadline absoluto limita ctx.deadline e NÃO se move
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC03/AC06 — o teto absoluto limita o contexto e renovação saudável NÃO o estende',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      const TTL = 8_000;
      const HEARTBEAT = 200;
      const { turn_id } = await mkTurn();
      // O orçamento ABSOLUTO existe na coluna e passa a ser carregado no claim.
      await pool.query(
        `UPDATE agent_turns SET deadline_at = now() + interval '4 seconds' WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
        [T, A, turn_id],
      );
      const claim = await claimTurn(turn_id, TTL);
      expect(claim.deadline_at, 'o claim precisa carregar deadline_at no RETURNING').not.toBeNull();
      const teto = claim.deadline_at!;
      expect(teto.getTime(), 'o teto (4s) precisa ser mais curto que a lease (8s)').toBeLessThan(
        claim.lease_expires_at.getTime(),
      );

      const lease = new TurnLease(claim, { ttl_ms: TTL, heartbeat_ms: HEARTBEAT });
      try {
        const ctx = lease.context();
        expect(
          ctx.deadline.getTime(),
          'o horizonte da lease (8s) não pode substituir o orçamento do run (4s)',
        ).toBe(teto.getTime());

        // Renovação SAUDÁVEL empurra a lease para além do teto — e o prazo do
        // contexto continua sendo o do run. É esta asserção que fecha o defeito de
        // "turno sem fim": sem o teto, o getter seguiria a lease para sempre.
        await waitFor(async () => {
          const r = await turnRow(turn_id);
          return (r.lease_expires_at as Date).getTime() > teto.getTime() + 500;
        }, 'lease renovada para além do teto absoluto');

        expect(lease.alive, 'renovação saudável não é perda').toBe(true);
        expect(
          ctx.deadline.getTime(),
          'o horizonte MÓVEL não pode esticar o orçamento ABSOLUTO do run',
        ).toBe(teto.getTime());
        expect(lease.token).toBe(claim.claim_token);

        // Um deadline do caller MAIS LONGO que o teto também não o estica; um mais
        // curto vence (é o menor de todos).
        const maisLongo = new Date(teto.getTime() + 60_000);
        expect(lease.context(maisLongo).deadline.getTime()).toBe(teto.getTime());
        const maisCurto = new Date(Date.now() + 500);
        expect(lease.context(maisCurto).deadline.getTime()).toBe(maisCurto.getTime());
      } finally {
        await lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC03 — sem `deadline_at`, o horizonte volta a ser o da lease (nada muda no caminho legado)',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 8_000);
      expect(claim.deadline_at, 'nenhum caminho de produção escreve deadline_at hoje').toBeNull();

      const lease = new TurnLease(claim, { ttl_ms: 8_000, heartbeat_ms: 200 });
      try {
        expect(lease.context().deadline.getTime()).toBe(claim.lease_expires_at.getTime());
      } finally {
        await lease.settle();
      }
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC04 — recusa, expiração, duas falhas e o encerramento
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC04 — recusa de token perde a posse e NENHUM renew ressurge',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 8_000);
      const lease = new TurnLease(claim, { ttl_ms: 8_000, heartbeat_ms: 200 });
      try {
        // Outro worker assumiu (takeover): o token vigente deixa de ser o nosso.
        await pool.query(
          `UPDATE agent_turns SET claim_token = gen_random_uuid(), claimed_by = 'sc07-sucessor' WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
          [T, A, turn_id],
        );

        await waitFor(() => !lease.alive, 'a posse ser declarada perdida');
        expect(lease.lostReason, 'a recusa do CAS é `token_mismatch`').toBe('token_mismatch');
        expect(lease.token, 'depois da perda o token não pode ser devolvido').toBeNull();
        expect(lease.signal.aborted, 'a tentativa local precisa ser abortada').toBe(true);
        expect(lease.signal.reason).toBeInstanceOf(Error);

        // "Nenhum renew ressurge": o loop parou, então o banco não é mais tocado.
        const depoisDaPerda = await turnRow(turn_id);
        await sleep(3 * 200);
        const depois = await turnRow(turn_id);
        expect(
          (depois.heartbeat_at as Date).getTime(),
          'um dono que já perdeu a posse não pode continuar batendo no banco',
        ).toBe((depoisDaPerda.heartbeat_at as Date).getTime());
      } finally {
        await lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC04 — DUAS falhas consecutivas abortam a tentativa',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 8_000);
      // Lease de 8s: folga suficiente para as duas falhas caberem ANTES do
      // vencimento — que é a exigência da issue.
      const lease = new TurnLease(claim, { ttl_ms: 8_000, heartbeat_ms: 400 });

      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          `SELECT id FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 FOR UPDATE`,
          [T, A, turn_id],
        );
        const t0 = Date.now();
        await waitFor(() => !lease.alive, 'a segunda falha abortar a tentativa');
        expect(lease.lostReason).toBe('heartbeat_failed');
        expect(lease.signal.aborted).toBe(true);
        expect(
          Date.now() - t0,
          'abortar ANTES do vencimento: a lease de 8s ainda estava viva',
        ).toBeLessThan(8_000);
        // A lease no BANCO segue com prazo futuro: não vencemos por expiração.
        const r = await turnRow(turn_id);
        expect((r.lease_expires_at as Date).getTime()).toBeGreaterThan(Date.now());
      } finally {
        try {
          await locker.query('ROLLBACK');
        } catch {
          /* já revertida */
        }
        locker.release();
        await lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC04/AC03 — margem esgotada DURANTE a batida perde a posse por `expired` (relógio monotônico controlado)',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const TTL = 4_000;
      const HEARTBEAT = 400;
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, TTL);

      // Relógio monotônico INJETADO: o decorrido é controlado pelo teste, então a
      // expiração não depende de sorte de agendamento com banco real.
      let mono = 0;
      const real = agentTurnsRepo.renewTurnLease.bind(agentTurnsRepo);
      let liberar: (() => void) | null = null;
      const portao = new Promise<void>((r) => {
        liberar = r;
      });
      const spy = vi
        .spyOn(agentTurnsRepo, 'renewTurnLease')
        .mockImplementation(async (input: Parameters<typeof real>[0]) => {
          await portao;
          return real(input);
        });

      const lease = new TurnLease(claim, {
        ttl_ms: TTL,
        heartbeat_ms: HEARTBEAT,
        mono_ms: () => mono,
      });
      try {
        // A batida sai (margem intacta: mono=0) e fica PRESA. O processo "para" —
        // GC, event loop bloqueado — e a margem da lease acaba enquanto isso.
        await sleep(HEARTBEAT + 100);
        mono = TTL + 1_000;
        liberar!();
        await waitFor(() => !lease.alive, 'a perda por vencimento');
        expect(
          lease.lostReason,
          'a resposta veio depois de a margem acabar: a posse acabou por VENCIMENTO',
        ).toBe('expired');
        expect(lease.signal.aborted).toBe(true);
      } finally {
        await lease.settle();
        spy.mockRestore();
      }
    },
    30_000,
  );

  itT(
    'AC06 — o relógio de PAREDE do processo não decide expiração (margem vem do BANCO, medida em monotônico)',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      // TTL 1,2s com heartbeat 400ms: a margem, no relógio de parede, vence em
      // 1,2s. O relógio monotônico injetado fica CONGELADO, então a margem medida
      // pelo processo não corre — a lease não pode ser declarada "expired" pelo
      // relógio de parede.
      const TTL = 1_200;
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, TTL);
      const lease = new TurnLease(claim, {
        ttl_ms: TTL,
        heartbeat_ms: 400,
        mono_ms: () => 0,
      });

      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          `SELECT id FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 FOR UPDATE`,
          [T, A, turn_id],
        );
        const t0 = Date.now();
        await waitFor(() => !lease.alive, 'a perda por falhas consecutivas');
        expect(Date.now() - t0).toBeGreaterThanOrEqual(TTL * 0.9);
        expect(
          lease.lostReason,
          'o relógio de parede já passou do vencimento; a margem do banco + monotônico não — a perda é por FALHAS, não por expiração inventada',
        ).toBe('heartbeat_failed');
      } finally {
        try {
          await locker.query('ROLLBACK');
        } catch {
          /* já revertida */
        }
        locker.release();
        await lease.settle();
      }
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC04/AC05 — encerramento: aguarda a batida, remove o listener,
  //                  solta APENAS a posse
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC04 — `settle()` aguarda a batida em voo, desarma o loop e remove o listener',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const TTL = 8_000;
      const HEARTBEAT = 300;
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, TTL);

      const real = agentTurnsRepo.renewTurnLease.bind(agentTurnsRepo);
      let emVoo = 0;
      let total = 0;
      const spy = vi
        .spyOn(agentTurnsRepo, 'renewTurnLease')
        .mockImplementation(async (input: Parameters<typeof real>[0]) => {
          emVoo += 1;
          total += 1;
          try {
            await sleep(150); // batida longa: precisa estar EM VOO no encerramento
            return await real(input);
          } finally {
            emVoo -= 1;
          }
        });

      const lease = new TurnLease(claim, { ttl_ms: TTL, heartbeat_ms: HEARTBEAT });
      // O listener de `abort` é removido no encerramento — observado no próprio
      // sinal da lease, não por leitura de código.
      const remocoes = vi.spyOn(lease.signal, 'removeEventListener');
      try {
        await waitFor(() => emVoo === 1, 'uma batida em voo');
        await lease.settle();
        expect(emVoo, '`settle()` só resolve depois de a batida em voo terminar').toBe(0);
        expect(
          remocoes.mock.calls.some((c) => c[0] === 'abort'),
          'o ouvinte do AbortSignal precisa ser removido no encerramento',
        ).toBe(true);

        // Loop DESARMADO: nenhuma batida nova depois do encerramento. Se o timer
        // (ou o listener) tivesse sobrado, `total` cresceria.
        const totalNoFim = total;
        await sleep(3 * HEARTBEAT);
        expect(total, 'nenhuma renovação pode acontecer depois do encerramento').toBe(totalNoFim);
        expect(emVoo).toBe(0);
      } finally {
        spy.mockRestore();
        remocoes.mockRestore();
        await lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC05/AC04 — sem terminal, o cleanup solta SÓ a posse: run durável intacto e nenhum retry declarado',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, 60_000);
      // Efeito DESCONHECIDO em jogo: um run no journal, no estágio em que não se
      // sabe se o provedor recebeu o pedido.
      const run_id = await mkUnknownSubmissionRun(turn_id);
      const antes = await turnRow(turn_id);
      const antesRun = await pool.query(`SELECT * FROM engine_runs WHERE id = $1`, [run_id]);
      const releaseSpy = vi.spyOn(agentTurnsRepo, 'releaseTurnClaim');
      const perdidosAntes = await counterTotal('maia_turn_lease_lost_total');

      const lease = new TurnLease(claim, { ttl_ms: 60_000, heartbeat_ms: 15_000 });
      // `FEATURE_TURN_CLAIM` off → o status do handle é o que o core lê. O claim
      // deixou a linha em `claimed`, e é isso que o handle carrega.
      const handle: TurnHandle = {
        turn_id,
        status: 'claimed',
        state_version: claim.state_version,
        attempt_count: claim.attempt,
        conversa_id: null,
        lease,
      };

      try {
        const desfecho = await cleanupTurnClaim(handle);
        expect(desfecho, 'execução que sai SEM terminal devolve a posse').toBe('released');
        expect(releaseSpy).toHaveBeenCalledTimes(1);

        const depois = await turnRow(turn_id);
        // (1) FORENSE preservada: quem tinha o turno continua legível, e a lease
        //     vencida é o que autoriza o sucessor a reivindicar.
        expect(depois.claim_token).toBe(antes.claim_token);
        expect(depois.claimed_by).toBe(antes.claimed_by);
        expect((depois.lease_expires_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
        // (2) NENHUM desfecho declarado: estado, backoff e erro intactos — soltar
        //     a posse NÃO é "retry seguro".
        expect(depois.status).toBe(antes.status);
        expect(depois.next_attempt_at).toBe(antes.next_attempt_at);
        expect(depois.last_error_code).toBe(antes.last_error_code);
        expect(depois.outcome).toBe(antes.outcome);
        expect(depois.state_version).toBe(antes.state_version);
        expect(depois.attempt_count).toBe(antes.attempt_count);
        // (3) RUN durável intacto: `submission_unknown` continua sendo a única
        //     autoridade sobre o que já aconteceu.
        const depoisRun = await pool.query(`SELECT * FROM engine_runs WHERE id = $1`, [run_id]);
        expect(depoisRun.rows[0]).toEqual(antesRun.rows[0]);
        expect(depoisRun.rows[0]!.phase).toBe('submission_unknown');
        // (4) Só `lease_expires_at`/`updated_at` mudaram entre as duas leituras.
        const mudadas = Object.keys(depois).filter(
          (k) =>
            !['lease_expires_at', 'updated_at'].includes(k) &&
            String(depois[k]) !== String(antes[k]),
        );
        expect(mudadas, 'o cleanup da posse não pode escrever em mais nada').toEqual([]);
        // (5) Liberação intencional não é anomalia no sinal de perda.
        expect(await counterTotal('maia_turn_lease_lost_total')).toBe(perdidosAntes);
        expect(lease.lostReason).toBe('released');
      } finally {
        releaseSpy.mockRestore();
        await lease.settle();
      }
    },
    30_000,
  );

  itT(
    'AC05/AC04 — com terminal, o cleanup NÃO devolve a posse e AGUARDA a batida em voo',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const TTL = 8_000;
      const HEARTBEAT = 300;
      const { turn_id } = await mkTurn();
      const claim = await claimTurn(turn_id, TTL);
      // O CAS terminal LIMPA o token na mesma transação; aqui só o estado do
      // handle importa para a decisão, e o token some do banco. O `outcome` é
      // obrigatório por CHECK (`agent_turns_outcome_presence_chk`).
      await pool.query(
        `UPDATE agent_turns
            SET status = 'completed', outcome = 'reply_delivered', completed_at = now(),
                claim_token = NULL, lease_expires_at = NULL
          WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
        [T, A, turn_id],
      );

      const real = agentTurnsRepo.renewTurnLease.bind(agentTurnsRepo);
      let emVoo = 0;
      const spy = vi
        .spyOn(agentTurnsRepo, 'renewTurnLease')
        .mockImplementation(async (input: Parameters<typeof real>[0]) => {
          emVoo += 1;
          try {
            await sleep(150);
            return await real(input);
          } finally {
            emVoo -= 1;
          }
        });
      const releaseSpy = vi.spyOn(agentTurnsRepo, 'releaseTurnClaim');
      const perdidosAntes = await counterTotal('maia_turn_lease_lost_total');

      const lease = new TurnLease(claim, { ttl_ms: TTL, heartbeat_ms: HEARTBEAT });
      const handle: TurnHandle = {
        turn_id,
        status: 'completed',
        state_version: claim.state_version,
        attempt_count: claim.attempt,
        conversa_id: null,
        lease,
      };

      try {
        await waitFor(() => emVoo === 1, 'uma batida em voo');
        const desfecho = await cleanupTurnClaim(handle);
        expect(desfecho, 'turno terminal: nada a devolver, só o heartbeat a desligar').toBe(
          'stopped',
        );
        expect(emVoo, 'o encerramento terminal precisa AGUARDAR a batida em voo (AC04)').toBe(0);
        expect(releaseSpy, 'terminal não libera posse — não há posse').not.toHaveBeenCalled();
        // A recusa do CAS (turno terminal) NÃO pode virar `token_mismatch` falso.
        expect(lease.lostReason).toBeNull();
        expect(await counterTotal('maia_turn_lease_lost_total')).toBe(perdidosAntes);
      } finally {
        spy.mockRestore();
        releaseSpy.mockRestore();
        await lease.settle();
      }
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SC07-AC06 — tentativa canônica do PG, forense no release, e o token do
  //              originador não renova nada depois do takeover
  // ══════════════════════════════════════════════════════════════════════════

  itT(
    'AC06 — a tentativa canônica vem do PostgreSQL, não do transporte',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      const { turn_id } = await mkTurn();
      const primeira = await claimTurn(turn_id, 8_000, 'sc07-dono-1');
      const leaseMissao1 = new TurnLease(primeira, { ttl_ms: 8_000, heartbeat_ms: 400 });
      try {
        const r1 = await turnRow(turn_id);
        expect(primeira.attempt).toBe(Number(r1.attempt_count));
        expect(primeira.attempt).toBe(1);

        // Vence a lease no BANCO (sem sucessor, sem erro de conexão) e deixa o
        // SUCESSOR reivindicar: a tentativa é do banco, então vira 2.
        await pool.query(
          `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
          [T, A, turn_id],
        );
        const segunda = await claimTurn(turn_id, 8_000, 'sc07-dono-2');
        const r2 = await turnRow(turn_id);
        expect(segunda.attempt).toBe(2);
        expect(segunda.attempt).toBe(Number(r2.attempt_count));
        expect(segunda.worker_id).toBe('sc07-dono-2');
        expect(segunda.claim_token).toBe(r2.claim_token);
        expect(segunda.claim_token).not.toBe(primeira.claim_token);
      } finally {
        await leaseMissao1.settle();
      }
    },
    30_000,
  );

  itT(
    'AC06 — `release` preserva a forense e o sucessor reivindica na hora',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');

      const { turn_id } = await mkTurn();
      const claim1 = await claimTurn(turn_id, 60_000, 'sc07-forense');
      const lease = new TurnLease(claim1, { ttl_ms: 60_000, heartbeat_ms: 15_000 });
      await lease.release();

      const r = await turnRow(turn_id);
      expect(lease.alive).toBe(false);
      expect(lease.lostReason).toBe('released');
      // Forense: apagar `claimed_by`/`claim_token` fingiria que nunca houve dono.
      expect(r.claimed_by).toBe('sc07-forense');
      expect(r.claim_token).toBe(claim1.claim_token);
      expect((r.lease_expires_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
      // Devolver a posse ACELERA o sucessor em vez de custar um TTL inteiro.
      const claim2 = await claimTurn(turn_id, 60_000, 'sc07-sucessor');
      expect(claim2.attempt).toBe(claim1.attempt + 1);
    },
    30_000,
  );

  itT(
    'AC06 — o token do originador (callback) não renova nem estende a lease após o takeover',
    async () => {
      const { TurnLease } = await import('@/runtime/turns/lease.js');
      const { agentTurnsRepo } = await import('@/db/repositories/turn-repos.js');

      const { turn_id } = await mkTurn();
      const doOriginador = await claimTurn(turn_id, 60_000, 'sc07-origin');
      // Heartbeat CURTO de propósito: o dono antigo precisa BATER e descobrir a
      // perda dentro da janela do teste (a lease do banco continua de 60s).
      const leaseOriginador = new TurnLease(doOriginador, { ttl_ms: 60_000, heartbeat_ms: 200 });
      try {
        await pool.query(
          `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`,
          [T, A, turn_id],
        );
        const sucessor = await claimTurn(turn_id, 60_000, 'sc07-sucessor-2');
        expect(sucessor.claim_token).not.toBe(doOriginador.claim_token);
        const depoisDoTakeover = await turnRow(turn_id);

        // O "callback" do originador chega com o token ANTIGO: recusado, e — o que
        // importa — o vencimento do SUCESSOR não é tocado por ele.
        const tentativa = await inT(() =>
          agentTurnsRepo.renewTurnLease({
            turn_id,
            claim_token: doOriginador.claim_token,
            lease_ms: 60_000,
            statement_timeout_ms: 200,
          }),
        );
        expect(tentativa.ok, 'quem não é o dono vigente não renova').toBe(false);
        if (!tentativa.ok) expect(tentativa.reason).toBe('token_mismatch');

        const depois = await turnRow(turn_id);
        expect(
          (depois.heartbeat_at as Date).getTime(),
          'nenhum heartbeat por conta do originador',
        ).toBe((depoisDoTakeover.heartbeat_at as Date).getTime());
        expect((depois.lease_expires_at as Date).getTime()).toBe(
          (depoisDoTakeover.lease_expires_at as Date).getTime(),
        );
        expect(depois.claim_token).toBe(sucessor.claim_token);

        // E a lease do originador, quando a batida dela dispara, perde a posse e
        // PARA — sem renovar nada do sucessor.
        await waitFor(() => !leaseOriginador.alive, 'o originador perceber a perda');
        expect(leaseOriginador.lostReason).toBe('token_mismatch');
        expect((await turnRow(turn_id)).heartbeat_at as Date).toEqual(
          depoisDoTakeover.heartbeat_at as Date,
        );
      } finally {
        await leaseOriginador.settle();
      }
    },
    30_000,
  );
});

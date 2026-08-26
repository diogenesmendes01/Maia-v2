/**
 * Issue #504 — claim atômico, lease e fencing contra PostgreSQL REAL
 * (migrations 097 + 114).
 *
 * Por que nada aqui pode ser mock: o objeto sob teste é uma corrida entre
 * transações. O que decide o vencedor é o lock de row do Postgres e a
 * re-avaliação do WHERE depois do commit do concorrente (EvalPlanQual) — um
 * dublê de banco reproduziria a API e nenhuma dessas duas coisas, e passaria
 * feliz mesmo com um "SELECT elegível depois UPDATE" no lugar do UPDATE atômico.
 *
 * Entrada pelo REPOSITÓRIO de produção (`agentTurnsRepo`), não por SQL montado
 * aqui: um teste que reescrevesse a query com o próprio harness continuaria
 * verde depois de alguém deletar o método real.
 *
 * O que se prova:
 *   1. corrida de 2, 10 e 50 callers → EXATAMENTE um claim;
 *   2. o claim incrementa `attempt` uma vez e grava token/dono/lease juntos;
 *   3. só o dono renova; token velho é recusado;
 *   4. lease VENCIDA não se renova (worker que "revive" não retoma);
 *   5. takeover depois do vencimento, e o token muda;
 *   6. a tentativa antiga NÃO consegue concluir depois do takeover (fencing);
 *   7. o sucessor conclui normalmente;
 *   8. liberação explícita devolve o turno ao pool imediatamente;
 *   9. `retryable` com backoff no futuro não é reivindicável; vencido, é;
 *  10. `outbound_pending` não é tomável por lease vencida;
 *  11. isolamento cruzado: o turno do outro tenant é `not_found`.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED — `agents.id` é PK global e outras suítes semeiam a mesma base.
const T_A = 'claim504-tenant-a';
const A_A = 'claim504-agent-a';
const T_B = 'claim504-tenant-b';
const A_B = 'claim504-agent-b';

const LEASE_MS = 60_000;

let pool: pg.Pool;
const createdMensagens: string[] = [];

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, tenant, agent],
  );
  createdMensagens.push(id);
  return id;
}

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

/** Cria um turno `received` novo, pronto para ser reivindicado. */
async function freshTurn(tenant = T_A, agent = A_A): Promise<{ id: string; mensagem_id: string }> {
  const mensagem_id = await mkInbound(tenant, agent);
  const { agentTurnsRepo } = await loadRepos();
  const run = tenant === T_A ? inA : inB;
  const turn = await run(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: tenant,
      agent_id: agent,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return { id: turn.id, mensagem_id };
}

/** Empurra a lease do turno para o PASSADO, simulando um dono morto. */
async function expireLease(turn_id: string): Promise<void> {
  await pool.query(`UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
    turn_id,
  ]);
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

d('#504 — claim atômico / lease / fencing (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
  }, 30_000);

  afterAll(async () => {
    if (createdMensagens.length > 0) {
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [createdMensagens]);
    }
    // Tenants/agents também: outras suítes ENUMERAM agentes (readiness da saga
    // de onboarding, por exemplo) e um agente de teste esquecido na base vira
    // falha em suíte alheia — que é como um teste "verde" derruba o vizinho.
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_B]]);
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool.end();
  });

  // ─── 1. A corrida ─────────────────────────────────────────────────────────
  //
  // O caso central da issue. Rodado em três tamanhos porque a janela de corrida
  // muda de forma com a contenção: com 2 callers ela é rara, com 50 o lock de
  // row é disputado de verdade e um "SELECT depois UPDATE" quebra de imediato.
  for (const callers of [2, 10, 50]) {
    it(`${callers} workers disputando o MESMO turno → exatamente 1 claim`, async () => {
      const { agentTurnsRepo } = await loadRepos();
      const turn = await freshTurn();

      const results = await Promise.all(
        Array.from({ length: callers }, (_, i) =>
          inA(() =>
            agentTurnsRepo.claimNextEligibleTurn({
              turn_id: turn.id,
              worker_id: `worker-${i}`,
              lease_ms: LEASE_MS,
            }),
          ),
        ),
      );

      const winners = results.filter((r) => r.ok);
      expect(winners, `esperava exatamente 1 vencedor entre ${callers}`).toHaveLength(1);
      // Perder NÃO é erro nem "não existe": é a resposta correta para
      // "cheguei depois". Confundir com `not_found` esconderia bug de escopo.
      for (const r of results.filter((x) => !x.ok)) {
        expect(r.ok === false && r.reason).toBe('not_eligible');
      }

      // O banco concorda com quem venceu — a fonte de verdade é a row, não o
      // valor devolvido em memória.
      const row = await readTurn(turn.id);
      const winner = winners[0]!;
      expect(winner.ok).toBe(true);
      if (!winner.ok) return;
      expect(row.claim_token).toBe(winner.claim.claim_token);
      expect(row.claimed_by).toBe(winner.claim.worker_id);
      expect(row.status).toBe('claimed');

      // A tentativa foi contada UMA vez, não `callers` vezes: se cada tentativa
      // perdedora incrementasse, `MAX_TURN_ATTEMPTS` estouraria por contenção.
      expect(Number(row.attempt_count)).toBe(1);
    }, 60_000);
  }

  // ─── 2. O que o claim grava ───────────────────────────────────────────────
  it('o claim grava token, dono, claimed_at, heartbeat_at e lease ATOMICAMENTE', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claimed = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const row = await readTurn(turn.id);
    expect(row.status).toBe('claimed');
    expect(row.claim_token).toBeTruthy();
    expect(row.claimed_by).toBe('w1');
    expect(row.claimed_at).toBeTruthy();
    expect(row.heartbeat_at).toBeTruthy();
    expect(Number(row.attempt_count)).toBe(1);
    // A lease é medida pelo relógio do POSTGRES: se o UPDATE usasse
    // `Date.now()` do processo, um nó com clock skew abriria janela de takeover
    // falso. Comparamos contra `now()` do banco, não contra o daqui.
    const live = await pool.query(
      `SELECT lease_expires_at > now() AS live,
              lease_expires_at <= now() + interval '61 seconds' AS bounded
         FROM agent_turns WHERE id = $1`,
      [turn.id],
    );
    expect(live.rows[0].live).toBe(true);
    expect(live.rows[0].bounded).toBe(true);
  });

  it('um turno já reivindicado com lease VIVA não é reivindicável de novo', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    const second = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('not_eligible');
    expect(Number((await readTurn(turn.id)).attempt_count)).toBe(1);
  });

  // ─── 3-4. Heartbeat ───────────────────────────────────────────────────────
  it('só o DONO renova; um token velho é recusado', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claim = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const mine = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id: turn.id,
        claim_token: claim.claim.claim_token,
        lease_ms: LEASE_MS,
      }),
    );
    expect(mine.ok).toBe(true);

    const alien = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id: turn.id,
        claim_token: randomUUID(),
        lease_ms: LEASE_MS,
      }),
    );
    expect(alien.ok).toBe(false);
    expect(alien.ok === false && alien.reason).toBe('token_mismatch');
  });

  it('uma lease VENCIDA não se renova — o worker que "revive" não retoma a posse', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claim = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // O worker some (GC longo, partição de rede) e a lease vence. NINGUÉM
    // assumiu ainda — o token dele continua sendo o da row.
    await expireLease(turn.id);

    const revived = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id: turn.id,
        claim_token: claim.claim.claim_token,
        lease_ms: LEASE_MS,
      }),
    );
    // O token casa e ainda assim a renovação é recusada: a posse não volta
    // sozinha só porque o sucessor ainda não chegou.
    expect(revived.ok).toBe(false);
    expect(revived.ok === false && revived.reason).toBe('token_mismatch');
  });

  // ─── 5-7. Takeover e fencing ──────────────────────────────────────────────
  it('takeover depois do vencimento: novo dono, novo token, nova tentativa', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const first = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await expireLease(turn.id);

    const second = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.claim.claim_token).not.toBe(first.claim.claim_token);
    expect(second.claim.worker_id).toBe('w2');
    expect(second.claim.attempt).toBe(2);
  });

  it('a tentativa ANTIGA não consegue concluir depois do takeover (fencing)', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const zombie = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(zombie.ok).toBe(true);
    if (!zombie.ok) return;
    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id: turn.id,
        expected_claim_token: zombie.claim.claim_token,
        bump_attempt: false,
      }),
    );

    // O worker lento perde a lease e o sucessor assume.
    await expireLease(turn.id);
    const successor = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    // O sucessor leva o turno de volta a `running` com o SEU token. Este passo
    // é o que torna o caso uma prova do FENCE e não outra coisa: sem ele o
    // turno ficaria em `claimed`, a gravação do zumbi seria barrada pelo estado
    // de origem (`completed` só sai de `running`/`outbound_pending`) e o caso
    // passaria mesmo com o compare-and-set do token removido. Agora o estado é
    // válido e a lease está VIVA (é a do sucessor) — a ÚNICA coisa que separa o
    // zumbi da gravação é o token.
    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id: turn.id,
        expected_claim_token: successor.claim.claim_token,
        bump_attempt: false,
      }),
    );

    // ...e AGORA o zumbi termina seu trabalho e tenta gravar. É esta linha que
    // a issue existe para tornar impossível.
    const late = await inA(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id: turn.id,
        outcome: 'reply_delivered',
        expected_claim_token: zombie.claim.claim_token,
      }),
    );
    expect(late.ok).toBe(false);
    // `stale_claim`, e não `state_mismatch`: a reação a um é PARAR, a do outro é
    // reler e tentar de novo. Trocar os dois faria o zumbi insistir.
    expect(late.ok === false && late.conflict).toBe('stale_claim');

    // O turno NÃO foi concluído por ele, e a projeção legada não foi carimbada.
    const row = await readTurn(turn.id);
    expect(row.status).not.toBe('completed');
    const projected = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [
      turn.mensagem_id,
    ]);
    expect(projected.rows[0].processada_em).toBeNull();
  });

  it('o SUCESSOR, com o token vigente, conclui normalmente', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const first = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(first.ok).toBe(true);
    await expireLease(turn.id);
    const second = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id: turn.id,
        expected_claim_token: second.claim.claim_token,
        bump_attempt: false,
      }),
    );
    const done = await inA(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id: turn.id,
        outcome: 'reply_delivered',
        expected_claim_token: second.claim.claim_token,
      }),
    );
    expect(done.ok).toBe(true);

    const row = await readTurn(turn.id);
    expect(row.status).toBe('completed');
    // A posse morre com a tentativa: um turno terminal não pode continuar
    // aparecendo como "de alguém" nem cair na varredura de lease vencida.
    expect(row.claim_token).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('sem token, uma gravação NÃO é fenced — é o kill switch da flag', async () => {
    // Prova que o caminho legado (#503) continua funcionando com a flag OFF: o
    // fence só existe quando o caller passa o token.
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    await inA(() => agentTurnsRepo.markClaimed({ turn_id: turn.id }));
    await inA(() => agentTurnsRepo.markRunning({ turn_id: turn.id }));
    const done = await inA(() =>
      agentTurnsRepo.completeTurnTx({ turn_id: turn.id, outcome: 'reply_delivered' }),
    );
    expect(done.ok).toBe(true);
  });

  // ─── 8. Liberação explícita ───────────────────────────────────────────────
  it('liberar a posse devolve o turno ao pool NA HORA, sem esperar o TTL', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claim = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const released = await inA(() =>
      agentTurnsRepo.releaseTurnClaim({
        turn_id: turn.id,
        claim_token: claim.claim.claim_token,
      }),
    );
    expect(released.released).toBe(true);

    // Sucessor reivindica imediatamente...
    const next = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(next.ok).toBe(true);

    // ...e quem liberou perde o direito de escrever no mesmo instante.
    const late = await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id: turn.id,
        expected_claim_token: claim.claim.claim_token,
        bump_attempt: false,
      }),
    );
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.conflict).toBe('stale_claim');
  });

  // ─── 9-10. Elegibilidade por estado ───────────────────────────────────────
  it('`retryable` só é reivindicável quando o backoff VENCEU', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    await inA(() => agentTurnsRepo.markClaimed({ turn_id: turn.id }));
    await inA(() => agentTurnsRepo.markRunning({ turn_id: turn.id }));
    await inA(() =>
      agentTurnsRepo.markRetryable({
        turn_id: turn.id,
        next_attempt_at: new Date(Date.now() + 3_600_000),
        error_code: 'reasoner_failed',
        error_summary: null,
      }),
    );

    const tooEarly = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(tooEarly.ok).toBe(false);
    expect(tooEarly.ok === false && tooEarly.reason).toBe('not_eligible');

    await pool.query(`UPDATE agent_turns SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [
      turn.id,
    ]);
    const due = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    // `retryable -> claimed` DIRETO: o claim tem predicado próprio e não passa
    // pela tabela de transições (que exigiria o desvio por `queued`).
    expect(due.ok).toBe(true);
  });

  it('`outbound_pending` NÃO é tomável nem com a lease vencida', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claim = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id: turn.id,
        expected_claim_token: claim.claim.claim_token,
        bump_attempt: false,
      }),
    );
    await inA(() =>
      agentTurnsRepo.markOutboundCommittedTx({
        turn_id: turn.id,
        outbound_message_id: randomUUID(),
        expected_claim_token: claim.claim.claim_token,
      }),
    );
    await expireLease(turn.id);

    const taken = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    // A resposta já foi comprometida: uma segunda execução do ReAct a
    // duplicaria. Quem finaliza é o outbox (#506), nunca um takeover.
    expect(taken.ok).toBe(false);
    expect(taken.ok === false && taken.reason).toBe('not_eligible');
  });

  // ─── 11. Isolamento ───────────────────────────────────────────────────────
  it('o turno do tenant A é invisível para o tenant B (not_found, não not_eligible)', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn(T_A, A_A);

    const alien = await inB(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'wB', lease_ms: LEASE_MS }),
    );
    expect(alien.ok).toBe(false);
    // `not_found` e não `not_eligible`: o turno não EXISTE naquele escopo. A
    // distinção é o que faz um bug de roteamento aparecer como bug de
    // roteamento, em vez de se esconder como corrida perdida.
    expect(alien.ok === false && alien.reason).toBe('not_found');

    // E a row não foi tocada por ninguém.
    const row = await readTurn(turn.id);
    expect(row.claim_token).toBeNull();
    expect(Number(row.attempt_count)).toBe(0);

    // Renovação e liberação cruzadas também falham.
    const claim = await inA(() =>
      agentTurnsRepo.claimNextEligibleTurn({ turn_id: turn.id, worker_id: 'wA', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const alienRenew = await inB(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id: turn.id,
        claim_token: claim.claim.claim_token,
        lease_ms: LEASE_MS,
      }),
    );
    expect(alienRenew.ok).toBe(false);
    const alienRelease = await inB(() =>
      agentTurnsRepo.releaseTurnClaim({
        turn_id: turn.id,
        claim_token: claim.claim.claim_token,
      }),
    );
    expect(alienRelease.released).toBe(false);
  });
});

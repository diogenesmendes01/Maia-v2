/**
 * Issue #504 — claim atômico, lease e fencing contra Postgres REAL
 * (migrations 096/097/108).
 *
 * ESTA SUÍTE É A ÚNICA EVIDÊNCIA POSSÍVEL. Concorrência entre réplicas não é
 * verificável com mock: um teste unitário só pode provar que chamamos o
 * repositório, nunca que o PostgreSQL serializou duas escritas simultâneas.
 * Tudo aqui é sobre o que o BANCO garante.
 *
 * Cobertura:
 *  1. corrida de 2, 10 e 50 callers em `tryClaimTurn` — exatamente UM vence;
 *  2. o claim incrementa `attempt` e grava o trio de posse atomicamente;
 *  3. o dono renova; o token ANTIGO não renova;
 *  4. lease VENCIDA não é renovável (nada de retomada implícita);
 *  5. takeover depois da expiração — e a tentativa antiga não consegue mais
 *     concluir o turno (`stale_claim`);
 *  6. transição terminal DEVOLVE a posse no mesmo UPDATE;
 *  7. `retryable` com backoff pendente não é reivindicável; vencido, é;
 *  8. `outbound_pending` e terminais NUNCA são reivindicáveis;
 *  9. órfão pré-#504 (claimed sem lease, parado) é adotado;
 * 10. isolamento cruzado: o turno de outro tenant/agent é invisível ao claim;
 * 11. a CHECK do trio impede meia-posse;
 * 12. `findScopeByIdCrossTenant` devolve o escopo sem ALS.
 *
 * Skipped sem TEST_DB_URL (a lane unit-only passa sem Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

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
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL, now())`,
    [id, tenant, agent],
  );
  createdMensagens.push(id);
  return id;
}

/** Cria um turno em `received` para um inbound novo e devolve o id do turno. */
async function mkTurn(tenant = T_A, agent = A_A): Promise<string> {
  const { agentTurnsRepo } = await loadRepos();
  const mensagem_id = await mkInbound(tenant, agent);
  const turn = await runWithTenantContext({ tenant_id: tenant, agent_id: agent }, () =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: tenant,
      agent_id: agent,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return turn.id;
}

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

/** Envelhece a lease de um turno para simular um dono morto. */
async function expireLease(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
}

d('#504 — claim/lease/fencing contra DB real', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
  });

  afterAll(async () => {
    if (createdMensagens.length > 0) {
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [createdMensagens]);
    }
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_B]]);
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool.end();
  });

  // ── (1) A propriedade central: exatamente um vencedor ────────────────────
  for (const racers of [2, 10, 50]) {
    it(`(1) ${racers} workers disputam o MESMO turno — exatamente um vence`, async () => {
      const { agentTurnsRepo } = await loadRepos();
      const turn_id = await mkTurn();

      const results = await Promise.all(
        Array.from({ length: racers }, (_, i) =>
          inA(() =>
            agentTurnsRepo.tryClaimTurn({
              turn_id,
              worker_id: `racer-${i}:${process.pid}`,
              lease_ms: LEASE_MS,
            }),
          ),
        ),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      // Todos os perdedores enxergam a posse viva — nenhum "não encontrado".
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.ok).toBe(false);
        if (!loser.ok) expect(loser.reason).toBe('lease_active');
      }
      // E a tentativa canônica subiu EXATAMENTE uma vez, mesmo com 50
      // concorrentes: se o UPDATE não fosse o único ponto de decisão, o
      // contador teria contado tentativas que nunca existiram.
      const row = await readTurn(turn_id);
      expect(Number(row.attempt_count)).toBe(1);
    });
  }

  it('(2) o claim grava o TRIO de posse e o estado, atomicamente', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const res = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    expect(res.ok).toBe(true);
    const row = await readTurn(turn_id);
    expect(row.status).toBe('claimed');
    expect(row.claimed_by).toBe('w1:1');
    expect(row.claim_token).toBeTruthy();
    expect(row.lease_expires_at).toBeTruthy();
    expect(row.heartbeat_at).toBeTruthy();
    expect(Number(row.attempt_count)).toBe(1);
    expect(Number(row.state_version)).toBe(1);
    // O relógio é o do PostgreSQL — a lease vence no futuro segundo o BANCO.
    const alive = await pool.query(
      `SELECT lease_expires_at > now() AS alive FROM agent_turns WHERE id = $1`,
      [turn_id],
    );
    expect(alive.rows[0].alive).toBe(true);
  });

  // ── (3)(4) Heartbeat ─────────────────────────────────────────────────────
  it('(3) o DONO renova; o token ANTIGO não', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const first = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const renewed = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id,
        claim_token: first.claim.claim_token,
        worker_id: 'w1:1',
        lease_ms: LEASE_MS,
      }),
    );
    expect(renewed.ok).toBe(true);

    // Takeover: o dono morre, a lease vence, outro assume.
    await expireLease(turn_id);
    const second = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w2:2', lease_ms: LEASE_MS }),
    );
    expect(second.ok).toBe(true);

    // O ZUMBI tenta renovar com o token velho: recusado. Sem isto, um worker
    // pausado por GC empurraria a lease do sucessor para frente.
    const zombie = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id,
        claim_token: first.claim.claim_token,
        worker_id: 'w1:1',
        lease_ms: LEASE_MS,
      }),
    );
    expect(zombie).toEqual({ ok: false, reason: 'lost' });
  });

  it('(4) lease VENCIDA não é renovável — nada de retomada implícita', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const claim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    if (!claim.ok) throw new Error('claim inicial falhou');
    await expireLease(turn_id);

    // O dono ORIGINAL recupera conectividade e tenta renovar. Ninguém assumiu
    // ainda — e mesmo assim a renovação é recusada: o turno voltou ao pool, e
    // ressuscitar a posse por baixo de um possível sucessor é a corrida que o
    // fencing existe para impedir.
    const late = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id,
        claim_token: claim.claim.claim_token,
        worker_id: 'w1:1',
        lease_ms: LEASE_MS,
      }),
    );
    expect(late).toEqual({ ok: false, reason: 'lost' });
  });

  // ── (5) O cenário que a issue existe para fechar ─────────────────────────
  it('(5) a tentativa ANTIGA não conclui o turno depois do takeover', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const first = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'slow:1', lease_ms: LEASE_MS }),
    );
    if (!first.ok) throw new Error('claim inicial falhou');
    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id,
        expected_claim_token: first.claim.claim_token,
        bump_attempt: false,
      }),
    );

    await expireLease(turn_id);
    const second = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'fast:2', lease_ms: LEASE_MS }),
    );
    if (!second.ok) throw new Error('takeover falhou');

    // O worker lento acorda e tenta declarar sucesso. RECUSADO, e classificado
    // como fencing — não como corrida de estado benigna.
    const late = await inA(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id,
        outcome: 'reply_delivered',
        expected_claim_token: first.claim.claim_token,
      }),
    );
    expect(late.ok).toBe(false);
    expect(late).toMatchObject({ conflict: 'stale_claim' });
    if (!late.ok && late.conflict === 'stale_claim') {
      expect(late.current_claimed_by).toBe('fast:2');
    }
    // O turno NÃO ficou completed por causa do zumbi.
    expect((await readTurn(turn_id)).status).not.toBe('completed');

    // O dono ATUAL conclui normalmente.
    const ok = await inA(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id,
        outcome: 'reply_delivered',
        expected_claim_token: second.claim.claim_token,
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it('(6) a transição terminal DEVOLVE a posse no MESMO UPDATE', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const claim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    if (!claim.ok) throw new Error('claim falhou');
    await inA(() =>
      agentTurnsRepo.markRunning({
        turn_id,
        expected_claim_token: claim.claim.claim_token,
        bump_attempt: false,
      }),
    );
    await inA(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id,
        outcome: 'reply_delivered',
        expected_claim_token: claim.claim.claim_token,
      }),
    );
    const row = await readTurn(turn_id);
    expect(row.status).toBe('completed');
    // Sem esta propriedade existiria uma janela em que o turno já é terminal e
    // ainda parece possuído — e um sweep que rodasse ali tomaria posse dele.
    expect(row.claimed_by).toBeNull();
    expect(row.claim_token).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('(6b) `retryable` também devolve a posse — a tentativa acabou', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    const claim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    if (!claim.ok) throw new Error('claim falhou');
    await inA(() =>
      agentTurnsRepo.markRetryable({
        turn_id,
        next_attempt_at: new Date(Date.now() + 60_000),
        error_code: 'boom',
        error_summary: null,
        expected_claim_token: claim.claim.claim_token,
      }),
    );
    const row = await readTurn(turn_id);
    expect(row.status).toBe('retryable');
    expect(row.claim_token).toBeNull();
  });

  // ── (7)(8) Elegibilidade ─────────────────────────────────────────────────
  it('(7) `retryable` só é reivindicável com o backoff VENCIDO', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    await pool.query(
      `UPDATE agent_turns SET status='retryable', next_attempt_at = now() + interval '10 minutes' WHERE id=$1`,
      [turn_id],
    );
    const early = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('backoff_pending');

    await pool.query(
      `UPDATE agent_turns SET next_attempt_at = now() - interval '1 second' WHERE id=$1`,
      [turn_id],
    );
    const due = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    expect(due.ok).toBe(true);
    // O claim limpa `next_attempt_at`: a tentativa está em curso, não agendada.
    expect((await readTurn(turn_id)).next_attempt_at).toBeNull();
  });

  it('(8) `outbound_pending` e terminais NUNCA são reivindicáveis', async () => {
    const { agentTurnsRepo } = await loadRepos();
    for (const [status, outcome] of [
      ['outbound_pending', null],
      ['completed', 'reply_delivered'],
      ['dead_letter', 'retry_exhausted'],
      ['ignored', 'blocked_by_policy'],
      ['superseded', 'merged_into_turn'],
    ] as const) {
      const turn_id = await mkTurn();
      await pool.query(`UPDATE agent_turns SET status=$2, outcome=$3 WHERE id=$1`, [
        turn_id,
        status,
        outcome,
      ]);
      const res = await inA(() =>
        agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
      );
      expect(res.ok, `status ${status} não pode ser reivindicado`).toBe(false);
      if (!res.ok) expect(res.reason).toBe('not_claimable');
    }
  });

  it('(9) órfão pré-#504 (claimed SEM lease, parado) é adotado', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn();
    // Exatamente o que `markClaimed` de #503 deixava: estado sem posse.
    await pool.query(
      `UPDATE agent_turns SET status='claimed', updated_at = now() - interval '1 hour' WHERE id=$1`,
      [turn_id],
    );
    const res = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    expect(res.ok).toBe(true);

    // Mas um `claimed` sem lease RECÉM-atualizado NÃO é adotado: é a janela de
    // deploy rolling em que uma réplica antiga ainda pode estar executando.
    const fresh_id = await mkTurn();
    await pool.query(
      `UPDATE agent_turns SET status='claimed', claimed_by=NULL, claim_token=NULL,
              lease_expires_at=NULL, updated_at = now() WHERE id=$1`,
      [fresh_id],
    );
    const refused = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: fresh_id, worker_id: 'w2:2', lease_ms: LEASE_MS }),
    );
    expect(refused.ok).toBe(false);
  });

  // ── (10) Isolamento ──────────────────────────────────────────────────────
  it('(10) o claim é INVISÍVEL para outro tenant/agent', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn(T_A, A_A);

    const foreign = await inB(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'intruso:1', lease_ms: LEASE_MS }),
    );
    expect(foreign).toEqual({ ok: false, reason: 'not_found' });
    expect((await readTurn(turn_id)).status).toBe('received');

    // Renovação e liberação também são cegas fora do escopo.
    const claim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id, worker_id: 'w1:1', lease_ms: LEASE_MS }),
    );
    if (!claim.ok) throw new Error('claim falhou');
    await expect(
      inB(() =>
        agentTurnsRepo.renewTurnLease({
          turn_id,
          claim_token: claim.claim.claim_token,
          worker_id: 'w1:1',
          lease_ms: LEASE_MS,
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'lost' });
    await expect(
      inB(() =>
        agentTurnsRepo.releaseTurnLease({ turn_id, claim_token: claim.claim.claim_token }),
      ),
    ).resolves.toEqual({ released: false });
    // A posse do tenant A permanece intacta.
    expect((await readTurn(turn_id)).claimed_by).toBe('w1:1');
  });

  it('(11) a CHECK do trio impede meia-posse', async () => {
    const turn_id = await mkTurn();
    await expect(
      pool.query(`UPDATE agent_turns SET claimed_by = 'w1:1' WHERE id = $1`, [turn_id]),
    ).rejects.toThrow(/agent_turns_claim_trio_chk/);
    await expect(
      pool.query(`UPDATE agent_turns SET claim_token = gen_random_uuid() WHERE id = $1`, [turn_id]),
    ).rejects.toThrow(/agent_turns_claim_trio_chk/);
  });

  it('(12) `findScopeByIdCrossTenant` resolve o escopo SEM contexto de tenant', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn_id = await mkTurn(T_B, A_B);
    // Sem ALS: é a leitura de ENTRY POINT do job V2.
    const scope = await agentTurnsRepo.findScopeByIdCrossTenant(turn_id);
    expect(scope).toMatchObject({ turn_id, tenant_id: T_B, agent_id: A_B });
    expect(await agentTurnsRepo.findScopeByIdCrossTenant(randomUUID())).toBeNull();
  });

  it('(13) o recovery ENXERGA a lease vencida e IGNORA a viva', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const alive_id = await mkTurn();
    const dead_id = await mkTurn();
    await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: alive_id, worker_id: 'vivo:1', lease_ms: LEASE_MS }),
    );
    await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: dead_id, worker_id: 'morto:1', lease_ms: LEASE_MS }),
    );
    await expireLease(dead_id);

    const candidates = await inA(() => agentTurnsRepo.findRecoverableTurns(60_000, 500));
    const ids = candidates.map((c) => c.turn.id);
    expect(ids).toContain(dead_id);
    expect(ids).not.toContain(alive_id);
    expect(candidates.find((c) => c.turn.id === dead_id)?.reason).toBe('lease_expired');
  });
});

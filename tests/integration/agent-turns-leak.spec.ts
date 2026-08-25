/**
 * Issue #503 — suíte de LEAK cross-tenant da máquina de estados do turno.
 *
 * Faz parte de `npm run test:leak`: qualquer método de `agentTurnsRepo` que
 * perca o filtro `tenant_id + agent_id` no WHERE quebra aqui. A cobertura é
 * método a método (leitura, escrita e as duas enumerações cross-tenant), porque
 * o vetor real de vazamento é "alguém adiciona um método novo e esquece o
 * escopo" — não uma falha de constraint.
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

// Ids NAMESPACED — `agents.id` é PK global.
const T_A = 'turnsleak-tenant-a';
const A_A = 'turnsleak-agent-a';
const T_B = 'turnsleak-tenant-b';
const A_B = 'turnsleak-agent-b';

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

async function mkInbound(tenant: string, agent: string, ageMs = 0): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL, now() - ($4 || ' milliseconds')::interval)`,
    [id, tenant, agent, String(ageMs)],
  );
  createdMensagens.push(id);
  return id;
}

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

d('agent turns — leak suite cross-tenant', () => {
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

  it('leitura: nenhum método enxerga turno de outro par (tenant, agent)', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgB = await mkInbound(T_B, A_B);
    const turnB = await inB(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: T_B,
        agent_id: A_B,
        conversa_id: null,
        channel_id: null,
      }),
    );

    expect(await inA(() => agentTurnsRepo.findById(turnB.id))).toBeNull();
    expect(await inA(() => agentTurnsRepo.findTurnByMessage(msgB))).toBeNull();
    expect(await inA(() => agentTurnsRepo.listTurnInputs(turnB.id))).toEqual([]);

    // ...e o dono continua enxergando.
    expect((await inB(() => agentTurnsRepo.findById(turnB.id)))?.id).toBe(turnB.id);
    expect((await inB(() => agentTurnsRepo.findTurnByMessage(msgB)))?.id).toBe(turnB.id);
    expect(await inB(() => agentTurnsRepo.listTurnInputs(turnB.id))).toHaveLength(1);
  });

  it('escrita: nenhuma transição alcança turno de outro par', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgB = await mkInbound(T_B, A_B);
    const turnB = await inB(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: T_B,
        agent_id: A_B,
        conversa_id: null,
        channel_id: null,
      }),
    );
    const v = Number(turnB.state_version);

    for (const attempt of [
      () => agentTurnsRepo.markQueued({ turn_id: turnB.id, expected_version: v }),
      () => agentTurnsRepo.markClaimed({ turn_id: turnB.id, expected_version: v }),
      () => agentTurnsRepo.markRunning({ turn_id: turnB.id, expected_version: v }),
      () =>
        agentTurnsRepo.markIgnored({
          turn_id: turnB.id,
          outcome: 'blocked_by_policy',
          expected_version: v,
        }),
      () =>
        agentTurnsRepo.completeTurnTx({
          turn_id: turnB.id,
          outcome: 'reply_delivered',
          expected_version: v,
        }),
      () => agentTurnsRepo.markSupersededSelf({ turn_id: turnB.id, expected_version: v }),
      () =>
        agentTurnsRepo.markSupersededByAbsorber({
          turn_id: turnB.id,
          absorbed_by_turn_id: turnB.id,
          expected_version: v,
        }),
      () =>
        agentTurnsRepo.markRetryable({
          turn_id: turnB.id,
          next_attempt_at: new Date(),
          error_code: 'x',
          error_summary: null,
          expected_version: v,
        }),
      () =>
        agentTurnsRepo.markDeadLetter({
          turn_id: turnB.id,
          outcome: 'retry_exhausted',
          error_code: 'x',
          error_summary: null,
          expected_version: v,
        }),
    ]) {
      const result = await inA(attempt);
      expect(result).toMatchObject({ ok: false, conflict: 'not_found' });
    }

    // Estado do dono INTACTO após todas as tentativas.
    const after = await inB(() => agentTurnsRepo.findById(turnB.id));
    expect(after?.status).toBe('received');
    expect(Number(after?.state_version)).toBe(v);
  });

  // Issue #504 — as três primitivas de POSSE. Estão aqui, e não só na suíte de
  // claim, porque é esta suíte que roda em `npm run test:leak` e é ela que pega
  // "alguém acrescentou um método e esqueceu o escopo". Um claim sem
  // `tenant_id + agent_id` no WHERE seria a pior variante do vazamento: não só
  // leitura, mas TOMADA DE POSSE de trabalho de outro tenant.
  it('posse: claim, heartbeat e liberação não alcançam turno de outro par', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgB = await mkInbound(T_B, A_B);
    const turnB = await inB(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: T_B,
        agent_id: A_B,
        conversa_id: null,
        channel_id: null,
      }),
    );

    // A não consegue reivindicar o turno de B.
    const alienClaim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: turnB.id, worker_id: 'wA', lease_ms: 60_000 }),
    );
    expect(alienClaim).toMatchObject({ ok: false, reason: 'not_found' });

    // O dono reivindica...
    const owned = await inB(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: turnB.id, worker_id: 'wB', lease_ms: 60_000 }),
    );
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;

    // ...e A, mesmo DE POSSE DO TOKEN (o pior caso: token vazado por log ou
    // por um payload malformado), não renova nem libera fora do escopo dele.
    const alienRenew = await inA(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id: turnB.id,
        claim_token: owned.claim.claim_token,
        lease_ms: 60_000,
      }),
    );
    expect(alienRenew).toMatchObject({ ok: false });
    const alienRelease = await inA(() =>
      agentTurnsRepo.releaseTurnClaim({
        turn_id: turnB.id,
        claim_token: owned.claim.claim_token,
      }),
    );
    expect(alienRelease).toEqual({ released: false });

    // A posse do dono seguiu intacta.
    const after = await inB(() => agentTurnsRepo.findById(turnB.id));
    expect(after?.claimed_by).toBe('wB');
    expect(after?.claim_token).toBe(owned.claim.claim_token);
  });

  it('recovery: findRecoverableTurns só devolve turnos do par corrente', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const stale = 60_000;
    const msgA = await mkInbound(T_A, A_A, stale * 5);
    const msgB = await mkInbound(T_B, A_B, stale * 5);
    const turnA = await inA(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgA,
        tenant_id: T_A,
        agent_id: A_A,
        conversa_id: null,
        channel_id: null,
      }),
    );
    const turnB = await inB(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: T_B,
        agent_id: A_B,
        conversa_id: null,
        channel_id: null,
      }),
    );
    // `created_at` do TURNO é now(); envelhecemos para casar o cutoff.
    await pool.query(
      `UPDATE agent_turns SET created_at = now() - interval '10 minutes' WHERE id = ANY($1::uuid[])`,
      [[turnA.id, turnB.id]],
    );

    const forA = await inA(() => agentTurnsRepo.findRecoverableTurns(stale, 100));
    expect(forA.map((r) => r.turn.id)).toContain(turnA.id);
    expect(forA.map((r) => r.turn.id)).not.toContain(turnB.id);
    for (const r of forA) {
      expect(r.turn.tenant_id).toBe(T_A);
      expect(r.turn.agent_id).toBe(A_A);
    }
  });

  it('divergência legado: countLegacyProjectionMismatch conta só o par corrente', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgB = await mkInbound(T_B, A_B);
    const turnB = await inB(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: T_B,
        agent_id: A_B,
        conversa_id: null,
        channel_id: null,
      }),
    );
    // Divergência PLANTADA no tenant B: `processada_em` preenchido com turno
    // ainda não-terminal.
    await pool.query(`UPDATE mensagens SET processada_em = now() WHERE id = $1`, [msgB]);
    expect(turnB.status).toBe('received');

    const fromB = await inB(() => agentTurnsRepo.countLegacyProjectionMismatch());
    expect(fromB.projection_without_terminal).toBeGreaterThanOrEqual(1);

    const fromA = await inA(() => agentTurnsRepo.countLegacyProjectionMismatch());
    // A divergência de B NÃO pode aparecer na contagem de A.
    expect(fromA.projection_without_terminal).toBe(0);
  });

  it('enumerações cross-tenant devolvem o PAR, nunca linhas de outro tenant', async () => {
    const { agentTurnsRepo } = await loadRepos();
    // Estes dois métodos rodam FORA de contexto (são dispatchers). O contrato
    // é: devolvem apenas o par (tenant_id, agent_id) — nunca payload de row —
    // e o inner é sempre executado dentro de runWithTenantContext.
    const pairs = await agentTurnsRepo.listTenantAgentPairsWithRecoverableTurns(1);
    for (const p of pairs) {
      expect(Object.keys(p).sort()).toEqual(['agent_id', 'tenant_id']);
    }
    const pending = await agentTurnsRepo.listTenantAgentPairsPendingBackfill();
    for (const p of pending) {
      expect(Object.keys(p).sort()).toEqual(['agent_id', 'pending', 'tenant_id']);
    }
  });
});

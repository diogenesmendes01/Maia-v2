/**
 * Issue #504 (decisão do dono) — a ABSORÇÃO DE IRMÃO contra PostgreSQL REAL
 * (migrations 097 + 114).
 *
 * `markSuperseded` era uma operação só, sem fence nenhum. Agora são duas, com
 * regras opostas, e as duas só se provam contra banco de verdade:
 *
 *   - `markSupersededByAbsorber` — o fence é do ABSORVEDOR (token + lease
 *     VIVA, verificados na mesma declaração) e o compare-and-swap é na linha do
 *     IRMÃO. O irmão NÃO precisa de claim, e normalmente não tem nenhum.
 *   - `markSupersededSelf` — o turno declara a si mesmo absorvido, e aí o fence
 *     é o do próprio turno, como em toda outra transição terminal.
 *
 * Por que nada aqui pode ser mock: as três garantias são propriedades do
 * PostgreSQL, não da API. `lease_expires_at > now()` é o relógio DO BANCO; a
 * corrida entre duas absorções é decidida pelo lock de row e pela reavaliação
 * do WHERE depois do commit do concorrente (EvalPlanQual); e a projeção legada
 * `mensagens.processada_em` acontece na MESMA transação do CAS. Um dublê
 * reproduziria a assinatura e nenhuma das três.
 *
 * Entrada pelo REPOSITÓRIO de produção (`agentTurnsRepo`) — um harness que
 * remontasse o UPDATE continuaria verde depois de alguém deletar o método real.
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

const T_A = 'absorb504-tenant-a';
const A_A = 'absorb504-agent-a';

const LEASE_MS = 60_000;

let pool: pg.Pool;
const createdMensagens: string[] = [];

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);

async function mkInbound(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, T_A, A_A],
  );
  createdMensagens.push(id);
  return id;
}

/** Turno `received` novo — o estado em que uma irmã do debounce nasce. */
async function freshTurn(): Promise<{ id: string; state_version: number; mensagem_id: string }> {
  const mensagem_id = await mkInbound();
  const { agentTurnsRepo } = await loadRepos();
  const turn = await inA(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T_A,
      agent_id: A_A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return { id: turn.id, state_version: Number(turn.state_version), mensagem_id };
}

/** Turno reivindicado com lease viva — o ABSORVEDOR da rajada. */
async function claimedTurn(): Promise<{ id: string; claim_token: string }> {
  const { agentTurnsRepo } = await loadRepos();
  const turn = await freshTurn();
  const claim = await inA(() =>
    agentTurnsRepo.tryClaimTurn({ turn_id: turn.id, worker_id: 'absorvedor', lease_ms: LEASE_MS }),
  );
  if (!claim.ok) throw new Error('setup: o claim do absorvedor deveria ter sido concedido');
  return { id: turn.id, claim_token: claim.claim.claim_token };
}

async function expireLease(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

d('#504 — absorção de irmão: o fence pertence a quem absorve (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
      T_A,
    ]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [A_A, T_A],
    );
  }, 30_000);

  afterAll(async () => {
    if (createdMensagens.length > 0) {
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [createdMensagens]);
    }
    await pool.query(`DELETE FROM agents WHERE id = $1`, [A_A]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [T_A]);
    await pool.end();
  });

  // ─── SONDA 2 — o irmão NÃO precisa de claim ───────────────────────────────
  //
  // O caso NORMAL, e o que qualquer fence sobre o irmão quebraria: o turno
  // absorvido nunca foi reivindicado (`claim_token IS NULL`), porque quem foi
  // reivindicado foi o executor da rajada.
  it('absorve um irmão SEM claim nenhum — o caso normal do debounce', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    // Pré-condição explícita: o irmão não tem posse alguma.
    expect((await readTurn(sibling.id))['claim_token']).toBeNull();

    const r = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: absorber.claim_token,
        expected_version: sibling.state_version,
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.status).toBe('superseded');
      expect(r.turn.outcome).toBe('merged_into_turn');
      expect(r.turn.superseded_by_turn_id).toBe(absorber.id);
    }
    // Terminal ⇒ a projeção legada foi escrita na MESMA transação.
    const msg = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [
      sibling.mensagem_id,
    ]);
    expect(msg.rows[0].processada_em).not.toBeNull();
  });

  // ─── SONDA 1 — a lease do ABSORVEDOR ──────────────────────────────────────
  it('absorvedor com lease VENCIDA não absorve — e o resultado é `stale_claim`', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    // O zumbi: ainda porta um token que CASA com a linha, mas a lease morreu.
    // Só o token nunca foi suficiente, e é este caso que prova por quê.
    await expireLease(absorber.id);

    const r = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: absorber.claim_token,
        expected_version: sibling.state_version,
      }),
    );

    expect(r.ok).toBe(false);
    // `stale_claim`, e NÃO `state_mismatch`: a reação correta é PARAR, não
    // reler e reinsistir. Confundir os dois transforma o fence numa sugestão.
    expect(r.ok === false && r.conflict).toBe('stale_claim');
    // E o irmão continua intacto e executável.
    const row = await readTurn(sibling.id);
    expect(row['status']).toBe('received');
    expect(row['superseded_by_turn_id']).toBeNull();
  });

  it('absorvedor com token VELHO (sucedido por outro worker) não absorve', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    // Takeover: a lease vence e outro worker assume — o token muda.
    await expireLease(absorber.id);
    const successor = await inA(() =>
      agentTurnsRepo.tryClaimTurn({
        turn_id: absorber.id,
        worker_id: 'sucessor',
        lease_ms: LEASE_MS,
      }),
    );
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    expect(successor.claim.claim_token).not.toBe(absorber.claim_token);

    const zumbi = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: absorber.claim_token, // token da encarnação morta
        expected_version: sibling.state_version,
      }),
    );
    expect(zumbi.ok).toBe(false);
    expect(zumbi.ok === false && zumbi.conflict).toBe('stale_claim');

    // O sucessor absorve normalmente.
    const ok = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: successor.claim.claim_token,
        expected_version: sibling.state_version,
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it('absorvedor de OUTRO escopo não autoriza absorção (fail-closed)', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    // Mesmo token, mas o EXISTS exige tenant+agent do contexto corrente. Um
    // `turn_id` autorizando de fora do escopo seria vazamento entre tenants por
    // um caminho que ninguém olha.
    const r = await runWithTenantContext({ tenant_id: T_A, agent_id: 'outro-agente' }, () =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: absorber.claim_token,
        expected_version: sibling.state_version,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict).toBe('not_found');
  });

  // ─── SONDA 3 — o CAS do irmão ─────────────────────────────────────────────
  //
  // Duas absorções concorrentes do MESMO irmão: exatamente uma pode vencer. Se
  // as duas vencessem, a rajada do debounce produziria dois turnos executáveis
  // disputando as mesmas mensagens — que é a execução dupla por outro caminho.
  it('duas absorções concorrentes do mesmo irmão → exatamente UMA vence', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorberA = await claimedTurn();
    const absorberB = await claimedTurn();
    const sibling = await freshTurn();

    const results = await Promise.all(
      [absorberA, absorberB].map((a) =>
        inA(() =>
          agentTurnsRepo.markSupersededByAbsorber({
            turn_id: sibling.id,
            absorbed_by_turn_id: a.id,
            absorber_claim_token: a.claim_token,
            // Os dois leram o MESMO estado — é exatamente a corrida real.
            expected_version: sibling.state_version,
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    // O perdedor perde por ESTADO/VERSÃO (o irmão andou), não por fence: a
    // posse dele está viva. Reportar `stale_claim` aqui mandaria um worker
    // saudável cancelar a própria tentativa.
    expect(loser && loser.ok === false && loser.conflict).toBe('state_mismatch');

    // E a relação persistida aponta para UM absorvedor só.
    const absorbedByA = await inA(() => agentTurnsRepo.listAbsorbedTurns(absorberA.id));
    const absorbedByB = await inA(() => agentTurnsRepo.listAbsorbedTurns(absorberB.id));
    expect(absorbedByA.length + absorbedByB.length).toBe(1);
  });

  it('CAS obsoleto (o irmão já andou) é recusado', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    // O irmão foi enfileirado por outro caminho: a versão que lemos ficou velha.
    const queued = await inA(() => agentTurnsRepo.markQueued({ turn_id: sibling.id }));
    expect(queued.ok).toBe(true);

    const r = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        absorber_claim_token: absorber.claim_token,
        expected_version: sibling.state_version, // obsoleta
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict).toBe('state_mismatch');
  });

  // ─── AUTO-SUPERSESSÃO — o fence é do PRÓPRIO turno ────────────────────────
  it('auto-supersessão exige o claim_token do PRÓPRIO turno', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const turn = await freshTurn();
    const claim = await inA(() =>
      agentTurnsRepo.tryClaimTurn({ turn_id: turn.id, worker_id: 'dono', lease_ms: LEASE_MS }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // `claimed` não é origem de `superseded` no contrato (#503): a
    // auto-supersessão só existe antes de a execução começar. O que este caso
    // prova é o FENCE, então voltamos o turno a `queued` mantendo a posse.
    await pool.query(`UPDATE agent_turns SET status = 'queued' WHERE id = $1`, [turn.id]);
    const version = Number((await readTurn(turn.id))['state_version']);

    // Token de outra encarnação: recusado.
    const zumbi = await inA(() =>
      agentTurnsRepo.markSupersededSelf({
        turn_id: turn.id,
        expected_version: version,
        expected_claim_token: randomUUID(),
      }),
    );
    expect(zumbi.ok).toBe(false);
    expect(zumbi.ok === false && zumbi.conflict).toBe('stale_claim');

    // Lease vencida com o token CERTO: também recusado. Só o token nunca basta.
    await expireLease(turn.id);
    const vencido = await inA(() =>
      agentTurnsRepo.markSupersededSelf({
        turn_id: turn.id,
        expected_version: version,
        expected_claim_token: claim.claim.claim_token,
      }),
    );
    expect(vencido.ok).toBe(false);
    expect(vencido.ok === false && vencido.conflict).toBe('stale_claim');

    // Com posse viva, passa.
    await pool.query(
      `UPDATE agent_turns SET lease_expires_at = now() + interval '1 minute' WHERE id = $1`,
      [turn.id],
    );
    const ok = await inA(() =>
      agentTurnsRepo.markSupersededSelf({
        turn_id: turn.id,
        expected_version: version,
        expected_claim_token: claim.claim.claim_token,
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.turn.status).toBe('superseded');
      // A posse morre com a tentativa (`clearClaim`).
      expect(ok.turn.claim_token).toBeNull();
    }
  });

  it('regime de #503 (sem token nenhum) continua absorvendo — a flag é kill switch', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const absorber = await claimedTurn();
    const sibling = await freshTurn();

    const r = await inA(() =>
      agentTurnsRepo.markSupersededByAbsorber({
        turn_id: sibling.id,
        absorbed_by_turn_id: absorber.id,
        // sem `absorber_claim_token`: é o que o lifecycle envia com
        // FEATURE_TURN_CLAIM OFF, onde não existe lease em lugar nenhum.
        expected_version: sibling.state_version,
      }),
    );
    expect(r.ok).toBe(true);
  });
});

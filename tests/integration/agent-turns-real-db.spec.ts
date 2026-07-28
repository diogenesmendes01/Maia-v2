/**
 * Issue #503 — máquina de estados durável do turno, contra Postgres REAL
 * (migrations 096/097).
 *
 * Prova o que só o banco pode provar:
 *  1. dois callers tentam a MESMA transição — exatamente um vence (CAS);
 *  2. CAS com `state_version` obsoleto devolve conflito tipado;
 *  3. uma mensagem inbound não pode pertencer a dois turnos;
 *  4. FK composta impede associar mensagem do tenant B a turno do tenant A;
 *  5. o CHECK rejeita terminal sem outcome e par estado/outcome incompatível;
 *  6. transição terminal escreve a projeção legada `processada_em`; retryable NÃO;
 *  7. rollback da transação de ingestão deixa ZERO mensagem e ZERO turno;
 *     commit deixa AMBOS;
 *  8. backfill roda duas vezes sem criar turno duplicado;
 *  9. o índice de recovery é de fato usado pelo plano da consulta;
 * 10. cross-tenant: o turno do outro tenant é invisível (not_found).
 *
 * Skipped sem TEST_DB_URL (a lane unit-only passa sem Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
// A matriz do caso (5) é GERADA a partir do contrato: se o SQL da migration 097
// e `TERMINAL_OUTCOMES` divergirem, o caso correspondente falha.
import {
  TURN_STATUSES,
  TURN_OUTCOMES,
  TERMINAL_TURN_STATUSES,
  TERMINAL_OUTCOMES,
  isTerminalTurnStatus,
} from '@/runtime/turns/contract.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED: `agents.id` é PK GLOBAL — um id genérico colidiria com
// seeds de outras suítes.
const OTHER_TENANT = 'turns503-tenant-b';
const OTHER_AGENT = 'turns503-agent-b';

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

/** Insere um inbound cru (sem passar pelo repo) e devolve o id. */
async function mkInbound(
  tenant: string,
  agent: string,
  opts: { processada?: boolean; created_at?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, $4, COALESCE($5::timestamptz, now()))`,
    [id, tenant, agent, opts.processada ? new Date() : null, opts.created_at ?? null],
  );
  createdMensagens.push(id);
  return id;
}

const inPrimary = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, fn);
const inOther = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: OTHER_TENANT, agent_id: OTHER_AGENT }, fn);

d('agent_turns — DB real (migrations 096/097)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent('primary', 'primary');
    await ensureTenantAgent(OTHER_TENANT, OTHER_AGENT);
  });

  afterAll(async () => {
    if (createdMensagens.length > 0) {
      // agent_turn_inputs cai por CASCADE do turno; a FK para mensagens exige
      // apagar inputs antes das mensagens.
      await pool.query(
        `DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [createdMensagens]);
    }
    await pool.query(`DELETE FROM agents WHERE id = $1`, [OTHER_AGENT]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [OTHER_TENANT]);
    await pool.end();
  });

  it('(1) dois callers tentam a mesma transição — exatamente um vence', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const mensagem_id = await mkInbound('primary', 'primary');
    const turn = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: mensagem_id,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );

    const version = Number(turn.state_version);
    const [a, b] = await Promise.all([
      inPrimary(() => agentTurnsRepo.markQueued({ turn_id: turn.id, expected_version: version })),
      inPrimary(() => agentTurnsRepo.markQueued({ turn_id: turn.id, expected_version: version })),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, conflict: 'state_mismatch' });
  });

  it('(2) CAS com state_version obsoleto devolve conflito tipado (nunca sucesso silencioso)', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const mensagem_id = await mkInbound('primary', 'primary');
    const turn = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: mensagem_id,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );
    const stale = Number(turn.state_version);
    const ok = await inPrimary(() =>
      agentTurnsRepo.markQueued({ turn_id: turn.id, expected_version: stale }),
    );
    expect(ok.ok).toBe(true);

    // Mesma versão, de novo: o estado já avançou.
    const conflict = await inPrimary(() =>
      agentTurnsRepo.markClaimed({ turn_id: turn.id, expected_version: stale }),
    );
    expect(conflict).toMatchObject({ ok: false, conflict: 'state_mismatch' });
    if (!conflict.ok && conflict.conflict === 'state_mismatch') {
      expect(conflict.current_status).toBe('queued');
      expect(conflict.current_state_version).toBe(stale + 1);
    }
  });

  it('(3) uma mensagem inbound não pode pertencer a dois turnos', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const shared = await mkInbound('primary', 'primary');
    const other = await mkInbound('primary', 'primary');
    const turnA = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: shared,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );
    const turnB = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: other,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );
    expect(turnA.id).not.toBe(turnB.id);

    const attached = await inPrimary(() =>
      agentTurnsRepo.attachInputTx({ turn_id: turnB.id, mensagem_id: shared, ingress_seq: 1 }),
    );
    expect(attached).toEqual({ attached: false, reason: 'already_attached' });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM agent_turn_inputs WHERE mensagem_id = $1`,
      [shared],
    );
    expect(rows[0].n).toBe(1);
  });

  it('(4) FK composta impede associar mensagem do tenant B a turno do tenant A', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgA = await mkInbound('primary', 'primary');
    const msgB = await mkInbound(OTHER_TENANT, OTHER_AGENT);
    const turnA = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgA,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );

    // Pelo repositório: o tenant guard escopa a row inserida em primary/primary,
    // então a FK composta (tenant, agent, mensagem) NÃO encontra msgB.
    await expect(
      inPrimary(() =>
        agentTurnsRepo.attachInputTx({ turn_id: turnA.id, mensagem_id: msgB, ingress_seq: 1 }),
      ),
    ).rejects.toThrow();

    // Direto no SQL, forjando o escopo: a FK do TURNO barra.
    await expect(
      pool.query(
        `INSERT INTO agent_turn_inputs (tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
         VALUES ($1, $2, $3, $4, 1)`,
        [OTHER_TENANT, OTHER_AGENT, turnA.id, msgB],
      ),
    ).rejects.toThrow();
  });

  // ─── (5) MATRIZ COMPLETA estado x outcome, contra o banco ────────────────
  //
  // A primeira versão deste teste cobria três casos pontuais e por isso deixou
  // passar um bug REAL na migration 097: o CHECK composto usava
  // `status = 'completed' AND outcome IN (...)`, que com `outcome IS NULL`
  // avalia para NULL — e um CHECK do Postgres só REPROVA em FALSE, aceitando
  // NULL. Ou seja, "terminal exige outcome" não estava valendo no banco.
  //
  // Agora a matriz é GERADA a partir das constantes do contrato
  // (src/runtime/turns/contract.ts). Duas propriedades novas:
  //   - cobre os 10 estados x (14 outcomes + NULL) = 150 combinações, então
  //     nenhum par fica sem cobertura por esquecimento;
  //   - se alguém adicionar um outcome/estado ao contrato sem atualizar o SQL
  //     (ou vice-versa), o caso correspondente falha aqui. É o guarda contra a
  //     divergência contrato ↔ migration.
  //
  // Os casos REJEITADOS reusam uma única mensagem: um INSERT recusado não
  // deixa row, então a unique de `representative_message_id` não é consumida.
  // Os casos ACEITOS precisam de uma mensagem nova cada.
  describe('(5) matriz estado x outcome — o CHECK do banco espelha o contrato', () => {
    /** Nomes de constraint que podem legitimamente barrar um par inválido. */
    const OUTCOME_CONSTRAINTS = /agent_turns_(outcome_presence|status_outcome)_chk/;

    async function insertTurn(
      mensagem_id: string,
      status: string,
      outcome: string | null,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status, outcome)
         VALUES ('primary', 'primary', $1, $2, $3)`,
        [mensagem_id, status, outcome],
      );
    }

    let rejectMsg: string;
    beforeAll(async () => {
      rejectMsg = await mkInbound('primary', 'primary');
    });

    it('todo estado TERMINAL sem outcome é REJEITADO (o bug que o CI pegou)', async () => {
      for (const status of TERMINAL_TURN_STATUSES) {
        await expect(
          insertTurn(rejectMsg, status, null),
          `${status} + outcome NULL deveria ser rejeitado`,
        ).rejects.toThrow(OUTCOME_CONSTRAINTS);
      }
    });

    it('todo par (terminal, outcome) VÁLIDO do contrato é ACEITO', async () => {
      for (const status of TERMINAL_TURN_STATUSES) {
        for (const outcome of TERMINAL_OUTCOMES[status]) {
          const msg = await mkInbound('primary', 'primary');
          await expect(
            insertTurn(msg, status, outcome),
            `${status} + ${outcome} consta de TERMINAL_OUTCOMES e deveria ser aceito`,
          ).resolves.toBeDefined();
        }
      }
    });

    it('todo par (terminal, outcome) FORA da lista do contrato é REJEITADO', async () => {
      for (const status of TERMINAL_TURN_STATUSES) {
        const allowed = new Set<string>(TERMINAL_OUTCOMES[status]);
        for (const outcome of TURN_OUTCOMES) {
          if (allowed.has(outcome)) continue;
          await expect(
            insertTurn(rejectMsg, status, outcome),
            `${status} + ${outcome} NÃO consta de TERMINAL_OUTCOMES e deveria ser rejeitado`,
          ).rejects.toThrow(OUTCOME_CONSTRAINTS);
        }
      }
    });

    it('todo estado NÃO-terminal com outcome NULL é ACEITO', async () => {
      for (const status of TURN_STATUSES) {
        if (isTerminalTurnStatus(status)) continue;
        const msg = await mkInbound('primary', 'primary');
        await expect(
          insertTurn(msg, status, null),
          `${status} + outcome NULL deveria ser aceito`,
        ).resolves.toBeDefined();
      }
    });

    it('todo estado NÃO-terminal com QUALQUER outcome é REJEITADO', async () => {
      for (const status of TURN_STATUSES) {
        if (isTerminalTurnStatus(status)) continue;
        for (const outcome of TURN_OUTCOMES) {
          await expect(
            insertTurn(rejectMsg, status, outcome),
            `${status} + ${outcome}: estado não-terminal não pode carregar outcome`,
          ).rejects.toThrow(OUTCOME_CONSTRAINTS);
        }
      }
    });

    it('valor fora do vocabulário é rejeitado (status e outcome)', async () => {
      await expect(insertTurn(rejectMsg, 'processing', null)).rejects.toThrow(
        /agent_turns_status_chk/,
      );
      // Outcome desconhecido não casa nenhuma lista fechada.
      await expect(insertTurn(rejectMsg, 'completed', 'done')).rejects.toThrow(
        OUTCOME_CONSTRAINTS,
      );
    });

    // Divergência consciente nº 1 da PR, verificada NO BANCO e não só no
    // contrato: descarte por regra explícita é `ignored`, nunca `completed`.
    it('descartes por política pertencem a `ignored` e são recusados em `completed`', async () => {
      for (const outcome of [
        'blocked_by_policy',
        'identity_unknown',
        'identity_blocked',
        'quarantined',
        'rate_limited_silent',
      ] as const) {
        await expect(
          insertTurn(rejectMsg, 'completed', outcome),
          `${outcome} não pode ser aceito em 'completed'`,
        ).rejects.toThrow(OUTCOME_CONSTRAINTS);
        const msg = await mkInbound('primary', 'primary');
        await expect(insertTurn(msg, 'ignored', outcome)).resolves.toBeDefined();
      }
    });

    // Divergência consciente nº 2: as ARESTAS extras (`retryable`/`claimed` ->
    // `dead_letter`) não são expressáveis num CHECK — quem as impõe é o CAS do
    // repositório (teste (1)). O que o banco garante é o lado do OUTCOME:
    // `retry_exhausted` só existe em `dead_letter`.
    it('`retry_exhausted` só é aceito em `dead_letter`', async () => {
      for (const status of TERMINAL_TURN_STATUSES) {
        if (status === 'dead_letter') continue;
        await expect(insertTurn(rejectMsg, status, 'retry_exhausted')).rejects.toThrow(
          OUTCOME_CONSTRAINTS,
        );
      }
      const msg = await mkInbound('primary', 'primary');
      await expect(insertTurn(msg, 'dead_letter', 'retry_exhausted')).resolves.toBeDefined();
    });
  });

  it('(6) terminal projeta processada_em; retryable NÃO projeta', async () => {
    const { agentTurnsRepo } = await loadRepos();

    // (a) retryable — a projeção NÃO pode ser escrita.
    const pendingMsg = await mkInbound('primary', 'primary');
    const pendingTurn = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: pendingMsg,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );
    const retry = await inPrimary(() =>
      agentTurnsRepo.markRetryable({
        turn_id: pendingTurn.id,
        next_attempt_at: new Date(Date.now() + 60_000),
        error_code: 'reasoner_failed',
        error_summary: 'timeout',
        expected_version: Number(pendingTurn.state_version),
      }),
    );
    expect(retry.ok).toBe(true);
    let res = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [pendingMsg]);
    expect(res.rows[0].processada_em).toBeNull();

    // (b) terminal — a projeção É escrita, para TODAS as mensagens do turno.
    const repMsg = await mkInbound('primary', 'primary');
    const siblingMsg = await mkInbound('primary', 'primary');
    const turn = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: repMsg,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );
    await inPrimary(() =>
      agentTurnsRepo.attachInputTx({
        turn_id: turn.id,
        mensagem_id: siblingMsg,
        ingress_seq: 1,
      }),
    );
    await inPrimary(() =>
      agentTurnsRepo.markIgnored({
        turn_id: turn.id,
        outcome: 'identity_unknown',
        expected_version: Number(turn.state_version),
      }),
    );
    res = await pool.query(
      `SELECT id, processada_em FROM mensagens WHERE id = ANY($1::uuid[])`,
      [[repMsg, siblingMsg]],
    );
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) expect(row.processada_em).not.toBeNull();
  });

  it('(7) rollback da ingestão deixa zero mensagem e zero turno; commit deixa ambos', async () => {
    const { agentTurnsRepo } = await loadRepos();

    // Rollback: para falhar DEPOIS do insert da mensagem (que é o que torna o
    // teste interessante), plantamos um turno de OUTRO tenant já usando o
    // `representative_message_id` que vamos tentar inserir. O ON CONFLICT do
    // create não devolve row, a releitura — escopada em primary — não acha
    // nada, e o repo falha ALTO. A transação inteira tem de sumir.
    const doomedId = randomUUID();
    createdMensagens.push(doomedId);
    await pool.query(
      `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status)
       VALUES ($1, $2, $3, 'received')`,
      [OTHER_TENANT, OTHER_AGENT, doomedId],
    );
    await expect(
      inPrimary(() =>
        agentTurnsRepo.createReceivedTurnTx({
          mensagem: {
            id: doomedId,
            conversa_id: null,
            channel_id: null,
            direcao: 'in',
            tipo: 'texto',
            conteudo: 'x',
            midia_url: null,
            metadata: {},
            processada_em: null,
            ferramentas_chamadas: [],
            tokens_usados: null,
          },
        }),
      ),
    ).rejects.toThrow(/não pôde ser criado nem relido/);
    let res = await pool.query(`SELECT count(*)::int AS n FROM mensagens WHERE id = $1`, [
      doomedId,
    ]);
    expect(res.rows[0].n).toBe(0);
    res = await pool.query(
      `SELECT count(*)::int AS n FROM agent_turns
       WHERE representative_message_id = $1 AND tenant_id = 'primary'`,
      [doomedId],
    );
    expect(res.rows[0].n).toBe(0);

    // Commit: mensagem E turno persistidos, ligados por agent_turn_inputs.
    const created = await inPrimary(() =>
      agentTurnsRepo.createReceivedTurnTx({
        mensagem: {
          conversa_id: null,
          channel_id: null,
          direcao: 'in',
          tipo: 'texto',
          conteudo: 'ok',
          midia_url: null,
          metadata: {},
          processada_em: null,
          ferramentas_chamadas: [],
          tokens_usados: null,
        },
      }),
    );
    createdMensagens.push(created.mensagem.id);
    expect(created.turn.status).toBe('received');
    expect(created.turn.representative_message_id).toBe(created.mensagem.id);
    res = await pool.query(
      `SELECT count(*)::int AS n FROM agent_turn_inputs WHERE turn_id = $1 AND mensagem_id = $2 AND ingress_seq = 0`,
      [created.turn.id, created.mensagem.id],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it('(8) backfill é idempotente: duas execuções não criam turno duplicado', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const processed = await mkInbound('primary', 'primary', { processada: true });
    const pending = await mkInbound('primary', 'primary');

    const first = await agentTurnsRepo.backfillBatch({
      tenant_id: 'primary',
      agent_id: 'primary',
      limit: 500,
    });
    expect(first.created).toBeGreaterThanOrEqual(2);

    const second = await agentTurnsRepo.backfillBatch({
      tenant_id: 'primary',
      agent_id: 'primary',
      limit: 500,
    });
    expect(second.created).toBe(0);

    const res = await pool.query(
      `SELECT representative_message_id, status, outcome, completed_at, next_attempt_at
       FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
      [[processed, pending]],
    );
    expect(res.rows).toHaveLength(2);
    const byMsg = new Map(res.rows.map((r) => [r.representative_message_id, r]));
    expect(byMsg.get(processed)).toMatchObject({
      status: 'completed',
      outcome: 'legacy_processed',
    });
    expect(byMsg.get(processed).completed_at).not.toBeNull();
    expect(byMsg.get(pending)).toMatchObject({ status: 'received', outcome: null });
    expect(byMsg.get(pending).next_attempt_at).not.toBeNull();
  });

  it('(9) a consulta de recovery usa o índice escopado (não Seq Scan)', async () => {
    // O planner só escolhe índice quando vale a pena; forçamos a comparação
    // desabilitando seqscan, o que prova que existe um caminho por índice
    // compatível com (tenant, agent, status, next_attempt_at).
    const client = await pool.connect();
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN (FORMAT TEXT)
         SELECT * FROM agent_turns
         WHERE tenant_id = 'primary' AND agent_id = 'primary'
           AND status IN ('received','queued','claimed','running','retryable')
           AND next_attempt_at <= now()`,
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toMatch(/Index (Scan|Only Scan|Cond)|Bitmap Index Scan/);
    } finally {
      client.release();
    }
  });

  it('(10) cross-tenant: turno do outro tenant é invisível', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const msgB = await mkInbound(OTHER_TENANT, OTHER_AGENT);
    const turnB = await inOther(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: msgB,
        tenant_id: OTHER_TENANT,
        agent_id: OTHER_AGENT,
        conversa_id: null,
        channel_id: null,
      }),
    );

    expect(await inPrimary(() => agentTurnsRepo.findById(turnB.id))).toBeNull();
    expect(await inPrimary(() => agentTurnsRepo.findTurnByMessage(msgB))).toBeNull();
    expect(await inPrimary(() => agentTurnsRepo.listTurnInputs(turnB.id))).toEqual([]);

    const blocked = await inPrimary(() =>
      agentTurnsRepo.markQueued({ turn_id: turnB.id, expected_version: 0 }),
    );
    expect(blocked).toMatchObject({ ok: false, conflict: 'not_found' });

    // E o turno do outro tenant continua intacto.
    const still = await inOther(() => agentTurnsRepo.findById(turnB.id));
    expect(still?.status).toBe('received');
  });
});

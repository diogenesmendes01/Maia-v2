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
    // Limpeza por ESCOPO, não só pelos ids que este processo rastreou. Uma
    // execução interrompida deixa linha para trás, e o `DELETE FROM agents`
    // seguinte quebra em `mensagens_agent_id_fkey` — derrubando a SUÍTE
    // INTEIRA no `afterAll`, com todos os casos verdes. Falha de arquivo sem
    // teste vermelho é especialmente difícil de ler. Os ids são namespaced
    // (`turns503-*`), então apagar por escopo não alcança dado de outro spec.
    await pool.query(
      `DELETE FROM agent_turn_inputs WHERE mensagem_id IN
         (SELECT id FROM mensagens WHERE tenant_id = $1 AND agent_id = $2)`,
      [OTHER_TENANT, OTHER_AGENT],
    );
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1 AND agent_id = $2`, [
      OTHER_TENANT,
      OTHER_AGENT,
    ]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1 AND agent_id = $2`, [
      OTHER_TENANT,
      OTHER_AGENT,
    ]);
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

    /**
     * Devolve o RESULTADO da query, não `void`.
     *
     * A primeira versão era `Promise<void>`: os casos positivos usavam
     * `.resolves.toBeDefined()` e falhavam sempre, porque um INSERT bem
     * sucedido resolvia `undefined`. Os 21 pares que DEVEM ser aceitos
     * apareciam como falha — o CI de integração ficou vermelho exatamente
     * aqui. Retornando o `QueryResult`, o caso positivo afirma algo real:
     * `rowCount === 1`.
     */
    function insertTurn(
      mensagem_id: string,
      status: string,
      outcome: string | null,
    ): Promise<pg.QueryResult> {
      return pool.query(
        `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status, outcome)
         VALUES ('primary', 'primary', $1, $2, $3)`,
        [mensagem_id, status, outcome],
      );
    }

    /** Insere e exige que a row TENHA sido criada. */
    async function expectAccepted(
      mensagem_id: string,
      status: string,
      outcome: string | null,
      hint: string,
    ): Promise<void> {
      const result = await insertTurn(mensagem_id, status, outcome);
      expect(result.rowCount, hint).toBe(1);
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
          await expectAccepted(
            msg,
            status,
            outcome,
            `${status} + ${outcome} consta de TERMINAL_OUTCOMES e deveria ser aceito`,
          );
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
        await expectAccepted(msg, status, null, `${status} + outcome NULL deveria ser aceito`);
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
        await expectAccepted(msg, 'ignored', outcome, `${outcome} deveria ser aceito em 'ignored'`);
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
      await expectAccepted(
        msg,
        'dead_letter',
        'retry_exhausted',
        "retry_exhausted deveria ser aceito em 'dead_letter'",
      );
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

  /**
   * Nó de plano do `EXPLAIN (FORMAT JSON)`. Só o que este arquivo usa.
   */
  type PlanNode = {
    'Node Type': string;
    'Index Name'?: string;
    Plans?: PlanNode[];
  };

  /**
   * Todos os índices citados na ÁRVORE do plano, em qualquer profundidade.
   *
   * Um `Bitmap Heap Scan` traz o `Index Name` no filho, não na raiz — checar só
   * o topo devolveria vazio justamente no plano que este teste espera.
   */
  function collectIndexNames(node: PlanNode): string[] {
    const here = node['Index Name'] ? [node['Index Name']] : [];
    return [...here, ...(node.Plans ?? []).flatMap(collectIndexNames)];
  }

  /**
   * Roda `fn` num bloco de transação com `enable_seqscan` desligado, e SEMPRE
   * desfaz.
   *
   * Dois motivos, os dois vindos de defeito real neste arquivo:
   *
   *  - `SET LOCAL` só vale dentro de transação. Fora dela o Postgres responde
   *    `WARNING: SET LOCAL can only be used in transaction blocks` e não aplica
   *    nada. O WARNING não vira erro no driver, então o teste seguia com o
   *    seqscan ligado e falhava por um motivo que não era o que ele mede.
   *  - O `ROLLBACK` precisa rodar TAMBÉM quando a asserção lança. `pg.Pool` não
   *    desfaz nada no `release()`: um client devolvido ainda em transação, e com
   *    `enable_seqscan=off` local, contamina o próximo teste que pegar o slot.
   */
  async function explainWithoutSeqScan<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL enable_seqscan = off');
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  it('(9) o ramo `retryable` do recovery é servido pelo índice de recovery, nomeado', async () => {
    // ESCOPO DO QUE ESTE CASO PROVA, porque a versão anterior prometia mais do
    // que entregava: ele cobre UM dos três ramos de `findRecoverableTurns`
    // (`src/db/repositories/turn-repos.ts`), o de `retryable`. Os outros dois
    // — `received`/`queued` por `created_at` e `claimed`/`running` por
    // `lease_expires_at` — NÃO são cobertos aqui e não são reivindicados.
    //
    // A versão anterior achatava os três ramos num único `next_attempt_at <=
    // now()` aplicado a todos os estados. Aquele predicado não é o de produção:
    // ele podia escolher o índice de recovery enquanto a consulta real fazia
    // Seq Scan. Era a mesma vacuidade que este arquivo veio corrigir, uma
    // camada abaixo.
    //
    // Tudo roda numa transação DESFEITA, e isso não é economia de limpeza:
    //   - as 200 linhas somem no `ROLLBACK`, então uma execução interrompida
    //     não deixa massa para trás (a versão com `afterAll` deixava, porque o
    //     registro dos escopos só existia na memória do processo);
    //   - e NÃO há `ANALYZE`. Medi: `ANALYZE` dentro de transação NÃO é
    //     desfeito pelo `ROLLBACK` — `pg_class.reltuples` foi de 39 para 4039 e
    //     ficou, com a tabela vazia. Publicar estatística sintética num banco
    //     que outros specs compartilham distorce o plano deles, que é
    //     exatamente o dano que o teardown existia para evitar.
    //
    // Sem `ANALYZE`, com `enable_seqscan = off` e o predicado do ramo, o
    // planner compara caminhos de índice: o de recovery cobre os quatro
    // atributos, o genérico de escopo cobre dois. 200 linhas bastam.
    const nonce = randomUUID().slice(0, 8);
    const tenant = `idx-${nonce}`;
    const agent = `idx-${nonce}-probe`;

    const indexes = await explainWithoutSeqScan(async (client) => {
      await client.query(`INSERT INTO tenants (id, nome, status) VALUES ($1,$1,'active')`, [
        tenant,
      ]);
      await client.query(
        `INSERT INTO agents (id, tenant_id, nome, status) VALUES ($1,$2,$1,'active')`,
        [agent, tenant],
      );
      await client.query(
        `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status, next_attempt_at)
         SELECT $1, $2, gen_random_uuid(), 'retryable', now() - interval '1 minute'
           FROM generate_series(1, 200)`,
        [tenant, agent],
      );

      // O predicado do ramo `retryable` COMO ELE É em `findRecoverableTurns`,
      // incluindo `IS NOT NULL`, a ordenação e o limite — os três participam da
      // escolha do plano.
      const plan = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM agent_turns
         WHERE tenant_id = $1 AND agent_id = $2
           AND status = 'retryable'
           AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
         ORDER BY created_at
         LIMIT 200`,
        [tenant, agent],
      );
      return collectIndexNames(plan.rows[0]!['QUERY PLAN'][0]!.Plan);
    });

    expect(
      indexes,
      `o plano não usou o índice de recovery; usou: ${indexes.join(', ') || '(nenhum índice)'}`,
    ).toContain('agent_turns_scope_status_next_attempt_idx');
  });

  it('(9b) o `SET LOCAL` REALMENTE se aplica, e não vaza da transação', async () => {
    // Guarda do guard: sem transação, o `SET LOCAL` é um no-op silencioso e o
    // caso (9) volta a falhar por um motivo que não é o que ele mede. Aqui a
    // ausência de transação é o defeito sendo asserido, não um acidente.
    const dentro = await explainWithoutSeqScan((client) =>
      client.query<{ enable_seqscan: string }>('SHOW enable_seqscan'),
    );
    expect(dentro.rows[0]!.enable_seqscan, 'SET LOCAL não pegou dentro do BEGIN').toBe('off');

    // Depois do ROLLBACK o valor volta ao default — inclusive para o próximo
    // teste que pegar este slot do pool.
    const fora = await pool.query<{ enable_seqscan: string }>('SHOW enable_seqscan');
    expect(fora.rows[0]!.enable_seqscan, 'o SET LOCAL vazou da transação').toBe('on');
  });

  it('(9c) uma asserção que LANÇA ainda desfaz a transação', async () => {
    // O caminho de falha é o que estava desprotegido: `pg.Pool` não faz
    // rollback no `release()`, então um throw no meio devolvia ao pool um
    // client ainda em transação e com `enable_seqscan=off`.
    await expect(
      explainWithoutSeqScan(async () => {
        throw new Error('asserção falhou no meio da transação');
      }),
    ).rejects.toThrow('asserção falhou');

    const fora = await pool.query<{ enable_seqscan: string }>('SHOW enable_seqscan');
    expect(fora.rows[0]!.enable_seqscan, 'o slot voltou ao pool contaminado').toBe('on');
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

  // Achado P2 rodada 1: a irmã do debounce virava `superseded` mas a relação de
  // absorção só existia no log — o operador via `merged_into_turn` sem saber
  // QUAL turno respondeu no lugar. Agora é coluna, com FK composta.
  it('(12) absorção do debounce é PERSISTIDA e escopada por tenant', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const mkTurn = async (): Promise<{ id: string; state_version: number }> => {
      const msg = await mkInbound('primary', 'primary');
      const t = await inPrimary(() =>
        agentTurnsRepo.ensureTurnForMessage({
          id: msg,
          tenant_id: 'primary',
          agent_id: 'primary',
          conversa_id: null,
          channel_id: null,
        }),
      );
      return { id: t.id, state_version: Number(t.state_version) };
    };
    const executor = await mkTurn();
    const sibling = await mkTurn();

    const r = await inPrimary(() =>
      agentTurnsRepo.markSuperseded({
        turn_id: sibling.id,
        absorbed_by_turn_id: executor.id,
        expected_version: sibling.state_version,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.status).toBe('superseded');
      expect(r.turn.outcome).toBe('merged_into_turn');
      expect(r.turn.superseded_by_turn_id).toBe(executor.id);
    }

    // A pergunta que o operador faz: "o que este turno absorveu?"
    const absorbed = await inPrimary(() => agentTurnsRepo.listAbsorbedTurns(executor.id));
    expect(absorbed.map((t) => t.id)).toEqual([sibling.id]);

    // CHECK: absorção só existe em `superseded`.
    const other = await mkTurn();
    await expect(
      pool.query(`UPDATE agent_turns SET superseded_by_turn_id = $1 WHERE id = $2`, [
        executor.id,
        other.id,
      ]),
    ).rejects.toThrow(/agent_turns_superseded_by_chk/);

    // CHECK: ninguém absorve a si mesmo.
    await expect(
      pool.query(
        `UPDATE agent_turns SET status = 'superseded', outcome = 'merged_into_turn',
         superseded_by_turn_id = id WHERE id = $1`,
        [other.id],
      ),
    ).rejects.toThrow(/agent_turns_superseded_by_chk/);

    // FK composta: não dá para ser absorvido por turno de OUTRO tenant.
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
    await expect(
      pool.query(
        `UPDATE agent_turns SET status = 'superseded', outcome = 'merged_into_turn',
         superseded_by_turn_id = $1 WHERE id = $2`,
        [turnB.id, other.id],
      ),
    ).rejects.toThrow();
  });

  // Achado P1 rodada 1: no modo autoritativo o turno virava `retryable`, mas
  // `processada_em` era carimbado assim mesmo — o recovery reenfileirava e a
  // reentrada morria no early-return legado. Os cenários A e B da #503
  // continuavam como perda definitiva. Este teste percorre o CICLO INTEIRO e
  // ancora as duas propriedades que o consertam: a projeção legada NÃO é
  // escrita enquanto o turno não for terminal, e o turno volta a ser executável.
  it('(11) ciclo completo falha → retryable → recovery → nova execução', async () => {
    const { agentTurnsRepo } = await loadRepos();
    const mensagem_id = await mkInbound('primary', 'primary');
    let turn = await inPrimary(() =>
      agentTurnsRepo.ensureTurnForMessage({
        id: mensagem_id,
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        channel_id: null,
      }),
    );

    // received -> queued -> claimed -> running (primeira execução)
    for (const step of ['markQueued', 'markClaimed', 'markRunning'] as const) {
      const r = await inPrimary(() =>
        agentTurnsRepo[step]({ turn_id: turn.id, expected_version: Number(turn.state_version) }),
      );
      expect(r.ok, `${step} deveria vencer`).toBe(true);
      if (r.ok) turn = r.turn;
    }
    expect(turn.status).toBe('running');
    expect(turn.attempt_count).toBe(1);

    // Falha do reasoner (cenário A): retryable com tentativa JÁ vencida, para
    // que o recovery a eleja no mesmo tick.
    const retry = await inPrimary(() =>
      agentTurnsRepo.markRetryable({
        turn_id: turn.id,
        next_attempt_at: new Date(Date.now() - 1_000),
        error_code: 'reasoner_failed',
        error_summary: null,
        expected_version: Number(turn.state_version),
      }),
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) turn = retry.turn;

    // A PROPRIEDADE CENTRAL: turno não-terminal não projeta no campo legado.
    // Se `processada_em` fosse escrito aqui, o early-return de core.ts abortaria
    // a reentrada e o retry nunca aconteceria.
    const projected = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [
      mensagem_id,
    ]);
    expect(projected.rows[0].processada_em).toBeNull();

    // O recovery ELEGE o turno, com o motivo certo.
    const candidates = await inPrimary(() => agentTurnsRepo.findRecoverableTurns(0, 100));
    const mine = candidates.find((c) => c.turn.id === turn.id);
    expect(mine, 'o turno retryable deveria ser candidato de recovery').toBeDefined();
    expect(mine!.reason).toBe('retry_due');

    // Rearme + nova execução: retryable -> queued -> claimed -> running.
    for (const step of ['markQueued', 'markClaimed', 'markRunning'] as const) {
      const r = await inPrimary(() =>
        agentTurnsRepo[step]({ turn_id: turn.id, expected_version: Number(turn.state_version) }),
      );
      expect(r.ok, `${step} na reentrada deveria vencer`).toBe(true);
      if (r.ok) turn = r.turn;
    }
    expect(turn.status).toBe('running');
    // Segunda tentativa contabilizada — é o que alimenta o teto de dead letter.
    expect(turn.attempt_count).toBe(2);

    // Agora conclui de verdade: terminal projeta `processada_em`.
    const done = await inPrimary(() =>
      agentTurnsRepo.completeTurnTx({
        turn_id: turn.id,
        outcome: 'reply_delivered',
        expected_version: Number(turn.state_version),
      }),
    );
    expect(done.ok).toBe(true);
    const after = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [
      mensagem_id,
    ]);
    expect(after.rows[0].processada_em).not.toBeNull();

    // E deixa de ser candidato de recovery.
    const post = await inPrimary(() => agentTurnsRepo.findRecoverableTurns(0, 100));
    expect(post.find((c) => c.turn.id === turn.id)).toBeUndefined();
  });
});

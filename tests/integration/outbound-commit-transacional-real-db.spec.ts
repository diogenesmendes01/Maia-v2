/**
 * Issue #631 (fatia B da épica #506) — o COMMIT TRANSACIONAL da resposta,
 * contra Postgres REAL, entrando pelo call site de PRODUÇÃO.
 *
 * ## Por que este arquivo é de integração, e por que ele entra por
 * `dispatchOutput`/`sendOutbound`
 *
 * A propriedade que a issue exige é sobre ORDEM E ATOMICIDADE entre duas
 * escritas e um efeito externo: "nenhuma chamada ao canal ocorre antes do
 * commit" e "rollback não deixa linha parcial". Nenhuma das duas é observável
 * num harness que reconstrói a transação por conta própria — um teste assim
 * continua verde mesmo que o call site de produção seja DELETADO, porque quem
 * abre a transação é o teste.
 *
 * Então aqui não existe transação montada pelo teste. A entrada é
 * `dispatchOutput` / `sendOutbound` de `src/agent/output-dispatch.ts` — as
 * funções que o ReAct, as skills e os fallbacks chamam — e tudo abaixo delas é
 * código de produção contra um banco de verdade.
 *
 * ## O que é mockado, e por quê
 *
 * Só a saída FÍSICA do canal (`@/gateway/line-output.js`). Ela é a fronteira
 * externa e é justamente o que não pode acontecer cedo demais. O double dela
 * não é passivo: ele CONSULTA O BANCO no instante do envio, por uma conexão
 * própria, e registra o que existia lá naquele momento. É esse registro que
 * transforma "nada vai ao canal antes do banco" numa afirmação verificável em
 * vez de uma inspeção de ordem de linhas.
 *
 * ## As sondas que este arquivo é obrigado a reprovar
 *
 *   1. mover `line.sendText(...)` para ANTES de `commitOutboundOrRefuse(...)`
 *      em `sendOutbound` → o caso "a linha durável já existe no instante do
 *      envio" reprova;
 *   2. trocar o `throw` de `commitOutboundOrRefuse` por um retorno fail-open
 *      → os casos de recusa reprovam (o canal passa a ser chamado);
 *   3. remover `expected_claim_token` da chamada a `commitTurnOutboundTx`
 *      → o caso "worker sem posse não commita" reprova;
 *   4. tirar o INSERT do outbox de dentro do `withTx` do turno → o caso de
 *      rollback reprova (o turno fica em `outbound_pending` sem artefato).
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'primary';
const AGENT = 'primary';

/**
 * O que o double do canal viu NO INSTANTE em que foi chamado.
 *
 * Ler o banco DEPOIS do dispatch não distingue "commitou e enviou" de "enviou e
 * commitou" — as duas terminam com a linha lá. Só a leitura feita DE DENTRO da
 * chamada ao canal responde a pergunta da issue.
 */
type FotoNoEnvio = {
  linhasOutbound: number;
  statusDoTurno: string | null;
};

const { canal } = vi.hoisted(() => ({
  canal: {
    fotos: [] as FotoNoEnvio[],
    /** Preenchido no beforeAll: fotografa o banco por uma conexão própria. */
    fotografar: null as null | (() => Promise<FotoNoEnvio>),
    sendText: vi.fn(),
    sendPoll: vi.fn(),
    conectado: true,
  },
}));

vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null },
    sendText: canal.sendText,
    sendDocument: vi.fn(),
    sendVoice: vi.fn(),
    sendPoll: canal.sendPoll,
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => canal.conectado,
  })),
}));

import { dispatchOutput, sendOutbound, OutboundDeliveryError } from '@/agent/output-dispatch.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithOutboundTurnScope } from '@/runtime/outbound/turn-scope.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { TurnLease } from '@/runtime/turns/lease.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;
let inboundId: string;
let turnId: string;
let claimToken: string;

/**
 * Handle com posse VIVA, como `beginTurnExecution` o devolve.
 *
 * `lease` é reduzido ao que o commit consulta — `token`. Não é um espelho da
 * transação (o teste não reconstrói nada do que está sendo verificado): é a
 * ENTRADA que produção receberia, e tudo que acontece depois dela é o código
 * real. Um `token` `null` é o estado `lost`, e é assim que o caso de posse
 * perdida é montado.
 */
function handleComPosse(token: string | null, state_version: number): TurnHandle {
  return {
    turn_id: turnId,
    status: 'running',
    state_version,
    attempt_count: 1,
    conversa_id: conversaId,
    lease: { token } as unknown as TurnLease,
  };
}

function ctxDeDispatch(text: string): Parameters<typeof dispatchOutput>[0] {
  return {
    pessoa: {
      id: pessoaId,
      telefone_whatsapp: '+5511900000631',
      preferencias: null,
    } as unknown as Pessoa,
    conversa: { id: conversaId, channel_id: null } as unknown as Conversa,
    inbound: {
      id: inboundId,
      conteudo: 'quanto eu gastei?',
      metadata: {},
      tipo: 'texto',
    } as unknown as Mensagem,
    jid: '5511900000631@s.whatsapp.net',
    text,
    latestPending: null,
    latestReportPdf: null,
    turnHasSensitive: false,
    sensitiveTools: [],
  };
}

/** Roda `fn` como a tentativa dona do turno rodaria. */
function comoOWorkerDono<T>(handle: TurnHandle, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
    runWithOutboundTurnScope(handle, fn),
  );
}

async function linhasOutboundDoTurno(): Promise<
  Array<{
    id: string;
    status: string;
    sequence_in_turn: number;
    logical_dedupe_key: string;
    payload_type: string;
    payload_hash: string;
    next_attempt_at: string | null;
    delivery_outcome: string | null;
  }>
> {
  const { rows } = await pool.query(
    `SELECT id, status, sequence_in_turn, logical_dedupe_key, payload_type,
            payload_hash, next_attempt_at, delivery_outcome
       FROM outbound_messages
      WHERE turn_id = $1
      ORDER BY sequence_in_turn`,
    [turnId],
  );
  return rows;
}

async function statusDoTurno(): Promise<{ status: string; state_version: number } | null> {
  const { rows } = await pool.query(
    `SELECT status, state_version FROM agent_turns WHERE id = $1`,
    [turnId],
  );
  return rows[0] ? { status: rows[0].status, state_version: Number(rows[0].state_version) } : null;
}

d('#631 — commit transacional da resposta (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    canal.fotografar = async (): Promise<FotoNoEnvio> => {
      // Conexão PRÓPRIA, fora de qualquer transação do runtime: é o que
      // garante que a foto enxerga apenas o que já foi COMMITADO. Lendo pela
      // mesma conexão da transação, um INSERT ainda não commitado apareceria e
      // o caso ficaria verde mesmo com o envio antes do commit.
      const [out, turno] = await Promise.all([
        pool.query(`SELECT count(*)::int AS n FROM outbound_messages WHERE turn_id = $1`, [turnId]),
        pool.query(`SELECT status FROM agent_turns WHERE id = $1`, [turnId]),
      ]);
      return {
        linhasOutbound: out.rows[0]!.n as number,
        statusDoTurno: (turno.rows[0]?.status as string | undefined) ?? null,
      };
    };
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    canal.fotos = [];
    canal.conectado = true;
    canal.sendText.mockReset();
    canal.sendPoll.mockReset();
    canal.sendText.mockImplementation(async () => {
      canal.fotos.push(await canal.fotografar!());
      return `3EB0${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
    });

    const c = await pool.connect();
    try {
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Sonda 631', $3, 'dono', 'ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      pessoaId = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1, $2, $3, 'ativa') RETURNING id`,
        [TENANT, AGENT, pessoaId],
      );
      conversaId = conv.rows[0]!.id;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1, $2, $3, 'in', 'texto', 'quanto eu gastei?', '{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;
      // Turno em `running` com lease VIVA — o estado exato em que a cognição
      // termina e o dispatcher é chamado.
      claimToken = randomUUID();
      const t = await c.query<{ id: string }>(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, claim_token, claimed_by, claimed_at, lease_expires_at, state_version)
         VALUES ($1, $2, $3, $4, 'running', 1, $5, 'sonda-631', now(), now() + interval '5 minutes', 3)
         RETURNING id`,
        [TENANT, AGENT, inboundId, conversaId, claimToken],
      );
      turnId = t.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterEach(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE conversa_id = $1`, [conversaId]);
      await c.query(`DELETE FROM outbound_messages WHERE conversa_id = $1`, [conversaId]);
      await c.query(`UPDATE agent_turns SET outbound_message_id = NULL WHERE id = $1`, [turnId]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE turn_id = $1`, [turnId]);
      await c.query(`DELETE FROM agent_turns WHERE id = $1`, [turnId]);
      await c.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversaId]);
      await c.query(`DELETE FROM conversas WHERE id = $1`, [conversaId]);
      await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoaId]);
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 1 — nada vai ao canal antes do banco.
  // ═══════════════════════════════════════════════════════════════════════

  it('quando o canal é chamado, a linha durável e o turno em outbound_pending JÁ estão commitados', async () => {
    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () => dispatchOutput(ctxDeDispatch('resposta ao usuário')));

    expect(canal.sendText).toHaveBeenCalledTimes(1);
    // A afirmação inteira da fatia, em duas linhas. Mover o `sendText` para
    // antes do `commitOutboundOrRefuse` faz as duas virarem 0 / 'running'.
    expect(canal.fotos).toHaveLength(1);
    expect(canal.fotos[0]).toEqual({ linhasOutbound: 1, statusDoTurno: 'outbound_pending' });

    const linhas = await linhasOutboundDoTurno();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.payload_type).toBe('text');
    expect(linhas[0]!.sequence_in_turn).toBe(0);
    expect(linhas[0]!.logical_dedupe_key).toMatch(/^mol1_[0-9a-f]{64}$/);
    // O desfecho da tentativa feita por este processo foi registrado — sem
    // isso a #632 varreria a linha e reenviaria uma mensagem já entregue.
    expect(linhas[0]!.status).toBe('delivered');
    expect(linhas[0]!.delivery_outcome).toBe('accepted_confirmed');
  });

  it('grava o evento de auditoria `outbound_committed` na MESMA transação', async () => {
    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () => dispatchOutput(ctxDeDispatch('resposta auditada')));

    const { rows } = await pool.query(
      `SELECT acao, metadata FROM audit_log
        WHERE conversa_id = $1 AND acao = 'outbound_committed'`,
      [conversaId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.turn_id).toBe(turnId);
    expect(rows[0]!.metadata.to_status).toBe('outbound_pending');
    // A trilha carrega o digest, nunca o texto: `payload_hash` é sha256 e é
    // inerte; o conteúdo não pode aparecer aqui.
    expect(rows[0]!.metadata.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('resposta auditada');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 3 — um worker SEM posse não commita resposta.
  // ═══════════════════════════════════════════════════════════════════════

  it('worker cujo claim_token não é mais o vigente NÃO commita e NÃO envia', async () => {
    // O sucessor tomou o turno: token novo na linha. O zumbi ainda carrega o
    // antigo no handle — exatamente a situação de takeover.
    await pool.query(
      `UPDATE agent_turns SET claim_token = $2, lease_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [turnId, randomUUID()],
    );
    const zumbi = handleComPosse(claimToken, 3);

    await expect(
      comoOWorkerDono(zumbi, () => dispatchOutput(ctxDeDispatch('resposta do zumbi'))),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);

    expect(canal.sendText).not.toHaveBeenCalled();
    expect(await linhasOutboundDoTurno()).toHaveLength(0);
    expect((await statusDoTurno())!.status).toBe('running');
  });

  it('worker com lease MORTA (token nulo no handle) nem chega ao banco, e não envia', async () => {
    const perdido = handleComPosse(null, 3);
    await expect(
      comoOWorkerDono(perdido, () => dispatchOutput(ctxDeDispatch('resposta sem posse'))),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);
    expect(canal.sendText).not.toHaveBeenCalled();
    expect(await linhasOutboundDoTurno()).toHaveLength(0);
    expect((await statusDoTurno())!.status).toBe('running');
  });

  it('CAS por state_version: um handle desatualizado é recusado e nada é enviado', async () => {
    // Alguém escreveu no turno depois da leitura do worker (o `state_version`
    // andou). O fence de token continua batendo — quem recusa aqui é o CAS.
    await pool.query(`UPDATE agent_turns SET state_version = state_version + 1 WHERE id = $1`, [
      turnId,
    ]);
    const desatualizado = handleComPosse(claimToken, 3);

    await expect(
      comoOWorkerDono(desatualizado, () => dispatchOutput(ctxDeDispatch('resposta velha'))),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);
    expect(canal.sendText).not.toHaveBeenCalled();
    expect(await linhasOutboundDoTurno()).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 2 + SONDA 4 — falha do ledger impede o envio, e o rollback é total.
  // ═══════════════════════════════════════════════════════════════════════

  it('falha do INSERT no outbox impede o envio E reverte a transição do turno', async () => {
    // A posição (turn_id, sequence_in_turn) = (t, 0) já está ocupada por OUTRO
    // payload. Não é idempotência — é uma segunda saída lógica disputando a
    // mesma posição —, então o unique `outbound_messages_turn_sequence_uq`
    // reprova o INSERT DENTRO da transação que acabou de mover o turno.
    //
    // É a forma mais honesta de simular "o ledger falhou": a falha nasce no
    // banco, no meio da transação de produção, e não de um mock.
    await pool.query(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel, status,
          turn_id, sequence_in_turn, payload_version, payload_type, payload_json,
          payload_hash, logical_dedupe_key, provider_idempotency_key, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, 'text', 'pending', $6, 0, 1, 'text',
               '{"type":"text","text":"ocupante"}'::jsonb, $7, $8, $9, now())`,
      [
        TENANT,
        AGENT,
        `ocupante-${randomUUID()}`,
        conversaId,
        inboundId,
        turnId,
        'b'.repeat(64),
        `mol1_${'c'.repeat(64)}`,
        `3EB0${'D'.repeat(18)}`,
      ],
    );

    const handle = handleComPosse(claimToken, 3);
    await expect(
      comoOWorkerDono(handle, () => dispatchOutput(ctxDeDispatch('resposta que nao sai'))),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);

    // (a) NADA foi ao canal. Trocar o `throw` de `commitOutboundOrRefuse` por
    //     um retorno fail-open faz esta linha reprovar.
    expect(canal.sendText).not.toHaveBeenCalled();
    // (b) O turno VOLTOU: a transição para `outbound_pending` fazia parte da
    //     MESMA transação que o INSERT. Tirar o INSERT de dentro do `withTx`
    //     deixa o turno em `outbound_pending` — e esta linha reprova.
    expect((await statusDoTurno())!.status).toBe('running');
    expect((await statusDoTurno())!.state_version).toBe(3);
    // (c) Nenhuma linha parcial: só o ocupante que o próprio teste plantou.
    const linhas = await linhasOutboundDoTurno();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.logical_dedupe_key).toBe(`mol1_${'c'.repeat(64)}`);
  });

  it('falha da AUDITORIA — depois do INSERT do artefato — reverte tudo: nem linha, nem transição', async () => {
    // ─────────────────────────────────────────────────────────────────────
    // Este caso existe porque o anterior NÃO distingue atômico de partido.
    //
    // Lá a falha nasce NO PRÓPRIO INSERT, então tirar o INSERT de dentro do
    // `withTx` produz o mesmo desfecho observável (nada persiste) e a sonda
    // volta VERDE com o defeito no lugar. Isso é um falso negativo, e a lição
    // é sobre a forma do teste: para provar que duas escritas são atômicas, a
    // falha tem de acontecer ENTRE elas.
    //
    // Aqui ela acontece: o `in_reply_to` é um UUID que NÃO existe em
    // `mensagens` (a forma de produção é uma mensagem apagada por retenção).
    // `outbound_messages` não tem FK para `mensagens` (migração 063), então o
    // INSERT do artefato PASSA; `audit_log.mensagem_id` TEM
    // (`REFERENCES mensagens(id)`, migração 001), então o `auditTx` seguinte
    // viola a FK e aborta a transação — com o artefato já inserido.
    //
    // Com o INSERT dentro do `withTx`: rollback total.
    // Com o INSERT fora (a sonda 4): a linha fica COMMITADA enquanto o turno
    // volta para `running` — uma saída lógica órfã, sem turno que a reclame.
    // ─────────────────────────────────────────────────────────────────────
    const mensagemApagada = randomUUID();
    const handle = handleComPosse(claimToken, 3);

    await expect(
      comoOWorkerDono(handle, () =>
        sendOutbound(pessoaId, conversaId, 'resposta órfã', mensagemApagada, {
          channel_id: null,
        }),
      ),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);

    expect(canal.sendText).not.toHaveBeenCalled();
    // A linha do artefato NÃO sobreviveu ao rollback.
    const { rows } = await pool.query(
      `SELECT id FROM outbound_messages WHERE in_reply_to = $1`,
      [mensagemApagada],
    );
    expect(rows).toHaveLength(0);
    // E o turno voltou: as duas escritas eram a MESMA transação.
    expect((await statusDoTurno())!.status).toBe('running');
    expect((await statusDoTurno())!.state_version).toBe(3);
    // A auditoria também não sobrou pela metade.
    const auditoria = await pool.query(
      `SELECT id FROM audit_log WHERE conversa_id = $1 AND acao = 'outbound_committed'`,
      [conversaId],
    );
    expect(auditoria.rows).toHaveLength(0);
  });

  it('o erro do commit é classificado como PRE-SEND (delivered:false), não como ambíguo', async () => {
    const zumbi = handleComPosse(null, 3);
    const erro = await comoOWorkerDono(zumbi, () =>
      dispatchOutput(ctxDeDispatch('x')).then(
        () => null,
        (e: unknown) => e as OutboundDeliveryError,
      ),
    );
    // `delivered: false` é a verdade literal (nada foi ao canal) e é o que faz
    // o caller devolver `not_sent` em vez de `sent_no_persist`. Classificar
    // como ambíguo proibiria um retry que é perfeitamente seguro.
    expect(erro).toBeInstanceOf(OutboundDeliveryError);
    expect(erro!.delivered).toBe(false);
    expect(erro!.message).toContain('outbound_commit_failed');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // IDEMPOTÊNCIA — duas tentativas da MESMA saída lógica, UMA linha.
  // ═══════════════════════════════════════════════════════════════════════

  it('duas tentativas de commitar a mesma saída lógica resultam em UMA linha', async () => {
    const texto = 'a mesma resposta, duas vezes';
    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () =>
      sendOutbound(pessoaId, conversaId, texto, inboundId, { channel_id: null }),
    );
    const depoisDaPrimeira = await linhasOutboundDoTurno();
    expect(depoisDaPrimeira).toHaveLength(1);

    // Segunda tentativa da MESMA saída: mesmo turno, mesma posição, mesmo
    // payload ⇒ mesma `logical_dedupe_key`. O handle já foi avançado pelo
    // primeiro commit (é a mesma referência), então o CAS continua batendo.
    await comoOWorkerDono(handle, () =>
      sendOutbound(pessoaId, conversaId, texto, inboundId, { channel_id: null }),
    );

    const depoisDaSegunda = await linhasOutboundDoTurno();
    expect(depoisDaSegunda).toHaveLength(1);
    expect(depoisDaSegunda[0]!.id).toBe(depoisDaPrimeira[0]!.id);
    expect(depoisDaSegunda[0]!.logical_dedupe_key).toBe(depoisDaPrimeira[0]!.logical_dedupe_key);
    // E — o ponto que "uma linha" sozinho NÃO garante — o canal foi chamado
    // UMA vez. Sem o guard `saidaLogicaJaTentada`, a segunda tentativa reusaria
    // a linha e mandaria a mensagem de novo: uma saída lógica, dois envios
    // físicos. Uma linha só não é idempotência; é contabilidade.
    expect(canal.sendText).toHaveBeenCalledTimes(1);
  });

  it('payload DIFERENTE na mesma posição não reaproveita a chave — ele é recusado', async () => {
    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () =>
      sendOutbound(pessoaId, conversaId, 'primeira', inboundId, { channel_id: null }),
    );
    canal.sendText.mockClear();

    // Mesma posição, conteúdo diferente ⇒ chave lógica diferente ⇒ o unique de
    // POSIÇÃO reprova. "Payload diferente não pode reutilizar chave
    // silenciosamente" (#506) — e a recusa impede o envio.
    await expect(
      comoOWorkerDono(handle, () =>
        sendOutbound(pessoaId, conversaId, 'segunda', inboundId, { channel_id: null }),
      ),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);
    expect(canal.sendText).not.toHaveBeenCalled();
    expect(await linhasOutboundDoTurno()).toHaveLength(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RECUPERAÇÃO — crash depois do commit e antes do enqueue.
  // ═══════════════════════════════════════════════════════════════════════

  it('no instante do envio a linha já é VISÍVEL ao recovery sem BullMQ — e em `sending`, não `pending`', async () => {
    // "Crash depois do commit e antes do enqueue" é, observacionalmente, o
    // estado que existe NO INSTANTE em que o canal é chamado: o commit já
    // aconteceu e nada depois dele rodou. Um processo morto ali deixa
    // exatamente isto no banco. Por isso a leitura acontece DENTRO do double —
    // ler depois do dispatch mediria o estado pós-bookkeeping, que é outro
    // instante e não responde a pergunta da issue.
    //
    // ─── O QUE MUDOU COM A #632, E POR QUE ISTO É A CORREÇÃO ────────────────
    //
    // Este caso afirmava `status IN ('pending','retryable')` neste instante.
    // Aquilo era a #631 tratando DOIS pontos de crash diferentes como um só:
    //
    //   crash ANTES de a chamada ao canal começar  ⇒ nada saiu, reenviar é seguro
    //   crash COM a chamada em voo                 ⇒ pode ter saído, reenviar DUPLICA
    //
    // Em `pending` os dois são indistinguíveis, e o recovery reenviaria os
    // dois. A #632 separa: `beginInlineDelivery` reivindica a linha e a move
    // para `sending` ANTES do canal, então um crash a partir daqui deixa
    // `sending` — o estado que diz "a chamada foi iniciada e o desfecho é
    // desconhecido". O primeiro ponto de crash continua deixando `pending`
    // (a falha acontece antes do claim) e continua sendo reenviável.
    //
    // A propriedade que a #631 realmente comprou — trabalho VISÍVEL ao recovery
    // sem consultar a BullMQ — continua valendo, e é o que este caso afirma
    // agora: a linha é reivindicável por takeover assim que a lease morre,
    // e nada disso passa por uma fila.
    let estadoNoEnvio: { status: string; lease_viva: boolean } | null = null;
    canal.sendText.mockImplementation(async () => {
      const { rows } = await pool.query(
        `SELECT status, (lease_expires_at > now()) AS lease_viva
           FROM outbound_messages
          WHERE tenant_id = $1 AND agent_id = $2 AND turn_id = $3`,
        [TENANT, AGENT, turnId],
      );
      estadoNoEnvio = rows[0]
        ? { status: rows[0].status as string, lease_viva: rows[0].lease_viva === true }
        : null;
      throw Object.assign(new Error('processo morreu no meio do envio'), { code: 'ECONNRESET' });
    });

    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () =>
      sendOutbound(pessoaId, conversaId, 'resposta comprometida', inboundId, {
        channel_id: null,
      }).catch(() => null),
    );

    // A linha tem DONO e está em `sending` no instante exato do efeito.
    expect(estadoNoEnvio).toEqual({ status: 'sending', lease_viva: true });

    // Ela NÃO está no estado "nunca tentada", que é o ponto: em `pending` o
    // recovery reenviaria, e aqui a chamada ao provedor já tinha começado.
    expect(estadoNoEnvio!.status).not.toBe('pending');
    // A visibilidade para o recovery vem do predicado de TAKEOVER de #632
    // (`claimed`/`sending` com lease vencida) e não da BullMQ. Que esse
    // predicado de fato recupera a linha — e a manda para `delivery_unknown`
    // em vez de reenviá-la — é o que
    // `tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts`
    // prova com o ciclo de produção inteiro; aqui só se afirma que o estado
    // deixado no instante do efeito é o que aquele predicado alcança.

    // O turno está `outbound_pending`: o ReAct NÃO pode ser reexecutado (a
    // resposta já foi comprometida) e `RECOVERABLE_TURN_STATUSES` o exclui de
    // propósito — quem finaliza é o outbox, nunca uma nova execução do
    // reasoner.
    expect((await statusDoTurno())!.status).toBe('outbound_pending');
  });

  it('transporte que LANÇA depois de iniciar o envio vira `delivery_unknown`, nunca `delivered`', async () => {
    // O processo sobreviveu, então o bookkeeping da tentativa roda — e a
    // única resposta honesta é "não sei". #506 §Resultado do provider: estado
    // incerto vai para reconciliação, jamais para reenvio cego. Marcar
    // `delivered` aqui seria inventar uma entrega; marcar `retryable` seria
    // autorizar um reenvio que pode duplicar.
    canal.sendText.mockImplementation(async () => {
      throw new Error('transporte lançou');
    });
    const handle = handleComPosse(claimToken, 3);
    await comoOWorkerDono(handle, () =>
      sendOutbound(pessoaId, conversaId, 'resposta ambígua', inboundId, {
        channel_id: null,
      }).catch(() => null),
    );

    const linhas = await linhasOutboundDoTurno();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.status).toBe('delivery_unknown');
    expect(linhas[0]!.delivery_outcome).toBe('timeout_unknown');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ISOLAMENTO — a chave lógica é por (tenant, agent).
  // ═══════════════════════════════════════════════════════════════════════

  it('o artefato derivado sob outro escopo é RECUSADO antes de tocar o banco', async () => {
    // O contexto ALS diz um tenant e o turno pertence a outro: a chave lógica
    // nasceria no espaço de unicidade errado. Fail-closed, e o canal nem é
    // consultado.
    const handle = handleComPosse(claimToken, 3);
    await expect(
      runWithTenantContext({ tenant_id: 'tenant-631-vizinho', agent_id: AGENT }, () =>
        runWithOutboundTurnScope(handle, () =>
          sendOutbound(pessoaId, conversaId, 'vazamento', inboundId, { channel_id: null }),
        ),
      ),
    ).rejects.toThrow();
    expect(canal.sendText).not.toHaveBeenCalled();
    expect(await linhasOutboundDoTurno()).toHaveLength(0);
  });
});

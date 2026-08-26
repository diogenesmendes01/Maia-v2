/**
 * Issue #632 (fatia C da épica #506) — claim, lease e fencing da ENTREGA,
 * contra Postgres REAL, entrando pelo ciclo de PRODUÇÃO.
 *
 * ## Por que integração, e por que entra por `deliverOutbound`
 *
 * As três propriedades que a issue exige são sobre CONCORRÊNCIA entre
 * declarações SQL: "exatamente um vence", "o fence antigo é rejeitado", "crash
 * depois do provider aceitar não vira reenvio". Nenhuma delas é observável num
 * harness que reconstrói a query por conta própria — um teste assim continua
 * verde mesmo que o `WHERE` de produção seja deletado, porque quem monta o SQL
 * é o teste. Aqui não há SQL montado pelo teste exceto o de FIXTURE (criar
 * pessoa/conversa/turno) e o de INSPEÇÃO (ler o estado final).
 *
 * ## O que é falsificado, e por quê
 *
 * Só o PROVEDOR — um `LineOutput` fake, injetado pelo parâmetro `line` de
 * `deliverOutbound`. Ele é a fronteira externa e é justamente o que não pode
 * ser chamado duas vezes. Ele não é passivo: conta chamadas e, num dos casos,
 * SIMULA O CRASH lendo o banco de dentro da própria chamada para provar que a
 * linha já estava em `sending` no instante do envio.
 *
 * ## ARMADILHA DO `retry: 1`, evitada de propósito
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção abaixo é INVARIANTE
 * ABSOLUTA sobre o estado final de uma linha criada NO PRÓPRIO caso (`beforeEach`
 * recria tudo), nunca um delta antes×depois sobre estado mutável compartilhado.
 * Uma segunda tentativa começa de uma linha nova, então ela não pode herdar a
 * mutação da primeira como linha de base.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  beginInlineDelivery,
  deliverOutbound,
  recordInlineDelivery,
} from '@/runtime/outbound/delivery.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import {
  DeliveryFenceError,
  __resetDeliveryWorkerIdForTest,
} from '@/runtime/outbound/delivery-contract.js';
import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';
import type { LineOutput } from '@/gateway/line-output.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'primary';
const AGENT = 'primary';
const JID = '5511900000632@s.whatsapp.net';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;
let inboundId: string;
let turnId: string;
let outboundId: string;

/** Estado de um provedor FAKE — o que ele viu e quantas vezes. */
type Provedor = {
  chamadas: number;
  /** O status da linha no instante EXATO de cada chamada, lido por conexão própria. */
  statusNoEnvio: string[];
  /** A `messageId` recebida em cada chamada — `null` quando não veio nenhuma. */
  chavesRecebidas: Array<string | null>;
  /** Quando setado, a chamada lança este erro DEPOIS de contar a chamada. */
  lancaDepoisDeAceitar: Error | null;
  conectado: boolean;
};

function novoProvedor(): Provedor {
  return {
    chamadas: 0,
    statusNoEnvio: [],
    chavesRecebidas: [],
    lancaDepoisDeAceitar: null,
    conectado: true,
  };
}

/**
 * `LineOutput` FAKE. Cada `sendText` fotografa o banco por uma conexão PRÓPRIA
 * (fora de qualquer transação do runtime), então a foto enxerga só o que já foi
 * COMMITADO — que é o único jeito de afirmar "a linha já estava em `sending`
 * quando o provedor foi chamado".
 */
function fakeLine(p: Provedor): LineOutput {
  return {
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null as unknown as string },
    async sendText(_jid: string, _text: string, opts?: { messageId?: string }) {
      p.chamadas += 1;
      p.chavesRecebidas.push(opts?.messageId ?? null);
      const { rows } = await pool.query(
        `SELECT status FROM outbound_messages WHERE id = $1`,
        [outboundId],
      );
      p.statusNoEnvio.push((rows[0]?.status as string | undefined) ?? 'ausente');
      if (p.lancaDepoisDeAceitar) throw p.lancaDepoisDeAceitar;
      return `3EB0${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
    },
    sendDocument: vi.fn(),
    sendVoice: vi.fn(),
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => p.conectado,
  } as unknown as LineOutput;
}

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);
}

async function linha(): Promise<{
  status: string;
  delivery_outcome: string | null;
  attempt: number;
  claim_token: string | null;
  claimed_by: string | null;
  next_attempt_at: string | null;
  provider_message_id: string | null;
}> {
  const { rows } = await pool.query(
    `SELECT status, delivery_outcome, attempt, claim_token, claimed_by,
            next_attempt_at, provider_message_id
       FROM outbound_messages WHERE id = $1`,
    [outboundId],
  );
  return rows[0];
}

d('#632 — claim/lease/fence da entrega (Postgres real)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 60 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    __resetDeliveryWorkerIdForTest();
    const c = await pool.connect();
    try {
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Sonda 632', $3, 'dono', 'ativa') RETURNING id`,
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
         VALUES ($1, $2, $3, 'in', 'texto', 'e a resposta?', '{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;
      const t = await c.query<{ id: string }>(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, state_version)
         VALUES ($1, $2, $3, $4, 'outbound_pending', 1, 4) RETURNING id`,
        [TENANT, AGENT, inboundId, conversaId],
      );
      turnId = t.rows[0]!.id;

      // A linha do outbox — construída pelo MESMO artefato determinístico de
      // #630 que a produção usa. Nada de chaves inventadas pelo teste: se a
      // derivação mudar, este fixture muda junto e o teste continua falando da
      // produção.
      const artefato = buildOutboundArtifact({
        tenant_id: TENANT,
        agent_id: AGENT,
        turn_id: turnId,
        sequence_in_turn: 0,
        payload: { type: 'text', text: 'a resposta durável' },
        channel: 'whatsapp',
      });
      const o = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages
           (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
            status, turn_id, sequence_in_turn, payload_version, payload_type,
            payload_json, payload_hash, logical_dedupe_key, provider_idempotency_key,
            next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,'text','pending',$6,0,$7,$8,$9::jsonb,$10,$11,$12, now())
         RETURNING id`,
        [
          TENANT,
          AGENT,
          artefato.logical_dedupe_key,
          conversaId,
          inboundId,
          turnId,
          artefato.payload_version,
          artefato.payload_type,
          JSON.stringify(artefato.payload),
          artefato.payload_hash,
          artefato.logical_dedupe_key,
          artefato.provider_idempotency_key,
        ],
      );
      outboundId = o.rows[0]!.id;
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
  // SONDA 1 — CLAIM CONCORRENTE: exatamente um vence.
  //
  // Três cardinalidades porque a JANELA MUDA DE FORMA com a contenção: com 2
  // a corrida é quase sempre resolvida antes do lock; com 50 quase todos
  // entram na fila do lock de row e saem por EvalPlanQual. Um `WHERE` que
  // funcione só no primeiro regime passaria num teste de N=2.
  // ═══════════════════════════════════════════════════════════════════════

  for (const N of [2, 10, 50]) {
    it(`${N} workers disputando a MESMA linha: exatamente um claim é concedido`, async () => {
      const resultados = await comoEscopo(() =>
        Promise.all(
          Array.from({ length: N }, () =>
            outboundDeliveryRepo.tryClaimDelivery({
              outbound_id: outboundId,
              worker_id: `sonda-${randomUUID().slice(0, 8)}`,
              lease_ms: 60_000,
            }),
          ),
        ),
      );
      const vencedores = resultados.filter((r) => r.ok);
      // INVARIANTE ABSOLUTA, não delta: exatamente 1 de N. Uma segunda
      // tentativa do vitest recria a linha no `beforeEach`, então ela não
      // herda nada da primeira.
      expect(vencedores).toHaveLength(1);
      expect(resultados.filter((r) => !r.ok)).toHaveLength(N - 1);

      const l = await linha();
      expect(l.status).toBe('claimed');
      // `attempt` prova que a declaração rodou UMA vez, não N: se dois
      // UPDATEs tivessem passado, o contador estaria em 2.
      expect(l.attempt).toBe(1);
      expect(l.claim_token).toBe(vencedores[0]!.ok ? vencedores[0]!.claim.claim_token : null);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 2 — TAKEOVER POR LEASE, e o fence antigo é REJEITADO.
  // ═══════════════════════════════════════════════════════════════════════

  it('worker antigo com lease vencida é sucedido, e o token velho NÃO confirma nem reenvia', async () => {
    const antigo = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: outboundId,
        worker_id: 'worker-antigo',
        lease_ms: 60_000,
      }),
    );
    expect(antigo.ok).toBe(true);
    const tokenAntigo = antigo.ok ? antigo.claim.claim_token : '';

    // A lease do antigo morre. Relógio do BANCO — o teste não inventa instante.
    await pool.query(
      `UPDATE outbound_messages SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [outboundId],
    );

    const novo = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: outboundId,
        worker_id: 'worker-novo',
        lease_ms: 60_000,
      }),
    );
    expect(novo.ok).toBe(true);
    const tokenNovo = novo.ok ? novo.claim.claim_token : '';
    expect(tokenNovo).not.toBe(tokenAntigo);

    // (a) O antigo NÃO CONFIRMA. `recordDeliveryOutcome` com o token velho é
    //     recusado — se passasse, ele marcaria `delivered` uma linha que o
    //     sucessor ainda vai entregar.
    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.recordDeliveryOutcome({
          outbound_id: outboundId,
          claim_token: tokenAntigo,
          outcome: 'accepted_confirmed',
          provider_message_id: '3EB0DEADBEEFDEADBEEF',
        }),
      ),
    ).rejects.toBeInstanceOf(DeliveryFenceError);

    // (b) O antigo NÃO REENVIA. `markSending` com o token velho é recusado, e
    //     é ele o portão do efeito externo.
    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.markSending({
          outbound_id: outboundId,
          claim_token: tokenAntigo,
        }),
      ),
    ).rejects.toBeInstanceOf(DeliveryFenceError);

    // (c) O antigo também não RENOVA — recuperar conectividade não devolve
    //     posse perdida.
    const renovado = await comoEscopo(() =>
      outboundDeliveryRepo.renewDeliveryLease({
        outbound_id: outboundId,
        claim_token: tokenAntigo,
        lease_ms: 60_000,
      }),
    );
    expect(renovado.ok).toBe(false);

    // (d) O sucessor manda de verdade.
    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.markSending({ outbound_id: outboundId, claim_token: tokenNovo }),
      ),
    ).resolves.toBeUndefined();

    const l = await linha();
    expect(l.status).toBe('sending');
    expect(l.claim_token).toBe(tokenNovo);
    expect(l.delivery_outcome).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 3 — CRASH DEPOIS DE O PROVIDER ACEITAR NÃO VIRA REENVIO.
  //
  // O caso mais importante da issue. O crash é simulado da forma mais fiel
  // possível: o fake provider ACEITA (retorna id), e a gravação do desfecho
  // NUNCA acontece porque o processo "morre" — o que na prática significa que
  // o teste corta o fluxo ali e a linha fica exatamente como o crash a
  // deixaria: `sending`, com lease que vai vencer.
  //
  // A falha, seguindo a armadilha aprendida na #631, precisa cair ENTRE as
  // duas escritas — e cai: `markSending` já commitou, `recordDeliveryOutcome`
  // nunca roda.
  // ═══════════════════════════════════════════════════════════════════════

  it('crash entre o aceite do provider e o registro do desfecho NÃO produz segundo envio', async () => {
    const p = novoProvedor();

    // ── ato 1: o worker que morre. Ele reivindica, marca `sending`, chama o
    //    provedor (que ACEITA) e some antes de gravar o desfecho.
    const morto = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: outboundId,
        worker_id: 'worker-que-morre',
        lease_ms: 60_000,
      }),
    );
    expect(morto.ok).toBe(true);
    await comoEscopo(() =>
      outboundDeliveryRepo.markSending({
        outbound_id: outboundId,
        claim_token: morto.ok ? morto.claim.claim_token : '',
      }),
    );
    const line = fakeLine(p);
    await line.sendText(JID, 'a resposta durável');
    expect(p.chamadas).toBe(1);
    expect(p.statusNoEnvio[0]).toBe('sending'); // o provedor foi chamado COM a linha em `sending`
    // ...e aqui o processo morre. Nada mais é gravado.

    // A lease do morto vence.
    await pool.query(
      `UPDATE outbound_messages SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [outboundId],
    );

    // ── ato 2: o sucessor roda o ciclo de PRODUÇÃO inteiro sobre a mesma linha.
    const resultado = await comoEscopo(() =>
      deliverOutbound({ outbound_id: outboundId, jid: JID, line }),
    );

    // A AFIRMAÇÃO. O provedor continua com UMA chamada: o sucessor NÃO
    // reenviou. Invariante absoluta sobre o contador do provedor deste caso.
    expect(p.chamadas).toBe(1);
    expect(resultado.delivered).toBe(false);
    expect(resultado).toMatchObject({ reason: 'takeover_of_in_flight_send' });

    // E o estado é HONESTO: não `delivered` (ninguém confirmou), não
    // `retryable` (reenviar duplicaria), e sim `delivery_unknown` — a fila da
    // reconciliação de #633.
    const l = await linha();
    expect(l.status).toBe('delivery_unknown');
    expect(l.delivery_outcome).toBe('cancelled_after_send_unknown');
    // Fora do índice de trabalho — e o que a tira de lá é o ESTADO, não o
    // timestamp: `idx_outbound_messages_ready` filtra
    // `status IN ('pending','retryable')`. (`next_attempt_at` NÃO pode ser
    // zerado: o CHECK `outbound_messages_durable_row_complete_check` da 121
    // exige que ele exista em toda row durável.)
    expect(['pending', 'retryable']).not.toContain(l.status);
    expect(l.next_attempt_at).not.toBeNull();
    // Posse liberada — nenhum worker fantasma segurando a linha.
    expect(l.claim_token).toBeNull();
    expect(l.claimed_by).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 4 — `delivered` NÃO é marcado por chamada INICIADA.
  // ═══════════════════════════════════════════════════════════════════════

  it('provedor que aceita SEM identificador termina em delivery_unknown, nunca em delivered', async () => {
    const p = novoProvedor();
    const line = fakeLine(p);
    // `sendText` devolvendo `null` com a linha CONECTADA é o caso literal de
    // "a chamada foi iniciada e retornou, e ninguém confirmou nada".
    (line as unknown as { sendText: unknown }).sendText = async (
      _j: string,
      _t: string,
      opts?: { messageId?: string },
    ) => {
      p.chamadas += 1;
      p.chavesRecebidas.push(opts?.messageId ?? null);
      return null;
    };

    const resultado = await comoEscopo(() =>
      deliverOutbound({ outbound_id: outboundId, jid: JID, line }),
    );

    expect(p.chamadas).toBe(1);
    expect(resultado.delivered).toBe(false);

    const l = await linha();
    // A asserção da issue, em duas linhas. Trocar o mapeamento de
    // `accepted_unconfirmed` para `delivered` em `delivery-contract.ts` faz as
    // duas virarem vermelho.
    expect(l.status).toBe('delivery_unknown');
    expect(l.delivery_outcome).toBe('accepted_unconfirmed');
    expect(l.status).not.toBe('delivered');
    // Nenhum carimbo de entrega: um dashboard de latência não pode contar isto.
    expect(l.provider_message_id).toBeNull();
  });

  it('o caminho FELIZ chega a completed, com histórico, e entrega a chave idempotente', async () => {
    const p = novoProvedor();
    const line = fakeLine(p);

    const resultado = await comoEscopo(() =>
      deliverOutbound({ outbound_id: outboundId, jid: JID, line }),
    );

    expect(resultado.delivered).toBe(true);
    expect(p.chamadas).toBe(1);
    // A chave idempotente do PROVEDOR chegou ao adaptador — é o que faz um
    // reenvio de texto carregar o mesmo (remoteJid, fromMe, id).
    const { rows: chaveRows } = await pool.query(
      `SELECT provider_idempotency_key FROM outbound_messages WHERE id = $1`,
      [outboundId],
    );
    expect(p.chavesRecebidas[0]).toBe(chaveRows[0]!.provider_idempotency_key);
    expect(p.chavesRecebidas[0]).toMatch(/^3EB0[0-9A-F]{18}$/);

    const l = await linha();
    expect(l.status).toBe('completed');
    expect(l.delivery_outcome).toBe('accepted_confirmed');
    expect(l.claim_token).toBeNull();

    // O HISTÓRICO existe, e existe UMA vez.
    const { rows: hist } = await pool.query(
      `SELECT conteudo, tipo FROM mensagens
        WHERE conversa_id = $1 AND direcao = 'out'`,
      [conversaId],
    );
    expect(hist).toHaveLength(1);
    // O texto é o do ARTEFATO — não uma nova renderização.
    expect(hist[0]!.conteudo).toBe('a resposta durável');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 6 — o caminho SÍNCRONO (a ponte de #634) não deixa worker fantasma.
  //
  // `beginInlineDelivery` + `recordInlineDelivery` substituem o
  // `recordInlineDeliveryOutcome` sem claim de #631. Como o dispatcher grava o
  // histórico por conta própria e PARA em `delivered`, ele não pode segurar a
  // posse — uma linha `delivered` com `claim_token` que nunca mais volta é um
  // dono fantasma, e o recovery de #633 esperaria por um worker que já foi
  // embora.
  // ═══════════════════════════════════════════════════════════════════════

  it('a ponte síncrona marca sending antes do envio e SOLTA a posse ao terminar', async () => {
    const handle = await comoEscopo(() => beginInlineDelivery(outboundId, 60_000));
    // `sending` ANTES do canal: é isto que torna o crash pós-envio
    // diagnosticável em vez de indistinguível de "nunca tentada".
    expect((await linha()).status).toBe('sending');

    await comoEscopo(() =>
      recordInlineDelivery(handle, {
        outcome: 'accepted_confirmed',
        provider_message_id: '3EB0AABBCCDDEEFF0011',
        payload_type: 'text',
      }),
    );

    const l = await linha();
    expect(l.status).toBe('delivered');
    expect(l.delivery_outcome).toBe('accepted_confirmed');
    // A posse foi SOLTA: a ponte não segue para `completed`, então segurá-la
    // deixaria a linha com um dono que nunca volta.
    expect(l.claim_token).toBeNull();
    expect(l.claimed_by).toBeNull();
    // E ainda assim ela NÃO é reivindicável — `delivered` é terminal para a
    // entrega, então nenhum worker a reenvia.
    const depois = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: outboundId,
        worker_id: 'worker-tardio',
        lease_ms: 60_000,
      }),
    );
    expect(depois).toEqual({ ok: false, reason: 'terminal' });
  });

  it('a ponte síncrona RECUSA quando um delivery worker já tem a linha', async () => {
    // O worker de verdade reivindicou primeiro, com lease VIVA.
    const worker = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: outboundId,
        worker_id: 'delivery-worker',
        lease_ms: 60_000,
      }),
    );
    expect(worker.ok).toBe(true);

    // A ponte síncrona não pode passar por cima: #631 sobrescrevia o desfecho
    // do worker sem sequer perceber, porque não havia fence nenhum.
    await expect(
      comoEscopo(() => beginInlineDelivery(outboundId, 60_000)),
    ).rejects.toBeInstanceOf(DeliveryFenceError);

    const l = await linha();
    expect(l.claim_token).toBe(worker.ok ? worker.claim.claim_token : null);
    expect(l.delivery_outcome).toBeNull();
  });

  it('uma linha em completed não é reivindicável: um segundo job não reenvia', async () => {
    const p = novoProvedor();
    const line = fakeLine(p);
    await comoEscopo(() => deliverOutbound({ outbound_id: outboundId, jid: JID, line }));
    expect(p.chamadas).toBe(1);

    // O MESMO job chega de novo (replay manual, réplica atrasada, DLQ).
    const segundo = await comoEscopo(() =>
      deliverOutbound({ outbound_id: outboundId, jid: JID, line }),
    );

    expect(p.chamadas).toBe(1); // invariante absoluta: o provedor foi tocado UMA vez
    expect(segundo.delivered).toBe(false);
    expect(segundo).toMatchObject({ reason: 'claim_not_acquired' });

    const { rows: hist } = await pool.query(
      `SELECT id FROM mensagens WHERE conversa_id = $1 AND direcao = 'out'`,
      [conversaId],
    );
    // Histórico idempotente: uma linha, não duas.
    expect(hist).toHaveLength(1);
  });
});

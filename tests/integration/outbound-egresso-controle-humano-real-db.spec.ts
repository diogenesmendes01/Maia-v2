/**
 * P04.7b (spec §8.2.4, C43) — o FENCE DE EGRESSO depois do commit, contra
 * Postgres real.
 *
 * ─── A janela que estes casos cercam ───────────────────────────────────────
 *
 * A U-P04.7a fechou o COMMIT: o turno só chega a `outbound_pending` com a
 * conversa em modo `bot`. A janela seguinte é maior e ficou aberta até aqui —
 * entre o commit e o envio existe FILA. A linha espera `next_attempt_at`, e
 * quem a envia é o drain, o recovery ou o takeover de lease, às vezes minutos
 * depois. O operador que assume a conversa nesse intervalo tinha a resposta do
 * bot saindo por cima dele.
 *
 * ─── Por que pelo CLAIM, e não por um teste de worker ──────────────────────
 *
 * `tryClaimDelivery` é o ponto ÚNICO por onde toda entrega do outbox durável
 * passa: drain, recovery e takeover chamam todos ele, e nenhum envia sem a
 * posse que ele concede. Provar o fence aqui prova os três — e prova também
 * que não existe estado intermediário em que o worker tem posse e não tem
 * autorização, porque as duas saem do MESMO `UPDATE`.
 *
 * Os casos:
 *
 *  1. conversa em `bot`: a posse é concedida, como sempre;
 *  2. humano assume DEPOIS do commit: a posse deixa de ser concedida, a linha
 *     fica intacta (HOLD, não descarte) e a recusa é `human_control`;
 *  3. `pausing` retém igual a `human` — é a janela entre o clique e a parada
 *     confirmada, e é justamente nela que um envio escaparia;
 *  4. a fala do OPERADOR passa com o humano no controle. Sem isto o remédio
 *     vira a doença: o console ficaria mudo;
 *  5. pausa e retomada: o modo volta a `bot`, o epoch avança, e a resposta
 *     escrita ANTES continua retida — ela responde a um estado da conversa que
 *     já não existe (§8.2.5);
 *  6. retomada sem que nada tenha sido escrito antes: epoch igual, posse
 *     concedida. É a contra-prova de que o caso 5 fala do EPOCH e não de
 *     "qualquer coisa que passou por uma pausa".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { __resetDeliveryWorkerIdForTest } from '@/runtime/outbound/delivery-contract.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'primary';
const AGENT = 'primary';

let pool: pg.Pool;
let conversaId: string;
let inboundId: string;
let turnId: string;
let outboundId: string;
let streamKey: string;
let canalId: string;

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);
}

function claim() {
  return comoEscopo(() =>
    outboundDeliveryRepo.tryClaimDelivery({
      outbound_id: outboundId,
      worker_id: 'spec-p04-7b',
      lease_ms: 30_000,
    }),
  );
}

/** Cria (ou move) o controle da stream deste turno. */
async function controle(input: { mode: string; epoch: number }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO conversation_controls
       (tenant_id, agent_id, stream_key, stream_key_version, channel_id, conversa_id,
        mode, control_epoch)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, agent_id, stream_key)
       DO UPDATE SET mode = EXCLUDED.mode, control_epoch = EXCLUDED.control_epoch
     RETURNING id`,
    [TENANT, AGENT, streamKey, canalId, conversaId, input.mode, input.epoch],
  );
  return rows[0]!.id;
}

/** Carimba a proveniência da linha de outbound, como o commit faria. */
async function proveniencia(input: {
  control_id: string | null;
  control_epoch: number | null;
  origin: string;
}): Promise<void> {
  await pool.query(
    `UPDATE outbound_messages
        SET control_id = $2, control_epoch = $3, origin = $4
      WHERE id = $1`,
    [outboundId, input.control_id, input.control_epoch, input.origin],
  );
}

async function linha(): Promise<{ status: string; attempt: number; claim_token: string | null }> {
  const { rows } = await pool.query(
    `SELECT status, attempt, claim_token FROM outbound_messages WHERE id = $1`,
    [outboundId],
  );
  return rows[0];
}

d('P04.7b — o egresso respeita o controle humano depois do commit', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 20 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    __resetDeliveryWorkerIdForTest();
    streamKey = `wa:p047b:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    const c = await pool.connect();
    try {
      const canal = await c.query<{ id: string }>(
        `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, active)
         VALUES ($1, $2, 'web', $3, true) RETURNING id`,
        [TENANT, AGENT, `p047b-${streamKey}`],
      );
      canalId = canal.rows[0]!.id;
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Sonda P04.7b', $3, 'dono', 'ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1, $2, $3, 'ativa') RETURNING id`,
        [TENANT, AGENT, p.rows[0]!.id],
      );
      conversaId = conv.rows[0]!.id;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1, $2, $3, 'in', 'texto', 'e a resposta?', '{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;
      // O turno PRECISA de `stream_key`: é por ela que o controle o alcança.
      const t = await c.query<{ id: string }>(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, state_version, stream_key, stream_key_version)
         VALUES ($1, $2, $3, $4, 'outbound_pending', 1, 4, $5, 1) RETURNING id`,
        [TENANT, AGENT, inboundId, conversaId, streamKey],
      );
      turnId = t.rows[0]!.id;

      const o = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages
           (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
            status, turn_id, sequence_in_turn, payload_version, payload_type,
            payload_json, payload_hash, logical_dedupe_key, provider_idempotency_key,
            next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 'whatsapp', 'pending', $6, 0, 1, 'text',
                 '{"text":"oi"}'::jsonb, $7, $3, $8, now())
         RETURNING id`,
        [
          TENANT,
          AGENT,
          `mol1_${streamKey}`,
          conversaId,
          inboundId,
          turnId,
          `hash_${streamKey}`,
          `prov_${streamKey}`,
        ],
      );
      outboundId = o.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  it('1. conversa em `bot`: a posse é concedida como sempre', async () => {
    const id = await controle({ mode: 'bot', epoch: 3 });
    await proveniencia({ control_id: id, control_epoch: 3, origin: 'bot' });
    const r = await claim();
    expect(r.ok).toBe(true);
  });

  it('2. humano assume DEPOIS do commit: HOLD, com motivo próprio', async () => {
    // O commit já aconteceu — a linha está lá, commitada em modo `bot`. A
    // tomada humana é posterior, e é exatamente a janela que esta fatia fecha.
    const id = await controle({ mode: 'bot', epoch: 3 });
    await proveniencia({ control_id: id, control_epoch: 3, origin: 'bot' });
    await controle({ mode: 'human', epoch: 4 });

    const antes = await linha();
    const r = await claim();

    expect(r).toEqual({ ok: false, reason: 'human_control' });
    // HOLD, e não descarte: a linha fica IDÊNTICA. Nem `attempt` avança — um
    // hold não pode consumir o orçamento de tentativas da DLQ.
    expect(await linha()).toEqual(antes);
  });

  it('3. `pausing` retém igual a `human` — é a janela do clique', async () => {
    const id = await controle({ mode: 'bot', epoch: 3 });
    await proveniencia({ control_id: id, control_epoch: 3, origin: 'bot' });
    await controle({ mode: 'pausing', epoch: 4 });
    expect(await claim()).toEqual({ ok: false, reason: 'human_control' });
  });

  it('4. a fala do OPERADOR passa com o humano no controle', async () => {
    // Sem esta cláusula o fence reteria justamente quem tem o controle, e o
    // console ficaria mudo.
    const id = await controle({ mode: 'human', epoch: 4 });
    await proveniencia({ control_id: id, control_epoch: 4, origin: 'operator' });
    const r = await claim();
    expect(r.ok).toBe(true);
  });

  it('5. `system` NÃO passa — lembrete automático durante atendimento humano', async () => {
    const id = await controle({ mode: 'human', epoch: 4 });
    await proveniencia({ control_id: id, control_epoch: 4, origin: 'system' });
    expect(await claim()).toEqual({ ok: false, reason: 'human_control' });
  });

  it('6. pausa E retomada: o modo volta a `bot` e a resposta VELHA segue retida', async () => {
    // O epoch incrementa no pause E no resume (migration 140). Uma resposta
    // escrita no epoch 3 responde a um estado da conversa que já não existe —
    // é o backlog que o §8.2.5 descarta em `future_only`, chegando pelo lado
    // do egresso.
    const id = await controle({ mode: 'bot', epoch: 3 });
    await proveniencia({ control_id: id, control_epoch: 3, origin: 'bot' });
    await controle({ mode: 'bot', epoch: 5 });
    expect(await claim()).toEqual({ ok: false, reason: 'human_control' });
  });

  it('7. CONTRA-PROVA: mesmo epoch depois da retomada, a posse é concedida', async () => {
    // Sem este caso, o anterior passaria por um fence que retivesse tudo que
    // um dia teve controle — o que pararia a conversa para sempre.
    const id = await controle({ mode: 'bot', epoch: 5 });
    await proveniencia({ control_id: id, control_epoch: 5, origin: 'bot' });
    const r = await claim();
    expect(r.ok).toBe(true);
  });

  it('8. linha LEGADA (sem proveniência) é retida pelo controle vivo', async () => {
    // A metade do predicado que não depende das colunas novas: uma saída
    // commitada antes da 148 não tem `control_epoch`, mas o turno dela tem
    // `stream_key` — e é por ela que o controle a alcança.
    await controle({ mode: 'human', epoch: 4 });
    await proveniencia({ control_id: null, control_epoch: null, origin: 'bot' });
    expect(await claim()).toEqual({ ok: false, reason: 'human_control' });
  });

  it('9. sem controle nenhum, nada muda: a conversa nunca foi pausada', async () => {
    await proveniencia({ control_id: null, control_epoch: null, origin: 'bot' });
    const r = await claim();
    expect(r.ok).toBe(true);
  });
});

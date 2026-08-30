/**
 * Issue #506 (auditoria de fechamento) — AS SEIS LINHAS DE AUDITORIA QUE
 * FALTAVAM, contra Postgres REAL, entrando pelos módulos de PRODUÇÃO.
 *
 * A auditoria de fechamento da épica foi literal: dos onze eventos que a
 * §Auditoria mínima lista, cinco existiam e **seis só existiam como métrica e
 * log estruturado** — `outbound.claimed`, `outbound.send_started`,
 * `outbound.delivery_unknown`, `outbound.retry_scheduled`,
 * `outbound.reconciliation_started` e `outbound.reconciled`. Métrica responde
 * "quantos"; log responde "o que aconteceu enquanto o arquivo existir". Nenhum
 * dos dois responde "reconstrua o ciclo desta linha".
 *
 * ## Por que integração, e por que entra pelo ciclo real
 *
 * A propriedade sob teste não é "a função `auditTx` funciona" — isso um unitário
 * provaria, e continuaria verde com a chamada REMOVIDA do call site de
 * produção. A propriedade é **a linha existe em `audit_logs` depois de o ciclo
 * de produção rodar**, e a única forma de afirmá-la é rodar o ciclo:
 * `deliverOutbound` (#632) para as quatro primeiras e
 * `runOutboundRecoveryForScope` (#633) para as duas últimas. O único SQL escrito
 * aqui é o de FIXTURE e o de INSPEÇÃO.
 *
 * ## A segunda metade: ATOMICIDADE
 *
 * "Auditoria que falha em silêncio é pior que auditoria ausente, porque cria a
 * impressão de rastro." As três últimas sondas provam que a trilha e a mutação
 * são a MESMA transação, e a falha é injetada no lugar em que atomicidade é
 * observável: **entre** a mutação e a auditoria. O mecanismo é o mesmo que a
 * #631 já usa — `audit_log.mensagem_id` tem FK para `mensagens` (migração 001) e
 * `outbound_messages.in_reply_to` NÃO tem (063). Apagar a mensagem faz o
 * `UPDATE` do estado passar e o `auditTx` seguinte violar a FK, com a mutação já
 * aplicada dentro da transação. Se as duas escritas forem atômicas: rollback
 * total. Se não forem: o estado avança e a trilha some.
 *
 * ## Isolamento: tenant PRÓPRIO
 *
 * Par (tenant, agent) só desta suíte, pelo mesmo motivo do arquivo de #633: as
 * contagens de `audit_log` por ação seriam deltas frágeis sob `primary/primary`,
 * que roda em paralelo com as outras suítes da épica.
 *
 * ## ARMADILHA DO `retry: 1`, evitada de propósito
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção abaixo é INVARIANTE ABSOLUTA
 * sobre linhas criadas NO PRÓPRIO caso (`beforeEach` apaga e recria tudo do
 * escopo), nunca um delta antes×depois sobre estado compartilhado. Uma segunda
 * tentativa começa de linhas novas.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { buildOutboundArtifact, type OutboundPayload } from '@/runtime/outbound/contract.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { deliverOutbound } from '@/runtime/outbound/delivery.js';
import {
  DeliveryFenceError,
  __resetDeliveryWorkerIdForTest,
} from '@/runtime/outbound/delivery-contract.js';
import {
  runOutboundRecoveryForScope,
  __resetOutboundRecoveryGaugesForTest,
} from '@/workers/outbound-recovery.js';
import { outboundDeliveryQueue } from '@/gateway/queue.js';
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';
import type { LineOutput } from '@/gateway/line-output.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't506aud';
const AGENT = 'a506aud';
const SCOPE = { tenant_id: TENANT, agent_id: AGENT };
const JID = '5511900000506@s.whatsapp.net';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(SCOPE, fn);
}

const PAYLOADS: Record<'text' | 'audio', OutboundPayload> = {
  text: { type: 'text', text: 'a resposta durável' },
  audio: {
    type: 'audio',
    media: { kind: 'local_path', path: '/tmp/voz-506.ogg' },
    mimetype: 'audio/ogg; codecs=opus',
    source_text: 'a resposta durável, em voz',
  },
};

/** Canal LEGADO da 063 por tipo — o CHECK `..._channel_check` o restringe. */
const CANAL: Record<'text' | 'audio', string> = { text: 'text', audio: 'voice' };

/**
 * `LineOutput` FAKE — a única coisa falsificada nesta suíte, e ela é a fronteira
 * externa. `id` controla o desfecho normalizado pelo caminho de PRODUÇÃO:
 *
 *   string       ⇒ `accepted_with_id`   ⇒ `accepted_confirmed`  ⇒ `delivered`
 *   null + on    ⇒ `accepted_without_id`⇒ `accepted_unconfirmed`⇒ `delivery_unknown`
 *   null + off   ⇒ `rejected_transient` ⇒ `rejected_retryable`  ⇒ `retryable`
 *
 * O teste NÃO escolhe o estado: ele escolhe o que o provedor devolve, e quem
 * decide o estado continua sendo `statusForOutcome`.
 */
function fakeLine(opts: { id: string | null; conectado?: boolean }): LineOutput {
  return {
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null as unknown as string },
    async sendText() {
      return opts.id;
    },
    sendDocument: vi.fn(),
    async sendVoice() {
      return opts.id;
    },
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => opts.conectado !== false,
  } as unknown as LineOutput;
}

type Fixture = {
  outbound_id: string;
  turn_id: string;
  /** A mensagem de ENTRADA que o turno representa. NÃO é apagável (FK do turno). */
  representativa_id: string;
  /**
   * A mensagem a que a saída responde (`in_reply_to`). É esta que as sondas de
   * atomicidade apagam para quebrar a FK de `audit_log.mensagem_id`.
   */
  in_reply_to_id: string;
};

/**
 * Turno + linha do outbox no estado pedido. Usa `buildOutboundArtifact` — o
 * MESMO derivador determinístico da produção — para que as duas chaves nunca
 * sejam inventadas pelo teste.
 *
 * DUAS mensagens de propósito: `agent_turns.representative_message_id` tem FK
 * para `mensagens`, então a mensagem do turno não pode ser apagada. A do
 * `in_reply_to` pode, e é o que torna a sonda de atomicidade possível.
 */
async function criarLinha(opts: {
  tipo?: 'text' | 'audio';
  status: string;
  delivery_outcome?: string | null;
  attempt?: number;
  idade_s?: number;
}): Promise<Fixture> {
  const tipo = opts.tipo ?? 'text';
  const c = await pool.connect();
  try {
    const m1 = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','e a resposta?','{"remote_jid":"${JID}"}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const m2 = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','a que se responde','{"remote_jid":"${JID}"}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const t = await c.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          attempt_count, state_version)
       VALUES ($1,$2,$3,$4,'outbound_pending',1,4) RETURNING id`,
      [TENANT, AGENT, m1.rows[0]!.id, conversaId],
    );
    const turn_id = t.rows[0]!.id;
    const artefato = buildOutboundArtifact({
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id,
      sequence_in_turn: 0,
      payload: PAYLOADS[tipo],
      channel: 'whatsapp',
    });
    const o = await c.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
          status, delivery_outcome, attempt, turn_id, sequence_in_turn,
          payload_version, payload_type, payload_json, payload_hash,
          logical_dedupe_key, provider_idempotency_key, next_attempt_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13::jsonb,$14,$15,$16,
               now(), now() - make_interval(secs => $17))
       RETURNING id`,
      [
        TENANT,
        AGENT,
        artefato.logical_dedupe_key,
        conversaId,
        m2.rows[0]!.id,
        CANAL[tipo],
        opts.status,
        opts.delivery_outcome ?? null,
        opts.attempt ?? 0,
        turn_id,
        artefato.payload_version,
        artefato.payload_type,
        JSON.stringify(artefato.payload),
        artefato.payload_hash,
        artefato.logical_dedupe_key,
        artefato.provider_idempotency_key,
        opts.idade_s ?? 0,
      ],
    );
    return {
      outbound_id: o.rows[0]!.id,
      turn_id,
      representativa_id: m1.rows[0]!.id,
      in_reply_to_id: m2.rows[0]!.id,
    };
  } finally {
    c.release();
  }
}

async function linha(id: string) {
  const { rows } = await pool.query(
    `SELECT status, delivery_outcome, attempt, claim_token, next_attempt_at
       FROM outbound_messages WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    delivery_outcome: string | null;
    attempt: number;
    claim_token: string | null;
    next_attempt_at: string | null;
  };
}

/** As linhas de auditoria de uma ação, no escopo desta suíte. */
async function trilha(acao: string, alvo_id?: string) {
  const { rows } = await pool.query(
    `SELECT acao, alvo_id, entidade_alvo, conversa_id, mensagem_id, metadata
       FROM audit_log
      WHERE tenant_id = $1 AND agent_id = $2 AND acao = $3
        AND ($4::uuid IS NULL OR alvo_id = $4::uuid)
      ORDER BY created_at`,
    [TENANT, AGENT, acao, alvo_id ?? null],
  );
  return rows as Array<{
    acao: string;
    alvo_id: string | null;
    entidade_alvo: string | null;
    conversa_id: string | null;
    mensagem_id: string | null;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Torna a AUDITORIA da próxima transição impossível, sem tocar no `UPDATE` que
 * a precede: apaga a mensagem para a qual `audit_log.mensagem_id` aponta.
 *
 * É a forma de produção de "mensagem apagada por retenção", e é exatamente a
 * injeção que a #631 já usa. Precisa limpar as linhas de auditoria anteriores
 * antes — elas próprias referenciam a mensagem.
 */
async function tornarAuditoriaImpossivel(in_reply_to_id: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM audit_log WHERE mensagem_id = $1`, [in_reply_to_id]);
    await c.query(`DELETE FROM mensagens WHERE id = $1`, [in_reply_to_id]);
  } finally {
    c.release();
  }
}

/** Os jobs armados por esta suíte — o único escopo que ela pode limpar. */
const armados = new Set<string>();

d('#506 — as seis linhas de auditoria do ciclo outbound (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 20 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'sonda 506 auditoria')
         ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 506 auditoria')
         ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda 506',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      pessoaId = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1,$2,$3,'ativa') RETURNING id`,
        [TENANT, AGENT, pessoaId],
      );
      conversaId = conv.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM conversas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    } finally {
      c.release();
    }
    for (const id of armados) {
      await outboundDeliveryQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    await outboundDeliveryQueue.close().catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    __resetDeliveryWorkerIdForTest();
    __resetOutboundRecoveryGaugesForTest();
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1 AND conversa_id = $2`, [
        TENANT,
        conversaId,
      ]);
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 + 2 — `outbound.claimed` e `outbound.send_started`, pelo ciclo REAL.
  //
  // As duas juntas num caso só porque a propriedade que importa é a ORDEM:
  // a posse precede o `sending`, e o `sending` precede o adaptador. Uma trilha
  // que tivesse as duas em qualquer ordem não reconstruiria o ciclo.
  // ═══════════════════════════════════════════════════════════════════════

  it('o ciclo de entrega grava `outbound_claimed` e `outbound_send_started`', async () => {
    const f = await criarLinha({ status: 'pending' });
    const r = await comoEscopo(() =>
      deliverOutbound({
        outbound_id: f.outbound_id,
        jid: JID,
        line: fakeLine({ id: '3EB0AAAABBBBCCCCDDDD' }),
      }),
    );
    expect(r.delivered).toBe(true);

    const claimed = await trilha('outbound_claimed', f.outbound_id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.entidade_alvo).toBe('outbound_messages');
    expect(claimed[0]!.conversa_id).toBe(conversaId);
    expect(claimed[0]!.mensagem_id).toBe(f.in_reply_to_id);
    expect(claimed[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      turn_id: f.turn_id,
      payload_type: 'text',
      // `attempt` DEPOIS do incremento — é a tentativa que a posse autoriza.
      attempt: 1,
      status_after_claim: 'claimed',
    });
    expect(typeof claimed[0]!.metadata['worker_id']).toBe('string');

    const started = await trilha('outbound_send_started', f.outbound_id);
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      turn_id: f.turn_id,
      from_status: 'claimed',
      to_status: 'sending',
      attempt: 1,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — `outbound.delivery_unknown`.
  //
  // O evento central da issue: "estados incertos não são reenviados cegamente".
  // O provedor ACEITOU e não devolveu id, com a linha conectada — o desfecho
  // honesto é `accepted_unconfirmed`, e a trilha tem de registrar a INCERTEZA,
  // não uma falha.
  // ═══════════════════════════════════════════════════════════════════════

  it('desfecho da família DESCONHECIDA grava `outbound_delivery_unknown`', async () => {
    const f = await criarLinha({ status: 'pending' });
    await comoEscopo(() =>
      deliverOutbound({
        outbound_id: f.outbound_id,
        jid: JID,
        line: fakeLine({ id: null, conectado: true }),
      }),
    );
    expect((await linha(f.outbound_id)).status).toBe('delivery_unknown');

    const t = await trilha('outbound_delivery_unknown', f.outbound_id);
    expect(t).toHaveLength(1);
    expect(t[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      outcome: 'accepted_unconfirmed',
      status: 'delivery_unknown',
      payload_type: 'text',
      attempt: 1,
    });
    // E NÃO existe trilha de retry: um desfecho incerto não agenda reenvio.
    expect(await trilha('outbound_retry_scheduled', f.outbound_id)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 — `outbound.retry_scheduled`.
  //
  // Linha DESCONECTADA ⇒ nada saiu ⇒ recusa transitória ⇒ `retryable` com
  // `next_attempt_at` carimbado pelo relógio do BANCO. O par
  // (attempt, retry_in_seconds) na trilha é o que torna auditável a afirmação
  // "o backoff é exponencial e tem teto".
  // ═══════════════════════════════════════════════════════════════════════

  it('desfecho retentável grava `outbound_retry_scheduled` com o backoff do BANCO', async () => {
    const f = await criarLinha({ status: 'pending' });
    await comoEscopo(() =>
      deliverOutbound({
        outbound_id: f.outbound_id,
        jid: JID,
        line: fakeLine({ id: null, conectado: false }),
      }),
    );
    const l = await linha(f.outbound_id);
    expect(l.status).toBe('retryable');

    const t = await trilha('outbound_retry_scheduled', f.outbound_id);
    expect(t).toHaveLength(1);
    expect(t[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      outcome: 'rejected_retryable',
      status: 'retryable',
      last_error_code: 'channel_disconnected',
      attempt: 1,
    });
    expect(Number(t[0]!.metadata['retry_in_seconds'])).toBeGreaterThan(0);
    // O instante da trilha é o MESMO que o gate do banco usa. Recalculá-lo em
    // JS gravaria um horário que `next_attempt_at` não conhece.
    expect(new Date(String(t[0]!.metadata['next_attempt_at'])).getTime()).toBe(
      new Date(l.next_attempt_at!).getTime(),
    );
    expect(await trilha('outbound_delivery_unknown', f.outbound_id)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 — `outbound.reconciliation_started`, pela varredura REAL.
  //
  // `audio` não tem chave nativa no Baileys, então a única saída de uma linha
  // incerta é a fila HUMANA. A trilha registra o FUNDAMENTO da espera.
  // ═══════════════════════════════════════════════════════════════════════

  it('a escalada para a fila humana grava `outbound_reconciliation_started`', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
      attempt: 2,
      idade_s: 2 * 3600,
    });
    armados.add(outboundDeliveryJobId(f.outbound_id));
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(f.outbound_id)).status).toBe('reconciling');
    const t = await trilha('outbound_reconciliation_started', f.outbound_id);
    expect(t).toHaveLength(1);
    expect(t[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      payload_type: 'audio',
      delivery_outcome: 'timeout_unknown',
      from_status: 'delivery_unknown',
      to_status: 'reconciling',
      escalation_reason: 'provider_idempotency_unavailable_for_payload_type',
    });

    // Idempotência da TRILHA: um segundo tick não escreve outra linha, porque
    // o CAS `status = 'delivery_unknown'` já não passa.
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(await trilha('outbound_reconciliation_started', f.outbound_id)).toHaveLength(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6a — `outbound.reconciled`, resultado `resend_idempotent`.
  //
  // A ÚNICA escrita da recuperação que autoriza efeito externo repetido. É a
  // que menos pode acontecer sem trilha: "por que esta mensagem saiu duas
  // vezes?" só tem resposta se existir a linha que diz quem autorizou.
  // ═══════════════════════════════════════════════════════════════════════

  it('o reenvio idempotente grava `outbound_reconciled` dizendo que a CHAVE é a mesma', async () => {
    const f = await criarLinha({
      tipo: 'text',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
      attempt: 1,
      idade_s: 2 * 3600,
    });
    armados.add(outboundDeliveryJobId(f.outbound_id));
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(f.outbound_id)).status).toBe('retryable');
    const t = await trilha('outbound_reconciled', f.outbound_id);
    expect(t).toHaveLength(1);
    expect(t[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      result: 'resend_idempotent',
      from_status: 'delivery_unknown',
      to_status: 'retryable',
      delivery_outcome: 'timeout_unknown',
      reuses_provider_idempotency_key: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6b — `outbound.reconciled`, resultado `history_fabricated`.
  //
  // A janela `delivered -> completed`: o processo que enviou morreu, o
  // histórico foi PROJETADO do artefato imutável e nada foi reenviado. A trilha
  // precisa dizer as duas coisas — de onde veio o histórico e que o provedor
  // NÃO foi tocado —, porque é o par que separa recuperação de duplicata.
  // ═══════════════════════════════════════════════════════════════════════

  it('a recuperação do histórico órfão grava `outbound_reconciled` sem tocar o provedor', async () => {
    const f = await criarLinha({
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
      attempt: 1,
      idade_s: 5 * 60,
    });
    armados.add(outboundDeliveryJobId(f.outbound_id));
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(f.outbound_id)).status).toBe('completed');
    const t = await trilha('outbound_reconciled', f.outbound_id);
    expect(t).toHaveLength(1);
    expect(t[0]!.metadata).toMatchObject({
      outbound_id: f.outbound_id,
      result: 'history_fabricated',
      from_status: 'delivered',
      to_status: 'completed',
      provider_contacted: false,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ATOMICIDADE — a auditoria que falha REVERTE a mutação.
  //
  // Três sondas, uma por transição do caminho quente. A falha é injetada
  // ENTRE o `UPDATE` e o `auditTx` (ver `tornarAuditoriaImpossivel`), que é a
  // única posição em que atomicidade é observável: uma falha no próprio UPDATE
  // produziria o mesmo desfecho visível com as duas escritas SEPARADAS.
  // ═══════════════════════════════════════════════════════════════════════

  it('auditoria impossível REVERTE o claim: a posse não é concedida', async () => {
    const f = await criarLinha({ status: 'pending' });
    await tornarAuditoriaImpossivel(f.in_reply_to_id);

    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.tryClaimDelivery({
          outbound_id: f.outbound_id,
          worker_id: 'sonda-atomica',
          lease_ms: 60_000,
        }),
      ),
    ).rejects.toThrow();

    const l = await linha(f.outbound_id);
    // O `UPDATE` do claim já tinha rodado dentro da transação: sem atomicidade,
    // `status` seria `claimed` e `attempt` seria 1.
    expect(l.status).toBe('pending');
    expect(l.attempt).toBe(0);
    expect(l.claim_token).toBeNull();
    expect(await trilha('outbound_claimed', f.outbound_id)).toHaveLength(0);
  });

  it('auditoria impossível REVERTE o `sending`: nada vai ao adaptador sem trilha', async () => {
    const f = await criarLinha({ status: 'pending' });
    const claim = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: f.outbound_id,
        worker_id: 'sonda-atomica',
        lease_ms: 60_000,
      }),
    );
    expect(claim.ok).toBe(true);
    // A mensagem some DEPOIS do claim — a forma de produção é retenção rodando
    // entre uma transição e a seguinte.
    await tornarAuditoriaImpossivel(f.in_reply_to_id);

    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.markSending({
          outbound_id: f.outbound_id,
          claim_token: claim.ok ? claim.claim.claim_token : '',
        }),
      ),
    ).rejects.toThrow();

    // `claimed`, e NÃO `sending`. A diferença é operacional e é o ponto inteiro
    // de #632: `claimed` significa "nada saiu" e é reivindicável de novo;
    // `sending` significaria "a chamada foi iniciada" e proibiria o reenvio.
    expect((await linha(f.outbound_id)).status).toBe('claimed');
    expect(await trilha('outbound_send_started', f.outbound_id)).toHaveLength(0);
  });

  it('auditoria impossível REVERTE o desfecho: a linha fica `sending`, não `retryable`', async () => {
    const f = await criarLinha({ status: 'pending' });
    const claim = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: f.outbound_id,
        worker_id: 'sonda-atomica',
        lease_ms: 60_000,
      }),
    );
    expect(claim.ok).toBe(true);
    const token = claim.ok ? claim.claim.claim_token : '';
    await comoEscopo(() =>
      outboundDeliveryRepo.markSending({ outbound_id: f.outbound_id, claim_token: token }),
    );
    await tornarAuditoriaImpossivel(f.in_reply_to_id);

    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.recordDeliveryOutcome({
          outbound_id: f.outbound_id,
          claim_token: token,
          outcome: 'rejected_retryable',
          last_error_code: 'channel_disconnected',
          retry_in_seconds: 5,
        }),
      ),
    ).rejects.toThrow();

    const l = await linha(f.outbound_id);
    // `sending` é o estado HONESTO quando o desfecho não pôde ser registrado:
    // a chamada foi iniciada e ninguém sabe o que aconteceu. A reconciliação de
    // #633 pega a linha e NÃO reenvia — que é melhor do que um `retryable` sem
    // trilha, porque `retryable` autorizaria o reenvio.
    expect(l.status).toBe('sending');
    expect(l.delivery_outcome).toBeNull();
    expect(await trilha('outbound_retry_scheduled', f.outbound_id)).toHaveLength(0);
    // E a exceção NÃO é a de fence: quem falhou foi a auditoria, e confundir as
    // duas faria o call site tratar perda de trilha como perda de posse.
    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.recordDeliveryOutcome({
          outbound_id: f.outbound_id,
          claim_token: randomUUID(),
          outcome: 'rejected_retryable',
        }),
      ),
    ).rejects.toBeInstanceOf(DeliveryFenceError);
  });
});

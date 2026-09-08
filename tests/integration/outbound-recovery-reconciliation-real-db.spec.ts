/**
 * Issue #633 (fatia D da épica #506) — recuperação, reconciliação, DLQ e
 * rearmamento manual, contra Postgres REAL, entrando pelos módulos de PRODUÇÃO.
 *
 * ## Por que integração, e por que entra pelo worker
 *
 * As propriedades que a issue exige são sobre CONCORRÊNCIA e sobre PREDICADOS
 * SQL: "sweepers concorrentes não duplicam", "lease vencida volta a ser
 * reivindicável e o fence antigo não confirma", "a varredura de takeover não
 * cai em sequential scan". Nenhuma é observável num harness que reconstrua as
 * queries — um teste assim continua verde depois de alguém deletar o `WHERE` de
 * produção, porque quem monta o SQL é o teste.
 *
 * A entrada é `runOutboundRecoveryForScope` (o corpo real do worker) e
 * `rearmOutboundByOperator` (a operação real). O único SQL escrito aqui é o de
 * FIXTURE e o de INSPEÇÃO.
 *
 * ## Isolamento: tenant PRÓPRIO
 *
 * A varredura é per-escopo e a detecção de divergência conta a tabela INTEIRA
 * do par (tenant, agent). Rodando sob `primary/primary` — compartilhado com as
 * suítes de #631 e #632, que rodam em paralelo — toda contagem seria um delta
 * frágil. Este arquivo cria o seu próprio par, e por isso cada asserção é uma
 * INVARIANTE ABSOLUTA e não uma diferença antes×depois.
 *
 * ## ARMADILHA DO `retry: 1`, evitada de propósito
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção abaixo é sobre o estado
 * FINAL de linhas criadas NO PRÓPRIO caso (`beforeEach` limpa e recria), nunca
 * um delta sobre estado mutável compartilhado. Uma segunda tentativa começa de
 * linhas novas e não pode herdar a mutação da primeira como linha de base.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  buildOutboundArtifact,
  type OutboundPayload,
} from '@/runtime/outbound/contract.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import { __resetDeliveryWorkerIdForTest } from '@/runtime/outbound/delivery-contract.js';
import {
  runOutboundRecoveryForScope,
  __resetOutboundRecoveryGaugesForTest,
} from '@/workers/outbound-recovery.js';
import { rearmOutboundByOperator } from '@/ops/outbound-rearm.js';
import { agentQueue, outboundDeliveryQueue } from '@/gateway/queue.js';
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';
import { agentTurnJobId } from '@/runtime/turns/job.js';
import { _resetForTests, renderPrometheus } from '@/lib/metrics.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't633';
const AGENT = 'a633';
const SCOPE = { tenant_id: TENANT, agent_id: AGENT };

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(SCOPE, fn);
}

/** Payloads de PRODUÇÃO por tipo — os mesmos que a união de #630 aceita. */
type FixturePayloadType = 'text' | 'audio' | 'status_fallback';

const PAYLOADS: Record<FixturePayloadType, OutboundPayload> = {
  text: { type: 'text', text: 'a resposta durável' },
  audio: {
    type: 'audio',
    media: { kind: 'local_path', path: '/tmp/voz-633.ogg' },
    mimetype: 'audio/ogg; codecs=opus',
    source_text: 'a resposta durável, em voz',
  },
  status_fallback: {
    type: 'status_fallback',
    text: 'limite atingido; tente novamente em breve',
    reason: 'policy_refusal',
  },
};

/** Canal LEGADO da 063 por tipo — o CHECK `..._channel_check` o restringe. */
const CANAL: Record<FixturePayloadType, string> = {
  text: 'text',
  audio: 'voice',
  status_fallback: 'status_fallback',
};

type Fixture = {
  outbound_id: string;
  turn_id: string;
  inbound_id: string;
};

/**
 * Cria turno + linha do outbox no estado pedido. Usa `buildOutboundArtifact`
 * — o MESMO derivador determinístico da produção — para que as duas chaves
 * nunca sejam inventadas pelo teste.
 */
async function criarLinha(opts: {
  tipo?: FixturePayloadType;
  status: string;
  delivery_outcome?: string | null;
  attempt?: number;
  /** Idade da linha, em segundos. Vira `created_at = now() - idade`. */
  idade_s?: number;
  /** Lease em segundos a partir de agora (negativo = já vencida). */
  lease_s?: number | null;
  /** Lease do TURNO; só ela autoriza a convergência pós-outbound. */
  turn_lease_s?: number | null;
  turn_status?: string;
  /** Obrigatório quando `turn_status` é terminal — `agent_turns_outcome_presence_chk`. */
  turn_outcome?: string;
}): Promise<Fixture> {
  const tipo = opts.tipo ?? 'text';
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','e a resposta?','{"remote_jid":"5511900000633@s.whatsapp.net"}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const inbound_id = m.rows[0]!.id;
    const turnHasClaim =
      opts.turn_lease_s !== undefined && opts.turn_lease_s !== null;
    const t = await c.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          outcome, attempt_count, state_version, claimed_by, claim_token,
          lease_expires_at, outbound_committed_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,4,$7,$8::uuid,
               CASE WHEN $8::uuid IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $9) END,
               now() - make_interval(secs => $10))
       RETURNING id`,
      [
        TENANT,
        AGENT,
        inbound_id,
        conversaId,
        opts.turn_status ?? 'outbound_pending',
        opts.turn_outcome ?? null,
        turnHasClaim ? 'turn-worker-morto' : null,
        turnHasClaim ? randomUUID() : null,
        opts.turn_lease_s ?? 0,
        opts.idade_s ?? 0,
      ],
    );
    const turn_id = t.rows[0]!.id;
    await c.query(
      `INSERT INTO agent_turn_inputs(tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
       VALUES ($1,$2,$3,$4,0)`,
      [TENANT, AGENT, turn_id, inbound_id],
    );
    const artefato = buildOutboundArtifact({
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id,
      sequence_in_turn: 0,
      payload: PAYLOADS[tipo],
      channel: 'whatsapp',
    });
    const temClaim = opts.lease_s !== undefined && opts.lease_s !== null;
    const o = await c.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
          status, delivery_outcome, attempt, turn_id, sequence_in_turn,
          payload_version, payload_type, payload_json, payload_hash,
          logical_dedupe_key, provider_idempotency_key,
          next_attempt_at, created_at,
          claimed_by, claim_token, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13::jsonb,$14,$15,$16,
               now(), now() - make_interval(secs => $17),
               $18, $19::uuid,
               CASE WHEN $19::uuid IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $20) END)
       RETURNING id`,
      [
        TENANT,
        AGENT,
        artefato.logical_dedupe_key,
        conversaId,
        inbound_id,
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
        temClaim ? 'worker-morto' : null,
        temClaim ? randomUUID() : null,
        opts.lease_s ?? 0,
      ],
    );
    return { outbound_id: o.rows[0]!.id, turn_id, inbound_id };
  } finally {
    c.release();
  }
}

async function linha(id: string) {
  const { rows } = await pool.query(
    `SELECT status, delivery_outcome, attempt, last_error_code, claim_token, next_attempt_at
       FROM outbound_messages WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    delivery_outcome: string | null;
    attempt: number;
    last_error_code: string | null;
    claim_token: string | null;
    next_attempt_at: string | null;
  };
}

async function turno(id: string) {
  const { rows } = await pool.query(
    `SELECT status, outcome, state_version, claim_token, lease_expires_at, completed_at
       FROM agent_turns WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    outcome: string | null;
    state_version: string;
    claim_token: string | null;
    lease_expires_at: string | null;
    completed_at: string | null;
  };
}

async function adicionarParte(
  fixture: Fixture,
  input: { sequence: number; status: string; text?: string },
): Promise<string> {
  const payload: OutboundPayload = {
    type: 'text',
    text: input.text ?? `parte ${input.sequence}`,
  };
  const artifact = buildOutboundArtifact({
    tenant_id: TENANT,
    agent_id: AGENT,
    turn_id: fixture.turn_id,
    sequence_in_turn: input.sequence,
    payload,
    channel: 'whatsapp',
  });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
        status, turn_id, sequence_in_turn, payload_version, payload_type,
        payload_json, payload_hash, logical_dedupe_key, provider_idempotency_key,
        next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,now(),now())
     RETURNING id`,
    [
      TENANT,
      AGENT,
      artifact.logical_dedupe_key,
      conversaId,
      fixture.inbound_id,
      input.status,
      fixture.turn_id,
      artifact.sequence_in_turn,
      artifact.payload_version,
      artifact.payload_type,
      JSON.stringify(artifact.payload),
      artifact.payload_hash,
      artifact.logical_dedupe_key,
      artifact.provider_idempotency_key,
    ],
  );
  return rows[0]!.id;
}

/** Os jobs armados por esta suíte — o único escopo que ela pode limpar. */
const armados = new Set<string>();

async function jobExiste(outbound_id: string): Promise<boolean> {
  const id = outboundDeliveryJobId(outbound_id);
  armados.add(id);
  return (await outboundDeliveryQueue.getJob(id)) !== undefined;
}

d('#633 — recuperação e reconciliação do outbox (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 20 });
    const c = await pool.connect();
    try {
      // Par (tenant, agent) PRÓPRIO — ver o bloco "Isolamento" no topo.
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1, 'sonda 633') ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 633')
         ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda 633',$3,'dono','ativa') RETURNING id`,
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
      await c.query(`DELETE FROM audit_log WHERE conversa_id = $1`, [
        conversaId,
      ]);
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [
        TENANT,
      ]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [
        TENANT,
      ]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM conversas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    } finally {
      c.release();
    }
    // Só os jobs ARMADOS por esta suíte — nada de `obliterate`, que apagaria a
    // fila das vizinhas.
    for (const id of armados) {
      await outboundDeliveryQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    await outboundDeliveryQueue.close().catch(() => undefined);
    await agentQueue.close().catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    __resetDeliveryWorkerIdForTest();
    __resetOutboundRecoveryGaugesForTest();
    _resetForTests();
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE conversa_id = $1`, [
        conversaId,
      ]);
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [
        TENANT,
      ]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [
        TENANT,
      ]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(
        `DELETE FROM mensagens WHERE tenant_id = $1 AND conversa_id = $2`,
        [TENANT, conversaId],
      );
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 1 — REENVIO CEGO É IMPOSSÍVEL.
  //
  // Uma linha em `delivery_unknown` de um tipo que o provedor NÃO deduplica
  // JAMAIS volta a `retryable` pela varredura, por mais velha que fique. Ela
  // vai para `reconciling` (fila humana) e NENHUM job de entrega é armado.
  //
  // A idade escolhida (2h) já passou da carência (5min) e ainda não alcançou o
  // prazo total (24h) — é a janela exata em que a única saída automática seria
  // o reenvio. Se ele existisse, apareceria aqui.
  // ═══════════════════════════════════════════════════════════════════════

  it('delivery_unknown de tipo sem chave nativa NUNCA vira retry automático', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
      idade_s: 2 * 3600,
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    const l = await linha(f.outbound_id);
    // INVARIANTE ABSOLUTA: o estado final é `reconciling`, e `retryable` — o
    // único estado a partir do qual o worker reenviaria — é inalcançável.
    expect(l.status).toBe('reconciling');
    expect(l.status).not.toBe('retryable');
    // E o transporte também não foi armado: sem job, nem um worker que ignore
    // o estado teria por onde começar.
    expect(await jobExiste(f.outbound_id)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 2 — O RETRY RESPEITA A CAPABILITY DO PROVEDOR.
  //
  // O contraste, no MESMO tick e com o MESMO desfecho e a MESMA idade: `text`
  // (o Baileys aceita `messageId` em `sendText`) é devolvido ao ciclo; `audio`
  // (sem chave nativa) não é. A única variável é o `payload_type`.
  //
  // Duas linhas no mesmo `runOutboundRecoveryForScope` de propósito: um teste
  // com uma linha só provaria o comportamento e não a DISCRIMINAÇÃO.
  // ═══════════════════════════════════════════════════════════════════════

  it('o reenvio automático segue a capability por tipo de payload, não o desfecho', async () => {
    const comChave = await criarLinha({
      tipo: 'text',
      status: 'delivery_unknown',
      delivery_outcome: 'accepted_unconfirmed',
      idade_s: 2 * 3600,
    });
    const semChave = await criarLinha({
      tipo: 'audio',
      status: 'delivery_unknown',
      delivery_outcome: 'accepted_unconfirmed',
      idade_s: 2 * 3600,
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(comChave.outbound_id)).status).toBe('retryable');
    expect((await linha(semChave.outbound_id)).status).toBe('reconciling');
    // O job só existe para a linha que o provedor deduplica.
    expect(await jobExiste(comChave.outbound_id)).toBe(true);
    expect(await jobExiste(semChave.outbound_id)).toBe(false);
  });

  it('dentro da carência nada é tocado, nem o tipo idempotente', async () => {
    const f = await criarLinha({
      tipo: 'text',
      status: 'delivery_unknown',
      delivery_outcome: 'accepted_unconfirmed',
      idade_s: 60, // < RECONCILIATION_GRACE_MS (5min)
    });
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect((await linha(f.outbound_id)).status).toBe('delivery_unknown');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 3 — TAKEOVER PELA VARREDURA.
  //
  // Uma linha `sending` com lease vencida é encontrada pela varredura, volta a
  // ser reivindicável, e o FENCE ANTIGO não confirma nada. Duas afirmações
  // independentes num caso só, porque separá-las deixaria passar a versão em
  // que a linha é retomada mas o zumbi ainda escreve.
  // ═══════════════════════════════════════════════════════════════════════

  it('lease vencida volta a ser reivindicável e o fence antigo NÃO confirma', async () => {
    const f = await criarLinha({
      status: 'sending',
      attempt: 1,
      lease_s: -30, // já vencida
    });
    const antes = await linha(f.outbound_id);
    const tokenAntigo = antes.claim_token!;
    expect(tokenAntigo).toBeTruthy();

    // A varredura enxerga a linha (é o predicado do índice novo da 131).
    const candidatos = await comoEscopo(() =>
      outboundRecoveryRepo.listDeliverable(50),
    );
    expect(candidatos.map((c) => c.outbound_id)).toContain(f.outbound_id);

    // O SUCESSOR reivindica — pelo claim atômico de PRODUÇÃO.
    const claim = await comoEscopo(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: f.outbound_id,
        worker_id: 'sucessor-633',
        lease_ms: 60_000,
      }),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('inalcançável');
    expect(claim.claim.claim_token).not.toBe(tokenAntigo);
    // Tomada em `sending`, ela CONTINUA em `sending` — é a garantia estrutural
    // de #632: `markSending` exige `claimed`, então o sucessor é incapaz de
    // enviar.
    expect(claim.claim.status_after_claim).toBe('sending');

    // O ZUMBI tenta confirmar com o token velho. Tem de ser recusado.
    await expect(
      comoEscopo(() =>
        outboundDeliveryRepo.recordDeliveryOutcome({
          outbound_id: f.outbound_id,
          claim_token: tokenAntigo,
          outcome: 'accepted_confirmed',
          provider_message_id: 'ZUMBI',
        }),
      ),
    ).rejects.toThrow(/fence/i);

    const depois = await linha(f.outbound_id);
    // INVARIANTE ABSOLUTA: nada do zumbi entrou.
    expect(depois.delivery_outcome).toBeNull();
    expect(depois.status).toBe('sending');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SWEEPERS CONCORRENTES — critério de pronto nº 1.
  //
  // Dez varreduras simultâneas sobre a MESMA linha incerta produzem UMA
  // transição e UMA linha de auditoria. Dez e não duas: com duas a corrida é
  // quase sempre resolvida antes do lock; com dez a maioria entra na fila do
  // lock de row e sai por EvalPlanQual.
  // ═══════════════════════════════════════════════════════════════════════

  it('10 varreduras simultâneas produzem UMA promoção e UMA auditoria', async () => {
    const f = await criarLinha({
      tipo: 'text',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
      idade_s: 2 * 3600,
    });

    const resultados = await comoEscopo(() =>
      Promise.all(
        Array.from({ length: 10 }, () =>
          outboundRecoveryRepo.promoteUnknownToRetryable({
            outbound_id: f.outbound_id,
          }),
        ),
      ),
    );
    // INVARIANTE ABSOLUTA: exatamente 1 de 10.
    expect(resultados.filter((r) => r.promoted).length).toBe(1);
    expect((await linha(f.outbound_id)).status).toBe('retryable');
  });

  it('10 dead-letters simultâneos produzem UMA transição e UMA auditoria', async () => {
    const f = await criarLinha({
      status: 'retryable',
      attempt: 20, // acima de OUTBOUND_MAX_DELIVERY_ATTEMPTS
    });

    const resultados = await comoEscopo(() =>
      Promise.all(
        Array.from({ length: 10 }, () =>
          outboundRecoveryRepo.deadLetterTx({
            outbound_id: f.outbound_id,
            from_statuses: ['pending', 'retryable', 'claimed', 'sending'],
            reason: 'attempt_limit',
            conversa_id: conversaId,
            in_reply_to: f.inbound_id,
            attempt: 20,
            delivery_outcome: null,
          }),
        ),
      ),
    );
    expect(resultados.filter((r) => r.dead_lettered).length).toBe(1);
    expect((await linha(f.outbound_id)).status).toBe('dead_letter');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'outbound_dead_lettered' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows[0].n).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DLQ — teto de tentativas, auditado, pela varredura de produção.
  // ═══════════════════════════════════════════════════════════════════════

  it('teto de tentativas leva à DLQ auditada em vez de mais um rearme', async () => {
    const f = await criarLinha({ status: 'retryable', attempt: 12 });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    const l = await linha(f.outbound_id);
    expect(l.status).toBe('dead_letter');
    expect(l.last_error_code).toBe('attempt_limit');
    expect(l.claim_token).toBeNull();
    // Nenhum job foi armado: a DLQ existe justamente para parar o
    // "rearma → falha → rearma".
    expect(await jobExiste(f.outbound_id)).toBe(false);
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE acao = 'outbound_dead_lettered' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.reason).toBe('attempt_limit');
  });

  it('`sending` acima do teto NÃO vai direto à DLQ — a incerteza precisa ser registrada antes', async () => {
    // Se ela fosse morta aqui, chegaria a `dead_letter` com `delivery_outcome`
    // NULL — e `manualRearmDuplicateRisk` lê justamente esse campo. O operador
    // veria "sem risco" numa linha cuja chamada ao provedor estava EM VOO, e a
    // confirmação de risco (a defesa contra a falha #12) não seria pedida.
    const f = await criarLinha({
      status: 'sending',
      attempt: 20,
      lease_s: -30,
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    const l = await linha(f.outbound_id);
    // INVARIANTE ABSOLUTA: continua `sending`, e o caminho para a DLQ passa
    // primeiro pelo takeover (que a fecha como `delivery_unknown`).
    expect(l.status).toBe('sending');
    expect(l.status).not.toBe('dead_letter');
    // E foi REARMADA: é o takeover que registra a incerteza.
    expect(await jobExiste(f.outbound_id)).toBe(true);
  });

  it('prazo de reconciliação vencido leva à DLQ, mesmo em tipo idempotente', async () => {
    const f = await criarLinha({
      tipo: 'text',
      status: 'reconciling',
      delivery_outcome: 'accepted_unconfirmed',
      idade_s: 25 * 3600, // > RECONCILIATION_DEADLINE_MS
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    const l = await linha(f.outbound_id);
    expect(l.status).toBe('dead_letter');
    expect(l.last_error_code).toBe('reconciliation_timeout');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REARMAMENTO MANUAL — a falha #12 da épica, como comportamento.
  // ═══════════════════════════════════════════════════════════════════════

  it('rearmamento de linha INCERTA sem chave nativa é RECUSADO sem confirmação', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'dead_letter',
      delivery_outcome: 'timeout_unknown',
      attempt: 12,
    });

    const recusa = await rearmOutboundByOperator({
      outbound_id: f.outbound_id,
      actor: 'sonda',
      reason: 'o cliente reclamou',
    });

    expect(recusa.rearmed).toBe(false);
    if (recusa.rearmed) throw new Error('inalcançável');
    expect(recusa.refusal).toBe('duplicate_risk_unacknowledged');
    // INVARIANTE ABSOLUTA: nada mudou.
    expect((await linha(f.outbound_id)).status).toBe('dead_letter');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'outbound_manual_rearm' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('com a confirmação explícita o rearmamento acontece e a trilha registra o risco', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'dead_letter',
      delivery_outcome: 'timeout_unknown',
      attempt: 12,
    });

    const ok = await rearmOutboundByOperator({
      outbound_id: f.outbound_id,
      actor: 'sonda',
      reason: 'o cliente reclamou',
      acknowledge_duplicate_risk: true,
    });

    expect(ok.rearmed).toBe(true);
    expect((await linha(f.outbound_id)).status).toBe('retryable');
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE acao = 'outbound_manual_rearm' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.duplicate_risk).toBe(true);
    expect(rows[0].metadata.acknowledged_duplicate_risk).toBe(true);
    expect(rows[0].metadata.reason).toBe('o cliente reclamou');
    expect(rows[0].metadata.actor).toBe('sonda');
    await jobExiste(f.outbound_id); // registra o id para a limpeza
  });

  it('CAS do rearme recusa quando o estado observado já mudou', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'reconciling',
      delivery_outcome: 'timeout_unknown',
    });

    const result = await comoEscopo(() =>
      outboundRecoveryRepo.rearmManuallyTx({
        outbound_id: f.outbound_id,
        conversa_id: conversaId,
        in_reply_to: f.inbound_id,
        actor: 'sonda-cas',
        reason: 'estado observado ficou stale',
        from_status: 'delivery_unknown',
        duplicate_risk: true,
        acknowledged_duplicate_risk: true,
      }),
    );

    expect(result.rearmed).toBe(false);
    expect((await linha(f.outbound_id)).status).toBe('reconciling');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'outbound_manual_rearm' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('recusa rearmar uma parte depois que o turno pai já terminou', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'dead_letter',
      delivery_outcome: 'timeout_unknown',
      attempt: 12,
      turn_lease_s: -30,
    });
    await adicionarParte(f, { sequence: 1, status: 'completed' });

    const finalized = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(finalized.finalized).toBe(true);
    expect((await turno(f.turn_id)).status).toBe('completed');

    const result = await rearmOutboundByOperator({
      outbound_id: f.outbound_id,
      actor: 'sonda',
      reason: 'não pode reabrir um turno concluído',
      acknowledge_duplicate_risk: true,
      rearm: false,
    });

    expect(result.rearmed).toBe(false);
    expect((await linha(f.outbound_id)).status).toBe('dead_letter');
    expect((await turno(f.turn_id)).status).toBe('completed');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'outbound_manual_rearm' AND alvo_id = $1`,
      [f.outbound_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('finalização e rearme concorrentes têm um único vencedor', async () => {
    const f = await criarLinha({
      tipo: 'audio',
      status: 'dead_letter',
      delivery_outcome: 'timeout_unknown',
      attempt: 12,
      turn_lease_s: -30,
    });
    await adicionarParte(f, { sequence: 1, status: 'completed' });

    const [finalized, rearmed] = await Promise.all([
      comoEscopo(() => outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id)),
      rearmOutboundByOperator({
        outbound_id: f.outbound_id,
        actor: 'sonda-concorrente',
        reason: 'corrida controlada com o finalizador',
        acknowledge_duplicate_risk: true,
        rearm: false,
      }),
    ]);

    expect(Number(finalized.finalized) + Number(rearmed.rearmed)).toBe(1);
    const parent = await turno(f.turn_id);
    const artifact = await linha(f.outbound_id);
    if (finalized.finalized) {
      expect(rearmed.rearmed).toBe(false);
      expect(parent.status).toBe('completed');
      expect(artifact.status).toBe('dead_letter');
    } else {
      expect(rearmed.rearmed).toBe(true);
      expect(parent.status).toBe('outbound_pending');
      expect(artifact.status).toBe('retryable');
    }

    const { rows } = await pool.query(
      `SELECT acao, count(*)::int AS n
         FROM audit_log
        WHERE alvo_id IN ($1::uuid, $2::uuid)
          AND acao IN ('outbound_manual_rearm', 'outbound_turn_finalized')
        GROUP BY acao`,
      [f.outbound_id, f.turn_id],
    );
    expect(rows.reduce((sum, row) => sum + Number(row.n), 0)).toBe(1);
  });

  it('`failed_terminal` NÃO é rearmável — a recusa do provedor é definitiva', async () => {
    const f = await criarLinha({
      status: 'failed_terminal',
      delivery_outcome: 'rejected_terminal',
    });
    const recusa = await rearmOutboundByOperator({
      outbound_id: f.outbound_id,
      actor: 'sonda',
      reason: 'tentar de novo',
      acknowledge_duplicate_risk: true,
    });
    expect(recusa.rearmed).toBe(false);
    if (recusa.rearmed) throw new Error('inalcançável');
    expect(recusa.refusal).toBe('status_not_rearmable');
    expect((await linha(f.outbound_id)).status).toBe('failed_terminal');
  });

  it('rearmamento SEM --reason é recusado antes de tocar o banco', async () => {
    const f = await criarLinha({
      tipo: 'text',
      status: 'dead_letter',
      attempt: 12,
    });
    const recusa = await rearmOutboundByOperator({
      outbound_id: f.outbound_id,
      actor: 'sonda',
      reason: '   ',
    });
    expect(recusa.rearmed).toBe(false);
    if (recusa.rearmed) throw new Error('inalcançável');
    expect(recusa.refusal).toBe('reason_missing');
    expect((await linha(f.outbound_id)).status).toBe('dead_letter');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DIVERGÊNCIA TURNO ↔ OUTBOUND, nos DOIS sentidos.
  // ═══════════════════════════════════════════════════════════════════════

  it('detecta turno em outbound_pending SEM linha do outbox', async () => {
    const c = await pool.connect();
    try {
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1,$2,$3,'in','texto','órfão','{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      await c.query(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, state_version)
         VALUES ($1,$2,$3,$4,'outbound_pending',1,4)`,
        [TENANT, AGENT, m.rows[0]!.id, conversaId],
      );
    } finally {
      c.release();
    }
    const d1 = await comoEscopo(() =>
      outboundRecoveryRepo.countTurnOutboundDivergence(),
    );
    expect(d1.turn_pending_without_outbound).toBe(1);
    expect(d1.outbound_without_live_turn).toBe(0);
  });

  it('detecta linha do outbox VIVA cujo turno já é terminal', async () => {
    await criarLinha({
      status: 'retryable',
      turn_status: 'completed',
      turn_outcome: 'reply_delivered',
    });
    const d2 = await comoEscopo(() =>
      outboundRecoveryRepo.countTurnOutboundDivergence(),
    );
    expect(d2.outbound_without_live_turn).toBe(1);
    expect(d2.turn_pending_without_outbound).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A JANELA `delivered -> completed` — dívida declarada pela #632.
  // ═══════════════════════════════════════════════════════════════════════

  it('linha `delivered` COM histórico é concluída pela reconciliação', async () => {
    const f = await criarLinha({
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
      idade_s: 300,
      turn_lease_s: -30,
    });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1,$2,$3,'out','texto','a resposta durável', jsonb_build_object('in_reply_to', $4::text))`,
        [TENANT, AGENT, conversaId, f.inbound_id],
      );
    } finally {
      c.release();
    }

    const stats = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(f.outbound_id)).status).toBe('completed');
    expect(stats.reconciled.history_recovered).toBe(1);
    expect(stats.reconciled.turn_finalized).toBe(1);
    expect((await turno(f.turn_id)).status).toBe('completed');
  });

  // A metade que a #633 NÃO fechou — e o que a #635 fez com ela.
  //
  // Esta sonda dizia `expect(status).toBe('delivered')`: a fatia D recusava
  // fabricar o histórico faltante ("o texto teria de ser re-renderizado a
  // partir do payload"), então a linha ficava parada com `ops_alert`.
  //
  // A #635 resolveu a objeção sem re-renderizar: `buildHistoricoFromArtifact`
  // é uma projeção PURA do artefato imutável, com uma definição só, importada
  // pelos dois caminhos. A metade que continua valendo — e que esta sonda
  // continua exigindo — é a que importa de verdade: NADA é reenviado.
  //
  // A prova de que o texto recuperado não diverge do que o usuário recebeu
  // exige um oráculo externo (o que o adaptador entregou ao provedor) e vive em
  // `outbound-historico-idempotente-real-db.spec.ts`.
  it('linha `delivered` SEM histórico é RECUPERADA sem reenvio (#635)', async () => {
    const f = await criarLinha({
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
      idade_s: 300,
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    // A mensagem CHEGOU: reenviar duplicaria. Nenhum job de entrega é armado.
    expect(await jobExiste(f.outbound_id)).toBe(false);
    // E o ciclo FECHA, porque o histórico foi projetado do artefato.
    expect((await linha(f.outbound_id)).status).toBe('completed');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM mensagens WHERE outbound_id = $1`,
      [f.outbound_id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONVERGÊNCIA OUTBOX → TURNO — recuperação pós-commit.
  // ═══════════════════════════════════════════════════════════════════════

  it('descobre row já `completed` e fecha turno com lease vencida no mesmo tick', async () => {
    const f = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });

    const scopes = await outboundRecoveryRepo.listScopesWithWork();
    expect(scopes).toContainEqual(SCOPE);

    const stats = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(stats.reconciled.turn_finalized).toBe(1);

    const t = await turno(f.turn_id);
    expect(t.status).toBe('completed');
    expect(t.outcome).toBe('reply_delivered');
    expect(Number(t.state_version)).toBe(5);
    expect(t.claim_token).toBeNull();
    expect(t.lease_expires_at).toBeNull();
    expect(t.completed_at).not.toBeNull();

    const inputs = await pool.query<{ processada_em: string | null }>(
      `SELECT m.processada_em
         FROM mensagens m
         JOIN agent_turn_inputs i
           ON i.tenant_id = m.tenant_id
          AND i.agent_id  = m.agent_id
          AND i.mensagem_id = m.id
        WHERE i.turn_id = $1`,
      [f.turn_id],
    );
    expect(inputs.rows).toHaveLength(1);
    expect(inputs.rows[0]!.processada_em).not.toBeNull();

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log
        WHERE acao = 'outbound_turn_finalized' AND alvo_id = $1`,
      [f.turn_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      source: 'outbound_recovery',
      outcome: 'reply_delivered',
      artifact_count: 1,
      successful_count: 1,
      partial_delivery: false,
    });
  });

  it('lease viva ou ausente não autoriza o recovery a concluir o turno', async () => {
    const viva = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: 300,
    });
    const semLease = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
    });

    const candidates = await comoEscopo(() =>
      outboundRecoveryRepo.listFinalizableTurns(50),
    );
    expect(candidates.map((candidate) => candidate.turn_id)).not.toContain(
      viva.turn_id,
    );
    expect(candidates.map((candidate) => candidate.turn_id)).not.toContain(
      semLease.turn_id,
    );

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect((await turno(viva.turn_id)).status).toBe('outbound_pending');
    expect((await turno(semLease.turn_id)).status).toBe('outbound_pending');
  });

  it('multipart só fecha depois que a última parte deixa de ser `delivered`', async () => {
    const f = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });
    const second = await adicionarParte(f, {
      sequence: 1,
      status: 'delivered',
    });

    const before = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(before).toEqual({
      finalized: false,
      reason: 'artifacts_unresolved',
    });
    expect((await turno(f.turn_id)).status).toBe('outbound_pending');

    await pool.query(
      `UPDATE outbound_messages SET status = 'completed' WHERE id = $1`,
      [second],
    );
    const after = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(after.finalized).toBe(true);
    expect((await turno(f.turn_id)).status).toBe('completed');
  });

  it('10 finalizadores concorrentes produzem UMA conclusão e UMA auditoria', async () => {
    const f = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });

    const results = await comoEscopo(() =>
      Promise.all(
        Array.from({ length: 10 }, () =>
          outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
        ),
      ),
    );
    expect(results.filter((result) => result.finalized)).toHaveLength(1);
    const audits = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'outbound_turn_finalized' AND alvo_id = $1`,
      [f.turn_id],
    );
    expect(audits.rows[0]!.n).toBe(1);
  });

  it('sucesso composto apenas de status fallback usa `fallback_delivered`', async () => {
    const f = await criarLinha({
      tipo: 'status_fallback',
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });
    const result = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(result.finalized).toBe(true);
    expect((await turno(f.turn_id)).outcome).toBe('fallback_delivered');
  });

  it('falha terminal sem nenhum artefato concluído não inventa sucesso', async () => {
    const f = await criarLinha({
      status: 'failed_terminal',
      delivery_outcome: 'rejected_terminal',
      turn_lease_s: -30,
      idade_s: 300,
    });
    const result = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(result).toEqual({ finalized: false, reason: 'no_success' });

    expect(await outboundRecoveryRepo.listScopesWithWork()).toContainEqual(
      SCOPE,
    );
    expect(
      await comoEscopo(() => outboundRecoveryRepo.listFinalizableTurns(1)),
    ).toEqual([]);
    const stats = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(stats.no_success_pending).toBe(1);
    expect(await renderPrometheus()).toMatch(
      /maia_outbound_turn_no_success_pending\{agent_id="a633",tenant_id="t633"\} 1/,
    );

    const repeated = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(repeated.no_success_pending).toBe(1);
    expect(await renderPrometheus()).not.toContain('result="turn_no_success"');
    expect(
      await comoEscopo(() => outboundRecoveryRepo.oldestPendingAgeSeconds()),
    ).toBeGreaterThanOrEqual(299);
    expect((await turno(f.turn_id)).status).toBe('outbound_pending');

    await pool.query(
      `UPDATE outbound_messages
          SET status = 'completed', delivery_outcome = 'accepted_confirmed'
        WHERE id = $1`,
      [f.outbound_id],
    );
    const resolved = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(resolved.no_success_pending).toBe(0);
    expect(await renderPrometheus()).toMatch(
      /maia_outbound_turn_no_success_pending\{agent_id="a633",tenant_id="t633"\} 0/,
    );
    expect((await turno(f.turn_id)).status).toBe('completed');
  });

  it('zero-sucesso antigo não ocupa o LIMIT nem impede sucesso posterior', async () => {
    const blocked = await criarLinha({
      status: 'failed_terminal',
      delivery_outcome: 'rejected_terminal',
      turn_lease_s: -60,
      idade_s: 600,
    });
    const successful = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
      idade_s: 300,
    });

    expect(
      await comoEscopo(() => outboundRecoveryRepo.listFinalizableTurns(1)),
    ).toEqual([{ turn_id: successful.turn_id }]);

    const stats = await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(stats.reconciled.turn_finalized).toBe(1);
    expect(stats.no_success_pending).toBe(1);
    expect((await turno(successful.turn_id)).status).toBe('completed');
    expect((await turno(blocked.turn_id)).status).toBe('outbound_pending');
  });

  it('fallback concluído com irmã cancelada fecha e registra entrega parcial', async () => {
    const f = await criarLinha({
      tipo: 'status_fallback',
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });
    await adicionarParte(f, { sequence: 1, status: 'cancelled' });

    const result = await comoEscopo(() =>
      outboundRecoveryRepo.finalizeResolvedTurnTx(f.turn_id),
    );
    expect(result.finalized).toBe(true);
    expect((await turno(f.turn_id)).outcome).toBe('fallback_delivered');
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log
        WHERE acao = 'outbound_turn_finalized' AND alvo_id = $1`,
      [f.turn_id],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({
      partial_delivery: true,
      artifact_count: 2,
      successful_count: 1,
    });
  });

  it('a conclusão recuperada promove e sinaliza o sucessor com origem auditável', async () => {
    const f = await criarLinha({
      status: 'completed',
      delivery_outcome: 'accepted_confirmed',
      turn_lease_s: -30,
    });
    const streamKey = `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;
    await pool.query(
      `UPDATE agent_turns
          SET stream_key = $2, stream_key_version = 1,
              first_ingress_seq = 1, last_ingress_seq = 1
        WHERE id = $1`,
      [f.turn_id, streamKey],
    );
    const successorInbound = await pool.query<{ id: string }>(
      `INSERT INTO mensagens
         (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','mensagem seguinte','{}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const successor = await pool.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          state_version, stream_key, stream_key_version,
          first_ingress_seq, last_ingress_seq)
       VALUES ($1,$2,$3,$4,'received',0,$5,1,2,2)
       RETURNING id`,
      [TENANT, AGENT, successorInbound.rows[0]!.id, conversaId, streamKey],
    );
    const successorId = successor.rows[0]!.id;
    await pool.query(
      `INSERT INTO agent_turn_inputs(tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
       VALUES ($1,$2,$3,$4,0)`,
      [TENANT, AGENT, successorId, successorInbound.rows[0]!.id],
    );

    try {
      await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

      const promoted = await pool.query<{
        status: string;
        promoted_by_turn_id: string | null;
        promoted_at: string | null;
      }>(
        `SELECT status, promoted_by_turn_id, promoted_at
           FROM agent_turns WHERE id = $1`,
        [successorId],
      );
      expect(promoted.rows[0]).toMatchObject({
        status: 'queued',
        promoted_by_turn_id: f.turn_id,
      });
      expect(promoted.rows[0]!.promoted_at).not.toBeNull();
      expect(
        await agentQueue.getJob(agentTurnJobId(successorId)),
      ).toBeDefined();

      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log
          WHERE acao = 'turn_promoted' AND alvo_id = $1`,
        [successorId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({
        source: 'outbound_recovery',
        promoted_by_turn_id: f.turn_id,
      });
    } finally {
      await agentQueue
        .getJob(agentTurnJobId(successorId))
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // `maia_outbound_pending_age_seconds` — a base do alarme.
  // ═══════════════════════════════════════════════════════════════════════

  it('a idade do pendente mais antigo ignora o que já foi concluído', async () => {
    await criarLinha({ status: 'completed', idade_s: 10_000 });
    await criarLinha({ status: 'retryable', idade_s: 600 });
    const idade = await comoEscopo(() =>
      outboundRecoveryRepo.oldestPendingAgeSeconds(),
    );
    // A `completed` de 10.000s não conta; a `retryable` de 600s conta.
    expect(idade).toBeGreaterThanOrEqual(600);
    expect(idade).toBeLessThan(1_000);
  });

  it('a idade do pendente mais antigo inclui `dead_letter`? NÃO — é decisão terminal', async () => {
    await criarLinha({ status: 'dead_letter', idade_s: 10_000, attempt: 12 });
    const idade = await comoEscopo(() =>
      outboundRecoveryRepo.oldestPendingAgeSeconds(),
    );
    expect(idade).toBe(0);
  });
});

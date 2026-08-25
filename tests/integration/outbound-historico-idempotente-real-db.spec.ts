/**
 * Issue #635 (fatia F da épica #506) — HISTÓRICO IDEMPOTENTE, a janela
 * `delivered -> completed` fechada, multipart e a saída SEM ENVIO, contra
 * Postgres REAL e entrando pelos módulos de PRODUÇÃO.
 *
 * ## Por que integração, e por que entra pelo ciclo real
 *
 * Tudo que esta fatia promete é sobre DECLARAÇÕES DO BANCO e sobre o que
 * sobrevive a um processo que morre no meio: a unique parcial da 135, o CAS
 * entre sweepers, o `ON CONFLICT DO NOTHING`, o predicado escopado por tenant.
 * Nenhuma é observável num harness em memória — um teste assim continua verde
 * depois de alguém apagar o `WHERE` de produção, porque quem monta a consulta é
 * o teste.
 *
 * As entradas são `deliverOutbound` (o ciclo real de #632),
 * `runOutboundRecoveryForScope` (o corpo real do worker de #633) e os
 * repositórios de produção. O único SQL escrito aqui é de FIXTURE e de
 * INSPEÇÃO.
 *
 * ## O ORÁCULO da não-divergência — e por que ele não é um espelho
 *
 * A sonda mais importante do arquivo (sonda 3) afirma que o texto RECUPERADO é
 * byte a byte o que o usuário recebeu. Ela seria inútil se o texto esperado
 * fosse produzido por `buildHistoricoFromArtifact` — as duas metades da
 * comparação sairiam da mesma função e o teste mediria a si mesmo.
 *
 * O oráculo aqui é o `LineOutput` FAKE: ele guarda a string EXATA que o
 * adaptador entregou ao provedor, e é ELA que é comparada com o `conteudo`
 * gravado. Nenhum dos dois lados passa pela projeção dentro do teste. Mudar o
 * renderizador de produção deixa a sonda vermelha mesmo que os dois caminhos de
 * produção continuem concordando entre si — que é exatamente a divergência que
 * a #633 temia.
 *
 * ## Isolamento: par (tenant, agent) PRÓPRIO
 *
 * Contagens de histórico e de linhas do outbox sob `primary/primary` — que
 * outras suítes da leva usam em paralelo — seriam deltas frágeis. Este arquivo
 * cria o seu próprio par, e a sonda 4 cria um SEGUNDO par para FORÇAR a colisão
 * de chave em vez de afirmar isolamento por construção.
 *
 * ## ARMADILHA DO `retry: 1`
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção abaixo é INVARIANTE ABSOLUTA
 * sobre linhas criadas NO PRÓPRIO caso (`beforeEach` limpa e recria) — nunca um
 * delta antes×depois sobre estado mutável, que a segunda tentativa herdaria.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { buildOutboundArtifact, type OutboundPayload } from '@/runtime/outbound/contract.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import {
  beginInlineDelivery,
  deliverOutbound,
  recordInlineDelivery,
} from '@/runtime/outbound/delivery.js';
import { __resetDeliveryWorkerIdForTest } from '@/runtime/outbound/delivery-contract.js';
import {
  runOutboundRecoveryForScope,
  __resetOutboundRecoveryGaugesForTest,
} from '@/workers/outbound-recovery.js';
import type { LineOutput } from '@/gateway/line-output.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't635';
const AGENT = 'a635';
const SCOPE = { tenant_id: TENANT, agent_id: AGENT };

/** O SEGUNDO par — existe só para FORÇAR a colisão da sonda 4. */
const TENANT_B = 't635b';
const AGENT_B = 'a635b';
const SCOPE_B = { tenant_id: TENANT_B, agent_id: AGENT_B };

const JID = '5511900000635@s.whatsapp.net';

let pool: pg.Pool;
let conversaId: string;
let conversaIdB: string;

function comoEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(SCOPE, fn);
}
function comoEscopoB<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(SCOPE_B, fn);
}

/**
 * O ORÁCULO. Guarda o que o adaptador REALMENTE entregou ao provedor.
 *
 * Não reimplementa regra nenhuma: ele é a fronteira de saída, e o que ele
 * registra é o efeito externo observado. A produção abaixo de
 * `input.line` é idêntica — `deliverOutbound` expõe o parâmetro exatamente
 * para isto (#632).
 */
type ProviderCapture = { jid: string; text: string; messageId: string | undefined };

function fakeLine(capturas: ProviderCapture[], id = () => `WA-${randomUUID()}`): LineOutput {
  return {
    // `channel_id: null` — o par (tenant, agent) desta sonda não tem linha
    // provisionada, e `mensagens.channel_id` tem FK composta para `channels`
    // (090). A fixture exercita o caminho legado sem canal.
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null },
    async sendText(jid, text, opts) {
      capturas.push({ jid, text, messageId: opts?.messageId });
      return id();
    },
    async sendDocument() {
      throw new Error('fakeLine.sendDocument não é usado por esta suíte');
    },
    async sendVoice() {
      throw new Error('fakeLine.sendVoice não é usado por esta suíte');
    },
    async sendPoll() {
      throw new Error('fakeLine.sendPoll não é usado por esta suíte');
    },
    sendReaction() {},
    startTyping() {
      return undefined as never;
    },
    markRead() {},
    isConnected: () => true,
  } as unknown as LineOutput;
}

type Fixture = { outbound_id: string; turn_id: string; inbound_id: string; texto: string };

/**
 * Cria turno + linha(s) do outbox. Usa `buildOutboundArtifact` — o MESMO
 * derivador determinístico da produção — para que as duas chaves nunca sejam
 * inventadas pelo teste.
 */
async function criarTurnoComArtefatos(opts: {
  scope?: { tenant_id: string; agent_id: string };
  conversa_id?: string;
  /** Um artefato por posição, na ordem. */
  artefatos: Array<{ texto: string; status: string; delivery_outcome?: string | null }>;
  idade_s?: number;
}): Promise<Fixture[]> {
  const scope = opts.scope ?? SCOPE;
  const conversa_id = opts.conversa_id ?? conversaId;
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','e a resposta?', jsonb_build_object('remote_jid', $4::text))
       RETURNING id`,
      [scope.tenant_id, scope.agent_id, conversa_id, JID],
    );
    const inbound_id = m.rows[0]!.id;
    const t = await c.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          attempt_count, state_version)
       VALUES ($1,$2,$3,$4,'outbound_pending',1,4) RETURNING id`,
      [scope.tenant_id, scope.agent_id, inbound_id, conversa_id],
    );
    const turn_id = t.rows[0]!.id;
    const out: Fixture[] = [];
    for (const [seq, a] of opts.artefatos.entries()) {
      const payload: OutboundPayload = { type: 'text', text: a.texto };
      const artefato = buildOutboundArtifact({
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
        turn_id,
        sequence_in_turn: seq,
        payload,
        channel: 'whatsapp',
      });
      const o = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages
           (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
            status, delivery_outcome, attempt, turn_id, sequence_in_turn,
            payload_version, payload_type, payload_json, payload_hash,
            logical_dedupe_key, provider_idempotency_key,
            next_attempt_at, created_at)
         VALUES ($1,$2,$3,$4,$5,'text',$6,$7,0,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,
                 now(), now() - make_interval(secs => $16))
         RETURNING id`,
        [
          scope.tenant_id,
          scope.agent_id,
          artefato.logical_dedupe_key,
          conversa_id,
          inbound_id,
          a.status,
          a.delivery_outcome ?? null,
          turn_id,
          seq,
          artefato.payload_version,
          artefato.payload_type,
          JSON.stringify(artefato.payload),
          artefato.payload_hash,
          artefato.logical_dedupe_key,
          artefato.provider_idempotency_key,
          opts.idade_s ?? 0,
        ],
      );
      out.push({ outbound_id: o.rows[0]!.id, turn_id, inbound_id, texto: a.texto });
    }
    return out;
  } finally {
    c.release();
  }
}

async function linha(id: string) {
  const { rows } = await pool.query(
    `SELECT status, delivery_outcome, last_error_code FROM outbound_messages WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    delivery_outcome: string | null;
    last_error_code: string | null;
  };
}

/** As rows de histórico ANCORADAS neste artefato. Leitura de inspeção. */
async function historicoDe(outbound_id: string) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, agent_id, conteudo, tipo, midia_url, metadata
       FROM mensagens WHERE outbound_id = $1 ORDER BY created_at`,
    [outbound_id],
  );
  return rows as Array<{
    id: string;
    tenant_id: string;
    agent_id: string;
    conteudo: string;
    tipo: string;
    midia_url: string | null;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Quantas rows de SAÍDA a conversa tem, ANCORADAS OU NÃO.
 *
 * É a contagem que o usuário enxerga, e é ela que torna o vermelho da sonda 1
 * inequívoco: sem a chave, a segunda conclusão insere uma SEGUNDA resposta na
 * conversa — não apenas uma row sem âncora.
 */
async function historicoDaConversa(conversa_id: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM mensagens WHERE conversa_id = $1 AND direcao = 'out'`,
    [conversa_id],
  );
  return Number(rows[0]!.n);
}

/** Envelhece a linha para além da carência de `delivered` sem histórico. */
async function envelhecer(outbound_id: string, segundos: number): Promise<void> {
  await pool.query(
    `UPDATE outbound_messages SET created_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [outbound_id, segundos],
  );
}

d('#635 — histórico idempotente e a janela delivered→completed (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 20 });
    const c = await pool.connect();
    try {
      for (const [tenant, agent, nome] of [
        [TENANT, AGENT, 'sonda 635'],
        [TENANT_B, AGENT_B, 'sonda 635 vizinha'],
      ] as const) {
        await c.query(`INSERT INTO tenants(id, nome) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [
          tenant,
          nome,
        ]);
        await c.query(
          `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
          [agent, tenant, nome],
        );
      }
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda 635',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1,$2,$3,'ativa') RETURNING id`,
        [TENANT, AGENT, p.rows[0]!.id],
      );
      conversaId = conv.rows[0]!.id;
      const pB = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda 635 B',$3,'dono','ativa') RETURNING id`,
        [TENANT_B, AGENT_B, `+55118${Date.now().toString().slice(-8)}`],
      );
      const convB = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1,$2,$3,'ativa') RETURNING id`,
        [TENANT_B, AGENT_B, pB.rows[0]!.id],
      );
      conversaIdB = convB.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      for (const tenant of [TENANT, TENANT_B]) {
        await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM conversas WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      }
    } finally {
      c.release();
    }
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    __resetDeliveryWorkerIdForTest();
    __resetOutboundRecoveryGaugesForTest();
    const c = await pool.connect();
    try {
      for (const tenant of [TENANT, TENANT_B]) {
        await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [tenant]);
        await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [tenant]);
      }
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A DECLARAÇÃO DO BANCO — a chave existe e é PARCIAL e ESCOPADA.
  // ═══════════════════════════════════════════════════════════════════════

  it('a chave idempotente do histórico existe como índice NOMEADO, único, parcial e VÁLIDO', async () => {
    const { rows } = await pool.query<{
      indexdef: string;
      indisvalid: boolean;
      indisunique: boolean;
    }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid, i.indisunique
         FROM pg_index i
        WHERE i.indexrelid = 'mensagens_outbound_history_uq'::regclass`,
    );
    expect(rows).toHaveLength(1);
    const idx = rows[0]!;
    // "não há Seq Scan" não prova índice — o índice NOMEADO prova.
    expect(idx.indisunique).toBe(true);
    // Issue #658: o runner não detecta CONCURRENTLY inválido. Aqui detectamos.
    expect(idx.indisvalid).toBe(true);
    // O namespace de dedupe é do PAR, não global — é isso que a sonda 4 força.
    expect(idx.indexdef).toContain('tenant_id');
    expect(idx.indexdef).toContain('agent_id');
    expect(idx.indexdef).toContain('outbound_id');
    // PARCIAL: nenhuma row legada (sem âncora) entra no índice.
    expect(idx.indexdef).toContain('WHERE (outbound_id IS NOT NULL)');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 1 — IDEMPOTÊNCIA REAL: concluir duas vezes não duplica histórico.
  //
  // Duas metades, e a segunda é a que importa.
  //
  // (a) pelo CAMINHO NORMAL: o segundo `deliverOutbound` é recusado pelo claim
  //     (a linha está `completed`), e o histórico continua com uma row.
  //
  // (b) com o PORTÃO DE ESTADO DESFEITO À MÃO: a linha volta a `delivered` e a
  //     conclusão roda DE NOVO, com o mesmo artefato. É o cenário que a #635
  //     criou ao dar um segundo escritor ao histórico — e, sem a unique da 135,
  //     ele produz DUAS rows na conversa do usuário. A idempotência de ESTADO
  //     de #632 não alcança este caso; a CHAVE alcança.
  // ═══════════════════════════════════════════════════════════════════════

  it('concluir duas vezes não duplica a linha de histórico — nem pelo estado, nem pela chave', async () => {
    const capturas: ProviderCapture[] = [];
    const [f] = await criarTurnoComArtefatos({
      artefatos: [{ texto: 'a resposta durável', status: 'pending' }],
    });

    const r1 = await comoEscopo(() =>
      deliverOutbound({ outbound_id: f!.outbound_id, jid: JID, line: fakeLine(capturas) }),
    );
    expect(r1.delivered).toBe(true);
    expect((await linha(f!.outbound_id)).status).toBe('completed');
    expect(await historicoDaConversa(conversaId)).toBe(1);

    // (a) caminho normal: o claim recusa `completed`.
    const r2 = await comoEscopo(() =>
      deliverOutbound({ outbound_id: f!.outbound_id, jid: JID, line: fakeLine(capturas) }),
    );
    expect(r2.delivered).toBe(false);
    expect(capturas).toHaveLength(1); // nada foi reenviado ao provedor
    expect(await historicoDaConversa(conversaId)).toBe(1);

    // (b) portão de estado desfeito: a conclusão roda de novo, sobre o MESMO
    //     artefato, com posse legítima. Só a CHAVE segura.
    const claim = await comoEscopo(() =>
      pool
        .query(
          `UPDATE outbound_messages
              SET status = 'delivered', claimed_by = 'sonda', claim_token = gen_random_uuid(),
                  lease_expires_at = now() + interval '60 seconds'
            WHERE id = $1 RETURNING claim_token`,
          [f!.outbound_id],
        )
        .then((r) => r.rows[0] as { claim_token: string }),
    );
    const segunda = await comoEscopo(() =>
      outboundDeliveryRepo.completeDeliveryTx({
        outbound_id: f!.outbound_id,
        claim_token: claim.claim_token,
        conversa_id: conversaId,
        channel_id: null,
        in_reply_to: f!.inbound_id,
        historico: {
          tipo: 'texto',
          conteudo: f!.texto,
          metadata: { in_reply_to: f!.inbound_id },
        },
      }),
    );
    // INVARIANTE ABSOLUTA: UMA row de histórico, sempre — contada pela ÂNCORA
    // e contada pelo que o usuário vê na conversa. As duas juntas: sem a chave,
    // a segunda conclusão insere uma SEGUNDA resposta, e é a contagem da
    // conversa que diz isso sem ambiguidade.
    expect(await historicoDe(f!.outbound_id)).toHaveLength(1);
    expect(await historicoDaConversa(conversaId)).toBe(1);
    // E a segunda gravação DIZ que não inseriu — a idempotência é observável,
    // não silenciosa.
    expect(segunda.history_inserted).toBe(false);
    expect(segunda.history_message_id).toBeNull();
    // A conclusão acontece de qualquer forma: o ciclo terminou.
    expect((await linha(f!.outbound_id)).status).toBe('completed');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 2 + 3 — A JANELA `delivered -> completed`, E O ORÁCULO.
  //
  // O crash é injetado ENTRE as duas escritas (trap: uma falha DENTRO da
  // própria escrita ficaria verde com a transação quebrada). `recordDeliveryOutcome`
  // já gravou `delivered`; `completeDeliveryTx` morre antes de tocar em
  // `mensagens`. É a janela exata que a #632 declarou e a #633 recusou fechar.
  //
  // O texto esperado NÃO vem da projeção: vem do que o fake entregou ao
  // provedor. Ver §ORÁCULO no topo.
  // ═══════════════════════════════════════════════════════════════════════

  it('crash entre `delivered` e `completed`: o histórico é FABRICADO, sem reenviar', async () => {
    const capturas: ProviderCapture[] = [];
    const [f] = await criarTurnoComArtefatos({
      artefatos: [{ texto: 'a única resposta que o usuário recebeu', status: 'pending' }],
    });

    // O CRASH. Cai ENTRE `delivered` e o INSERT do histórico.
    const boom = vi
      .spyOn(outboundDeliveryRepo, 'completeDeliveryTx')
      .mockRejectedValueOnce(new Error('kill -9 no meio da janela'));
    await expect(
      comoEscopo(() =>
        deliverOutbound({ outbound_id: f!.outbound_id, jid: JID, line: fakeLine(capturas) }),
      ),
    ).rejects.toThrow('kill -9');
    boom.mockRestore();

    // O estado depois do crash: a mensagem CHEGOU, o histórico NÃO entrou.
    expect(capturas).toHaveLength(1);
    expect((await linha(f!.outbound_id)).status).toBe('delivered');
    expect(await historicoDe(f!.outbound_id)).toHaveLength(0);

    // Passada a carência, a reconciliação roda.
    await envelhecer(f!.outbound_id, 3600);
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    // INVARIANTE ABSOLUTA 1 — a linha fechou.
    expect((await linha(f!.outbound_id)).status).toBe('completed');
    // INVARIANTE ABSOLUTA 2 — exatamente UMA row de histórico, ancorada.
    const hist = await historicoDe(f!.outbound_id);
    expect(hist).toHaveLength(1);
    // INVARIANTE ABSOLUTA 3 — NADA foi reenviado. O fake continua com uma
    // chamada só: a mensagem chegou uma vez e a recuperação não tocou o canal.
    expect(capturas).toHaveLength(1);

    // ─── O ORÁCULO ────────────────────────────────────────────────────────
    // O texto gravado é BYTE A BYTE o que o adaptador entregou ao provedor.
    // Nenhum dos dois lados desta comparação passa pela projeção AQUI.
    expect(hist[0]!.conteudo).toBe(capturas[0]!.text);
    // E a retenção: nem mídia, nem URL.
    expect(hist[0]!.midia_url).toBeNull();
  });

  it('a auditoria distingue histórico FABRICADO de histórico que já existia', async () => {
    const capturas: ProviderCapture[] = [];
    const [f] = await criarTurnoComArtefatos({
      artefatos: [{ texto: 'resposta com trilha', status: 'pending' }],
    });
    const boom = vi
      .spyOn(outboundDeliveryRepo, 'completeDeliveryTx')
      .mockRejectedValueOnce(new Error('crash'));
    await expect(
      comoEscopo(() =>
        deliverOutbound({ outbound_id: f!.outbound_id, jid: JID, line: fakeLine(capturas) }),
      ),
    ).rejects.toThrow();
    boom.mockRestore();
    await envelhecer(f!.outbound_id, 3600);
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'outbound_delivery_completed' AND alvo_id = $2`,
      [TENANT, f!.outbound_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata['recovered_by']).toBe('reconciliation');
    expect(rows[0]!.metadata['history_fabricated']).toBe(true);
  });

  it('linha `delivered` que JÁ TEM histórico é concluída sem inserir nada', async () => {
    // O caminho SÍNCRONO de `output-dispatch.ts` grava o histórico por conta
    // própria e para em `delivered`. A reconciliação tem de distinguir isso de
    // um crash — e a distinção agora é a CHAVE, não o `in_reply_to`.
    const [f] = await criarTurnoComArtefatos({
      artefatos: [{ texto: 'o síncrono já historiou', status: 'delivered' }],
      idade_s: 3600,
    });
    await pool.query(
      `UPDATE outbound_messages SET delivery_outcome = 'accepted_confirmed' WHERE id = $1`,
      [f!.outbound_id],
    );
    await pool.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo,
                             outbound_id, metadata)
       VALUES ($1,$2,$3,'out','texto',$4,$5, jsonb_build_object('in_reply_to', $6::text))`,
      [TENANT, AGENT, conversaId, f!.texto, f!.outbound_id, f!.inbound_id],
    );

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    expect((await linha(f!.outbound_id)).status).toBe('completed');
    expect(await historicoDe(f!.outbound_id)).toHaveLength(1);
    // Nenhuma auditoria de fabricação — o histórico não foi projetado.
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'outbound_delivery_completed' AND alvo_id = $2`,
      [TENANT, f!.outbound_id],
    );
    expect(rows[0]!.metadata['history_fabricated']).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 4 — ESCOPO POR TENANT, com a colisão FORÇADA.
  //
  // Afirmar isolamento sem forçar a colisão é a armadilha que já mordeu esta
  // leva três vezes. Aqui o MESMO valor de `outbound_id` é gravado como
  // histórico nos DOIS pares, e as duas perguntas são feitas separadamente:
  //
  //  (a) a UNIQUE recusa? NÃO — o namespace é (tenant, agent, outbound_id), e
  //      se ela fosse global a segunda inserção explodiria com 23505;
  //  (b) `hasHistoryFor` do par A enxerga a row do par B? NÃO — e é ESSA
  //      consulta que carrega o peso: se ela perdesse os predicados de escopo,
  //      a reconciliação de A concluiria a linha SEM fabricar histórico,
  //      porque acharia que o vizinho já tinha gravado.
  // ═══════════════════════════════════════════════════════════════════════

  it('o histórico de um tenant não aparece no do outro — com a colisão FORÇADA', async () => {
    const [f] = await criarTurnoComArtefatos({
      artefatos: [{ texto: 'a resposta do tenant A', status: 'delivered' }],
      idade_s: 3600,
    });
    await pool.query(
      `UPDATE outbound_messages SET delivery_outcome = 'accepted_confirmed' WHERE id = $1`,
      [f!.outbound_id],
    );
    // A COLISÃO: o vizinho grava histórico com o MESMO `outbound_id`.
    const inboundB = await pool.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
       VALUES ($1,$2,$3,'in','texto','pergunta do vizinho') RETURNING id`,
      [TENANT_B, AGENT_B, conversaIdB],
    );
    await pool.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo,
                             outbound_id, metadata)
       VALUES ($1,$2,$3,'out','texto','a resposta do vizinho',$4,
               jsonb_build_object('in_reply_to', $5::text))`,
      [TENANT_B, AGENT_B, conversaIdB, f!.outbound_id, inboundB.rows[0]!.id],
    );

    // (a) a unique é ESCOPADA: a inserção acima passou. Duas rows, mesmo
    //     `outbound_id`, tenants diferentes.
    const todas = await historicoDe(f!.outbound_id);
    expect(todas).toHaveLength(1);
    expect(todas[0]!.tenant_id).toBe(TENANT_B);

    // (b) a consulta que carrega o peso.
    const vistoPorA = await comoEscopo(() =>
      outboundRecoveryRepo.hasHistoryFor({
        outbound_id: f!.outbound_id,
        conversa_id: conversaId,
        in_reply_to: f!.inbound_id,
      }),
    );
    expect(vistoPorA).toBe(false);
    const vistoPorB = await comoEscopoB(() =>
      outboundRecoveryRepo.hasHistoryFor({
        outbound_id: f!.outbound_id,
        conversa_id: conversaIdB,
        in_reply_to: inboundB.rows[0]!.id,
      }),
    );
    expect(vistoPorB).toBe(true);

    // E o efeito de ponta a ponta: A fabrica o SEU histórico apesar do vizinho.
    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM mensagens WHERE outbound_id = $1 AND tenant_id = $2`,
      [f!.outbound_id, TENANT],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 5 — MULTIPART: dois artefatos do mesmo turno, dois históricos.
  //
  // É o falso positivo que a #633 tinha e não podia ver: os dois artefatos
  // respondem ao MESMO `in_reply_to`, então o predicado antigo
  // (`metadata->>'in_reply_to'`) respondia "já existe" para o segundo — e ele
  // era concluído SEM histórico, com a linha em `completed` mentindo.
  // ═══════════════════════════════════════════════════════════════════════

  it('multipart: cada artefato do turno ganha o SEU histórico', async () => {
    const artefatos = await criarTurnoComArtefatos({
      artefatos: [
        { texto: 'primeira parte', status: 'delivered', delivery_outcome: 'accepted_confirmed' },
        { texto: 'segunda parte', status: 'delivered', delivery_outcome: 'accepted_confirmed' },
      ],
      idade_s: 3600,
    });

    await comoEscopo(() => runOutboundRecoveryForScope(SCOPE));

    for (const a of artefatos) {
      expect((await linha(a.outbound_id)).status).toBe('completed');
      const hist = await historicoDe(a.outbound_id);
      expect(hist, `artefato ${a.outbound_id} sem histórico`).toHaveLength(1);
      expect(hist[0]!.conteudo).toBe(a.texto);
    }
    // Duas rows distintas na conversa, uma por artefato.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM mensagens
        WHERE tenant_id = $1 AND conversa_id = $2 AND direcao = 'out'`,
      [TENANT, conversaId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 6 — MULTIPART: a ORDEM. O artefato 1 não passa na frente do 0.
  //
  // Contraste no MESMO caso, com uma variável só: o estado do artefato 0.
  // Um teste com um cenário só provaria o comportamento, não a DISCRIMINAÇÃO.
  // ═══════════════════════════════════════════════════════════════════════

  it('o artefato seguinte espera enquanto o anterior está INCERTO, e sai quando ele resolve', async () => {
    const capturas: ProviderCapture[] = [];
    const artefatos = await criarTurnoComArtefatos({
      artefatos: [
        {
          texto: 'primeira parte, incerta',
          status: 'delivery_unknown',
          delivery_outcome: 'timeout_unknown',
        },
        { texto: 'segunda parte', status: 'pending' },
      ],
    });
    const [zero, um] = artefatos as [Fixture, Fixture];

    const bloqueado = await comoEscopo(() =>
      deliverOutbound({ outbound_id: um.outbound_id, jid: JID, line: fakeLine(capturas) }),
    );
    expect(bloqueado.delivered).toBe(false);
    expect(bloqueado).toMatchObject({ reason: 'awaiting_earlier_artifact' });
    // INVARIANTE ABSOLUTA: o canal não foi tocado, e a linha continua elegível
    // (nem `claimed`, nem com `attempt` consumido).
    expect(capturas).toHaveLength(0);
    const antes = await linha(um.outbound_id);
    expect(antes.status).toBe('pending');

    // A ÚNICA variável muda: o artefato 0 resolve.
    await pool.query(`UPDATE outbound_messages SET status = 'completed' WHERE id = $1`, [
      zero.outbound_id,
    ]);

    const liberado = await comoEscopo(() =>
      deliverOutbound({ outbound_id: um.outbound_id, jid: JID, line: fakeLine(capturas) }),
    );
    expect(liberado.delivered).toBe(true);
    expect(capturas).toHaveLength(1);
    expect(capturas[0]!.text).toBe('segunda parte');
    expect((await linha(um.outbound_id)).status).toBe('completed');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 7 — A SAÍDA "SEM ENVIO" NÃO É TRABALHO ENTREGÁVEL.
  //
  // O defeito concreto que ela fecha: o fallback enquete→texto fechava a linha
  // da enquete como `retryable` "para que o recovery não a reenvie" — e
  // `retryable` é EXATAMENTE o estado que `listDeliverable` seleciona. O
  // contraste está no mesmo caso: as duas linhas têm o mesmo turno e a mesma
  // idade, e só o estado difere.
  // ═══════════════════════════════════════════════════════════════════════

  it('`cancelled` sai do trabalho entregável; `retryable` continua nele', async () => {
    const artefatos = await criarTurnoComArtefatos({
      artefatos: [
        { texto: 'a enquete substituída', status: 'pending' },
        { texto: 'o texto que a substituiu', status: 'retryable' },
      ],
    });
    const [semEnvio, entregavel] = artefatos as [Fixture, Fixture];

    // O ESTADO NÃO É ESCRITO PELO TESTE. Ele vem do caminho de produção que o
    // fallback enquete→texto usa: posse (`beginInlineDelivery`) e depois o
    // desfecho normalizado (`recordInlineDelivery` → `statusForOutcome`). Uma
    // fixture com `status: 'cancelled'` escrito à mão provaria que
    // `listDeliverable` ignora `cancelled`, e nada sobre o MAPEAMENTO — que é a
    // metade que a #631 errou.
    await comoEscopo(async () => {
      const handle = await beginInlineDelivery(semEnvio.outbound_id);
      await recordInlineDelivery(handle, {
        outcome: 'cancelled_before_send',
        last_error_code: 'superseded_by_text_fallback',
        payload_type: 'interactive_poll',
      });
    });
    expect((await linha(semEnvio.outbound_id)).status).toBe('cancelled');

    const candidatos = await comoEscopo(() => outboundRecoveryRepo.listDeliverable(200));
    const ids = candidatos.map((c) => c.outbound_id);
    // INVARIANTE ABSOLUTA, nos dois sentidos: a saída sem envio está FORA, e a
    // que ainda tem trabalho está DENTRO.
    expect(ids).not.toContain(semEnvio.outbound_id);
    expect(ids).toContain(entregavel.outbound_id);

    // E o ciclo de entrega também a recusa, pelo claim.
    const capturas: ProviderCapture[] = [];
    const r = await comoEscopo(() =>
      deliverOutbound({ outbound_id: semEnvio.outbound_id, jid: JID, line: fakeLine(capturas) }),
    );
    expect(r.delivered).toBe(false);
    expect(capturas).toHaveLength(0);
    expect((await linha(semEnvio.outbound_id)).status).toBe('cancelled');
  });
});

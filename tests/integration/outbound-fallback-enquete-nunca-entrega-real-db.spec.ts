/**
 * Issue #635 (fatia F da épica #506) — a SAÍDA "SEM ENVIO" do fallback
 * enquete→texto, medida pela CONSEQUÊNCIA para o usuário, contra Postgres real
 * e atravessando `dispatchOutput` de PRODUÇÃO.
 *
 * ## A invariante, e por que ela não é o enum
 *
 * O commit que dá título à fatia troca UMA linha em
 * `src/agent/output-dispatch.ts` (o `recordCommittedDelivery` do ramo de
 * fallback): `kind: 'retryable'` → `kind: 'no_send'`. Afirmar
 * `delivery_outcome === 'cancelled_before_send'` seria escrever o lado direito
 * daquela linha duas vezes — um espelho do código, verde por construção e
 * incapaz de dizer se o estado escolhido SERVE para alguma coisa.
 *
 * A propriedade que serve é a que o usuário vive:
 *
 *   **depois do fallback enquete→texto, a enquete NUNCA é entregue.**
 *
 * Ela é medida em três degraus, do banco até o canal:
 *
 *   1. a linha da enquete (posição 0) NÃO aparece em `listDeliverable` — nem
 *      no instante do fallback, nem depois de o gate de backoff vencer. O
 *      relógio é AVANÇADO explicitamente (`next_attempt_at` para uma hora
 *      atrás): confiar no `now()` real faria a sonda passar por SORTE, porque
 *      o backoff de `rejected_retryable` é de 5 segundos e nenhum teste dura
 *      tanto;
 *   2. a varredura de recuperação de #633 não REARMA nada no escopo, e o ciclo
 *      de entrega de #632 (`deliverOutbound`, o mesmo que o job da fila chama)
 *      não reivindica a linha nem toca `line.sendPoll`;
 *   3. a conversa do usuário termina com o texto do fallback e NADA além dele.
 *
 * Com `kind: 'retryable'` de volta na produção, o degrau (1) reprova (a linha
 * volta a ser selecionada assim que o backoff vence) e o degrau (2) reprova no
 * lugar onde o dano acontece: `deliverOutbound` reivindica a linha e a ENQUETE
 * vai ao canal DEPOIS do texto que existia para substituí-la. É o duplo envio
 * pela porta dos fundos.
 *
 * ## O que é dublê, e por que só ele
 *
 * Só o CANAL (`@/gateway/line-output.js`). Ele é a fronteira externa da
 * plataforma e é justamente o efeito que a invariante proíbe — sem WhatsApp
 * conectado `sendPoll` devolve o resultado vazio e o ramo morreria antes de
 * provar qualquer coisa. O dublê não reimplementa regra nenhuma: ele REGISTRA
 * o que o adaptador recebeu, e é esse registro que responde "a enquete chegou
 * ao usuário?".
 *
 * Tudo o mais é produção: `dispatchOutput` escolhe o ramo, `sendOutboundPoll`
 * detecta os segredos ausentes, o commit transacional de #631 grava as duas
 * posições, o claim/lease/fence de #632 governa a posse, e as varreduras de
 * #633 leem o banco de verdade. O gatilho do ramo é o predicado de produção
 * `if (!sent.whatsapp_id || !sent.message_secret || !sent.creator_jid)` — o
 * dublê entra por ele pela porta da frente, devolvendo o MESMO resultado vazio
 * que `presence.sendPoll` devolve quando não há socket.
 *
 * ## Por que existem dois CONTROLES
 *
 * Um zero só significa alguma coisa quando o não-zero é possível.
 *
 *   - CONTROLE A (produção, com segredos): a enquete VAI ao canal e não há
 *     fallback. Sem ele, "a enquete não foi entregue depois" também passaria
 *     se o ramo de enquete nunca tivesse sido alcançado.
 *   - CONTROLE B (fixture em `retryable`): uma linha de enquete num estado
 *     ENTREGÁVEL é selecionada por `listDeliverable` e VAI ao canal por
 *     `deliverOutbound`. Sem ele, o zero do degrau (2) também passaria se a
 *     varredura estivesse quebrada, o escopo errado, ou o payload de enquete
 *     fosse inentregável por outro motivo — e a conclusão da fatia seria
 *     "a correção é redundante" quando ela não é.
 *
 * ## Isolamento e a ARMADILHA DO `retry: 1`
 *
 * `vitest.config.ts` tem `retry: 1`, e a segunda tentativa herda a mutação da
 * primeira como baseline. Por isso: par (tenant, agent) PRÓPRIO, `beforeEach`
 * que apaga tudo dele, um turno novo por caso, e toda asserção é INVARIANTE
 * ABSOLUTA sobre linhas criadas no próprio caso — nunca um delta antes×depois.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/**
 * O par (tenant, agent) desta suíte, e o JID.
 *
 * `vi.hoisted` porque a fábrica de `vi.mock` abaixo os lê, e ela é içada acima
 * de todo `const` de topo do arquivo.
 */
const { TENANT, AGENT } = vi.hoisted(() => ({ TENANT: 't635fb', AGENT: 'a635fb' }));
const SCOPE = { tenant_id: TENANT, agent_id: AGENT };
const JID = '5511900000636@s.whatsapp.net';

/**
 * O REGISTRO do canal. É o oráculo da invariante: "a enquete foi entregue?" é
 * respondida por `pollSends`, e por nada mais.
 *
 * `vi.hoisted` porque a fábrica de `vi.mock` é içada acima dos imports — um
 * `const` comum ainda estaria na zona morta temporal quando ela roda.
 */
const canal = vi.hoisted(() => ({
  pollSends: [] as Array<{ jid: string; question: string; options: readonly unknown[] }>,
  textSends: [] as Array<{ jid: string; text: string }>,
  /**
   * O provedor devolve os três segredos? `false` reproduz o resultado vazio de
   * `presence.sendPoll` (sem socket / desconectado) e é o gatilho REAL do ramo
   * de fallback. `true` é o CONTROLE A.
   */
  comSegredos: false,
}));

vi.mock('@/gateway/line-output.js', () => {
  const wid = (): string => `3EB0${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
  const line = {
    // `channel_id: null` — este par (tenant, agent) não tem linha provisionada,
    // e `mensagens.channel_id` tem FK composta para `channels` (090). É o mesmo
    // caminho legado sem canal que a suíte irmã de #635 exercita.
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null },
    async sendText(jid: string, text: string) {
      canal.textSends.push({ jid, text });
      return wid();
    },
    async sendDocument() {
      throw new Error('sendDocument não é usado por esta suíte');
    },
    async sendVoice() {
      throw new Error('sendVoice não é usado por esta suíte');
    },
    async sendPoll(jid: string, question: string, options: readonly unknown[]) {
      canal.pollSends.push({ jid, question, options });
      if (!canal.comSegredos) {
        // O resultado VAZIO de `presence.sendPoll` — o mesmo shape que a
        // produção devolve sem socket. Nada saiu ao canal.
        return { whatsapp_id: null, message_secret: null, creator_jid: null };
      }
      return {
        whatsapp_id: wid(),
        message_secret: Buffer.from('segredo-de-poll').toString('base64'),
        creator_jid: '5511000000000@s.whatsapp.net',
      };
    },
    sendReaction() {
      /* inerte */
    },
    startTyping() {
      return { stop: () => undefined };
    },
    markRead() {
      /* inerte */
    },
    isConnected: () => true,
  };
  return {
    forCurrentAgentChannel: async () => line,
    forChannel: async () => line,
    _buildOutputForTests: () => line,
    _clearScopeCacheForTests: () => undefined,
  };
});

import { dispatchOutput } from '@/agent/output-dispatch.js';
import { config } from '@/config/env.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithOutboundTurnScope } from '@/runtime/outbound/turn-scope.js';
import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import { deliverOutbound } from '@/runtime/outbound/delivery.js';
import { __resetDeliveryWorkerIdForTest } from '@/runtime/outbound/delivery-contract.js';
import {
  runOutboundRecoveryForScope,
  __resetOutboundRecoveryGaugesForTest,
} from '@/workers/outbound-recovery.js';
import type { LineOutput } from '@/gateway/line-output.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { TurnLease } from '@/runtime/turns/lease.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

/** As três opções da pendência. Três é o mínimo que `usePoll` aceita. */
const OPCOES = [
  { key: 'alimentacao', label: 'Alimentação' },
  { key: 'transporte', label: 'Transporte' },
  { key: 'moradia', label: 'Moradia' },
] as const;

const PERGUNTA = 'Em qual categoria eu classifico esse gasto?';

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;

/** A linha de saída dublê, do ponto de vista de quem injeta em `deliverOutbound`. */
async function linhaDeSaida(): Promise<LineOutput> {
  const { forCurrentAgentChannel } = await import('@/gateway/line-output.js');
  return forCurrentAgentChannel(null);
}

function noEscopo<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(SCOPE, fn);
}

/** Turno REAL em `running`, com lease viva — o estado em que a cognição termina. */
async function novoTurno(): Promise<{ turnId: string; inboundId: string; handle: TurnHandle }> {
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','paguei 50 no mercado', jsonb_build_object('remote_jid', $4::text))
       RETURNING id`,
      [TENANT, AGENT, conversaId, JID],
    );
    const inboundId = m.rows[0]!.id;
    const claimToken = randomUUID();
    const t = await c.query<{ id: string; state_version: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status, attempt_count,
          claim_token, claimed_by, claimed_at, lease_expires_at, state_version)
       VALUES ($1,$2,$3,$4,'running',1,$5,'sonda-635-fallback',now(),now() + interval '5 minutes',3)
       RETURNING id, state_version`,
      [TENANT, AGENT, inboundId, conversaId, claimToken],
    );
    const turnId = t.rows[0]!.id;
    return {
      turnId,
      inboundId,
      handle: {
        turn_id: turnId,
        status: 'running',
        state_version: Number(t.rows[0]!.state_version),
        attempt_count: 1,
        conversa_id: conversaId,
        // O commit só consulta `token`. Não é um espelho da transação: é a
        // ENTRADA que produção receberia, e tudo abaixo dela é código real.
        lease: { token: claimToken } as unknown as TurnLease,
      },
    };
  } finally {
    c.release();
  }
}

function ctxComEnquete(inboundId: string): Parameters<typeof dispatchOutput>[0] {
  return {
    pessoa: {
      id: pessoaId,
      telefone_whatsapp: '+5511900000636',
      preferencias: null,
    } as unknown as Pessoa,
    conversa: { id: conversaId, channel_id: null } as unknown as Conversa,
    inbound: {
      id: inboundId,
      conteudo: 'paguei 50 no mercado',
      metadata: { remote_jid: JID },
      tipo: 'texto',
    } as unknown as Mensagem,
    jid: JID,
    text: PERGUNTA,
    latestPending: { id: randomUUID(), opcoes_validas: [...OPCOES] },
    latestReportPdf: null,
    turnHasSensitive: false,
    sensitiveTools: [],
  };
}

/** Roda `fn` como a tentativa DONA do turno rodaria. */
function comoOWorkerDono<T>(handle: TurnHandle, fn: () => Promise<T>): Promise<T> {
  return noEscopo(() => runWithOutboundTurnScope(handle, fn));
}

type LinhaOutbound = {
  id: string;
  sequence_in_turn: number;
  payload_type: string;
  status: string;
  delivery_outcome: string | null;
  attempt: number;
  next_attempt_at: string | null;
};

async function linhasDoTurno(turnId: string): Promise<LinhaOutbound[]> {
  const { rows } = await pool.query<LinhaOutbound>(
    `SELECT id, sequence_in_turn, payload_type, status, delivery_outcome, attempt, next_attempt_at
       FROM outbound_messages WHERE turn_id = $1 ORDER BY sequence_in_turn`,
    [turnId],
  );
  return rows;
}

/** As saídas que o usuário enxerga na conversa. Contagem ABSOLUTA. */
async function saidasDaConversa(): Promise<Array<{ conteudo: string; tipo: string }>> {
  const { rows } = await pool.query<{ conteudo: string; tipo: string }>(
    `SELECT conteudo, tipo FROM mensagens
      WHERE conversa_id = $1 AND direcao = 'out' ORDER BY created_at`,
    [conversaId],
  );
  return rows;
}

/** Os ids que a varredura de entrega de #633 considera trabalho ENTREGÁVEL. */
async function idsEntregaveis(): Promise<string[]> {
  const candidatos = await noEscopo(() => outboundRecoveryRepo.listDeliverable(200));
  return candidatos.map((c) => c.outbound_id);
}

/**
 * AVANÇA o relógio do gate de backoff, explicitamente.
 *
 * O backoff de `rejected_retryable` na primeira tentativa é de 5 segundos
 * (`backoffSeconds(0)`), e nenhum caso de teste dura isso. Sem este empurrão a
 * sonda ficaria verde por SORTE — a linha estaria fora da varredura por causa
 * do relógio, não por causa do estado, e o defeito passaria despercebido.
 */
async function venceOBackoff(outbound_id: string): Promise<void> {
  await pool.query(
    `UPDATE outbound_messages SET next_attempt_at = now() - interval '1 hour' WHERE id = $1`,
    [outbound_id],
  );
}

d('#635 — depois do fallback enquete→texto, a enquete NUNCA é entregue (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 8 });
    // O ramo de enquete de `dispatchOutput` é gateado por esta flag (default
    // OFF). Sem ela a resposta sairia como texto simples e a suíte inteira
    // mediria o ramo errado.
    vi.spyOn(config, 'FEATURE_ONE_TAP', 'get').mockReturnValue(true);
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants(id, nome) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [
        TENANT,
        'sonda 635 fallback',
      ]);
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT, 'sonda 635 fallback'],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda 635 fallback',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, '+5511900000636'],
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
    vi.restoreAllMocks();
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
    await pool.end();
  });

  beforeEach(async () => {
    canal.pollSends.length = 0;
    canal.textSends.length = 0;
    canal.comSegredos = false;
    __resetDeliveryWorkerIdForTest();
    __resetOutboundRecoveryGaugesForTest();
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [TENANT]);
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTROLE A — o ramo de enquete EXISTE e o discriminador é o dos segredos.
  // ═══════════════════════════════════════════════════════════════════════

  it('CONTROLE: com os três segredos, a enquete VAI ao canal e não há fallback de texto', async () => {
    canal.comSegredos = true;
    const { turnId, inboundId, handle } = await novoTurno();

    await comoOWorkerDono(handle, () => dispatchOutput(ctxComEnquete(inboundId)));

    expect(canal.pollSends.map((p) => p.question)).toEqual([PERGUNTA]);
    expect(canal.textSends, 'com segredos não existe fallback').toEqual([]);

    const linhas = await linhasDoTurno(turnId);
    expect(linhas.map((l) => [l.sequence_in_turn, l.payload_type])).toEqual([
      [0, 'interactive_poll'],
    ]);
    // A conversa termina com a PERGUNTA da enquete, e só ela.
    expect((await saidasDaConversa()).map((m) => m.conteudo)).toEqual([PERGUNTA]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A SONDA — a invariante da fatia, em DOIS degraus.
  //
  // Dois `it` e não um só, e a razão é operacional: um `expect` que reprova
  // ABORTA o caso, então o degrau do canal nunca chegaria a rodar se o degrau
  // da fila reprovasse antes. Separados, o vermelho do defeito aparece nos
  // DOIS lugares — na fila e no telefone do usuário — em vez de um esconder o
  // outro.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Roda o turno de produção que cai no fallback e devolve o que ele produziu.
   *
   * Faz as asserções de que o RAMO FOI ALCANÇADO: sem elas, tudo o que vem
   * depois seria vácuo — "a enquete não voltou" também é verdade num turno em
   * que enquete nenhuma foi tentada.
   */
  async function turnoQueCaiNoFallback(): Promise<{
    enquete: LinhaOutbound;
    textoEntregue: string;
    diag: string;
  }> {
    const { turnId, inboundId, handle } = await novoTurno();
    await comoOWorkerDono(handle, () => dispatchOutput(ctxComEnquete(inboundId)));

    expect(canal.pollSends, 'a tentativa de enquete tem de ter acontecido').toHaveLength(1);
    expect(canal.textSends, 'o fallback de texto tem de ter acontecido').toHaveLength(1);
    const textoEntregue = canal.textSends[0]!.text;
    expect(textoEntregue).toContain(PERGUNTA);
    expect(textoEntregue).toContain('1. Alimentação');
    expect(textoEntregue).toContain('3. Moradia');

    const linhas = await linhasDoTurno(turnId);
    expect(
      linhas.map((l) => [l.sequence_in_turn, l.payload_type]),
      'posição 0 é a enquete; a 1 é o texto do fallback',
    ).toEqual([
      [0, 'interactive_poll'],
      [1, 'text'],
    ]);
    const enquete = linhas[0]!;
    return {
      enquete,
      textoEntregue,
      diag: `linha da enquete: status=${enquete.status} outcome=${enquete.delivery_outcome}`,
    };
  }

  it('DEGRAU 1 — a enquete substituída não volta à fila de entrega, nem depois de o backoff vencer', async () => {
    const { enquete, diag } = await turnoQueCaiNoFallback();

    expect(
      await idsEntregaveis(),
      `a enquete não pode ser trabalho entregável (${diag})`,
    ).not.toContain(enquete.id);

    // O relógio é avançado À MÃO para além dos 5s que `rejected_retryable`
    // armava (`backoffSeconds(0)`). É este passo que impede a sonda de passar
    // por sorte: sem ele, a linha estaria fora da varredura por causa do
    // RELÓGIO e não por causa do ESTADO.
    await venceOBackoff(enquete.id);
    expect(
      await idsEntregaveis(),
      `nem com o gate de backoff VENCIDO a enquete pode voltar à fila (${diag})`,
    ).not.toContain(enquete.id);

    // E a varredura de #633, rodada sobre o escopo, não rearma job nenhum.
    const stats = await noEscopo(() => runOutboundRecoveryForScope(SCOPE));
    expect(stats.rearmed, `a varredura não pode rearmar a enquete (${diag})`).toBe(0);
  });

  it('DEGRAU 2 — o delivery worker não reivindica a enquete, e a conversa termina só com o texto', async () => {
    const { enquete, textoEntregue, diag } = await turnoQueCaiNoFallback();
    // O mesmo empurrão de relógio do degrau 1: o worker é chamado no mundo em
    // que o backoff já venceu, que é o mundo em que o dano acontecia.
    await venceOBackoff(enquete.id);

    // `deliverOutbound` é a MESMA função que o job da fila chama (#632). O
    // `line` injetado é o dublê: se a produção reivindicasse a linha, o
    // `sendPoll` dele registraria o segundo envio — que é o dano, literal.
    const linha = await linhaDeSaida();
    const r = await noEscopo(() =>
      deliverOutbound({ outbound_id: enquete.id, jid: JID, line: linha }),
    );
    expect(r.delivered, `a enquete não pode ser entregue (${diag})`).toBe(false);
    expect(
      canal.pollSends,
      `a enquete NÃO pode ir ao canal uma segunda vez — é o duplo envio (${diag})`,
    ).toHaveLength(1);

    // A CONVERSA. O oráculo é o dublê: `textoEntregue` é a string EXATA que o
    // adaptador recebeu, e nenhum dos dois lados da comparação passa por uma
    // projeção escrita neste arquivo.
    expect(
      (await saidasDaConversa()).map((m) => m.conteudo),
      `a conversa tem de terminar com o texto do fallback e nada além (${diag})`,
    ).toEqual([textoEntregue]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTROLE B — o zero acima é causado pelo ESTADO, e por mais nada.
  // ═══════════════════════════════════════════════════════════════════════

  it('CONTROLE: uma linha de enquete em estado ENTREGÁVEL é selecionada e VAI ao canal', async () => {
    // Com segredos: o desfecho é `accepted_confirmed`, isto é, a enquete
    // CHEGOU. É o dano que a sonda acima existe para provar que não acontece.
    canal.comSegredos = true;
    const { turnId } = await novoTurno();
    const payload = {
      type: 'interactive_poll' as const,
      question: PERGUNTA,
      options: [...OPCOES],
    };
    const artefato = buildOutboundArtifact({
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id: turnId,
      sequence_in_turn: 0,
      payload,
      channel: 'whatsapp',
    });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel, status,
          delivery_outcome, attempt, turn_id, sequence_in_turn, payload_version, payload_type,
          payload_json, payload_hash, logical_dedupe_key, provider_idempotency_key,
          next_attempt_at, last_error_code)
       SELECT $1,$2,$3,$4, t.representative_message_id, 'text', 'retryable',
              'rejected_retryable', 0, $5, 0, $6, $7, $8::jsonb, $9, $10, $11,
              now() - interval '1 hour', 'superseded_by_text_fallback'
         FROM agent_turns t WHERE t.id = $5
       RETURNING id`,
      [
        TENANT,
        AGENT,
        artefato.logical_dedupe_key,
        conversaId,
        turnId,
        artefato.payload_version,
        artefato.payload_type,
        JSON.stringify(artefato.payload),
        artefato.payload_hash,
        artefato.logical_dedupe_key,
        artefato.provider_idempotency_key,
      ],
    );
    const id = rows[0]!.id;

    // A varredura de #633 SELECIONA `retryable` com o gate vencido…
    expect(await idsEntregaveis()).toContain(id);

    // …e o ciclo de #632 a reivindica e MANDA A ENQUETE ao canal.
    const linha = await linhaDeSaida();
    const r = await noEscopo(() => deliverOutbound({ outbound_id: id, jid: JID, line: linha }));
    expect(
      canal.pollSends.map((p) => p.question),
      'é isto que acontece com uma enquete deixada em `retryable`',
    ).toEqual([PERGUNTA]);
    expect(r.delivered, 'e ela CHEGA ao usuário').toBe(true);
  });
});

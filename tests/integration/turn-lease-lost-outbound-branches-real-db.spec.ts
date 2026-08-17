/**
 * Issue #504 §Fencing — os TRÊS ramos do outbound que NÃO passam por
 * `sendOutbound()`: documento (PDF), voz e enquete.
 *
 * ─── O vão que esta suíte fecha ─────────────────────────────────────────────
 *
 * `turn-lease-lost-effects-real-db.spec.ts` cobre o ramo de TEXTO, e o guard
 * que ela exercita mora dentro de `sendOutbound()`. Mas `safeDispatchOutput()`
 * entra primeiro em `dispatchOutput()`, e `dispatchOutput()` despacha:
 *
 *   PDF   → `line.sendDocument`   (nunca chama `sendOutbound`)
 *   voz   → `line.sendVoice`      (nunca chama `sendOutbound`, salvo fallback)
 *   poll  → `sendOutboundPoll`    (função exportada, ledger + `line.sendPoll`)
 *
 * Os três reivindicavam o ledger de #227 e produziam o EFEITO EXTERNO mesmo
 * com o `AbortSignal` da tentativa já abortado. Uma resposta em áudio ou um
 * boleto em PDF entregue por um worker desautorizado é tão irreversível quanto
 * o texto — mais, porque o usuário recebe DUAS respostas em mídias diferentes.
 *
 * ─── O que é real e o que é dublê, e por quê ────────────────────────────────
 *
 * REAL: a perda da posse (claim SQL → lease vencida → takeover por outro
 * worker → heartbeat descobre → `AbortSignal`), o `runWithTurnExecution` que
 * `src/agent/core.ts` abre em produção, o `safeDispatchOutput`/`dispatchOutput`
 * de produção, o ledger `outbound_messages` e a tabela `mensagens`.
 *
 * DUBLÊ: só a LINHA de saída (`forCurrentAgentChannel`) e o TTS. Ambos são
 * dependências EXTERNAS que não existem no ambiente de teste — sem canal
 * WhatsApp conectado, `sendDocument`/`sendVoice`/`sendPoll` devolvem `null` e
 * o ramo morre antes de provar qualquer coisa, e o caso de CONTROLE (que dá
 * significado à ausência) ficaria impossível de escrever. O dublê registra
 * QUAL primitiva de envio foi chamada — que é literalmente o efeito externo
 * que a issue existe para impedir.
 *
 * Nada do caminho de decisão é dublê: o ramo (PDF vs voz vs poll vs texto), o
 * fence e a persistência são o código de produção.
 *
 * ─── O caso de CONTROLE ─────────────────────────────────────────────────────
 *
 * Sem ele, "nenhum envio aconteceu" também passaria se o ramo nunca tivesse
 * sido alcançado (flag desligada, precedência errada, pendência com opções de
 * menos). O controle roda o MESMO contexto com a lease VIVA e exige a
 * primitiva CERTA chamada + linha no ledger. É ele que dá sentido ao zero.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { config } from '@/config/env.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';
/**
 * TTL da lease do DONO legitimo. 30s, e o numero importa.
 *
 * Era 1_500ms, e isso quebrava os casos de CONTROLE -- os que provam que, com
 * a lease VIVA, o efeito acontece normalmente. Medido no CI: o controle do
 * react-loop leva ~3.9s de corpo. Com TTL de 1.5s e heartbeat de 400ms, a
 * lease precisa ser renovada ~9 vezes DURANTE o caso, e
 * `MAX_HEARTBEAT_FAILURES` renovacoes falhas consecutivas a matam. Sob
 * contencao ela morre, o guard recusa o efeito, e o CONTROLE reprova com
 * `turn_ownership_lost` -- exatamente o que ele existe para provar que NAO
 * acontece. O `retry: 1` absorvia, e o vermelho so apareceu porque o bloco
 * RECUPERADOS PELA SEGUNDA TENTATIVA do reporter (#545/#566) o denunciou.
 *
 * Subir NAO enfraquece as BARREIRAS, e vale registrar por que: elas nao perdem
 * a posse por expiracao. `loseOwnershipForReal()` forca o vencimento por SQL
 * (`lease_expires_at = now() - interval '1 second'`) e entao um SUCESSOR
 * reivindica -- e o proprio helper afirma `lostReason === 'token_mismatch'`,
 * isto e, takeover. Verificado por sonda: com o TTL longo tambem nas
 * barreiras, elas continuam passando. O TTL curto nao era load-bearing para
 * nada; era so um cronometro competindo com o corpo do teste.
 */
const TTL_MS = 30_000;
const HEARTBEAT_MS = 400;

/**
 * Gravador da LINHA de saída. `vi.hoisted` porque a fábrica de `vi.mock` é
 * içada acima dos imports do arquivo — um `const` comum ainda estaria na zona
 * morta temporal quando a fábrica roda.
 */
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ kind: 'text' | 'document' | 'voice' | 'poll'; jid: string }>,
  channel_id: '',
  /**
   * Gancho de TEMPO: roda DENTRO do TTS dublê. É assim que a perda da posse
   * acontece no MEIO de `dispatchOutput` (depois da fronteira comum, antes do
   * envio), que é o que a revalidação por ramo existe para cobrir.
   */
  onTts: async (): Promise<void> => {},
}));

vi.mock('@/gateway/line-output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/gateway/line-output.js')>();
  const wid = (): string => `wid-${randomUUID()}`;
  const line = {
    get scope() {
      return { tenant_id: T, agent_id: A, channel_id: wire.channel_id };
    },
    async sendText(jid: string) {
      wire.calls.push({ kind: 'text', jid });
      return wid();
    },
    async sendDocument(jid: string) {
      wire.calls.push({ kind: 'document', jid });
      return wid();
    },
    async sendVoice(jid: string) {
      wire.calls.push({ kind: 'voice', jid });
      return wid();
    },
    async sendPoll(jid: string) {
      wire.calls.push({ kind: 'poll', jid });
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
    isConnected() {
      return true;
    },
  };
  return { ...actual, forCurrentAgentChannel: async () => line };
});

// O TTS é uma chamada HTTP à OpenAI. Sem o dublê, `synthesizeSpeech` falha, o
// ramo de voz cai no fallback de texto e o caso de controle provaria o ramo
// ERRADO (e a barreira passaria pelo guard de `sendOutbound`, não pelo novo).
vi.mock('@/lib/tts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tts.js')>();
  return {
    ...actual,
    synthesizeSpeech: async () => {
      await wire.onTts();
      return Buffer.from('audio-falso');
    },
  };
});

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;

const createdMensagens: string[] = [];
const createdPdfs: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function mkInbound(tipo: 'texto' | 'audio'): Promise<Mensagem> {
  const r = await pool.query(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', $4, 'oi', '{}'::jsonb)
     RETURNING *`,
    [T, A, conversa.id, tipo],
  );
  const row = r.rows[0] as Mensagem;
  createdMensagens.push(row.id);
  return row;
}

/** Turno + posse REAIS (mesma porta de produção: `tryClaimTurn`). */
async function claimWithLease(mensagem_id: string) {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  const { TurnLease } = await import('@/runtime/turns/lease.js');
  const turn = await agentTurnsRepo.ensureTurnForMessage({
    id: mensagem_id,
    tenant_id: T,
    agent_id: A,
    conversa_id: conversa.id,
    channel_id: null,
  });
  const claimed = await agentTurnsRepo.tryClaimTurn({
    turn_id: turn.id,
    worker_id: `dono-${randomUUID().slice(0, 8)}`,
    lease_ms: TTL_MS,
  });
  expect(claimed.ok, 'o dono legítimo deveria ter conseguido o claim').toBe(true);
  if (!claimed.ok) throw new Error('claim não concedido');
  return {
    turn_id: turn.id,
    lease: new TurnLease(claimed.claim, { ttl_ms: TTL_MS, heartbeat_ms: HEARTBEAT_MS }),
  };
}

/** Perda pelo caminho REAL: takeover no SQL + heartbeat do dono descobrindo. */
async function loseOwnershipForReal(
  turn_id: string,
  lease: { alive: boolean; lostReason: string | null },
): Promise<void> {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await agentTurnsRepo.tryClaimTurn({
    turn_id,
    worker_id: `sucessor-${randomUUID().slice(0, 8)}`,
    lease_ms: 60_000,
  });
  expect(successor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);
  const deadline = Date.now() + 10_000;
  while (lease.alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lease.alive, 'o heartbeat real deveria ter detectado a perda').toBe(false);
  expect(lease.lostReason, 'a perda tem de vir do TAKEOVER, não de erro de banco').toBe(
    'token_mismatch',
  );
}

async function countOutboundLedger(mensagem_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbound_messages
      WHERE tenant_id=$1 AND agent_id=$2 AND in_reply_to=$3`,
    [T, A, mensagem_id],
  );
  return Number(r.rows[0]!.n);
}

async function countOutRows(mensagem_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM mensagens
      WHERE tenant_id=$1 AND agent_id=$2 AND direcao='out'
        AND metadata->>'in_reply_to' = $3`,
    [T, A, mensagem_id],
  );
  return Number(r.rows[0]!.n);
}

type Ramo = 'document' | 'voice' | 'poll';

/**
 * O `DispatchOutputCtx` que `react-loop.ts` monta, com o ramo forçado pelo
 * MESMO discriminador que a produção usa (`latestReportPdf` / `inbound.tipo`
 * + flag de voz / `latestPending` + `FEATURE_ONE_TAP`).
 */
async function ctxFor(ramo: Ramo, inbound: Mensagem) {
  const base = {
    pessoa,
    conversa,
    inbound,
    jid: '5511000000000@s.whatsapp.net',
    text: 'resposta do turno',
    latestPending: null as { id: string; opcoes_validas: Array<{ key: string; label: string }> } | null,
    latestReportPdf: null as
      | { path: string; fileName: string; mimetype: string; tipo: 'extrato' | 'comparativo' }
      | null,
    turnHasSensitive: false,
    sensitiveTools: [] as string[],
  };
  if (ramo === 'document') {
    const path = join(tmpdir(), `ll504-${randomUUID()}.pdf`);
    await writeFile(path, '%PDF-1.4 fake');
    createdPdfs.push(path);
    base.latestReportPdf = {
      path,
      fileName: 'extrato.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
    };
  }
  if (ramo === 'poll') {
    base.latestPending = {
      id: randomUUID(),
      opcoes_validas: [
        { key: 'a', label: 'Alimentação' },
        { key: 'b', label: 'Transporte' },
        { key: 'c', label: 'Moradia' },
      ],
    };
  }
  return base;
}

d('#504 — lease perdida: os ramos PDF / voz / poll do outbound', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    // Sem o ledger de #227 ligado, `outbound_messages` é no-op e o controle
    // não teria efeito de banco a exibir.
    vi.spyOn(config, 'FEATURE_OUTBOUND_DEDUP', 'get').mockReturnValue(true);
    // Discriminadores dos ramos de voz e poll.
    vi.spyOn(config, 'FEATURE_OUTBOUND_VOICE', 'get').mockReturnValue(true);
    vi.spyOn(config, 'FEATURE_ONE_TAP', 'get').mockReturnValue(true);

    const ch = await pool.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, external_id, channel_type, display_name, active)
       VALUES ($1,$2,$3,'whatsapp','ll504-branches', false) RETURNING id`,
      [T, A, `ll504-${randomUUID()}`],
    );
    wire.channel_id = ch.rows[0]!.id;

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'ll504-branches', $3, 'dono', 'ativa') RETURNING *`,
      [T, A, `+5511${Math.floor(Math.random() * 1e9)}`],
    );
    pessoa = p.rows[0] as Pessoa;

    const conv = await pool.query(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades, channel_id)
       VALUES ($1,$2,$3,'{}',$4) RETURNING *`,
      [T, A, pessoa.id, wire.channel_id],
    );
    conversa = conv.rows[0] as Conversa;
  }, 60_000);

  beforeEach(() => {
    wire.calls.length = 0;
    wire.onTts = async () => {};
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (createdMensagens.length > 0) {
      await pool.query(`DELETE FROM outbound_messages WHERE in_reply_to = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
    }
    await pool.query(`DELETE FROM audit_log WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM channels WHERE id = $1`, [wire.channel_id]);
    await pool.end();
    for (const p of createdPdfs) {
      if (existsSync(p)) await import('node:fs/promises').then((m) => m.unlink(p).catch(() => {}));
    }
  });

  for (const ramo of ['document', 'voice', 'poll'] as const) {
    const tipoInbound = ramo === 'voice' ? 'audio' : 'texto';

    it(`CONTROLE (${ramo}): com a lease VIVA o ramo ${ramo} envia e reivindica o ledger`, async () => {
      const { safeDispatchOutput } = await import('@/agent/output-dispatch.js');
      const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

      const inbound = await mkInbound(tipoInbound);
      const ctx = await ctxFor(ramo, inbound);

      let outcome: { status: string } | null = null;
      await inT(async () => {
        const { lease } = await claimWithLease(inbound.id);
        await runWithTurnExecution(lease.context(), async () => {
          outcome = await safeDispatchOutput(ctx);
        });
        lease.stop();
      });

      // Se este bloco quebrar, o ramo não foi alcançado e o caso da barreira
      // abaixo passaria sem provar nada.
      expect(
        wire.calls.map((c) => c.kind),
        `a linha deveria ter recebido um envio de ${ramo}`,
      ).toEqual([ramo]);
      expect(await countOutboundLedger(inbound.id), 'ledger reivindicado').toBe(1);
      expect(await countOutRows(inbound.id), 'a mensagem de saída deveria estar persistida').toBe(1);
      expect(outcome).toEqual({ status: 'delivered' });
    }, 60_000);

    it(`BARREIRA (${ramo}): perdida a lease, safeDispatchOutput não envia ${ramo} nem toca o ledger`, async () => {
      const { safeDispatchOutput } = await import('@/agent/output-dispatch.js');
      const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

      const inbound = await mkInbound(tipoInbound);
      const ctx = await ctxFor(ramo, inbound);

      let outcome: { status: string; error?: string } | null = null;
      await inT(async () => {
        const { turn_id, lease } = await claimWithLease(inbound.id);
        await runWithTurnExecution(lease.context(), async () => {
          // A tentativa JÁ está dentro do contexto; só então a posse é perdida.
          await loseOwnershipForReal(turn_id, lease);
          outcome = await safeDispatchOutput(ctx);
        });
      });

      // O EFEITO primeiro, o valor de retorno depois: um expect sobre o
      // retorno colocado antes abortaria o teste e a saída vermelha esconderia
      // justamente o efeito que a issue existe para impedir.
      expect(
        await countOutboundLedger(inbound.id),
        'nenhum outbound pode ter sido sequer reivindicado sem posse',
      ).toBe(0);
      expect(
        wire.calls,
        `o ramo ${ramo} não pode ter chamado a linha de saída sem posse`,
      ).toEqual([]);
      expect(await countOutRows(inbound.id), 'nenhuma row de saída sem posse').toBe(0);

      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe('not_sent');
      expect(outcome!.error).toContain('turn_ownership_lost');
    }, 60_000);
  }

  /**
   * ─── Por que estes dois casos existem além dos de cima ───────────────────
   *
   * Nos casos acima a posse já está perdida quando `safeDispatchOutput` é
   * chamado, e o corte rápido da entrada de `dispatchOutput` basta para
   * barrar. Mas a posse pode acabar DEPOIS dessa entrada: entre ela e o envio
   * há awaits reais (resolução da linha, consulta de pendência, síntese de
   * voz — uma chamada de rede). Um guard só na entrada seria de novo uma
   * FOTOGRAFIA, não um fence no limite do efeito.
   *
   * Aqui a perda continua sendo produzida pelo mecanismo REAL (takeover no SQL
   * + heartbeat do dono descobrindo); o que estes casos escolhem é o INSTANTE,
   * usando um await que o próprio `dispatchOutput` já faz como gancho.
   */
  it('BARREIRA (voice): posse perdida DURANTE o TTS não deixa a voz sair', async () => {
    const { safeDispatchOutput } = await import('@/agent/output-dispatch.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const inbound = await mkInbound('audio');
    const ctx = await ctxFor('voice', inbound);

    let outcome: { status: string; error?: string } | null = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      // A posse está VIVA quando `safeDispatchOutput` é chamado — a entrada de
      // `dispatchOutput` passa. Só durante o TTS a lease é tomada.
      wire.onTts = async () => {
        await loseOwnershipForReal(turn_id, lease);
      };
      await runWithTurnExecution(lease.context(), async () => {
        outcome = await safeDispatchOutput(ctx);
      });
    });

    expect(await countOutboundLedger(inbound.id), 'nenhum ledger sem posse').toBe(0);
    expect(wire.calls, 'a voz não pode ter saído').toEqual([]);
    expect(await countOutRows(inbound.id), 'nenhuma row de saída sem posse').toBe(0);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('not_sent');
    expect(outcome!.error).toContain('turn_ownership_lost');
  }, 60_000);

  it('BARREIRA (document): posse perdida DEPOIS da fronteira comum não deixa o PDF sair', async () => {
    const { safeDispatchOutput } = await import('@/agent/output-dispatch.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const inbound = await mkInbound('texto');
    const ctx = await ctxFor('document', inbound);

    let outcome: { status: string; error?: string } | null = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      // `findActiveSnapshot` é um await REAL do bloco pre-send de
      // `dispatchOutput`, entre a fronteira comum e o ramo do PDF. Usá-lo como
      // gancho não substitui nada do caminho: o spy delega para o repositório
      // de verdade depois de provocar o takeover.
      const original = pendingQuestionsRepo.findActiveSnapshot.bind(pendingQuestionsRepo);
      const spy = vi
        .spyOn(pendingQuestionsRepo, 'findActiveSnapshot')
        .mockImplementation(async (conversa_id: string) => {
          await loseOwnershipForReal(turn_id, lease);
          return original(conversa_id);
        });
      try {
        await runWithTurnExecution(lease.context(), async () => {
          outcome = await safeDispatchOutput(ctx);
        });
      } finally {
        spy.mockRestore();
      }
    });

    expect(await countOutboundLedger(inbound.id), 'nenhum ledger sem posse').toBe(0);
    expect(wire.calls, 'o documento não pode ter saído').toEqual([]);
    expect(await countOutRows(inbound.id), 'nenhuma row de saída sem posse').toBe(0);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('not_sent');
    expect(outcome!.error).toContain('turn_ownership_lost');
  }, 60_000);

  it('BARREIRA: sendOutboundPoll chamado DIRETO também recusa sem posse', async () => {
    const { sendOutboundPoll } = await import('@/agent/output-dispatch.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const inbound = await mkInbound('texto');
    const pending = {
      id: randomUUID(),
      opcoes_validas: [
        { key: 'a', label: 'Alimentação' },
        { key: 'b', label: 'Transporte' },
        { key: 'c', label: 'Moradia' },
      ],
    };

    let err: (Error & { delivered?: boolean }) | null = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      await runWithTurnExecution(lease.context(), async () => {
        await loseOwnershipForReal(turn_id, lease);
        err = await sendOutboundPoll(
          pessoa.id,
          conversa.id,
          'escolha',
          inbound.id,
          pending,
          { channel_id: conversa.channel_id },
        ).then(
          () => null,
          (e: unknown) => e as Error & { delivered?: boolean },
        );
      });
    });

    expect(await countOutboundLedger(inbound.id), 'nenhum ledger sem posse').toBe(0);
    expect(wire.calls, 'nenhum envio de poll sem posse').toEqual([]);
    expect(err, 'sendOutboundPoll deveria ter recusado').not.toBeNull();
    expect(err!.delivered, 'recusa é PRE-SEND: nada chegou ao usuário').toBe(false);
    expect(err!.message).toContain('turn_ownership_lost');
  }, 60_000);
});

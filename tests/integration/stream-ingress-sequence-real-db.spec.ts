/**
 * Issue #505 (fases 1–2, shadow) — sequência de ingresso contra PostgreSQL REAL
 * (migrations 118 + 119).
 *
 * Por que nada aqui pode ser mock: o objeto sob teste é uma CORRIDA entre
 * transações. Quem garante a monotonicidade é o lock de row do Postgres no
 * `INSERT … ON CONFLICT DO UPDATE`, e quem garante que uma reentrega não queima
 * sequência é o ROLLBACK. Um dublê de banco reproduziria a API e nenhuma das
 * duas coisas — passaria feliz com um `SELECT max()+1` no lugar do UPSERT.
 *
 * Entrada pelo REPOSITÓRIO de produção (`mensagensRepo.createInbound`), não por
 * SQL montado aqui: um teste que reescrevesse a alocação com o próprio harness
 * continuaria verde depois de alguém deletar o caminho real.
 *
 * O que se prova:
 *   1. ingressos da mesma stream recebem sequências 1..N, únicas e monotônicas;
 *   2. 50 ingressos CONCORRENTES na mesma stream não repetem nem pulam número;
 *   3. reentrega do mesmo `whatsapp_id` reusa a row — e a sequência — original;
 *   4. reentrega CONCORRENTE aloca uma única sequência (a perdedora devolve a
 *      dela no rollback);
 *   5. o turno nasce com `first_ingress_seq = last_ingress_seq` (turno simples);
 *   6. a unique parcial recusa fisicamente uma segunda linha com a mesma
 *      (tenant, agent, stream_key, ingress_seq);
 *   7. streams iguais em TENANTS diferentes têm contadores independentes —
 *      §Acceptance "streams iguais em tenants/agents diferentes permanecem
 *      isoladas";
 *   8. identidade irresolúvel é RECUSADA e nada é persistido;
 *   9. o CHECK do banco recusa uma stream sob o literal `'default'` mesmo que
 *      alguém contorne a aplicação.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { deriveStreamKey } from '@/runtime/turns/stream-key.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED — `agents.id` é PK global e outras suítes semeiam a mesma base.
const T_A = 'stream505-tenant-a';
const A_A = 'stream505-agent-a';
const T_B = 'stream505-tenant-b';
const A_B = 'stream505-agent-b';

const CANAL = '505c0505-0505-4505-8505-050505050505';
const OUTRA_LINHA = '505c0505-0505-4505-8505-050505050506';
// `channels.id` é PK GLOBAL e a FK de `mensagens` é composta por (tenant,
// agent, id): tenant B precisa da linha DELE. A propriedade "mesma linha em
// tenants diferentes ⇒ chaves diferentes" é provada logo abaixo, na derivação
// pura, onde ela não depende de o banco conseguir representar o cenário.
const CANAL_B = '505c0505-0505-4505-8505-05050505050b';
const TELEFONE = '+5511988887777';

let pool: pg.Pool;
let repos: typeof import('../../src/db/repositories.js');

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

/**
 * `mensagens.channel_id` tem FK COMPOSTA para `channels (tenant_id, agent_id,
 * id)` (migration 090), então a LINHA precisa existir.
 *
 * `active = false` de propósito: `channels_active_line_uq` é uma unique GLOBAL
 * sobre (channel_type, external_id) para linhas whatsapp ATIVAS, e uma linha
 * ativa semeada aqui poderia disputar com outra suíte. Nada neste arquivo
 * resolve canal — a linha existe só para satisfazer a FK.
 */
async function ensureChannel(tenant: string, agent: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO channels (id, tenant_id, agent_id, external_id, channel_type, active)
     VALUES ($1, $2, $3, $4, 'whatsapp', false)
     ON CONFLICT (id) DO NOTHING`,
    [id, tenant, agent, `stream505-${id}`],
  );
}

/** O inbound como o gateway o monta (`src/gateway/baileys.ts`). */
function inbound(
  over: {
    whatsapp_id?: string;
    telefone?: string | null;
    channel_id?: string | null;
  } = {},
) {
  return {
    conversa_id: null,
    channel_id: over.channel_id === undefined ? CANAL : over.channel_id,
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    midia_url: null,
    metadata: {
      whatsapp_id: over.whatsapp_id ?? `wa-${randomUUID()}`,
      remote_jid: '5511988887777@s.whatsapp.net',
      telefone: over.telefone === undefined ? TELEFONE : over.telefone,
    },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
  } as never;
}

const chaveEsperada = (tenant: string, agent: string, channel_id = CANAL): string => {
  const derived = deriveStreamKey({
    tenant_id: tenant,
    agent_id: agent,
    channel_kind: 'whatsapp',
    channel_id,
    remote_identity: TELEFONE,
  });
  if (!derived.ok) throw new Error(`derivação falhou: ${derived.reason}`);
  return derived.stream_key;
};

d('#505 — sequência de ingresso por stream (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    repos = await import('../../src/db/repositories.js');
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
    await ensureChannel(T_A, A_A, CANAL);
    await ensureChannel(T_A, A_A, OUTRA_LINHA);
    await ensureChannel(T_B, A_B, CANAL_B);
  }, 20_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
  });

  it('ingressos sequenciais recebem 1, 2, 3 na mesma stream', async () => {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      rows.push(await inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true })));
    }
    expect(rows.map((r) => r.row.ingress_seq)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((r) => r.row.stream_key))).toEqual(new Set([chaveEsperada(T_A, A_A)]));
    expect(rows.every((r) => r.row.stream_key_version === 1)).toBe(true);
  });

  it('o turno simples nasce com first_ingress_seq = last_ingress_seq', async () => {
    const { turn } = await inA(() =>
      repos.mensagensRepo.createInbound(inbound(), { withTurn: true }),
    );
    expect(turn).toBeDefined();
    const { rows } = await pool.query(
      `SELECT stream_key, stream_key_version, first_ingress_seq, last_ingress_seq
         FROM agent_turns WHERE id = $1`,
      [turn!.id],
    );
    expect(rows[0]).toMatchObject({
      stream_key: chaveEsperada(T_A, A_A),
      stream_key_version: 1,
      first_ingress_seq: '1',
      last_ingress_seq: '1',
    });
  });

  it('50 ingressos CONCORRENTES na mesma stream: 50 sequências únicas, sem buraco', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 50 }, () =>
        inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true })),
      ),
    );
    const seqs = resultados.map((r) => r.row.ingress_seq!).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(50);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  }, 20_000);

  it('reentrega do mesmo whatsapp_id reusa a row — e a sequência — original', async () => {
    const wa = `wa-fixo-${randomUUID()}`;
    const primeiro = await inA(() =>
      repos.mensagensRepo.createInbound(inbound({ whatsapp_id: wa }), { withTurn: true }),
    );
    const reentrega = await inA(() =>
      repos.mensagensRepo.createInbound(inbound({ whatsapp_id: wa }), { withTurn: true }),
    );
    expect(reentrega.duplicate).toBe(true);
    expect(reentrega.row.id).toBe(primeiro.row.id);
    expect(reentrega.row.ingress_seq).toBe(primeiro.row.ingress_seq);

    // E o contador NÃO avançou: a stream ainda está em 1.
    const { rows } = await pool.query(
      `SELECT last_ingress_seq FROM agent_stream_sequences
        WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3`,
      [T_A, A_A, chaveEsperada(T_A, A_A)],
    );
    expect(rows[0]?.last_ingress_seq).toBe('1');
  });

  it('reentrega CONCORRENTE do mesmo evento aloca UMA única sequência', async () => {
    // As duas passam o pre-check (nenhuma comitou ainda) e correm para o
    // INSERT. A perdedora leva 23505, a transação inteira reverte — contador
    // incluído — e ela relê a row vencedora. Se a alocação estivesse FORA da
    // transação, o número da perdedora ficaria queimado e a stream teria um
    // buraco permanente.
    const wa = `wa-corrida-${randomUUID()}`;
    const [x, y] = await Promise.all([
      inA(() => repos.mensagensRepo.createInbound(inbound({ whatsapp_id: wa }), { withTurn: true })),
      inA(() => repos.mensagensRepo.createInbound(inbound({ whatsapp_id: wa }), { withTurn: true })),
    ]);
    expect(x.row.id).toBe(y.row.id);
    expect(x.row.ingress_seq).toBe(y.row.ingress_seq);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM mensagens
        WHERE tenant_id = $1 AND agent_id = $2 AND stream_key IS NOT NULL`,
      [T_A, A_A],
    );
    expect(rows[0]?.n).toBe(1);

    // A ASSERÇÃO QUE PEGA A ALOCAÇÃO FORA DA TRANSAÇÃO.
    //
    // Com a alocação DENTRO da transação, a perdedora reverte o incremento e o
    // contador fica em 1. Com ela FORA (ou num `db` em vez do `tx`), as duas
    // corridas alocam — 1 e 2 —, só uma linha sobrevive, e o contador fica em 2:
    // a stream passa a ter um BURACO permanente na numeração, e nenhuma das
    // asserções acima muda de cor. Este número é a única testemunha.
    const contador = await pool.query(
      `SELECT last_ingress_seq FROM agent_stream_sequences
        WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3`,
      [T_A, A_A, chaveEsperada(T_A, A_A)],
    );
    expect(contador.rows[0]?.last_ingress_seq).toBe('1');
  });

  it('a unique parcial recusa FISICAMENTE uma segunda linha com a mesma sequência', async () => {
    // A alocação é o caminho bem-comportado; a unique é o que transforma
    // qualquer OUTRO alocador (backfill, replay, psql) em violação visível.
    const chave = chaveEsperada(T_A, A_A);
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata,
                              stream_key, stream_key_version, ingress_seq)
       VALUES ($1, $2, $3, 'in', 'texto', 'a', '{}'::jsonb, $4, 1, 42)`,
      [randomUUID(), T_A, A_A, chave],
    );
    await expect(
      pool.query(
        `INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata,
                                stream_key, stream_key_version, ingress_seq)
         VALUES ($1, $2, $3, 'in', 'texto', 'b', '{}'::jsonb, $4, 1, 42)`,
        [randomUUID(), T_A, A_A, chave],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('streams do MESMO remoto em tenants diferentes são isoladas (chave e contador)', async () => {
    // §Falhas 7 — "o mesmo remote_jid em tenants diferentes compartilha
    // lock/chave" é uma das falhas que a issue existe para impedir.
    //
    // A metade da CHAVE é provada na derivação de produção, com a MESMA linha
    // nos dois lados — cenário que o banco nem consegue representar, já que
    // `channels.id` é PK global e a FK de `mensagens` é composta por (tenant,
    // agent, id).
    expect(chaveEsperada(T_A, A_A, CANAL)).not.toBe(chaveEsperada(T_B, A_B, CANAL));

    // A metade do CONTADOR é provada no banco: duas linhas, duas sequências que
    // começam do 1 sem se ver.
    const a = await inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true }));
    const b = await inB(() =>
      repos.mensagensRepo.createInbound(inbound({ channel_id: CANAL_B }), { withTurn: true }),
    );

    expect(a.row.stream_key).not.toBe(b.row.stream_key);
    // Contadores independentes: ambos começam do 1.
    expect(a.row.ingress_seq).toBe(1);
    expect(b.row.ingress_seq).toBe(1);

    const { rows } = await pool.query(
      `SELECT tenant_id, stream_key FROM agent_stream_sequences WHERE tenant_id = ANY($1)
        ORDER BY tenant_id`,
      [[T_A, T_B]],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].stream_key).not.toBe(rows[1].stream_key);
  });

  it('o MESMO remoto em duas LINHAS do mesmo agente são duas streams', async () => {
    const linhaA = await inA(() =>
      repos.mensagensRepo.createInbound(inbound(), { withTurn: true }),
    );
    const linhaB = await inA(() =>
      repos.mensagensRepo.createInbound(inbound({ channel_id: OUTRA_LINHA }), { withTurn: true }),
    );
    expect(linhaA.row.stream_key).toBe(chaveEsperada(T_A, A_A));
    expect(linhaB.row.stream_key).toBe(chaveEsperada(T_A, A_A, OUTRA_LINHA));
    expect(linhaA.row.stream_key).not.toBe(linhaB.row.stream_key);
    expect(linhaB.row.ingress_seq).toBe(1);
  });

  it('turno agregado ESTENDE last_ingress_seq — e só com ingressos da MESMA stream', async () => {
    // Três ingressos na stream A (seqs 1,2,3) e um na stream B (linha
    // diferente, seq 1). O turno do primeiro absorve as irmãs.
    const m1 = await inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true }));
    const m2 = await inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true }));
    const m3 = await inA(() => repos.mensagensRepo.createInbound(inbound(), { withTurn: true }));
    const outraStream = await inA(() =>
      repos.mensagensRepo.createInbound(inbound({ channel_id: OUTRA_LINHA }), { withTurn: true }),
    );

    const estendeu = await inA(() =>
      repos.agentTurnsRepo.extendTurnStreamBoundaryTx({
        turn_id: m1.turn!.id,
        // A mensagem da OUTRA stream entra na lista DE PROPÓSITO: ela não pode
        // mover a fronteira. Sem o predicado `m.stream_key = agent_turns.stream_key`
        // ela alargaria o intervalo deste turno até cobrir sequência que ele
        // nunca consumiu — e o head-of-line barraria a stream errada.
        mensagem_ids: [m2.row.id, m3.row.id, outraStream.row.id],
      }),
    );
    expect(estendeu).toBe(true);

    const { rows } = await pool.query(
      `SELECT first_ingress_seq, last_ingress_seq FROM agent_turns WHERE id = $1`,
      [m1.turn!.id],
    );
    expect(rows[0]).toMatchObject({ first_ingress_seq: '1', last_ingress_seq: '3' });
  });

  it('identidade irresolúvel: RECUSA e NADA é persistido', async () => {
    await expect(
      inA(() =>
        repos.mensagensRepo.createInbound(inbound({ channel_id: null }), { withTurn: true }),
      ),
    ).rejects.toMatchObject({ code: 'STREAM_IDENTITY_UNRESOLVED' });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM mensagens WHERE tenant_id = $1`,
      [T_A],
    );
    expect(rows[0]?.n).toBe(0);

    // A RECUSA CHEGA A `audit_log` DE VERDADE.
    //
    // Não é redundante com o `expect(auditMock)` do teste unitário: lá o módulo
    // de auditoria é um dublê. Aqui a escrita percorre o grafo real, que tem um
    // CICLO de import (`repositories -> stream-ingress -> governance/audit ->
    // repositories`). ESM resolve ciclos por live binding, e `audit()` engole a
    // própria falha de escrita num `catch` — ou seja, um `auditRepo` ainda em
    // TDZ apareceria como recusa "silenciosamente não auditada", que é o pior
    // desfecho possível para uma trilha. Esta asserção é o que impede isso de
    // passar despercebido.
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'stream_ingress_rejected'
        ORDER BY created_at DESC LIMIT 1`,
      [T_A],
    );
    expect(trilha.rows).toHaveLength(1);
    expect(trilha.rows[0].metadata).toMatchObject({ reason: 'missing_channel' });
  });

  it("o BANCO recusa uma stream sob o literal 'default', mesmo por fora da aplicação", async () => {
    await expect(
      pool.query(
        `INSERT INTO agent_stream_sequences (tenant_id, agent_id, stream_key, stream_key_version)
         VALUES ('default', 'default', 'v1:deadbeef', 1)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a coerência do trio (chave, versão, sequência) é imposta pelo CHECK', async () => {
    // Meio-preenchido é o estado que faria uma leitura futura acreditar numa
    // stream sem ordem — ou numa ordem sem stream.
    await expect(
      pool.query(
        `INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata, stream_key)
         VALUES ($1, $2, $3, 'in', 'texto', 'x', '{}'::jsonb, 'v1:abc')`,
        [randomUUID(), T_A, A_A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o CHECK do turno recusa fronteira invertida', async () => {
    await expect(
      pool.query(
        `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id,
                                  stream_key, stream_key_version, first_ingress_seq, last_ingress_seq)
         VALUES ($1, $2, $3, $4, 'v1:abc', 1, 9, 2)`,
        [randomUUID(), T_A, A_A, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/**
 * Issue #628 (fatia E da #505) — DEBOUNCE TRANSACIONAL contra PostgreSQL REAL
 * (migrations 120 + 122 + 124 + 126 + 127 + 130).
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é uma CORRIDA entre transações. Quem garante que duas
 * réplicas não fecham batches sobrepostos é o lock de row do PostgreSQL na
 * linha de `agent_stream_sequences` mais o `debounce_closed_at IS NULL` do
 * UPDATE; quem garante que a janela sobrevive a um reinício é a coluna. Um
 * dublê de banco reproduziria a API e nenhuma das duas coisas — passaria feliz
 * com um `Map` no lugar do mutex.
 *
 * Toda entrada é pela porta real, carregada por `moduloDeProducao`:
 * `mensagensRepo.createInbound` (o ingresso), `runStreamDebounceCloser` (o
 * varredor de produção, com orçamento de uma passada) e
 * `agentTurnsRepo.closeDueDebounceBatch` (o fechamento). A ÚNICA coisa dublada
 * é o transporte: `@/gateway/queue.js` abre `ioredis` no import, e a asserção
 * que interessa — "o wake-up foi disparado para ESTE turno" — se lê no
 * argumento, não no Redis.
 *
 * O que se prova:
 *   1. a janela é ABERTA na mesma transação do ingresso, e o turno fica
 *      `received` (não `queued`): não existe wake-up antes do fechamento;
 *   2. o ingresso seguinte ESTENDE o prazo em vez de abrir uma segunda janela;
 *   3. o TETO (`MESSAGE_DEBOUNCE_MAX_MS`) é ancorado no instante PERSISTIDO da
 *      abertura, e ele vence contra o reset;
 *   4. o prazo NÃO VENCIDO recusa o fechamento (`not_due`) — o relógio é o do
 *      banco;
 *   5. o fechamento agrupa a rajada: head `queued`, irmãos `superseded`,
 *      inputs reancorados, fronteira estendida, `debounce_batch_size` gravado;
 *   6. DUAS RÉPLICAS concorrentes: exatamente um fechamento, nenhuma
 *      sobreposição e nenhuma lacuna (critério de pronto da issue);
 *   7. um ingresso EM VOO tranca o fechamento (`stream_locked`) — a borda de
 *      serialização, escrita como comportamento;
 *   8. a LACUNA: mídia no meio da rajada FECHA o batch antes dela;
 *   9. KILL DO PROCESSO: a janela sobrevive e é fechada pelo varredor, que
 *      nunca viu nada em memória (critério de pronto da issue);
 *  10. `maia_stream_debounce_batch_size` é publicada, com o valor certo;
 *  11. streams iguais em TENANTS diferentes não se absorvem.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { deriveStreamKey } from '@/runtime/turns/stream-key.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

// As três flags da fatia, ANTES de qualquer import: `contractEnv` parseia sob
// demanda e MEMOIZA, então um `process.env` mexido dentro de `it()` chega
// tarde. `FEATURE_MESSAGE_DEBOUNCE` vem `false` no fixture do contrato (é o
// default do repositório), e sem ela o debounce transacional é inerte de
// propósito — a suíte inteira passaria sem exercer uma linha.
vi.hoisted(() => {
  process.env.FEATURE_MESSAGE_DEBOUNCE = 'true';
  process.env.FEATURE_TURN_STREAM_DEBOUNCE = 'true';
  process.env.FEATURE_TURN_HEAD_OF_LINE = 'true';
});

/**
 * O transporte, e SÓ ele. `enqueueAgent` é espionado porque a única coisa que o
 * fechamento pede à fila é o wake-up do head; a DECISÃO, que é o que a fatia
 * persiste, é verificada NO BANCO em todos os casos.
 */
const enqueueAgentMock = vi.fn(async () => {});
vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: (...args: unknown[]) => enqueueAgentMock(...(args as [])),
  QueueRedisUnavailableError: class QueueRedisUnavailableError extends Error {},
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'deb628-tenant-a';
const A_A = 'deb628-agent-a';
const T_B = 'deb628-tenant-b';
const A_B = 'deb628-agent-b';

const CANAL_A = '628c0628-0628-4628-8628-062806280628';
const CANAL_B = '628c0628-0628-4628-8628-06280628062b';
const TELEFONE = '+5511977776666';

/** `MESSAGE_DEBOUNCE_MS` / `MESSAGE_DEBOUNCE_MAX_MS` do fixture do contrato. */
const JANELA_MS = 5_000;
const TETO_MS = 30_000;

let pool: pg.Pool;

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

/** A FK composta de `mensagens.channel_id` exige a linha; `active=false` para
 *  não disputar a unique global de linha whatsapp ativa com outra suíte. */
async function ensureChannel(tenant: string, agent: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO channels (id, tenant_id, agent_id, external_id, channel_type, active)
     VALUES ($1, $2, $3, $4, 'whatsapp', false)
     ON CONFLICT (id) DO NOTHING`,
    [id, tenant, agent, `deb628-${id}`],
  );
}

/** O inbound como o gateway o monta (`src/gateway/baileys.ts`). */
function inbound(over: { tipo?: string; conteudo?: string; channel_id?: string } = {}) {
  return {
    conversa_id: null,
    channel_id: over.channel_id ?? CANAL_A,
    direcao: 'in',
    tipo: over.tipo ?? 'texto',
    conteudo: over.conteudo ?? 'oi',
    midia_url: null,
    metadata: {
      whatsapp_id: `wa-${randomUUID()}`,
      remote_jid: '5511977776666@s.whatsapp.net',
      telefone: TELEFONE,
    },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
  } as never;
}

const chaveDe = (tenant: string, agent: string, channel_id: string): string => {
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

async function lerTurno(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

/**
 * VIAGEM NO TEMPO, e é a única coisa que o harness força.
 *
 * Esperar 5 segundos reais por caso tornaria a suíte inutilizável, e mexer no
 * relógio do processo não adiantaria — a comparação acontece dentro do
 * PostgreSQL, que é exatamente o ponto da fatia. Empurrar o prazo para o
 * passado é o equivalente honesto: nada da lógica de fechamento é substituído,
 * só o instante em que ela passa a estar autorizada.
 */
async function vencerJanela(stream_key: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET debounce_deadline_at = now() - interval '1 second'
      WHERE stream_key = $1 AND debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL`,
    [stream_key],
  );
}

d('#628 — debounce transacional (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const worker = moduloDeProducao(() => import('@/workers/stream-debounce-closer.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  const debounce = moduloDeProducao(() => import('@/runtime/turns/stream-debounce.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
    await ensureChannel(T_A, A_A, CANAL_A);
    await ensureChannel(T_B, A_B, CANAL_B);
  }, 30_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    // `channels` PRIMEIRO: `channels_agent_id_fkey` referencia `agents`, e
    // derrubar o agente antes explode a limpeza inteira — o arquivo aparece
    // como "não carregou", que num relatório se parece com nada a testar.
    await pool?.query(`DELETE FROM channels WHERE id = ANY($1)`, [[CANAL_A, CANAL_B]]);
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1)`, [[A_A, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    enqueueAgentMock.mockClear();
    enqueueAgentMock.mockImplementation(async () => {});
    // Métrica ZERADA e RE-SEMEADA a cada caso: as asserções são ABSOLUTAS. Uma
    // asserção por DELTA sobre estado global mutável fica verde na SEGUNDA
    // tentativa do `retry: 1` do vitest, porque ela herda a mutação da primeira
    // como linha de base — e o processo sai com falharam=0 escondendo um
    // vermelho real.
    metricas()._resetForTests();
    debounce()._resetSeedForTests();
    debounce().registrarSeriesDeDebounce();
  });

  /** Uma mensagem de texto pela porta de produção. Devolve `{mensagem, turno}`. */
  async function texto(
    ctx: <T>(fn: () => Promise<T>) => Promise<T> = inA,
    over: { tipo?: string; conteudo?: string; channel_id?: string } = {},
  ): Promise<{ mensagem_id: string; turn_id: string; seq: number }> {
    const r = await ctx(() =>
      repos().mensagensRepo.createInbound(inbound(over), { withTurn: true }),
    );
    return {
      mensagem_id: r.row.id,
      turn_id: r.turn!.id,
      seq: Number(r.row.ingress_seq),
    };
  }

  // ─── 1–3: a JANELA, aberta na transação do ingresso ──────────────────────

  it('o ingresso ABRE a janela na mesma transação e deixa o turno em `received`', async () => {
    const m1 = await texto();
    const t = await lerTurno(m1.turn_id);
    expect(t['status']).toBe('received');
    expect(t['debounce_window_opened_at']).not.toBeNull();
    expect(t['debounce_deadline_at']).not.toBeNull();
    expect(t['debounce_closed_at']).toBeNull();
    // `queued` significa "existe wake-up para este turno", e ainda NÃO existe:
    // quem o cria é o fechamento. Carimbá-lo aqui faria o varredor de recovery
    // rearmar o turno por conta própria, furando a janela recém-aberta.
    expect(t['queued_at']).toBeNull();
    // O prazo é ~agora + MESSAGE_DEBOUNCE_MS, e vem do relógio do BANCO.
    const dist =
      new Date(t['debounce_deadline_at'] as string).getTime() -
      new Date(t['debounce_window_opened_at'] as string).getTime();
    expect(dist).toBeGreaterThan(JANELA_MS - 1_500);
    expect(dist).toBeLessThanOrEqual(JANELA_MS + 500);
  });

  it('o ingresso seguinte ESTENDE o prazo da janela — não abre uma segunda', async () => {
    const m1 = await texto();
    const prazo1 = new Date((await lerTurno(m1.turn_id))['debounce_deadline_at'] as string);
    const m2 = await texto();
    const t1 = await lerTurno(m1.turn_id);
    const t2 = await lerTurno(m2.turn_id);
    // O prazo do head ANDOU para a frente (o reset do debounce), e o irmão
    // recebeu o MESMO prazo — a janela é uma só, e qualquer membro sobrevivente
    // carrega o relógio dela.
    expect(new Date(t1['debounce_deadline_at'] as string).getTime()).toBeGreaterThan(
      prazo1.getTime(),
    );
    expect(t1['debounce_deadline_at']).toEqual(t2['debounce_deadline_at']);
    // A ABERTURA de cada um continua sendo a sua — é ela que ancora o teto do
    // primeiro, e reescrevê-la faria o teto nunca vencer.
    expect(new Date(t2['debounce_window_opened_at'] as string).getTime()).toBeGreaterThanOrEqual(
      new Date(t1['debounce_window_opened_at'] as string).getTime(),
    );
  });

  it('o TETO é ancorado na abertura PERSISTIDA e vence contra o reset', async () => {
    const m1 = await texto();
    // A janela abriu há 29,5s — o que um processo REINICIADO não teria como
    // saber se o dado não estivesse no banco.
    await pool.query(
      `UPDATE agent_turns SET debounce_window_opened_at = now() - interval '29.5 seconds'
        WHERE id = $1`,
      [m1.turn_id],
    );
    await texto();
    const t = await lerTurno(m1.turn_id);
    const restante =
      new Date(t['debounce_deadline_at'] as string).getTime() - Date.now();
    // O reset pediria +5s; o teto (abertura + 30s) só permite ~0,5s. `LEAST`
    // faz o teto vencer — é o que impede um usuário que digita sem parar de
    // adiar a resposta para sempre.
    expect(restante).toBeLessThan(JANELA_MS);
    expect(restante).toBeLessThan(TETO_MS - 29_000);
  });

  // ─── 4: o RELÓGIO PERSISTENTE recusa o fechamento antecipado ─────────────

  it('prazo NÃO vencido recusa o fechamento com `not_due`', async () => {
    await texto();
    const r = await inA(() =>
      repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chaveDe(T_A, A_A, CANAL_A) }),
    );
    expect(r).toEqual({ closed: false, reason: 'not_due' });
    // E o varredor não enxerga a stream: `listDueDebounceStreams` filtra por
    // `debounce_deadline_at <= now()` no BANCO.
    const devidas = await repos().agentTurnsRepo.listDueDebounceStreams(50);
    expect(devidas.filter((s) => s.tenant_id === T_A)).toEqual([]);
  });

  // ─── 5: o FECHAMENTO ─────────────────────────────────────────────────────

  it('o fechamento agrupa a rajada num turno só, com fronteira e inputs no head', async () => {
    const m1 = await texto(inA, { conteudo: 'oi' });
    const m2 = await texto(inA, { conteudo: 'como está' });
    const m3 = await texto(inA, { conteudo: 'a finança?' });
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await vencerJanela(chave);

    const r = await inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }));
    expect(r.closed).toBe(true);
    if (!r.closed) return;
    expect(r.batch_size).toBe(3);
    expect(r.head.turn_id).toBe(m1.turn_id);
    expect(new Set(r.absorbed_turn_ids)).toEqual(new Set([m2.turn_id, m3.turn_id]));

    const head = await lerTurno(m1.turn_id);
    expect(head['status']).toBe('queued');
    expect(head['debounce_batch_size']).toBe(3);
    expect(head['debounce_closed_at']).not.toBeNull();
    // A FRONTEIRA cobre o intervalo inteiro que o batch consumiu (§Relação
    // entre ingressos e turnos da issue-mãe).
    expect(Number(head['first_ingress_seq'])).toBe(m1.seq);
    expect(Number(head['last_ingress_seq'])).toBe(m3.seq);
    // `promoted_at` carimbado: fechar o batch É eleger quem avança, e é o que
    // permite ao varredor de recovery reconciliar "commit feito, enqueue não
    // feito" pelo caminho da #627.
    expect(head['promoted_at']).not.toBeNull();

    for (const id of [m2.turn_id, m3.turn_id]) {
      const irmao = await lerTurno(id);
      expect(irmao['status']).toBe('superseded');
      expect(irmao['outcome']).toBe('merged_into_turn');
      expect(irmao['superseded_by_turn_id']).toBe(m1.turn_id);
      expect(irmao['debounce_closed_at']).not.toBeNull();
    }

    // Os INPUTS foram reancorados: a composição do batch é um FATO do banco,
    // legível pelo executor, que roda em outro processo e outro instante.
    const batch = await inA(() =>
      repos().agentTurnsRepo.listClosedDebounceBatch(m1.turn_id),
    );
    expect(batch.map((b) => b.mensagem_id)).toEqual([
      m1.mensagem_id,
      m2.mensagem_id,
      m3.mensagem_id,
    ]);
    expect(batch.map((b) => b.conteudo)).toEqual(['oi', 'como está', 'a finança?']);
  });

  // ─── 6: DUAS RÉPLICAS ────────────────────────────────────────────────────

  it('duas réplicas concorrentes: UM fechamento, sem sobreposição e sem lacuna', async () => {
    const m1 = await texto();
    const m2 = await texto();
    const m3 = await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await vencerJanela(chave);

    // As duas réplicas ao MESMO tempo, sobre a MESMA stream.
    const [a, b] = await Promise.all([
      inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave })),
      inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave })),
    ]);
    const fechados = [a, b].filter((r) => r.closed);
    // ABSOLUTO, não delta: exatamente um.
    expect(fechados.length).toBe(1);
    const perdedor = [a, b].find((r) => !r.closed)!;
    expect(perdedor.closed).toBe(false);
    if (!perdedor.closed) {
      // Qualquer um dos três é uma recusa CORRETA — o que não pode acontecer é
      // um segundo `closed: true`.
      expect(['stream_locked', 'no_window', 'lost_race']).toContain(perdedor.reason);
    }

    // SEM SOBREPOSIÇÃO E SEM LACUNA: as três mensagens pertencem ao head, e a
    // nenhum outro turno.
    const { rows: inputs } = await pool.query(
      `SELECT turn_id, mensagem_id FROM agent_turn_inputs WHERE tenant_id = $1`,
      [T_A],
    );
    expect(inputs.length).toBe(3);
    expect(new Set(inputs.map((r) => r.turn_id))).toEqual(new Set([m1.turn_id]));
    expect(new Set(inputs.map((r) => r.mensagem_id))).toEqual(
      new Set([m1.mensagem_id, m2.mensagem_id, m3.mensagem_id]),
    );
    // E nenhum turno da stream ficou fora do desfecho: um head `queued`, dois
    // `superseded`. Um turno ainda `received` aqui seria a LACUNA.
    const { rows: estados } = await pool.query(
      `SELECT status, count(*)::int AS n FROM agent_turns WHERE tenant_id = $1 GROUP BY status`,
      [T_A],
    );
    expect(estados.sort((x, y) => x.status.localeCompare(y.status))).toEqual([
      { status: 'queued', n: 1 },
      { status: 'superseded', n: 2 },
    ]);
  });

  it('duas réplicas sobre um head JÁ `queued`: ainda UM fechamento só', async () => {
    // ESTE é o caso que o `state_version` NÃO cobre, e por isso ele é um teste
    // separado em vez de uma variação do de cima.
    //
    // A promoção do sucessor (#627) e o re-arme do varredor de recovery deixam
    // o head em `queued` ANTES de a janela fechar — acontece sempre que a
    // janela fica aberta além de `STUCK_AFTER_MS`. Nesse estado o fechamento
    // NÃO incrementa `state_version` (de propósito: re-armar um turno já
    // `queued` não é transição de estado, e bumpar invalidaria o CAS otimista
    // de uma absorção concorrente — a decisão da #627). Logo o CAS de versão
    // aprovaria as DUAS réplicas, e o único guarda que resta é
    // `debounce_closed_at IS NULL`.
    //
    // O segundo fechamento reescreveria `debounce_batch_size` para 1 (os
    // irmãos já saíram do prefixo) e dispararia um segundo wake-up: a evidência
    // forense da rajada passaria a MENTIR sobre quantas mensagens ela agrupou.
    const m1 = await texto();
    const m2 = await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await pool.query(
      `UPDATE agent_turns SET status = 'queued', queued_at = now() WHERE id = $1`,
      [m1.turn_id],
    );
    await vencerJanela(chave);

    const [a, b] = await Promise.all([
      inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave })),
      inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave })),
    ]);
    expect([a, b].filter((r) => r.closed).length).toBe(1);
    // ABSOLUTO: o tamanho gravado é o do batch REAL, não o de um segundo
    // fechamento que só achou o head.
    expect(Number((await lerTurno(m1.turn_id))['debounce_batch_size'])).toBe(2);
    expect((await lerTurno(m2.turn_id))['status']).toBe('superseded');
  });

  it('um fechamento SEQUENCIAL sobre a mesma stream não reabre nada (sem corrida)', async () => {
    // A corrida acima cobre o caminho concorrente; este cobre o SEQUENCIAL, em
    // que os dois fechadores não disputam lock nenhum e portanto o mutex não
    // recusa nenhum dos dois. Aqui só `debounce_closed_at IS NULL` responde.
    const m1 = await texto();
    await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await pool.query(`UPDATE agent_turns SET status = 'queued' WHERE id = $1`, [m1.turn_id]);
    await vencerJanela(chave);
    const primeiro = await inA(() =>
      repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }),
    );
    expect(primeiro.closed).toBe(true);
    // O head continua `queued` e vencido? Não: `debounce_closed_at` o tirou do
    // conjunto de membros. O segundo fechamento não acha janela.
    const segundo = await inA(() =>
      repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }),
    );
    expect(segundo).toEqual({ closed: false, reason: 'no_window' });
    expect(Number((await lerTurno(m1.turn_id))['debounce_batch_size'])).toBe(2);
  });

  // ─── 7: a BORDA DE SERIALIZAÇÃO ──────────────────────────────────────────

  it('um ingresso EM VOO tranca o fechamento — a borda é de serialização, não de relógio', async () => {
    await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await vencerJanela(chave);

    // Uma transação que já alocou `ingress_seq` e ainda NÃO comitou: ela segura
    // a linha de `agent_stream_sequences`, que é o mutex da stream.
    const emVoo = await pool.connect();
    try {
      await emVoo.query('BEGIN');
      await emVoo.query(
        `UPDATE agent_stream_sequences SET last_ingress_seq = last_ingress_seq + 1
          WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3`,
        [T_A, A_A, chave],
      );
      const r = await inA(() =>
        repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }),
      );
      // O fechador NÃO enxerga a stream pela metade: ele nem começa. É daqui
      // que sai a impossibilidade de lacuna — e não de um `ORDER BY` esperto.
      expect(r).toEqual({ closed: false, reason: 'stream_locked' });
    } finally {
      await emVoo.query('ROLLBACK');
      emVoo.release();
    }

    // Comitado (aqui, revertido) o ingresso, o mesmo fechamento passa.
    const depois = await inA(() =>
      repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }),
    );
    expect(depois.closed).toBe(true);
  });

  // ─── 8: a LACUNA ─────────────────────────────────────────────────────────

  it('mídia no meio da rajada FECHA o batch antes dela — a lacuna não é absorvida', async () => {
    const m1 = await texto(inA, { conteudo: 'olha isto' });
    // Áudio: nunca passa pelo debounce, portanto não recebe janela — e abre uma
    // lacuna numérica na sequência da stream.
    const audio = await texto(inA, { tipo: 'audio', conteudo: null as unknown as string });
    const m3 = await texto(inA, { conteudo: 'e isto' });
    const chave = chaveDe(T_A, A_A, CANAL_A);

    expect((await lerTurno(audio.turn_id))['debounce_window_opened_at']).toBeNull();

    await vencerJanela(chave);
    const r = await inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave }));
    expect(r.closed).toBe(true);
    if (!r.closed) return;
    // O batch é {m1}, e SÓ. Absorver m3 por cima do áudio responderia a
    // terceira mensagem antes da segunda — a inversão que a #505 existe para
    // impedir, produzida pela própria agregação.
    expect(r.batch_size).toBe(1);
    expect(r.absorbed_turn_ids).toEqual([]);
    expect(r.head.turn_id).toBe(m1.turn_id);
    expect((await lerTurno(m3.turn_id))['status']).toBe('received');
    expect((await lerTurno(m3.turn_id))['debounce_closed_at']).toBeNull();
  });

  // ─── 9: KILL DO PROCESSO ─────────────────────────────────────────────────

  it('kill do processo no meio da janela: ela sobrevive e o VARREDOR a fecha', async () => {
    const m1 = await texto();
    const m2 = await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    // O "kill": nada é preservado em memória por construção — não existe timer,
    // não existe chave no Redis, não existe estado de módulo. O que sobra é a
    // linha. Vencemos o prazo e chamamos o VARREDOR DE PRODUÇÃO, que descobre a
    // stream sozinho, CROSS-TENANT, sem receber nada deste teste.
    await vencerJanela(chave);
    enqueueAgentMock.mockClear();

    await worker().runStreamDebounceCloser({ budget_ms: 0 });

    const head = await lerTurno(m1.turn_id);
    expect(head['status']).toBe('queued');
    expect(head['debounce_batch_size']).toBe(2);
    expect((await lerTurno(m2.turn_id))['status']).toBe('superseded');
    // E o wake-up saiu para o HEAD, com `turn_id` (o que torna o `jobId`
    // determinístico e a promoção idempotente no transporte).
    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect(enqueueAgentMock.mock.calls[0]![0]).toMatchObject({
      mensagem_id: m1.mensagem_id,
      turn_id: m1.turn_id,
    });
  });

  it('o varredor é IDEMPOTENTE: uma segunda passada não reabre nem re-sinaliza', async () => {
    const m1 = await texto();
    await texto();
    await vencerJanela(chaveDe(T_A, A_A, CANAL_A));
    await worker().runStreamDebounceCloser({ budget_ms: 0 });
    enqueueAgentMock.mockClear();
    await worker().runStreamDebounceCloser({ budget_ms: 0 });
    expect(enqueueAgentMock).toHaveBeenCalledTimes(0);
    expect(Number((await lerTurno(m1.turn_id))['debounce_batch_size'])).toBe(2);
  });

  // ─── 10: a MÉTRICA que a issue nomeia ────────────────────────────────────

  it('`maia_stream_debounce_batch_size` é publicada, com baldes próprios e o valor certo', async () => {
    await texto();
    await texto();
    await texto();
    await vencerJanela(chaveDe(T_A, A_A, CANAL_A));
    await worker().runStreamDebounceCloser({ budget_ms: 0 });

    const corpo = await metricas().renderPrometheus();
    // ABSOLUTO: uma amostra, soma 3. Um delta ficaria verde na segunda
    // tentativa do `retry: 1` herdando a mutação da primeira.
    expect(corpo).toMatch(/^maia_stream_debounce_batch_size_count 1$/m);
    expect(corpo).toMatch(/^maia_stream_debounce_batch_size_sum 3$/m);
    // Baldes PRÓPRIOS: com os de milissegundos (50, 100, …) toda amostra
    // cairia em `le="50"` e a série não separaria nada.
    expect(corpo).toMatch(/^maia_stream_debounce_batch_size_bucket\{le="1"\} 0$/m);
    expect(corpo).toMatch(/^maia_stream_debounce_batch_size_bucket\{le="3"\} 1$/m);
    // E o desfecho contado, para que "não fechou nada" e "não rodou" não sejam
    // o mesmo silêncio.
    expect(corpo).toMatch(/^maia_stream_debounce_close_total\{result="closed"\} 1$/m);
    expect(corpo).toMatch(/^maia_stream_debounce_close_total\{result="not_due"\} 0$/m);
  });

  it('a auditoria `stream_batch_closed` registra a composição do batch', async () => {
    await texto();
    await texto();
    await vencerJanela(chaveDe(T_A, A_A, CANAL_A));
    await worker().runStreamDebounceCloser({ budget_ms: 0 });
    const { rows } = await pool.query(
      `SELECT acao, metadata FROM audit_log WHERE tenant_id = $1 AND acao = 'stream_batch_closed'`,
      [T_A],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.batch_size).toBe(2);
    expect(rows[0].metadata.absorbed_turn_ids.length).toBe(1);
    // A issue-mãe proíbe `stream_key` como dimensão de série; na `audit_log`
    // (armazenamento protegido) ela poderia aparecer, mas aqui não precisamos
    // dela — e não a gravamos.
    expect(JSON.stringify(rows[0].metadata)).not.toContain('v1:');
  });

  // ─── ATOMICIDADE: a falha cai ENTRE as escritas ──────────────────────────

  it('uma falha ENTRE as escritas desfaz o fechamento INTEIRO', async () => {
    // A lição da #631: um caso cuja falha acontece NA PRÓPRIA escrita fica
    // verde mesmo com a transação quebrada — o único jeito de provar
    // atomicidade é fazer a falha cair ENTRE duas escritas que precisam ser um
    // átomo. O fechamento faz três, nesta ordem: (a) fecha o head e o
    // enfileira, (b) supersede os irmãos, (c) reancora os inputs.
    //
    // O gatilho abaixo derruba (c). Se as três não estiverem na MESMA
    // transação, (a) e (b) sobrevivem — e o resultado é o pior estado
    // possível: um head `queued` que vai executar SEM as mensagens do batch, e
    // irmãos `superseded` cujo conteúdo nunca será respondido. Silenciosamente.
    const m1 = await texto();
    const m2 = await texto();
    const chave = chaveDe(T_A, A_A, CANAL_A);
    await vencerJanela(chave);

    await pool.query(`
      CREATE OR REPLACE FUNCTION deb628_falha_no_reancorar() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'deb628: falha injetada entre as escritas do fechamento';
      END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER deb628_trg BEFORE UPDATE ON agent_turn_inputs
      FOR EACH ROW EXECUTE FUNCTION deb628_falha_no_reancorar()`);
    try {
      await expect(
        inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: chave })),
      ).rejects.toThrow(/deb628/);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS deb628_trg ON agent_turn_inputs`);
      await pool.query(`DROP FUNCTION IF EXISTS deb628_falha_no_reancorar()`);
    }

    // NADA sobreviveu: nem o fechamento do head, nem a supersessão do irmão.
    const head = await lerTurno(m1.turn_id);
    expect(head['status']).toBe('received');
    expect(head['debounce_closed_at']).toBeNull();
    expect(head['debounce_batch_size']).toBeNull();
    expect(head['promoted_at']).toBeNull();
    const irmao = await lerTurno(m2.turn_id);
    expect(irmao['status']).toBe('received');
    expect(irmao['superseded_by_turn_id']).toBeNull();

    // E a janela continua ABERTA e vencida — a rajada não se perdeu, ela volta
    // a ser candidata na próxima passada do varredor.
    const devidas = await repos().agentTurnsRepo.listDueDebounceStreams(50);
    expect(devidas.some((s) => s.stream_key === chave)).toBe(true);
  });

  // ─── 11: ISOLAMENTO ──────────────────────────────────────────────────────

  it('streams de TENANTS diferentes não se absorvem nem se fecham', async () => {
    const a1 = await texto(inA);
    const b1 = await texto(inB, { channel_id: CANAL_B });
    const b2 = await texto(inB, { channel_id: CANAL_B });
    await vencerJanela(chaveDe(T_B, A_B, CANAL_B));

    await worker().runStreamDebounceCloser({ budget_ms: 0 });

    // O de B fechou; o de A, cujo prazo não venceu, ficou intacto.
    expect((await lerTurno(b1.turn_id))['status']).toBe('queued');
    expect(Number((await lerTurno(b1.turn_id))['debounce_batch_size'])).toBe(2);
    expect((await lerTurno(b2.turn_id))['status']).toBe('superseded');
    const turnoA = await lerTurno(a1.turn_id);
    expect(turnoA['status']).toBe('received');
    expect(turnoA['debounce_closed_at']).toBeNull();
    // E nenhum input de A migrou para um turno de B.
    const { rows } = await pool.query(
      `SELECT tenant_id, turn_id FROM agent_turn_inputs WHERE mensagem_id = $1`,
      [a1.mensagem_id],
    );
    expect(rows).toEqual([{ tenant_id: T_A, turn_id: a1.turn_id }]);
  });

  // ─── 12: a MESMA stream_key em tenants diferentes ────────────────────────
  //
  // O caso 11 acima usa as chaves DERIVADAS de cada escopo, que são distintas
  // por construção — e por isso ele nao consegue exercitar o `tenant_id`/
  // `agent_id` do `WHERE` do fechamento: `stream_key` sozinho ja e seletivo.
  // Medido: removendo as duas colunas do `UPDATE` de `closeDueDebounceBatchTx`,
  // a suite inteira continuava 16/16 verde.
  //
  // Chave IGUAL em tenants diferentes e estado REAL (backfill, replay manual), e
  // e o mesmo cenario que a fatia B trata em `turn-stream-exclusion-real-db`
  // ("a MESMA stream_key em TENANTS diferentes nao compete"). Aqui ele existe
  // para que o escopo do fechamento seja carregado por teste, e nao pela
  // improbabilidade de colisao da chave derivada.
  it('a MESMA stream_key em TENANTS diferentes: fechar a de um nao toca a do outro', async () => {
    const compartilhada = `deb628-compartilhada-${randomUUID()}`;
    const a1 = await texto(inA);
    const b1 = await texto(inB, { channel_id: CANAL_B });
    const b2 = await texto(inB, { channel_id: CANAL_B });

    // Backfill: as tres linhas passam a carregar a MESMA chave literal, e cada
    // escopo ganha a SUA linha de mutex — `lockStreamForDebounce` trava em
    // `agent_stream_sequences` por (tenant, agent, stream_key), e sem ela o
    // fechamento sai por `stream_locked` antes de chegar ao `WHERE` que este
    // caso existe para exercitar.
    await pool.query(`UPDATE agent_turns SET stream_key = $1 WHERE id = ANY($2::uuid[])`, [
      compartilhada,
      [a1.turn_id, b1.turn_id, b2.turn_id],
    ]);
    for (const [tn, ag] of [
      [T_A, A_A],
      [T_B, A_B],
    ]) {
      await pool.query(
        `INSERT INTO agent_stream_sequences (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
         VALUES ($1, $2, $3, 1, 100) ON CONFLICT DO NOTHING`,
        [tn, ag, compartilhada],
      );
    }

    // Vence a janela SO do tenant A. Sem o escopo no fechamento, fechar A
    // arrastaria as linhas de B, que nem sequer estao vencidas.
    await pool.query(
      `UPDATE agent_turns SET debounce_deadline_at = now() - interval '1 second'
        WHERE stream_key = $1 AND tenant_id = $2 AND agent_id = $3
          AND debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL`,
      [compartilhada, T_A, A_A],
    );

    await worker().runStreamDebounceCloser({ budget_ms: 0 });

    const turnoA = await lerTurno(a1.turn_id);
    expect(turnoA['status']).toBe('queued');
    expect(turnoA['debounce_closed_at']).not.toBeNull();

    // B nao foi tocado: nem fechado, nem absorvido, nem contado.
    for (const id of [b1.turn_id, b2.turn_id]) {
      const t = await lerTurno(id);
      expect(t['status'], `turno de B (${id}) foi tocado pelo fechamento de A`).toBe('received');
      expect(t['debounce_closed_at']).toBeNull();
      expect(t['debounce_batch_size']).toBeNull();
    }

    // E nenhum input de B migrou para o turno de A.
    const { rows } = await pool.query(
      `SELECT DISTINCT tenant_id FROM agent_turn_inputs WHERE turn_id = $1`,
      [a1.turn_id],
    );
    expect(rows).toEqual([{ tenant_id: T_A }]);
  });
});

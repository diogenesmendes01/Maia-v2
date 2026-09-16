/**
 * P04.6 (spec §8.2.4 linha 2394, §8.2.5 primeiro bullet) — o HOLD de
 * admissão/claim sob controle humano, contra PostgreSQL REAL.
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é um predicado que roda no `WHERE` do claim, no filtro do
 * recovery, no dispatcher cross-tenant e na eleição da promoção. Um harness que
 * montasse o SELECT por conta própria passaria feliz com o predicado REMOVIDO do
 * código de produção — estaria provando o harness. Por isso toda entrada é pela
 * porta real (`claimNextEligibleTurn`, `findRecoverableTurns`,
 * `listTenantAgentPairsWithRecoverableTurns`, `markIgnored`), carregada por
 * `moduloDeProducao`.
 *
 * ─── As DUAS pontas, e por que só uma não provaria nada ───────────────────
 *
 * "A conversa sob controle humano não é reivindicada" passaria num sistema que
 * nunca reivindica nada. Cada caso de recusa tem o seu par em `bot`, com a
 * MESMA fixture, provando que o que mudou foi o controle e não o resto.
 *
 * ─── Os dois eixos do isolamento (C41) ────────────────────────────────────
 *
 * A mesma `stream_key` LITERAL aparece em outro tenant e em outro agente do
 * MESMO tenant. Separar tenant não basta: `agents.id` é global, e uma
 * verificação que só olhasse `tenant_id` deixaria um agente reter a conversa do
 * vizinho. Três vezes nesta épica um mutante sobreviveu por falta desse eixo.
 *
 * Skipped sem `TEST_DB_URL`, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const enqueueAgentMock = vi.fn(async () => {});
vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: (...args: unknown[]) => enqueueAgentMock(...(args as [])),
  agentQueue: {},
  QueueRedisUnavailableError: class QueueRedisUnavailableError extends Error {},
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'hold-p046-tenant-a';
const A_A = 'hold-p046-agent-a';
/** Segundo agente DO MESMO tenant — a colisão que `agents.id` global esconde. */
const A_A2 = 'hold-p046-agent-a2';
/** Segundo tenant — a colisão que a `stream_key` derivada esconde. */
const T_B = 'hold-p046-tenant-b';
const A_B = 'hold-p046-agent-b';

const OPERADOR = 'operador-p046';
const LEASE_MS = 60_000;
const STALE_MS = 1;

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inA2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A2 }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

/** Uma `stream_key` do formato real (v1 + hash), longa o bastante para não colidir. */
const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

async function ensureScopes(): Promise<void> {
  for (const [t, a] of [
    [T_A, A_A],
    [T_A, A_A2],
    [T_B, A_B],
  ] as const) {
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
      t,
    ]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [a, t],
    );
  }
}

/**
 * Um turno numa stream NOMEADA, com sequência ESCOLHIDA.
 *
 * Satisfaz o `agent_turns_stream_shadow_chk` (trio coerente, `first >= 1`,
 * `last >= first`) e semeia `agent_stream_sequences`, cuja PK é
 * `(tenant, agent, stream_key)`.
 */
async function mkTurno(args: {
  tenant: string;
  agent: string;
  stream_key: string | null;
  seq?: number;
  status?: string;
}): Promise<string> {
  const { tenant, agent, stream_key } = args;
  const seq = args.seq ?? 1;
  const status = args.status ?? 'queued';
  if (stream_key !== null) {
    await pool.query(
      `INSERT INTO agent_stream_sequences
         (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (tenant_id, agent_id, stream_key)
         DO UPDATE SET last_ingress_seq = GREATEST(
           agent_stream_sequences.last_ingress_seq, EXCLUDED.last_ingress_seq)`,
      [tenant, agent, stream_key, seq],
    );
  }
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at, processada_em)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now() - interval '1 hour', NULL)`,
    [mensagem_id, tenant, agent],
  );
  const turn_id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns
       (id, tenant_id, agent_id, status, representative_message_id,
        stream_key, stream_key_version, first_ingress_seq, last_ingress_seq,
        created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8, now() - interval '1 hour')`,
    [
      turn_id,
      tenant,
      agent,
      status,
      mensagem_id,
      stream_key,
      stream_key === null ? null : 1,
      stream_key === null ? null : seq,
    ],
  );
  return turn_id;
}

/** Um controle NAQUELE modo para aquela stream. `bot` é a ponta de controle. */
async function mkControle(args: {
  tenant: string;
  agent: string;
  stream_key: string;
  mode: 'bot' | 'pausing' | 'human';
}): Promise<string> {
  const control_id = randomUUID();
  const humano = args.mode !== 'bot';
  await pool.query(
    `INSERT INTO conversation_controls
       (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id,
        mode, control_epoch, owner_app_user_id, paused_at, reason_code)
     VALUES ($1,$2,$3,$4,1,$5,$6,1,$7,$8,$9)`,
    [
      control_id,
      args.tenant,
      args.agent,
      args.stream_key,
      randomUUID(),
      args.mode,
      humano ? OPERADOR : null,
      humano ? new Date() : null,
      humano ? 'operator_takeover' : null,
    ],
  );
  return control_id;
}

async function lerTurno(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

d('P04.6 — hold de admissão/claim sob controle humano (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  const streamMetrics = moduloDeProducao(() => import('@/runtime/turns/stream-metrics.js'));

  const claim = (turn_id: string, escopo = inA) =>
    escopo(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id,
        worker_id: `w-${randomUUID().slice(0, 8)}`,
        lease_ms: LEASE_MS,
      }),
    );

  /**
   * Um contador do Prometheus, como número ABSOLUTO. `-1` significa SÉRIE
   * AUSENTE, e o sentinela é deliberado: para uma série que deveria existir,
   * "ausente" e "zero" são falhas diferentes e confundi-las esconderia uma
   * métrica que deixou de ser publicada.
   */
  async function contador(nome: string, labels: string): Promise<number> {
    const body = await metricas().renderPrometheus();
    const m = new RegExp(`^${nome}\\{${labels}\\} (\\d+)`, 'm').exec(body);
    return m ? Number(m[1]) : -1;
  }

  /**
   * Quantas vezes a série foi INCREMENTADA, tratando ausência como zero.
   *
   * Existe porque as duas métricas desta fatia têm ciclos de vida diferentes, e
   * eu tinha misturado os dois: `maia_stream_blocked_total` é PRÉ-SEMEADA em
   * zero no boot (`registrarSeriesDeStream` itera `STREAM_BLOCKED_REASONS`),
   * então uma série dela sempre existe; `maia_turn_claim_total` nasce no
   * primeiro `incCounter`, então um resultado que nunca ocorreu simplesmente
   * não aparece no `/metrics`.
   *
   * Para afirmar "esta recusa NÃO foi contada como aquilo", ausência é prova
   * mais forte do que zero — não houve sequer a primeira ocorrência. Usar
   * `contador()` aqui comparava o sentinela `-1` com `0` e reprovava por um
   * defeito do teste, não do código.
   */
  async function vezesContado(nome: string, labels: string): Promise<number> {
    const n = await contador(nome, labels);
    return n === -1 ? 0 : n;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureScopes();
  }, 30_000);

  afterAll(async () => {
    for (const t of [T_A, T_B]) {
      await pool?.query(`DELETE FROM conversation_controls WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_A2, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    for (const t of [T_A, T_B]) {
      await pool.query(`DELETE FROM conversation_controls WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    enqueueAgentMock.mockClear();
    // Métrica ZERADA e RE-SEMEADA: as asserções são ABSOLUTAS, não deltas. Um
    // delta sobre estado global mutável fica verde na SEGUNDA tentativa do
    // `retry: 1` do vitest, herdando a mutação da primeira como linha de base.
    metricas()._resetForTests();
    streamMetrics()._resetSeedForTests();
    streamMetrics().registrarSeriesDeStream();
  });

  // ─── O CLAIM ────────────────────────────────────────────────────────────

  it('1. conversa em `human`: o claim é RECUSADO com `conversation_human_control`', async () => {
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    const r = await claim(turno);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('conversation_human_control');
    // E o turno NÃO foi tocado: sem attempt gasto, sem token, sem lease. O
    // §8.2.4 é literal — "não gastar attempts nem fazer retry storm".
    const linha = await lerTurno(turno);
    expect(linha['status']).toBe('queued');
    expect(linha['attempt_count']).toBe(0);
    expect(linha['claim_token']).toBeNull();
  });

  it('2. conversa em `pausing`: TAMBÉM recusado — a janela do meio é a perigosa', async () => {
    // `pausing` é estado REAL: a barreira foi comitada e a drenagem não
    // terminou. Se o claim só olhasse `human`, o bot poderia INICIAR um turno
    // depois do clique de pausa — exatamente o efeito pela metade que a
    // separação `pause`/`reconcile` existe para tornar visível.
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'pausing' });

    const r = await claim(turno);
    expect(r.ok === false && r.reason).toBe('conversation_human_control');
  });

  it('3. A OUTRA PONTA — conversa em `bot`: o claim é CONCEDIDO', async () => {
    // Sem este caso, tudo acima passaria num sistema que recusa sempre.
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'bot' });

    const r = await claim(turno);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.claim.turn_id).toBe(turno);
  });

  it('4. SEM controle nenhum: concedido — o hold nasce de uma linha, não da ausência dela', async () => {
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    const r = await claim(turno);
    expect(r.ok).toBe(true);
  });

  it('5. turno SEM `stream_key`: concedido — o escape documentado', async () => {
    // 10.833 dos 10.957 turnos deste banco não têm stream. Recusá-los tornaria
    // inclaimável todo turno anterior ao protocolo: uma parada total do
    // ingresso provocada pela própria proteção.
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: null });
    const r = await claim(turno);
    expect(r.ok).toBe(true);
  });

  it('6. controle de OUTRA stream do mesmo escopo não retém esta conversa', async () => {
    const minha = streamKey();
    const alheia = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: minha });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: alheia, mode: 'human' });

    const r = await claim(turno);
    expect(r.ok).toBe(true);
  });

  it('7. a recusa é CONTADA na métrica de claim e na de bloqueio de stream', async () => {
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    await claim(turno);
    expect(
      await contador('maia_turn_claim_total', 'result="conversation_human_control"'),
    ).toBe(1);
    expect(
      await contador('maia_stream_blocked_total', 'reason="conversation_human_control"'),
    ).toBe(1);
    // E NÃO foi contada como outra coisa: `not_eligible` genérico é justamente
    // o que o §8.2.4 proíbe ("retornar motivo fechado"), e `stream_poisoned`
    // mandaria o operador desbloquear uma conversa que ninguém interditou.
    // `vezesContado` porque `maia_turn_claim_total` não é pré-semeada: um
    // resultado que nunca ocorreu está AUSENTE do `/metrics`, não em zero.
    expect(await vezesContado('maia_turn_claim_total', 'result="not_eligible"')).toBe(0);
    expect(await vezesContado('maia_turn_claim_total', 'result="stream_poisoned"')).toBe(0);
    // A série de bloqueio, essa, É pré-semeada — então aqui "zero" é uma
    // afirmação sobre a série existir e não ter sido tocada, e o `contador`
    // estrito é o certo: se ela sumisse do `/metrics`, este caso reprovaria.
    expect(await contador('maia_stream_blocked_total', 'reason="stream_poisoned"')).toBe(0);
  });

  // ─── ISOLAMENTO — os dois eixos ─────────────────────────────────────────

  it('8. a MESMA `stream_key` em outro TENANT não é alcançada pelo hold', async () => {
    const key = streamKey();
    const meu = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    const dele = await mkTurno({ tenant: T_B, agent: A_B, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    expect((await claim(meu)).ok).toBe(false);
    // O vizinho segue trabalhando. Sem o `tenant_id` no predicado, a pausa de A
    // pararia a conversa de B — e nada na linha de B apontaria para A.
    expect((await claim(dele, inB)).ok).toBe(true);
  });

  it('9. a MESMA `stream_key` em outro AGENTE do mesmo tenant também não', async () => {
    // `agents.id` é global: separar só por tenant deixaria este eixo aberto.
    const key = streamKey();
    const meu = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    const vizinho = await mkTurno({ tenant: T_A, agent: A_A2, stream_key: key });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    expect((await claim(meu)).ok).toBe(false);
    expect((await claim(vizinho, inA2)).ok).toBe(true);
  });

  // ─── O RECOVERY ─────────────────────────────────────────────────────────

  it('10. o varredor NÃO enumera turno retido — e enumera o mesmo quando o modo é `bot`', async () => {
    // As duas metades no mesmo caso de propósito: a fixture é idêntica e o
    // ÚNICO que muda é o modo. Sem o predicado aqui, o varredor rearma a cada
    // ciclo um turno que o claim vai recusar — trabalho infinito com aparência
    // de recuperação, e o `limit` da varredura consumido por conversas que
    // nenhum worker pode destravar.
    const key = streamKey();
    const turno = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key });
    const control_id = await mkControle({
      tenant: T_A,
      agent: A_A,
      stream_key: key,
      mode: 'human',
    });

    const retido = await inA(() => repos().agentTurnsRepo.findRecoverableTurns(STALE_MS));
    expect(retido.map((r) => r.turn.id)).not.toContain(turno);

    await pool.query(
      `UPDATE conversation_controls SET mode = 'bot', owner_app_user_id = NULL WHERE id = $1`,
      [control_id],
    );
    const livre = await inA(() => repos().agentTurnsRepo.findRecoverableTurns(STALE_MS));
    expect(livre.map((r) => r.turn.id)).toContain(turno);
  });

  it('11. o dispatcher CROSS-TENANT não enumera o par cujo único trabalho está retido', async () => {
    const key = streamKey();
    await mkTurno({ tenant: T_B, agent: A_B, stream_key: key });
    await mkControle({ tenant: T_B, agent: A_B, stream_key: key, mode: 'human' });

    const pares = await repos().agentTurnsRepo.listTenantAgentPairsWithRecoverableTurns(STALE_MS);
    expect(pares).not.toContainEqual({ tenant_id: T_B, agent_id: A_B });
  });

  // ─── A PROMOÇÃO ─────────────────────────────────────────────────────────

  it('12. concluir o head NÃO promove o sucessor numa conversa retida', async () => {
    // O consumidor menos óbvio do predicado. Sem ele, a conclusão promove, bate
    // na BullMQ, o job acorda e o claim recusa: um `promoted` que não
    // corresponde a fila nenhuma, mais o retry storm que o §8.2.4 proíbe.
    const key = streamKey();
    const head = await mkTurno({
      tenant: T_A,
      agent: A_A,
      stream_key: key,
      seq: 1,
      status: 'received',
    });
    const sucessor = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    const r = await inA(() =>
      repos().agentTurnsRepo.markIgnored({ turn_id: head, outcome: 'operator_cancelled' }),
    );
    expect(r.ok).toBe(true);

    const depois = await lerTurno(sucessor);
    expect(depois['promoted_at']).toBeNull();
    expect(enqueueAgentMock).not.toHaveBeenCalled();
  });

  it('13. a MESMA conclusão promove quando a conversa é do bot', async () => {
    // A outra ponta do caso 12: sem ela, "não promoveu" passaria num sistema
    // que nunca promove.
    const key = streamKey();
    const head = await mkTurno({
      tenant: T_A,
      agent: A_A,
      stream_key: key,
      seq: 1,
      status: 'received',
    });
    const sucessor = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'bot' });

    await inA(() =>
      repos().agentTurnsRepo.markIgnored({ turn_id: head, outcome: 'operator_cancelled' }),
    );

    const depois = await lerTurno(sucessor);
    expect(depois['promoted_at']).not.toBeNull();
  });

  // ─── A RECUSA NÃO PODE ENGOLIR AS OUTRAS ────────────────────────────────
  //
  // Os três casos abaixo nasceram de SOBREVIVENTES da varredura de mutação, e
  // o primeiro mudou a minha conclusão: eu ia registrar a mutação que remove o
  // filtro de modo da SONDA como redundante, porque a sonda só roda depois de o
  // claim já ter falhado. Está errado — ela é alcançável com a conversa em
  // `bot`, e o efeito é justamente o colapso de diagnóstico que o comentário do
  // vocabulário promete não existir.

  it('14. conversa em `bot` COM FILA: a recusa é `not_head`, não o hold', async () => {
    // Sem o filtro de modo na sonda, este caso devolveria
    // `conversation_human_control` para uma conversa que NINGUÉM assumiu — e a
    // remediação que o operador leria ("espere o humano terminar") seria falsa:
    // o que há é fila, e ela anda sozinha.
    const key = streamKey();
    const head = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const atras = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'bot' });
    void head;

    const r = await claim(atras);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('not_head');
  });

  it('15. conversa em `human` COM FILA: o hold PRECEDE o `not_head`', async () => {
    // A outra metade da mesma fronteira, e ela fixa a ordem que escolhi em
    // `explainClaimRejection`: o controle é verificado ANTES da fila. As duas
    // são verdade ao mesmo tempo, e a que descreve o estado que o operador vê
    // no console é o controle — dizer `not_head` mandaria esperar por uma fila
    // que não vai andar enquanto um humano estiver no comando.
    const key = streamKey();
    const head = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 1 });
    const atras = await mkTurno({ tenant: T_A, agent: A_A, stream_key: key, seq: 2 });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });
    void head;

    const r = await claim(atras);
    expect(r.ok === false && r.reason).toBe('conversation_human_control');
  });

  it('16. turno SEM stream, recusado por outro motivo, não é atribuído a um controle alheio', async () => {
    // `outbound_pending` não é reivindicável nem terminal, então o claim é
    // recusado com `not_eligible` e a SONDA roda — que é a única forma de
    // exercitar a guarda `alvo.stream_key IS NOT NULL` dela. Existe um controle
    // humano NO MESMO escopo, em outra stream: sem a guarda e sem a igualdade
    // do JOIN, ele seria atribuído a este turno, e um turno que não pertence a
    // conversa nenhuma apareceria como "retido por atendimento humano".
    const turno = await mkTurno({
      tenant: T_A,
      agent: A_A,
      stream_key: null,
      status: 'outbound_pending',
    });
    await mkControle({
      tenant: T_A,
      agent: A_A,
      stream_key: streamKey(),
      mode: 'human',
    });

    const r = await claim(turno);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('not_eligible');
  });

  // ─── O QUINTO E SEXTO CONSUMIDORES: o fechador de DEBOUNCE ──────────────
  //
  // Achado por revisão adversarial do desenho da fatia seguinte, e confirmado
  // por leitura minha do código: `closeDueDebounceBatchTx` põe `status='queued'`
  // no head, carimba `promoted_at = now()`, zera `next_attempt_at` e empurra
  // `last_ingress_seq` com `GREATEST(...)` — tudo sem consultar o controle. O
  // worker que o dirige é um relógio cross-tenant, e `listDueDebounceStreams`
  // também não consulta.
  //
  // O hold do claim impedia a EXECUÇÃO, então a conversa não era respondida.
  // Mas a linha era MUTADA, e o deslocamento de `last_ingress_seq` furava o
  // filtro do descarte de backlog (`<= watermark`): um head que absorvesse
  // mensagem depois do watermark escapava do cancelamento e voltava a ser
  // reivindicável no instante em que o modo virasse `bot` — quebrando
  // `future_only` justamente no caminho que o §8.2.5 existe para fechar.

  /** Turno com JANELA DE DEBOUNCE vencida — o que o fechador vem buscar. */
  async function mkTurnoComJanelaVencida(key: string): Promise<string> {
    const turno = await mkTurno({
      tenant: T_A,
      agent: A_A,
      stream_key: key,
      seq: 1,
      status: 'received',
    });
    await pool.query(
      `UPDATE agent_turns
          SET debounce_window_opened_at = now() - interval '2 minutes',
              debounce_deadline_at      = now() - interval '1 minute',
              debounce_closed_at        = NULL
        WHERE id = $1`,
      [turno],
    );
    return turno;
  }

  it('17. o fechador de debounce NÃO fecha janela de conversa retida', async () => {
    const key = streamKey();
    const turno = await mkTurnoComJanelaVencida(key);
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'human' });

    const r = await inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: key }));
    expect(r.closed).toBe(false);
    // Motivo PRÓPRIO, e não `lost_race`: o CAS falhar por causa do predicado
    // contaria a história errada — mandaria o operador procurar corrida onde há
    // decisão humana. Mesma régua que separou `stream_poisoned` de
    // `stream_blocked`.
    expect(r.closed === false && r.reason).toBe('conversation_human_control');

    // E a LINHA não foi tocada: é isto que fura o descarte, não o fechamento.
    const depois = await lerTurno(turno);
    expect(depois['status']).toBe('received');
    expect(depois['debounce_closed_at']).toBeNull();
    expect(depois['promoted_at']).toBeNull();
    expect(Number(depois['last_ingress_seq'])).toBe(1);
  });

  it('18. a MESMA janela fecha quando a conversa é do bot', async () => {
    // Sem esta ponta, o caso 17 passaria num sistema que nunca fecha janela.
    const key = streamKey();
    const turno = await mkTurnoComJanelaVencida(key);
    await mkControle({ tenant: T_A, agent: A_A, stream_key: key, mode: 'bot' });

    const r = await inA(() => repos().agentTurnsRepo.closeDueDebounceBatch({ stream_key: key }));
    expect(r.closed).toBe(true);
    const depois = await lerTurno(turno);
    expect(depois['status']).toBe('queued');
    expect(depois['debounce_closed_at']).not.toBeNull();
  });

  it('19. o varredor cross-tenant não ENUMERA a stream retida', async () => {
    // A enumeração é advisória — o CAS é a barreira —, mas sem ela o worker
    // gasta o `limit` da rodada em conversas que não pode fechar, e uma stream
    // retida de longa duração empurraria streams legítimas para fora do lote
    // (a starvation que a própria ordenação por prazo existe para evitar).
    const retida = streamKey();
    const livre = streamKey();
    await mkTurnoComJanelaVencida(retida);
    await mkTurnoComJanelaVencida(livre);
    await mkControle({ tenant: T_A, agent: A_A, stream_key: retida, mode: 'human' });
    await mkControle({ tenant: T_A, agent: A_A, stream_key: livre, mode: 'bot' });

    const streams = await repos().agentTurnsRepo.listDueDebounceStreams(200);
    const chaves = streams.map((s) => s.stream_key);
    expect(chaves).not.toContain(retida);
    expect(chaves).toContain(livre);
  });
});

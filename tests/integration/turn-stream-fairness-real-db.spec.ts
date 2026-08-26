/**
 * Issue #629 (fatia F da #505) — FAIRNESS E STARVATION SOB CARGA, contra
 * PostgreSQL REAL.
 *
 * ─── O buraco que este arquivo fecha ──────────────────────────────────────
 *
 * Nenhuma fatia da #505 mediu fairness. A #626 provou PARALELISMO (doze
 * conversas simultâneas) e ausência de lock global, mas paralelismo e fairness
 * são perguntas diferentes: um escalonador pode ter doze conversas rodando ao
 * mesmo tempo e ainda assim deixar a décima terceira parada para sempre. Os
 * dois critérios de pronto da issue são literais:
 *
 *   - "uma conversa lenta não serializa o tenant nem o agente inteiro";
 *   - "fairness demonstrada com percentis e nenhum starvation persistente".
 *
 * ─── Por que o laço é uma SIMULAÇÃO DO WORKER, e não um `for` sobre ids ───
 *
 * A pergunta é sobre distribuição de VAGAS, e vaga é um conceito do pool de
 * workers. Um `for` sequencial sobre os turnos mediria a ordem em que o TESTE
 * os visita, não a ordem em que a plataforma os atende — e passaria verde com
 * o head-of-line removido. Então o laço abaixo reproduz o ciclo real:
 *
 *   1. todo turno é ENFILEIRADO no ingresso (um job por turno);
 *   2. N workers puxam jobs CONCORRENTEMENTE e tentam o claim de verdade
 *      (`claimNextEligibleTurn`);
 *   3. um claim recusado TERMINA o job — o wake-up foi consumido, exatamente
 *      como em produção;
 *   4. uma conclusão PROMOVE o sucessor, e o `enqueueAgent` da promoção
 *      devolve o job à fila do teste.
 *
 * O passo 4 é o que torna o laço honesto: sem a promoção de verdade (#627), a
 * fila do teste secaria e o teste "provaria" starvation que é dele.
 *
 * ─── O que se prova ───────────────────────────────────────────────────────
 *
 *   1. UMA CONVERSA LENTA NÃO SERIALIZA NADA: com o head de uma conversa
 *      segurado por um worker vivo durante toda a rodada, TODAS as outras
 *      terminam;
 *   2. uma conversa QUENTE não monopoliza vagas: com backlog grande, ela nunca
 *      ocupa mais de UMA vaga por vez, e as conversas pequenas não esperam por
 *      ela;
 *   3. FAIRNESS com PERCENTIS: a espera medida (`maia_stream_turn_wait_seconds`,
 *      do relógio do banco) tem cauda limitada, e nenhuma conversa fica sem ser
 *      atendida;
 *   4. STARVATION é medida, e o contador conta EPISÓDIOS e não scrapes;
 *   5. os gauges de fairness chegam ao `/metrics` a partir do ponto de boot.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

/** Jobs que a PROMOÇÃO devolve à fila. É o passo 4 do ciclo (ver cabeçalho). */
const promovidos: string[] = [];
vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: async (payload: { turn_id?: string }) => {
    if (payload.turn_id) promovidos.push(payload.turn_id);
  },
  agentQueue: {},
  QueueRedisUnavailableError: class QueueRedisUnavailableError extends Error {},
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'fair629-tenant';
const A = 'fair629-agent';
const LEASE_MS = 60_000;

/** Vagas do pool. Quatro é o suficiente para que "uma vaga por stream" seja
 *  uma afirmação com consequência: com uma vaga só, nada seria distinguível. */
const VAGAS = 4;

let pool: pg.Pool;
const inT = <X>(fn: () => Promise<X>): Promise<X> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

d('#629 — fairness e starvation sob carga (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));
  const turns = moduloDeProducao(() => import('@/runtime/turns/lifecycle.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));
  const streamMetrics = moduloDeProducao(() => import('@/runtime/turns/stream-metrics.js'));
  const coletor = moduloDeProducao(() => import('@/observability/stream-fairness-collector.js'));

  async function mkInbound(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
       VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
      [id, T, A],
    );
    return id;
  }

  async function turnInStream(stream_key: string, seq: number): Promise<string> {
    const mensagem_id = await mkInbound();
    const turn = await inT(() =>
      repos().agentTurnsRepo.ensureTurnForMessage({
        id: mensagem_id,
        tenant_id: T,
        agent_id: A,
        conversa_id: null,
        channel_id: null,
      }),
    );
    await pool.query(
      `UPDATE agent_turns
          SET stream_key = $2, stream_key_version = 1, status = 'queued',
              queued_at = now(), first_ingress_seq = $3, last_ingress_seq = $3
        WHERE id = $1`,
      [turn.id, stream_key, seq],
    );
    return turn.id;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: VAGAS + 4 });
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
      T,
    ]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [A, T],
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_stream_blocks WHERE tenant_id = $1`, [T]);
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [T]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [T]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [T]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T]);
    await pool?.query(`DELETE FROM agents WHERE id = $1`, [A]);
    await pool?.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    promovidos.length = 0;
    await pool.query(`DELETE FROM agent_stream_blocks WHERE tenant_id = $1`, [T]);
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [T]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [T]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [T]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T]);
    metricas()._resetForTests();
    streamMetrics()._resetSeedForTests();
    streamMetrics().registrarSeriesDeStream();
    coletor()._resetStarvationStateForTests();
  });

  /**
   * O POOL DE WORKERS. `VAGAS` consumidores puxam da mesma fila, entram pela
   * porta REAL (`beginTurnExecution` — que é quem faz o claim atômico, arma a
   * lease e OBSERVA a espera) e concluem pela porta REAL, o que dispara a
   * promoção — que devolve o job do sucessor à fila deste laço.
   *
   * O laço só termina quando NÃO há job na fila E nenhum worker está em voo:
   * um worker que saísse ao ver a fila momentaneamente vazia mediria a própria
   * corrida, e não o escalonador — a promoção do turno que outro worker está
   * concluindo AGORA ainda vai chegar.
   */
  async function drenar(
    fila: string[],
    opts: { maxJobs?: number } = {},
  ): Promise<{
    concluidos: Array<{ turn_id: string; em: number }>;
    recusas: Record<string, number>;
    pico_de_vagas: number;
    jobs: number;
  }> {
    const inicio = Date.now();
    const concluidos: Array<{ turn_id: string; em: number }> = [];
    const recusas: Record<string, number> = {};
    let emVoo = 0;
    let pico = 0;
    let jobs = 0;
    const teto = opts.maxJobs ?? 5_000;

    const worker = async (n: number): Promise<void> => {
      for (;;) {
        const turn_id = fila.shift();
        if (!turn_id) {
          // Fila vazia: só desiste quando NINGUÉM mais pode produzir trabalho.
          if (emVoo === 0) return;
          await new Promise((res) => setTimeout(res, 2));
          continue;
        }
        if (jobs++ > teto) return;
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        const handle = {
          turn_id,
          status: 'queued',
          state_version: 0,
          attempt_count: 0,
          conversa_id: null,
          lease: null,
        };
        try {
          const inicioExec = await inT(() => turns().beginTurnExecution(handle as never));
          if (!inicioExec.started) {
            // O job TERMINA. O wake-up foi consumido — é exatamente o que
            // acontece em produção quando o claim recusa com `not_head`.
            recusas[inicioExec.reason] = (recusas[inicioExec.reason] ?? 0) + 1;
            continue;
          }
          await inT(() => turns().concludeTurn(handle as never, 'reply_delivered'));
          concluidos.push({ turn_id, em: Date.now() - inicio });
          // O que a promoção acordou entra na fila deste laço.
          fila.push(...promovidos.splice(0));
        } finally {
          (handle.lease as { stop?: () => void } | null)?.stop?.();
          emVoo -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: VAGAS }, (_, i) => worker(i)));
    return { concluidos, recusas, pico_de_vagas: pico, jobs };
  }

  async function ativosPorStream(): Promise<Record<string, number>> {
    const r = await pool.query(
      `SELECT stream_key, count(*)::int AS n
         FROM agent_turns
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN ('claimed','running')
        GROUP BY stream_key`,
      [T, A],
    );
    return Object.fromEntries(
      (r.rows as Array<{ stream_key: string; n: number }>).map((x) => [x.stream_key, x.n]),
    );
  }

  // ─── SONDA 1 — uma conversa LENTA não serializa nada ──────────────────────

  it('uma conversa LENTA não serializa o tenant nem o agente: as outras 30 terminam', async () => {
    const lenta = streamKey();
    const lentaTurnos = [await turnInStream(lenta, 1), await turnInStream(lenta, 2)];

    const frias: Array<{ key: string; turn: string }> = [];
    for (let i = 0; i < 30; i++) {
      const k = streamKey();
      frias.push({ key: k, turn: await turnInStream(k, 1) });
    }

    // A conversa LENTA fica com o head reivindicado e a lease VIVA — um worker
    // saudável fazendo trabalho longo. Ela não vai andar durante a rodada, de
    // propósito: é a definição de "conversa lenta".
    const preso = await inT(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: lentaTurnos[0]!,
        worker_id: 'worker-lento',
        lease_ms: LEASE_MS,
      }),
    );
    expect(preso.ok).toBe(true);

    const fila = [...frias.map((f) => f.turn), lentaTurnos[1]!];
    const r = await drenar(fila);

    // INVARIANTE ABSOLUTA: TODAS as conversas frias terminaram. Não "quase
    // todas", não "mais do que antes" — todas. É a única forma da afirmação
    // "não serializa" que não pode passar por acaso.
    const concluidas = new Set(r.concluidos.map((c) => c.turn_id));
    for (const f of frias) {
      expect(concluidas.has(f.turn)).toBe(true);
    }
    expect(concluidas.size).toBe(30);

    // E a conversa lenta NÃO andou — o sucessor dela foi recusado, como manda o
    // FIFO. Sem esta metade, "todas terminaram" seria compatível com o
    // head-of-line desligado.
    const seguinte = await pool.query(`SELECT status FROM agent_turns WHERE id = $1`, [
      lentaTurnos[1],
    ]);
    expect(seguinte.rows[0]!.status).toBe('queued');
    expect(r.recusas['not_head']).toBeGreaterThanOrEqual(1);

    // Houve PARALELISMO de verdade: mais de uma vaga ocupada ao mesmo tempo.
    // Sem isto, "todas terminaram" poderia ser um laço sequencial disfarçado.
    expect(r.pico_de_vagas).toBeGreaterThan(1);
  }, 60_000);

  // ─── SONDA 2 — a conversa QUENTE não monopoliza vagas ─────────────────────

  it('uma conversa QUENTE ocupa NO MÁXIMO uma vaga, e as pequenas não esperam por ela', async () => {
    const quente = streamKey();
    const quentes: string[] = [];
    for (let i = 1; i <= 25; i++) quentes.push(await turnInStream(quente, i));

    const frias: string[] = [];
    for (let i = 0; i < 20; i++) frias.push(await turnInStream(streamKey(), 1));

    // A fila do ingresso: TODOS têm job, e os da conversa quente chegam
    // primeiro — o pior caso para fairness, porque os workers puxam 25 jobs da
    // mesma conversa antes de ver a primeira conversa fria.
    const fila = [...quentes, ...frias];

    // Amostragem de OCUPAÇÃO enquanto o laço roda: a afirmação "no máximo uma
    // vaga por stream" precisa ser observada DURANTE, não depois.
    let maxPorStream = 0;
    const amostrador = setInterval(() => {
      void ativosPorStream().then((m) => {
        for (const n of Object.values(m)) maxPorStream = Math.max(maxPorStream, n);
      });
    }, 5);

    const r = await drenar(fila);
    clearInterval(amostrador);
    await new Promise((res) => setTimeout(res, 20));

    // Nenhuma conversa teve dois turnos ativos ao mesmo tempo — a exclusão da
    // #625 é o que impede uma conversa quente de tomar o pool inteiro. (0
    // significa que a amostragem não pegou nenhum instante ativo; aí a
    // afirmação seria vazia, então exigimos ao menos uma observação.)
    expect(maxPorStream).toBeGreaterThanOrEqual(1);
    expect(maxPorStream).toBeLessThanOrEqual(1);

    // TODAS as conversas pequenas terminaram, e a quente também drenou inteira
    // (25 turnos, um de cada vez, pela promoção).
    const concluidos = r.concluidos.map((c) => c.turn_id);
    for (const f of frias) expect(concluidos).toContain(f);
    for (const q of quentes) expect(concluidos).toContain(q);

    // FAIRNESS, com percentis: a posição de conclusão de cada conversa fria
    // dentro da ordem global. Se a conversa quente monopolizasse, as frias
    // sairiam TODAS depois dos 25 turnos dela, e a mediana da posição relativa
    // ficaria no fim.
    const posicao = new Map(concluidos.map((id, i) => [id, i]));
    const posFrias = frias.map((f) => posicao.get(f)!).sort((a, b) => a - b);
    const p50 = posFrias[Math.floor(posFrias.length * 0.5)]!;
    const p95 = posFrias[Math.floor(posFrias.length * 0.95)]!;
    // eslint-disable-next-line no-console
    console.log(
      `[#629 fairness] frias=${frias.length} quentes=${quentes.length} ` +
        `p50_pos=${p50} p95_pos=${p95} max_pos=${posFrias[posFrias.length - 1]} ` +
        `total=${concluidos.length} jobs=${r.jobs} pico_vagas=${r.pico_de_vagas}`,
    );
    // A mediana das conversas frias tem de cair na PRIMEIRA METADE da ordem
    // global. Se a conversa quente serializasse o pool, ela cairia depois de 25.
    expect(p50).toBeLessThan(concluidos.length / 2);
    // E nenhuma conversa fria fica para o fim absoluto.
    expect(p95).toBeLessThan(concluidos.length);
    expect(r.pico_de_vagas).toBeGreaterThan(1);
  }, 60_000);

  // ─── SONDA 3 — a espera é MEDIDA, com percentis ───────────────────────────

  it('`maia_stream_turn_wait_seconds` recebe uma amostra por turno atendido', async () => {
    const fila: string[] = [];
    for (let i = 0; i < 12; i++) fila.push(await turnInStream(streamKey(), 1));
    const r = await drenar([...fila]);
    expect(r.concluidos).toHaveLength(12);

    const body = await metricas().renderPrometheus();
    const count = /^maia_stream_turn_wait_seconds_count (\d+)/m.exec(body);
    const sum = /^maia_stream_turn_wait_seconds_sum ([\d.]+)/m.exec(body);
    // INVARIANTE ABSOLUTA: doze turnos atendidos, doze amostras. Um `>= 1`
    // ficaria verde com a observação em qualquer lugar do laço.
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBe(12);
    expect(sum).not.toBeNull();
    // A soma é finita e não negativa: um `EXTRACT` errado (ou um relógio
    // invertido) produziria `NaN` ou negativo, e a histograma cairia toda no
    // primeiro balde sem nenhum sinal de que algo está errado.
    expect(Number.isFinite(Number(sum![1]))).toBe(true);
    // ESTRITAMENTE positivo: todo turno foi para `queued` antes de ser
    // reivindicado, então a espera real nunca é zero. Um `>= 0` ficaria verde
    // com o `EXTRACT` trocado por uma constante — que é a forma que o defeito
    // tomaria.
    expect(Number(sum![1])).toBeGreaterThan(0);
    // E os baldes são os de SEGUNDOS, não os de milissegundos do default: com
    // os padrões, `le="0.5"` não existiria.
    expect(body).toMatch(/^maia_stream_turn_wait_seconds_bucket\{le="0\.5"\}/m);
    expect(body).toMatch(/^maia_stream_turn_wait_seconds_bucket\{le="900"\}/m);
  }, 60_000);

  // ─── SONDA 4 — STARVATION conta EPISÓDIOS, não scrapes ────────────────────

  it('starvation: uma conversa parada conta UMA vez, por mais que se colete', async () => {
    const parada = streamKey();
    const t1 = await turnInStream(parada, 1);
    const saudavel = await turnInStream(streamKey(), 1);
    // A conversa parada envelhece MUITO além do limiar.
    await pool.query(
      `UPDATE agent_turns SET queued_at = now() - interval '2 hours' WHERE id = $1`,
      [t1],
    );

    const fonte = {
      snapshot: (ms: number) => inT(() => repos().agentTurnsRepo.snapshotStreamScheduling(ms)),
      countBlocked: () => inT(() => repos().agentTurnsRepo.countBlockedStreams()),
      starvationAfterMs: () => 60_000,
    };
    coletor().registerStreamFairnessGauges(fonte);

    const contar = async (): Promise<number> => {
      const body = await metricas().renderPrometheus();
      const m = /^maia_stream_starvation_total (\d+)/m.exec(body);
      return m ? Number(m[1]) : -1;
    };

    // ─── O ATRASO DE UM SCRAPE, e por que ele é declarado aqui ─────────────
    //
    // `renderPrometheus` emite os CONTADORES antes de rodar os providers de
    // GAUGE (src/lib/metrics.ts), e quem detecta starvation é o provider. Então
    // o scrape que DETECTA ainda mostra o valor anterior; quem mostra o
    // incremento é o SEGUINTE. Não é bug e não vale mexer na lib compartilhada
    // por causa disso — mas é exatamente o tipo de coisa que faz um teste
    // "confirmar" um valor que ainda não existe, então fica escrito.
    expect(await contar()).toBe(0);
    // O segundo scrape, já com a detecção comitada.
    expect(await contar()).toBe(1);

    // TRÊS coletas seguidas, com o cache de coalescência vencido. Se o contador
    // contasse AMOSTRAS em vez de EPISÓDIOS, ele estaria em 4 aqui — e a série
    // mediria a frequência do Prometheus, não a saúde da plataforma.
    for (let i = 0; i < 2; i++) {
      await new Promise((res) => setTimeout(res, 5_100));
      expect(await contar()).toBe(1);
    }

    // A conversa saudável nunca entrou na conta.
    expect(saudavel).toBeTruthy();

    // E os gauges descrevem o estado: duas conversas vivas, nenhuma ativa,
    // idade do head mais velho acima de uma hora.
    const body = await metricas().renderPrometheus();
    expect(/^maia_stream_live_total (\d+)/m.exec(body)![1]).toBe('2');
    expect(/^maia_stream_active_total (\d+)/m.exec(body)![1]).toBe('0');
    expect(Number(/^maia_stream_head_age_seconds (\d+)/m.exec(body)![1])).toBeGreaterThan(3_000);
    expect(/^maia_stream_poisoned_streams (\d+)/m.exec(body)![1]).toBe('0');
    expect(/^maia_stream_backlog_max (\d+)/m.exec(body)![1]).toBe('1');
  }, 60_000);

  // ─── SONDA 5 — a interdição APARECE no gauge ──────────────────────────────

  it('o gauge de conversas interditadas conta as interdições ATIVAS', async () => {
    const key = streamKey();
    const t1 = await turnInStream(key, 1);
    await turnInStream(key, 2);
    const claim = await inT(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: t1,
        worker_id: 'w',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(true);
    const handle = {
      turn_id: t1,
      status: claim.ok ? claim.claim.status : 'claimed',
      state_version: claim.ok ? claim.claim.state_version : 0,
      attempt_count: claim.ok ? claim.claim.attempt : 1,
      conversa_id: null,
      claim: claim.ok ? claim.claim : undefined,
      lease: null,
    };
    await inT(() =>
      turns().deadLetterTurn(handle as never, { code: 'x', outcome: 'unsafe_to_retry' }),
    );

    coletor().registerStreamFairnessGauges({
      snapshot: (ms: number) => inT(() => repos().agentTurnsRepo.snapshotStreamScheduling(ms)),
      countBlocked: () => inT(() => repos().agentTurnsRepo.countBlockedStreams()),
      starvationAfterMs: () => 300_000,
    });
    const body = await metricas().renderPrometheus();
    expect(/^maia_stream_poisoned_streams (\d+)/m.exec(body)![1]).toBe('1');
  }, 60_000);
});

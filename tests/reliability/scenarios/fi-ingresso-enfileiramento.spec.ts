/**
 * Issue #510 (fatia E) — FI-01, FI-02 e FI-03: a FRONTEIRA DE ENTRADA do turno,
 * contra Postgres e Redis REAIS, com réplicas que são PROCESSOS e uma morte que
 * é um sinal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que estes três cenários provam, e por que nenhum deles é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A armadilha de um harness de fault injection é injetar a falha, nada quebrar,
 * e o teste passar afirmando nada. O antídoto, cenário a cenário, é o mesmo par
 * das fatias B e C: **a reação do sistema é observada positivamente**, e
 * **existe um caso de controle em que ela não deveria acontecer**.
 *
 *   FI-01 — falha: o MESMO evento do provedor é publicado em DUAS réplicas de
 *           processo ao mesmo tempo, soltas por barreira (a reentrega que o
 *           WhatsApp faz depois de um ACK perdido).
 *           reação provada: `createInbound` persiste UM ingresso e cria UM
 *           turno lógico; a réplica perdedora recebe a MESMA `mensagem_id`
 *           com `duplicate: true` e NENHUM turno novo.
 *           controle: no MESMO `it`, um evento com `whatsapp_id` DIFERENTE, na
 *           MESMA stream, cria um segundo ingresso e um segundo turno, com
 *           `ingress_seq` 2. Sem ele, "um ingresso" também passaria num sistema
 *           que recusasse todo ingresso.
 *
 *   FI-02 — falha: `SIGKILL` no failpoint `after_inbound_persist_before_enqueue`
 *           — o commit já aconteceu, o `enqueueAgent` não.
 *           reação provada: o turno NÃO se perde (fica em `received`, com a
 *           mensagem não processada e ZERO jobs), e o varredor de produção
 *           `runMessageRecovery()` rearma EXATAMENTE UM job.
 *           controle: o MESMO varredor, rodado ANTES do envelhecimento, não
 *           rearma NADA — a regra de idade está viva. E rodado DUAS vezes
 *           depois, continua produzindo UM job só (o `jobId` determinístico).
 *
 *   FI-03 — falha: o mesmo `turn_id` é enfileirado N vezes, por processos
 *           distintos que não se conhecem (o ingresso e o recovery, em
 *           produção), soltos pela mesma barreira.
 *           reação provada: a fila `agent` fica com UM job, e ele é claimável
 *           uma vez só (`attempt_count = 1`).
 *           controle: no MESMO `it`, um turno DIFERENTE enfileirado uma vez
 *           ganha o SEU job. Sem ele, "um job" também passaria numa fila que
 *           estivesse simplesmente engolindo tudo.
 *
 * ═══ Por que a contagem de jobs é por PAYLOAD, e não por `jobId` ═══════════
 *
 * `TurnDriver.jobsDoTurno` varre a fila e classifica cada job com
 * `parseAgentTurnJob` — o parser de PRODUÇÃO. Perguntar
 * `getJob(agentTurnJobId(turn_id))` seria circular: com a derivação
 * determinística apagada, os N enfileiramentos criariam N jobs com ids
 * aleatórios e o `getJob` não acharia NENHUM — o cenário ficaria vermelho
 * dizendo "0 to be 1", que é o vermelho errado. Varrendo, o vermelho passa a
 * ser "esperava 1 job, achei 8", que é o defeito.
 *
 * ═══ Nenhum `sleep` sincroniza nada ════════════════════════════════════════
 *
 * A largada é uma BARREIRA; a parada é um GATE com resposta HTTP diferida (e
 * `esperarParadoEm` antes de qualquer `liberar`/`hardKill`); a espera é
 * `eventually` com prazo e diagnóstico. O único tempo de relógio que entra numa
 * asserção é `estavelDurante`, sempre com justificativa — e o único tempo
 * FABRICADO é `TurnDriver.envelhecerTurno`, que tem um bloco próprio dizendo o
 * que ele fabrica e o que não fabrica.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { agentTurnJobId } from '@/runtime/turns/job.js';
import { shutdownQueue } from '@/gateway/queue.js';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import { TurnDriver, type IdsDoTurno } from '../harness/turn-driver.js';
import { InvariantOracle, verificarProgresso } from '../oracles/invariant-oracle.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/** O failpoint desta fatia. O SEAM está em `fixtures/motor-de-turno.ts`. */
const GATE_INGRESSO = 'after_inbound_persist_before_enqueue';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** O MESMO binário de FI-04 — quem reivindica aqui chama `acquireTurnLease`. */
const FIXTURE_DE_CLAIM = resolve(AQUI, '..', 'fixtures', 'replica-de-turno.ts');

/**
 * Idade que FI-02 dá ao turno antes de chamar o varredor.
 *
 * `STUCK_AFTER_MS` de `src/workers/message-recovery.ts` é 2 minutos e não tem
 * env que a parametrize. Cinco minutos passam do prazo com folga sem que a
 * folga vire outro número mágico a manter. Ver `TurnDriver.envelhecerTurno`.
 */
const IDADE_DE_RECUPERACAO_MS = 5 * 60 * 1000;

/** Quantos processos disputam o enfileiramento em FI-03. */
const REPLICAS_DE_ENQUEUE = 4;
/** Quantas vezes CADA um repete o `enqueueAgent`. 4 × 2 = 8 tentativas. */
const REPETICOES_POR_REPLICA = 2;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let artefatos: ArtifactCollector;
let driver: TurnDriver;
let TENANT = '';
let AGENTE = '';

/** Toda linha estruturada de um prefixo, já parseada. */
function linhasDe(filho: SupervisedChild, prefixo: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const linha of filho.stdout.split('\n')) {
    const t = linha.trim();
    if (!t.startsWith(prefixo)) continue;
    try {
      out.push(JSON.parse(t.slice(prefixo.length).trim()) as Record<string, unknown>);
    } catch {
      // Linha partida pelo chunk: o próximo pedaço a completa.
    }
  }
  return out;
}

function oracleDe(turnIds: readonly (string | null)[]): InvariantOracle {
  return new InvariantOracle({
    pool,
    escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
    turnIds: turnIds.filter((t): t is string => typeof t === 'string'),
  });
}

d('#510 FI-01/FI-02/FI-03 — ingresso, crash pré-enqueue e enfileiramento duplicado', () => {
  beforeAll(async () => {
    // Banco EXCLUSIVO desta suíte, migrado pelo runner de produção, com
    // tenants/agents explícitos. A tranca da faxina (`assertAlvoDestrutivo`)
    // roda antes de criar E antes de destruir.
    env = await ReliabilityEnvironment.criar({ suite: 'fi-ingresso' });
    TENANT = env.estado.tenants[0]!.tenantId;
    AGENTE = env.estado.tenants[0]!.agentId;
    pool = new pg.Pool({ connectionString: env.estado.databaseUrl });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await env?.derrubar();
    // A fila `agent` é REAL e vive num Redis que o `DROP DATABASE` não alcança.
    // Fechar a conexão da BullMQ deste processo é o que impede o worker do
    // vitest de terminar com um handle aberto.
    await shutdownQueue();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-ingresso', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
    driver = await TurnDriver.criar({
      env,
      pool,
      sup,
      servidor,
      tenant_id: TENANT,
      agent_id: AGENTE,
    });
  });

  afterEach(async (ctx) => {
    await sup.dispose();
    await servidor.fechar();
    // A fila é compartilhada: só os jobs QUE ESTE DRIVER ARMOU saem.
    await driver?.limparJobs();
    // Artefato SÓ no vermelho: o CI não coleciona megabytes de rodada verde.
    if (ctx.task.result?.state === 'fail') {
      console.error(`[#510] artefato do cenário: ${artefatos.escrever()}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FI-01
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-01 — o MESMO evento em duas réplicas de processo: um ingresso, um turno lógico',
    async () => {
      const alvo = await driver.criarAlvo('fi01');

      // As DUAS réplicas recebem o MESMO `whatsapp_id` — é exatamente o que uma
      // reentrega do provedor produz depois de um ACK perdido.
      const a = driver.subirIngresso('ingresso-a', alvo, { TEST_FI_BARREIRA: 'largada' });
      const b = driver.subirIngresso('ingresso-b', alvo, { TEST_FI_BARREIRA: 'largada' });

      // A LARGADA. Sem ela quem persiste primeiro é quem terminou de importar
      // o grafo de módulos antes — isso não é corrida, é sorteio de import.
      await servidor.esperarNaBarreira('largada', 2, 60_000);
      expect(servidor.abrirBarreira('largada')).toBe(2);

      const [pa, pb] = await Promise.all([driver.prontidao(a), driver.prontidao(b)]);
      expect(a.pid).not.toBe(b.pid);

      const vencedores = [pa, pb].filter((p) => !p.duplicate);
      const perdedores = [pa, pb].filter((p) => p.duplicate);
      expect(
        vencedores.length,
        `esperava UM ingresso novo; a=${JSON.stringify(pa)} b=${JSON.stringify(pb)}`,
      ).toBe(1);
      const vencedor = vencedores[0] as IdsDoTurno;
      const perdedor = perdedores[0] as IdsDoTurno;

      // A REAÇÃO, do lado do vencedor: ingresso novo, turno novo, posição 1 na
      // stream.
      expect(vencedor.turn_id).not.toBeNull();
      expect(vencedor.ingress_seq).toBe(1);
      expect(vencedor.stream_key).not.toBeNull();
      expect(vencedor.conversa_id).toBe(alvo.conversa_id);

      // E do lado do perdedor, e é aqui que o cenário deixa de ser vácuo: ele
      // NÃO falhou nem foi ignorado — ele recebeu de volta a MESMA row, com
      // `duplicate: true` e SEM turno novo. Um processo que apenas tivesse
      // morrido reportaria "não consegui"; este reporta o id do vencedor.
      expect(perdedor.mensagem_id).toBe(vencedor.mensagem_id);
      expect(
        perdedor.turn_id,
        'a réplica dedupada criou um turno — a reentrega virou trabalho novo',
      ).toBeNull();

      // A REAÇÃO no banco: UM ingresso para o evento, UM turno na stream.
      const ingressos = await driver.ingressosDoEvento(alvo.whatsapp_id);
      expect(
        ingressos.length,
        `o mesmo whatsapp_id produziu ${ingressos.length} rows: ${JSON.stringify(ingressos)}`,
      ).toBe(1);
      expect(ingressos[0]!.id).toBe(vencedor.mensagem_id);

      const turnos = await driver.turnosDaStream(vencedor.stream_key as string);
      expect(turnos.map((t) => t.id)).toEqual([vencedor.turn_id]);

      // E nada se move enquanto as duas réplicas continuam VIVAS. A invariante
      // é NEGATIVA ("a reentrega não vira um segundo ingresso"), e não existe
      // evento de "não persisti".
      expect(a.vivo && b.vivo).toBe(true);
      await estavelDurante(
        async () => (await driver.ingressosDoEvento(alvo.whatsapp_id)).length,
        {
          label: 'a reentrega não produz um segundo ingresso',
          janelaMs: 1_200,
          justificativa:
            'a invariante é negativa; não existe evento de "ingresso que não aconteceu", ' +
            'então a única prova honesta é observar a janela com as duas réplicas vivas',
        },
      );

      // ── O CONTROLE. Um evento DIFERENTE, na MESMA stream, PASSA: segundo
      //    ingresso, segundo turno, `ingress_seq` 2. Sem isto, "um ingresso"
      //    também passaria num sistema que recusasse todo ingresso — e a
      //    sequência provaria que a reentrega não consumiu número (#505).
      const outroEvento = { ...alvo, whatsapp_id: `${alvo.whatsapp_id}-novo` };
      const pc = await driver.injetar('ingresso-c', outroEvento);
      expect(pc.duplicate).toBe(false);
      expect(pc.mensagem_id).not.toBe(vencedor.mensagem_id);
      expect(pc.turn_id).not.toBeNull();
      expect(pc.turn_id).not.toBe(vencedor.turn_id);
      expect(
        pc.ingress_seq,
        'a reentrega consumiu uma posição da stream — o rollback de #505 não devolveu o número',
      ).toBe(2);
      expect(pc.stream_key).toBe(vencedor.stream_key);

      const turnosDepois = await driver.turnosDaStream(vencedor.stream_key as string);
      expect(turnosDepois).toHaveLength(2);

      await oracleDe([vencedor.turn_id, pc.turn_id]).assertInvariantes('FI-01');
    },
    180_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-02
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-02 — SIGKILL entre o commit e o enqueue: o turno não se perde e o recovery rearma UM job',
    async () => {
      const alvo = await driver.criarAlvo('fi02');
      servidor.arm(GATE_INGRESSO, 'pause');

      // O motor persiste o inbound e PARA entre as duas chamadas de produção —
      // o mesmo par que `src/gateway/baileys.ts` faz em sequência.
      const morto = driver.subirIngresso('ingresso-morto', alvo, {
        TEST_FI_GATE: 'sim',
        TEST_FI_ENFILEIRAR: 'sim',
      });
      const ids = await driver.prontidao(morto);
      const turn_id = ids.turn_id as string;
      expect(turn_id).not.toBeNull();

      const oracle = oracleDe([turn_id]);

      // O anúncio traz os IDs — o cenário CONFERE o estágio antes de agir, em
      // vez de assumir que o processo já chegou onde deveria.
      const evento = await servidor.waitForReached(GATE_INGRESSO, { timeoutMs: 30_000 });
      expect(evento.context).toMatchObject({ turn_id, mensagem_id: ids.mensagem_id });
      // E `esperarParadoEm` antes de matar: "anunciou" e "está bloqueado no
      // fetch esperando decisão" são fatos diferentes, e só o segundo autoriza
      // o `hardKill`.
      await servidor.esperarParadoEm(GATE_INGRESSO, 1, 30_000);

      const antesDoCrash = await oracle.coletar();
      expect((await driver.linhaDoTurno(turn_id)).status).toBe('received');
      expect(await driver.processadaEm(ids.mensagem_id)).toBeNull();
      expect(await driver.jobsDoTurno({ turn_id, mensagem_id: ids.mensagem_id })).toHaveLength(0);

      // A FALHA: `SIGKILL` num processo PARADO no ponto exato. Nenhum `finally`
      // roda, nenhum pool fecha, nenhum `enqueueAgent` acontece.
      sup.hardKill(morto);
      const enc = await morto.esperarSaida(10_000);
      expect(enc.signal).toBe('SIGKILL');
      // A prova de que ele morreu ANTES do enqueue, e não durante: a linha
      // `##fi-gate## {fase:'liberado'}` nunca foi impressa.
      expect(linhasDe(morto, '##fi-gate##').map((l) => l.fase)).toEqual(['chegando']);
      expect(linhasDe(morto, '##fi-enqueue##')).toHaveLength(0);

      // A REAÇÃO: o turno SOBREVIVEU ao crash, em `received`, sem job nenhum.
      // É exatamente o estado que `createReceivedTurnTx` promete deixar quando
      // o processo morre na janela — e é ele que o recovery procura.
      const logoApos = await driver.linhaDoTurno(turn_id);
      expect(logoApos.status).toBe('received');
      expect(logoApos.conversa_id).toBe(alvo.conversa_id);
      expect(await driver.processadaEm(ids.mensagem_id)).toBeNull();
      await estavelDurante(
        async () =>
          (await driver.jobsDoTurno({ turn_id, mensagem_id: ids.mensagem_id })).length,
        {
          label: 'a morte no gate não deixou job nenhum para trás',
          janelaMs: 1_000,
          justificativa:
            'a invariante é negativa ("nada foi enfileirado"); não existe evento de ' +
            'enqueue que não aconteceu',
        },
      );

      // ── O CONTROLE DE PRAZO. O varredor DE PRODUÇÃO roda agora, com o turno
      //    ainda novo, e NÃO rearma nada. Sem isto, "o recovery rearmou" também
      //    passaria num varredor que rearmasse tudo o tempo todo — e o
      //    envelhecimento do passo seguinte seria indistinguível de ter
      //    desligado a checagem de idade.
      await driver.recuperar('recovery-cedo');
      expect(
        await driver.jobsDoTurno({ turn_id, mensagem_id: ids.mensagem_id }),
        'o varredor rearmou um turno que ainda não venceu STUCK_AFTER_MS',
      ).toHaveLength(0);
      expect((await driver.linhaDoTurno(turn_id)).status).toBe('received');

      // Só a IDADE é fabricada. Estado, regra de elegibilidade e produtor do
      // job continuam sendo os de produção — ver `TurnDriver.envelhecerTurno`.
      await driver.envelhecerTurno(turn_id, IDADE_DE_RECUPERACAO_MS);

      // A REAÇÃO: `runMessageRecovery()` — o varredor inteiro, sem
      // reimplementação — rearma EXATAMENTE UM job, com o id determinístico.
      await driver.recuperar('recovery-tarde');
      const jobs = await driver.esperarJobs(
        { turn_id, mensagem_id: ids.mensagem_id },
        1,
        { label: 'o varredor de produção rearma UM job para o turno órfão' },
      );
      expect(jobs[0]!.id).toBe(agentTurnJobId(turn_id));
      expect(jobs[0]!.mensagem_id).toBe(ids.mensagem_id);
      expect(['waiting', 'active', 'delayed', 'prioritized']).toContain(jobs[0]!.estado);

      // E o turno saiu de `received` para `queued` pela transição de produção
      // (`noteTurnQueued`), que é o que diz "existe wake-up para este turno".
      const depois = await driver.esperarEstado(turn_id, ['queued']);
      expect(depois.attempt_count).toBe(0);

      // ── UM job, e não um por varredura. Um segundo sweep do MESMO turno
      //    ainda elegível colide no mesmo `jobId` em vez de criar outro.
      await driver.recuperar('recovery-tarde-2');
      await estavelDurante(
        async () =>
          (await driver.jobsDoTurno({ turn_id, mensagem_id: ids.mensagem_id })).length,
        {
          label: 'a segunda varredura NÃO cria um segundo job',
          janelaMs: 1_500,
          intervalMs: 100,
          justificativa:
            'é uma afirmação negativa sobre duplicação no transporte; o segundo job, ' +
            'se existisse, apareceria dentro da janela',
        },
      );
      expect(await driver.jobsDoTurno({ turn_id, mensagem_id: ids.mensagem_id })).toHaveLength(1);

      const depoisDaRecuperacao = await oracle.coletar();
      expect(verificarProgresso(antesDoCrash, depoisDaRecuperacao)).toEqual([]);
      await oracle.assertInvariantes('FI-02');
    },
    240_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-03
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-03 — o mesmo turn_id enfileirado por N processos: um job ativo, um claim',
    async () => {
      const alvo = await driver.criarAlvo('fi03');
      const ids = await driver.injetar('ingresso', alvo);
      const turn_id = ids.turn_id as string;
      const mensagem_id = ids.mensagem_id;
      expect(await driver.jobsDoTurno({ turn_id, mensagem_id })).toHaveLength(0);

      // N processos que não se conhecem armando o MESMO trabalho — em produção
      // são o ingresso (`src/gateway/baileys.ts`) e o varredor
      // (`src/workers/message-recovery.ts`), que podem rodar em réplicas.
      const filhos: SupervisedChild[] = [];
      for (let i = 0; i < REPLICAS_DE_ENQUEUE; i += 1) {
        filhos.push(
          driver.subirEnfileirador(`enfileirador-${i}`, { mensagem_id, turn_id }, {
            TEST_FI_BARREIRA: 'largada',
            TEST_FI_REPETICOES: String(REPETICOES_POR_REPLICA),
          }),
        );
      }

      await servidor.esperarNaBarreira('largada', REPLICAS_DE_ENQUEUE, 90_000);
      expect(servidor.abrirBarreira('largada')).toBe(REPLICAS_DE_ENQUEUE);
      const prontos = await Promise.all(filhos.map((f) => driver.prontidao(f)));
      expect(new Set(filhos.map((f) => f.pid)).size).toBe(REPLICAS_DE_ENQUEUE);

      // Cada processo REALMENTE tentou — e tentou `REPETICOES_POR_REPLICA`
      // vezes. Sem esta contagem, "um job" também passaria num cenário em que
      // três dos quatro processos nem chegaram a chamar `enqueueAgent`.
      const tentativas = filhos.reduce((t, f) => t + linhasDe(f, '##fi-enqueue##').length, 0);
      expect(tentativas).toBe(REPLICAS_DE_ENQUEUE * REPETICOES_POR_REPLICA);
      for (const p of prontos) expect(p.ok).toBe(true);

      // A REAÇÃO: as 8 tentativas colidem num job SÓ. A contagem é por payload
      // — ver o bloco no topo sobre por que não é por `jobId`.
      const jobs = await driver.esperarJobs({ turn_id, mensagem_id }, 1, {
        label: `${String(tentativas)} enfileiramentos do mesmo turno colidem num job`,
      });
      expect(jobs[0]!.id).toBe(agentTurnJobId(turn_id));
      expect(jobs[0]!.turn_id).toBe(turn_id);
      expect(jobs[0]!.mensagem_id).toBe(mensagem_id);

      await estavelDurante(async () => (await driver.jobsDoTurno({ turn_id, mensagem_id })).length, {
        label: 'nenhum job extra aparece depois da corrida',
        janelaMs: 1_500,
        intervalMs: 100,
        justificativa:
          'é uma afirmação negativa sobre duplicação no transporte; um job atrasado ' +
          'apareceria dentro da janela',
      });

      // ── O CONTROLE. Um turno DIFERENTE, enfileirado UMA vez, ganha o SEU
      //    job. Sem isto, "um job" também passaria numa fila que estivesse
      //    engolindo tudo — ou num driver que contasse errado.
      const outro = await driver.criarAlvo('fi03-controle');
      const idsOutro = await driver.injetar('ingresso-controle', outro);
      const turnOutro = idsOutro.turn_id as string;
      await driver.prontidao(
        driver.subirEnfileirador('enfileirador-controle', {
          mensagem_id: idsOutro.mensagem_id,
          turn_id: turnOutro,
        }),
      );
      const jobsOutro = await driver.esperarJobs(
        { turn_id: turnOutro, mensagem_id: idsOutro.mensagem_id },
        1,
        { label: 'o turno de controle ganha o SEU job' },
      );
      expect(jobsOutro[0]!.id).toBe(agentTurnJobId(turnOutro));
      expect(jobsOutro[0]!.id).not.toBe(jobs[0]!.id);
      // E o job do turno disputado continua UM — o controle não o duplicou.
      expect(await driver.jobsDoTurno({ turn_id, mensagem_id })).toHaveLength(1);

      // ── UM CLAIM. O job que sobreviveu é trabalho REAL: uma réplica de turno
      //    (o mesmo binário de FI-04) o reivindica com `acquireTurnLease` e a
      //    linha registra UMA tentativa.
      const claimador = sup.spawn({
        label: 'claimador',
        script: FIXTURE_DE_CLAIM,
        cwd: process.cwd(),
        env: {
          ...env.envDoFilho(),
          ...servidor.envDoFilho(),
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' '),
          TEST_FI_TENANT_ID: TENANT,
          TEST_FI_AGENT_ID: AGENTE,
          TEST_FI_TURN_ID: turn_id,
        },
        readyTimeoutMs: 45_000,
      });
      const posse = (await claimador.esperarPronto(45_000)) as unknown as {
        acquired: boolean;
        attempt: number | null;
        motivo: string;
      };
      expect(posse.acquired, `o job sobrevivente não era claimável: ${JSON.stringify(posse)}`).toBe(
        true,
      );
      const linha = await driver.linhaDoTurno(turn_id);
      expect(linha.status).toBe('claimed');
      expect(linha.attempt_count, 'oito enfileiramentos produziram mais de um claim').toBe(1);

      await oracleDe([turn_id, turnOutro]).assertInvariantes('FI-03');
    },
    240_000,
  );
});

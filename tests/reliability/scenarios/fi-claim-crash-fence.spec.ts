/**
 * Issue #510 (fatia B) — FI-04, FI-05, FI-06 e FI-07 contra infraestrutura
 * REAL, com réplicas que são PROCESSOS e falhas que são SINAIS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que estes quatro cenários provam, e por que nenhum deles é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A armadilha de um harness de fault injection é injetar a falha, nada quebrar,
 * e o teste passar afirmando nada. O antídoto aplicado aqui, cenário a cenário,
 * é sempre o mesmo par: **a reação do sistema é observada positivamente**, e
 * **existe um caso de controle em que ela não deveria acontecer**.
 *
 *   FI-04 — falha: duas réplicas disputam o MESMO turno, soltas por barreira.
 *           reação provada: o `UPDATE` atômico de `claimNextEligibleTurn`
 *           concede a posse a UMA. Observada como: um `acquired`, um recusado
 *           COM MOTIVO, `attempt_count = 1`, um único `claim_token`.
 *           controle: a réplica perdedora continua VIVA e não grava nada.
 *
 *   FI-05 — falha: `SIGKILL` no dono, parado num failpoint exato.
 *           reação provada: a lease vence e o SUCESSOR assume, com
 *           `attempt_count = 2` e token novo.
 *           controle: o sucessor sobe ANTES do crash e é RECUSADO várias vezes
 *           com o dono PROVADAMENTE vivo; as recusas estão no stdout dele. Sem
 *           isso, "o sucessor assumiu" também passaria num sistema sem lease
 *           nenhuma. (A ordem — sucessor antes do `SIGKILL` — é da fatia F:
 *           subi-lo depois fazia o controle depender de o import a frio caber
 *           no TTL, e isso flocava.)
 *
 *   FI-06 — falha: o heartbeat do dono para, mas o processo NÃO morre
 *           (`SIGSTOP`).
 *           reação provada: a lease vence mesmo com o dono vivo, e o sucessor
 *           assume. É a falha que o `SIGKILL` não consegue modelar.
 *
 *   FI-07 — falha: o dono deposto VOLTA (`SIGCONT`) e tenta gravar.
 *           reação provada: o `WHERE claim_token = …` do banco RECUSA, com
 *           `conflict: 'stale_claim'` — e a linha não se move.
 *           controle: o MESMO binário, no cenário FI-04, grava com sucesso
 *           quando o token é o vigente. Sem esse controle, "a gravação foi
 *           recusada" também passaria num fixture que não sabe gravar.
 *
 * ═══ Por que réplicas de PROCESSO, e não de objeto ═════════════════════════
 *
 * `tests/reliability/README.md` já dizia o que faltava: as suítes de #504
 * simulam réplicas concorrentes DENTRO de um processo, com `worker_id`
 * distinto. Um `throw` simulado ainda roda `finally`, ainda fecha o pool, ainda
 * deixa o heartbeat cancelar o timer. Aqui são dois pids, dois
 * `turnWorkerId()`, dois pools de Postgres, dois event loops — e o encerramento
 * é `SIGKILL`, que não roda nada disso.
 *
 * ═══ Por que o filho importa de `src/` ═════════════════════════════════════
 *
 * `fixtures/replica-de-turno.ts` chama `acquireTurnLease` e
 * `agentTurnsRepo.markRunning` REAIS. Se ele reescrevesse o SQL, esta suíte
 * continuaria verde depois de alguém apagar a condição de lease do claim — ela
 * estaria provando o SQL do fixture. As sondas vermelhas da PR acertam o call
 * site de produção justamente por causa disso.
 *
 * ═══ Nenhum `sleep` sincroniza nada ════════════════════════════════════════
 *
 * A largada é uma BARREIRA; a parada é um GATE de failpoint com resposta HTTP
 * diferida; a espera é `eventually` com prazo e diagnóstico. O único lugar em
 * que o tempo aparece como grandeza é o vencimento da lease — e ele é lido do
 * relógio do BANCO, nunca do processo de teste.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante, eventually } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import {
  InvariantOracle,
  verificarFenceDeTokenDeposto,
  verificarProgresso,
} from '../oracles/invariant-oracle.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
const FIXTURE = resolve(AQUI, '..', 'fixtures', 'replica-de-turno.ts');

/**
 * `--import tsx`, e NÃO o CLI do tsx: o CLI spawna um NETO para aplicar os
 * flags do loader, e o pid que o `ProcessSupervisor` registra passa a ser o do
 * invólucro. Um `SIGKILL` mataria a casca enquanto o processo que segura a
 * lease continua batendo heartbeat — um teste de crash que não mata o processo
 * certo é pior que nenhum. A armadilha está documentada em
 * `tests/reliability/README.md` (#513, fatia D) e é cobrada caso a caso aqui
 * (`carga.pid === filho.pid`).
 */
const CARREGADOR_TSX = '--import tsx';

/**
 * TTL da lease NESTES cenários. O default de produção é 60s
 * (`TURN_LEASE_TTL_MS`), o que faria FI-05/06/07 esperarem um minuto cada.
 * 6s com heartbeat de 1.5s mantém a razão do contrato (heartbeat cabe 4x no
 * TTL, e o mínimo exigido é 3x — `MAX_HEARTBEAT_TO_TTL_RATIO`), de modo que
 * uma pausa de GC do dono VIVO não produza takeover falso e transforme o
 * vermelho em ruído.
 */
const TTL_MS = 6_000;
const BATIDA_MS = 1_500;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let artefatos: ArtifactCollector;
let TENANT = '';
let AGENTE = '';

interface Prontidao {
  pid: number;
  worker_id: string;
  acquired: boolean;
  claim_token: string | null;
  attempt: number | null;
  motivo: string;
}

interface LinhaDoTurno {
  status: string;
  attempt_count: number;
  claim_token: string | null;
  claimed_by: string | null;
  state_version: number;
  lease_expires_at: Date | null;
}

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

async function linhaDoTurno(turn_id: string): Promise<LinhaDoTurno> {
  const r = await pool.query<LinhaDoTurno>(
    `SELECT status, attempt_count::int AS attempt_count, claim_token::text AS claim_token,
            claimed_by, state_version::int AS state_version, lease_expires_at
       FROM agent_turns WHERE id = $1`,
    [turn_id],
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`turno ${turn_id} sumiu do banco`);
  return linha;
}

/** O relógio é o do BANCO — o do processo de teste não decide prazo nenhum. */
async function jaVenceu(prazo: Date | null): Promise<boolean> {
  if (!prazo) return true;
  const r = await pool.query<{ v: boolean }>('SELECT $1::timestamptz <= now() AS v', [prazo]);
  return r.rows[0]?.v === true;
}

/** Cria um inbound e o turno `received` correspondente. Um por caso. */
async function turnoNovo(): Promise<string> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [mensagem_id, TENANT, AGENTE],
  );
  const r = await pool.query<{ id: string }>(
    `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status)
     VALUES ($1, $2, $3, 'received') RETURNING id::text AS id`,
    [TENANT, AGENTE, mensagem_id],
  );
  return r.rows[0]!.id;
}

function subirReplica(
  label: string,
  turn_id: string,
  extra: Readonly<Record<string, string>> = {},
): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE,
    cwd: RAIZ,
    env: {
      ...env.envDoFilho(),
      ...servidor.envDoFilho(),
      // Acrescentado, não substituído: o que o worker do vitest já pediu
      // continua valendo para o filho.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
      TURN_LEASE_TTL_MS: String(TTL_MS),
      TURN_LEASE_HEARTBEAT_MS: String(BATIDA_MS),
      TEST_FI_TENANT_ID: TENANT,
      TEST_FI_AGENT_ID: AGENTE,
      TEST_FI_TURN_ID: turn_id,
      ...extra,
    },
    // Import a frio do grafo de produção sob `tsx` numa máquina compartilhada.
    readyTimeoutMs: 45_000,
  });
}

/** O handshake, com a premissa de todo `SIGKILL` desta suíte cobrada. */
async function prontidaoDe(filho: SupervisedChild): Promise<Prontidao> {
  const carga = (await filho.esperarPronto(45_000)) as unknown as Prontidao;
  expect(
    carga.pid,
    'o pid do dono do claim não é o pid supervisionado — o SIGKILL mataria um invólucro',
  ).toBe(filho.pid);
  return carga;
}

d('#510 FI-04/05/06/07 — claim, crash e fence com réplicas de PROCESSO', () => {
  beforeAll(async () => {
    // Banco EXCLUSIVO desta suíte, migrado pelo runner de produção, com
    // tenants/agents explícitos. A tranca da faxina (`assertAlvoDestrutivo`)
    // roda antes de criar E antes de destruir.
    env = await ReliabilityEnvironment.criar({ suite: 'fi-claim-crash-fence' });
    TENANT = env.estado.tenants[0]!.tenantId;
    AGENTE = env.estado.tenants[0]!.agentId;
    pool = new pg.Pool({ connectionString: env.estado.databaseUrl });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await env?.derrubar();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-claim-crash-fence', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
  });

  afterEach(async (ctx) => {
    await sup.dispose();
    await servidor.fechar();
    // Artefato SÓ no vermelho: o CI não coleciona megabytes de rodada verde.
    if (ctx.task.result?.state === 'fail') {
      console.error(`[#510] artefato do cenário: ${artefatos.escrever()}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FI-04
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-04 — duas réplicas soltas pela MESMA barreira: exatamente um claim_token vence',
    async () => {
      const turn_id = await turnoNovo();
      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [turn_id],
      });

      // O gate segura o VENCEDOR logo depois do claim — é o que garante que a
      // foto do banco seja tirada com a corrida já decidida e ninguém adiante.
      servidor.arm('after_turn_claim_before_running', 'pause');

      const a = subirReplica('replica-a', turn_id, {
        TEST_FI_BARREIRA: 'largada',
        TEST_FI_ESCREVER: 'running',
      });
      const b = subirReplica('replica-b', turn_id, {
        TEST_FI_BARREIRA: 'largada',
        TEST_FI_ESCREVER: 'running',
      });

      // A LARGADA. Sem ela quem vence é quem terminou de importar primeiro —
      // isso não é corrida, é sorteio de tempo de import.
      await servidor.esperarNaBarreira('largada', 2, 60_000);
      expect(servidor.abrirBarreira('largada')).toBe(2);

      const [pa, pb] = await Promise.all([prontidaoDe(a), prontidaoDe(b)]);
      expect(a.pid).not.toBe(b.pid);
      expect(pa.worker_id).not.toBe(pb.worker_id);

      const vencedores = [pa, pb].filter((p) => p.acquired);
      const perdedores = [pa, pb].filter((p) => !p.acquired);
      expect(
        vencedores.length,
        `esperava UM vencedor; a=${JSON.stringify(pa)} b=${JSON.stringify(pb)}`,
      ).toBe(1);
      const vencedor = vencedores[0]!;
      const perdedor = perdedores[0]!;

      // A recusa do perdedor tem MOTIVO. "Não conseguiu" sem motivo também
      // seria o que um processo que nem tentou reportaria.
      expect(perdedor.motivo).not.toBe('acquired');
      expect(perdedor.motivo).not.toBe('nenhuma_tentativa');

      // A REAÇÃO, no banco: um claim, uma tentativa, um dono.
      const linha = await linhaDoTurno(turn_id);
      expect(linha.status).toBe('claimed');
      expect(linha.attempt_count, 'duas réplicas contaram duas tentativas').toBe(1);
      expect(linha.claim_token).toBe(vencedor.claim_token);
      expect(linha.claimed_by).toBe(vencedor.worker_id);

      // E ela se mantém: o perdedor continua VIVO e insistindo? Não — ele
      // tentou uma vez. O que se afirma aqui é que nada se move enquanto o
      // vencedor está parado no gate.
      await estavelDurante(
        async () => {
          const l = await linhaDoTurno(turn_id);
          return { claim_token: l.claim_token, attempt: l.attempt_count, versao: l.state_version };
        },
        {
          label: 'a posse do turno não muda enquanto o vencedor está no gate',
          janelaMs: 1_200,
          justificativa:
            'não existe evento de "claim que não aconteceu"; a única prova é observar a janela',
        },
      );

      await oracle.assertInvariantes('FI-04');

      // CASO DE CONTROLE do fence: liberado, o vencedor grava com o token
      // VIGENTE e a gravação PASSA. Sem isto, a recusa de FI-07 também
      // passaria num fixture que simplesmente não sabe gravar.
      servidor.liberar('after_turn_claim_before_running');
      const escritaDoVencedor = await eventually(
        () => linhasDe(vencedor === pa ? a : b, '##fi-escrita##').at(-1),
        { label: 'o vencedor grava markRunning com o token vigente', timeoutMs: 15_000 },
      );
      expect(escritaDoVencedor).toMatchObject({ operacao: 'markRunning', ok: true, conflict: null });
      expect((await linhaDoTurno(turn_id)).status).toBe('running');
    },
    180_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-05
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-05 — SIGKILL no dono parado no failpoint: o sucessor assume, e só depois do prazo',
    async () => {
      const turn_id = await turnoNovo();
      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [turn_id],
      });

      servidor.arm('after_turn_claim_before_running', 'pause');
      const a = subirReplica('dono', turn_id);
      const pa = await prontidaoDe(a);
      expect(pa.acquired, `o dono não conseguiu o claim: ${JSON.stringify(pa)}`).toBe(true);

      // O anúncio traz os IDs — o cenário CONFERE o estágio antes de agir, em
      // vez de assumir que o processo já chegou onde deveria.
      const evento = await servidor.waitForReached('after_turn_claim_before_running', {
        timeoutMs: 30_000,
      });
      expect(evento.context).toMatchObject({ turn_id, attempt: 1, worker_id: pa.worker_id });

      const antesDoCrash = await oracle.coletar();
      const linhaAntes = await linhaDoTurno(turn_id);

      // ── O SUCESSOR SOBE ANTES DO CRASH, e a ordem é o que torna o controle
      //    DETERMINÍSTICO (#510, fatia F).
      //
      // A ordem anterior — matar e só então subir o sucessor — fazia o controle
      // ("antes do prazo ele é RECUSADO") depender de o import a frio do grafo
      // de produção caber dentro do TTL da lease. O import custa de 1.9s a 6.8s
      // (`AGENTS.md` §7.1) e o TTL aqui é 6s: numa rodada lenta o sucessor
      // terminava de importar DEPOIS do vencimento e entrava na primeira
      // tentativa, sem nunca ter sido barrado — flake observado em rodadas
      // seguidas da lane. Subir antes tira o relógio do caminho, e o controle
      // fica mais forte: as recusas são observadas com o dono PROVADAMENTE
      // vivo, e não só "antes do prazo".
      const b = subirReplica('sucessor', turn_id, {
        TEST_FI_TENTATIVAS: '200',
        TEST_FI_INTERVALO_MS: '250',
      });
      const recusasAntesDoCrash = await eventually(
        () => {
          const t = linhasDe(b, '##fi-claim##').filter((x) => x.result !== 'acquired');
          return t.length >= 2 ? t : undefined;
        },
        {
          label: 'o sucessor é RECUSADO enquanto o dono VIVO segura a lease',
          timeoutMs: 60_000,
          abortSignal: sup.sinalDeFalha,
          describeState: () => ({ stdout: b.stdout.split('\n').slice(-6) }),
        },
      );
      for (const r of recusasAntesDoCrash) expect(r.result).toBe('not_eligible');

      // A FALHA: `SIGKILL` num processo PARADO num ponto exato do caminho.
      sup.hardKill(a);
      const enc = await a.esperarSaida(10_000);
      expect(enc.signal).toBe('SIGKILL');

      // Nada foi devolvido. Um `SIGKILL` não roda `finally`, e é isto que o
      // distingue de um `throw` simulado: a posse do MORTO continua gravada,
      // com o mesmo token e o prazo que o último heartbeat dele deixou.
      const logoApos = await linhaDoTurno(turn_id);
      expect(logoApos.claim_token).toBe(pa.claim_token);
      expect(logoApos.claimed_by).toBe(pa.worker_id);
      expect(logoApos.attempt_count).toBe(1);
      expect(await jaVenceu(logoApos.lease_expires_at)).toBe(false);

      // O SUCESSOR — já vivo e insistindo desde antes do crash — assume quando o
      // BANCO deixa. O gate já foi consumido pelo dono morto (`remaining: 1`),
      // então ele passa direto por ele.
      const pb = await prontidaoDe(b);
      expect(pb.acquired, `o sucessor nunca assumiu: ${JSON.stringify(pb)}`).toBe(true);

      // O CONTROLE que impede o vácuo, agora contado sobre a corrida inteira:
      // ele foi RECUSADO várias vezes antes de entrar, e todas as recusas têm
      // o mesmo motivo. Sem elas, "o sucessor assumiu" também passaria num
      // sistema que nunca teve lease nenhuma.
      const tentativas = linhasDe(b, '##fi-claim##');
      const recusas = tentativas.filter((t) => t.result !== 'acquired');
      expect(
        recusas.length,
        `o sucessor entrou na PRIMEIRA tentativa — a lease do morto não barrou nada: ${JSON.stringify(tentativas)}`,
      ).toBeGreaterThanOrEqual(2);
      for (const r of recusas) expect(r.result).toBe('not_eligible');

      // A REAÇÃO: tentativa nova, token novo, dono novo.
      const depois = await linhaDoTurno(turn_id);
      expect(depois.attempt_count).toBe(2);
      expect(depois.claim_token).not.toBe(pa.claim_token);
      expect(depois.claimed_by).toBe(pb.worker_id);
      expect(depois.state_version).toBeGreaterThan(linhaAntes.state_version);

      const depoisDaRecuperacao = await oracle.coletar();
      expect(verificarProgresso(antesDoCrash, depoisDaRecuperacao)).toEqual([]);
      await oracle.assertInvariantes('FI-05');
    },
    180_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-06 + FI-07
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-06/FI-07 — dono CONGELADO perde a lease; ao voltar, sua gravação é recusada pelo fence',
    async () => {
      expect(
        ProcessSupervisor.suportaCongelamento(),
        'esta plataforma não implementa SIGSTOP — o cenário não pode ser executado, e passar seria vácuo',
      ).toBe(true);

      const turn_id = await turnoNovo();
      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [turn_id],
      });

      servidor.arm('after_turn_claim_before_running', 'pause');
      const a = subirReplica('dono-congelado', turn_id, { TEST_FI_ESCREVER: 'running' });
      const pa = await prontidaoDe(a);
      expect(pa.acquired).toBe(true);
      await servidor.waitForReached('after_turn_claim_before_running', { timeoutMs: 30_000 });

      // FI-06 — A FALHA: o heartbeat para, mas o processo NÃO morre. É a falha
      // que o `SIGKILL` não modela: pausa longa de GC, VM suspensa, `fsync`
      // travado. O dono continua vivo, com o `claim_token` na memória.
      sup.congelar(a);
      const congeladoEm = await linhaDoTurno(turn_id);
      expect(congeladoEm.claim_token).toBe(pa.claim_token);

      // A REAÇÃO: a lease vence pelo relógio do BANCO, mesmo com o dono vivo.
      await eventually(async () => await jaVenceu((await linhaDoTurno(turn_id)).lease_expires_at), {
        label: 'a lease do dono congelado vence pelo relógio do banco',
        timeoutMs: TTL_MS * 3,
        intervalMs: 100,
        describeState: async () => await linhaDoTurno(turn_id),
      });

      // E o sucessor assume.
      const b = subirReplica('sucessor', turn_id, {
        TEST_FI_TENTATIVAS: '80',
        TEST_FI_INTERVALO_MS: '250',
      });
      const pb = await prontidaoDe(b);
      expect(pb.acquired, `o sucessor não assumiu do dono congelado: ${JSON.stringify(pb)}`).toBe(
        true,
      );
      const noTakeover = await linhaDoTurno(turn_id);
      expect(noTakeover.claim_token).not.toBe(pa.claim_token);
      expect(noTakeover.attempt_count).toBe(2);

      // FI-07 — O DONO DEPOSTO VOLTA. `SIGCONT` devolve o processo com todo o
      // estado que ele tinha, inclusive o `claim_token` que já não vale.
      sup.descongelar(a);
      servidor.liberar('after_turn_claim_before_running');

      const escrita = await eventually(() => linhasDe(a, '##fi-escrita##').at(-1), {
        label: 'o dono deposto tenta a gravação fenced',
        timeoutMs: 30_000,
        describeState: () => ({ stdout: a.stdout.split('\n').slice(-6) }),
      });

      // A REAÇÃO, e ela é do BANCO: `stale_claim`. O fixture usou o token
      // CAPTURADO no claim, não `lease.token` — então o que recusou foi o
      // `WHERE claim_token = …` de `turnWriteConditions`, e não um guard em
      // memória do processo zumbi.
      expect(escrita).toMatchObject({
        operacao: 'markRunning',
        ok: false,
        conflict: 'stale_claim',
      });

      // E a linha NÃO se moveu desde o takeover.
      const depois = await oracle.coletar();
      expect(
        verificarFenceDeTokenDeposto(depois, {
          turn_id,
          claim_token: pa.claim_token as string,
          state_version_no_takeover: noTakeover.state_version,
        }),
      ).toEqual([]);

      await estavelDurante(
        async () => {
          const l = await linhaDoTurno(turn_id);
          return { claim_token: l.claim_token, dono: l.claimed_by, versao: l.state_version };
        },
        {
          label: 'o zumbi não move a linha depois de voltar',
          janelaMs: 1_500,
          justificativa:
            'a invariante é NEGATIVA ("nada mudou"); não há evento de gravação que não aconteceu',
        },
      );

      await oracle.assertInvariantes('FI-06/FI-07');
    },
    180_000,
  );
});

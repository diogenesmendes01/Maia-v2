/**
 * Issue #510 (fatia F) — FI-15 e FI-16: as DUAS janelas de crash em volta do
 * commit do outbox, com réplicas que são PROCESSOS e falhas que são SINAIS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que estes dois cenários provam, e por que nenhum deles é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * O antídoto contra o vácuo é o mesmo das fatias B e C: **a reação do sistema é
 * observada positivamente**, e **existe um caso de controle em que ela não
 * deveria acontecer**.
 *
 *   FI-15 — falha: `SIGKILL` no dono com a resposta JÁ CONSTRUÍDA e o commit
 *           ainda não feito.
 *           reação provada: NENHUMA linha do outbox nasce — e a ausência é
 *           observada por uma JANELA (`estavelDurante`), não por uma foto. Sem
 *           linha durável não existe nada que qualquer worker de entrega possa
 *           reivindicar: o `SIGKILL` acontece antes de a saída existir.
 *           Depois do vencimento da lease, o sucessor assume e commita: UMA
 *           linha, `inserted: true`.
 *           controle: o MESMO sucessor commita a MESMA saída lógica uma
 *           segunda vez (mesmo texto, mesma `sequence_in_turn` ⇒ mesma
 *           `logical_dedupe_key`) e recebe `inserted: false`, com a contagem
 *           ainda em UMA linha. Sem esse controle, "existe uma linha" também
 *           passaria num sistema em que a segunda tentativa não aconteceu.
 *
 *   FI-16 — falha: `SIGKILL` DEPOIS do commit e ANTES de o artefato chegar ao
 *           transporte.
 *           reação provada: a linha fica `pending`, sem job e sem dono; a
 *           varredura de recuperação de produção a rearma num job de id
 *           DETERMINÍSTICO; o ciclo de entrega real a reivindica e produz UM
 *           efeito no ledger de um provider que vive em OUTRO processo.
 *           controle: ANTES da varredura, o ledger fica em ZERO por uma janela
 *           inteira — ninguém entrega uma linha que ninguém sabe que existe. E
 *           DEPOIS da entrega, uma SEGUNDA varredura não produz um segundo
 *           efeito. As duas pontas são o que separa "entregue uma vez" de
 *           "entregue porque o teste mandou entregar".
 *
 * ═══ Onde o gate mora, e por que ele NÃO está em `src/` ════════════════════
 *
 * `after_response_built_before_outbox_commit` e
 * `after_outbox_commit_before_delivery_enqueue` são pontos do CHAMADOR: a
 * resposta é construída, e só então `commitOutboundIntent` é chamada; a linha é
 * commitada, e só então o artefato vira trabalho para o transporte. O gate fica
 * entre duas chamadas de produção, dentro de `fixtures/replica-de-commit.ts` —
 * a mesma construção de FI-04/05 (`acquireTurnLease` + `markRunning`) e de
 * FI-17/18 (`beginInlineDelivery` + `recordInlineDelivery`). Nenhum arquivo de
 * `src/` foi tocado, e o teste arquitetural que varre `src/` atrás dos nomes do
 * catálogo continua valendo.
 *
 * ═══ Nenhum `sleep` sincroniza nada ════════════════════════════════════════
 *
 * A parada é um GATE com resposta HTTP diferida; a espera é `eventually`; a
 * ausência é `estavelDurante` com justificativa. O único lugar em que o tempo
 * aparece como grandeza é o vencimento da lease — lido do relógio do BANCO.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import IORedis from 'ioredis';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante, eventually } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import { FakeChannelProvider } from '../fakes/fake-channel-provider.js';
import { InvariantOracle } from '../oracles/invariant-oracle.js';
import { linhasDe, prontidaoDe, CARREGADOR_TSX } from './_util-cenario.js';
// O id do job vem da PRODUÇÃO: um id recalculado aqui deixaria o cenário verde
// depois de alguém trocar a derivação, que é justamente a garantia de "um job
// por linha" que FI-16 mede.
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
const FIXTURE_COMMIT = resolve(AQUI, '..', 'fixtures', 'replica-de-commit.ts');
const FIXTURE_VARREDURA = resolve(AQUI, '..', 'fixtures', 'replica-de-varredura.ts');
const FIXTURE_ENTREGA = resolve(AQUI, '..', 'fixtures', 'replica-de-entrega.ts');

/** TTL da lease do TURNO nestes cenários. Ver o comentário de TTL da fatia B. */
const TTL_MS = 6_000;
const BATIDA_MS = 1_500;
/** TTL da lease de ENTREGA. */
const LEASE_ENTREGA_MS = 6_000;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let provider: FakeChannelProvider;
let artefatos: ArtifactCollector;
let redis: IORedis;

/**
 * UM par (tenant, agent) POR CENÁRIO, e isso não é higiene: a varredura de
 * recuperação varre um ESCOPO inteiro, então a linha que FI-15 deixa
 * comprometida entraria no lote de FI-16 e o `rearmed` deixaria de ser sobre o
 * artefato órfão deste cenário. O ambiente já semeia dois tenants nomeados —
 * são estes.
 */
interface Escopo {
  tenant_id: string;
  agent_id: string;
}
let ESCOPO_A: Escopo;
let ESCOPO_B: Escopo;

interface Alvo {
  turn_id: string;
  conversa_id: string;
  mensagem_id: string;
}

interface LinhaDeSaida {
  id: string;
  status: string;
  attempt: number;
  claim_token: string | null;
  delivery_outcome: string | null;
  logical_dedupe_key: string;
  provider_idempotency_key: string;
  payload_hash: string;
}

/**
 * Cria a cadeia REAL até o turno `received`.
 *
 * A cadeia inteira existe porque `audit_log.conversa_id` tem FK para
 * `conversas` e a auditoria do commit vive na MESMA transação do `UPDATE`: um
 * `conversa_id` inventado faria o commit ser revertido pelo caminho
 * fail-closed, e o cenário mediria a FK em vez da janela de crash.
 */
async function turnoNovo(e: Escopo): Promise<Alvo> {
  const TENANT = e.tenant_id;
  const AGENTE = e.agent_id;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'Sonda 510F', $3, 'dono', 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, `+5511${String(Date.now()).slice(-9)}`],
  );
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status)
     VALUES ($1, $2, $3, 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, p.rows[0]!.id],
  );
  const conversa_id = c.rows[0]!.id;
  const m = await pool.query<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, 'in', 'texto', 'x', '{}'::jsonb, NULL) RETURNING id::text AS id`,
    [TENANT, AGENTE, conversa_id],
  );
  const mensagem_id = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, conversa_id, status)
     VALUES ($1, $2, $3, $4, 'received') RETURNING id::text AS id`,
    [TENANT, AGENTE, mensagem_id, conversa_id],
  );
  return { turn_id: t.rows[0]!.id, conversa_id, mensagem_id };
}

/** Todas as saídas durável do turno. `[]` quando nenhuma existe. */
async function saidasDoTurno(turn_id: string): Promise<LinhaDeSaida[]> {
  const r = await pool.query<LinhaDeSaida>(
    `SELECT id::text AS id, status, attempt::int AS attempt, claim_token::text AS claim_token,
            delivery_outcome, logical_dedupe_key, provider_idempotency_key, payload_hash
       FROM outbound_messages WHERE turn_id = $1 ORDER BY created_at`,
    [turn_id],
  );
  return r.rows;
}

async function statusDoTurno(turn_id: string): Promise<{ status: string; lease: Date | null }> {
  const r = await pool.query<{ status: string; lease_expires_at: Date | null }>(
    'SELECT status, lease_expires_at FROM agent_turns WHERE id = $1',
    [turn_id],
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`turno ${turn_id} sumiu do banco`);
  return { status: linha.status, lease: linha.lease_expires_at };
}

/** O relógio é o do BANCO — o do processo de teste não decide prazo nenhum. */
async function jaVenceu(prazo: Date | null): Promise<boolean> {
  if (!prazo) return true;
  const r = await pool.query<{ v: boolean }>('SELECT $1::timestamptz <= now() AS v', [prazo]);
  return r.rows[0]?.v === true;
}

/**
 * O job de entrega existe no Redis?
 *
 * Inspeção por CHAVE e não por API da BullMQ: o que se quer afirmar é "o
 * transporte tem UM trabalho armado para esta linha", e a chave
 * `bull:outbound-delivery:<jobId>` é a forma durável desse fato. O id vem de
 * `outboundDeliveryJobId` (produção) sobre um `outbound_id` UUID — ele é único
 * por rodada, então nenhuma outra árvore compartilhando este Redis é tocada
 * nem observada.
 */
async function jobDeEntrega(outbound_id: string): Promise<{ existe: boolean; naFila: number }> {
  const jobId = outboundDeliveryJobId(outbound_id);
  const existe = (await redis.exists(`bull:outbound-delivery:${jobId}`)) === 1;
  const fila = await redis.lrange('bull:outbound-delivery:wait', 0, -1);
  return { existe, naFila: fila.filter((x) => x === jobId).length };
}

/** Remove SÓ os jobs desta rodada. Nunca uma varredura por prefixo de fila. */
async function limparJobs(ids: readonly string[]): Promise<void> {
  for (const outbound_id of ids) {
    const jobId = outboundDeliveryJobId(outbound_id);
    await redis.lrem('bull:outbound-delivery:wait', 0, jobId).catch(() => 0);
    await redis.del(`bull:outbound-delivery:${jobId}`).catch(() => 0);
  }
}

function envComum(e: Escopo): Record<string, string | undefined> {
  return {
    ...env.envDoFilho(),
    ...servidor.envDoFilho(),
    // Acrescentado, não substituído: o que o worker do vitest já pediu
    // continua valendo para o filho.
    NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
    TEST_FI_TENANT_ID: e.tenant_id,
    TEST_FI_AGENT_ID: e.agent_id,
  };
}

function subirCommit(
  e: Escopo,
  label: string,
  alvo: Alvo,
  extra: Readonly<Record<string, string>> = {},
): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE_COMMIT,
    cwd: RAIZ,
    env: {
      ...envComum(e),
      TURN_LEASE_TTL_MS: String(TTL_MS),
      TURN_LEASE_HEARTBEAT_MS: String(BATIDA_MS),
      TEST_FI_TURN_ID: alvo.turn_id,
      TEST_FI_CONVERSA_ID: alvo.conversa_id,
      TEST_FI_IN_REPLY_TO: alvo.mensagem_id,
      ...extra,
    },
    readyTimeoutMs: 45_000,
  });
}

function subirVarredura(
  e: Escopo,
  label: string,
  extra: Readonly<Record<string, string>> = {},
): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE_VARREDURA,
    cwd: RAIZ,
    env: {
      ...envComum(e),
      // A varredura é o produtor da fila de entrega; ligar as duas flags é o
      // regime que a regra cross-field de `src/config/rules.ts` exige (o
      // consumidor precede o produtor).
      FEATURE_OUTBOUND_RECOVERY: 'true',
      FEATURE_OUTBOUND_DELIVERY_WORKER: 'true',
      ...extra,
    },
    readyTimeoutMs: 60_000,
  });
}

function subirEntrega(
  e: Escopo,
  label: string,
  alvo: { outbound_id: string; idempotency_key: string; payload_hash: string },
): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE_ENTREGA,
    cwd: RAIZ,
    env: {
      ...envComum(e),
      TEST_FI_OUTBOUND_ID: alvo.outbound_id,
      TEST_FI_IDEMPOTENCY_KEY: alvo.idempotency_key,
      TEST_FI_PAYLOAD_HASH: alvo.payload_hash,
      TEST_FI_PROVIDER_URL: provider.baseUrl,
      TEST_FI_LEASE_MS: String(LEASE_ENTREGA_MS),
    },
    readyTimeoutMs: 45_000,
  });
}

d('#510 FI-15/FI-16 — as duas janelas de crash em volta do commit do outbox', () => {
  const criados: string[] = [];

  beforeAll(async () => {
    env = await ReliabilityEnvironment.criar({ suite: 'fi-outbox-commit' });
    ESCOPO_A = {
      tenant_id: env.estado.tenants[0]!.tenantId,
      agent_id: env.estado.tenants[0]!.agentId,
    };
    ESCOPO_B = {
      tenant_id: env.estado.tenants[1]!.tenantId,
      agent_id: env.estado.tenants[1]!.agentId,
    };
    pool = new pg.Pool({ connectionString: env.estado.databaseUrl });
    redis = new IORedis(env.estado.redisUrl, { maxRetriesPerRequest: 2 });
  }, 300_000);

  afterAll(async () => {
    await limparJobs(criados).catch(() => undefined);
    redis?.disconnect();
    await pool?.end();
    await env?.derrubar();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-outbox-commit', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
    provider = await FakeChannelProvider.iniciar(sup, { label: 'provider' });
  });

  afterEach(async (ctx) => {
    await sup.dispose();
    await servidor.fechar();
    if (ctx.task.result?.state === 'fail') {
      console.error(`[#510] artefato do cenário: ${artefatos.escrever()}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FI-15
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-15 — SIGKILL com a resposta pronta e o outbox ainda vazio: o retry cria UMA saída',
    async () => {
      const alvo = await turnoNovo(ESCOPO_A);
      const oracle = new InvariantOracle({ pool, escopo: [ESCOPO_A], turnIds: [alvo.turn_id] });

      servidor.arm('after_response_built_before_outbox_commit', 'pause');
      const morto = subirCommit(ESCOPO_A, 'commit-morto', alvo);
      const p1 = await prontidaoDe(morto);
      expect(p1.acquired, `o dono não conseguiu o claim: ${JSON.stringify(p1)}`).toBe(true);

      // O anúncio traz os IDs — o cenário CONFERE o estágio antes de agir.
      const evento = await servidor.waitForReached('after_response_built_before_outbox_commit', {
        timeoutMs: 30_000,
      });
      expect(evento.context).toMatchObject({ turn_id: alvo.turn_id, attempt: 1 });
      await servidor.esperarParadoEm('after_response_built_before_outbox_commit', 1);

      // ── O SUCESSOR SOBE ANTES DO CRASH, e essa ordem é o que torna o
      //    controle DETERMINÍSTICO.
      //
      // A ordem óbvia — matar e só então subir o sucessor — faz o controle
      // ("antes do prazo ele é RECUSADO") depender de o import a frio do grafo
      // de produção caber dentro do TTL da lease. Ele custa de 1.9s a 6.8s
      // (`AGENTS.md` §7.1), o TTL aqui é 6s, e o cenário reprovou em 4 de 5
      // rodadas seguidas justamente assim: o sucessor terminava de importar
      // depois do vencimento e entrava na PRIMEIRA tentativa, sem nunca ter
      // sido barrado. Subir antes tira o relógio do caminho: ele é recusado
      // ENQUANTO o dono está vivo, e as recusas são observadas antes de o
      // `SIGKILL` acontecer.
      servidor.disarm('after_response_built_before_outbox_commit');
      const sucessor = subirCommit(ESCOPO_A, 'commit-sucessor', alvo, {
        TEST_FI_TENTATIVAS: '200',
        TEST_FI_INTERVALO_MS: '250',
        TEST_FI_COMMITS: '2',
      });

      // O CONTROLE DE PRAZO, observado com o dono AINDA VIVO: a lease dele
      // barra o sucessor. Sem isto, "o sucessor assumiu" também passaria num
      // sistema sem lease nenhuma.
      const recusas = await eventually(
        () => {
          const tentativas = linhasDe(sucessor, '##fi-claim##').filter(
            (t) => t.result !== 'acquired',
          );
          return tentativas.length >= 2 ? tentativas : undefined;
        },
        {
          label: 'o sucessor é RECUSADO enquanto o dono vivo segura a lease',
          timeoutMs: 60_000,
          abortSignal: sup.sinalDeFalha,
          describeState: () => ({ stdout: sucessor.stdout.split('\n').slice(-8) }),
        },
      );
      for (const r of recusas) expect(r.result).toBe('not_eligible');

      // A FALHA: `SIGKILL` num processo PARADO com a resposta construída e o
      // banco ainda sem saber dela.
      sup.hardKill(morto);
      expect((await morto.esperarSaida(10_000)).signal).toBe('SIGKILL');

      // ── A REAÇÃO, e ela é NEGATIVA: nenhuma saída nasceu. Uma foto
      //    instantânea passaria também no caso em que o INSERT ainda estava em
      //    voo — a janela é o único observável honesto para "não aconteceu".
      await estavelDurante(async () => (await saidasDoTurno(alvo.turn_id)).length, {
        label: 'nenhuma linha do outbox existe depois do crash pré-commit',
        janelaMs: 1_500,
        intervalMs: 100,
        justificativa:
          'a invariante é NEGATIVA ("a saída não foi comprometida"); não existe evento de ' +
          'INSERT que não aconteceu, e sem linha durável não há nada que um worker de ' +
          'entrega possa reivindicar — o envio é estruturalmente impossível.',
      });
      expect(await saidasDoTurno(alvo.turn_id)).toHaveLength(0);
      // O turno ficou como o morto o deixou: `running`, com a lease dele.
      expect((await statusDoTurno(alvo.turn_id)).status).toBe('running');
      expect(await jaVenceu((await statusDoTurno(alvo.turn_id)).lease)).toBe(false);

      // ── E ENTÃO o sucessor assume — depois do vencimento, decidido pelo
      //    BANCO. Ele commita a MESMA saída lógica DUAS vezes
      //    (`TEST_FI_COMMITS=2`); a segunda é o caso de controle.
      const p2 = await prontidaoDe(sucessor, 90_000);
      expect(p2.acquired, `o sucessor nunca assumiu: ${JSON.stringify(p2)}`).toBe(true);

      const commits = await eventually(
        () => {
          const linhas = linhasDe(sucessor, '##fi-commit##');
          return linhas.length >= 2 ? linhas : undefined;
        },
        {
          label: 'o sucessor commita a mesma saída lógica duas vezes',
          timeoutMs: 30_000,
          // O sinal do supervisor ABORTA a espera no instante em que o filho
          // morre sem permissão — em vez de queimar o prazo inteiro esperando
          // por uma linha que ninguém mais vai imprimir. É o caminho pelo qual
          // um commit que EXPLODE (chave não determinística, unique de posição)
          // vira um vermelho que nomeia o filho morto.
          abortSignal: sup.sinalDeFalha,
          describeState: () => ({ stdout: sucessor.stdout.split('\n').slice(-8) }),
        },
      );

      // A REAÇÃO POSITIVA: a primeira commitou de verdade…
      expect(commits[0]).toMatchObject({ committed: true, inserted: true });
      // …e o CONTROLE: a segunda encontrou a saída lógica JÁ comprometida.
      expect(commits[1]).toMatchObject({ committed: true, inserted: false });
      expect(commits[1]!.outbound_id).toBe(commits[0]!.outbound_id);

      // UMA linha, e a `logical_dedupe_key` é o mecanismo que a manteve única.
      const saidas = await saidasDoTurno(alvo.turn_id);
      expect(saidas, `duas tentativas produziram ${saidas.length} linhas`).toHaveLength(1);
      criados.push(saidas[0]!.id);
      expect(saidas[0]!.id).toBe(commits[0]!.outbound_id);
      // E ninguém tentou entregar nada: a linha nasceu agora, sem dono e sem
      // desfecho. É a forma observável de "nenhum send".
      expect(saidas[0]!.attempt).toBe(0);
      expect(saidas[0]!.claim_token).toBeNull();
      expect(saidas[0]!.delivery_outcome).toBeNull();

      expect((await statusDoTurno(alvo.turn_id)).status).toBe('outbound_pending');
      await oracle.assertInvariantes('FI-15');
    },
    180_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-16
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-16 — SIGKILL depois do commit e antes do transporte: a varredura recupera e entrega UMA vez',
    async () => {
      const alvo = await turnoNovo(ESCOPO_B);
      await provider.roteirizar([{ kind: 'accept' }, { kind: 'accept' }]);
      const oracle = new InvariantOracle({ pool, escopo: [ESCOPO_B], turnIds: [alvo.turn_id] });

      // O gate fica DEPOIS do commit e ANTES de o artefato virar trabalho.
      servidor.arm('after_outbox_commit_before_delivery_enqueue', 'pause');
      const morto = subirCommit(ESCOPO_B, 'commit-morto', alvo, { TEST_FI_ENFILEIRAR: 'sim' });
      expect((await prontidaoDe(morto)).acquired).toBe(true);

      const evento = await servidor.waitForReached('after_outbox_commit_before_delivery_enqueue', {
        timeoutMs: 30_000,
      });
      expect(evento.context).toMatchObject({ turn_id: alvo.turn_id });
      await servidor.esperarParadoEm('after_outbox_commit_before_delivery_enqueue', 1);

      // A linha DURÁVEL já existe — é o que distingue FI-16 de FI-15.
      const antes = await saidasDoTurno(alvo.turn_id);
      expect(antes).toHaveLength(1);
      const outbound_id = antes[0]!.id;
      criados.push(outbound_id);
      expect(antes[0]!.status).toBe('pending');

      // A FALHA: o processo morre com o artefato durável e NINGUÉM sabendo.
      sup.hardKill(morto);
      expect((await morto.esperarSaida(10_000)).signal).toBe('SIGKILL');

      // ── O CONTROLE, e ele vem PRIMEIRO de propósito: enquanto ninguém varre,
      //    NADA acontece. Sem esta janela, "a varredura recuperou" também
      //    passaria num sistema em que outra coisa qualquer entregou a linha.
      expect(await jobDeEntrega(outbound_id)).toEqual({ existe: false, naFila: 0 });
      await estavelDurante(
        async () => {
          const l = (await saidasDoTurno(alvo.turn_id))[0]!;
          return {
            chamadas: (await provider.ledger()).physical_call_total,
            status: l.status,
            attempt: l.attempt,
          };
        },
        {
          label: 'sem varredura, o artefato órfão não é entregue nem tocado',
          janelaMs: 1_500,
          intervalMs: 100,
          justificativa:
            'a invariante é NEGATIVA ("ninguém entrega o que ninguém sabe que existe"); ' +
            'não há evento de "não entreguei" para esperar.',
        },
      );

      // ── A RECUPERAÇÃO, pelo caminho de produção.
      servidor.disarm('after_outbox_commit_before_delivery_enqueue');
      const varredura = subirVarredura(ESCOPO_B, 'varredura');
      const stats = (await prontidaoDe(varredura)) as unknown as {
        rodadas: Array<{ rearmed: number }>;
      };
      expect(stats.rodadas[0]!.rearmed, 'a varredura não rearmou o artefato órfão').toBe(1);

      // O artefato virou trabalho: UM job, com o id determinístico da produção.
      expect(await jobDeEntrega(outbound_id)).toEqual({ existe: true, naFila: 1 });

      // ── A ENTREGA, pelo ciclo real (`beginInlineDelivery`/`recordInlineDelivery`).
      const entrega = subirEntrega(ESCOPO_B, 'entrega', {
        outbound_id,
        idempotency_key: antes[0]!.provider_idempotency_key,
        payload_hash: antes[0]!.payload_hash,
      });
      const pe = await prontidaoDe(entrega);
      expect(pe.acquired, `a entrega não reivindicou a linha: ${JSON.stringify(pe)}`).toBe(true);

      await eventually(
        async () => (await saidasDoTurno(alvo.turn_id))[0]!.delivery_outcome !== null,
        {
          timeoutMs: 30_000,
          label: 'o desfecho da entrega é persistido',
          abortSignal: sup.sinalDeFalha,
        },
      );
      const depois = (await saidasDoTurno(alvo.turn_id))[0]!;
      expect(depois.delivery_outcome).toBe('accepted_confirmed');
      expect(depois.status).toBe('delivered');

      // UM efeito, no ledger de um processo que sobreviveu ao `SIGKILL`.
      const ledger = await provider.ledger();
      expect(ledger.physical_call_total).toBe(1);
      expect(ledger.logical_effect_total).toBe(1);

      // ── O SEGUNDO CONTROLE: uma varredura NOVA sobre a linha já entregue não
      //    produz um segundo efeito. "Entregue uma vez" atravessa o tick
      //    seguinte, que é quando um rearme cego duplicaria a mensagem.
      const varredura2 = subirVarredura(ESCOPO_B, 'varredura-2');
      await prontidaoDe(varredura2);
      await estavelDurante(async () => (await provider.ledger()).physical_call_total, {
        label: 'a segunda varredura não produz um segundo envio',
        janelaMs: 2_000,
        intervalMs: 100,
        justificativa:
          'é uma afirmação negativa sobre um efeito EXTERNO; a janela é o único observável ' +
          'honesto, e é ela que fica vermelha se o rearme voltar a tocar uma linha entregue.',
      });

      expect(await saidasDoTurno(alvo.turn_id)).toHaveLength(1);
      await oracle.assertInvariantes('FI-16');
    },
    240_000,
  );
});

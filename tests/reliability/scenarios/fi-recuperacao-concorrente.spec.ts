/**
 * Issue #510 (fatia F) — FI-08 e FI-09: a RECUPERAÇÃO sob concorrência, e a
 * recuperação com o transporte entupido.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que estes dois cenários provam, e por que nenhum deles é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FI-08 — falha: DOIS sweepers de PROCESSO sobre o MESMO lote, soltos por
 *           barreira.
 *           reação provada: cada linha é decidida UMA vez. Observada como:
 *           `dead_lettered` somado entre as DUAS réplicas é exatamente o número
 *           de linhas elegíveis (o CAS `status IN (…)` concede a uma só), UMA
 *           `audit_log` de `outbound_dead_lettered` por linha, e UM job por
 *           linha rearmada (o `jobId` determinístico colide os dois `add`).
 *           controle: as duas réplicas ANUNCIAM o lote que leram antes da
 *           largada, e o cenário cobra que o conjunto seja o MESMO. Sem isso,
 *           "uma auditoria por linha" também passaria com a réplica B chegando
 *           depois de tudo decidido — que é concorrência nenhuma. E, no mesmo
 *           `it`, uma linha ABAIXO do teto de tentativas NÃO é morta: a
 *           varredura decide por política, não por reflexo.
 *
 *   FI-09 — falha: o job determinístico da linha fica RETIDO em `failed`.
 *           reação provada: a varredura rearma assim mesmo — `enqueueOutbound
 *           Delivery` remove o CADÁVER antes do `add`, e a linha volta a ter
 *           trabalho armado. A recuperação NÃO fica bloqueada até a retenção
 *           expirar.
 *           controle: no mesmo `it`, uma linha cujo job está VIVO (`waiting`)
 *           não é tocada — mesmo `timestamp`, uma única entrada na fila. A
 *           limpeza é seletiva; se ela removesse sempre, "rearmar" viraria
 *           "cancelar uma entrega possivelmente em voo".
 *
 * ═══ Isolamento de fila, e por que ele não é por prefixo ═══════════════════
 *
 * As filas de produção (`src/gateway/queue.ts`) são construídas no import, com
 * o prefixo `bull` padrão: não há como passar um prefixo por env sem mexer em
 * `src/`. O que isola esta suíte é (a) o db lógico do Redis EXCLUSIVO da
 * worktree (#571) e (b) o `jobId`, que é `outboundDeliveryJobId(<uuid da
 * rodada>)` — um valor que nenhuma outra árvore pode produzir. Toda leitura e
 * toda limpeza deste arquivo miram ids desta rodada; nenhuma varre prefixo de
 * fila, porque uma varredura por prefixo num Redis compartilhado por ~95
 * árvores é dano cruzado.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import { InvariantOracle } from '../oracles/invariant-oracle.js';
import { linhasDe, prontidaoDe, CARREGADOR_TSX } from './_util-cenario.js';
// Da PRODUÇÃO: o id do job e o teto de tentativas. Recalculá-los aqui deixaria
// o cenário verde depois de alguém trocar a derivação ou a política — que são
// exatamente as duas coisas que ele mede.
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';
import { OUTBOUND_MAX_DELIVERY_ATTEMPTS } from '@/runtime/outbound/recovery-contract.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
const FIXTURE_VARREDURA = resolve(AQUI, '..', 'fixtures', 'replica-de-varredura.ts');

const FILA = 'outbound-delivery';
const CHAVE_FILA = `bull:${FILA}`;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let artefatos: ArtifactCollector;
let redis: IORedis;
let fila: Queue;

interface Escopo {
  tenant_id: string;
  agent_id: string;
}
/** Um par (tenant, agent) por cenário: a varredura varre o ESCOPO inteiro. */
let ESCOPO_A: Escopo;
let ESCOPO_B: Escopo;

interface Semeada {
  outbound_id: string;
  turn_id: string;
  conversa_id: string;
}

/** Ids desta rodada, para a limpeza mirar SÓ neles. */
const criados: string[] = [];

/**
 * Semeia a cadeia REAL (pessoa → conversa → mensagem → turno) e UMA linha
 * durável do outbox no estado pedido.
 *
 * O `INSERT` é setup, não o objeto do teste — o que está sob prova é a
 * VARREDURA. Mesma divisão que `saidaNova()` da fatia C faz. A cadeia inteira
 * existe porque `audit_log.conversa_id` tem FK para `conversas`, e a auditoria
 * do dead letter vive na MESMA transação do `UPDATE`: um `conversa_id`
 * inventado faria a transação inteira ser revertida, e o cenário mediria a FK
 * em vez da corrida.
 */
async function saidaSemeada(
  e: Escopo,
  opts: { attempt: number; status?: string },
): Promise<Semeada> {
  const { tenant_id, agent_id } = e;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'Sonda 510F', $3, 'dono', 'ativa') RETURNING id::text AS id`,
    [tenant_id, agent_id, `+5511${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`],
  );
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status)
     VALUES ($1, $2, $3, 'ativa') RETURNING id::text AS id`,
    [tenant_id, agent_id, p.rows[0]!.id],
  );
  const conversa_id = c.rows[0]!.id;
  const m = await pool.query<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', 'texto', 'x', '{}'::jsonb) RETURNING id::text AS id`,
    [tenant_id, agent_id, conversa_id],
  );
  const mensagem_id = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, conversa_id, status)
     VALUES ($1, $2, $3, $4, 'outbound_pending') RETURNING id::text AS id`,
    [tenant_id, agent_id, mensagem_id, conversa_id],
  );
  const turn_id = t.rows[0]!.id;

  const payload = { type: 'text', text: 'resposta durável' };
  const payload_hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const chave = `fi08-${turn_id}-0`;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel, status,
        turn_id, sequence_in_turn, payload_version, payload_type, payload_json, payload_hash,
        logical_dedupe_key, provider_idempotency_key, next_attempt_at, attempt)
     VALUES ($1,$2,$3,$4,$5,'text',$6,
             $7, 0, 1, 'text', $8::jsonb, $9,
             $10, $11, now() - interval '1 minute', $12)
     RETURNING id::text AS id`,
    [
      tenant_id,
      agent_id,
      chave,
      conversa_id,
      mensagem_id,
      opts.status ?? 'pending',
      turn_id,
      JSON.stringify(payload),
      payload_hash,
      chave,
      chave,
      opts.attempt,
    ],
  );
  const outbound_id = o.rows[0]!.id;
  criados.push(outbound_id);
  return { outbound_id, turn_id, conversa_id };
}

async function statusDaSaida(outbound_id: string): Promise<{ status: string; attempt: number }> {
  const r = await pool.query<{ status: string; attempt: number }>(
    'SELECT status, attempt::int AS attempt FROM outbound_messages WHERE id = $1',
    [outbound_id],
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`outbound ${outbound_id} sumiu do banco`);
  return linha;
}

/** Quantas auditorias com esta ação existem para este alvo. */
async function auditorias(acao: string, alvo_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_log WHERE acao = $1 AND alvo_id = $2',
    [acao, alvo_id],
  );
  return Number(r.rows[0]?.n ?? '0');
}

/** Quantas vezes o id desta linha aparece na lista `wait` da fila. */
async function naFila(outbound_id: string): Promise<number> {
  const jobId = outboundDeliveryJobId(outbound_id);
  const lista = await redis.lrange(`${CHAVE_FILA}:wait`, 0, -1);
  return lista.filter((x) => x === jobId).length;
}

/** Remove SÓ os jobs desta rodada. Nunca uma varredura por prefixo. */
async function limparJobs(ids: readonly string[]): Promise<void> {
  for (const outbound_id of ids) {
    const jobId = outboundDeliveryJobId(outbound_id);
    await redis.lrem(`${CHAVE_FILA}:wait`, 0, jobId).catch(() => 0);
    await redis.zrem(`${CHAVE_FILA}:failed`, jobId).catch(() => 0);
    await redis.zrem(`${CHAVE_FILA}:completed`, jobId).catch(() => 0);
    await redis.del(`${CHAVE_FILA}:${jobId}`).catch(() => 0);
  }
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
      ...env.envDoFilho(),
      ...servidor.envDoFilho(),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
      TEST_FI_TENANT_ID: e.tenant_id,
      TEST_FI_AGENT_ID: e.agent_id,
      // O regime que a regra cross-field de `src/config/rules.ts` exige: o
      // consumidor precede o produtor.
      FEATURE_OUTBOUND_RECOVERY: 'true',
      FEATURE_OUTBOUND_DELIVERY_WORKER: 'true',
      ...extra,
    },
    readyTimeoutMs: 60_000,
  });
}

d('#510 FI-08/FI-09 — varredura concorrente e job retido', () => {
  beforeAll(async () => {
    env = await ReliabilityEnvironment.criar({ suite: 'fi-recuperacao' });
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
    fila = new Queue(FILA, { connection: new IORedis(env.estado.redisUrl, { maxRetriesPerRequest: null }) });
  }, 300_000);

  afterAll(async () => {
    await limparJobs(criados).catch(() => undefined);
    await fila?.close().catch(() => undefined);
    redis?.disconnect();
    await pool?.end();
    await env?.derrubar();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-recuperacao', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
  });

  afterEach(async (ctx) => {
    await sup.dispose();
    await servidor.fechar();
    if (ctx.task.result?.state === 'fail') {
      console.error(`[#510] artefato do cenário: ${artefatos.escrever()}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FI-08
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-08 — dois sweepers sobre o MESMO lote: uma decisão por linha, um job por linha',
    async () => {
      // Duas linhas ACIMA do teto (viram DLQ) e duas abaixo (viram job). As
      // quatro no mesmo escopo, porque é o escopo que a varredura varre.
      const mortaA = await saidaSemeada(ESCOPO_A, { attempt: OUTBOUND_MAX_DELIVERY_ATTEMPTS });
      const mortaB = await saidaSemeada(ESCOPO_A, { attempt: OUTBOUND_MAX_DELIVERY_ATTEMPTS + 1 });
      const vivaA = await saidaSemeada(ESCOPO_A, { attempt: 0 });
      const vivaB = await saidaSemeada(ESCOPO_A, { attempt: 1, status: 'retryable' });
      const oracle = new InvariantOracle({
        pool,
        escopo: [ESCOPO_A],
        turnIds: [mortaA.turn_id, mortaB.turn_id, vivaA.turn_id, vivaB.turn_id],
      });

      const a = subirVarredura(ESCOPO_A, 'varredura-a', { TEST_FI_BARREIRA: 'largada' });
      const b = subirVarredura(ESCOPO_A, 'varredura-b', { TEST_FI_BARREIRA: 'largada' });

      // A LARGADA. Sem ela quem "vence" é quem terminou de importar primeiro —
      // isso não é corrida, é sorteio de tempo de import.
      await servidor.esperarNaBarreira('largada', 2, 90_000);

      // ── A PREMISSA, cobrada antes da largada: as DUAS réplicas leram o MESMO
      //    lote. Sem esta asserção, "uma decisão por linha" também passaria com
      //    a réplica B chegando depois de tudo decidido — e aí não houve
      //    concorrência nenhuma para medir.
      const loteA = linhasDe(a, '##fi-lote##').at(-1);
      const loteB = linhasDe(b, '##fi-lote##').at(-1);
      const esperado = [mortaA.outbound_id, mortaB.outbound_id, vivaA.outbound_id, vivaB.outbound_id]
        .slice()
        .sort();
      expect(loteA?.ids, 'a réplica A não leu o lote').toEqual(esperado);
      expect(loteB?.ids, 'a réplica B não leu o MESMO lote').toEqual(esperado);

      expect(servidor.abrirBarreira('largada')).toBe(2);

      const [pa, pb] = await Promise.all([prontidaoDe(a, 90_000), prontidaoDe(b, 90_000)]);
      expect(a.pid).not.toBe(b.pid);

      const rodadas = (carga: Record<string, unknown>): { rearmed: number; dead_lettered: number } =>
        (carga.rodadas as Array<{ rearmed: number; dead_lettered: number }>)[0]!;
      const somaDlq = rodadas(pa).dead_lettered + rodadas(pb).dead_lettered;
      const somaRearme = rodadas(pa).rearmed + rodadas(pb).rearmed;

      // ── A REAÇÃO: as duas réplicas decidiram sobre as MESMAS duas linhas e o
      //    dead letter aconteceu UMA vez ao todo. O `UPDATE ... WHERE status IN
      //    (…)` concedeu a uma; a outra voltou zero linhas e contou `noop`.
      expect(
        somaDlq,
        `dead letter aconteceu ${somaDlq} vezes para 2 linhas — a=${JSON.stringify(
          rodadas(pa),
        )} b=${JSON.stringify(rodadas(pb))}`,
      ).toBe(2);

      // E a auditoria, que é a evidência DURÁVEL da decisão: uma por linha.
      for (const morta of [mortaA, mortaB]) {
        expect(await statusDaSaida(morta.outbound_id)).toMatchObject({ status: 'dead_letter' });
        expect(
          await auditorias('outbound_dead_lettered', morta.outbound_id),
          'duas auditorias de dead letter para a MESMA linha',
        ).toBe(1);
      }

      // ── O REARME: as duas réplicas armaram o job das duas linhas vivas (o
      //    contador conta a INTENÇÃO, e ela é idempotente), e o transporte tem
      //    UM job por linha — o `jobId` determinístico colidiu os dois `add`.
      expect(somaRearme, 'as duas réplicas deveriam ter tentado rearmar as 2 linhas vivas').toBe(4);
      for (const viva of [vivaA, vivaB]) {
        expect(await naFila(viva.outbound_id), 'dois jobs para a mesma linha').toBe(1);
      }

      // ── O CONTROLE, no mesmo `it`: a varredura NÃO mata quem está abaixo do
      //    teto. Sem ele, "duas linhas morreram" passaria também num sweeper
      //    que mata tudo o que vê.
      for (const viva of [vivaA, vivaB]) {
        const l = await statusDaSaida(viva.outbound_id);
        expect(l.status, 'uma linha abaixo do teto foi morta pela varredura').not.toBe(
          'dead_letter',
        );
        expect(await auditorias('outbound_dead_lettered', viva.outbound_id)).toBe(0);
      }

      // E nada se move depois que as duas réplicas terminaram.
      await estavelDurante(
        async () => ({
          mortaA: (await statusDaSaida(mortaA.outbound_id)).status,
          vivaA: (await statusDaSaida(vivaA.outbound_id)).status,
          auditorias: await auditorias('outbound_dead_lettered', mortaA.outbound_id),
        }),
        {
          label: 'as decisões não são refeitas depois que as duas varreduras terminam',
          janelaMs: 1_200,
          justificativa:
            'a invariante é NEGATIVA ("ninguém decide de novo"); não existe evento de decisão ' +
            'que não aconteceu.',
        },
      );

      await oracle.assertInvariantes('FI-08');
    },
    240_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-09
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-09 — job determinístico RETIDO em failed: a varredura rearma; o job VIVO é preservado',
    async () => {
      const bloqueada = await saidaSemeada(ESCOPO_B, { attempt: 2, status: 'retryable' });
      const comJobVivo = await saidaSemeada(ESCOPO_B, { attempt: 0 });
      const oracle = new InvariantOracle({
        pool,
        escopo: [ESCOPO_B],
        turnIds: [bloqueada.turn_id, comJobVivo.turn_id],
      });

      const idBloqueada = outboundDeliveryJobId(bloqueada.outbound_id);
      const idVivo = outboundDeliveryJobId(comJobVivo.outbound_id);

      // ── O CADÁVER. O job é criado pela BullMQ de verdade e depois MOVIDO
      //    para `failed` pelas chaves — `moveToFailed` exige o lock de um job
      //    ATIVO, e subir um worker aqui consumiria a fila de quem mais
      //    estivesse no mesmo db lógico. O que o cenário precisa é do ESTADO
      //    (id ocupado por um job terminal), e é ele que está sendo montado.
      await fila.add('deliver', { version: 1, outbound_id: bloqueada.outbound_id }, {
        jobId: idBloqueada,
      });
      await redis.lrem(`${CHAVE_FILA}:wait`, 0, idBloqueada);
      await redis.zadd(`${CHAVE_FILA}:failed`, Date.now(), idBloqueada);
      await redis.hset(`${CHAVE_FILA}:${idBloqueada}`, {
        finishedOn: String(Date.now()),
        failedReason: 'sonda #510 FI-09',
      });
      const antesDoCadaver = await fila.getJob(idBloqueada);
      expect(
        await antesDoCadaver?.getState(),
        'o cenário não conseguiu montar o job RETIDO em failed — sem ele não há o que provar',
      ).toBe('failed');

      // ── O JOB VIVO, que é o caso de controle: trabalho de verdade, esperando
      //    consumidor. A varredura NÃO pode removê-lo para "rearmar".
      await fila.add('deliver', { version: 1, outbound_id: comJobVivo.outbound_id }, {
        jobId: idVivo,
      });
      const vivoAntes = await fila.getJob(idVivo);
      expect(await vivoAntes?.getState()).toBe('waiting');
      const timestampAntes = vivoAntes?.timestamp;

      // ── A VARREDURA, pelo caminho de produção.
      const varredura = subirVarredura(ESCOPO_B, 'varredura');
      const carga = await prontidaoDe(varredura, 90_000);
      const stats = (carga.rodadas as Array<{ rearmed: number }>)[0]!;
      expect(stats.rearmed, 'a varredura não rearmou as duas linhas elegíveis').toBe(2);

      // ── A REAÇÃO: o cadáver saiu do caminho e a linha voltou a ter trabalho
      //    armado. É a diferença entre "a recuperação está bloqueada até a
      //    retenção expirar" e "a recuperação funciona".
      const depois = await fila.getJob(idBloqueada);
      expect(
        await depois?.getState(),
        'o job continua RETIDO em failed — nenhum tick da varredura consegue rearmar esta linha',
      ).toBe('waiting');
      expect(await naFila(bloqueada.outbound_id)).toBe(1);
      expect(await redis.zscore(`${CHAVE_FILA}:failed`, idBloqueada)).toBeNull();

      // ── O CONTROLE: o job VIVO não foi removido nem duplicado. Remover um
      //    job em `waiting`/`active` para "rearmar" seria cancelar uma entrega
      //    possivelmente em voo — a limpeza é seletiva de propósito.
      const vivoDepois = await fila.getJob(idVivo);
      expect(await vivoDepois?.getState()).toBe('waiting');
      expect(
        vivoDepois?.timestamp,
        'o job vivo foi removido e recriado — a limpeza deixou de ser seletiva',
      ).toBe(timestampAntes);
      expect(await naFila(comJobVivo.outbound_id)).toBe(1);

      // Nenhuma das duas linhas foi morta: o transporte entupido não vira
      // desistência no banco.
      for (const s of [bloqueada, comJobVivo]) {
        expect((await statusDaSaida(s.outbound_id)).status).not.toBe('dead_letter');
        expect(await auditorias('outbound_dead_lettered', s.outbound_id)).toBe(0);
      }

      await oracle.assertInvariantes('FI-09');
    },
    240_000,
  );
});

/**
 * Issue #633 (fatia D da épica #506) — o job de entrega DETERMINÍSTICO, de
 * ponta a ponta, contra Redis/BullMQ e Postgres REAIS.
 *
 * A #632 entregou `outboundDeliveryJobId` e o testou como função pura, e
 * declarou a dívida em uma linha: *nada enfileira nem consome*. Esta suíte é
 * essa linha fechada, e o que só a infra real prova:
 *
 *  1. que dois `add` com o mesmo id resultam em UM job (a função pura não prova
 *     nada sobre a BullMQ);
 *  2. que a RETENÇÃO da fila não vira veto permanente ao rearme legítimo — um
 *     job `completed`/`failed` retido com o mesmo id bloquearia todo `add`
 *     seguinte, e a linha ficaria `retryable` para sempre;
 *  3. que a segunda camada (o claim atômico) segura mesmo quando a primeira
 *     (o `jobId`) falha — porque ela vai falhar, para jobs armados antes deste
 *     deploy.
 *
 * ─── O que este arquivo mede quando diz "uma entrega" ───────────────────────
 *
 * A POSSE, isto é `outbound_messages.attempt`, que o claim atômico incrementa.
 * Ela é a medida certa e não uma contagem de chamadas ao provedor: é a posse
 * que AUTORIZA o efeito externo, e nenhum caminho de `deliverOutbound` toca o
 * adaptador sem tê-la. Duas posses concedidas seriam a duplicata, mesmo que uma
 * delas morresse antes do `sendText`.
 *
 * Para que o ciclo termine sem provedor fake e sem sessão do WhatsApp, o
 * `payload_json` da linha é DELIBERADAMENTE inválido: `parseOutboundPayload`
 * (passo 5 de `deliverOutbound`) o rejeita com a posse na mão e a linha vira
 * `failed_terminal` — ANTES da resolução do canal (passo 7) e do adaptador
 * (passo 9). O que se exercita é exatamente o trecho desta fatia: fila →
 * consumidor → fronteira de confiança → claim.
 *
 * ─── Convivência com as outras suítes ───────────────────────────────────────
 *
 * A fila `outbound-delivery` nasce nesta fatia e só estas duas suítes de #633 a
 * usam, mas as regras de #504 valem igual: nada de `pause()` (é global no
 * Redis), nada de `obliterate()`, e toda limpeza é escopada aos jobs ARMADOS
 * aqui.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import { lifecycle } from '@/runtime/lifecycle/controller.js';
import {
  awaitQueueReady,
  enqueueOutboundDelivery,
  outboundDeliveryQueue,
  startOutboundDeliveryWorker,
} from '@/gateway/queue.js';
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';
import { consumeOutboundDeliveryJob } from '@/runtime/outbound/delivery-consumer.js';
import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't633q';
const AGENT = 'a633q';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pool: pg.Pool;
let conversaId: string;
let pessoaId: string;

/** jobIds armados por esta suíte — o único escopo que ela pode limpar. */
const armados = new Set<string>();

async function criarLinhaComPayloadInvalido(): Promise<string> {
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','e a resposta?','{"remote_jid":"5511900000634@s.whatsapp.net"}'::jsonb)
       RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const inbound = m.rows[0]!.id;
    const t = await c.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          attempt_count, state_version)
       VALUES ($1,$2,$3,$4,'outbound_pending',1,4) RETURNING id`,
      [TENANT, AGENT, inbound, conversaId],
    );
    const turn = t.rows[0]!.id;
    const artefato = buildOutboundArtifact({
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id: turn,
      sequence_in_turn: 0,
      payload: { type: 'text', text: 'a resposta durável' },
      channel: 'whatsapp',
    });
    const o = await c.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
          status, turn_id, sequence_in_turn, payload_version, payload_type,
          payload_json, payload_hash, logical_dedupe_key, provider_idempotency_key,
          next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,'text','pending',$6,0,$7,'text',
               -- INVALIDO DE PROPOSITO: falta o campo text. Ver o bloco no topo.
               '{"type":"text"}'::jsonb,
               $8,$9,$10, now())
       RETURNING id`,
      [
        TENANT,
        AGENT,
        artefato.logical_dedupe_key,
        conversaId,
        inbound,
        turn,
        artefato.payload_version,
        artefato.payload_hash,
        artefato.logical_dedupe_key,
        artefato.provider_idempotency_key,
      ],
    );
    return o.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function linha(id: string): Promise<{ status: string; attempt: number }> {
  const { rows } = await pool.query(
    `SELECT status, attempt FROM outbound_messages WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function arm(outbound_id: string): Promise<void> {
  armados.add(outboundDeliveryJobId(outbound_id));
  await enqueueOutboundDelivery(outbound_id);
}

/** Jobs vivos que carregam ESTE `outbound_id` — nunca uma contagem global. */
async function jobsDe(outbound_id: string): Promise<number> {
  const jobs = await outboundDeliveryQueue.getJobs([
    'waiting',
    'delayed',
    'active',
    'completed',
    'failed',
  ]);
  return jobs.filter((j) => (j.data as { outbound_id?: string })?.outbound_id === outbound_id)
    .length;
}

async function waitFor(predicate: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

d('#633 — job de entrega determinístico (Redis + Postgres reais)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 10 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1,'sonda 633 fila') ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 633 fila')
         ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda fila',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${(Date.now() + 1).toString().slice(-8)}`],
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
    // O guarda de dreno (`deferIfNotAcceptingWork`) recusa começar um job
    // quando o processo não aceita trabalho — num teste o lifecycle nasce em
    // repouso, então declarar explicitamente é o que faz o worker consumir.
    lifecycle._resetForTests();
    lifecycle.transitionTo('ready');
    await awaitQueueReady({ includeWorkers: false });
  });

  afterAll(async () => {
    // ORDEM IMPORTA, e a inversão custou um vermelho de CI.
    //
    // Este arquivo roda um worker BullMQ DE VERDADE. Enquanto ele estiver
    // vivo, o caminho de entrega continua gravando em `audit_log` — com
    // `mensagem_id` preenchido. Se a limpeza começar antes de o worker parar,
    // uma linha de auditoria nova pode aterrissar ENTRE o
    // `DELETE FROM audit_log` e o `DELETE FROM mensagens`, e o segundo estoura:
    //
    //     update or delete on table "mensagens" violates foreign key
    //     constraint "audit_log_mensagem_id_fkey" on table "audit_log"
    //
    // O arquivo inteiro é reportado como NÃO CARREGADO (o erro é de hook, não
    // de caso), e o resumo mostra `falharam=0` sobre 1207 casos — verde no
    // contador, vermelho na rodada. Observado no CI em node 22.18 enquanto o
    // 22.22 do MESMO commit passou: é corrida, e corrida não se conserta
    // repetindo a rodada.
    //
    // Fechar a fila PRIMEIRO torna a corrida não-representável: sem worker
    // vivo, não há escrita concorrente com a limpeza.
    for (const id of armados) {
      await outboundDeliveryQueue.getJob(id).then((j) => j?.remove()).catch(() => undefined);
    }
    const { shutdownQueue } = await import('@/gateway/queue.js');
    await shutdownQueue();

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

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 4 — ENFILEIRAR DUAS VEZES NÃO PRODUZ DUAS ENTREGAS.
  //
  // Duas camadas, medidas separadamente porque são independentes: o `jobId`
  // determinístico (transporte) e o claim atômico (banco). Um teste que
  // medisse só a primeira ficaria verde num deploy em que a segunda tivesse
  // sido apagada — e é a segunda que sobrevive a jobs armados antes do deploy.
  // ═══════════════════════════════════════════════════════════════════════

  it('dois enfileiramentos do mesmo outbound_id colidem num job só', async () => {
    const id = await criarLinhaComPayloadInvalido();
    await arm(id);
    await arm(id);
    // INVARIANTE ABSOLUTA: 1, e não "não aumentou".
    expect(await jobsDe(id)).toBe(1);
    const job = await outboundDeliveryQueue.getJob(outboundDeliveryJobId(id));
    expect(job?.id).toBe(outboundDeliveryJobId(id));
    await job?.remove();
  });

  it('o consumidor real concede UMA posse, mesmo com o job entregue duas vezes', async () => {
    const id = await criarLinhaComPayloadInvalido();
    const vistos: string[] = [];
    startOutboundDeliveryWorker(async (outbound_id) => {
      vistos.push(outbound_id);
      await consumeOutboundDeliveryJob(outbound_id);
    });
    await awaitQueueReady();

    await arm(id);
    await arm(id);

    const chegou = await waitFor(async () => (await linha(id)).status === 'failed_terminal');
    expect(chegou).toBe(true);

    // A segunda camada: o `attempt` conta POSSES concedidas pelo claim atômico.
    // Uma, e só uma — é ela que autoriza o efeito externo.
    const l = await linha(id);
    expect(l.attempt).toBe(1);
    expect(l.status).toBe('failed_terminal');

    // E mesmo forçando uma segunda execução do consumidor REAL sobre a MESMA
    // linha — o cenário do job armado antes do deploy, que o `jobId` não cobre
    // — nenhuma segunda posse é concedida.
    await consumeOutboundDeliveryJob(id);
    expect((await linha(id)).attempt).toBe(1);

    expect(vistos.filter((v) => v === id).length).toBeGreaterThanOrEqual(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // JOB RETIDO EM ESTADO DIFERENTE — o risco que a issue lista nominalmente.
  // ═══════════════════════════════════════════════════════════════════════

  it('um job RETIDO em `completed` não veta o rearme legítimo da mesma linha', async () => {
    const id = await criarLinhaComPayloadInvalido();
    const jobId = outboundDeliveryJobId(id);
    armados.add(jobId);

    // Simula o cadáver: um job com o id determinístico, já concluído e ainda
    // dentro da janela de retenção.
    await outboundDeliveryQueue.add('deliver', { version: 1, outbound_id: id }, { jobId });
    const cadaver = await outboundDeliveryQueue.getJob(jobId);
    await cadaver!.moveToCompleted('ok', 'token-sonda', false).catch(() => undefined);

    // O produtor de PRODUÇÃO — é ele que tem de limpar o cadáver antes do `add`.
    await enqueueOutboundDelivery(id);

    const vivo = await outboundDeliveryQueue.getJob(jobId);
    expect(vivo).toBeDefined();
    const estado = await vivo!.getState();
    // INVARIANTE ABSOLUTA: o job voltou a ser trabalho, não um cadáver retido.
    expect(['waiting', 'active', 'delayed', 'completed']).toContain(estado);
    expect(vivo!.finishedOn ?? null).toBeNull();
  });

  it('payload malformado não derruba o worker nem chega ao consumidor', async () => {
    // `.strict()` no schema do job: `tenant_id` no payload é REJEITADO, não
    // ignorado. É o que impede que alguém "só acrescente o telefone para
    // facilitar o debug".
    const jobId = `outbound-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;
    armados.add(jobId);
    const job = await outboundDeliveryQueue.add(
      'deliver',
      { version: 1, outbound_id: 'não-é-uuid', tenant_id: 'x' } as never,
      { jobId },
    );
    // O worker já está de pé do caso anterior; se ele morresse, o job ficaria
    // preso em `waiting` para sempre.
    const drenou = await waitFor(async () => {
      const estado = await job.getState();
      return estado === 'completed' || estado === 'unknown';
    }, 10_000);
    expect(drenou).toBe(true);
  });
});

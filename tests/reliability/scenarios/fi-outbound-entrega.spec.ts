/**
 * Issue #510 (fatia C) — FI-17 e FI-18 contra infraestrutura REAL, com
 * réplicas de entrega que são PROCESSOS e um provider que SOBREVIVE ao crash.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que estes dois cenários provam, e por que nenhum deles é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A armadilha de um harness de fault injection é injetar a falha, nada quebrar,
 * e o teste passar afirmando nada. O antídoto, cenário a cenário, é o mesmo par
 * da fatia B: **a reação do sistema é observada positivamente**, e **existe um
 * caso de controle em que ela não deveria acontecer**.
 *
 *   FI-17 — falha: dois delivery workers disputam a MESMA linha do outbox,
 *           soltos por barreira.
 *           reação provada: o `UPDATE` atômico de `tryClaimDelivery` concede a
 *           posse a UM. Observada como: um `acquired`, um recusado com
 *           `DeliveryFenceError`, `attempt = 1` na linha, um único
 *           `claim_token` — e UM efeito lógico no ledger do provider.
 *           controle: o perdedor continua VIVO e o `physical_call_total` do
 *           provider permanece 1. Sem isso, "um efeito" também passaria num
 *           cenário em que o perdedor simplesmente morreu antes de tentar.
 *
 *   FI-18 — falha: o provider ACEITA, a conexão cai antes da resposta, e o
 *           worker leva `SIGKILL` antes de gravar qualquer coisa.
 *           reação provada: a linha fica em `sending`; o sucessor reivindica,
 *           descobre a chamada em voo e é ESTRUTURALMENTE incapaz de reenviar
 *           (`status = CASE WHEN status = 'sending' THEN 'sending' … END` +
 *           `markSending` exigindo `claimed`); registra
 *           `cancelled_after_send_unknown` e manda a linha para reconciliação.
 *           controle: o ledger do provider continua com `logical_effect_count`
 *           = 1 DEPOIS de o sucessor rodar o ciclo inteiro. É a afirmação
 *           "não houve retry cego", e ela é a razão de o provider viver fora.
 *
 * ═══ Por que o provider precisa estar em OUTRO processo ════════════════════
 *
 * `tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts` já
 * cobre este seam com um fake in-process e um "crash" que é apenas parar de
 * chamar funções — o processo nunca morre, e o vencimento da lease é FORÇADO
 * por um `UPDATE … lease_expires_at = now() - interval '1 second'`.
 *
 * Aqui as três coisas são reais:
 *
 *   1. o worker morre de `SIGKILL` — nenhum `finally`, nenhum pool fechado,
 *      nenhum timer de heartbeat cancelado;
 *   2. a lease vence pelo RELÓGIO DO BANCO, não por um UPDATE que finge o
 *      tempo;
 *   3. o contador de efeitos vive num processo que SOBREVIVE ao kill. Um fake
 *      in-process não pode ser autoridade sobre "o sucessor reenviou?", porque
 *      ele deixa de existir no instante exato que interessa.
 *
 * ═══ Nenhum `sleep` sincroniza nada ════════════════════════════════════════
 *
 * A largada é uma BARREIRA; a parada é um GATE de failpoint com resposta HTTP
 * diferida; a espera é `eventually` com prazo e diagnóstico. O único lugar em
 * que o tempo aparece como grandeza é o vencimento da lease — lido do relógio
 * do BANCO.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante, eventually } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import { FakeChannelProvider } from '../fakes/fake-channel-provider.js';
import { InvariantOracle } from '../oracles/invariant-oracle.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
const FIXTURE = resolve(AQUI, '..', 'fixtures', 'replica-de-entrega.ts');

/**
 * `--import tsx`, e NÃO o CLI do tsx: o CLI spawna um NETO para aplicar os
 * flags do loader, e o pid que o `ProcessSupervisor` registra passa a ser o do
 * invólucro. Um `SIGKILL` mataria a casca enquanto o processo que segura a
 * posse continua vivo. Cobrado caso a caso (`carga.pid === filho.pid`).
 */
const CARREGADOR_TSX = '--import tsx';

/** TTL da lease de ENTREGA nestes cenários. Ver o comentário de TTL da fatia B. */
const LEASE_MS = 6_000;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let provider: FakeChannelProvider;
let artefatos: ArtifactCollector;
let TENANT = '';
let AGENTE = '';

interface Prontidao {
  pid: number;
  acquired: boolean;
  claim_token: string | null;
  attempt: number | null;
  motivo: string;
}

interface LinhaDeSaidaBruta {
  status: string;
  delivery_outcome: string | null;
  attempt: number;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  provider_message_id: string | null;
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

async function linhaDeSaida(outbound_id: string): Promise<LinhaDeSaidaBruta> {
  const r = await pool.query<LinhaDeSaidaBruta>(
    `SELECT status, delivery_outcome, attempt::int AS attempt, claim_token::text AS claim_token,
            claimed_by, lease_expires_at, provider_message_id
       FROM outbound_messages WHERE id = $1`,
    [outbound_id],
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`outbound ${outbound_id} sumiu do banco`);
  return linha;
}

/** O relógio é o do BANCO — o do processo de teste não decide prazo nenhum. */
async function jaVenceu(prazo: Date | null): Promise<boolean> {
  if (!prazo) return true;
  const r = await pool.query<{ v: boolean }>('SELECT $1::timestamptz <= now() AS v', [prazo]);
  return r.rows[0]?.v === true;
}

/**
 * Cria um turno e a linha DURÁVEL do outbox correspondente.
 *
 * O `INSERT` é setup de cenário, não o objeto do teste — o que está sob prova
 * é o CLAIM. Mesma divisão que `turnoNovo()` da fatia B faz para `agent_turns`.
 * O CHECK `outbound_messages_durable_row_complete_check` (migração 121) exige o
 * tuplo inteiro quando `turn_id IS NOT NULL`, então ele está todo aqui.
 */
async function saidaNova(): Promise<{
  outbound_id: string;
  turn_id: string;
  idempotency_key: string;
  payload_hash: string;
}> {
  // A cadeia inteira é REAL porque `audit_log.conversa_id` tem FK para
  // `conversas` — e a auditoria do claim vive na MESMA transação do `UPDATE`.
  // Um `conversa_id` inventado faria o claim ser revertido pelo caminho
  // fail-closed do repositório, e o cenário mediria a FK em vez da corrida.
  const p = await pool.query<{ id: string }>(
    `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'Sonda 510', $3, 'dono', 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, `+5511${String(Date.now()).slice(-9)}`],
  );
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status)
     VALUES ($1, $2, $3, 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, p.rows[0]!.id],
  );
  const conversa_id = c.rows[0]!.id;

  const m = await pool.query<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', 'texto', 'x', '{}'::jsonb) RETURNING id::text AS id`,
    [TENANT, AGENTE, conversa_id],
  );
  const mensagem_id = m.rows[0]!.id;

  const t = await pool.query<{ id: string }>(
    `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status)
     VALUES ($1, $2, $3, 'running') RETURNING id::text AS id`,
    [TENANT, AGENTE, mensagem_id],
  );
  const turn_id = t.rows[0]!.id;

  const payload = { kind: 'text', text: 'resposta durável' };
  const payload_hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const chave = `fi-${turn_id}-0`;

  const o = await pool.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel, status,
        turn_id, sequence_in_turn, payload_version, payload_type, payload_json, payload_hash,
        logical_dedupe_key, provider_idempotency_key, next_attempt_at, attempt)
     VALUES ($1,$2,$3,$4,$5,'text','pending',
             $6, 0, 1, 'text', $7::jsonb, $8,
             $9, $10, now(), 0)
     RETURNING id::text AS id`,
    [
      TENANT,
      AGENTE,
      chave,
      conversa_id,
      mensagem_id,
      turn_id,
      JSON.stringify(payload),
      payload_hash,
      chave,
      chave,
    ],
  );
  return { outbound_id: o.rows[0]!.id, turn_id, idempotency_key: chave, payload_hash };
}

function subirReplica(
  label: string,
  alvo: { outbound_id: string; idempotency_key: string; payload_hash: string },
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
      TEST_FI_TENANT_ID: TENANT,
      TEST_FI_AGENT_ID: AGENTE,
      TEST_FI_OUTBOUND_ID: alvo.outbound_id,
      TEST_FI_IDEMPOTENCY_KEY: alvo.idempotency_key,
      TEST_FI_PAYLOAD_HASH: alvo.payload_hash,
      TEST_FI_PROVIDER_URL: provider.baseUrl,
      TEST_FI_LEASE_MS: String(LEASE_MS),
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
    'o pid do dono da entrega não é o pid supervisionado — o SIGKILL mataria um invólucro',
  ).toBe(filho.pid);
  return carga;
}

d('#510 FI-17/FI-18 — claim de entrega e efeito não repetido, com réplicas de PROCESSO', () => {
  beforeAll(async () => {
    env = await ReliabilityEnvironment.criar({ suite: 'fi-outbound-entrega' });
    TENANT = env.estado.tenants[0]!.tenantId;
    AGENTE = env.estado.tenants[0]!.agentId;
    pool = new pg.Pool({ connectionString: env.estado.databaseUrl });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await env?.derrubar();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-outbound-entrega', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
    // O provider sobe pelo MESMO supervisor: ele é um filho como qualquer
    // outro, e morre pela mesma faxina com PID exato.
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
  // FI-17
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-17 — dois delivery workers na MESMA linha: um claim, um envio lógico',
    async () => {
      const alvo = await saidaNova();
      await provider.roteirizar([{ kind: 'accept' }, { kind: 'accept' }]);

      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [alvo.turn_id],
      });

      // O gate segura o VENCEDOR logo depois do claim — é o que garante que a
      // foto do banco seja tirada com a corrida já decidida e ninguém adiante.
      servidor.arm('after_outbound_claim_before_send', 'pause');

      const a = subirReplica('entrega-a', alvo, { TEST_FI_BARREIRA: 'largada' });
      const b = subirReplica('entrega-b', alvo, { TEST_FI_BARREIRA: 'largada' });

      await servidor.esperarNaBarreira('largada', 2, 60_000);
      expect(servidor.abrirBarreira('largada')).toBe(2);

      const [pa, pb] = await Promise.all([prontidaoDe(a), prontidaoDe(b)]);
      expect(a.pid).not.toBe(b.pid);

      const vencedores = [pa, pb].filter((p) => p.acquired);
      const perdedores = [pa, pb].filter((p) => !p.acquired);
      expect(
        vencedores.length,
        `esperava UM vencedor; a=${JSON.stringify(pa)} b=${JSON.stringify(pb)}`,
      ).toBe(1);
      const vencedor = vencedores[0]!;
      const perdedor = perdedores[0]!;

      // A recusa do perdedor tem NOME. "Não conseguiu" sem motivo também seria
      // o que um processo que nem tentou reportaria.
      expect(perdedor.motivo).toContain('DeliveryFenceError');
      expect(perdedor.claim_token).toBeNull();

      // A linha reflete UMA posse, e `attempt` andou UMA vez. Se as duas
      // réplicas tivessem reivindicado, `attempt` seria 2 — o incremento está
      // dentro do mesmo UPDATE atômico do claim.
      const linha = await linhaDeSaida(alvo.outbound_id);
      expect(linha.status).toBe('sending');
      expect(linha.attempt).toBe(1);
      expect(linha.claim_token).toBe(vencedor.claim_token);

      // NENHUM efeito ainda: o vencedor está parado ANTES da chamada.
      const antes = await provider.ledger();
      expect(antes.physical_call_total).toBe(0);
      expect(antes.logical_effect_total).toBe(0);

      // Solta o vencedor. Ele chama o provider e para no gate 2.
      servidor.arm('after_provider_accept_before_delivery_persist', 'pause');
      // Esperar o vencedor estar PARADO no gate 1 antes de soltá-lo. A
      // prontidão diz que ele reportou; o gate diz que ele chegou. São coisas
      // diferentes, e soltar um gate vazio devolve 0.
      await servidor.esperarParadoEm('after_outbound_claim_before_send', 1, 30_000);
      expect(servidor.liberar('after_outbound_claim_before_send')).toBe(1);

      await eventually(
        async () => (await provider.ledger()).logical_effect_total === 1,
        { timeoutMs: 30_000, label: 'o vencedor registra UM efeito lógico no provider' },
      );

      // Solta o gate 2: o desfecho é gravado.
      //
      // O `eventually` acima observa o LEDGER DO PROVIDER — um sinal indireto.
      // O filho registra o efeito lá e só DEPOIS estaciona neste gate; soltar
      // com base no ledger é apostar que ele já chegou. Foi essa aposta que
      // reprovou este cenário no CI (`liberar` devolveu 0). Esperar o filho
      // parado AQUI é esperar o sinal certo.
      await servidor.esperarParadoEm('after_provider_accept_before_delivery_persist', 1, 30_000);
      expect(servidor.liberar('after_provider_accept_before_delivery_persist')).toBe(1);

      await eventually(
        async () => (await linhaDeSaida(alvo.outbound_id)).delivery_outcome !== null,
        { timeoutMs: 30_000, label: 'o desfecho da entrega é persistido' },
      );

      const depois = await linhaDeSaida(alvo.outbound_id);
      expect(depois.delivery_outcome).toBe('accepted_confirmed');

      // ── O CONTROLE. O perdedor continua VIVO, e o ledger continua com UMA
      //    chamada física. Sem esta asserção, "um efeito" também passaria num
      //    cenário em que o perdedor tivesse morrido antes de tentar.
      expect(b.vivo || a.vivo).toBe(true);
      const ledger = await provider.ledger();
      expect(ledger.physical_call_total).toBe(1);
      expect(ledger.logical_effect_total).toBe(1);
      const entrada = await provider.entrada(alvo.idempotency_key);
      expect(entrada?.logical_effect_count).toBe(1);
      expect(entrada?.outcome).toBe('accepted');

      // E o perdedor nunca chegou sequer a emitir um envio.
      expect(linhasDe(perdedor === pa ? a : b, '##fi-envio##')).toHaveLength(0);

      await oracle.assertInvariantes('FI-17');
    },
    180_000,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // FI-18
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'FI-18 — provider aceita e o worker MORRE antes de gravar: o sucessor não reenvia',
    async () => {
      const alvo = await saidaNova();
      // `accept_then_drop`: o efeito é registrado e a conexão cai antes da
      // resposta. O emissor NÃO pode concluir "falhou".
      await provider.roteirizar([{ kind: 'accept_then_drop' }, { kind: 'accept' }]);

      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [alvo.turn_id],
      });

      // O gate fica DEPOIS da chamada ao provider e ANTES da persistência —
      // a janela mais perigosa do caminho de saída inteiro.
      servidor.arm('after_provider_accept_before_delivery_persist', 'pause');

      const morto = subirReplica('entrega-morto', alvo);
      const p1 = await prontidaoDe(morto);
      expect(p1.acquired).toBe(true);

      // O efeito ACONTECEU: o provider registrou antes de derrubar a conexão.
      await eventually(
        async () => (await provider.ledger()).logical_effect_total === 1,
        { timeoutMs: 30_000, label: 'o provider registra o efeito antes do drop' },
      );

      // O worker está parado no gate 2, com o efeito externo já existente e
      // NADA persistido. Agora ele morre — sem `finally`, sem fechar pool, sem
      // cancelar timer.
      const linhaAntes = await linhaDeSaida(alvo.outbound_id);
      expect(linhaAntes.status).toBe('sending');
      expect(linhaAntes.delivery_outcome).toBeNull();

      // O `SIGKILL` precisa acertar o filho PARADO no gate 2, não em algum
      // lugar por ali: o ledger já provou que o efeito aconteceu, mas só isto
      // prova que ele está bloqueado esperando decisão do cenário.
      await servidor.esperarParadoEm('after_provider_accept_before_delivery_persist', 1, 30_000);
      sup.hardKill(morto);
      const enc = await morto.esperarSaida(10_000);
      expect(enc.signal).toBe('SIGKILL');

      // A linha continua em `sending`: o crash não gravou nada. Este é o
      // estado que diz "a chamada foi iniciada, o desfecho é desconhecido".
      const linhaDepoisDoKill = await linhaDeSaida(alvo.outbound_id);
      expect(linhaDepoisDoKill.status).toBe('sending');
      expect(linhaDepoisDoKill.delivery_outcome).toBeNull();

      // ── O CONTROLE DE PRAZO. ANTES do vencimento, o sucessor é RECUSADO.
      //    Sem isto, "o sucessor assumiu" também passaria num sistema sem
      //    lease nenhuma.
      expect(await jaVenceu(linhaDepoisDoKill.lease_expires_at)).toBe(false);

      // A lease vence pelo relógio do BANCO. Nenhum UPDATE finge o tempo.
      await eventually(
        async () => jaVenceu((await linhaDeSaida(alvo.outbound_id)).lease_expires_at),
        { timeoutMs: 30_000, label: 'a lease da entrega vence pelo relógio do banco' },
      );

      // ── O SUCESSOR. Ele roda o ciclo de produção inteiro sobre a mesma linha.
      servidor.disarm('after_provider_accept_before_delivery_persist');
      const sucessor = subirReplica('entrega-sucessor', alvo);
      const p2 = await prontidaoDe(sucessor);

      // ── A AFIRMAÇÃO CENTRAL, e ela vem PRIMEIRO de propósito: é o dano real.
      //
      //    O ledger vive num processo que SOBREVIVEU ao `SIGKILL`, então ele
      //    pode responder a pergunta que um fake in-process não pode: o
      //    sucessor reenviou?
      //
      //    `estavelDurante` e não uma leitura única: afirmar um NEGATIVO ("não
      //    houve segunda chamada") com uma foto instantânea passaria também no
      //    caso em que a segunda chamada ainda não saiu. A janela dá ao
      //    sucessor tempo de sobra para reenviar — e é exatamente ela que fica
      //    vermelha quando a trava estrutural do `sending` é removida.
      await estavelDurante(async () => (await provider.ledger()).physical_call_total, {
        label: 'o sucessor NÃO chama o provider uma segunda vez',
        janelaMs: 3_000,
        intervalMs: 100,
        justificativa:
          'é uma afirmação negativa sobre um efeito EXTERNO; não há evento de ' +
          '"não enviei" para esperar, então a janela é o único observável honesto.',
      });

      // Ele reivindicou a linha — e foi RECUSADO pela disposição da chamada em
      // voo. `beginInlineDelivery` lança `DeliveryFenceError` de propósito: a
      // próxima linha do chamador seria a chamada ao canal.
      expect(p2.acquired).toBe(false);
      expect(p2.motivo).toContain('DeliveryFenceError');

      const ledger = await provider.ledger();
      expect(ledger.physical_call_total).toBe(1);
      expect(ledger.logical_effect_total).toBe(1);
      const entrada = await provider.entrada(alvo.idempotency_key);
      expect(entrada?.physical_call_count).toBe(1);
      expect(entrada?.logical_effect_count).toBe(1);

      // E o sucessor nunca emitiu um envio sequer.
      expect(linhasDe(sucessor, '##fi-envio##')).toHaveLength(0);

      // ── O ESTADO É HONESTO. Não `delivered` (ninguém confirmou), não
      //    `retryable` (reenviar duplicaria), e sim `delivery_unknown` — a
      //    fila da reconciliação.
      await eventually(
        async () => (await linhaDeSaida(alvo.outbound_id)).status === 'delivery_unknown',
        { timeoutMs: 30_000, label: 'a linha vai para delivery_unknown' },
      );
      const finalLinha = await linhaDeSaida(alvo.outbound_id);
      expect(finalLinha.delivery_outcome).toBe('cancelled_after_send_unknown');
      expect(['pending', 'retryable']).not.toContain(finalLinha.status);
      // Posse liberada — nenhum worker fantasma segurando a linha.
      expect(finalLinha.claim_token).toBeNull();
      expect(finalLinha.claimed_by).toBeNull();

      // O oracle confere a família `outbound` inteira, inclusive
      // `desconhecido_nao_e_entregue`.
      await oracle.assertInvariantes('FI-18');
    },
    180_000,
  );
});

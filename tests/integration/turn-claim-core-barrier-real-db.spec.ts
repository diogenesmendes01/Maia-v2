/**
 * Issue #504 — a BARREIRA vista do consumidor de produção (`src/agent/core.ts`).
 *
 * ─── Por que esta suíte existe separada ─────────────────────────────────────
 *
 * `turn-claim-lifecycle-real-db.spec.ts` chama `beginTurnExecution` DIRETO e
 * prova que ela devolve `started: false` quando outro worker tem a posse. Isso
 * é necessário e insuficiente: nada ali prova que alguém OBEDECE o retorno.
 *
 * A lacuna é real e foi medida: neutralizar o consumidor com
 * `if (false && !start.started)` em `src/agent/core.ts` deixava as cinco suítes
 * de #504 inteiramente VERDES — o cadeado funcionava e não estava na porta.
 * É a mesma armadilha de espelho que a #545 enfrentou.
 *
 * ─── Por que este caso não é espelho ────────────────────────────────────────
 *
 * Nada aqui mocka `beginTurnExecution` para devolver `started: false` — isso
 * testaria o mock. A barreira é produzida pelo ESTADO REAL: outro worker
 * reivindica o turno de verdade, com lease viva, via `agentTurnsRepo`. Depois
 * chamamos `runAgentForMensagem`, o ponto de entrada que o worker da BullMQ
 * usa (`src/index.ts`), e a asserção observa o EFEITO NO BANCO.
 *
 * ─── Qual efeito, e por que ele é o discriminador certo ─────────────────────
 *
 * Uma mensagem sem `telefone` no metadata percorre o caminho pós-barreira mais
 * CURTO que existe: o inner conclui `identity_unknown` e carimba
 * `mensagens.processada_em`. Escolher o caminho mais curto é deliberado — se
 * até ele rodou, tudo que vem depois (identidade, ReAct, tools, outbound)
 * também teria rodado. E `processada_em` é o efeito certo de observar porque é
 * ele que o early-return legado consulta: um intruso que o carimba faz o turno
 * do dono legítimo parecer processado por fora.
 *
 * O turno em si quase não se move nos dois cenários (o CAS de `concludeTurn`
 * falharia de qualquer jeito, porque `ignored` não sai de `claimed`), então as
 * asserções sobre `claim_token`/`attempt_count` são a rede — não o sinal.
 *
 * O caso de CONTROLE não é decoração: sem ele, "nada aconteceu" passaria também
 * se o core nunca tivesse rodado (import quebrado, tenant errado, mensagem não
 * encontrada). Ele prova que o mesmo harness, com o turno LIVRE, de fato
 * executa e carimba.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomInt } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';

// `config/env.ts` congela o env no import, então a flag tem de estar de pé
// ANTES de qualquer import — inclusive dos imports ESM içados. É o mesmo
// motivo (e o mesmo remédio) de `debounce-flow.spec.ts`.
const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
    FEATURE_TURN_CLAIM: process.env.FEATURE_TURN_CLAIM,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  process.env.FEATURE_TURN_CLAIM = 'true';
  return prev;
});

// Stub da cadeia queue/baileys/redis: importar `src/agent/core.js` abriria uma
// Queue da BullMQ e um socket Baileys. A camada de banco — que é o que este
// caso mede — permanece REAL. Espelha `debounce-flow.spec.ts`.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));
vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
// O RESOLVEDOR DE IDENTIDADE é o único mock de comportamento desta suíte, e
// deliberadamente não é nada que ela teste: ele serve de PONTO DE PAUSA
// determinístico dentro de `runAgentForMensagem`, entre a barreira do claim e a
// conclusão do turno. `takeoverDuranteOTurno` é preenchido por caso; quando
// está nulo o mock só devolve `unknown` e o turno segue o caminho normal.
//
// Mockar `beginTurnExecution` ou o dispatcher aqui seria testar o mock. Este é
// o oposto: o mock apenas abre a janela em que a POSSE REAL é tomada por outro
// worker, e tudo que se mede depois — fence, `markLost`, `AbortSignal`, guards
// — é código de produção.
const takeoverHook = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }));
// O ROTEADOR DE CANAL, pela mesma lógica: uma mensagem COM telefone precisa de
// um canal casado, e semear um canal `whatsapp` num Postgres compartilhado por
// 46 worktrees mudaria o desfecho do catch-all single-tenant para todas as
// outras suítes. Mock PARCIAL — só `resolveChannel` — devolvendo o mesmo par
// baseline que o caminho sem telefone já usa. Roteamento não é o que esta
// suíte mede.
vi.mock('../../src/gateway/channel-resolver.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveChannel: async () => ({
    tenant_id: 'primary',
    agent_id: 'primary',
    channel_id: null,
  }),
}));
vi.mock('../../src/identity/resolver.js', () => ({
  resolveIdentity: async () => {
    if (takeoverHook.fn) await takeoverHook.fn();
    return { kind: 'unknown' as const };
  },
}));
vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => false,
  getSocket: () => null,
  startBaileys: vi.fn(),
  shutdownBaileys: vi.fn(),
  triggerPairingCode: vi.fn(),
  isReactionStub: () => false,
  REACTION_STUB_TYPE: 67,
  MEDIA_ROOT: '/tmp/media',
  getLastDisconnectAt: () => null,
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// `primary/primary` NÃO é escolha estética: uma mensagem sem telefone faz o
// probe de canal devolver null, e `runAgentForMensagem` mantém o par baseline.
// Um tenant sintético aqui faria o inner não achar a mensagem, e o caso passaria
// por não ter rodado nada — o falso verde que o caso de controle detecta.
const T = 'primary';
const A = 'primary';

let pool: pg.Pool;
const created: string[] = [];

const inPrimary = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

/** Inbound SEM `telefone` no metadata — o caminho pós-barreira mais curto. */
async function mkInboundSemTelefone(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'oi', jsonb_build_object('whatsapp_id', $4::text), NULL)`,
    [id, T, A, `WAID-504-${randomInt(0, 1e9).toString(36)}`],
  );
  created.push(id);
  return id;
}

/** Inbound COM `telefone` — passa pelo resolvedor (nosso ponto de pausa). */
async function mkInboundComTelefone(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'oi', jsonb_build_object('telefone', $4::text, 'whatsapp_id', $5::text), NULL)`,
    [
      id,
      T,
      A,
      `+5511${randomInt(100000000, 999999999)}`,
      `WAID-504-hb-${randomInt(0, 1e9).toString(36)}`,
    ],
  );
  created.push(id);
  return id;
}

async function mkTurn(mensagem_id: string): Promise<string> {
  const { agentTurnsRepo } = await import('../../src/db/repositories.js');
  const turn = await inPrimary(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T,
      agent_id: A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return turn.id;
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

async function readProcessadaEm(mensagem_id: string): Promise<unknown> {
  const r = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [mensagem_id]);
  return r.rows[0]?.processada_em ?? null;
}

d('#504 — o core OBEDECE a barreira do claim (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  }, 30_000);

  afterAll(async () => {
    if (created.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [created]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        created,
      ]);
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [created],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [created]);
    }
    // `primary/primary` é semeado pela migration 081 e compartilhado com toda a
    // suíte: apagamos SÓ as nossas linhas, nunca o par.
    //
    // E devolvemos o env: o Vitest isola o registro de módulos por arquivo, mas
    // REUSA o processo do worker — sem isto, um spec que carregasse `config`
    // depois deste herdaria `FEATURE_TURN_CLAIM=true` sem ter pedido.
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  });

  it('CONTROLE: com o turno LIVRE, o core executa e carimba processada_em', async () => {
    // Sem este caso, o teste seguinte passaria também se o core nunca tivesse
    // rodado. Ele é o que dá significado ao "nada aconteceu" de lá.
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    const mensagem_id = await mkInboundSemTelefone();
    const turn_id = await mkTurn(mensagem_id);

    await runAgentForMensagem(mensagem_id);

    expect(
      await readProcessadaEm(mensagem_id),
      'o core deveria ter executado e concluído o turno sem identidade',
    ).not.toBeNull();
    const turn = await readTurn(turn_id);
    // Executou de verdade: reivindicou (o claim conta a tentativa) e concluiu.
    expect(Number(turn.attempt_count)).toBe(1);
    expect(turn.status).toBe('ignored');
    expect(turn.outcome).toBe('identity_unknown');
  }, 60_000);

  /**
   * ─── Achado P1 nº 2 da review, visto do CONSUMIDOR ────────────────────────
   *
   * As duas suítes acima provam a barreira de ENTRADA. Este caso prova a outra
   * metade: que o core abre o CONTEXTO DE EXECUÇÃO da tentativa e que os
   * limites de efeito a jusante o obedecem quando a posse acaba NO MEIO.
   *
   * Por que aqui e não em `turn-lease-lost-effects-real-db.spec.ts`: lá o
   * escopo (`runWithTurnExecution`) é aberto pelo próprio teste, então aquela
   * suíte prova que os guards funcionam — não que o core os liga. É a mesma
   * distinção entre "o cadeado funciona" e "o cadeado está na porta" que segurou
   * esta PR na primeira integração. Apagar o `runWithTurnExecution` de
   * `src/agent/core.ts` deixa aquela suíte inteira verde e esta vermelha.
   *
   * O efeito observado é `mensagens.processada_em`, pelo mesmo motivo do caso
   * anterior: é o campo que o early-return legado consulta, e carimbá-lo depois
   * de perder a posse faz o turno do dono legítimo parecer processado por fora.
   */
  it('POSSE PERDIDA NO MEIO: o core não carimba a projeção legada', async () => {
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    const { agentTurnsRepo } = await import('../../src/db/repositories.js');
    const mensagem_id = await mkInboundComTelefone();
    const turn_id = await mkTurn(mensagem_id);

    // A janela: o core já reivindicou e está DENTRO do turno. Aqui a lease vence
    // e outro worker assume — pela porta de produção, sem mock nenhum.
    takeoverHook.fn = async () => {
      await pool.query(
        `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
        [turn_id],
      );
      const sucessor = await inPrimary(() =>
        agentTurnsRepo.claimNextEligibleTurn({
          turn_id,
          worker_id: 'sucessor-no-meio-do-turno',
          lease_ms: 60_000,
        }),
      );
      expect(sucessor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);
    };
    try {
      await runAgentForMensagem(mensagem_id);
    } finally {
      takeoverHook.fn = null;
    }

    // O SINAL: a projeção legada NÃO foi carimbada por quem perdeu a posse.
    expect(
      await readProcessadaEm(mensagem_id),
      'o core carimbou processada_em depois de perder a posse do turno',
    ).toBeNull();

    // A REDE, e o que prova que o core REALMENTE entrou (sem isto, um turno
    // barrado na entrada também deixaria `processada_em` nulo): a conclusão foi
    // tentada e RECUSADA pelo fence, e a posse na linha é a do sucessor.
    const fence = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'turn_fence_rejected' AND alvo_id = $1`,
      [turn_id],
    );
    expect(
      fence.rows[0].n,
      'o core precisa ter ENTRADO e sido recusado no fence — senão o teste passa por não ter rodado',
    ).toBeGreaterThan(0);
    const turn = await readTurn(turn_id);
    expect(turn.claimed_by).toBe('sucessor-no-meio-do-turno');
    expect(turn.status, 'o zumbi não pode ter concluído o turno').not.toBe('ignored');
  }, 60_000);

  it('CONTROLE do caso acima: sem takeover, o mesmo caminho carimba e conclui', async () => {
    // O par honesto do caso anterior: mesma mensagem com telefone, mesmo
    // resolvedor devolvendo `unknown`, mesma rota — só que a posse permanece.
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    const mensagem_id = await mkInboundComTelefone();
    const turn_id = await mkTurn(mensagem_id);

    takeoverHook.fn = null;
    await runAgentForMensagem(mensagem_id);

    expect(
      await readProcessadaEm(mensagem_id),
      'com a posse intacta o core tem de concluir e carimbar',
    ).not.toBeNull();
    const turn = await readTurn(turn_id);
    expect(turn.status).toBe('ignored');
    expect(turn.outcome).toBe('identity_unknown');
    expect(Number(turn.attempt_count)).toBe(1);
  }, 60_000);

  it('BARREIRA: turno com dono vivo — o core NÃO executa nem carimba nada', async () => {
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    const { agentTurnsRepo } = await import('../../src/db/repositories.js');
    const mensagem_id = await mkInboundSemTelefone();
    const turn_id = await mkTurn(mensagem_id);

    // OUTRO worker toma a posse de verdade, com lease viva. Nenhum mock: é o
    // mesmo caminho que uma segunda réplica usaria.
    const dono = await inPrimary(() =>
      agentTurnsRepo.claimNextEligibleTurn({
        turn_id,
        worker_id: 'outro-worker-vivo',
        lease_ms: 60_000,
      }),
    );
    expect(dono.ok, 'o dono deveria ter conseguido o claim').toBe(true);
    if (!dono.ok) return;

    // E AGORA o caminho de produção roda para a MESMA mensagem — exatamente o
    // que acontece quando duas réplicas acordam com o mesmo job.
    await runAgentForMensagem(mensagem_id);

    // O SINAL: nenhum efeito. Se o core ignorasse `started: false`, teria
    // percorrido o inner até `identity_unknown` e carimbado o campo legado.
    expect(
      await readProcessadaEm(mensagem_id),
      'o core executou um turno que não é dele: processada_em foi carimbado',
    ).toBeNull();

    // A REDE: a posse do dono está intacta e nenhuma segunda tentativa nasceu.
    const turn = await readTurn(turn_id);
    expect(Number(turn.attempt_count), 'nenhuma segunda tentativa pode ter começado').toBe(1);
    expect(turn.claim_token).toBe(dono.claim.claim_token);
    expect(turn.claimed_by).toBe('outro-worker-vivo');
    expect(turn.status).toBe('claimed');
  }, 60_000);
});

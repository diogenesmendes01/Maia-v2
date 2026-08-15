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

  it('BARREIRA: turno com dono vivo — o core NÃO executa nem carimba nada', async () => {
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    const { agentTurnsRepo } = await import('../../src/db/repositories.js');
    const mensagem_id = await mkInboundSemTelefone();
    const turn_id = await mkTurn(mensagem_id);

    // OUTRO worker toma a posse de verdade, com lease viva. Nenhum mock: é o
    // mesmo caminho que uma segunda réplica usaria.
    const dono = await inPrimary(() =>
      agentTurnsRepo.tryClaimTurn({
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

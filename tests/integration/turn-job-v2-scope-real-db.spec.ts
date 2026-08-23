/**
 * Issue #504 §Contrato do job — a FRONTEIRA CROSS-TENANT do payload V2, vista
 * do consumidor de produção.
 *
 * ─── Por que esta suíte é adversarial e não de contrato ─────────────────────
 *
 * Um job V2 carrega `{version: 2, turn_id}`. Isso significa que o consumidor
 * aceita um PONTEIRO e vai buscar o dono no banco — e é exatamente a forma de
 * ataque que a issue obriga a fechar ("nenhuma informação de tenant vinda
 * apenas do payload pode ser confiada sem reconciliação com a linha
 * persistida"). Provar que o resolvedor devolve o escopo certo no caminho feliz
 * é necessário e insuficiente: o que interessa é o que ele faz com um ponteiro
 * que ATRAVESSA a fronteira.
 *
 * Nada aqui mocka `resolveTurnJobScope`. A situação é produzida pelo ESTADO
 * REAL: um turno do tenant sintético é gravado com
 * `representative_message_id` apontando para a mensagem de OUTRO par (tenant,
 * agent). Isso é fisicamente representável porque a coluna NÃO tem foreign key
 * — só uma unique (`migrations/097_agent_turns.sql`) —, e é a razão de o
 * predicado existir. Depois chamamos `runAgentTurnJob`, o mesmo corpo de
 * processor que `src/index.ts` registra no worker da BullMQ, e observamos o
 * EFEITO NO BANCO.
 *
 * ─── Qual efeito, e por que ele é o discriminador certo ─────────────────────
 *
 * `mensagens.processada_em` da mensagem VÍTIMA. É o mesmo discriminador da
 * barreira de `turn-claim-core-barrier-real-db.spec.ts`, pela mesma razão: uma
 * mensagem sem `telefone` percorre o caminho pós-resolução mais CURTO que
 * existe (o inner conclui `identity_unknown` e carimba), então se até ele rodou,
 * tudo depois teria rodado. Afrouxar o resolvedor faz o carimbo aparecer na
 * mensagem de outro dono — e é isso, e não uma exceção esperada, que a
 * asserção pega.
 *
 * O caso de CONTROLE não é decoração: sem ele, "nada aconteceu" passaria também
 * se o consumidor nunca tivesse rodado (import quebrado, mensagem não
 * encontrada, mock demais). Ele prova que o MESMO harness, com o ponteiro
 * íntegro, de fato executa e carimba.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomInt } from 'node:crypto';

// `config/env.ts` congela o env no import, então a flag tem de estar de pé
// ANTES de qualquer import — inclusive dos içados. Mesmo motivo (e mesmo
// remédio) de `turn-claim-core-barrier-real-db.spec.ts`.
const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  return prev;
});

// Stub da cadeia queue/baileys/redis: importar `src/agent/core.js` abriria uma
// Queue da BullMQ e um socket Baileys. A camada de BANCO — que é o que esta
// suíte mede — permanece REAL.
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
// Mesmo mock parcial da barreira: semear um canal `whatsapp` num Postgres
// compartilhado mudaria o desfecho do catch-all single-tenant para as outras
// suítes. Roteamento de canal não é o que esta suíte mede.
vi.mock('../../src/gateway/channel-resolver.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveChannel: async () => ({
    tenant_id: 'primary',
    agent_id: 'primary',
    channel_id: null,
  }),
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

/**
 * O par BASELINE. Uma mensagem sem `telefone` faz o probe de canal devolver
 * null, e `runAgentForMensagem` mantém `primary/primary` — então é sob ele que
 * o inner precisa encontrar a mensagem para que o caso de CONTROLE prove
 * execução de verdade.
 */
const VICTIM_T = 'primary';
const VICTIM_A = 'primary';

/** O tenant ATACANTE: dono do turno cujo ponteiro atravessa a fronteira. */
const SUFFIX = randomInt(0, 1e9).toString(36);
const ATTACKER_T = `t504v2-${SUFFIX}`;
const ATTACKER_A = `a504v2-${SUFFIX}`;

let pool: pg.Pool;
const mensagensCriadas: string[] = [];
const turnosCriados: string[] = [];

/** Inbound SEM `telefone` — o caminho pós-resolução mais curto que existe. */
async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'oi', jsonb_build_object('whatsapp_id', $4::text), NULL)`,
    [id, tenant, agent, `WAID-504V2-${randomInt(0, 1e9).toString(36)}`],
  );
  mensagensCriadas.push(id);
  return id;
}

/**
 * Turno gravado por SQL direto, com o par (tenant, agent) e o ponteiro
 * declarados independentemente — é o que permite construir a combinação
 * cruzada que nenhuma API de repositório produziria.
 */
async function mkTurn(args: {
  tenant: string;
  agent: string;
  representative_message_id: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, queued_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, args.tenant, args.agent, args.representative_message_id, args.status ?? 'received'],
  );
  turnosCriados.push(id);
  // A row de `agent_turn_inputs` só é criada quando o turno e a mensagem
  // pertencem ao MESMO par: as duas FKs dela são compostas por (tenant, agent),
  // e é justamente por isso que ela não pode representar o cruzamento — a
  // fronteira que falta é a de `representative_message_id`.
  if (args.tenant === VICTIM_T && args.agent === VICTIM_A) {
    await pool.query(
      `INSERT INTO agent_turn_inputs (tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
       VALUES ($1, $2, $3, $4, 0) ON CONFLICT DO NOTHING`,
      [args.tenant, args.agent, id, args.representative_message_id],
    );
  }
  return id;
}

async function readProcessadaEm(mensagem_id: string): Promise<unknown> {
  const r = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [mensagem_id]);
  return r.rows[0]?.processada_em ?? null;
}

async function countAudit(alvo_id: string, acao: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM audit_log WHERE alvo_id = $1 AND acao = $2`,
    [alvo_id, acao],
  );
  return Number(r.rows[0]?.c ?? '0');
}

d('#504 — o resolvedor de escopo do job V2 fecha a fronteira (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, 'Tenant 504 V2') ON CONFLICT (id) DO NOTHING`,
      [ATTACKER_T],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'Agent 504 V2', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ATTACKER_A, ATTACKER_T],
    );
  }, 30_000);

  afterAll(async () => {
    if (turnosCriados.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE alvo_id = ANY($1::uuid[])`, [turnosCriados]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE turn_id = ANY($1::uuid[])`, [
        turnosCriados,
      ]);
      await pool.query(`DELETE FROM agent_turns WHERE id = ANY($1::uuid[])`, [turnosCriados]);
    }
    if (mensagensCriadas.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
        mensagensCriadas,
      ]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        mensagensCriadas,
      ]);
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [mensagensCriadas]);
    }
    // O par sintético é NOSSO (sufixo aleatório): pode ir embora inteiro. O
    // `primary/primary` é semeado pela migration 081 e compartilhado — nunca.
    await pool.query(`DELETE FROM agents WHERE id = $1`, [ATTACKER_A]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [ATTACKER_T]);
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  });

  it('CONTROLE: com o ponteiro ÍNTEGRO, o job V2 executa o turno de ponta a ponta', async () => {
    // Sem este caso, o "nada aconteceu" do teste adversarial passaria também se
    // o consumidor nunca tivesse rodado. Ele é o que dá significado àquele nada.
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    const mensagem_id = await mkInbound(VICTIM_T, VICTIM_A);
    const turn_id = await mkTurn({
      tenant: VICTIM_T,
      agent: VICTIM_A,
      representative_message_id: mensagem_id,
    });

    const facts = { received_at_ms: null as number | null };
    await runAgentTurnJob({ kind: 'v2', turn_id }, facts);

    expect(
      await readProcessadaEm(mensagem_id),
      'o consumidor V2 deveria ter resolvido o escopo e executado o turno',
    ).not.toBeNull();
    // O relógio do SLI ponta-a-ponta foi recomposto do banco: é o que substitui
    // o `received_at_ms` que o payload V2 não pode carregar.
    expect(facts.received_at_ms).toBeTypeOf('number');
  });

  it('ADVERSARIAL: um job V2 apontando para o turno de OUTRO tenant é RECUSADO, e a mensagem da vítima não é tocada', async () => {
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    const { TurnScopeUnresolvedError } = await import(
      '../../src/runtime/turns/scope-resolver.js'
    );

    // A vítima: mensagem do par baseline, ainda não processada.
    const vitima = await mkInbound(VICTIM_T, VICTIM_A);
    // O ponteiro cruzado: turno do ATACANTE apontando para a mensagem da
    // vítima. Nenhuma FK impede — é a lacuna que o resolvedor cobre.
    const turnoAtacante = await mkTurn({
      tenant: ATTACKER_T,
      agent: ATTACKER_A,
      representative_message_id: vitima,
    });

    const facts = { received_at_ms: null as number | null };
    const erro = await runAgentTurnJob({ kind: 'v2', turn_id: turnoAtacante }, facts).then(
      () => null,
      (e: unknown) => e,
    );

    // A ASSERÇÃO QUE IMPORTA, e ela vem PRIMEIRO de propósito: o que se está
    // provando não é que uma exceção foi lançada, é que NENHUM efeito
    // atravessou a fronteira. Afrouxe o predicado do resolvedor e este carimbo
    // aparece — o job de um tenant terá feito o turno de outro rodar. Deixá-la
    // depois da asserção de tipo faria o vermelho parar na exceção que faltou,
    // sem nunca mostrar o vazamento.
    expect(
      await readProcessadaEm(vitima),
      'a mensagem da VÍTIMA foi processada por um job que aponta para o turno de outro tenant',
    ).toBeNull();

    expect(erro, 'o resolvedor tinha de RECUSAR, não resolver').toBeInstanceOf(
      TurnScopeUnresolvedError,
    );
    expect((erro as { reason: string }).reason).toBe('scope_mismatch');

    // A recusa é DURÁVEL: sem a row de auditoria, um ponteiro cruzado em
    // produção seria só um job falhando sem explicação.
    expect(await countAudit(turnoAtacante, 'turn_job_scope_rejected')).toBeGreaterThan(0);
  });

  it('turno inexistente (payload forjado com UUID aleatório) é recusado como `turn_not_found`', async () => {
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    const facts = { received_at_ms: null as number | null };
    const erro = await runAgentTurnJob({ kind: 'v2', turn_id: randomUUID() }, facts).then(
      () => null,
      (e: unknown) => e,
    );
    expect((erro as { reason?: string })?.reason).toBe('turn_not_found');
  });

  it('turno cuja mensagem representativa NÃO existe é recusado como `representative_missing`', async () => {
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    // Ponteiro para uma mensagem que nunca existiu. Sem FK, o INSERT passa —
    // e é por isso que o resolvedor precisa distinguir este caso de
    // "turno inexistente": os dois pedem triagem diferente.
    const orfao = await mkTurn({
      tenant: ATTACKER_T,
      agent: ATTACKER_A,
      representative_message_id: randomUUID(),
    });
    const facts = { received_at_ms: null as number | null };
    const erro = await runAgentTurnJob({ kind: 'v2', turn_id: orfao }, facts).then(
      () => null,
      (e: unknown) => e,
    );
    expect((erro as { reason?: string })?.reason).toBe('representative_missing');
  });

  it('a série `maia_turn_scope_rejected_total` distingue os motivos da recusa', async () => {
    const { renderPrometheus } = await import('../../src/lib/metrics.js');
    const linhas = (await renderPrometheus())
      .split('\n')
      .filter((l) => l.startsWith('maia_turn_scope_rejected_total'));
    const texto = linhas.join('\n');
    expect(texto).toContain('reason="scope_mismatch"');
    expect(texto).toContain('reason="turn_not_found"');
    // Fora de escopo de tenant a atribuição é `system` — o bucket sancionado —
    // e NUNCA o literal `default`.
    expect(texto).toContain('tenant_id="system"');
    expect(texto).not.toContain('tenant_id="default"');
  });
});

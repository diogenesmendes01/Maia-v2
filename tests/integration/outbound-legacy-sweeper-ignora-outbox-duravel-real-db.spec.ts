/**
 * Issue #633 (fatia D da épica #506) — o SWEEPER LEGADO não pode tocar a linha
 * do OUTBOX DURÁVEL. Contra Postgres REAL, entrando pelo worker de produção.
 *
 * ## O defeito que esta suíte existe para impedir de voltar
 *
 * `outbound_messages_sweeper` (#292) promove a `unknown` toda row `pending`
 * mais velha que `OUTBOUND_SWEEPER_STALE_PENDING_SEC` (300s por default).
 * Depois da #630 a MESMA tabela hospeda o outbox durável, cuja row NASCE em
 * `pending` esperando o delivery worker — e `unknown` é TERMINAL para o claim
 * de entrega (`DELIVERY_TERMINAL_STATUSES`, #632).
 *
 * Ou seja: cinco minutos depois de a resposta ser commitada, o housekeeping do
 * ledger ANTIGO a tornava inentregável. E o modo de falha é o pior possível —
 * **silencioso**: nenhuma exceção, nenhuma métrica subindo, a linha só muda
 * para um estado terminal e o claim nunca mais a pega. O usuário simplesmente
 * não recebe resposta.
 *
 * O conserto é um predicado de três palavras (`AND turn_id IS NULL`) em TRÊS
 * consultas. É exatamente o tipo de coisa que uma refatoração futura remove por
 * parecer redundante — e o comentário no cabeçalho daquele arquivo ajuda quem
 * lê, não quem não lê. Estes casos são para quem não lê.
 *
 * ## Por que integração e não unidade
 *
 * `tests/unit/workers/outbound-messages-sweeper.spec.ts` REIMPLEMENTA o `WHERE`
 * em JavaScript sobre um store em memória. É a armadilha do espelho: o fake não
 * modela `turn_id`, então remover o predicado da produção o deixa VERDE.
 * (Verificado: com os seis `AND turn_id IS NULL` removidos por regex, aquela
 * suíte passa inteira.) Aqui não há SQL escrito pelo teste exceto o de FIXTURE
 * e o de INSPEÇÃO — quem executa o predicado é o PostgreSQL.
 *
 * ## Cada caso tem CONTROLE, e o controle não é decoração
 *
 * Um teste que afirme só "a linha durável não foi tocada" fica VERDE com o
 * sweeper inteiro desligado, com o advisory lock global tomado por outro
 * processo, ou com a carência mal calculada no fixture. Por isso todo caso
 * carrega, na MESMA idade e no MESMO passe, uma linha LEGADA que **tem** de ser
 * tocada. As duas asserções juntas dizem "o sweeper rodou E discriminou".
 *
 * ## ARMADILHA DO `retry: 1`
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção é INVARIANTE ABSOLUTA sobre
 * o estado final de linhas criadas NO PRÓPRIO caso (`beforeEach` limpa e
 * recria), nunca um delta antes×depois sobre estado mutável compartilhado.
 *
 * ## Efeito colateral declarado
 *
 * `runOutboundMessagesSweeper` é GLOBAL (o dispatcher não é escopado): ao rodar
 * aqui, ele varre a tabela inteira do banco da worktree. Na prática isso é
 * inócuo — as rows das suítes vizinhas têm segundos de idade, e os cortes são
 * 300s (promoção) e 30 DIAS (retenção). Está escrito porque é o tipo de coisa
 * que deve ser decidida de propósito, e não descoberta depois.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';
import {
  runOutboundMessagesSweeper,
  listTenantsWithWork,
} from '@/workers/outbound-messages-sweeper.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't633s';
const AGENT = 'a633s';

/** Bem além de `OUTBOUND_SWEEPER_STALE_PENDING_SEC` (300s por default). */
const IDADE_STALE_S = 3600;
/** Bem além de `OUTBOUND_SWEEPER_RETENTION_DAYS` (30 por default). */
const IDADE_RETENCAO_S = 60 * 24 * 3600;

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;

/** Linha do ledger LEGADO: sem `turn_id`, exatamente como a 063 a criava. */
async function criarLegada(status: string, idade_s: number): Promise<string> {
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','legado','{}'::jsonb) RETURNING id`,
      [TENANT, AGENT, conversaId],
    );
    const inbound = m.rows[0]!.id;
    const o = await c.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
          status, created_at)
       VALUES ($1,$2,$3,$4,$5,'text',$6, now() - make_interval(secs => $7))
       RETURNING id`,
      [TENANT, AGENT, `legado-${inbound}`, conversaId, inbound, status, idade_s],
    );
    return o.rows[0]!.id;
  } finally {
    c.release();
  }
}

/**
 * Linha do OUTBOX DURÁVEL: com `turn_id`, o tuplo completo que o CHECK
 * `outbound_messages_durable_row_complete_check` (121) exige, e as duas chaves
 * derivadas pelo MESMO `buildOutboundArtifact` da produção.
 */
async function criarDuravel(status: string, idade_s: number): Promise<string> {
  const c = await pool.connect();
  try {
    const m = await c.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,'in','texto','duravel','{}'::jsonb) RETURNING id`,
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
          next_attempt_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'text',$6,$7,0,$8,$9,$10::jsonb,$11,$12,$13,
               now(), now() - make_interval(secs => $14))
       RETURNING id`,
      [
        TENANT,
        AGENT,
        artefato.logical_dedupe_key,
        conversaId,
        inbound,
        status,
        turn,
        artefato.payload_version,
        artefato.payload_type,
        JSON.stringify(artefato.payload),
        artefato.payload_hash,
        artefato.logical_dedupe_key,
        artefato.provider_idempotency_key,
        idade_s,
      ],
    );
    return o.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** O estado da linha, ou `null` quando ela deixou de existir. */
async function estado(id: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT status FROM outbound_messages WHERE id = $1`, [id]);
  return (rows[0]?.status as string | undefined) ?? null;
}

d('#633 — o sweeper LEGADO não toca a linha do outbox durável (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 10 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1,'sonda 633 sweeper') ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 633 sweeper')
         ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda sweeper',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${(Date.now() + 3).toString().slice(-8)}`],
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
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM conversas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    } finally {
      c.release();
    }
    await pool.end();
  });

  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1 AND conversa_id = $2`, [
        TENANT,
        conversaId,
      ]);
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONSULTA (A) — a PROMOÇÃO stale-pending. É o caminho do defeito.
  // ═══════════════════════════════════════════════════════════════════════

  it('uma resposta DURÁVEL em `pending` e velha NÃO é promovida a `unknown`', async () => {
    const duravel = await criarDuravel('pending', IDADE_STALE_S);
    // CONTROLE, na MESMA idade e no MESMO passe: sem ele, este caso ficaria
    // verde com o sweeper desligado, com o advisory lock global tomado por
    // outro processo, ou com a carência mal calculada acima.
    const legada = await criarLegada('pending', IDADE_STALE_S);

    await runOutboundMessagesSweeper();

    // INVARIANTE ABSOLUTA, não delta: a durável CONTINUA reivindicável pelo
    // delivery worker; `unknown` seria terminal e a resposta se perderia em
    // silêncio.
    expect(await estado(duravel)).toBe('pending');
    expect(await estado(duravel)).not.toBe('unknown');
    // E o sweeper DE FATO rodou e fez o trabalho dele no ledger legado.
    expect(await estado(legada)).toBe('unknown');
  });

  it('GUARDA PROSPECTIVA: `retryable` durável também sobrevive ao passe', async () => {
    // HONESTIDADE SOBRE ESTE CASO: ele NÃO fica vermelho quando os filtros de
    // `turn_id` saem — foi medido. O predicado da promoção casa `status =
    // 'pending'` e mais nada, então uma linha `retryable` está fora dele com ou
    // sem o filtro.
    //
    // Ele existe para o defeito VIZINHO: `retryable` é o outro membro de
    // `OUTBOUND_SELECTABLE_STATUSES` (#630), e um alargamento futuro do sweeper
    // legado que o incluísse — sem o filtro de `turn_id` — reabriria o mesmo
    // buraco por outra porta. É guarda, não sonda; a sonda são os três casos
    // vizinhos, e o CONTROLE abaixo é o que impede que ESTE fique verde por
    // vacuidade.
    const duravel = await criarDuravel('retryable', IDADE_STALE_S);
    const legada = await criarLegada('pending', IDADE_STALE_S);

    await runOutboundMessagesSweeper();

    expect(await estado(duravel)).toBe('retryable');
    expect(await estado(legada)).toBe('unknown');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONSULTA (B) — a RETENÇÃO. Ela apaga; apagar é irreversível.
  // ═══════════════════════════════════════════════════════════════════════

  it('a retenção NÃO apaga a linha durável, nem quando ela já está num estado legado', async () => {
    // `unknown` com `turn_id NOT NULL` é EXATAMENTE a corrupção que o defeito
    // produzia. Se a retenção também a apagasse, o inventário pós-deploy
    // (`WHERE turn_id IS NOT NULL AND status='unknown'`, runbook §2) não
    // teria o que encontrar: o rastro forense da perda sumiria com a linha.
    const duravelCorrompida = await criarDuravel('unknown', IDADE_RETENCAO_S);
    const duravelCompleta = await criarDuravel('completed', IDADE_RETENCAO_S);
    const legada = await criarLegada('sent', IDADE_RETENCAO_S);

    await runOutboundMessagesSweeper();

    // INVARIANTES ABSOLUTAS: as duas duráveis SOBREVIVEM.
    expect(await estado(duravelCorrompida)).toBe('unknown');
    expect(await estado(duravelCompleta)).toBe('completed');
    // CONTROLE: a legada terminal e antiga foi mesmo apagada.
    expect(await estado(legada)).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONSULTA (C) — o DISPATCHER. Ele não apaga nem promove; ele DECIDE quem
  // entra no passe. Sem caso próprio, remover o filtro só dele passa
  // despercebido — as outras duas consultas fazem o passe virar no-op, e um
  // teste de efeito ficaria verde.
  // ═══════════════════════════════════════════════════════════════════════

  it('um escopo cujo ÚNICO trabalho é durável NÃO é enumerado pelo dispatcher', async () => {
    await criarDuravel('pending', IDADE_STALE_S);
    await criarDuravel('unknown', IDADE_RETENCAO_S);

    const escopos = await listTenantsWithWork(300, 30);

    // INVARIANTE ABSOLUTA sobre o MEU par: ele não pode aparecer. Asserção
    // sobre o próprio escopo, e não sobre o tamanho da lista, porque o
    // dispatcher é global e as suítes vizinhas também têm linhas.
    expect(escopos).not.toContainEqual({ tenant_id: TENANT, agent_id: AGENT });
  });

  it('CONTROLE do dispatcher: com UMA linha legada, o mesmo escopo é enumerado', async () => {
    await criarDuravel('pending', IDADE_STALE_S);
    await criarLegada('pending', IDADE_STALE_S);

    const escopos = await listTenantsWithWork(300, 30);

    expect(escopos).toContainEqual({ tenant_id: TENANT, agent_id: AGENT });
  });
});

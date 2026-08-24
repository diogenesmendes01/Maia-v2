/**
 * Issue #630 (fatia A da épica #506) — a migração 121 contra Postgres REAL.
 *
 * O teste unitário prova que a derivação das chaves é correta. Este prova a
 * outra metade, que só o banco pode responder:
 *
 *   1. a migração APLICA sobre dado existente e a row LEGADA continua
 *      inserível exatamente como antes (o "aditivo" é aditivo de verdade);
 *   2. os uniques PARCIAIS realmente recusam a segunda saída lógica e
 *      realmente ignoram a row legada — que é o mecanismo pelo qual a
 *      constraint não pode explodir com duplicata histórica;
 *   3. o CHECK de completude impede meia-row durável;
 *   4. a FK COMPOSTA impede que uma row aponte para o turno de outro tenant —
 *      isolamento por construção, não por disciplina de código;
 *   5. os CHECKs de vocabulário recusam valor fora da lista fechada e o CHECK
 *      não cai na armadilha ternária (predicado que dá NULL ACEITA a row).
 *
 * Skipped sem TEST_DB_URL — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';
const T2 = 'tenant-630-vizinho';

let client: pg.Client;

/** Cria um turno e devolve o id. FK composta ⇒ o turno precisa existir. */
async function criarTurno(tenant: string, agent: string): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO agent_turns (tenant_id, agent_id, representative_message_id, status)
     VALUES ($1, $2, $3, 'received') RETURNING id`,
    [tenant, agent, randomUUID()],
  );
  return rows[0].id as string;
}

/**
 * Chave lógica sintética e ÚNICA por chamada.
 *
 * Ela precisa ser única por default e o motivo é uma lição do próprio teste:
 * a primeira versão devolvia um literal fixo (`mol1_bbb…`), e três casos que
 * nada tinham a ver com unicidade quebraram com `duplicate key value violates
 * … outbound_messages_logical_dedupe_uq` — porque as rows de casos ANTERIORES
 * seguiam na tabela. O unique estava certo; o fixture é que afirmava, sem
 * querer, que duas saídas lógicas distintas compartilhavam identidade.
 *
 * Formato de baixa entropia e obviamente sintético (hex de um UUID, sem
 * segredo): o gitleaks varre a HISTÓRIA, e uma "chave" aleatória num teste de
 * idempotência é exatamente o que a regra `generic-api-key` procura.
 * O caso que TESTA a colisão passa a mesma chave explicitamente.
 */
function chaveLogicaSintetica(): string {
  return `mol1_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

/** Row durável completa. `over` altera um campo por vez para isolar o CHECK. */
function rowDuravel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: T,
    agent_id: A,
    idempotency_key: `k-${randomUUID()}`,
    conversa_id: randomUUID(),
    in_reply_to: randomUUID(),
    channel: 'text',
    status: 'pending',
    turn_id: null,
    sequence_in_turn: 0,
    payload_version: 1,
    payload_type: 'text',
    payload_json: JSON.stringify({ type: 'text', text: 'oi' }),
    payload_hash: 'a'.repeat(64),
    logical_dedupe_key: chaveLogicaSintetica(),
    provider_idempotency_key: `3EB0${'C'.repeat(18)}`,
    next_attempt_at: new Date().toISOString(),
    ...over,
  };
}

async function inserir(row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(
    `INSERT INTO outbound_messages (${cols.join(', ')}) VALUES (${params})`,
    Object.values(row),
  );
}

d('#630 — migração 121: outbox durável em outbound_messages', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    await client.connect();
    await client.query(
      `INSERT INTO tenants (id, nome) VALUES ($1, 'vizinho 630')
       ON CONFLICT (id) DO NOTHING`,
      [T2],
    );
    await client.query(
      `INSERT INTO agents (id, tenant_id, nome) VALUES ($1, $2, 'agente vizinho')
       ON CONFLICT (id) DO NOTHING`,
      [A === 'primary' ? 'agente-630-vizinho' : A, T2],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM outbound_messages WHERE idempotency_key LIKE 'k-%'`);
    await client.query(`DELETE FROM agent_turns WHERE tenant_id IN ($1, $2)`, [T, T2]);
    await client.query(`DELETE FROM agents WHERE tenant_id = $1`, [T2]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [T2]);
    await client.end();
  });

  it('todas as colunas de #630 existem, e nenhuma coluna legada mudou de nulabilidade', async () => {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'outbound_messages'`,
    );
    const porNome = new Map<string, string>(rows.map((r) => [r.column_name, r.is_nullable]));
    for (const c of [
      'turn_id',
      'sequence_in_turn',
      'payload_version',
      'payload_type',
      'payload_json',
      'payload_hash',
      'logical_dedupe_key',
      'provider_idempotency_key',
      'attempt',
      'claimed_by',
      'claim_token',
      'lease_expires_at',
      'next_attempt_at',
      'provider_message_id',
      'provider_timestamp',
      'last_error_code',
      'delivery_outcome',
    ]) {
      expect(porNome.has(c), `coluna ausente: ${c}`).toBe(true);
    }
    // tenant/agent seguem NOT NULL — o criterio de pronto de #630 sobre
    // "nenhum campo de tenant/agent nullable" e propriedade da COLUNA.
    expect(porNome.get('tenant_id')).toBe('NO');
    expect(porNome.get('agent_id')).toBe('NO');
  });

  it('a row LEGADA (sem nada de #630) continua inserível — o aditivo é aditivo', async () => {
    await expect(
      inserir({
        tenant_id: T,
        agent_id: A,
        idempotency_key: `k-legado-${randomUUID()}`,
        conversa_id: randomUUID(),
        in_reply_to: randomUUID(),
        channel: 'text',
        status: 'pending',
      }),
    ).resolves.toBeUndefined();
  });

  it('N rows LEGADAS coexistem sem tocar o unique parcial — é por isso que a constraint não explode', async () => {
    // Este é o teste do RISCO declarado em #506: se os uniques NÃO fossem
    // parciais, um conjunto de rows legadas com logical_dedupe_key NULL
    // ainda passaria (NULL é distinto no unique do Postgres), mas o
    // predicado parcial torna a propriedade EXPLÍCITA e à prova de um
    // backfill futuro que preenchesse a coluna.
    for (let i = 0; i < 3; i++) {
      await inserir({
        tenant_id: T,
        agent_id: A,
        idempotency_key: `k-legado-lote-${i}-${randomUUID()}`,
        conversa_id: randomUUID(),
        in_reply_to: randomUUID(),
        channel: 'text',
        status: 'pending',
      });
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM outbound_messages
        WHERE tenant_id = $1 AND logical_dedupe_key IS NULL`,
      [T],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('o unique parcial recusa a SEGUNDA saída lógica com a mesma chave', async () => {
    const turn = await criarTurno(T, A);
    const ldk = chaveLogicaSintetica();
    await inserir(rowDuravel({ turn_id: turn, sequence_in_turn: 0, logical_dedupe_key: ldk }));
    await expect(
      inserir(rowDuravel({ turn_id: turn, sequence_in_turn: 1, logical_dedupe_key: ldk })),
    ).rejects.toThrow(/outbound_messages_logical_dedupe_uq/);
  });

  it('a MESMA chave lógica em OUTRO tenant é permitida — o escopo é (tenant, agent, key)', async () => {
    const turn = await criarTurno(T, A);
    const turn2 = await criarTurno(T2, 'agente-630-vizinho');
    const ldk = chaveLogicaSintetica();
    await inserir(rowDuravel({ turn_id: turn, logical_dedupe_key: ldk }));
    await expect(
      inserir(
        rowDuravel({
          tenant_id: T2,
          agent_id: 'agente-630-vizinho',
          turn_id: turn2,
          logical_dedupe_key: ldk,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('o unique de posição recusa duas saídas na MESMA posição do MESMO turno', async () => {
    const turn = await criarTurno(T, A);
    await inserir(rowDuravel({ turn_id: turn, sequence_in_turn: 0 }));
    await expect(
      // conteudo DIFERENTE (chave logica diferente), mesma posicao: e a rede
      // que o unique de (7a) sozinho nao daria.
      inserir(
        rowDuravel({
          turn_id: turn,
          sequence_in_turn: 0,
          logical_dedupe_key: `mol1_${randomUUID().replace(/-/g, '')}`,
          payload_hash: 'd'.repeat(64),
        }),
      ),
    ).rejects.toThrow(/outbound_messages_turn_sequence_uq/);
  });

  it('a FK COMPOSTA impede que uma row aponte para o turno de OUTRO tenant', async () => {
    const turnoDoVizinho = await criarTurno(T2, 'agente-630-vizinho');
    await expect(
      inserir(rowDuravel({ tenant_id: T, agent_id: A, turn_id: turnoDoVizinho })),
    ).rejects.toThrow(/outbound_messages_turn_scope_fk/);
  });

  it('o CHECK de completude impede meia-row durável', async () => {
    const turn = await criarTurno(T, A);
    for (const faltando of [
      'sequence_in_turn',
      'payload_version',
      'payload_type',
      'payload_json',
      'payload_hash',
      'logical_dedupe_key',
      'provider_idempotency_key',
      'next_attempt_at',
    ]) {
      await expect(
        inserir(rowDuravel({ turn_id: turn, [faltando]: null })),
        `row com ${faltando}=NULL deveria ser recusada`,
      ).rejects.toThrow(/outbound_messages_durable_row_complete_check/);
    }
  });

  it('vocabulário fechado: status, payload_type, delivery_outcome e canal', async () => {
    const turn = await criarTurno(T, A);
    await expect(inserir(rowDuravel({ status: 'inventado' }))).rejects.toThrow(
      /outbound_messages_status_check/,
    );
    await expect(
      inserir(rowDuravel({ turn_id: turn, payload_type: 'image' })),
    ).rejects.toThrow(/outbound_messages_payload_type_check/);
    await expect(
      inserir(rowDuravel({ turn_id: turn, payload_type: 'video' })),
    ).rejects.toThrow(/outbound_messages_payload_type_check/);
    await expect(
      inserir(rowDuravel({ delivery_outcome: 'talvez' })),
    ).rejects.toThrow(/outbound_messages_delivery_outcome_check/);
    await expect(inserir(rowDuravel({ channel: 'telepatia' }))).rejects.toThrow(
      /outbound_messages_channel_check/,
    );
    // Os estados novos de #506 SAO aceitos — sem isso o indice de selecao
    // apontaria para um status que o CHECK proibe.
    await expect(inserir(rowDuravel({ status: 'retryable' }))).resolves.toBeUndefined();
    await expect(inserir(rowDuravel({ status: 'delivery_unknown' }))).resolves.toBeUndefined();
    // ...e os quatro legados da 063 continuam validos.
    for (const s of ['pending', 'sent', 'failed', 'unknown']) {
      await expect(inserir(rowDuravel({ status: s }))).resolves.toBeUndefined();
    }
  });

  it('payload_hash tem que ser sha256 hex minúsculo', async () => {
    await expect(inserir(rowDuravel({ payload_hash: 'A'.repeat(64) }))).rejects.toThrow(
      /outbound_messages_payload_hash_format_check/,
    );
    await expect(inserir(rowDuravel({ payload_hash: 'a'.repeat(63) }))).rejects.toThrow(
      /outbound_messages_payload_hash_format_check/,
    );
  });

  it('o trio de claim é tudo-ou-nada — um dono sem token não pode ser cercado', async () => {
    await expect(
      inserir(rowDuravel({ claimed_by: 'worker-a', claim_token: null })),
    ).rejects.toThrow(/outbound_messages_claim_complete_check/);
    await expect(
      inserir(
        rowDuravel({
          claimed_by: 'worker-a',
          claim_token: randomUUID(),
          lease_expires_at: null,
        }),
      ),
    ).rejects.toThrow(/outbound_messages_claim_complete_check/);
    await expect(
      inserir(
        rowDuravel({
          claimed_by: 'worker-a',
          claim_token: randomUUID(),
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('sequence_in_turn e attempt não podem ser negativos', async () => {
    const turn = await criarTurno(T, A);
    await expect(
      inserir(rowDuravel({ turn_id: turn, sequence_in_turn: -1 })),
    ).rejects.toThrow(/outbound_messages_sequence_in_turn_check/);
    await expect(inserir(rowDuravel({ attempt: -1 }))).rejects.toThrow(
      /outbound_messages_attempt_check/,
    );
  });

  it('o índice de seleção existe e é parcial em pending/retryable', async () => {
    // Se o predicado divergir de OUTBOUND_SELECTABLE_STATUSES, a selecao do
    // delivery worker vira seq scan silencioso na tabela mais quente.
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_outbound_messages_ready'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/next_attempt_at/);
    expect(rows[0].indexdef).toMatch(/pending/);
    expect(rows[0].indexdef).toMatch(/retryable/);
  });

  it('os dois uniques são PARCIAIS — é o que os torna imunes a duplicata histórica', async () => {
    const { rows } = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('outbound_messages_logical_dedupe_uq', 'outbound_messages_turn_sequence_uq')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.indexdef, `${r.indexname} precisa ser UNIQUE`).toMatch(/CREATE UNIQUE INDEX/);
      expect(r.indexdef, `${r.indexname} precisa ser PARCIAL`).toMatch(/WHERE .*IS NOT NULL/);
    }
  });
});

/**
 * Issue #635 (fatia F da épica #506) — suíte de LEAK do outbox durável.
 *
 * Faz parte de `npm run test:leak`. O critério de pronto que ela cumpre é
 * literal: *"teste de leak prova isolamento de dedupe keys e queries entre
 * tenants/agents"*.
 *
 * ─── Por que a COLISÃO é forçada em toda sonda ─────────────────────────────
 *
 * "Escopo por tenant passa verde sem estar testado" foi o defeito mais repetido
 * desta leva. Um leak test que crie dados diferentes nos dois pares prova
 * apenas que os dados são diferentes: com o `WHERE` de escopo apagado ele
 * continua verde, porque não há nada para vazar.
 *
 * Aqui cada sonda FORÇA a colisão do identificador que a consulta usa — a mesma
 * `logical_dedupe_key`, o mesmo `outbound_id` no histórico, ou o `turn_id` do
 * vizinho passado como ENTRADA — e então pergunta ao par A. Se a resposta
 * trouxer o dado de B, é vazamento; e sem os predicados de escopo ela traz, por
 * construção.
 *
 * Uma colisão NÃO foi possível forçar, e a sonda de
 * `findBlockingEarlierArtifact` diz isso por extenso em vez de fingir: o mesmo
 * `turn_id` não pode existir em dois pares, porque `agent_turns.id` é PK global
 * e `outbound_messages_turn_scope_fk` amarra o trio. Lá o isolamento é carregado
 * primeiro pelo SCHEMA, e o `WHERE` de escopo é defesa em profundidade — o que a
 * sonda ainda consegue exigir.
 *
 * ─── E a colisão que quase passou despercebida ─────────────────────────────
 *
 * Comparar o par A contra o par B prova apenas que **pelo menos um** dos dois
 * predicados de escopo existe: os dois pares diferem em tenant E em agente,
 * então apagar um dos predicados deixa o outro segurando, e a suíte continua
 * verde. Isso foi VERIFICADO removendo cada metade de `hasHistoryFor`
 * separadamente — as duas vezes, verde.
 *
 * Por isso existe um TERCEIRO par (`T_A` + `A_A2`: mesmo tenant, outro agente)
 * e a sonda "cada METADE do escopo carrega peso", que isola cada predicado
 * contra a row que só ele exclui.
 *
 * Cada `it` diz QUAL consulta carrega o peso, para que a falha aponte a função
 * e não a suíte.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real — e `pulado` NÃO é
 * `passou`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { outboundRecoveryRepo } from '@/db/repositories/outbound-recovery-repo.js';
import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED — `agents.id` é PK global.
const T_A = 'outboundleak-tenant-a';
const A_A = 'outboundleak-agent-a';
const T_B = 'outboundleak-tenant-b';
const A_B = 'outboundleak-agent-b';
/**
 * O TERCEIRO par: **mesmo tenant que A**, agente diferente.
 *
 * Ele existe porque sem ele nenhuma sonda deste arquivo prova qual METADE do
 * escopo carrega o peso — ver o `it` "cada metade do escopo carrega peso".
 */
const A_A2 = 'outboundleak-agent-a2';

let pool: pg.Pool;
let conversaA: string;
let conversaB: string;
let conversaA2: string;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);
const inA2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A2 }, fn);

async function ensureTenantAgent(tenant: string, agent: string): Promise<string> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
  const p = await pool.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1,$2,'leak',$3,'dono','ativa') RETURNING id`,
    [tenant, agent, `+5511${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`],
  );
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
     VALUES ($1,$2,$3,'ativa') RETURNING id`,
    [tenant, agent, p.rows[0]!.id],
  );
  return conv.rows[0]!.id;
}

/**
 * Insere UMA linha do outbox no par indicado.
 *
 * `turn_id` e `logical_dedupe_key` podem ser IMPOSTOS pelo chamador: é assim
 * que a colisão é forçada. Quando não são, saem de `buildOutboundArtifact` — o
 * derivador de produção.
 */
async function mkOutbound(opts: {
  tenant: string;
  agent: string;
  conversa_id: string;
  texto: string;
  status: string;
  sequence_in_turn?: number;
  turn_id?: string;
  logical_dedupe_key?: string;
  delivery_outcome?: string | null;
}): Promise<{ outbound_id: string; turn_id: string; inbound_id: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
     VALUES ($1,$2,$3,'in','texto','pergunta') RETURNING id`,
    [opts.tenant, opts.agent, opts.conversa_id],
  );
  const inbound_id = m.rows[0]!.id;
  let turn_id = opts.turn_id ?? null;
  if (!turn_id) {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          attempt_count, state_version)
       VALUES ($1,$2,$3,$4,'outbound_pending',1,4) RETURNING id`,
      [opts.tenant, opts.agent, inbound_id, opts.conversa_id],
    );
    turn_id = t.rows[0]!.id;
  }
  // `turn_id` fornecido = REUSO de um turno já existente do MESMO par, para
  // montar um multipart. Não serve para colidir entre pares: `agent_turns.id` é
  // PK global e a FK composta impede que o mesmo uuid pertença a dois pares.
  const seq = opts.sequence_in_turn ?? 0;
  const artefato = buildOutboundArtifact({
    tenant_id: opts.tenant,
    agent_id: opts.agent,
    turn_id,
    sequence_in_turn: seq,
    payload: { type: 'text', text: opts.texto },
    channel: 'whatsapp',
  });
  const key = opts.logical_dedupe_key ?? artefato.logical_dedupe_key;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
        status, delivery_outcome, attempt, turn_id, sequence_in_turn,
        payload_version, payload_type, payload_json, payload_hash,
        logical_dedupe_key, provider_idempotency_key, next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,0,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,now(),now())
     RETURNING id`,
    [
      opts.tenant,
      opts.agent,
      key,
      opts.conversa_id,
      inbound_id,
      opts.status,
      opts.delivery_outcome ?? null,
      turn_id,
      seq,
      artefato.payload_version,
      artefato.payload_type,
      JSON.stringify(artefato.payload),
      artefato.payload_hash,
      key,
      artefato.provider_idempotency_key,
    ],
  );
  return { outbound_id: o.rows[0]!.id, turn_id, inbound_id };
}

d('outbound (#635) — leak suite cross-tenant do outbox durável', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 10 });
    conversaA = await ensureTenantAgent(T_A, A_A);
    conversaB = await ensureTenantAgent(T_B, A_B);
    conversaA2 = await ensureTenantAgent(T_A, A_A2);
  });

  afterAll(async () => {
    // DUAS passadas, e não uma por tenant: a sonda "cada metade do escopo"
    // grava deliberadamente uma row com o PAR INCOERENTE (tenant de B, agente
    // de A). Apagando tenant a tenant, `agents` de A cairia antes de
    // `mensagens` de B e a FK `mensagens_agent_id_fkey` recusaria a limpeza.
    for (const tenant of [T_A, T_B]) {
      await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM conversas WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [tenant]);
    }
    for (const tenant of [T_A, T_B]) {
      await pool.query(`DELETE FROM agents WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    }
    await pool.end();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AS DEDUPE KEYS — o namespace é do PAR, e a colisão prova isso.
  // ═══════════════════════════════════════════════════════════════════════

  it('a MESMA logical_dedupe_key convive nos dois pares — o namespace é (tenant, agent)', async () => {
    const chave = `maia:outbound:v1:leak:${randomUUID()}`;
    const a = await mkOutbound({
      tenant: T_A,
      agent: A_A,
      conversa_id: conversaA,
      texto: 'A',
      status: 'pending',
      logical_dedupe_key: chave,
    });
    const b = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'B',
      status: 'pending',
      logical_dedupe_key: chave,
    });
    // Se `outbound_messages_logical_dedupe_uq` fosse GLOBAL, a segunda inserção
    // teria explodido com 23505 e este `it` nem chegaria aqui.
    expect(a.outbound_id).not.toBe(b.outbound_id);
    const { rows } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM outbound_messages WHERE logical_dedupe_key = $1 ORDER BY tenant_id`,
      [chave],
    );
    expect(rows.map((r) => r.tenant_id)).toEqual([T_A, T_B]);
  });

  it('a MESMA logical_dedupe_key DENTRO de um par é recusada pelo banco', async () => {
    // O contraste que torna a sonda acima significativa: a unicidade existe, e
    // é só o escopo que a separa.
    const chave = `maia:outbound:v1:leak:${randomUUID()}`;
    await mkOutbound({
      tenant: T_A,
      agent: A_A,
      conversa_id: conversaA,
      texto: 'primeira',
      status: 'pending',
      logical_dedupe_key: chave,
    });
    await expect(
      mkOutbound({
        tenant: T_A,
        agent: A_A,
        conversa_id: conversaA,
        texto: 'segunda',
        status: 'pending',
        logical_dedupe_key: chave,
      }),
    ).rejects.toThrow(/duplicate key|outbound_messages_logical_dedupe_uq/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AS CONSULTAS — uma sonda por função, com a colisão forçada.
  // ═══════════════════════════════════════════════════════════════════════

  it('`findById` não devolve a linha do vizinho', async () => {
    const b = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'segredo do vizinho',
      status: 'pending',
    });
    expect(await inA(() => outboundDeliveryRepo.findById(b.outbound_id))).toBeNull();
    expect(await inB(() => outboundDeliveryRepo.findById(b.outbound_id))).not.toBeNull();
  });

  it('`tryClaimDelivery` não reivindica a linha do vizinho', async () => {
    const b = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'não é seu',
      status: 'pending',
    });
    const recusado = await inA(() =>
      outboundDeliveryRepo.tryClaimDelivery({
        outbound_id: b.outbound_id,
        worker_id: 'leak-worker',
        lease_ms: 60_000,
      }),
    );
    expect(recusado.ok).toBe(false);
    // E a linha do vizinho continua intocada — sem dono.
    const { rows } = await pool.query<{ claim_token: string | null; status: string }>(
      `SELECT claim_token, status FROM outbound_messages WHERE id = $1`,
      [b.outbound_id],
    );
    expect(rows[0]!.claim_token).toBeNull();
    expect(rows[0]!.status).toBe('pending');
  });

  it('`findBlockingEarlierArtifact` não vê o artefato do vizinho', async () => {
    // ─── O que NÃO deu para forçar, e o que carrega o peso no lugar ────────
    //
    // A colisão ideal seria o MESMO `turn_id` existindo nos dois pares. Ela é
    // INEXPRIMÍVEL: `agent_turns.id` é PK GLOBAL (097), e
    // `outbound_messages_turn_scope_fk` exige que o trio
    // (tenant_id, agent_id, turn_id) exista em `agent_turns`. Ou seja, um
    // `turn_id` pertence a UM par por construção do schema — e essa é a
    // primeira declaração que carrega o isolamento aqui.
    //
    // O que dá para forçar, e é o que esta sonda faz, é a colisão na ENTRADA da
    // consulta: o par A pergunta pelo `turn_id` de B. Sem os predicados
    // `tenant_id`/`agent_id` no `WHERE`, ela encontraria a linha travada do
    // vizinho — e o efeito não seria leitura indevida, seria o turno de A
    // preso para sempre por um artefato que não é dele.
    const vizinho = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'parte 0 do vizinho, travada',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
      sequence_in_turn: 0,
    });
    await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'parte 1 do vizinho',
      status: 'pending',
      sequence_in_turn: 1,
      turn_id: vizinho.turn_id,
    });

    const bloqueio = await inA(() =>
      outboundDeliveryRepo.findBlockingEarlierArtifact({
        turn_id: vizinho.turn_id,
        sequence_in_turn: 1,
      }),
    );
    expect(bloqueio).toBeNull();
    // Controle: em B a MESMA pergunta ENCONTRA o bloqueio. Sem este contraste a
    // asserção acima passaria com a função devolvendo `null` sempre.
    const bloqueioB = await inB(() =>
      outboundDeliveryRepo.findBlockingEarlierArtifact({
        turn_id: vizinho.turn_id,
        sequence_in_turn: 1,
      }),
    );
    expect(bloqueioB).toMatchObject({ sequence_in_turn: 0, status: 'delivery_unknown' });
  });

  it('`hasHistoryFor` não vê o histórico do vizinho — outbound_id COLIDIDO', async () => {
    const a = await mkOutbound({
      tenant: T_A,
      agent: A_A,
      conversa_id: conversaA,
      texto: 'resposta de A',
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
    });
    // A colisão: B grava histórico ancorado no `outbound_id` de A.
    const inbB = await pool.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
       VALUES ($1,$2,$3,'in','texto','pergunta B') RETURNING id`,
      [T_B, A_B, conversaB],
    );
    await pool.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo,
                             outbound_id, metadata)
       VALUES ($1,$2,$3,'out','texto','resposta de B',$4,
               jsonb_build_object('in_reply_to', $5::text))`,
      [T_B, A_B, conversaB, a.outbound_id, inbB.rows[0]!.id],
    );

    // Sem o escopo, A concluiria a linha SEM fabricar histórico, porque acharia
    // que o histórico do vizinho era o seu.
    const vistoPorA = await inA(() =>
      outboundRecoveryRepo.hasHistoryFor({
        outbound_id: a.outbound_id,
        conversa_id: conversaA,
        in_reply_to: a.inbound_id,
      }),
    );
    expect(vistoPorA).toBe(false);
    const vistoPorB = await inB(() =>
      outboundRecoveryRepo.hasHistoryFor({
        outbound_id: a.outbound_id,
        conversa_id: conversaB,
        in_reply_to: inbB.rows[0]!.id,
      }),
    );
    expect(vistoPorB).toBe(true);
  });

  it('cada METADE do escopo de `hasHistoryFor` carrega peso, separadamente', async () => {
    // ─── Por que este `it` existe ─────────────────────────────────────────
    //
    // As sondas acima comparam um par contra OUTRO PAR, que difere em tenant E
    // em agente. Elas provam que "pelo menos um dos dois predicados está lá" —
    // e isso foi verificado: apagando `tenant_id` de `hasHistoryFor` elas
    // continuam VERDES (o `agent_id` segura), e apagando `agent_id` elas também
    // continuam verdes (o `tenant_id` segura). Uma regressão PARCIAL passaria
    // despercebida, que é a armadilha nº 4 desta leva.
    //
    // Aqui cada metade é isolada contra a row que só ela exclui.
    const a = await mkOutbound({
      tenant: T_A,
      agent: A_A,
      conversa_id: conversaA,
      texto: 'resposta de A',
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
    });

    // (1) `agent_id`: histórico do MESMO TENANT, OUTRO AGENTE, ancorado no
    //     `outbound_id` de A. Só `agent_id` o exclui.
    const inbA2 = await pool.query<{ id: string }>(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
       VALUES ($1,$2,$3,'in','texto','pergunta A2') RETURNING id`,
      [T_A, A_A2, conversaA2],
    );
    await pool.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo,
                             outbound_id, metadata)
       VALUES ($1,$2,$3,'out','texto','resposta do OUTRO AGENTE do mesmo tenant',$4,
               jsonb_build_object('in_reply_to', $5::text))`,
      [T_A, A_A2, conversaA2, a.outbound_id, inbA2.rows[0]!.id],
    );

    // (2) `tenant_id`: uma row com o PAR INCOERENTE (tenant de B, agente de A).
    //     `mensagens` referencia `tenants` e `agents` SEPARADAMENTE — não há FK
    //     composta que amarre o agente ao tenant —, então esta row é
    //     expressável, e é exatamente a classe de dado que o predicado
    //     `tenant_id` existe para excluir. Só `tenant_id` a exclui.
    await pool.query(
      `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo,
                             outbound_id, metadata)
       VALUES ($1,$2,NULL,'out','texto','row de par incoerente',$3,
               jsonb_build_object('in_reply_to', $4::text))`,
      [T_B, A_A, a.outbound_id, inbA2.rows[0]!.id],
    );

    // A pergunta de A não enxerga NENHUMA das duas.
    expect(
      await inA(() =>
        outboundRecoveryRepo.hasHistoryFor({
          outbound_id: a.outbound_id,
          conversa_id: conversaA,
          in_reply_to: a.inbound_id,
        }),
      ),
    ).toBe(false);

    // CONTROLES — sem eles, uma função que devolvesse `false` sempre passaria.
    expect(
      await inA2(() =>
        outboundRecoveryRepo.hasHistoryFor({
          outbound_id: a.outbound_id,
          conversa_id: conversaA2,
          in_reply_to: inbA2.rows[0]!.id,
        }),
      ),
    ).toBe(true);
    expect(
      await runWithTenantContext({ tenant_id: T_B, agent_id: A_A }, () =>
        outboundRecoveryRepo.hasHistoryFor({
          outbound_id: a.outbound_id,
          conversa_id: conversaA,
          in_reply_to: a.inbound_id,
        }),
      ),
    ).toBe(true);
  });

  it('`artifactForHistoryRecovery` não devolve o artefato do vizinho', async () => {
    const b = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'o payload do vizinho',
      status: 'delivered',
      delivery_outcome: 'accepted_confirmed',
    });
    expect(await inA(() => outboundRecoveryRepo.artifactForHistoryRecovery(b.outbound_id))).toBeNull();
    expect(
      await inB(() => outboundRecoveryRepo.artifactForHistoryRecovery(b.outbound_id)),
    ).not.toBeNull();
  });

  it('as varreduras (`listDeliverable`, `listReconciliation`) não enumeram o vizinho', async () => {
    const b1 = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'entregável do vizinho',
      status: 'pending',
    });
    const b2 = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'incerto do vizinho',
      status: 'delivery_unknown',
      delivery_outcome: 'timeout_unknown',
    });
    const entregaveis = await inA(() => outboundRecoveryRepo.listDeliverable(500));
    const reconciliaveis = await inA(() => outboundRecoveryRepo.listReconciliation(500));
    expect(entregaveis.map((r) => r.outbound_id)).not.toContain(b1.outbound_id);
    expect(reconciliaveis.map((r) => r.outbound_id)).not.toContain(b2.outbound_id);
    // Controle: em B eles APARECEM. Sem isto, uma varredura quebrada que
    // devolvesse lista vazia passaria nas duas asserções acima.
    const entregaveisB = await inB(() => outboundRecoveryRepo.listDeliverable(500));
    const reconciliaveisB = await inB(() => outboundRecoveryRepo.listReconciliation(500));
    expect(entregaveisB.map((r) => r.outbound_id)).toContain(b1.outbound_id);
    expect(reconciliaveisB.map((r) => r.outbound_id)).toContain(b2.outbound_id);
  });

  it('`countTurnOutboundDivergence` conta só o próprio par', async () => {
    // Divergência plantada SÓ em B: linha viva com turno terminal.
    const b = await mkOutbound({
      tenant: T_B,
      agent: A_B,
      conversa_id: conversaB,
      texto: 'divergente do vizinho',
      status: 'retryable',
    });
    await pool.query(
      `UPDATE agent_turns SET status = 'completed', outcome = 'reply_delivered'
        WHERE tenant_id = $1 AND id = $2`,
      [T_B, b.turn_id],
    );
    const emB = await inB(() => outboundRecoveryRepo.countTurnOutboundDivergence());
    expect(emB.outbound_without_live_turn).toBeGreaterThanOrEqual(1);
  });
});

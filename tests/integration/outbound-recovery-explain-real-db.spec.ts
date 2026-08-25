/**
 * Issue #633 (fatia D da épica #506) — o PLANO das varreduras, sob volume
 * representativo, contra Postgres REAL.
 *
 * ## Por que esta suíte existe
 *
 * A #632 pediu nominalmente: *não há índice para a varredura de takeover;
 * `idx_outbound_messages_ready` (121, 7c) é PARCIAL em `pending`/`retryable` e
 * não enxerga `claimed`/`sending`; a #633 deve validar isso com EXPLAIN*.
 *
 * Um teste de comportamento não responde a essa pergunta: a varredura devolve
 * as linhas certas com ou sem índice. O que muda sem índice é o PLANO, e o
 * plano só é observável pelo `EXPLAIN` — e só é informativo sob volume, porque
 * numa tabela de dez linhas o planejador escolhe Seq Scan por ser mais barato,
 * corretamente, e o teste ficaria vermelho por um motivo que não é defeito.
 *
 * ## MEDIDO, e por que "sem Seq Scan" NÃO é a asserção que importa
 *
 * A sonda foi executada com `idx_outbound_messages_expired_claims` DERRUBADO à
 * mão, para ver o que o planejador faz sem ele. Ele NÃO cai em Seq Scan: cai em
 * `idx_outbound_messages_tenant_agent_status_created` (a 067) com
 * `lease_expires_at` como FILTRO — que é exatamente o que a #632 previu ao
 * pedir esta validação, e não uma varredura sequencial.
 *
 * Ou seja: uma asserção "não há Seq Scan" ficaria VERDE sem o índice desta
 * fatia, e não provaria nada. O que a torna informativa é exigir o índice
 * NOMEADO e recusar o de fallback — porque a diferença entre os dois não é
 * "índice vs. varredura", é SELETIVIDADE: a 067 indexa TODA row (inclusive as
 * terminais, que sob retenção de 30 dias são a maioria) e não ordena por
 * `lease_expires_at`, então o número de tuplas visitadas cresce com o
 * HISTÓRICO; o índice parcial da 131 cresce com o trabalho EM VOO.
 *
 * As duas asserções ficam, e a de Seq Scan é a rede de baixo: ela pega o caso
 * em que alguém derrubar TAMBÉM o índice de fallback.
 *
 * ## Contra a armadilha do espelho
 *
 * O SQL explicado é o de PRODUÇÃO: `deliverableStatement`,
 * `reconciliationStatement`, `takeoverOnlyStatement` e `scopesWithWorkStatement`
 * são as MESMAS funções que `outboundRecoveryRepo` executa. Um teste que
 * montasse a query por conta própria continuaria verde depois de alguém trocar
 * a ordem das colunas do `WHERE` real — mediria a si mesmo.
 *
 * ## O volume, e por que ele tem esta forma
 *
 * ~4 000 linhas TERMINAIS (`sent`, o vocabulário legado sob retenção de 30
 * dias) mais ~300 linhas de trabalho EM VOO. É a PROPORÇÃO que importa, não o
 * valor absoluto: a esmagadora maioria da tabela é histórico, e o que a
 * varredura procura é uma fração minúscula.
 *
 * O número começou em 20 000 e foi REDUZIDO depois de medido: o poder
 * discriminante desta suíte vem de exigir o índice NOMEADO (ver "MEDIDO"
 * acima), não de tornar o Seq Scan caro, e 4 000 já produz exatamente as mesmas
 * quatro escolhas de plano — inclusive os três vermelhos com o índice da 131
 * derrubado. Menos linhas = menos perturbação das estatísticas compartilhadas,
 * que é o efeito colateral declarado logo abaixo.
 *
 * ## Efeito colateral declarado: `ANALYZE` num banco COMPARTILHADO
 *
 * `EXPLAIN` só fala do banco que existe se as estatísticas forem frescas, e
 * `ANALYZE` é por TABELA — não há como escopá-lo a um tenant. Enquanto esta
 * suíte roda, `pg_statistic` para `outbound_messages` reflete o volume dela, e
 * as suítes vizinhas do mesmo banco de worktree veem essas estatísticas.
 *
 * O que limita o dano, na ordem em que importa: (1) nenhuma outra suíte afirma
 * PLANO, então o pior caso alheio é uma escolha de plano diferente, nunca um
 * resultado diferente; (2) o `afterAll` apaga as linhas e roda `ANALYZE` de
 * novo, devolvendo as estatísticas ao estado anterior; (3) a janela é de
 * ~200ms. É risco RESIDUAL, e está escrito aqui porque quem o encontrar depois
 * merece achá-lo declarado em vez de deduzi-lo.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  deliverableStatement,
  explainStatement,
  reconciliationStatement,
  scopesWithWorkStatement,
  takeoverOnlyStatement,
} from '@/db/repositories/outbound-recovery-repo.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't633x';
const AGENT = 'a633x';
const LEGADAS = 4_000;
const EM_VOO = 300;

let pool: pg.Pool;
let conversaId: string;
let pessoaId: string;
let inboundId: string;

/** O plano contém varredura sequencial DA TABELA do outbox? */
function temSeqScanNoOutbox(plano: string): boolean {
  return /"Node Type"\s*:\s*"Seq Scan"[^}]*"Relation Name"\s*:\s*"outbound_messages"/.test(
    plano,
  ) || /"Relation Name"\s*:\s*"outbound_messages"[^}]*"Node Type"\s*:\s*"Seq Scan"/.test(plano);
}

/**
 * O índice para o qual o planejador CAI quando o da 131 não existe — medido,
 * não suposto (ver o bloco "MEDIDO" no topo). Ele é a 067: não-parcial, sem
 * `lease_expires_at` na chave, e por isso proporcional ao HISTÓRICO da tabela.
 */
const FALLBACK = 'idx_outbound_messages_tenant_agent_status_created';

/** Os índices citados pelo plano. */
function indices(plano: string): string[] {
  return Array.from(plano.matchAll(/"Index Name"\s*:\s*"([^"]+)"/g)).map((m) => m[1]!);
}

d('#633 — EXPLAIN das varreduras sob volume (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 10 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1,'sonda 633 explain') ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 633 explain')
         ON CONFLICT (id) DO NOTHING`,
        [AGENT, TENANT],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,'Sonda explain',$3,'dono','ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${(Date.now() + 2).toString().slice(-8)}`],
      );
      pessoaId = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1,$2,$3,'ativa') RETURNING id`,
        [TENANT, AGENT, pessoaId],
      );
      conversaId = conv.rows[0]!.id;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1,$2,$3,'in','texto','volume','{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;

      // ── HISTÓRICO. Row LEGADA (turn_id NULL) — é o que a retenção de 30 dias
      //    deixa na tabela, e é o corpo contra o qual o Seq Scan é medido.
      await c.query(
        `INSERT INTO outbound_messages
           (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel, status, created_at)
         SELECT $1, $2, 'legado-' || g, $3, $4, 'text', 'sent', now() - make_interval(days => 5)
           FROM generate_series(1, $5) g`,
        [TENANT, AGENT, conversaId, inboundId, LEGADAS],
      );

      // ── TRABALHO EM VOO. Precisa de turno (FK composta da 121), então os
      //    turnos vêm primeiro, num INSERT só.
      const turnos = await c.query<{ id: string }>(
        `WITH novas AS (
           INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
           SELECT $1, $2, $3, 'in', 'texto', 'volume ' || g, '{}'::jsonb
             FROM generate_series(1, $4) g
           RETURNING id
         )
         INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, state_version)
         SELECT $1, $2, novas.id, $3, 'outbound_pending', 1, 4 FROM novas
         RETURNING id`,
        [TENANT, AGENT, conversaId, EM_VOO],
      );
      const ids = turnos.rows.map((r) => r.id);
      // Um terço em cada família: claim vencido (takeover), pendente vencido,
      // e incerto. As três varreduras precisam ter o que encontrar.
      await c.query(
        `INSERT INTO outbound_messages
           (tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
            status, delivery_outcome, attempt, turn_id, sequence_in_turn,
            payload_version, payload_type, payload_json, payload_hash,
            logical_dedupe_key, provider_idempotency_key, next_attempt_at,
            claimed_by, claim_token, lease_expires_at, created_at)
         SELECT $1, $2, 'voo-' || t.ord, $3, $4, 'text',
                CASE t.ord % 3 WHEN 0 THEN 'sending' WHEN 1 THEN 'retryable'
                               ELSE 'delivery_unknown' END,
                CASE t.ord % 3 WHEN 2 THEN 'timeout_unknown' ELSE NULL END,
                1, t.id, 0, 1, 'text',
                '{"type":"text","text":"volume"}'::jsonb,
                repeat('a', 64),
                'ldk-voo-' || t.ord, '3EB0' || lpad(to_hex(t.ord), 18, '0'),
                now() - make_interval(secs => 60),
                CASE t.ord % 3 WHEN 0 THEN 'worker-morto' ELSE NULL END,
                CASE t.ord % 3 WHEN 0 THEN gen_random_uuid() ELSE NULL END,
                CASE t.ord % 3 WHEN 0 THEN now() - make_interval(secs => 30) ELSE NULL END,
                now() - make_interval(secs => 7200)
           FROM unnest($5::uuid[]) WITH ORDINALITY AS t(id, ord)`,
        [TENANT, AGENT, conversaId, inboundId, ids],
      );

      // Sem estatísticas frescas o planejador decide com um palpite, e o
      // EXPLAIN não fala do banco que existe.
      await c.query('ANALYZE outbound_messages');
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM outbound_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM conversas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
      // Devolve as estatísticas ao estado das outras suítes.
      await c.query('ANALYZE outbound_messages');
    } finally {
      c.release();
    }
    await pool.end();
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 5 — A VARREDURA DE TAKEOVER É INDEXADA.
  //
  // Isolada do gate de backoff de propósito: no `OR` completo o planejador
  // pode montar um `BitmapOr` de dois índices, e um `BitmapOr` cujo segundo
  // ramo virou filtro de heap ainda "usa índice". A pergunta que a #632 fez
  // tem uma resposta só quando o predicado está sozinho.
  // ═══════════════════════════════════════════════════════════════════════

  it('a varredura de takeover usa idx_outbound_messages_expired_claims, e não o fallback', async () => {
    const plano = await explainStatement(takeoverOnlyStatement(TENANT, AGENT, 200));
    expect(temSeqScanNoOutbox(plano)).toBe(false);
    expect(indices(plano)).toContain('idx_outbound_messages_expired_claims');
    // A asserção que de fato discrimina: sem o índice da 131 o planejador
    // escolhe ESTE, e o teste ficaria verde só com a checagem de Seq Scan.
    expect(indices(plano)).not.toContain(FALLBACK);
  });

  it('a varredura entregável completa (backoff OR takeover) cobre os dois ramos por índice próprio', async () => {
    const plano = await explainStatement(deliverableStatement(TENANT, AGENT, 200));
    expect(temSeqScanNoOutbox(plano)).toBe(false);
    // Os DOIS ramos do `OR` têm de estar cobertos: o de #121 e o novo de #131.
    const usados = indices(plano);
    expect(usados).toContain('idx_outbound_messages_ready');
    expect(usados).toContain('idx_outbound_messages_expired_claims');
    expect(usados).not.toContain(FALLBACK);
  });

  it('a fila de reconciliação usa idx_outbound_messages_reconcile, sem Seq Scan', async () => {
    const plano = await explainStatement(reconciliationStatement(TENANT, AGENT, 200));
    expect(temSeqScanNoOutbox(plano)).toBe(false);
    expect(indices(plano)).toContain('idx_outbound_messages_reconcile');
  });

  it('o dispatcher cross-tenant resolve o ramo de takeover pelo índice da 131', async () => {
    // Sem igualdade em `tenant_id` para ancorar a sondagem — é o regime que
    // motivou pôr `lease_expires_at` na FRENTE do índice da 131, o mesmo
    // diagnóstico que a 114 fez para `agent_turns`.
    const plano = await explainStatement(scopesWithWorkStatement());
    expect(temSeqScanNoOutbox(plano)).toBe(false);
    // MEDIDO: sem o índice da 131 este plano continua sem Seq Scan (ele cai em
    // `outbound_messages_turn_sequence_uq`), então só a exigência do índice
    // NOMEADO torna esta sonda capaz de ficar vermelha.
    expect(indices(plano)).toContain('idx_outbound_messages_expired_claims');
  });
});

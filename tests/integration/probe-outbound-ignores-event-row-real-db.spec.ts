/**
 * Issue #577 — a sonda sintética NÃO pode aceitar o placeholder do flush como
 * resposta do agente.
 *
 * ## Por que este arquivo existe
 *
 * A #577 admitiu `tipo='evento'` no CHECK de `mensagens`, e com isso a row de
 * `flushUnconfirmedToolSummaries()` passou a NASCER. Ela tem `direcao='out'` e
 * `metadata->>'in_reply_to'` — os dois campos pelos quais `hasOutboundReply()`
 * e `latestOutboundText()` procuram a resposta do agente. Mas ela existe
 * PORQUE o turno terminou SEM outbound: é o oposto do que a sonda afirma.
 *
 * Sem o filtro por tipo, um turno que estourou o teto de iterações e não
 * respondeu NADA passaria no LIVENESS (§1.4b), e o LLM-judge receberia `''`
 * como "texto da resposta". Ou seja: a correção do CHECK INTRODUZIRIA um
 * falso-positivo na sonda — o defeito nasce da própria correção, e é por isso
 * que este teste acompanha aquela.
 *
 * ## Por que não reaproveita `synthetic-probe.spec.ts`
 *
 * Aquele arquivo semeia por `seedTurn()`, que hoje falha em
 * `conversas_pessoa_id_fkey` (defeito de fixture pré-existente, alheio à
 * #577). Semear aqui o mínimo — pessoa, conversa, mensagens — é o que permite
 * exercitar as funções REAIS sem herdar aquele vermelho.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PROBE_TENANT_ID, PROBE_AGENT_ID } from '@/probe/constants.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let pessoa_id: string;
let conversa_id: string;
const criadas: string[] = [];

/** Entrada do run + a row que o flush cria quando o turno acaba sem outbound. */
async function semearTurnoSemOutbound(): Promise<string> {
  const inbound_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1,$2,$3,$4,'in','texto','oi','{}'::jsonb)`,
    [inbound_id, PROBE_TENANT_ID, PROBE_AGENT_ID, conversa_id],
  );
  criadas.push(inbound_id);

  const evento_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, ferramentas_chamadas)
     VALUES ($1,$2,$3,$4,'out','evento','',$5::jsonb,$6::jsonb)`,
    [
      evento_id,
      PROBE_TENANT_ID,
      PROBE_AGENT_ID,
      conversa_id,
      JSON.stringify({ in_reply_to: inbound_id, event_only: true, flush_reason: 'iteration_cap' }),
      JSON.stringify([{ nome: 'remember_safe_fact' }]),
    ],
  );
  criadas.push(evento_id);
  return inbound_id;
}

d('#577 — o placeholder do flush não conta como resposta para a sonda', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
      PROBE_TENANT_ID,
    ]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [PROBE_AGENT_ID, PROBE_TENANT_ID],
    );
    pessoa_id = randomUUID();
    await pool.query(
      `INSERT INTO pessoas (id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,$3,'probe-577','+5511999990577','dono','ativa')`,
      [pessoa_id, PROBE_TENANT_ID, PROBE_AGENT_ID],
    );
    conversa_id = randomUUID();
    await pool.query(
      `INSERT INTO conversas (id, tenant_id, agent_id, pessoa_id) VALUES ($1,$2,$3,$4)`,
      [conversa_id, PROBE_TENANT_ID, PROBE_AGENT_ID, pessoa_id],
    );
  }, 30_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversa_id]);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa_id]);
    await pool.end();
  });

  it('LIVENESS é FALSO quando só existe a row de `evento`', async () => {
    const { hasOutboundReply } = await import('@/probe/queries.js');
    const inbound_id = await semearTurnoSemOutbound();

    expect(
      await hasOutboundReply(inbound_id),
      'a row do flush tem direcao=out e in_reply_to, mas existe PORQUE o turno não ' +
        'respondeu — aceitá-la faz a sonda dar verde sobre silêncio do agente',
    ).toBe(false);
  }, 30_000);

  it('`latestOutboundText` não devolve o conteúdo vazio do placeholder', async () => {
    const { latestOutboundText } = await import('@/probe/queries.js');
    const inbound_id = await semearTurnoSemOutbound();

    const texto = await latestOutboundText(inbound_id);
    expect(
      texto,
      'devolver string vazia daria ao LLM-judge uma resposta vazia como se fosse do agente',
    ).toBeNull();
  }, 30_000);

  it('CONTROLE: com um outbound REAL, as duas funções enxergam a resposta', async () => {
    const { hasOutboundReply, latestOutboundText } = await import('@/probe/queries.js');
    const inbound_id = await semearTurnoSemOutbound();

    const real_id = randomUUID();
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1,$2,$3,$4,'out','texto','resposta de verdade',$5::jsonb)`,
      [
        real_id,
        PROBE_TENANT_ID,
        PROBE_AGENT_ID,
        conversa_id,
        JSON.stringify({ in_reply_to: inbound_id }),
      ],
    );
    criadas.push(real_id);

    expect(await hasOutboundReply(inbound_id)).toBe(true);
    expect(await latestOutboundText(inbound_id)).toBe('resposta de verdade');
  }, 30_000);
});

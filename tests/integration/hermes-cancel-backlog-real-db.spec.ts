/**
 * P04.5b.2b (spec §8.2.5) — a PRIMITIVA de descarte administrativo de um turno
 * retido, contra PostgreSQL REAL.
 *
 * ─── Por que uma primitiva `...InTx`, e não uma operação own-transaction ────
 *
 * O descarte acontece DENTRO da transação que retoma a conversa: o §8.2.5 manda
 * "fechar a obrigação de automação dos turnos retidos" como parte do comando de
 * resume, e o watermark é capturado sob o mesmo lock. `transitionTurn` abre
 * transação própria (`runTransitionTx` → `withTx`), então não serve — quem serve
 * é `runTransitionOnExecutor`, que aceita o executor do caller. O precedente
 * exato é `completeRecoveredOutboundTurnInTx`, e dele vem também a regra que o
 * caso 7 prende: **uma primitiva `...InTx` não pode devolver conflito e deixar o
 * caller comitar o resto** — conflito aqui é rollback obrigatório.
 *
 * ─── Por que a transição passa pelo CONTRATO, e não por UPDATE cru ─────────
 *
 * O cabeçalho de `turn-repos.ts` estabelece que nenhum caller escreve `status`
 * direto; toda transição valida o par (from, to, outcome) antes de tocar o
 * banco. `recoverExpiredStreamClaims` escreve direto, mas é recuperação interna
 * e a justificativa dele é sobre ordem de lock, não sobre dispensar o contrato —
 * usá-lo como licença distorceria o precedente.
 *
 * ─── Por que a métrica é ADIADA (caso 10) ─────────────────────────────────
 *
 * `runTransitionOnExecutor` não emite contador: quem emite é `runTransitionTx`,
 * DEPOIS do commit dele. Por isso existe `recordRecoveredOutboundTurnCommitted`.
 * Emitir dentro da transação faria `maia_turn_transitions_total` contar
 * descartes que o rollback desfez — a métrica mentiria exatamente no incidente
 * em que ela seria consultada.
 *
 * Skipped sem `TEST_DB_URL`, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'cancel-p045b2-tenant-a';
const A_A = 'cancel-p045b2-agent-a';
/** Segundo agente do MESMO tenant — o eixo que `agents.id` global esconde. */
const A_A2 = 'cancel-p045b2-agent-a2';
/** Segundo tenant — o eixo que a `stream_key` derivada esconde. */
const T_B = 'cancel-p045b2-tenant-b';
const A_B = 'cancel-p045b2-agent-b';

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inA2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A2 }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

async function ensureScopes(): Promise<void> {
  for (const [t, a] of [
    [T_A, A_A],
    [T_A, A_A2],
    [T_B, A_B],
  ] as const) {
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING`, [t]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`,
      [a, t],
    );
  }
}

/** Turno retido numa stream, com sequência de ingresso escolhida. */
async function mkTurno(args: {
  tenant?: string;
  agent?: string;
  status?: string;
  seq?: number;
}): Promise<{ id: string; state_version: number }> {
  const tenant = args.tenant ?? T_A;
  const agent = args.agent ?? A_A;
  const seq = args.seq ?? 1;
  const key = streamKey();
  await pool.query(
    `INSERT INTO agent_stream_sequences
       (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, agent_id, stream_key) DO NOTHING`,
    [tenant, agent, key, seq],
  );
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb,NULL)`,
    [mensagem_id, tenant, agent],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns
       (id, tenant_id, agent_id, status, representative_message_id,
        stream_key, stream_key_version, first_ingress_seq, last_ingress_seq)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7)`,
    [id, tenant, agent, args.status ?? 'queued', mensagem_id, key, seq],
  );
  return { id, state_version: 0 };
}

async function ler(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

d('P04.5b.2b — descarte administrativo de um turno retido (DB real)', () => {
  const repos = moduloDeProducao(() => import('@/db/repositories/turn-repos.js'));
  const client = moduloDeProducao(() => import('@/db/client.js'));
  const metricas = moduloDeProducao(() => import('../../src/lib/metrics.js'));

  /** Chama a primitiva dentro de uma transação, como o resume fará. */
  const cancelar = (
    turn: { id: string; state_version: number },
    escopo = inA,
  ): Promise<unknown> =>
    escopo(() =>
      client().withTx((tx) =>
        repos().cancelHeldBacklogTurnInTx(tx, {
          turn_id: turn.id,
          expected_version: turn.state_version,
        }),
      ),
    );

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureScopes();
  }, 30_000);

  afterAll(async () => {
    for (const t of [T_A, T_B]) {
      await pool?.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool?.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_A2, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    for (const t of [T_A, T_B]) {
      await pool.query(`DELETE FROM agent_stream_sequences WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM agent_turns WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM mensagens WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
    metricas()._resetForTests();
  });

  // ─── As três origens que a spec enumera ─────────────────────────────────

  for (const origem of ['queued', 'retryable', 'received'] as const) {
    it(`descarta um turno \`${origem}\` em ignored/operator_cancelled`, async () => {
      const t = await mkTurno({ status: origem });
      await cancelar(t);
      const depois = await ler(t.id);
      expect(depois['status']).toBe('ignored');
      expect(depois['outcome']).toBe('operator_cancelled');
      // Terminal carimba `completed_at` — é o que o STATE_TIMESTAMP faz, e o
      // que separa um turno descartado de um turno esquecido.
      expect(depois['completed_at']).not.toBeNull();
    });
  }

  it('4. RECUSA um turno `running` — a outra ponta, e a que importa', async () => {
    // `running → ignored` é aresta AUTOMÁTICA, então a primitiva PODERIA
    // aceitá-la por descuido ao montar as origens. Cancelar administrativamente
    // um turno EM EXECUÇÃO é o oposto do "sem execução/efeito pendente" da spec,
    // e a recusa tem de ser RUIDOSA: primitiva `...InTx` não devolve conflito
    // silencioso.
    const t = await mkTurno({ status: 'running' });
    await expect(cancelar(t)).rejects.toThrow(
      `held_backlog_cancellation_conflict:state_mismatch:${t.id}`,
    );
    expect((await ler(t.id))['status']).toBe('running');
  });

  it('5. RECUSA por CAS quando a versão esperada está velha', async () => {
    const t = await mkTurno({});
    await pool.query(`UPDATE agent_turns SET state_version = state_version + 1 WHERE id = $1`, [
      t.id,
    ]);
    await expect(cancelar(t)).rejects.toThrow(
      `held_backlog_cancellation_conflict:state_mismatch:${t.id}`,
    );
    expect((await ler(t.id))['status']).toBe('queued');
  });

  it('6. incrementa `state_version` e NÃO gasta tentativa', async () => {
    // `attempt_count` conta EXECUÇÕES. Um descarte administrativo não executou
    // nada, e gastar tentativa aqui empurraria para a DLQ um turno que a
    // plataforma nunca tentou responder.
    const t = await mkTurno({});
    // A posse é SEMEADA de propósito. Sem isso `claim_token` já nasce nulo e a
    // asserção abaixo passaria mesmo que o `clearClaim` sumisse do patch — a
    // mutação que o remove sobreviveria, e o teste afirmaria uma garantia
    // (#504, "a posse morre com a tentativa") que não estaria prendendo nada.
    await pool.query(
      `UPDATE agent_turns
          SET claim_token = $2, lease_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [t.id, randomUUID()],
    );
    await cancelar(t);
    const depois = await ler(t.id);
    expect(Number(depois['state_version'])).toBe(1);
    expect(Number(depois['attempt_count'])).toBe(0);
    expect(depois['claim_token']).toBeNull();
    expect(depois['lease_expires_at']).toBeNull();
  });

  it('7. ROLLBACK da transação externa desfaz o descarte', async () => {
    // A garantia que torna o descarte atômico com a retomada: se o resume
    // falhar depois de cancelar, o backlog volta intacto. Sem isso, um resume
    // abortado deixaria mensagens descartadas e a conversa ainda em `human`.
    const t = await mkTurno({});
    await expect(
      inA(() =>
        client().withTx(async (tx) => {
          await repos().cancelHeldBacklogTurnInTx(tx, {
            turn_id: t.id,
            expected_version: t.state_version,
          });
          throw new Error('aborta de proposito');
        }),
      ),
    ).rejects.toThrow('aborta de proposito');
    const depois = await ler(t.id);
    expect(depois['status']).toBe('queued');
    expect(depois['outcome']).toBeNull();
  });

  // ─── Isolamento, nos DOIS eixos (C41) ───────────────────────────────────

  it('8. não alcança turno de outro TENANT', async () => {
    const alheio = await mkTurno({ tenant: T_B, agent: A_B });
    // `not_found`, e NÃO `state_mismatch`: fora do escopo o turno é invisível,
    // não "existe com outro estado". Afirmar o código específico é o que separa
    // isolamento REAL de um throw qualquer — inclusive do `TypeError` que este
    // caso engoliria se a assertiva fosse só `toThrow()`.
    await expect(cancelar(alheio, inA)).rejects.toThrow(
      `held_backlog_cancellation_conflict:not_found:${alheio.id}`,
    );
    expect((await ler(alheio.id))['status']).toBe('queued');
    // A outra metade, sem a qual o caso seria VÁCUO: o dono alcança. Sem ela,
    // um turno que ninguém conseguisse cancelar — status errado na fixture,
    // por exemplo — faria a recusa acima passar por engano.
    await cancelar(alheio, inB);
    expect((await ler(alheio.id))['status']).toBe('ignored');
  });

  it('9. não alcança turno de outro AGENTE do mesmo tenant', async () => {
    const vizinho = await mkTurno({ tenant: T_A, agent: A_A2 });
    await expect(cancelar(vizinho, inA)).rejects.toThrow(
      `held_backlog_cancellation_conflict:not_found:${vizinho.id}`,
    );
    expect((await ler(vizinho.id))['status']).toBe('queued');
    await cancelar(vizinho, inA2);
    expect((await ler(vizinho.id))['status']).toBe('ignored');
  });

  // ─── A métrica adiada ───────────────────────────────────────────────────

  it('10. a métrica NÃO é emitida dentro da transação — só depois do commit', async () => {
    const t = await mkTurno({});
    await cancelar(t);
    const durante = await metricas().renderPrometheus();
    // A agulha é a MESMA das duas metades, de propósito. A primeira versão
    // procurava `to="ignored",outcome="operator_cancelled"` — ordem que o
    // renderizador NUNCA produz, porque `key()` ordena os rótulos
    // alfabeticamente (`from`, `outcome`, `to`). A asserção não podia falhar, e
    // a mutação que emitia o contador DENTRO da transação sobreviveu a ela.
    // Usar a mesma agulha nos dois lados torna o par verificável: ausente
    // antes do commit, presente depois.
    expect(durante).not.toContain('outcome="operator_cancelled"');

    repos().recordBacklogCancellationCommitted({ cancelados: 1 });
    const depois = await metricas().renderPrometheus();
    expect(depois).toContain('outcome="operator_cancelled"');
  });

  it('11. resume que não descartou nada NÃO cria série zerada', async () => {
    // `incCounter(nome, labels, 0)` CRIA a chave com valor 0, então sem a
    // guarda um resume que não descartou nada passaria a publicar uma série
    // permanente em zero. Um operador lendo o painel veria a métrica de
    // cancelamento administrativo existir para conversas onde ela nunca
    // ocorreu — ruído que se parece com sinal.
    repos().recordBacklogCancellationCommitted({ cancelados: 0 });
    expect(await metricas().renderPrometheus()).not.toContain(
      'outcome="operator_cancelled"',
    );
  });
});

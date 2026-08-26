/**
 * Issue #625 (fatia B da #505) — EXCLUSÃO de no máximo um turno ativo por
 * stream, contra PostgreSQL REAL (migrations 120 + 122 + 124).
 *
 * ─── Por que nada aqui pode ser dublê ─────────────────────────────────────
 *
 * O objeto sob teste é uma CONSTRAINT DE BANCO. Quem decide o vencedor de duas
 * réplicas disputando a mesma stream é o índice único parcial
 * `agent_turns_stream_active_uq` — não a aplicação, que nem sabe que perdeu até
 * o `23505` voltar. Um harness que simulasse o claim com o próprio SQL passaria
 * feliz com o índice DERRUBADO: ele estaria provando o harness, não a
 * invariante. Por isso toda entrada aqui é pelo repositório de produção
 * (`agentTurnsRepo.claimNextEligibleTurn`) e pelo `beginTurnExecution` do runtime.
 *
 * A segunda metade da fatia — recuperar claims EXPIRADOS dentro da transação —
 * é igualmente inauditável fora do banco: ela depende de `now()` do PostgreSQL
 * e do lock de linha, e ambos somem num mock.
 *
 * O que se prova:
 *   1. dois turnos DIFERENTES da mesma stream: exatamente um vira `claimed`;
 *   2. a corrida CONCORRENTE (2, 10 e 25 réplicas) sobre turnos distintos da
 *      mesma stream converge para UM turno ativo;
 *   3. o perdedor recebe `stream_busy` — motivo distinto de `not_eligible`;
 *   4. claim EXPIRADO é recuperado DENTRO da transação: o sucessor entra e o
 *      turno morto volta a `retryable` (sem sweeper, sem esperar ciclo);
 *   5. a recuperação preserva a forense (`claim_token`, `claimed_by`) e NÃO
 *      gasta tentativa;
 *   6. streams DISTINTAS do mesmo (tenant, agent) claimam em paralelo — sem
 *      lock global por tenant, agente ou fila;
 *   7. a MESMA `stream_key` em tenants diferentes NÃO compete (o escopo é parte
 *      da chave do índice);
 *   8. turno anterior ao protocolo (`stream_key IS NULL`) fica fora da exclusão;
 *   9. o takeover do MESMO turno (regressão de #504) continua funcionando;
 *  10. `outbound_pending` NÃO ocupa a stream — o outbox não prende a conversa;
 *  11. `beginTurnExecution` (o call site REAL de produção) devolve
 *      `reason: 'stream_busy'`;
 *  12. as duas rows de `audit_log` (`turn_stream_busy`,
 *      `turn_stream_claim_recovered`) são de fato escritas pelo call site.
 *
 * ─── Interação com a fatia C (#626, head-of-line) ─────────────────────────
 *
 * Depois da #626 o claim ganhou uma condição ANTERIOR ao índice: um turno só é
 * reivindicável quando não existe turno anterior não terminal na mesma stream
 * (`first_ingress_seq` menor). Com sequências DISTINTAS, o turno posterior é
 * recusado no `WHERE` — como `not_head` — e o índice desta fatia nunca chega a
 * ser consultado. O arquivo passaria verde sem o índice de pé, provando a fatia
 * errada.
 *
 * Por isso os casos que medem a EXCLUSÃO usam `first_ingress_seq` IGUAL nos
 * turnos concorrentes. Não é conveniência de teste: é a única configuração em
 * que o head-of-line não tem o que ordenar (a comparação é `<`, estrita) e a
 * decisão volta a ser inteiramente do índice — que é o objeto desta suíte.
 * Sequências iguais na mesma stream são um estado REAL, produzido por backfill
 * ou replay manual, e é justamente nele que a metade estrutural continua sendo
 * a única proteção. Os casos com sequências distintas — e as recusas
 * `not_head`/`stream_blocked` — vivem em
 * `tests/integration/turn-head-of-line-real-db.spec.ts`.
 *
 * Skipped sem TEST_DB_URL, como as demais suítes de DB real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Ids NAMESPACED — `agents.id` é PK global e outras suítes semeiam a mesma base.
const T_A = 'excl625-tenant-a';
const A_A = 'excl625-agent-a';
const T_B = 'excl625-tenant-b';
const A_B = 'excl625-agent-b';

const LEASE_MS = 60_000;

let pool: pg.Pool;

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_A, agent_id: A_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: T_B, agent_id: A_B }, fn);

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [id, tenant, agent],
  );
  return id;
}

/**
 * Turno `received` numa stream NOMEADA.
 *
 * A `stream_key` é passada de fora — e não derivada — de propósito: os casos
 * decisivos deste arquivo precisam de duas TENANTS carregando a MESMA chave
 * literal, e a derivação canônica (que embute tenant e agent no material) nunca
 * produziria isso. Forjar a chave é justamente o que a sonda nº 3 exige: se o
 * índice não trouxesse `tenant_id`/`agent_id` na chave, as duas tenants
 * passariam a competir, e nenhum teste que dependa da derivação conseguiria
 * mostrar isso.
 *
 * A CRIAÇÃO continua sendo a de produção (`ensureTurnForMessage`); só as
 * colunas de shadow são carimbadas depois, como o ingresso da fatia A as
 * carimbaria. Nada aqui reescreve o claim.
 */
async function turnInStream(args: {
  tenant: string;
  agent: string;
  stream_key: string | null;
  seq: number;
  repos: typeof import('../../src/db/repositories.js');
}): Promise<string> {
  const mensagem_id = await mkInbound(args.tenant, args.agent);
  const run = args.tenant === T_A ? inA : inB;
  const turn = await run(() =>
    args.repos.agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: args.tenant,
      agent_id: args.agent,
      conversa_id: null,
      channel_id: null,
    }),
  );
  if (args.stream_key !== null) {
    await pool.query(
      `UPDATE agent_turns
          SET stream_key = $2, stream_key_version = 1,
              first_ingress_seq = $3, last_ingress_seq = $3
        WHERE id = $1`,
      [turn.id, args.stream_key, args.seq],
    );
  }
  return turn.id;
}

async function readTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turn_id]);
  return r.rows[0] as Record<string, unknown>;
}

/** Empurra a lease do turno para o PASSADO, simulando um dono morto. */
async function expireLease(turn_id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
}

/** Quantos turnos desta stream estão OCUPANDO-A agora? A resposta tem de ser 1. */
async function activeInStream(tenant: string, agent: string, key: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM agent_turns
      WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3
        AND status IN ('claimed', 'running')`,
    [tenant, agent, key],
  );
  return (r.rows[0] as { n: number }).n;
}

const streamKey = (): string => `v1:${randomUUID().replace(/-/g, '').repeat(2)}`;

d('#625 — exclusão de um turno ativo por stream (DB real)', () => {
  const repos = moduloDeProducao(() => import('../../src/db/repositories.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(T_A, A_A);
    await ensureTenantAgent(T_B, A_B);
  }, 30_000);

  afterAll(async () => {
    await pool?.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool?.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[A_A, A_B]]);
    await pool?.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[T_A, T_B]]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM agent_turn_inputs WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM agent_turns WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM mensagens WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1)`, [[T_A, T_B]]);
  });

  // ─── 1. O caso central da fatia ────────────────────────────────────────────

  it('dois turnos DIFERENTES da mesma stream: o segundo claim é recusado como stream_busy', async () => {
    const key = streamKey();
    // Sequências IGUAIS: sem ordem a impor, o head-of-line (#626) deixa passar
    // e quem decide é o índice — ver o cabeçalho do arquivo.
    const t1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const t2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    const first = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t1, worker_id: 'replica-1', lease_ms: LEASE_MS }),
    );
    const second = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t2, worker_id: 'replica-2', lease_ms: LEASE_MS }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // `stream_busy`, e NÃO `not_eligible`: o turno estava perfeitamente
    // elegível — quem barrou foi a STREAM. Colapsar os dois motivos apagaria a
    // única forma de ver, na métrica, uma conversa serializando.
    expect(second.ok === false && second.reason).toBe('stream_busy');
    expect(await activeInStream(T_A, A_A, key)).toBe(1);
    // O perdedor não foi corrompido: continua `received`, sem tentativa gasta.
    const perdedor = await readTurn(t2);
    expect(perdedor['status']).toBe('received');
    expect(Number(perdedor['attempt_count'])).toBe(0);
  });

  for (const replicas of [2, 10, 25]) {
    it(`${replicas} réplicas claimando turnos DISTINTOS da mesma stream → 1 turno ativo`, async () => {
      const key = streamKey();
      const turnos: string[] = [];
      for (let i = 0; i < replicas; i++) {
        turnos.push(
          await turnInStream({
            tenant: T_A,
            agent: A_A,
            stream_key: key,
            // Todas na MESMA sequência: o que se mede aqui é o índice, não a
            // ordem (#626). Ver o cabeçalho do arquivo.
            seq: 1,
            repos: repos(),
          }),
        );
      }

      const results = await Promise.all(
        turnos.map((turn_id, i) =>
          inA(() =>
            repos().agentTurnsRepo.claimNextEligibleTurn({
              turn_id,
              worker_id: `replica-${i}`,
              lease_ms: LEASE_MS,
            }),
          ),
        ),
      );

      const vencedores = results.filter((r) => r.ok);
      expect(vencedores).toHaveLength(1);
      expect(await activeInStream(T_A, A_A, key)).toBe(1);
      // Todo perdedor tem de dizer POR QUE perdeu, e o motivo é a stream.
      // `not_found` aqui seria bug de escopo; `not_eligible` seria o índice
      // não tendo agido e o próprio turno tendo se recusado.
      for (const r of results.filter((x) => !x.ok)) {
        expect(r.ok === false && r.reason).toBe('stream_busy');
      }
    }, 30_000);
  }

  // ─── 2. A metade TEMPORAL: recuperação do claim expirado ───────────────────

  it('claim EXPIRADO é recuperado DENTRO da transação e a stream destrava', async () => {
    const key = streamKey();
    const morto = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Mesma sequência: isola a metade TEMPORAL do head-of-line. Com sequência
    // MAIOR o sucessor seria recusado como `not_head` ANTES de o índice opinar,
    // e este caso deixaria de medir a recuperação — o cenário com sequências
    // distintas está em `turn-head-of-line-real-db.spec.ts`.
    const sucessor = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    // Um worker reivindica e MORRE: a lease vence e ninguém a renova.
    expect(
      (await inA(() =>
        repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: morto, worker_id: 'zumbi', lease_ms: LEASE_MS }),
      )).ok,
    ).toBe(true);
    const antes = await readTurn(morto);
    await expireLease(morto);

    // Sem a recuperação DENTRO da transação, este claim bate no índice ocupado
    // pelo morto e a stream fica bloqueada PARA SEMPRE — nenhum sweeper corre
    // aqui, de propósito.
    const claim = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({
        turn_id: sucessor,
        worker_id: 'sucessor',
        lease_ms: LEASE_MS,
      }),
    );
    expect(claim.ok).toBe(true);
    // #627 mudou o CONTEÚDO deste campo de `string[]` para o objeto de promoção
    // (`StreamClaimRecovery`): o turno recuperado precisa ser RE-ARMADO, e o
    // wake-up exige o `representative_message_id` da linha recuperada. A
    // afirmação da fatia B é a mesma; o payload do sinal veio junto.
    expect(claim.recovered_stream_claims?.map((r) => r.turn_id)).toEqual([morto]);
    expect(claim.recovered_stream_claims?.[0]?.representative_message_id).toBeTruthy();

    const recuperado = await readTurn(morto);
    // Devolvido à fila, não descartado: o varredor de recovery já procura
    // exatamente por isto (`retryable` com `next_attempt_at` vencido).
    expect(recuperado['status']).toBe('retryable');
    expect(recuperado['next_attempt_at']).not.toBeNull();
    expect(recuperado['last_error_code']).toBe('stream_lease_expired');
    // Forense PRESERVADA — a pergunta "quem tinha este turno quando o pod
    // morreu?" continua respondível.
    expect(recuperado['claim_token']).toBe(antes['claim_token']);
    expect(recuperado['claimed_by']).toBe('zumbi');
    // E a tentativa NÃO foi gasta pelo crash: contar de novo mandaria um turno
    // inocente para a DLQ por causa de um deploy.
    expect(Number(recuperado['attempt_count'])).toBe(Number(antes['attempt_count']));
    // `state_version` avança: qualquer CAS otimista do zumbi passa a falhar.
    expect(Number(recuperado['state_version'])).toBeGreaterThan(Number(antes['state_version']));

    expect(await activeInStream(T_A, A_A, key)).toBe(1);
  });

  it('lease VIVA não é recuperada — só a vencida (a recuperação não é um confisco)', async () => {
    const key = streamKey();
    const vivo = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Sequência igual: quem recusa tem de ser o índice, não o head-of-line.
    const outro = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: vivo, worker_id: 'dono-vivo', lease_ms: LEASE_MS }),
    );
    const negado = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: outro, worker_id: 'intruso', lease_ms: LEASE_MS }),
    );

    expect(negado.ok).toBe(false);
    expect(negado.ok === false && negado.reason).toBe('stream_busy');
    expect(negado.recovered_stream_claims).toBeUndefined();
    expect((await readTurn(vivo))['status']).toBe('claimed');
  });

  it('takeover do MESMO turno com lease vencida continua funcionando (regressão #504)', async () => {
    const key = streamKey();
    const t = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const primeiro = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    await expireLease(t);
    const segundo = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t, worker_id: 'w2', lease_ms: LEASE_MS }),
    );

    expect(segundo.ok).toBe(true);
    // O takeover é do MESMO turno: a chave do índice não muda, então não há
    // conflito a resolver — e o turno não pode ter sido "recuperado" para
    // `retryable` no caminho, o que apagaria a posse que ele acabou de ganhar.
    expect(segundo.recovered_stream_claims).toBeUndefined();
    expect(
      primeiro.ok && segundo.ok && segundo.claim.claim_token !== primeiro.claim.claim_token,
    ).toBe(true);
    expect(await activeInStream(T_A, A_A, key)).toBe(1);
  });

  // ─── 3. Paralelismo: a exclusão é POR STREAM, não global ───────────────────

  it('streams DISTINTAS do mesmo (tenant, agent) claimam em paralelo — sem lock global', async () => {
    const chaves = Array.from({ length: 8 }, () => streamKey());
    const turnos = await Promise.all(
      chaves.map((key) =>
        turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() }),
      ),
    );

    const results = await Promise.all(
      turnos.map((turn_id, i) =>
        inA(() =>
          repos().agentTurnsRepo.claimNextEligibleTurn({
            turn_id,
            worker_id: `w-${i}`,
            lease_ms: LEASE_MS,
          }),
        ),
      ),
    );

    // TODAS vencem. Um lock por tenant, por agente ou por fila deixaria uma só
    // passar — que é o "gargalo global" que a issue-mãe proíbe explicitamente.
    expect(results.every((r) => r.ok)).toBe(true);
    for (const key of chaves) expect(await activeInStream(T_A, A_A, key)).toBe(1);
  }, 30_000);

  it('a MESMA stream_key em TENANTS diferentes não compete', async () => {
    // O escopo é parte da CHAVE do índice. Sem `tenant_id`/`agent_id` nela, o
    // turno da tenant A bloquearia a conversa da tenant B — e o bloqueio seria
    // invisível, porque nada na linha de B diria que a causa é de A.
    const key = streamKey();
    const a = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    const b = await turnInStream({ tenant: T_B, agent: A_B, stream_key: key, seq: 1, repos: repos() });

    const rA = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: a, worker_id: 'wa', lease_ms: LEASE_MS }),
    );
    const rB = await inB(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: b, worker_id: 'wb', lease_ms: LEASE_MS }),
    );

    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(await activeInStream(T_A, A_A, key)).toBe(1);
    expect(await activeInStream(T_B, A_B, key)).toBe(1);
  });

  it('turno anterior ao protocolo (stream_key NULL) fica FORA da exclusão', async () => {
    // Sem backfill (decisão da fatia A), turnos históricos têm `stream_key`
    // NULL. Se eles entrassem no índice, TODO o histórico sem stream colapsaria
    // numa única chave e o primeiro claim travaria todos os outros.
    const t1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: null, seq: 0, repos: repos() });
    const t2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: null, seq: 0, repos: repos() });

    const r1 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t1, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    const r2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t2, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('outbound_pending NÃO ocupa a stream — o outbox não prende a conversa', async () => {
    // Decisão explícita da fatia (e da issue-mãe, que nomeia `claimed`/`running`
    // e para neles): entre `outbound_pending` e o terminal, quem finaliza é o
    // delivery worker de #506, que não disputa posse com ninguém. Prender a
    // stream aí faria uma indisponibilidade do provedor de saída parar a
    // conversa inteira.
    const key = streamKey();
    const t1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Sequência IGUAL, e aqui a escolha carrega uma decisão de projeto: para a
    // OCUPAÇÃO (esta fatia) `outbound_pending` não prende a stream, mas para a
    // ORDEM (#626) ele prende — um turno ANTERIOR em `outbound_pending` recusa
    // o posterior com `stream_blocked`. As duas coisas são verdadeiras ao mesmo
    // tempo porque respondem a perguntas diferentes; o caso da ordem está em
    // `turn-head-of-line-real-db.spec.ts`.
    const t2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t1, worker_id: 'w1', lease_ms: LEASE_MS }),
    );
    await pool.query(`UPDATE agent_turns SET status = 'outbound_pending' WHERE id = $1`, [t1]);

    const r2 = await inA(() =>
      repos().agentTurnsRepo.claimNextEligibleTurn({ turn_id: t2, worker_id: 'w2', lease_ms: LEASE_MS }),
    );
    expect(r2.ok).toBe(true);
  });

  // ─── 4. O call site REAL do runtime ────────────────────────────────────────

  it('beginTurnExecution (call site de produção) devolve reason=stream_busy', async () => {
    const { beginTurnExecution } = await import('@/runtime/turns/lifecycle.js');
    const key = streamKey();
    const t1 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Sequência igual — ver o cabeçalho do arquivo.
    const t2 = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    const handleFor = (turn_id: string) =>
      ({
        turn_id,
        status: 'received' as const,
        state_version: 0,
        attempt_count: 0,
        conversa_id: null,
        lease: null,
      }) as never;

    const primeiro = await inA(() => beginTurnExecution(handleFor(t1)));
    const segundo = await inA(() => beginTurnExecution(handleFor(t2)));

    expect(primeiro.started).toBe(true);
    expect(segundo.started).toBe(false);
    expect(segundo.started === false && segundo.reason).toBe('stream_busy');
    expect(await activeInStream(T_A, A_A, key)).toBe(1);

    // A TRILHA. Sem esta row, "esta conversa parou porque o índice barrou" e
    // "porque ninguém a reivindicou" ficam indistinguíveis no post-mortem — e
    // as duas causas têm remediações opostas. O repositório é puro-DB e não
    // audita; quem audita é `acquireTurnLease` (src/runtime/turns/lease.ts).
    const trilha = await pool.query(
      `SELECT alvo_id FROM audit_log
        WHERE tenant_id = $1 AND acao = 'turn_stream_busy' AND alvo_id = $2`,
      [T_A, t2],
    );
    expect(trilha.rows).toHaveLength(1);
  }, 30_000);

  it('a recuperação de claim expirado é AUDITADA pelo call site de produção', async () => {
    const { beginTurnExecution } = await import('@/runtime/turns/lifecycle.js');
    const key = streamKey();
    const morto = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });
    // Sequência igual — ver o cabeçalho do arquivo.
    const sucessor = await turnInStream({ tenant: T_A, agent: A_A, stream_key: key, seq: 1, repos: repos() });

    const handleFor = (turn_id: string) =>
      ({
        turn_id,
        status: 'received' as const,
        state_version: 0,
        attempt_count: 0,
        conversa_id: null,
        lease: null,
      }) as never;

    expect((await inA(() => beginTurnExecution(handleFor(morto)))).started).toBe(true);
    await expireLease(morto);
    expect((await inA(() => beginTurnExecution(handleFor(sucessor)))).started).toBe(true);

    // O estado final é IDÊNTICO ao que o varredor de recovery produziria
    // (`retryable` com `next_attempt_at` vencido). Só a trilha distingue "o
    // sweeper achou" de "o claim da stream destravou" — e essa distinção é o
    // que separa um deploy normal de uma stream que estava presa.
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND acao = 'turn_stream_claim_recovered' AND alvo_id = $2`,
      [T_A, sucessor],
    );
    expect(trilha.rows).toHaveLength(1);
    expect((trilha.rows[0] as { metadata: { recovered: string[] } }).metadata.recovered).toEqual([
      morto,
    ]);
  }, 30_000);
});

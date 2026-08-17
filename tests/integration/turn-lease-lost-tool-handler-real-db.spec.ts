/**
 * Issue #504 §Fencing — a JANELA entre o guard de entrada do dispatcher e o
 * handler da tool.
 *
 * ─── O vão que esta suíte fecha ─────────────────────────────────────────────
 *
 * `turn-lease-lost-effects-real-db.spec.ts` perde a posse ANTES de chamar
 * `dispatchTool`, então prova apenas que o guard da primeira linha existe. Mas
 * entre aquela linha e `tool.handler(...)` o dispatcher espera por, no mínimo:
 * grant do agente, pré-check do cache de idempotência, claim de aprovação
 * (que pode até notificar humanos) e a reserva atômica. A lease pode morrer em
 * QUALQUER uma dessas janelas — e o handler rodava assim mesmo, criando a
 * transação, emitindo o boleto, chamando a API externa em nome de uma
 * tentativa que o banco já tinha desautorizado.
 *
 * Uma checagem única na entrada é uma FOTOGRAFIA. O que a issue exige é um
 * fence no limite do efeito.
 *
 * ─── Como o INSTANTE da perda é escolhido sem virar espelho ─────────────────
 *
 * A perda continua sendo produzida pelo mecanismo REAL, o mesmo das outras
 * suítes: claim SQL → lease vencida → takeover por outro worker → o heartbeat
 * do dono descobre → `AbortSignal`. Nada de `markLost()` à mão.
 *
 * O que este arquivo acrescenta é o INSTANTE: o takeover é disparado de dentro
 * de `idempotencyRepo.tryReserve`, que é um await REAL do dispatcher, o último
 * antes do handler. O spy delega para a implementação de verdade — a reserva
 * acontece, e é justamente por isso que o teste também consegue exigir que ela
 * seja DESFEITA. Sem esse gancho o teste dependeria de corrida de relógio
 * (heartbeat de 400ms contra ~30ms de dispatcher) e seria flaky nas duas
 * direções.
 *
 * O caminho exercitado é o de produção inteiro: `dispatchTool` real, REGISTRY
 * real, governança real, Postgres real.
 *
 * ─── O que é observado ──────────────────────────────────────────────────────
 *
 *   1. `agent_facts` — a tool `remember_safe_fact` é `side_effect: 'write'` e
 *      persiste uma linha. Existe ou não existe.
 *   2. `idempotency_keys` — a reserva feita ANTES da revalidação não pode
 *      ficar para trás. Uma row 'failed' devolveria `idempotency_prior_failed`
 *      ao worker que TEM a lease: o fence do turno viraria negação de serviço
 *      contra o dono legítimo.
 *   3. o `ToolHandlerCtx` que o dispatcher monta — `turn.claim_token` e
 *      `turn.signal` da tentativa. Observado no call site REAL (spy sobre o
 *      handler do REGISTRY, delegando para o original), não numa cópia.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa, Conversa, PermissionProfile, Permissao } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import type { ToolHandlerCtx } from '@/tools/_registry.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';
/**
 * TTL da lease do DONO legitimo. 30s, e o numero importa.
 *
 * Era 1_500ms, e isso quebrava os casos de CONTROLE -- os que provam que, com
 * a lease VIVA, o efeito acontece normalmente. Medido no CI: o controle do
 * react-loop leva ~3.9s de corpo. Com TTL de 1.5s e heartbeat de 400ms, a
 * lease precisa ser renovada ~9 vezes DURANTE o caso, e basta UMA renovacao
 * chegar atrasada para ela morrer.
 *
 * O mecanismo e o CAS, nao falha de heartbeat -- e a primeira versao deste
 * comentario errava nisso, atribuindo a perda a `MAX_HEARTBEAT_FAILURES`.
 * Esse caminho exige o BANCO NAO RESPONDER, o que nao estava acontecendo. O
 * que acontece e: o `UPDATE` de renovacao tem `AND lease_expires_at > now()`
 * no `WHERE` (`turn-repos.ts`), entao um atraso de agendamento no Node ou de
 * round-trip no banco maior que o TTL restante faz a lease vencer ANTES de a
 * renovacao chegar; o CAS devolve zero linhas e a lease se marca perdida com
 * `token_mismatch` -- sem sucessor nenhum e com o banco saudavel. Bate com o
 * `lostReason` observado nos logs do CI.
 *
 * Sob contencao ela morre, o guard recusa o efeito, e o CONTROLE reprova com
 * `turn_ownership_lost` -- exatamente o que ele existe para provar que NAO
 * acontece. O `retry: 1` absorvia, e o vermelho so apareceu porque o bloco
 * RECUPERADOS PELA SEGUNDA TENTATIVA do reporter (#545/#566) o denunciou.
 *
 * Que a renovacao de fato escreve no banco e coberto separadamente, em
 * `tests/integration/turn-lease-heartbeat-renew-real-db.spec.ts` -- com TTL
 * curto de proposito, porque com 30s aqui os controles passariam ate se o
 * timer parasse de disparar.
 *
 * Subir NAO enfraquece as BARREIRAS, e vale registrar por que: elas nao perdem
 * a posse por expiracao. `loseOwnershipForReal()` forca o vencimento por SQL
 * (`lease_expires_at = now() - interval '1 second'`) e entao um SUCESSOR
 * reivindica -- e o proprio helper afirma `lostReason === 'token_mismatch'`,
 * isto e, takeover. Verificado por sonda: com o TTL longo tambem nas
 * barreiras, elas continuam passando. O TTL curto nao era load-bearing para
 * nada; era so um cronometro competindo com o corpo do teste.
 */
const TTL_MS = 30_000;
const HEARTBEAT_MS = 400;

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;
let entidade_id: string;
let resolvedPermission: ResolvedPermission;

const createdMensagens: string[] = [];
const createdFacts: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

function toolCtx(mensagem_id: string) {
  return {
    pessoa,
    scope: {
      entidades: [entidade_id],
      byEntity: new Map<string, ResolvedPermission>([[entidade_id, resolvedPermission]]),
    },
    conversa,
    mensagem_id,
    request_id: randomUUID(),
  };
}

async function mkInbound(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', 'texto', 'oi', '{}'::jsonb)
     RETURNING id`,
    [T, A, conversa.id],
  );
  const id = r.rows[0]!.id;
  createdMensagens.push(id);
  return id;
}

async function claimWithLease(mensagem_id: string) {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  const { TurnLease } = await import('@/runtime/turns/lease.js');
  const turn = await agentTurnsRepo.ensureTurnForMessage({
    id: mensagem_id,
    tenant_id: T,
    agent_id: A,
    conversa_id: conversa.id,
    channel_id: null,
  });
  const claimed = await agentTurnsRepo.tryClaimTurn({
    turn_id: turn.id,
    worker_id: `dono-${randomUUID().slice(0, 8)}`,
    lease_ms: TTL_MS,
  });
  expect(claimed.ok, 'o dono legítimo deveria ter conseguido o claim').toBe(true);
  if (!claimed.ok) throw new Error('claim não concedido');
  return {
    turn_id: turn.id,
    claim_token: claimed.claim.claim_token,
    lease: new TurnLease(claimed.claim, { ttl_ms: TTL_MS, heartbeat_ms: HEARTBEAT_MS }),
  };
}

async function loseOwnershipForReal(
  turn_id: string,
  lease: { alive: boolean; lostReason: string | null },
): Promise<void> {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await agentTurnsRepo.tryClaimTurn({
    turn_id,
    worker_id: `sucessor-${randomUUID().slice(0, 8)}`,
    lease_ms: 60_000,
  });
  expect(successor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);
  const deadline = Date.now() + 10_000;
  while (lease.alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lease.alive, 'o heartbeat real deveria ter detectado a perda').toBe(false);
  expect(lease.lostReason, 'a perda tem de vir do TAKEOVER, não de erro de banco').toBe(
    'token_mismatch',
  );
}

async function countFacts(chave: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_facts WHERE tenant_id=$1 AND agent_id=$2 AND chave=$3`,
    [T, A, chave],
  );
  return Number(r.rows[0]!.n);
}

async function reservationRows(
  key: string,
): Promise<Array<{ state: string }>> {
  const r = await pool.query<{ state: string }>(
    `SELECT state FROM idempotency_keys WHERE tenant_id=$1 AND agent_id=$2 AND key=$3`,
    [T, A, key],
  );
  return r.rows;
}

d('#504 — a lease morre ENTRE o guard do dispatcher e o handler da tool', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'ll504-handler', $3, 'dono', 'ativa') RETURNING *`,
      [T, A, `+5511${Math.floor(Math.random() * 1e9)}`],
    );
    pessoa = p.rows[0] as Pessoa;

    const conv = await pool.query(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
       VALUES ($1,$2,$3,'{}') RETURNING *`,
      [T, A, pessoa.id],
    );
    conversa = conv.rows[0] as Conversa;

    const ent = await pool.query<{ id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo, status)
       VALUES ($1,$2,'PF-ll504-handler','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;

    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'ll504-handler owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-llh504-${randomUUID().slice(0, 8)}`],
    );
    const perm = await pool.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
       VALUES ($1,$2,$3,$4,'dono',$5,'ativa') RETURNING *`,
      [T, A, pessoa.id, entidade_id, (prof.rows[0] as PermissionProfile).id],
    );
    resolvedPermission = {
      permissao: perm.rows[0] as Permissao,
      profile: prof.rows[0] as PermissionProfile,
      effective_limits: { valor_max: 100000 },
    };
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (createdFacts.length > 0) {
      await pool.query(`DELETE FROM agent_facts WHERE chave = ANY($1::text[])`, [createdFacts]);
    }
    if (createdMensagens.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
    }
    await pool.query(`DELETE FROM audit_log WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM permission_profiles WHERE nome = 'll504-handler owner'`);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM idempotency_keys WHERE entity_id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM entidades WHERE id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.end();
  });

  it('CONTROLE: sem perda, o mesmo gancho deixa a tool executar normalmente', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `llh504-controle-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    // O MESMO spy do caso da barreira, sem provocar o takeover. Se o gancho
    // por si só bloqueasse a tool, a barreira abaixo passaria por motivo
    // nenhum.
    let reservedKey = '';
    const original = idempotencyRepo.tryReserve.bind(idempotencyRepo);
    const spy = vi
      .spyOn(idempotencyRepo, 'tryReserve')
      .mockImplementation(async (arg: Parameters<typeof original>[0]) => {
        reservedKey = arg.key;
        return original(arg);
      });

    let out: unknown;
    try {
      await inT(async () => {
        const { lease } = await claimWithLease(mensagem_id);
        await runWithTurnExecution(lease.context(), async () => {
          out = await dispatchTool({
            tool: 'remember_safe_fact',
            args: { chave, valor: 'dono vivo' },
            ctx: toolCtx(mensagem_id),
          });
        });
        lease.stop();
      });
    } finally {
      spy.mockRestore();
    }

    expect(await countFacts(chave), 'a tool deveria ter EXECUTADO com a posse viva').toBe(1);
    expect(out).not.toHaveProperty('error');
    expect(
      (await reservationRows(reservedKey)).map((r) => r.state),
      'a reserva do dono deveria ter concluído normalmente',
    ).toEqual(['completed']);
  }, 60_000);

  it('BARREIRA: posse perdida DEPOIS do guard e ANTES do handler cancela a execução', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `llh504-barreira-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    let out: unknown;
    let reservedKey = '';
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(mensagem_id);
      // A posse está VIVA aqui: o guard da PRIMEIRA linha do dispatcher passa.
      expect(lease.alive, 'a posse tem de estar viva na entrada do dispatcher').toBe(true);

      const original = idempotencyRepo.tryReserve.bind(idempotencyRepo);
      const spy = vi
        .spyOn(idempotencyRepo, 'tryReserve')
        .mockImplementation(async (arg: Parameters<typeof original>[0]) => {
          reservedKey = arg.key;
          // A reserva é feita de VERDADE e só então a posse é perdida — é o
          // pior caso, e o que exige a devolução da reserva.
          const reserved = await original(arg);
          await loseOwnershipForReal(turn_id, lease);
          return reserved;
        });

      try {
        await runWithTurnExecution(lease.context(), async () => {
          out = await dispatchTool({
            tool: 'remember_safe_fact',
            args: { chave, valor: 'zumbi' },
            ctx: toolCtx(mensagem_id),
          });
        });
      } finally {
        spy.mockRestore();
      }
    });

    // EFEITO primeiro, retorno depois.
    expect(await countFacts(chave), 'o handler não pode ter rodado sem posse').toBe(0);
    // E a reserva não pode ficar para trás: uma row 'failed' devolveria
    // `idempotency_prior_failed` ao worker que TEM a lease.
    expect(reservedKey, 'o gancho deveria ter capturado a chave reservada').not.toBe('');
    expect(
      (await reservationRows(reservedKey)).map((r) => r.state),
      'a reserva tem de ser ABANDONADA, não deixada terminal contra o dono legítimo',
    ).toEqual([]);

    expect(out).toEqual({
      error: 'turn_ownership_lost',
      details: { tool: 'remember_safe_fact' },
    });
  }, 60_000);

  it('CONTEXTO: o handler recebe claim_token e signal da tentativa', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `llh504-ctx-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    const tool = REGISTRY['remember_safe_fact']!;
    // Spy sobre o call site REAL do dispatcher, delegando para o handler
    // original: o que se observa é o objeto que a produção monta, não uma
    // reconstrução do call site (que passaria mesmo com a propagação deletada).
    const originalHandler = tool.handler.bind(tool);
    let seen: ToolHandlerCtx | null = null;
    const spy = vi
      .spyOn(tool, 'handler')
      .mockImplementation(async (args: unknown, ctx: ToolHandlerCtx) => {
        seen = ctx;
        return originalHandler(args, ctx);
      });

    let claim_token = '';
    try {
      await inT(async () => {
        const claimed = await claimWithLease(mensagem_id);
        claim_token = claimed.claim_token;
        await runWithTurnExecution(claimed.lease.context(), async () => {
          await dispatchTool({
            tool: 'remember_safe_fact',
            args: { chave, valor: 'com contexto' },
            ctx: toolCtx(mensagem_id),
          });
        });
        claimed.lease.stop();
      });
    } finally {
      spy.mockRestore();
    }

    expect(seen, 'o handler deveria ter sido chamado').not.toBeNull();
    // `?? null` para que a AUSÊNCIA do campo (propagação deletada) falhe nesta
    // asserção e não num TypeError três linhas abaixo — vermelho legível.
    const turn = seen!.turn ?? null;
    expect(turn, 'o ToolHandlerCtx tem de carregar a tentativa').not.toBeNull();
    // O FENCE: é este valor que `agent_turns` exige no WHERE de toda gravação
    // da tentativa. Sem ele o handler não tem como validar a própria tentativa.
    expect(turn!.claim_token, 'claim_token tem de ser o da tentativa corrente').toBe(claim_token);
    expect(turn!.attempt).toBeGreaterThanOrEqual(1);
    // E o sinal, para o handler COOPERAR com o cancelamento.
    expect(turn!.signal).toBeInstanceOf(AbortSignal);
    expect(turn!.signal.aborted, 'com a posse viva o sinal não está abortado').toBe(false);
  }, 60_000);
});

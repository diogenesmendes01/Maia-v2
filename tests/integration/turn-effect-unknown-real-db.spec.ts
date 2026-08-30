/**
 * Issue #507 §Tools — o cancelamento que chega DEPOIS do efeito, com Postgres
 * real e perda de lease real.
 *
 * ─── O que esta suíte prova, e por que ela precisa de banco ─────────────────
 *
 * A suíte irmã `tests/unit/tools/dispatcher-effect-unknown.spec.ts` fixa a
 * MATRIZ: dada uma classe e um sinal abortado, qual veredito sai. Ela mocka o
 * ledger de idempotência, então não pode responder a pergunta que interessa a
 * um operador: **o efeito aconteceu mesmo?**
 *
 * Aqui acontece. A tool escreve de verdade em `agent_facts`, a perda de posse
 * vem do mecanismo REAL da #504 (lease vencida por SQL → takeover por um
 * sucessor → o heartbeat do dono descobre → `AbortSignal`), e o instante é
 * escolhido de DENTRO do handler, depois de a linha existir. Isto é o cenário
 * caro de verdade:
 *
 *   · a linha ESTÁ no banco;
 *   · o turno já não é nosso;
 *   · e o dispatcher tem de dizer "não sei", não "cancelado" nem "erro".
 *
 * As três afirmações que só o banco sustenta:
 *
 *   1. o efeito EXISTE (por isso `effect_unknown` é honesto, não paranoia);
 *   2. a reserva de idempotência fica `failed` — é o estado que faz a MESMA
 *      chave falhar rápido em vez de reexecutar sozinha, e é assim que
 *      "`effect_unknown` nunca é automaticamente retryable" deixa de ser texto;
 *   3. existe uma linha `tool_effect_unknown` em `audit_log` com a estratégia
 *      de reconciliação — sem ela, um efeito possivelmente consumado ficaria
 *      sem rastro e ninguém teria o que reconciliar.
 *
 * E o CONTRASTE, no mesmo arquivo e com o mesmo mecanismo: uma tool
 * `abort_safe` cancelada no mesmo instante responde `turn_ownership_lost` e
 * NÃO deixa dívida — porque a classe dela declara que não há efeito. Sem esse
 * caso, "tudo vira effect_unknown" passaria como se fosse a feature.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa, Conversa, PermissionProfile, Permissao } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';
/**
 * TTL longo pelo mesmo motivo da suíte da #504: as BARREIRAS não perdem a posse
 * por expiração natural — elas forçam o vencimento por SQL e provocam um
 * TAKEOVER. Um TTL curto só criaria uma corrida entre o relógio da lease e o
 * corpo do teste, reprovando o CONTROLE sob contenção.
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
  const claimed = await agentTurnsRepo.claimNextEligibleTurn({
    turn_id: turn.id,
    worker_id: `dono-${randomUUID().slice(0, 8)}`,
    lease_ms: TTL_MS,
  });
  expect(claimed.ok, 'o dono legítimo deveria ter conseguido o claim').toBe(true);
  if (!claimed.ok) throw new Error('claim não concedido');
  return {
    turn_id: turn.id,
    lease: new TurnLease(claimed.claim, { ttl_ms: TTL_MS, heartbeat_ms: HEARTBEAT_MS }),
  };
}

/**
 * A perda REAL: vence a lease no banco, deixa um SUCESSOR reivindicar e espera
 * o heartbeat do dono descobrir sozinho. Nada de `markLost()` à mão — o que
 * se quer provar é o comportamento sob takeover, não sob um mock dele.
 */
async function loseOwnershipForReal(
  turn_id: string,
  lease: { alive: boolean; lostReason: string | null },
): Promise<void> {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await agentTurnsRepo.claimNextEligibleTurn({
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

async function reservationStates(key: string): Promise<string[]> {
  const r = await pool.query<{ state: string }>(
    `SELECT state FROM idempotency_keys WHERE tenant_id=$1 AND agent_id=$2 AND key=$3`,
    [T, A, key],
  );
  return r.rows.map((row) => row.state);
}

async function effectUnknownAudits(
  mensagem_id: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM audit_log
      WHERE tenant_id=$1 AND agent_id=$2 AND mensagem_id=$3 AND acao='tool_effect_unknown'`,
    [T, A, mensagem_id],
  );
  return r.rows.map((row) => row.metadata);
}

d('#507 — efeito possível + cancelamento tardio = `effect_unknown` (banco real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'eu507', $3, 'dono', 'ativa') RETURNING *`,
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
       VALUES ($1,$2,'PF-eu507','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;

    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'eu507 owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-eu507-${randomUUID().slice(0, 8)}`],
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
    await pool.query(`DELETE FROM permission_profiles WHERE nome = 'eu507 owner'`);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM idempotency_keys WHERE entity_id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM entidades WHERE id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.end();
  });

  it('CONTROLE: com a posse viva, o mesmo gancho deixa a tool concluir e cachear', async () => {
    // Sem este caso, a barreira abaixo passaria mesmo que o GANCHO — e não a
    // perda de posse — fosse o que impede a conclusão.
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `eu507-controle-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    let reservedKey = '';
    const originalReserve = idempotencyRepo.tryReserve.bind(idempotencyRepo);
    const reserveSpy = vi
      .spyOn(idempotencyRepo, 'tryReserve')
      .mockImplementation(async (arg: Parameters<typeof originalReserve>[0]) => {
        reservedKey = arg.key;
        return originalReserve(arg);
      });

    const tool = REGISTRY.remember_safe_fact!;
    const originalHandler = tool.handler;
    const handlerSpy = vi
      .spyOn(tool, 'handler')
      .mockImplementation(async (args, handlerCtx) => originalHandler(args, handlerCtx));

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
      handlerSpy.mockRestore();
      reserveSpy.mockRestore();
    }

    expect(out).not.toHaveProperty('error');
    expect(await countFacts(chave)).toBe(1);
    expect(await reservationStates(reservedKey)).toEqual(['completed']);
    expect(await effectUnknownAudits(mensagem_id)).toEqual([]);
  }, 60_000);

  it('BARREIRA: posse perdida DEPOIS de a tool gravar → `effect_unknown`, dívida registrada, retry recusado', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { idempotencyRepo } = await import('@/db/repositories.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `eu507-barreira-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    let reservedKey = '';
    const originalReserve = idempotencyRepo.tryReserve.bind(idempotencyRepo);
    const reserveSpy = vi
      .spyOn(idempotencyRepo, 'tryReserve')
      .mockImplementation(async (arg: Parameters<typeof originalReserve>[0]) => {
        reservedKey = arg.key;
        return originalReserve(arg);
      });

    // O INSTANTE: o handler REAL roda inteiro (a linha em `agent_facts` passa a
    // existir) e só então a posse é perdida — takeover de verdade, descoberto
    // pelo heartbeat de verdade. É a janela em que "cancelado" seria mentira.
    const tool = REGISTRY.remember_safe_fact!;
    const originalHandler = tool.handler;
    let turnIdParaPerder = '';
    let leaseParaPerder: { alive: boolean; lostReason: string | null } | null = null;
    const handlerSpy = vi
      .spyOn(tool, 'handler')
      .mockImplementation(async (args, handlerCtx) => {
        const written = await originalHandler(args, handlerCtx);
        await loseOwnershipForReal(turnIdParaPerder, leaseParaPerder!);
        return written;
      });

    let out: unknown;
    try {
      await inT(async () => {
        const { turn_id, lease } = await claimWithLease(mensagem_id);
        turnIdParaPerder = turn_id;
        leaseParaPerder = lease;
        await runWithTurnExecution(lease.context(), async () => {
          out = await dispatchTool({
            tool: 'remember_safe_fact',
            args: { chave, valor: 'gravado antes da perda' },
            ctx: toolCtx(mensagem_id),
          });
        });
        lease.stop();
      });
    } finally {
      handlerSpy.mockRestore();
      reserveSpy.mockRestore();
    }

    // 1. O efeito EXISTE. É por isso que a resposta honesta é "não sei", e não
    //    "cancelado": dizer que nada aconteceu contradiria o banco.
    expect(await countFacts(chave), 'a linha foi gravada ANTES da perda').toBe(1);

    // 2. O veredito, e o que ele carrega para quem vai reconciliar.
    expect(out).toMatchObject({
      error: 'effect_unknown',
      details: {
        tool: 'remember_safe_fact',
        effect_class: 'idempotent',
        retryable: false,
        reconciliation: 'replay_idempotency_key',
      },
    });

    // 3. A reserva fica TERMINAL. Não é detalhe de ledger: é o que impede um
    //    retry cego de reexecutar a mesma chave sozinho.
    expect(await reservationStates(reservedKey)).toEqual(['failed']);

    // 4. A dívida tem linha própria — sem ela ninguém saberia o que reconciliar.
    const audits = await effectUnknownAudits(mensagem_id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tool: 'remember_safe_fact',
      effect_class: 'idempotent',
      reconciliation: 'replay_idempotency_key',
      retryable: false,
    });
  }, 60_000);

  it('CONTRASTE: a MESMA perda, numa tool `abort_safe`, é só cancelamento — sem dívida', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();

    const tool = REGISTRY.read_turn_context!;
    const originalHandler = tool.handler;
    let turnIdParaPerder = '';
    let leaseParaPerder: { alive: boolean; lostReason: string | null } | null = null;
    const handlerSpy = vi
      .spyOn(tool, 'handler')
      .mockImplementation(async (args, handlerCtx) => {
        const read = await originalHandler(args, handlerCtx);
        await loseOwnershipForReal(turnIdParaPerder, leaseParaPerder!);
        return read;
      });

    let out: unknown;
    try {
      await inT(async () => {
        const { turn_id, lease } = await claimWithLease(mensagem_id);
        turnIdParaPerder = turn_id;
        leaseParaPerder = lease;
        await runWithTurnExecution(lease.context(), async () => {
          out = await dispatchTool({
            tool: 'read_turn_context',
            args: { limit: 5 },
            ctx: toolCtx(mensagem_id),
          });
        });
        lease.stop();
      });
    } finally {
      handlerSpy.mockRestore();
    }

    // `abort_safe` DECLARA que não há efeito a reconciliar, então o vocabulário
    // pode dizer "cancelado" — e nenhuma dívida é aberta. Se este caso também
    // virasse `effect_unknown`, a classificação não estaria classificando nada.
    expect(out).toMatchObject({ error: 'turn_ownership_lost' });
    expect(await effectUnknownAudits(mensagem_id)).toEqual([]);
  }, 60_000);
});

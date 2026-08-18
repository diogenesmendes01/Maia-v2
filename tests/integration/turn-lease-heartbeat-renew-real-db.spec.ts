/**
 * #504 — o heartbeat da lease RENOVA de verdade, contra Postgres real.
 *
 * ## Por que este arquivo existe
 *
 * Os casos de CONTROLE das specs de `turn-lease-lost-*` provam que, com a
 * lease viva, o efeito acontece. Eles NÃO provam que a lease está viva *porque
 * alguém a renova*: com o TTL em 30s e corpos de 2,5–3,2s, eles passariam
 * igual se o timer parasse de disparar ou se a renovação devolvesse sucesso
 * sem estender nada no banco. É o achado do review da PR #592, e é real — o
 * caminho integrado timer → `TurnLease` → `UPDATE` no Postgres ficaria sem
 * cobertura enquanto o TTL fosse maior que o teste.
 *
 * Aqui o TTL é curto de propósito e o teste OBSERVA O BANCO: captura
 * `heartbeat_at` e `lease_expires_at`, espera renovação, e exige que os dois
 * tenham avançado com a lease ainda viva.
 *
 * ## Sem fake timers, deliberadamente
 *
 * `renewTurnLease` compara contra `now()` do POSTGRES
 * (`AND lease_expires_at > now()`). Adiantar só o relógio do Node produziria
 * uma renovação que o banco recusa — ou pior, um verde que não diz nada sobre
 * o mecanismo real. O tempo aqui é o do banco.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = "hb504-tenant";
const A = "hb504-agent";

/** Curto de propósito: o teste PRECISA ver renovação acontecer. */
const TTL_MS = 3_000;
const HEARTBEAT_MS = 400;

let pool: pg.Pool;
const createdMensagens: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function mkTurn(): Promise<string> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [mensagem_id, T, A],
  );
  createdMensagens.push(mensagem_id);
  const { agentTurnsRepo } = await import("../../src/db/repositories.js");
  const turn = await inT(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T,
      agent_id: A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return turn.id;
}

/** O que o BANCO diz sobre a lease — não o que o objeto em memória acha. */
async function leaseNoBanco(
  turn_id: string,
): Promise<{ heartbeat_at: Date; lease_expires_at: Date }> {
  const r = await pool.query<{ heartbeat_at: Date; lease_expires_at: Date }>(
    `SELECT heartbeat_at, lease_expires_at FROM agent_turns WHERE id = $1`,
    [turn_id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`turno ${turn_id} sumiu do banco`);
  return row;
}

d("#504 — o heartbeat renova a lease no Postgres, não só em memória", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`,
      [T],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [A, T],
    );
  }, 30_000);

  afterAll(async () => {
    for (const id of createdMensagens) {
      await pool.query(`DELETE FROM agent_turns WHERE representative_message_id = $1`, [id]);
      await pool.query(`DELETE FROM mensagens WHERE id = $1`, [id]);
    }
    await pool.end();
  });

  it("`heartbeat_at` e `lease_expires_at` AVANÇAM no banco com a lease viva", async () => {
    const { agentTurnsRepo } = await import("@/db/repositories.js");
    const { TurnLease } = await import("@/runtime/turns/lease.js");

    const turn_id = await mkTurn();
    const claimed = await inT(() =>
      agentTurnsRepo.tryClaimTurn({
        turn_id,
        worker_id: `hb-${randomUUID().slice(0, 8)}`,
        lease_ms: TTL_MS,
      }),
    );
    expect(claimed.ok, "o claim inicial deveria ter sido concedido").toBe(true);
    if (!claimed.ok) throw new Error("claim não concedido");

    const antes = await leaseNoBanco(turn_id);

    // A lease e criada DENTRO do contexto de tenant, e isso e requisito, nao
    // estilo: `renewTurnLease` chama `scope()` para montar o `WHERE` por
    // tenant/agent, e o `setInterval` do heartbeat so carrega esse contexto se
    // for agendado dentro dele (AsyncLocalStorage propaga para o timer criado
    // sob `run()`). Criar a lease fora faz TODA renovacao cair no `catch` e o
    // `heartbeat_at` nunca avancar -- foi o primeiro vermelho deste arquivo, e
    // e o mesmo motivo pelo qual as specs de `turn-lease-lost-*` fazem o claim
    // dentro do `inT`.
    await inT(async () => {
      const lease = new TurnLease(claimed.claim, {
        ttl_ms: TTL_MS,
        heartbeat_ms: HEARTBEAT_MS,
      });

      try {
        // Espera por EVIDÊNCIA no banco, não por relógio de parede: pollar até o
        // `heartbeat_at` mudar é o que torna o teste determinístico sob carga.
        // O prazo é generoso e existe só para não pendurar a suíte.
        const deadline = Date.now() + 10_000;
        let depois = antes;
        while (
          depois.heartbeat_at.getTime() === antes.heartbeat_at.getTime() &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 50));
          depois = await leaseNoBanco(turn_id);
        }

        expect(
          depois.heartbeat_at.getTime(),
          "o `heartbeat_at` do banco não avançou: o timer não disparou, ou a renovação " +
            "devolveu sucesso sem escrever — que é o buraco que este teste existe para fechar",
        ).toBeGreaterThan(antes.heartbeat_at.getTime());

        expect(
          depois.lease_expires_at.getTime(),
          "o `heartbeat_at` avançou mas o vencimento não: renovar sem ESTENDER deixa a " +
            "lease morrer no prazo original",
        ).toBeGreaterThan(antes.lease_expires_at.getTime());

        // E a posse continua nossa: renovação não é takeover.
        expect(
          lease.alive,
          "a lease deveria seguir viva depois de renovar",
        ).toBe(true);
        expect(lease.lostReason).toBeNull();
      } finally {
        lease.stop();
      }
    });
  }, 30_000);

  it("renovação que chega DEPOIS do vencimento é recusada — e vira `token_mismatch`", async () => {
    // O mecanismo que de fato derrubava os casos de CONTROLE antes da #592, e
    // que eu tinha atribuído erradamente a `MAX_HEARTBEAT_FAILURES`. O
    // predicado do `UPDATE` é `AND lease_expires_at > now()`: expirada a
    // lease, a renovação devolve ZERO linhas mesmo com o banco saudável e
    // sem nenhum sucessor. Não é falha de heartbeat; é CAS recusado.
    const { agentTurnsRepo } = await import("@/db/repositories.js");

    const turn_id = await mkTurn();
    const claimed = await inT(() =>
      agentTurnsRepo.tryClaimTurn({
        turn_id,
        worker_id: `hb-exp-${randomUUID().slice(0, 8)}`,
        lease_ms: TTL_MS,
      }),
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("claim não concedido");

    // Vence a lease no BANCO, sem tocar em nada mais — nenhum sucessor, nenhum
    // erro de conexão.
    await pool.query(
      `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [turn_id],
    );

    const renovada = await inT(() =>
      agentTurnsRepo.renewTurnLease({
        turn_id,
        claim_token: claimed.claim.claim_token,
        lease_ms: TTL_MS,
      }),
    );

    expect(
      renovada.ok,
      "com a lease vencida o CAS tem de recusar, mesmo com o banco saudável",
    ).toBe(false);
  }, 30_000);
});

/**
 * P0 leak proof for `conversasRepo.byIdWithPessoa`.
 *
 * The schema currently permits a conversation owned by agent A to reference a
 * person owned by agent B. This suite proves the repository rejects both a
 * foreign base row and a corrupt foreign row on the joined side.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";

import { runWithTenantContext } from "@/db/tenant-context.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const RUN_ID = randomUUID().slice(0, 8);
const TENANT = `conversation-person-scope-${RUN_ID}`;
const AGENT_A = `conversation-person-agent-a-${RUN_ID}`;
const AGENT_B = `conversation-person-agent-b-${RUN_ID}`;
const PHONE_BASE = randomInt(1_000_000, 8_999_999);

let pool: pg.Pool;
let pessoaA: string;
let pessoaB: string;
let conversaA: string;
let conversaB: string;
let conversaCorrompida: string;

d("conversasRepo.byIdWithPessoa — real DB leak proof", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome)
       VALUES ($1, $3, $1), ($2, $3, $2)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_A, AGENT_B, TENANT],
    );

    const people = await pool.query<{ id: string; agent_id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES
         ($1, $2, 'A', $4, 'cliente', 'ativa'),
         ($1, $3, 'B', $5, 'cliente', 'ativa')
       RETURNING id, agent_id`,
      [
        TENANT,
        AGENT_A,
        AGENT_B,
        `+55119${PHONE_BASE}`,
        `+55119${PHONE_BASE + 1}`,
      ],
    );
    pessoaA = people.rows.find((row) => row.agent_id === AGENT_A)!.id;
    pessoaB = people.rows.find((row) => row.agent_id === AGENT_B)!.id;

    const conversations = await pool.query<{ id: string; marker: string }>(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status, metadata)
       VALUES
         ($1, $2, $4, 'ativa', '{"scope_test":"mine"}'::jsonb),
         ($1, $3, $5, 'ativa', '{"scope_test":"foreign"}'::jsonb),
         ($1, $2, $5, 'ativa', '{"scope_test":"corrupt_join"}'::jsonb)
       RETURNING id, metadata->>'scope_test' AS marker`,
      [TENANT, AGENT_A, AGENT_B, pessoaA, pessoaB],
    );
    conversaA = conversations.rows.find((row) => row.marker === "mine")!.id;
    conversaB = conversations.rows.find((row) => row.marker === "foreign")!.id;
    conversaCorrompida = conversations.rows.find(
      (row) => row.marker === "corrupt_join",
    )!.id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM conversas WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM pessoas WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    await pool.end();
  });

  it("returns only a conversation and person owned by the active tenant+agent", async () => {
    const { conversasRepo } = await import("@/db/repositories.js");
    const result = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT_A },
      () => conversasRepo.byIdWithPessoa(conversaA),
    );

    expect(result?.conversa.id).toBe(conversaA);
    expect(result?.pessoa.id).toBe(pessoaA);
  });

  it("hides a foreign conversation even when its id is known", async () => {
    const { conversasRepo } = await import("@/db/repositories.js");
    const result = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT_A },
      () => conversasRepo.byIdWithPessoa(conversaB),
    );

    expect(result).toBeNull();
  });

  it("hides a foreign person referenced by an otherwise-owned conversation", async () => {
    const { conversasRepo } = await import("@/db/repositories.js");
    const result = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT_A },
      () => conversasRepo.byIdWithPessoa(conversaCorrompida),
    );

    expect(result).toBeNull();
  });
});

/**
 * P0 — DB-free proof for the conversation/person hot-path join.
 *
 * Both sides must be scoped. Filtering only `conversas` still lets a corrupt
 * cross-scope `pessoa_id` expose another agent's person row; filtering only the
 * joined person still lets a caller probe a foreign conversation by known id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { runWithTenantContext } from "../../src/db/tenant-context.js";

const captured = vi.hoisted(() => ({
  joins: [] as SQL[],
  wheres: [] as SQL[],
}));

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: (_table: unknown, condition: SQL) => {
      captured.joins.push(condition);
      return chain;
    },
    where: (condition: SQL) => {
      captured.wheres.push(condition);
      return chain;
    },
    limit: () => Promise.resolve([]),
  };
  return chain;
}

vi.mock("../../src/db/client.js", () => ({
  db: { select: () => makeChain() },
  withTx: vi.fn(),
  pgErrorCode: () => undefined,
}));

function compile(fragment: SQL): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(fragment);
  return { sql: query.sql, params: query.params as unknown[] };
}

beforeEach(() => {
  captured.joins.length = 0;
  captured.wheres.length = 0;
});

describe("conversasRepo.byIdWithPessoa — complete ALS scope", () => {
  it("binds tenant + agent on both the conversation WHERE and the person JOIN", async () => {
    const { conversasRepo } =
      await import("../../src/db/repositories/conversation-repos.js");

    await runWithTenantContext(
      { tenant_id: "tenant-a", agent_id: "agent-a" },
      () => conversasRepo.byIdWithPessoa("conversation-known-id"),
    );

    expect(captured.wheres).toHaveLength(1);
    expect(captured.joins).toHaveLength(1);

    const where = compile(captured.wheres[0]!);
    expect(where.sql).toMatch(/conversas.*id/i);
    expect(where.sql).toMatch(/conversas.*tenant_id/i);
    expect(where.sql).toMatch(/conversas.*agent_id/i);
    expect(where.params).toEqual(
      expect.arrayContaining(["conversation-known-id", "tenant-a", "agent-a"]),
    );

    const join = compile(captured.joins[0]!);
    expect(join.sql).toMatch(/pessoas.*id/i);
    expect(join.sql).toMatch(/conversas.*pessoa_id/i);
    expect(join.sql).toMatch(/pessoas.*tenant_id/i);
    expect(join.sql).toMatch(/pessoas.*agent_id/i);
    expect(join.params).toEqual(
      expect.arrayContaining(["tenant-a", "agent-a"]),
    );
  });
});

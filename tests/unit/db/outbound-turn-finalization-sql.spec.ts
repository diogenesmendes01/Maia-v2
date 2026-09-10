/**
 * P1 — prova sem Postgres dos predicados que elegem a convergência do turno.
 * Compila as declarações de produção; não remonta SQL no teste.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  finalizableTurnsStatement,
  noSuccessTurnsSummaryStatement,
  scopesWithWorkStatement,
} from '@/db/repositories/outbound-recovery-repo.js';

const dialect = new PgDialect();
const compile = (statement: ReturnType<typeof scopesWithWorkStatement>) => {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
};

describe('P1 — SQL de convergência outbound → turno', () => {
  it('exige escopo, outbound_pending, claim e lease vencida', () => {
    const { sql, params } = compile(
      finalizableTurnsStatement('tenant-a', 'agent-a', 25),
    );
    expect(sql).toContain("t.status = 'outbound_pending'");
    expect(sql).toContain('t.claim_token IS NOT NULL');
    expect(sql).toContain('t.lease_expires_at IS NOT NULL');
    expect(sql).toContain('t.lease_expires_at <= now()');
    expect(params).toContain('tenant-a');
    expect(params).toContain('agent-a');
    expect(params).toContain(25);
  });

  it('exige sucesso comprovado e bloqueia qualquer artefato não final', () => {
    const { sql, params } = compile(
      finalizableTurnsStatement('tenant-a', 'agent-a', 25),
    );
    expect(sql.match(/EXISTS/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain("o.status = 'completed'");
    expect(sql).toContain('o.status NOT IN (');
    for (const status of [
      'completed',
      'failed_terminal',
      'cancelled',
      'dead_letter',
    ]) {
      expect(params).toContain(status);
    }
    expect(params).not.toContain('delivered');
  });

  it('diagnostica zero-sucesso em consulta agregada fora do LIMIT de finalização', () => {
    const { sql, params } = compile(
      noSuccessTurnsSummaryStatement('tenant-a', 'agent-a'),
    );
    expect(sql).toContain('COUNT(*)::int AS pending_count');
    expect(sql).toContain("t.status = 'outbound_pending'");
    expect(sql).toContain('o.status NOT IN (');
    expect(sql).toContain("o.status = 'completed'");
    expect(sql).not.toContain(' LIMIT ');
    expect(params).toContain('tenant-a');
    expect(params).toContain('agent-a');
  });

  it('o dispatcher tem uma perna por turno sem varrer todo `completed`', () => {
    const { sql } = compile(scopesWithWorkStatement());
    expect(sql).toContain(' UNION ');
    expect(sql).toContain('FROM "agent_turns" t');
    expect(sql).toContain("t.status = 'outbound_pending'");
    const legacyOutboundLeg = sql.split(' UNION ')[0]!;
    expect(legacyOutboundLeg).not.toContain("status = 'completed'");
  });
});

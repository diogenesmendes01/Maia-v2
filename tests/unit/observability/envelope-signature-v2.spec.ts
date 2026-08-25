/**
 * Issue #535 — `signature_version=2` and the signed attempt grouping.
 *
 * Owner decision being pinned here:
 *   - v2 signs `root_trace_id` and `attempt` on top of what v1 already signed;
 *   - production writes ONLY v2;
 *   - the verifier keeps reading v1 (fixtures / old environments), and v1 rows
 *     are never re-signed;
 *   - `listAttempts()` additionally requires the SIGNED `turno_id`.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not rebuild the signed material with a local helper and then check
 * that the local helper agrees with itself. A spec shaped that way stays green
 * after the production call site is deleted, because the harness re-derives
 * whatever production happens to do. Every assertion below is anchored either
 * on a LITERAL expectation or on the real repository function.
 *
 * The `listAttempts` half compiles the WHERE clause that production actually
 * built (`PgDialect.sqlToQuery`) instead of asserting on a mock's arguments —
 * so "the query filters by the signed turno_id" is checked against SQL, not
 * against a call record that a refactor could satisfy while dropping the
 * predicate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const captured: {
  where: unknown[];
  rows: Record<string, unknown>[];
} = { where: [], rows: [] };

function chain() {
  const self = {
    from: () => self,
    where: (w: unknown) => {
      captured.where.push(w);
      return self;
    },
    orderBy: () => self,
    groupBy: () => Promise.resolve(captured.rows),
    limit: () => Promise.resolve(captured.rows),
    then: (resolve: (v: unknown) => void) => resolve(captured.rows),
  };
  return self;
}

vi.mock('@/db/client.js', () => ({
  db: { select: vi.fn(() => chain()) },
}));

const { runtimeTraceRepo, TraceAttemptScopeError } = await import(
  '@/db/repositories/runtime-trace-repos.js'
);
const { signHmac, _resetHmacCacheForTests, _setTestMasterSecretForTests, _clearTestMasterSecretForTests } =
  await import('@/control-plane/runtime-trace/lib/hmac.js');
const { verifyEnvelopeIntegrity } = await import(
  '@/control-plane/runtime-trace/verify-envelope.js'
);

const TENANT = 'tenant-A';
const ROOT = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';
const TURNO = '99999999-8888-4777-8666-555555555555';
const OTHER_TURNO = '11111111-2222-4333-8444-555555555555';

/**
 * Build a stored row and sign it the way production does — but WITHOUT calling
 * the production payload builder: the material is spelled out here, so this
 * fixture pins the field SET rather than echoing it.
 */
function storedRow(over: Record<string, unknown> = {}) {
  const r = {
    trace_id: '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60',
    tenant_id: TENANT,
    agent_id: 'agent-a',
    conversa_id: null as string | null,
    turno_id: TURNO,
    root_trace_id: ROOT,
    attempt: 1,
    signature_version: 2,
    policy_id: null as string | null,
    decision: 'allow',
    side_effect_level: 'medium',
    redaction_class: 'standard',
    hmac_key_version: 1,
    body_status: 'persisted',
    body_persisted_at: null as Date | null,
    created_at: new Date('2026-07-01T10:00:00Z'),
    ...over,
  };
  const material: Record<string, unknown> = {
    trace_id: r.trace_id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    conversa_id: r.conversa_id,
    turno_id: r.turno_id,
    policy_id: r.policy_id,
    decision: r.decision,
    side_effect_level: r.side_effect_level,
    redaction_class: r.redaction_class,
    hmac_key_version: r.hmac_key_version,
  };
  if (r.signature_version === 2) {
    material.root_trace_id = r.root_trace_id;
    material.attempt = r.attempt;
    material.signature_version = 2;
  }
  return {
    ...r,
    envelope_hmac: signHmac(r.tenant_id, r.hmac_key_version, material),
    ...('envelope_hmac' in over ? { envelope_hmac: over.envelope_hmac as string } : {}),
  };
}

function compiledWhere(): { sql: string; params: unknown[] } {
  const last = captured.where[captured.where.length - 1];
  const q = new PgDialect().sqlToQuery(last as never);
  return { sql: q.sql, params: q.params as unknown[] };
}

describe('issue #535 — envelope signature v2', () => {
  beforeEach(() => {
    captured.where = [];
    captured.rows = [];
    _resetHmacCacheForTests();
    _setTestMasterSecretForTests('envelope-signature-v2-spec-master');
  });
  afterEach(() => {
    _clearTestMasterSecretForTests();
    _resetHmacCacheForTests();
  });

  /**
   * The task brief asked whether a value containing the canonical separator can
   * forge a different envelope. The canonical encoding is `canonicalJson`, i.e.
   * real JSON with `JSON.stringify` on every key and string — not
   * separator-concatenation — so a hostile value cannot close its own string.
   * Asserted rather than asserted-in-a-comment.
   */
  describe('canonical encoding is unambiguous', () => {
    it('a value carrying JSON punctuation cannot impersonate another field split', () => {
      // Two rows whose CONCATENATION would be identical under a naive
      // `join(':')` / `join('|')` encoding, and which must not share an HMAC.
      const a = storedRow({ agent_id: 'a", "attempt": 99, "x": "', attempt: 1 });
      const b = storedRow({ agent_id: 'a', attempt: 1 });
      expect(a.envelope_hmac).not.toBe(b.envelope_hmac);
      // And each still verifies as itself — escaping is lossless, not lossy.
      expect(verifyEnvelopeIntegrity(a)).toBe('verified');
      expect(verifyEnvelopeIntegrity(b)).toBe('verified');
      // Cross-feeding the signatures fails.
      expect(verifyEnvelopeIntegrity({ ...a, envelope_hmac: b.envelope_hmac })).toBe('invalid');
    });

    it('field-boundary shifting between adjacent fields is detected', () => {
      // `tenant_id`+`agent_id` = "acmeagent" either way. Under a delimiterless
      // concatenation both would sign the same bytes.
      const left = storedRow({ tenant_id: 'acme', agent_id: 'agent' });
      const right = storedRow({ tenant_id: 'acmeagent', agent_id: '' });
      expect(left.envelope_hmac).not.toBe(right.envelope_hmac);
    });

    it('a null and the literal string "null" are different signed values', () => {
      const nulled = storedRow({ conversa_id: null });
      const stringy = storedRow({ conversa_id: 'null' });
      expect(nulled.envelope_hmac).not.toBe(stringy.envelope_hmac);
    });
  });

  describe('listAttempts requires the SIGNED turno_id', () => {
    it('fails closed when turnoId is missing — no fallback to root-only grouping', async () => {
      await expect(
        // @ts-expect-error — deliberately violating the contract
        runtimeTraceRepo.listAttempts({ tenantId: TENANT, rootTraceId: ROOT }),
      ).rejects.toThrow(TraceAttemptScopeError);
      await expect(
        runtimeTraceRepo.listAttempts({ tenantId: TENANT, rootTraceId: ROOT, turnoId: '   ' }),
      ).rejects.toThrow(TraceAttemptScopeError);
      // Nothing was queried — the guard runs before the DB is touched.
      expect(captured.where).toHaveLength(0);
    });

    it('the SQL actually filters by turno_id, not just by root_trace_id', async () => {
      captured.rows = [storedRow()];
      await runtimeTraceRepo.listAttempts({
        tenantId: TENANT,
        rootTraceId: ROOT,
        turnoId: TURNO,
      });
      const { sql, params } = compiledWhere();
      expect(sql).toContain('"turno_id"');
      expect(sql).toContain('"root_trace_id"');
      expect(sql).toContain('"tenant_id"');
      expect(params).toContain(TURNO);
      expect(params).toContain(ROOT);
      expect(params).toContain(TENANT);
    });

    it('a sibling whose own signature does not verify is dropped from the group', async () => {
      const good = storedRow({ attempt: 1 });
      // The forged row: it satisfies the SQL predicate (a fake DB returns it
      // regardless), so only the signature check can keep it out.
      const forged = storedRow({
        trace_id: '00000000-0000-4000-8000-000000000001',
        attempt: 2,
        envelope_hmac: 'nao-e-uma-assinatura-real',
      });
      captured.rows = [good, forged];
      const out = await runtimeTraceRepo.listAttempts({
        tenantId: TENANT,
        rootTraceId: ROOT,
        turnoId: TURNO,
      });
      expect(out.items.map((a) => a.trace_id)).toEqual([good.trace_id]);
      // And the refusal is HANDED BACK, not swallowed — the router audits it.
      expect(out.refused.map((r) => r.trace_id)).toEqual([forged.trace_id]);
      expect(out.refused[0]!.integrity).toBe('invalid');
    });

    it('reports per-attempt integrity and whether the grouping itself is signed', async () => {
      const v2 = storedRow({ attempt: 1 });
      const v1 = storedRow({
        trace_id: '00000000-0000-4000-8000-000000000002',
        attempt: 2,
        signature_version: 1,
      });
      captured.rows = [v2, v1];
      const { items: out } = await runtimeTraceRepo.listAttempts({
        tenantId: TENANT,
        rootTraceId: ROOT,
        turnoId: TURNO,
      });
      expect(out).toHaveLength(2);
      expect(out[0]!.integrity).toBe('verified');
      expect(out[0]!.grouping_signed).toBe(true);
      // A v1 sibling still verifies — but its root/attempt are not signed, and
      // the caller is told so instead of having to infer it from a number.
      expect(out[1]!.integrity).toBe('verified');
      expect(out[1]!.grouping_signed).toBe(false);
    });

    it('a row belonging to ANOTHER turn cannot be spliced in by rewriting root_trace_id', async () => {
      // The whole point of the extra predicate. This row was signed for a
      // different turn; moving it into this group means editing `turno_id`,
      // which v1 and v2 both sign — so it can no longer verify.
      const alien = storedRow({
        trace_id: '00000000-0000-4000-8000-000000000003',
        turno_id: OTHER_TURNO,
        attempt: 2,
      });
      const spliced = { ...alien, turno_id: TURNO };
      captured.rows = [storedRow({ attempt: 1 }), spliced];
      const out = await runtimeTraceRepo.listAttempts({
        tenantId: TENANT,
        rootTraceId: ROOT,
        turnoId: TURNO,
      });
      expect(out.items.map((a) => a.trace_id)).not.toContain(alien.trace_id);
      expect(out.refused.map((r) => r.trace_id)).toContain(alien.trace_id);
    });

    it('still guards the tenant the same way as every other read', async () => {
      await expect(
        runtimeTraceRepo.listAttempts({ tenantId: '', rootTraceId: ROOT, turnoId: TURNO }),
      ).rejects.toThrow();
    });
  });
});

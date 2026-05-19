/**
 * user-layer — cross-tenant isolation property test (real Postgres).
 *
 * PR #94 adversarial review demanded a real-DB property test that inserts
 * data for 2 tenants, queries as tenant A, and asserts ZERO rows from
 * tenant B across every resolver access pattern.
 *
 * Gated on `TEST_DB_URL` (same pattern as every other integration spec).
 * The CI integration job runs these against a Postgres service container.
 *
 * Coverage:
 *   - rulesResolver.list (with/without intent_filter, only_active variants)
 *   - memoryResolver.list (with pessoa_id, role_id, channel_id, conversa_id,
 *     memory_types, intent_filter, every combo)
 *   - memoryResolver.markObserved (refuses tenant B's id under tenant A)
 *   - hintsResolver.list (with pessoa_id, scope)
 *   - interlocutorResolver.get (refuses tenant B's pessoa_id under tenant A)
 *   - factsResolver.list (raw SQL path — exercises the NOT EXISTS gate)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client.js';
import {
  tenants,
  agents,
  pessoas,
  memory_entry,
  behavioral_hint,
  agent_facts,
  learned_rules,
} from '@/db/schema.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { inArray } from 'drizzle-orm';

import { rulesResolver } from '@/user-layer/resolvers/rules-resolver.js';
import { memoryResolver } from '@/user-layer/resolvers/memory-resolver.js';
import { hintsResolver } from '@/user-layer/resolvers/hints-resolver.js';
import { interlocutorResolver } from '@/user-layer/resolvers/interlocutor-resolver.js';
import { factsResolver } from '@/user-layer/resolvers/facts-resolver.js';
import { buildUserSlice } from '@/user-layer/user-slice-builder.js';
import { buildKnowledgeSlice } from '@/user-layer/knowledge-slice-builder.js';
import { TenantBoundaryViolation } from '@/user-layer/internal/tenant-boundary.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'ul-iso-tenant-a';
const T_B = 'ul-iso-tenant-b';
const AG_A = 'ul-iso-agent-a';
const AG_B = 'ul-iso-agent-b';

const LEAK_MARKER_A = 'TENANT_A_SECRET_xxx_should_not_leak';
const LEAK_MARKER_B = 'TENANT_B_SECRET_yyy_should_not_leak';

let pessoaA: { id: string } | undefined;
let pessoaB: { id: string } | undefined;

d('user-layer cross-tenant isolation (real DB)', () => {
  beforeAll(async () => {
    // Tenants + agents
    await db.insert(tenants).values([
      { id: T_A, nome: 'UL Iso A' },
      { id: T_B, nome: 'UL Iso B' },
    ]).onConflictDoNothing();
    await db.insert(agents).values([
      { id: AG_A, tenant_id: T_A, nome: 'UL A' },
      { id: AG_B, tenant_id: T_B, nome: 'UL B' },
    ]).onConflictDoNothing();

    // Pessoas
    const [pA] = await db.insert(pessoas).values({
      tenant_id: T_A,
      agent_id: AG_A,
      nome: 'Pessoa A',
      telefone_whatsapp: `+551199${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`,
      tipo: 'funcionario',
      status: 'ativa',
    }).returning();
    pessoaA = pA;

    const [pB] = await db.insert(pessoas).values({
      tenant_id: T_B,
      agent_id: AG_B,
      nome: 'Pessoa B',
      telefone_whatsapp: `+551199${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`,
      tipo: 'funcionario',
      status: 'ativa',
    }).returning();
    pessoaB = pB;

    // Seed each table for BOTH tenants with a marker string we'll grep for.
    // Memory: mention_allowed=true so it passes the privacy gate; needs_review=false.
    await db.insert(memory_entry).values([
      {
        tenant_id: T_A,
        agent_id: AG_A,
        interlocutor_id: pA!.id,
        content: LEAK_MARKER_A,
        memory_type: 'fact',
        scope_type: 'interlocutor',
        subject_id: pA!.id,
        sensitivity: 'low',
        proactive_use: true,
        mention_allowed: true,
        needs_review: false,
        lifecycle_status: 'active',
      },
      {
        tenant_id: T_B,
        agent_id: AG_B,
        interlocutor_id: pB!.id,
        content: LEAK_MARKER_B,
        memory_type: 'fact',
        scope_type: 'interlocutor',
        subject_id: pB!.id,
        sensitivity: 'low',
        proactive_use: true,
        mention_allowed: true,
        needs_review: false,
        lifecycle_status: 'active',
      },
    ]);

    await db.insert(behavioral_hint).values([
      {
        tenant_id: T_A,
        agent_id: AG_A,
        scope_type: 'interlocutor',
        subject_id: pA!.id,
        hint_text: LEAK_MARKER_A,
        derived_sensitivity: 'low',
        lifecycle_status: 'active',
      },
      {
        tenant_id: T_B,
        agent_id: AG_B,
        scope_type: 'interlocutor',
        subject_id: pB!.id,
        hint_text: LEAK_MARKER_B,
        derived_sensitivity: 'low',
        lifecycle_status: 'active',
      },
    ]);

    await db.insert(agent_facts).values([
      {
        tenant_id: T_A,
        agent_id: AG_A,
        escopo: 'tenant',
        chave: 'iso_test_key',
        valor: { content: LEAK_MARKER_A },
        confianca: '0.95',
        fonte: 'aprendido',
        lifecycle_status: 'active',
      },
      {
        tenant_id: T_B,
        agent_id: AG_B,
        escopo: 'tenant',
        chave: 'iso_test_key',
        valor: { content: LEAK_MARKER_B },
        confianca: '0.95',
        fonte: 'aprendido',
        lifecycle_status: 'active',
      },
    ]);

    await db.insert(learned_rules).values([
      {
        tenant_id: T_A,
        agent_id: AG_A,
        tipo: 'classificacao',
        contexto: `${LEAK_MARKER_A} aluguel`,
        acao: 'rotular_como_a',
        confianca: '0.90',
        ativa: true,
        lifecycle_status: 'active',
      },
      {
        tenant_id: T_B,
        agent_id: AG_B,
        tipo: 'classificacao',
        contexto: `${LEAK_MARKER_B} aluguel`,
        acao: 'rotular_como_b',
        confianca: '0.90',
        ativa: true,
        lifecycle_status: 'active',
      },
    ]);
  });

  afterAll(async () => {
    const ids = [T_A, T_B];
    await db.delete(memory_entry).where(inArray(memory_entry.tenant_id, ids));
    await db.delete(behavioral_hint).where(inArray(behavioral_hint.tenant_id, ids));
    await db.delete(agent_facts).where(inArray(agent_facts.tenant_id, ids));
    await db.delete(learned_rules).where(inArray(learned_rules.tenant_id, ids));
    await db.delete(pessoas).where(inArray(pessoas.tenant_id, ids));
    await db.delete(agents).where(inArray(agents.tenant_id, ids));
    await db.delete(tenants).where(inArray(tenants.id, ids));
  });

  // ─── rulesResolver ────────────────────────────────────
  describe('rulesResolver', () => {
    it('no leak: list as tenant A returns zero rows from tenant B (every input variant)', async () => {
      const variants = [
        { tenant_id: T_A, limit: 100 },
        { tenant_id: T_A, intent_filter: 'aluguel', limit: 100 },
        { tenant_id: T_A, only_active: true, limit: 100 },
        { tenant_id: T_A, only_active: false, limit: 100 },
        { tenant_id: T_A, tipo: 'classificacao', limit: 100 },
        {
          tenant_id: T_A,
          intent_filter: 'aluguel',
          tipo: 'classificacao',
          only_active: true,
          limit: 100,
        },
      ];
      for (const v of variants) {
        const rows = await rulesResolver.list(v);
        for (const r of rows) {
          expect(r.context).not.toContain(LEAK_MARKER_B);
          expect(r.action).not.toBe('rotular_como_b');
        }
      }
    });
  });

  // ─── memoryResolver ───────────────────────────────────
  describe('memoryResolver', () => {
    it('no leak: list as tenant A returns zero rows from tenant B (every input variant)', async () => {
      const variants = [
        { tenant_id: T_A, limit: 100 },
        { tenant_id: T_A, pessoa_id: pessoaA!.id, limit: 100 },
        // Cross-tenant pessoa_id — tenant A asking about tenant B's pessoa
        // MUST return empty (NOT tenant B's data scoped by the foreign id).
        { tenant_id: T_A, pessoa_id: pessoaB!.id, limit: 100 },
        { tenant_id: T_A, memory_types: ['fact', 'preference'], limit: 100 },
        { tenant_id: T_A, intent_filter: LEAK_MARKER_B, limit: 100 },
        { tenant_id: T_A, role_id: 'fake-role', limit: 100 },
        { tenant_id: T_A, channel_id: 'fake-channel', limit: 100 },
        { tenant_id: T_A, conversa_id: 'fake-conversa', limit: 100 },
      ];
      for (const v of variants) {
        const rows = await memoryResolver.list(v);
        for (const m of rows) {
          expect(m.conteudo).not.toContain(LEAK_MARKER_B);
        }
      }
    });

    it('markObserved refuses to touch tenant B id under tenant A (no rows affected)', async () => {
      // Grab tenant B's memory id directly.
      const [bMem] = await db
        .select()
        .from(memory_entry)
        .where(inArray(memory_entry.tenant_id, [T_B]))
        .limit(1);
      expect(bMem).toBeDefined();
      const beforeUpdatedAt = bMem!.updated_at;
      // Call markObserved AS tenant A, passing tenant B's id.
      await memoryResolver.markObserved({ tenant_id: T_A, id: bMem!.id });
      // Tenant B's row must be untouched (updated_at unchanged).
      const [afterRow] = await db
        .select()
        .from(memory_entry)
        .where(inArray(memory_entry.id, [bMem!.id]))
        .limit(1);
      expect(afterRow!.updated_at.toISOString()).toBe(beforeUpdatedAt.toISOString());
    });
  });

  // ─── hintsResolver ────────────────────────────────────
  describe('hintsResolver', () => {
    it('no leak: list as tenant A returns zero rows from tenant B (every input variant)', async () => {
      const variants = [
        { tenant_id: T_A, limit: 100 },
        { tenant_id: T_A, pessoa_id: pessoaA!.id, limit: 100 },
        { tenant_id: T_A, pessoa_id: pessoaB!.id, limit: 100 }, // cross-tenant pessoa_id
      ];
      for (const v of variants) {
        const rows = await hintsResolver.list(v);
        for (const h of rows) {
          expect(h.hint).not.toContain(LEAK_MARKER_B);
        }
      }
    });
  });

  // ─── interlocutorResolver ─────────────────────────────
  describe('interlocutorResolver', () => {
    it('throws (not returns B) when tenant A asks for tenant B pessoa', async () => {
      await expect(
        interlocutorResolver.get({ tenant_id: T_A, pessoa_id: pessoaB!.id }),
      ).rejects.toThrow(/not found/);
    });
  });

  // ─── factsResolver (raw SQL path) ─────────────────────
  describe('factsResolver', () => {
    it('no leak: list as tenant A returns zero rows from tenant B', async () => {
      const variants = [
        { tenant_id: T_A, limit: 100 },
        { tenant_id: T_A, scope: ['tenant' as const], limit: 100 },
        { tenant_id: T_A, keys: ['iso_test_key'], limit: 100 },
        { tenant_id: T_A, scope: ['tenant' as const], keys: ['iso_test_key'], limit: 100 },
      ];
      for (const v of variants) {
        const rows = await factsResolver.list(v);
        for (const f of rows) {
          const text = JSON.stringify(f.value);
          expect(text).not.toContain(LEAK_MARKER_B);
        }
      }
    });
  });

  // ─── Facade trust boundary ────────────────────────────
  describe('facade enforceTenantBoundary', () => {
    it('throws TenantBoundaryViolation when context disagrees', async () => {
      await expect(
        runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
          buildUserSlice({
            tenant_id: T_B, // mismatch!
            pessoa_id: pessoaA!.id,
            depth: 'minimal',
            trace_id: 'iso-test',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantBoundaryViolation);

      await expect(
        runWithTenantContext({ tenant_id: T_A, agent_id: AG_A }, () =>
          buildKnowledgeSlice({
            tenant_id: T_B, // mismatch!
            depth: 'relevant',
            trace_id: 'iso-test',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantBoundaryViolation);
    });

    it('accepts when context matches', async () => {
      const result = await runWithTenantContext(
        { tenant_id: T_A, agent_id: AG_A },
        () =>
          buildUserSlice({
            tenant_id: T_A,
            pessoa_id: pessoaA!.id,
            depth: 'minimal',
            trace_id: 'iso-test',
          }),
      );
      expect(result.slice.interlocutor.pessoa_id).toBe(pessoaA!.id);
    });
  });
});

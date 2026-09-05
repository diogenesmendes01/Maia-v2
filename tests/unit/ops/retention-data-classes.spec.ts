import { describe, it, expect } from 'vitest';
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  UNAPPROVED_POLICY_VERSION,
  getDataClass,
  listDataClasses,
  parseRetentionPolicy,
  resolveRetention,
  classesExcludedFromDump,
  classesIncludedInDump,
  openDpoQuestions,
  openDecisions,
  openDecisionsByOwner,
  ratifiedDecisions,
} from '../../../src/ops/retention/data-classes.js';

/**
 * Issue #520 §9 — the inventory exists; the DEADLINES do not, and must not,
 * until the DPO approves them. These tests are the guard on that boundary.
 */

function approvedPolicy(classes: Record<string, number>): string {
  return JSON.stringify({
    version: 'v1-dpo-2026-07',
    approved_by: 'dpo@example',
    approved_at: '2026-07-01T00:00:00.000Z',
    classes: Object.fromEntries(
      Object.entries(classes).map(([k, days]) => [k, { retention_days: days }]),
    ),
  });
}

describe('the inventory covers every class the issue enumerates', () => {
  it.each([
    'postgres.messages',
    'postgres.conversations',
    'postgres.people',
    'postgres.memory',
    'postgres.financial',
    'postgres.audit',
    'postgres.traces',
    'media.blobs',
    'gateway.baileys_session',
    'queue.redis',
    'backup.artifact',
    'privacy.export',
    'privacy.tombstone',
  ])('includes %s', (id) => {
    expect(() => getDataClass(id)).not.toThrow();
  });

  it('throws on an unknown class instead of inventing a default', () => {
    expect(() => getDataClass('postgres.nope')).toThrowError(/not in the inventory/);
  });

  it('gives every class an owner, a purpose and a purge mechanism', () => {
    for (const c of listDataClasses()) {
      expect(c.data_owner.length).toBeGreaterThan(0);
      expect(c.purpose.length).toBeGreaterThan(0);
      expect(c.purge_mechanism).toBeTruthy();
      expect(c.audit_event.length).toBeGreaterThan(0);
    }
  });
});

describe('no legal deadline is hardcoded (DPO approval pending)', () => {
  it('ships every class with a null retention', () => {
    for (const c of DATA_CLASSES) expect(c.retention_days).toBeNull();
  });

  it('leaves every class pending except the one the platform owner ratified', () => {
    for (const c of DATA_CLASSES) {
      const expected = c.id === 'privacy.tombstone' ? 'ratified_by_owner' : 'pending_dpo';
      expect(c.approval_state, `approval_state de ${c.id}`).toBe(expected);
    }
  });

  it('records, for every class, either an open decision WITH AN OWNER or a ratification', () => {
    // Issue #536: a lista deixou de ser um balaio endereçado ao DPO. Cada item
    // aberto tem dono; cada item fechado tem decisão. Nada fica no meio.
    expect(openDecisions().length + ratifiedDecisions().length).toBe(DATA_CLASSES.length);
    for (const d of openDecisions()) {
      expect(d.question.length).toBeGreaterThan(10);
      expect(['legal_dpo', 'ops', 'security', 'unassigned']).toContain(d.owner);
    }
  });

  it('the default policy in force is the UNAPPROVED one', () => {
    expect(UNAPPROVED_POLICY.approved).toBe(false);
    expect(UNAPPROVED_POLICY.version).toBe(UNAPPROVED_POLICY_VERSION);
  });
});

describe('the remaining decisions are split by owner (issue #536)', () => {
  it('stops printing ops and security items as questions owed to the DPO', () => {
    const dpo = openDpoQuestions().map((q) => q.data_class);
    // `queue.redis` ("ops owns the TTLs") e `gateway.baileys_session` ("the
    // security owner must approve") estavam nesta lista e nunca foram do DPO.
    expect(dpo).not.toContain('queue.redis');
    expect(dpo).not.toContain('gateway.baileys_session');
    expect(dpo).toContain('postgres.messages');
  });

  it('routes each class to the role that can actually answer it', () => {
    const by = openDecisionsByOwner();
    const ids = (owner: keyof typeof by) => by[owner].map((d) => d.data_class);
    expect(ids('ops')).toEqual(
      expect.arrayContaining(['queue.redis', 'media.blobs', 'media.outbound_artifacts']),
    );
    expect(ids('security')).toEqual(['gateway.baileys_session']);
    expect(ids('legal_dpo')).toEqual(
      expect.arrayContaining([
        'postgres.messages',
        'postgres.people',
        'postgres.financial',
        'backup.artifact',
        'privacy.export',
      ]),
    );
  });

  it('keeps the unassigned bucket EXPLICIT instead of parking it under someone else', () => {
    // `postgres.audit` está congelada (nenhuma mudança campo a campo sem a
    // decisão acordada) e a pergunta congelada junta prazo (Legal/DPO) e valor
    // probatório da redação (Security). Separar seria editá-la. Então ela fica
    // visível como "dono a definir" — que é diferente de estar escondida na
    // lista do DPO.
    expect(openDecisionsByOwner().unassigned.map((d) => d.data_class)).toEqual([
      'postgres.audit',
    ]);
  });

  it('every class appears in exactly one bucket', () => {
    const by = openDecisionsByOwner();
    const all = [...by.legal_dpo, ...by.ops, ...by.security, ...by.unassigned];
    expect(all).toHaveLength(openDecisions().length);
    expect(new Set(all.map((d) => d.data_class)).size).toBe(all.length);
  });
});

describe('privacy.tombstone — ratified by the platform owner, not a DPO question', () => {
  it('no longer appears as a question owed to anyone', () => {
    expect(openDecisions().map((d) => d.data_class)).not.toContain('privacy.tombstone');
    expect(openDpoQuestions().map((q) => q.data_class)).not.toContain('privacy.tombstone');
  });

  it('records the ratified design and the argument behind it', () => {
    const ratified = ratifiedDecisions();
    expect(ratified.map((r) => r.data_class)).toEqual(['privacy.tombstone']);
    const decision = ratified[0]?.decision;
    if (decision?.state !== 'ratified_by_owner') throw new Error('shape');
    expect(decision.decision).toContain('not_purgeable');
    // O argumento, não uma reafirmação: um prazo mínimo teria de superar a
    // maior retenção de artefato de backup, e não-purgável elimina a conta.
    expect(decision.rationale).toContain('MINIMUM');
    expect(decision.rationale).toContain('backup');
    expect(decision.still_owed).toBeNull();
  });

  it('is structurally non-purgeable, which is what makes the ratification hold', () => {
    expect(getDataClass('privacy.tombstone').purge_mechanism).toBe('not_purgeable');
  });
});

describe('backup coverage is declared per class (issue §14)', () => {
  it('excludes the media volume, the Baileys session and Redis from the dump', () => {
    const excluded = classesExcludedFromDump();
    expect(excluded).toContain('media.blobs');
    expect(excluded).toContain('gateway.baileys_session');
    expect(excluded).toContain('queue.redis');
  });

  it('includes the Postgres classes in the dump', () => {
    const included = classesIncludedInDump();
    expect(included).toContain('postgres.messages');
    expect(included).toContain('postgres.audit');
  });

  it('partitions the inventory with no class left undeclared', () => {
    expect(classesIncludedInDump().length + classesExcludedFromDump().length).toBe(
      DATA_CLASSES.length,
    );
  });
});

describe('parseRetentionPolicy', () => {
  it('returns the unapproved policy when unset', () => {
    expect(parseRetentionPolicy(undefined).approved).toBe(false);
    expect(parseRetentionPolicy('   ').approved).toBe(false);
  });

  it('returns the unapproved policy on malformed JSON (never a built-in default)', () => {
    expect(parseRetentionPolicy('{oops').approved).toBe(false);
  });

  it('returns the unapproved policy when the approver or version is missing', () => {
    expect(
      parseRetentionPolicy(JSON.stringify({ classes: {}, version: 'v1' })).approved,
    ).toBe(false);
  });

  it('accepts a well-formed, approved policy', () => {
    const p = parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 30 }));
    expect(p.approved).toBe(true);
    expect(p.approved_by).toBe('dpo@example');
    expect(p.classes['postgres.traces']).toEqual({ retention_days: 30 });
  });

  it('silently drops entries for unknown classes', () => {
    const p = parseRetentionPolicy(approvedPolicy({ 'postgres.nope': 5 }));
    expect(p.classes['postgres.nope']).toBeUndefined();
  });

  it('refuses to let a policy make a structurally non-purgeable class purgeable', () => {
    const p = parseRetentionPolicy(
      approvedPolicy({ 'privacy.tombstone': 1, 'postgres.financial': 1 }),
    );
    expect(p.classes['privacy.tombstone']).toBeUndefined();
    expect(p.classes['postgres.financial']).toBeUndefined();
  });

  it('rejects a non-positive retention (a 0-day policy would delete on write)', () => {
    expect(parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 0 })).approved).toBe(false);
  });
});

describe('resolveRetention — backend decides, fail-closed', () => {
  it('refuses to purge anything under the unapproved policy', () => {
    for (const c of DATA_CLASSES) {
      const v = resolveRetention(c.id, UNAPPROVED_POLICY);
      expect(v.purgeable).toBe(false);
      expect(v.retention_days).toBeNull();
    }
  });

  it('reports policy_not_approved as the reason for a purgeable class', () => {
    expect(resolveRetention('postgres.traces', UNAPPROVED_POLICY).reason).toBe(
      'policy_not_approved',
    );
  });

  it('reports class_not_purgeable ahead of the policy state', () => {
    expect(resolveRetention('privacy.tombstone', UNAPPROVED_POLICY).reason).toBe(
      'class_not_purgeable',
    );
    expect(
      resolveRetention(
        'privacy.tombstone',
        parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 30 })),
      ).reason,
    ).toBe('class_not_purgeable');
  });

  it('reports class_not_in_policy for a class the DPO has not ruled on yet', () => {
    const p = parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 30 }));
    expect(resolveRetention('postgres.messages', p).reason).toBe('class_not_in_policy');
    expect(resolveRetention('postgres.messages', p).purgeable).toBe(false);
  });

  it('permits a purge only for an approved class with an approved period', () => {
    const p = parseRetentionPolicy(approvedPolicy({ 'postgres.traces': 30 }));
    expect(resolveRetention('postgres.traces', p)).toEqual({
      purgeable: true,
      retention_days: 30,
      policy_version: 'v1-dpo-2026-07',
      reason: 'ok',
    });
  });

  it('carries the policy version into every verdict (auditable)', () => {
    expect(resolveRetention('postgres.traces', UNAPPROVED_POLICY).policy_version).toBe(
      UNAPPROVED_POLICY_VERSION,
    );
  });
});

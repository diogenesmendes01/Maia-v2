import { describe, it, expect } from 'vitest';
import {
  pseudonymize,
  signTombstone,
  verifyTombstone,
  planReconciliation,
  canReleaseTraffic,
  isResurrected,
  deriveTombstoneSecret,
  TOMBSTONE_KEY_LABEL,
  type TombstoneRecord,
} from '../../../src/ops/retention/tombstones.js';
import { TypedError } from '../../../src/lib/utils.js';

/**
 * Issue #520 §13 — "restore antigo reaplica tombstones posteriores"; "falha de
 * acesso ao ledger bloqueia retorno à produção"; "teste prova que registro
 * excluído antes do restore não reaparece após reconciliação".
 */

const SECRET = 'unit-tombstone-secret';
const WATERMARK = new Date('2026-07-20T00:00:00.000Z');

/** Builds a correctly-signed tombstone; callers tamper with the result. */
function tombstone(over: Partial<Omit<TombstoneRecord, 'hmac'>> = {}): TombstoneRecord {
  const body = {
    id: 'ts-1',
    tenant_id: 'acme',
    agent_id: 'acme-main',
    data_class: 'postgres.messages',
    subject_ref: pseudonymize('+5511999998888', SECRET),
    resource_locator: null,
    action: 'delete' as const,
    effective_at: new Date('2026-07-25T00:00:00.000Z'),
    origin: 'privacy_request' as const,
    version: 1,
    ...over,
  };
  return { ...body, hmac_key_version: 1, hmac: signTombstone(body, SECRET) };
}

describe('pseudonymize', () => {
  it('is deterministic under the same key', () => {
    expect(pseudonymize('+5511999998888', SECRET)).toBe(pseudonymize('+5511999998888', SECRET));
  });

  it('never contains the raw identifier', () => {
    const p = pseudonymize('+5511999998888', SECRET);
    expect(p).not.toContain('5511999998888');
    expect(p).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed — a different secret yields a different pseudonym', () => {
    expect(pseudonymize('+5511999998888', SECRET)).not.toBe(
      pseudonymize('+5511999998888', 'other'),
    );
  });

  it('refuses to run without a secret (would store a raw identifier)', () => {
    expect(() => pseudonymize('+5511999998888', '')).toThrowError(/never store a raw identifier/);
  });
});

describe('tombstone signatures', () => {
  it('round-trips', () => {
    expect(verifyTombstone(tombstone(), SECRET)).toBe(true);
  });

  it('detects an edited effective_at (the field that decides replay)', () => {
    const t = tombstone();
    expect(
      verifyTombstone({ ...t, effective_at: new Date('2026-07-01T00:00:00.000Z') }, SECRET),
    ).toBe(false);
  });

  it('detects an edited subject or class', () => {
    const t = tombstone();
    expect(verifyTombstone({ ...t, subject_ref: 'someone-else' }, SECRET)).toBe(false);
    expect(verifyTombstone({ ...t, data_class: 'media.blobs' }, SECRET)).toBe(false);
  });

  it('detects a planted row signed with another key', () => {
    expect(verifyTombstone(tombstone(), 'wrong-secret')).toBe(false);
  });

  it('returns false (never throws) with no secret', () => {
    expect(verifyTombstone(tombstone(), '')).toBe(false);
  });

  it('refuses to sign without a secret', () => {
    expect(() =>
      signTombstone(
        {
          id: 'x',
          tenant_id: 'a',
          agent_id: 'b',
          data_class: 'c',
          subject_ref: null,
          resource_locator: 'r',
          action: 'delete',
          effective_at: new Date(),
          origin: 'operator',
          version: 1,
        },
        '',
      ),
    ).toThrowError(/cannot block resurrection/);
  });
});

describe('planReconciliation — fail closed', () => {
  it('blocks when the ledger boundary is unreadable', () => {
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: false,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    expect(plan).toMatchObject({ ok: false, blocked_reason: 'ledger_unavailable' });
    expect(plan.pending).toEqual([]);
  });

  it('blocks when the artifact carries no tombstone watermark', () => {
    expect(
      planReconciliation({
        watermark: null,
        ledger_available: true,
        tombstones: [],
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, blocked_reason: 'watermark_missing' });
  });

  it('blocks — and names the rows — when any tombstone fails verification', () => {
    const good = tombstone({ id: 'ts-good' });
    const forged = { ...tombstone({ id: 'ts-forged' }), hmac: 'f'.repeat(64) };
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [good, forged],
      secret: SECRET,
    });
    expect(plan.ok).toBe(false);
    expect(plan.blocked_reason).toBe('invalid_tombstone');
    expect(plan.invalid_ids).toEqual(['ts-forged']);
  });

  it('selects exactly the tombstones newer than the watermark', () => {
    const older = tombstone({ id: 'older', effective_at: new Date('2026-07-10T00:00:00.000Z') });
    const newer = tombstone({ id: 'newer', effective_at: new Date('2026-07-27T00:00:00.000Z') });
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [older, newer],
      secret: SECRET,
    });
    expect(plan.ok).toBe(true);
    expect(plan.pending.map((t) => t.id)).toEqual(['newer']);
  });

  it('excludes a tombstone exactly at the watermark (the snapshot already has it)', () => {
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [tombstone({ id: 'at', effective_at: WATERMARK })],
      secret: SECRET,
    });
    expect(plan.pending).toEqual([]);
  });

  it('orders pending deterministically (oldest effect first, then id)', () => {
    const a = tombstone({ id: 'b', effective_at: new Date('2026-07-26T00:00:00.000Z') });
    const b = tombstone({ id: 'a', effective_at: new Date('2026-07-26T00:00:00.000Z') });
    const c = tombstone({ id: 'c', effective_at: new Date('2026-07-25T12:00:00.000Z') });
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [a, b, c],
      secret: SECRET,
    });
    expect(plan.pending.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('counts pending work per data class without exposing any identifier', () => {
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [
        tombstone({ id: '1' }),
        tombstone({ id: '2' }),
        tombstone({ id: '3', data_class: 'media.blobs', resource_locator: 'loc' }),
      ],
      secret: SECRET,
    });
    expect(plan.by_class).toEqual({ 'postgres.messages': 2, 'media.blobs': 1 });
    expect(JSON.stringify(plan.by_class)).not.toContain('5511');
  });
});

describe('canReleaseTraffic — the restore gate', () => {
  const plan = planReconciliation({
    watermark: WATERMARK,
    ledger_available: true,
    tombstones: [tombstone({ id: 'ts-a' }), tombstone({ id: 'ts-b' })],
    secret: SECRET,
  });

  it('refuses while any pending tombstone has not been re-applied', () => {
    expect(canReleaseTraffic(plan, ['ts-a'])).toEqual({
      release: false,
      reason: 'tombstones_not_reapplied',
    });
  });

  it('refuses outright when the plan itself is blocked', () => {
    const blocked = planReconciliation({
      watermark: null,
      ledger_available: true,
      tombstones: [],
      secret: SECRET,
    });
    expect(canReleaseTraffic(blocked, [])).toEqual({
      release: false,
      reason: 'watermark_missing',
    });
  });

  it('releases only once every pending tombstone is confirmed applied', () => {
    expect(canReleaseTraffic(plan, ['ts-a', 'ts-b'])).toEqual({ release: true, reason: 'ok' });
  });

  it('releases immediately when there is nothing to re-apply', () => {
    const clean = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [],
      secret: SECRET,
    });
    expect(canReleaseTraffic(clean, [])).toEqual({ release: true, reason: 'ok' });
  });
});

describe('isResurrected — the end-to-end anti-resurrection property', () => {
  it('recognises a restored row that a later tombstone deleted', () => {
    const subject = pseudonymize('+5511999998888', SECRET);
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [tombstone({ id: 'ts-x', subject_ref: subject })],
      secret: SECRET,
    });
    // The restore brought this person's messages back; the ledger says no.
    expect(
      isResurrected(plan, {
        data_class: 'postgres.messages',
        subject_ref: pseudonymize('+5511999998888', SECRET),
        resource_locator: null,
      }),
    ).toBe(true);
  });

  it('leaves an unrelated subject alone', () => {
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    expect(
      isResurrected(plan, {
        data_class: 'postgres.messages',
        subject_ref: pseudonymize('+5511911112222', SECRET),
        resource_locator: null,
      }),
    ).toBe(false);
  });

  it('does not cross data classes', () => {
    const subject = pseudonymize('+5511999998888', SECRET);
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [tombstone({ subject_ref: subject })],
      secret: SECRET,
    });
    expect(
      isResurrected(plan, {
        data_class: 'media.blobs',
        subject_ref: subject,
        resource_locator: null,
      }),
    ).toBe(false);
  });

  it('matches a media object by its pseudonymised locator', () => {
    const locator = pseudonymize('/app/media/abc.ogg', SECRET);
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [
        tombstone({
          id: 'ts-media',
          data_class: 'media.blobs',
          subject_ref: null,
          resource_locator: locator,
        }),
      ],
      secret: SECRET,
    });
    expect(
      isResurrected(plan, {
        data_class: 'media.blobs',
        subject_ref: null,
        resource_locator: locator,
      }),
    ).toBe(true);
  });

  it('never matches on a null target (a plan entry with no locator matches nothing by locator)', () => {
    const plan = planReconciliation({
      watermark: WATERMARK,
      ledger_available: true,
      tombstones: [tombstone({ resource_locator: null })],
      secret: SECRET,
    });
    expect(
      isResurrected(plan, {
        data_class: 'postgres.messages',
        subject_ref: null,
        resource_locator: null,
      }),
    ).toBe(false);
  });
});

/**
 * Issue #536 — the ledger's keying material.
 *
 * Nothing writes a tombstone yet, so the derivation can still be DEFINED
 * rather than discovered. Once rows exist it is frozen: a different derivation
 * makes every existing HMAC fail, and an unverifiable ledger blocks every
 * restore by design.
 */
describe('deriveTombstoneSecret', () => {
  it('is deterministic', () => {
    expect(deriveTombstoneSecret('master')).toBe(deriveTombstoneSecret('master'));
  });

  it('is DOMAIN-SEPARATED from the master secret it descends from', () => {
    // Using one secret for two protocols is how a signature produced by one
    // becomes a valid signature in the other. The manifest signer uses the
    // master directly; the ledger must not.
    expect(deriveTombstoneSecret('master')).not.toBe('master');
    expect(deriveTombstoneSecret('master')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates two master secrets', () => {
    expect(deriveTombstoneSecret('a')).not.toBe(deriveTombstoneSecret('b'));
  });

  it('THROWS when no master secret is configured — never returns a weak key', () => {
    expect(() => deriveTombstoneSecret(undefined)).toThrow(TypedError);
    expect(() => deriveTombstoneSecret('')).toThrow(TypedError);
  });

  it('produces a key that actually signs and verifies a tombstone', () => {
    const secret = deriveTombstoneSecret('master');
    const body = {
      id: 'ts-derived',
      tenant_id: 'acme',
      agent_id: 'fin',
      data_class: 'postgres.messages',
      subject_ref: 'pseudo',
      resource_locator: null,
      action: 'delete' as const,
      effective_at: new Date('2026-07-25T00:00:00.000Z'),
      origin: 'privacy_request' as const,
      version: 1,
    };
    const record: TombstoneRecord = {
      ...body,
      hmac: signTombstone(body, secret),
      hmac_key_version: 1,
    };
    expect(verifyTombstone(record, secret)).toBe(true);
    // A tombstone keyed with the RAW master does not verify under the derived
    // key — the separation is real, not cosmetic.
    expect(verifyTombstone({ ...record, hmac: signTombstone(body, 'master') }, secret)).toBe(false);
  });

  it('the derivation label is pinned (changing it invalidates the whole ledger)', () => {
    expect(TOMBSTONE_KEY_LABEL).toBe('maia.tombstone.hmac.v1');
  });
});

/**
 * Issue #327 — provider-side dedup key derivation.
 *
 * `deriveProviderDedupKey` turns an outbox row's STABLE identity
 * (tenant_id, agent_id, idempotency_key) into a DETERMINISTIC provider-side
 * message id. The relayer passes it on the external send so a crash-induced
 * re-dispatch carries the SAME id → the transport dedups the duplicate
 * (closing the at-least-once tail #316 left open).
 *
 * These tests pin the contract that makes that work:
 *   - DETERMINISM: same identity → byte-identical key (so a retry matches).
 *   - WHATSAPP FORMAT: `3EB0` + 18 uppercase hex (the exact shape Baileys'
 *     generateMessageIDV2 emits) so the id is a valid WA message key id.
 *   - TENANT ISOLATION (inviolable): tenant/agent are folded into the hash, so
 *     two tenants with the same idempotency_key get DIFFERENT keys — the key is
 *     never a cross-tenant correlation handle and one tenant can't dedup another.
 *   - DELIMITER COLLISION-RESISTANCE: the tuple is joined with a separator so
 *     concatenation-ambiguous identities (`a|bc` vs `ab|c`) don't collide.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveProviderDedupKey,
  type PlannedEffect,
  type OutboxRowIdentity,
} from '@/governance/idempotency-effects.js';

const WA_EFFECT: PlannedEffect = {
  kind: 'whatsapp_text',
  jid: '5511999990000@s.whatsapp.net',
  text: 'olá',
  mensagem_id: 'm1',
};

const IDENTITY: OutboxRowIdentity = {
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  idempotency_key: 'ik-123',
};

describe('deriveProviderDedupKey — whatsapp_text', () => {
  it('is DETERMINISTIC: same identity → identical key', () => {
    const k1 = deriveProviderDedupKey(WA_EFFECT, IDENTITY);
    const k2 = deriveProviderDedupKey(WA_EFFECT, { ...IDENTITY });
    expect(k1).toBe(k2);
    expect(k1).not.toBeNull();
  });

  it('does NOT depend on the effect PAYLOAD (only on the row identity)', () => {
    // The key is derived from identity, NOT from jid/text. Two effects with the
    // same identity but different bodies still map to the same key — the
    // identity is the dedup primitive, and a given outbox row has one identity.
    const k1 = deriveProviderDedupKey(WA_EFFECT, IDENTITY);
    const k2 = deriveProviderDedupKey(
      { ...WA_EFFECT, text: 'completely different body' },
      IDENTITY,
    );
    expect(k1).toBe(k2);
  });

  it('matches the native WhatsApp message-id shape (3EB0 + 18 uppercase hex)', () => {
    const key = deriveProviderDedupKey(WA_EFFECT, IDENTITY)!;
    expect(key).toMatch(/^3EB0[0-9A-F]{18}$/);
    expect(key).toHaveLength(22);
  });

  it('TENANT ISOLATION: differs by tenant_id even with identical idempotency_key', () => {
    const a = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'tenant-A',
      agent_id: 'agent-X',
      idempotency_key: 'same',
    });
    const b = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'tenant-B',
      agent_id: 'agent-X',
      idempotency_key: 'same',
    });
    expect(a).not.toBe(b);
  });

  it('differs by agent_id even with identical tenant_id + idempotency_key', () => {
    const a = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'tenant-A',
      agent_id: 'agent-1',
      idempotency_key: 'same',
    });
    const b = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'tenant-A',
      agent_id: 'agent-2',
      idempotency_key: 'same',
    });
    expect(a).not.toBe(b);
  });

  it('differs by idempotency_key within the same tenant/agent', () => {
    const a = deriveProviderDedupKey(WA_EFFECT, { ...IDENTITY, idempotency_key: 'k-A' });
    const b = deriveProviderDedupKey(WA_EFFECT, { ...IDENTITY, idempotency_key: 'k-B' });
    expect(a).not.toBe(b);
  });

  it('is collision-resistant across concatenation-ambiguous identities (delimiter)', () => {
    // Without a delimiter, ('ab','c','d') and ('a','bc','d') would concatenate
    // to the same string and collide. The NUL/space-delimited join prevents it.
    const a = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'ab',
      agent_id: 'c',
      idempotency_key: 'd',
    });
    const b = deriveProviderDedupKey(WA_EFFECT, {
      tenant_id: 'a',
      agent_id: 'bc',
      idempotency_key: 'd',
    });
    expect(a).not.toBe(b);
  });
});

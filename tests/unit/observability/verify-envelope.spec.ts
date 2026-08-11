/**
 * Issue #514 review round 1 [P2] — the Trace Explorer must VERIFY the envelope
 * signature, not merely observe that a string is present.
 *
 * The old check was `envelope_hmac.length > 0`, so a tampered envelope was
 * reported to the operator as "signed". These tests tamper with each signed
 * field in turn, and with the signature itself, and require `invalid` — a check
 * that only looked at the string length would pass every one of them as signed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  verifyEnvelopeIntegrity,
  verifyBodyIntegrity,
} from '@/control-plane/runtime-trace/verify-envelope.js';
import { envelopeSignedPayload } from '@/control-plane/runtime-trace/envelope-writer.js';
import {
  signHmac,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
  _clearTestMasterSecretForTests,
  _setTestKeyringEntryForTests,
} from '@/control-plane/runtime-trace/lib/hmac.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function signedRow(over: Record<string, unknown> = {}) {
  const fields = {
    trace_id: TRACE_ID,
    tenant_id: 'acme',
    agent_id: 'a1',
    conversa_id: CONVERSA_ID,
    turno_id: TURNO_ID,
    policy_id: 'pol-1',
    decision: 'allow' as const,
    side_effect_level: 'medium' as const,
    redaction_class: 'standard',
    hmac_key_version: 1,
    ...over,
  };
  return {
    ...fields,
    envelope_hmac: signHmac(fields.tenant_id, fields.hmac_key_version, envelopeSignedPayload(fields)),
  };
}

describe('issue #514 [P2] — envelope integrity verification', () => {
  beforeEach(() => {
    _resetHmacCacheForTests();
    _setTestMasterSecretForTests('verify-envelope-spec-master-secret');
  });
  afterEach(() => {
    _clearTestMasterSecretForTests();
    _resetHmacCacheForTests();
  });

  it('an untouched envelope verifies', () => {
    expect(verifyEnvelopeIntegrity(signedRow())).toBe('verified');
  });

  describe('payload tampering — every signed field is covered', () => {
    it.each([
      ['decision', 'deny'],
      ['side_effect_level', 'none'],
      ['tenant_id', 'other-tenant'],
      ['agent_id', 'other-agent'],
      ['policy_id', 'pol-2'],
      ['redaction_class', 'minimal'],
      ['trace_id', '00000000-0000-4000-8000-000000000000'],
      ['conversa_id', '22222222-2222-4222-8222-222222222222'],
      ['turno_id', '33333333-3333-4333-8333-333333333333'],
    ])('flipping %s ⇒ invalid', (field, value) => {
      const row = signedRow();
      const tampered = { ...row, [field]: value };
      expect(verifyEnvelopeIntegrity(tampered)).toBe('invalid');
    });

    it('nulling an optional signed field ⇒ invalid', () => {
      const row = signedRow();
      expect(verifyEnvelopeIntegrity({ ...row, conversa_id: null })).toBe('invalid');
      expect(verifyEnvelopeIntegrity({ ...row, policy_id: null })).toBe('invalid');
    });

    it('escalating the side effect level (the dangerous edit) ⇒ invalid', () => {
      // The edit an attacker would actually make: make a `critical` effect look
      // like it was recorded as harmless.
      const row = signedRow({ side_effect_level: 'critical' });
      expect(verifyEnvelopeIntegrity({ ...row, side_effect_level: 'low' })).toBe('invalid');
    });
  });

  describe('signature tampering', () => {
    it('a mutated signature ⇒ invalid', () => {
      const row = signedRow();
      const flipped =
        row.envelope_hmac.slice(0, -2) + (row.envelope_hmac.endsWith('A') ? 'B' : 'A') + '=';
      expect(verifyEnvelopeIntegrity({ ...row, envelope_hmac: flipped })).toBe('invalid');
    });

    it('an empty signature ⇒ invalid (never "unknown")', () => {
      // A signature was mandatory at write time, so its absence is a failure,
      // not an inability to check.
      expect(verifyEnvelopeIntegrity({ ...signedRow(), envelope_hmac: '' })).toBe('invalid');
    });

    it("another tenant's valid signature ⇒ invalid (keys are tenant-derived)", () => {
      const mine = signedRow({ tenant_id: 'tenant-a' });
      const theirs = signedRow({ tenant_id: 'tenant-b' });
      expect(
        verifyEnvelopeIntegrity({ ...mine, envelope_hmac: theirs.envelope_hmac }),
      ).toBe('invalid');
    });

    it('a signature from a different key version ⇒ invalid', () => {
      _setTestKeyringEntryForTests(2, 'a-different-master-secret-for-v2');
      const row = signedRow({ hmac_key_version: 1 });
      const v2 = signHmac('acme', 2, envelopeSignedPayload({ ...row, hmac_key_version: 2 }));
      expect(verifyEnvelopeIntegrity({ ...row, envelope_hmac: v2 })).toBe('invalid');
    });
  });

  describe('unknown — cannot verify is NOT the same as tampered', () => {
    it('a key version with no configured secret ⇒ unknown', () => {
      const row = signedRow();
      // Version 99 has no secret in this process (rotated out, or a reader
      // deployed without it). Collapsing this into `invalid` would cry
      // tampering at every key rotation.
      expect(verifyEnvelopeIntegrity({ ...row, hmac_key_version: 99 })).toBe('unknown');
    });

    it('no master secret configured at all ⇒ unknown, and never throws', () => {
      const row = signedRow();
      _clearTestMasterSecretForTests();
      _resetHmacCacheForTests();
      let result: string | undefined;
      expect(() => {
        result = verifyEnvelopeIntegrity(row);
      }).not.toThrow();
      expect(result).toBe('unknown');
    });
  });

  describe('body packet_hmac [round 2 P2]', () => {
    // `body-writer.ts` signs the EXACT jsonb it stores in `packet`. The column
    // was persisted and never read back — same class of gap as the envelope.
    function signedBody(packet: unknown, over: Record<string, unknown> = {}) {
      const tenant_id = (over.tenant_id as string) ?? 'acme';
      const hmac_key_version = (over.hmac_key_version as number) ?? 1;
      return {
        tenant_id,
        hmac_key_version,
        packet,
        packet_hmac: signHmac(tenant_id, hmac_key_version, packet),
        ...over,
      };
    }

    it('an untouched body verifies', () => {
      expect(verifyBodyIntegrity(signedBody({ trace_id: TRACE_ID, decision_meta: { a: 1 } }))).toBe(
        'verified',
      );
    });

    it('a tampered packet ⇒ invalid', () => {
      const row = signedBody({ trace_id: TRACE_ID, decision_meta: { risk_score: 0.9 } });
      expect(
        verifyBodyIntegrity({
          ...row,
          packet: { trace_id: TRACE_ID, decision_meta: { risk_score: 0.1 } },
        }),
      ).toBe('invalid');
    });

    it('a tampered signature ⇒ invalid', () => {
      const row = signedBody({ trace_id: TRACE_ID });
      expect(verifyBodyIntegrity({ ...row, packet_hmac: 'AAAA' })).toBe('invalid');
    });

    it('key ordering does not matter (canonical JSON)', () => {
      const row = signedBody({ a: 1, b: 2 });
      expect(verifyBodyIntegrity({ ...row, packet: { b: 2, a: 1 } })).toBe('verified');
    });

    it("another tenant's key ⇒ invalid", () => {
      const mine = signedBody({ trace_id: TRACE_ID }, { tenant_id: 'tenant-a' });
      const theirs = signedBody({ trace_id: TRACE_ID }, { tenant_id: 'tenant-b' });
      expect(
        verifyBodyIntegrity({ ...mine, packet_hmac: theirs.packet_hmac }),
      ).toBe('invalid');
    });

    it('an ENCRYPTED body still verifies — the writer signs what it stores', () => {
      // For redaction_class=debug the stored packet is the cipher envelope
      // metadata, not the plaintext; it is signed all the same.
      const cipherRow = signedBody({
        __encrypted: true,
        cipher: { iv: 'aaa', tag: 'bbb', key_version: 1 },
        storage: 'inline',
      });
      expect(verifyBodyIntegrity(cipherRow)).toBe('verified');
    });

    it('a body that does not exist yet ⇒ absent, NOT invalid', () => {
      // Pending body. Nothing to verify is not a failure to verify.
      expect(verifyBodyIntegrity(null)).toBe('absent');
      expect(verifyBodyIntegrity(undefined)).toBe('absent');
    });

    it('a stored body with no signature ⇒ invalid', () => {
      const row = signedBody({ trace_id: TRACE_ID });
      expect(verifyBodyIntegrity({ ...row, packet_hmac: '' })).toBe('invalid');
    });

    it('an unavailable key version ⇒ unknown, and never throws', () => {
      const row = signedBody({ trace_id: TRACE_ID });
      let result: string | undefined;
      expect(() => {
        result = verifyBodyIntegrity({ ...row, hmac_key_version: 99 });
      }).not.toThrow();
      expect(result).toBe('unknown');
    });
  });

  it('signer and verifier share ONE payload definition (cannot drift)', () => {
    // If someone adds a field to the signature in `envelopeSignedPayload`, the
    // verifier picks it up for free — that is the point of the shared helper.
    const row = signedRow();
    const payload = envelopeSignedPayload(row);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'agent_id',
        'conversa_id',
        'decision',
        'hmac_key_version',
        'policy_id',
        'redaction_class',
        'side_effect_level',
        'tenant_id',
        'trace_id',
        'turno_id',
      ].sort(),
    );
  });
});

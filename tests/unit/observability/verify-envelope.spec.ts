/**
 * Issue #514 review round 1 [P2] — the Trace Explorer must VERIFY the envelope
 * signature, not merely observe that a string is present.
 *
 * The old check was `envelope_hmac.length > 0`, so a tampered envelope was
 * reported to the operator as "signed". These tests tamper with each signed
 * field in turn, and with the signature itself, and require `invalid` — a check
 * that only looked at the string length would pass every one of them as signed.
 *
 * Issue #535 adds the payload-version axis. Two things must hold at once and
 * they pull in opposite directions, which is why both are pinned here:
 *
 *   1. A v1 envelope — written before `root_trace_id`/`attempt` were signed —
 *      still verifies. Widening a signature must not retroactively convict
 *      every row that predates the widening.
 *   2. A v2 envelope whose `attempt` or `root_trace_id` was edited is
 *      `invalid`. That is the entire point of the change; if it were not
 *      testable, the change would be decorative.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  verifyEnvelopeIntegrity,
  verifyBodyIntegrity,
} from '@/control-plane/runtime-trace/verify-envelope.js';
import {
  envelopeSignedPayload,
  isKnownEnvelopePayloadVersion,
  ENVELOPE_PAYLOAD_VERSION_V1,
  ENVELOPE_PAYLOAD_VERSION_V2,
  CURRENT_ENVELOPE_PAYLOAD_VERSION,
  type EnvelopePayloadVersion,
} from '@/control-plane/runtime-trace/envelope-writer.js';
import {
  signHmac,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
  _clearTestMasterSecretForTests,
  _setTestKeyringEntryForTests,
} from '@/control-plane/runtime-trace/lib/hmac.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const ROOT_TRACE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

/**
 * A row exactly as the writer of `version` would have left it: fields, the
 * version column, and a signature computed over THAT version's payload.
 *
 * The signature goes through `envelopeSignedPayload` rather than an inlined
 * literal on purpose — a second hand-written copy of the payload here would be
 * the drift the shared helper exists to prevent, and it would let the spec
 * agree with itself while disagreeing with the writer.
 */
function signedRow(
  version: EnvelopePayloadVersion = CURRENT_ENVELOPE_PAYLOAD_VERSION,
  over: Record<string, unknown> = {},
) {
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
    root_trace_id: ROOT_TRACE_ID,
    attempt: 2,
    ...over,
  };
  return {
    ...fields,
    envelope_payload_version: version,
    envelope_hmac: signHmac(
      fields.tenant_id,
      fields.hmac_key_version,
      envelopeSignedPayload(fields, version),
    ),
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
    // Run the whole table against BOTH payload versions: the v1 field set is a
    // strict subset of v2, so every one of these must stay covered after the
    // widening.
    const versions: EnvelopePayloadVersion[] = [
      ENVELOPE_PAYLOAD_VERSION_V1,
      ENVELOPE_PAYLOAD_VERSION_V2,
    ];

    for (const version of versions) {
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
      ])(`v${version}: flipping %s ⇒ invalid`, (field, value) => {
        const row = signedRow(version);
        const tampered = { ...row, [field]: value };
        expect(verifyEnvelopeIntegrity(tampered)).toBe('invalid');
      });
    }

    it('nulling an optional signed field ⇒ invalid', () => {
      const row = signedRow();
      expect(verifyEnvelopeIntegrity({ ...row, conversa_id: null })).toBe('invalid');
      expect(verifyEnvelopeIntegrity({ ...row, policy_id: null })).toBe('invalid');
    });

    it('escalating the side effect level (the dangerous edit) ⇒ invalid', () => {
      // The edit an attacker would actually make: make a `critical` effect look
      // like it was recorded as harmless.
      const row = signedRow(CURRENT_ENVELOPE_PAYLOAD_VERSION, {
        side_effect_level: 'critical',
      });
      expect(verifyEnvelopeIntegrity({ ...row, side_effect_level: 'low' })).toBe('invalid');
    });
  });

  /**
   * Issue #535 — the owner's decision: `root_trace_id` and `attempt` are the
   * only evidence that was outside the signature, and they are what a forensic
   * read of a retry rests on.
   */
  describe('#535 — attempt grouping is signed from v2 on', () => {
    it('a v2 envelope with a re-ordered ATTEMPT ⇒ invalid', () => {
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2, { attempt: 2 });
      // The edit that mattered: make attempt 2 (the retry that succeeded after
      // a denied first try) read as attempt 1, and the sequence of the turn
      // inverts for whoever reads it next.
      expect(verifyEnvelopeIntegrity({ ...row, attempt: 1 })).toBe('invalid');
      expect(verifyEnvelopeIntegrity({ ...row, attempt: 7 })).toBe('invalid');
    });

    it('a v2 envelope re-parented to another ROOT ⇒ invalid', () => {
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
      expect(
        verifyEnvelopeIntegrity({
          ...row,
          root_trace_id: '44444444-4444-4444-8444-444444444444',
        }),
      ).toBe('invalid');
      // Detaching it from its turn entirely is the same tampering.
      expect(verifyEnvelopeIntegrity({ ...row, root_trace_id: null })).toBe('invalid');
    });

    it('an attempt of 0 is not silently repaired into the signed 1', () => {
      // The writer clamps its INPUT before signing. If the payload builder
      // clamped as well, this row — `attempt` edited below the clamp floor —
      // would be normalised back to the value that was signed and reported
      // `verified`. A signer must not be able to fix its input.
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2, { attempt: 1 });
      expect(verifyEnvelopeIntegrity({ ...row, attempt: 0 })).toBe('invalid');
      expect(verifyEnvelopeIntegrity({ ...row, attempt: -3 })).toBe('invalid');
    });
  });

  /**
   * The half of #535 that is easy to break and expensive to notice: rows
   * written before the widening.
   */
  describe('#535 — dual verification keeps existing envelopes valid', () => {
    it('a v1 envelope still verifies after the widening', () => {
      // This row is byte-identical to what the #514 writer produced. If the
      // verifier recomputed every row with the v2 payload, this would be
      // `invalid` — a signature change turning the entire history into an
      // integrity incident.
      expect(verifyEnvelopeIntegrity(signedRow(ENVELOPE_PAYLOAD_VERSION_V1))).toBe('verified');
    });

    it('a v1 envelope with a NULL root_trace_id verifies too (pre-107 row)', () => {
      // Migration 107 backfilled the root, but a row written by a replica that
      // predated it can hold NULL. v1 never signed the column, so its value
      // cannot make or break the check.
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V1, { root_trace_id: null, attempt: 1 });
      expect(verifyEnvelopeIntegrity(row)).toBe('verified');
    });

    it('v1 does NOT cover attempt grouping — the gap #535 closes, stated out loud', () => {
      // Documenting the residual exposure rather than implying the change is
      // retroactive: on a v1 row these columns remain unsigned, and the
      // Explorer says so (`attempt_grouping_signed`).
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V1, { attempt: 1 });
      expect(verifyEnvelopeIntegrity({ ...row, attempt: 9 })).toBe('verified');
      // Whereas the same edit on a v2 row is caught.
      const v2 = signedRow(ENVELOPE_PAYLOAD_VERSION_V2, { attempt: 1 });
      expect(verifyEnvelopeIntegrity({ ...v2, attempt: 9 })).toBe('invalid');
    });

    it('the two versions produce DIFFERENT signatures for the same fields', () => {
      // If they collided, "dual verification" would be a no-op and every test
      // above would pass for the wrong reason.
      const v1 = signedRow(ENVELOPE_PAYLOAD_VERSION_V1);
      const v2 = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
      expect(v1.envelope_hmac).not.toBe(v2.envelope_hmac);
    });
  });

  describe('#535 — the version column is itself signed', () => {
    it('downgrading a v2 row to v1 ⇒ invalid, not a way to drop fields', () => {
      // The attack the version tag exists to block: edit `attempt`, then set
      // the version to 1 so the verifier stops looking at it.
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
      expect(
        verifyEnvelopeIntegrity({
          ...row,
          attempt: 99,
          envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V1,
        }),
      ).toBe('invalid');
      // Even without touching any other field.
      expect(
        verifyEnvelopeIntegrity({ ...row, envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V1 }),
      ).toBe('invalid');
    });

    it('promoting a v1 row to v2 ⇒ invalid', () => {
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V1);
      expect(
        verifyEnvelopeIntegrity({ ...row, envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V2 }),
      ).toBe('invalid');
    });
  });

  describe('#535 — an unrecognised payload version is `invalid`, never `unknown`', () => {
    it.each([[0], [3], [99], [-1], [1.5], [Number.NaN]])(
      'version %s ⇒ invalid',
      (version) => {
        const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
        expect(
          verifyEnvelopeIntegrity({ ...row, envelope_payload_version: version as number }),
        ).toBe('invalid');
      },
    );

    it.each([[null], [undefined], ['2'], [{}]])(
      'a non-numeric version (%s) ⇒ invalid, and never throws',
      (version) => {
        const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
        let result: string | undefined;
        expect(() => {
          result = verifyEnvelopeIntegrity({
            ...row,
            envelope_payload_version: version as unknown as number,
          });
        }).not.toThrow();
        expect(result).toBe('invalid');
      },
    );

    it('stays `invalid` even when the key is ALSO unavailable', () => {
      // Ordering is deliberate: the payload version is checked first because a
      // version nobody implemented is malformed regardless of which keys this
      // reader happens to hold. Answering `unknown` here would let an attacker
      // opt any row out of verification by writing a number from the future.
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V2);
      expect(
        verifyEnvelopeIntegrity({
          ...row,
          envelope_payload_version: 42,
          hmac_key_version: 99, // no secret configured for this version
        }),
      ).toBe('invalid');
    });

    it('the guard agrees with the constants', () => {
      expect(isKnownEnvelopePayloadVersion(ENVELOPE_PAYLOAD_VERSION_V1)).toBe(true);
      expect(isKnownEnvelopePayloadVersion(ENVELOPE_PAYLOAD_VERSION_V2)).toBe(true);
      expect(isKnownEnvelopePayloadVersion(CURRENT_ENVELOPE_PAYLOAD_VERSION)).toBe(true);
      for (const v of [0, 3, -1, 1.5, Number.NaN, null, undefined, '1', {}]) {
        expect(isKnownEnvelopePayloadVersion(v)).toBe(false);
      }
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
      const mine = signedRow(CURRENT_ENVELOPE_PAYLOAD_VERSION, { tenant_id: 'tenant-a' });
      const theirs = signedRow(CURRENT_ENVELOPE_PAYLOAD_VERSION, { tenant_id: 'tenant-b' });
      expect(
        verifyEnvelopeIntegrity({ ...mine, envelope_hmac: theirs.envelope_hmac }),
      ).toBe('invalid');
    });

    it('a signature from a different key version ⇒ invalid', () => {
      _setTestKeyringEntryForTests(2, 'a-different-master-secret-for-v2');
      const row = signedRow(CURRENT_ENVELOPE_PAYLOAD_VERSION, { hmac_key_version: 1 });
      const v2 = signHmac(
        'acme',
        2,
        envelopeSignedPayload({ ...row, hmac_key_version: 2 }, CURRENT_ENVELOPE_PAYLOAD_VERSION),
      );
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

    it('a v1 row is unverifiable for the same reason, not a different one', () => {
      // The two version axes are independent: a missing KEY is `unknown` at
      // either payload version.
      const row = signedRow(ENVELOPE_PAYLOAD_VERSION_V1);
      expect(verifyEnvelopeIntegrity({ ...row, hmac_key_version: 99 })).toBe('unknown');
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

  describe('signer and verifier share ONE payload definition (cannot drift)', () => {
    const V1_KEYS = [
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
    ];

    it('v1 covers exactly the #514 field set', () => {
      // If someone adds a field to the signature in `envelopeSignedPayload`, the
      // verifier picks it up for free — that is the point of the shared helper.
      // Pinning the v1 key set is what keeps a future widening from silently
      // landing on the OLD version and invalidating history.
      const payload = envelopeSignedPayload(signedRow(), ENVELOPE_PAYLOAD_VERSION_V1);
      expect(Object.keys(payload).sort()).toEqual([...V1_KEYS].sort());
    });

    it('v2 = v1 + attempt grouping + the version tag', () => {
      const payload = envelopeSignedPayload(signedRow(), ENVELOPE_PAYLOAD_VERSION_V2);
      expect(Object.keys(payload).sort()).toEqual(
        [...V1_KEYS, 'root_trace_id', 'attempt', 'envelope_payload_version'].sort(),
      );
      expect((payload as { envelope_payload_version: number }).envelope_payload_version).toBe(
        ENVELOPE_PAYLOAD_VERSION_V2,
      );
    });

    it('the current write version is v2', () => {
      expect(CURRENT_ENVELOPE_PAYLOAD_VERSION).toBe(ENVELOPE_PAYLOAD_VERSION_V2);
    });
  });
});

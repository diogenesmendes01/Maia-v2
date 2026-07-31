/**
 * Issue #536 — the owner's proposal, materialised.
 *
 * TWO THINGS THESE TESTS EXIST TO GUARANTEE.
 *
 * 1. THE PROPOSAL DELETES NOTHING. It is a proposal pending homologation by
 *    the DPO and the accountant, not an approval, and certainly not a claim of
 *    compliance. Every guard that keeps it inert is asserted here.
 * 2. THE THREE COPIES CANNOT DRIFT. The same value ships in the module, in the
 *    configuration contract's `example` (which becomes `.env.example`) and in
 *    the retention matrix document. Pinning them is the only reason it is safe
 *    to have three.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PENDING_HOMOLOGATION_APPROVER,
  PROPOSED_POLICY_ROWS,
  PROPOSED_POLICY_VERSION,
  PROPOSED_RETENTION_POLICY,
  PROPOSED_RETENTION_POLICY_JSON,
  proposedRowFor,
} from '../../../src/ops/retention/proposed-policy.js';
import {
  DATA_CLASSES,
  getDataClass,
  parseRetentionPolicy,
  resolveRetention,
} from '../../../src/ops/retention/data-classes.js';
import { resolveEffectiveRetention } from '../../../src/ops/retention/derivation.js';
import { DEFAULT_TOMBSTONE_MIN_DAYS } from '../../../src/ops/retention/tombstone-floor.js';
import { ENV_CONTRACT } from '../../../src/config/contract.js';

const REPO_ROOT = join(__dirname, '../../..');
const MATRIX = join(REPO_ROOT, 'docs/architecture/concerns/data-retention-matrix.md');

const parsed = parseRetentionPolicy(PROPOSED_RETENTION_POLICY_JSON);

describe('a PROPOSAL is not an approval', () => {
  it('is signed with the pending-homologation sentinel', () => {
    expect(PROPOSED_RETENTION_POLICY.approved_by).toBe(PENDING_HOMOLOGATION_APPROVER);
    expect(PENDING_HOMOLOGATION_APPROVER).toBe('pending_dpo_homologation');
  });

  it('parses as structurally valid but NOT homologated', () => {
    expect(parsed.approved).toBe(true);
    expect(parsed.homologated).toBe(false);
  });

  it('leaves every class in dry-run, so nothing is armed', () => {
    expect(Object.keys(parsed.classes).length).toBeGreaterThan(0);
    for (const [id, entry] of Object.entries(parsed.classes)) {
      expect(entry.dry_run, id).toBe(true);
    }
  });

  it('never speaks about a structurally non-purgeable class', () => {
    for (const id of Object.keys(PROPOSED_RETENTION_POLICY.classes)) {
      expect(getDataClass(id).purge_mechanism, id).not.toBe('not_purgeable');
    }
  });
});

describe('the numbers are the owner’s', () => {
  it.each([
    ['postgres.traces', 30],
    ['postgres.messages', 180],
    ['postgres.messages.audio_transcript', 30],
    ['postgres.conversations', 180],
    ['postgres.people', 180],
    ['postgres.memory', 180],
    ['postgres.audit', 180],
    ['media.blobs', 7],
    ['backup.artifact', 30],
    ['privacy.export', 7],
  ])('%s → %i days', (id, days) => {
    expect(resolveRetention(id, parsed).retention_days).toBe(days);
  });

  it('gives the audio transcript a SHORTER period than the message body', () => {
    const transcript = resolveEffectiveRetention('postgres.messages.audio_transcript', parsed);
    const body = resolveEffectiveRetention('postgres.messages', parsed);
    expect(transcript.retention_days!).toBeLessThan(body.retention_days!);
  });

  it('does not let the conversation shell outlive its messages', () => {
    expect(resolveEffectiveRetention('postgres.conversations', parsed).retention_days).toBe(
      resolveEffectiveRetention('postgres.messages', parsed).retention_days,
    );
  });

  it('proposes no period for user-pinned memory — the finality comes first', () => {
    expect(proposedRowFor('postgres.memory.pinned')?.kind).toBe('undecided');
    expect(PROPOSED_RETENTION_POLICY.classes['postgres.memory.pinned']).toBeUndefined();
  });

  it('states the tombstone floor as a MINIMUM, not a purge period', () => {
    const row = proposedRowFor('privacy.tombstone');
    expect(row?.kind).toBe('minimum_floor');
    expect(row?.retention_days).toBeNull();
    expect(row?.policy).toContain(String(DEFAULT_TOMBSTONE_MIN_DAYS));
  });

  it('states the accounting floor without pretending the CTN is a retention table', () => {
    const row = proposedRowFor('postgres.financial');
    expect(row?.kind).toBe('minimum_floor');
    expect(row?.declared_basis).toContain('NÃO constituem tabela universal');
  });
});

describe('every class carries a declared basis and what still blocks it', () => {
  it('has exactly one proposal row per inventory class', () => {
    expect(PROPOSED_POLICY_ROWS).toHaveLength(DATA_CLASSES.length);
    for (const c of DATA_CLASSES) expect(proposedRowFor(c.id), c.id).toBeDefined();
  });

  it('names a basis for every class that proposes a period', () => {
    for (const row of PROPOSED_POLICY_ROWS) {
      if (row.kind === 'not_applicable') continue;
      expect(row.declared_basis.length, row.data_class).toBeGreaterThan(20);
      expect(row.policy.length, row.data_class).toBeGreaterThan(20);
    }
  });

  it('lists an open homologation item for every class except the two settled ones', () => {
    for (const row of PROPOSED_POLICY_ROWS) {
      // `queue.redis` has no retention question at all; `privacy.tombstone` is
      // the technical decision that #536 settled and enforces at boot.
      if (row.data_class === 'queue.redis') continue;
      expect(row.pending_homologation.length, row.data_class).toBeGreaterThan(0);
    }
  });
});

describe('the three copies of the proposal cannot drift', () => {
  it('the contract example IS the module value, byte for byte', () => {
    // The contract may only import zod (its purity contract), so it cannot
    // import the module. This assertion is the seam that keeps them equal.
    expect(ENV_CONTRACT.RETENTION_POLICY.example).toBe(PROPOSED_RETENTION_POLICY_JSON);
  });

  it('the contract example round-trips through the parser it will meet at boot', () => {
    const p = parseRetentionPolicy(ENV_CONTRACT.RETENTION_POLICY.example);
    expect(p.version).toBe(PROPOSED_POLICY_VERSION);
    expect(p.homologated).toBe(false);
  });

  it('the matrix document carries the same version and the same periods', () => {
    const doc = readFileSync(MATRIX, 'utf8');
    expect(doc).toContain(PROPOSED_POLICY_VERSION);
    for (const row of PROPOSED_POLICY_ROWS) {
      expect(doc, row.data_class).toContain(row.data_class);
    }
  });

  it('the matrix document no longer claims to be an unapproved DRAFT', () => {
    const doc = readFileSync(MATRIX, 'utf8');
    expect(doc).not.toContain('DRAFT — NOT APPROVED');
    expect(doc.toLowerCase()).toContain('pendente de homologação');
  });

  it('the matrix document keeps the legal framing that #520 demands', () => {
    const doc = readFileSync(MATRIX, 'utf8');
    // The framing is the point of the whole document: no universal deadlines,
    // and the CTN windows are not a retention table.
    for (const marker of ['arts. 6', '15–18', 'ANPD', '173', '174']) {
      expect(doc, marker).toContain(marker);
    }
    expect(doc).toMatch(/n[ãa]o (constituem|é|sao|são).{0,40}tabela universal/i);
  });
});

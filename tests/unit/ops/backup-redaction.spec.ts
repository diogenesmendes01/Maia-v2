import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  detectSecrets,
  assertNoSecrets,
  artifactRef,
  opaqueLocator,
} from '../../../src/ops/backup/redaction.js';

/**
 * Issue #520 acceptance: "logs não contêm DATABASE_URL, chaves, URLs assinadas,
 * telefones ou payloads". The baseline echoed raw pg_dump stderr, which on a
 * connection error contains the password.
 */

describe('redactSecrets', () => {
  it('scrubs a DATABASE_URL with an inline password', () => {
    const stderr =
      'pg_dump: error: connection to server failed: postgres://maia:s3cr3tpw@db.internal:5432/maia';
    const out = redactSecrets(stderr);
    expect(out).not.toContain('s3cr3tpw');
    expect(out).not.toContain('db.internal');
    expect(out).toContain('[redacted]');
  });

  it('scrubs a bare connection string with no credentials', () => {
    expect(redactSecrets('redis://cache.internal:6379/0')).toBe('[redacted]');
  });

  it('scrubs a pre-signed S3 URL', () => {
    const url =
      'https://bucket.s3.amazonaws.com/maia/x.dump?X-Amz-Signature=deadbeef&X-Amz-Expires=900';
    expect(redactSecrets(url)).toBe('[redacted]');
  });

  it('scrubs provider API keys and AWS access key ids', () => {
    expect(redactSecrets('key=sk-ant-api03-AAAABBBBCCCC')).not.toContain('AAAABBBBCCCC');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]');
  });

  it('scrubs E.164 phone numbers (PII)', () => {
    expect(redactSecrets('owner +5511999998888 asked')).toBe('owner [redacted] asked');
  });

  it('leaves innocuous operator text untouched', () => {
    const msg = 'pg_dump exit=1 could not open output file (disk full)';
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe('detectSecrets / assertNoSecrets', () => {
  it('names the classes it found without echoing the value', () => {
    const hits = detectSecrets('postgres://u:p@h/db and +5511999998888');
    expect(hits).toContain('uri_credentials');
    expect(hits).toContain('e164_phone');
  });

  it('throws fail-closed when a persisted payload carries a secret', () => {
    expect(() =>
      assertNoSecrets({ destination: 'postgres://u:p@h/db' }, 'backup manifest'),
    ).toThrowError(/must never be persisted/);
  });

  it('does not echo the secret in the error message', () => {
    try {
      assertNoSecrets({ url: 'postgres://maia:hunter2@h/db' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('accepts a clean manifest-shaped payload', () => {
    expect(() =>
      assertNoSecrets({ artifact_ref: 'maia-2026-07-28T03-00-00.dump', size_bytes: 42 }),
    ).not.toThrow();
  });
});

describe('artifactRef', () => {
  it('reduces an absolute POSIX path to its basename', () => {
    expect(artifactRef('/opt/maia/backups/maia-2026-07-28.dump')).toBe('maia-2026-07-28.dump');
  });

  it('reduces a Windows path to its basename', () => {
    expect(artifactRef('C:\\maia\\backups\\maia-2026-07-28.dump')).toBe('maia-2026-07-28.dump');
  });

  it('rejects a path with no basename', () => {
    expect(() => artifactRef('/opt/maia/backups/')).toThrowError(/no basename/);
  });
});

describe('opaqueLocator', () => {
  it('is stable for the same bucket/key', () => {
    expect(opaqueLocator('maia-backups', 'maia/x.dump')).toBe(
      opaqueLocator('maia-backups', 'maia/x.dump'),
    );
  });

  it('does not disclose the bucket name', () => {
    const loc = opaqueLocator('very-secret-bucket', 'maia/x.dump');
    expect(loc).not.toContain('very-secret-bucket');
    expect(loc).toMatch(/^[0-9a-f]{32}$/);
  });
});

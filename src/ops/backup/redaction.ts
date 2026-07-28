/**
 * Issue #520 — secret/PII minimisation for backup evidence.
 *
 * The baseline wrote the full local path and the S3 URL into `audit_logs`
 * metadata (`src/workers/backup.ts` `backup_completed` / `backup_s3_upload_failed`)
 * and echoed raw `pg_dump` stderr — which, on a connection failure, contains
 * `DATABASE_URL` **with the password**. Acceptance criterion: "logs não contêm
 * `DATABASE_URL`, chaves, URLs assinadas, telefones ou payloads".
 *
 * Everything in this module is PURE and defensive: it assumes callers WILL
 * eventually hand it a string containing a secret, and it is the last line
 * before that string reaches a log, a manifest or an audit row.
 */
import { createHash } from 'node:crypto';
import { TypedError } from '@/lib/utils.js';

const REDACTED = '[redacted]';

/**
 * Patterns that must never survive into a log/manifest/audit row.
 *
 * Deliberately conservative — a false positive costs an operator one grep,
 * a false negative leaks a credential. Order matters: the connection-string
 * rule runs before the generic URL rule so `postgres://u:p@h/db` is caught by
 * the more specific form.
 */
const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  // Any URI with inline credentials: scheme://user:pass@host/path?query.
  // The trailing `\S*` is deliberate — redacting only up to the `@` would
  // still publish the host, port and database name (topology is an asset an
  // attacker wants). The whole URI goes.
  { name: 'uri_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@\S*/gi },
  // Bare connection strings (no credentials but still topology + db name).
  { name: 'db_uri', re: /\b(?:postgres|postgresql|redis|rediss|amqp|mongodb):\/\/\S+/gi },
  // Pre-signed URLs — the query string IS the credential.
  { name: 'presigned_url', re: /\bhttps?:\/\/\S*[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|AWSAccessKeyId)=\S*/gi },
  // Provider API keys / access-key ids.
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai_key', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}/g },
  { name: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // E.164 phone numbers (PII — the platform is WhatsApp-native).
  { name: 'e164_phone', re: /\+\d{10,15}\b/g },
];

/**
 * Scrub every known secret/PII shape from a free-form string (typically a
 * subprocess stderr or an exception message) before it is logged or audited.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACTED);
  }
  return out;
}

/** Names of the secret classes detected in `input` (empty = clean). */
export function detectSecrets(input: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (new RegExp(re.source, re.flags).test(input)) hits.push(name);
  }
  return hits;
}

/**
 * Fail-closed guard for anything about to be PERSISTED (manifest, audit
 * metadata). Unlike `redactSecrets` this does not silently fix the payload —
 * persisting a silently-mangled manifest would hide the upstream bug. It
 * throws so the caller is forced to stop putting the secret there.
 *
 * The error message deliberately reports only the CLASS names, never the
 * matched text.
 */
export function assertNoSecrets(value: unknown, what = 'payload'): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const hits = detectSecrets(serialized);
  if (hits.length > 0) {
    throw new TypedError(
      'backup_secret_in_evidence',
      `${what} contains material that must never be persisted (${hits.join(', ')})`,
      { classes: hits },
    );
  }
}

/**
 * Non-sensitive artifact identity. The manifest and every audit row reference
 * a backup by its BASENAME (which is a timestamp, not a secret) — never by
 * absolute path (leaks host layout) and never by URL (may be pre-signed).
 *
 * Accepts both POSIX and Windows separators so the CLI behaves identically on
 * an operator laptop and on the Linux host.
 */
export function artifactRef(pathLike: string): string {
  const normalized = pathLike.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base.length === 0) {
    throw new TypedError('backup_invalid_artifact_ref', 'artifact path has no basename', {});
  }
  return base;
}

/**
 * Opaque, stable locator for an off-site object. `bucket/key` identifies the
 * blob for a human with bucket access, but publishing it in an audit row that
 * a support engineer can read tells them where the crown jewels live. We
 * persist a truncated SHA-256 instead: two runs against the same object
 * produce the same locator (so reconciliation works) and the locator alone
 * does not disclose the bucket name.
 *
 * The inputs are LENGTH-PREFIXED so no pair of (bucket, key) values can be
 * re-split into a different pair that hashes the same — an unambiguous
 * encoding that stays pure ASCII and reviewable in a diff.
 *
 * The plain bucket/key still lives in the operator's own storage console and
 * in the signed manifest body — this is minimisation, not obfuscation.
 */
export function opaqueLocator(bucket: string, key: string): string {
  const canonical = `${bucket.length}:${bucket}:${key.length}:${key}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

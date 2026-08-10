/**
 * Issue #536 §1, round-2 review of PR #541 — the manifest verification keyring.
 *
 * THE DEFECT THIS CLOSES. A signed manifest records `signature_key_version`
 * (`manifest.ts`), and `backup_manifests` persists it, but the drill used to
 * verify every envelope with the CURRENT master secret. So the moment an
 * operator did the thing the 90-day rotation policy tells them to do — bump
 * `RUNTIME_TRACE_HMAC_KEY_VERSION`, install a new master, retain the old one in
 * `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS` — every recovery point signed with
 * the previous key started failing as `manifest_unverifiable`. Not expired, not
 * corrupt: still on disk, still inside its retention window, still perfectly
 * restorable, and now refused by the only job that certifies restorability.
 * Rotating the key operationally deleted the backups.
 *
 * The repository already had the answer for audit rows, and this module does
 * not re-implement it: `src/control-plane/runtime-trace/lib/hmac.ts` parses the
 * versioned keyring and resolves current-or-previous by version, with the same
 * fail-closed rule. Backups sign with the same master material
 * (`src/ops/backup/adapters.ts` — `manifestSecret()`), so they get the same
 * keyring. A second parser for the same env var would drift, and a drifted
 * keyring is an unrestorable backup.
 *
 * FAIL-CLOSED, twice over:
 *  - an unknown version resolves to `null`, which `verifyManifest` reports as
 *    `key_version_unknown` — it never falls back to the current key, because a
 *    fallback would both hide the real diagnosis and accept an envelope that
 *    renamed its own key version;
 *  - the resolver THROWS for a version it does not hold; that throw is caught
 *    here and turned into `null` rather than escaping into the drill's generic
 *    `unexpected` bucket, where it would read as a crash instead of a verdict.
 */
import { hmacMasterSecretForVersion } from '@/control-plane/runtime-trace/lib/hmac.js';
import type { ManifestKeyring } from './manifest.js';

/**
 * The process-wide keyring for backup manifests.
 *
 * Not memoised: `hmacMasterSecretForVersion` already caches its parse of
 * `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS`, and a drill resolves exactly one
 * version per run.
 */
export function backupManifestKeyring(): ManifestKeyring {
  return {
    secretForVersion: (version: number): string | null => {
      try {
        // utf8 round-trips the material the signer used: the current secret is
        // read from config as a string, and the previous ones are parsed from
        // the env var as utf8 buffers.
        return hmacMasterSecretForVersion(version).toString('utf8');
      } catch {
        // Never echoed: the throw's message names the env var and the version,
        // which is operator guidance, not a verifier's verdict. The reason code
        // `verifyManifest` produces is what reaches the log.
        return null;
      }
    },
  };
}

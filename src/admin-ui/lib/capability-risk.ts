/**
 * P8.5 — Capability proposal risk + lock derivation (admin-ui re-export).
 *
 * The implementation lives in src/db/capability-risk.ts so it can be consumed
 * by both `proposalsUnifiedRepo` (server-side) and admin-ui code without
 * crossing the admin-ui ↔ main TS-build boundary in the wrong direction.
 *
 * See ../../db/capability-risk.ts for design rationale and the Codex review
 * note (#101 — hardcoded risk='medium' downgraded destructive capabilities).
 */
export { deriveCapabilityRisk, deriveCapabilityLocks } from '../../db/capability-risk.js';

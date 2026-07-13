/**
 * Spec perfil-inbox v4 §1.2 — classificador de risco do perfil operacional
 * (admin-ui re-export).
 *
 * The implementation lives in src/db/profile-risk.ts so it can be consumed
 * by both `proposalsUnifiedRepo` (server-side) and admin-ui code without
 * crossing the admin-ui ↔ main TS-build boundary in the wrong direction.
 *
 * See ../../db/profile-risk.ts for the exhaustive walker, the per-field
 * classification table, and the fail-UP rules (unknown field / incompatible
 * schema_version / unreadable predecessor ⇒ high).
 */
export {
  classifyProfileChangeRisk,
  PROFILE_FIELD_CLASSIFICATIONS,
} from '../../db/profile-risk.js';
export type {
  ProfileChangeEntry,
  ProfileFieldClassification,
  ProfileRiskLevel,
} from '../../db/profile-risk.js';

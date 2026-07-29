// Barrel for the repository layer. The implementation was split from a single
// 9.4k-line repositories.ts into domain-grouped modules under
// src/db/repositories/ (pure mechanical refactor — no behavior change).
// The public import surface of '@/db/repositories.js' is unchanged: every
// name exported before the split is re-exported here under the same name.

export * from './repositories/core.js';
export * from './repositories/pessoa-repos.js';
export * from './repositories/conversation-repos.js';
export * from './repositories/finance-repos.js';
export * from './repositories/cognitive-repos.js';
export * from './repositories/idempotency-repos.js';
export * from './repositories/governance-repos.js';
export * from './repositories/tenant-repos.js';
export * from './repositories/capability-repos.js';
export * from './repositories/procedure-repos.js';
export * from './repositories/profile-repos.js';
export * from './repositories/channel-repos.js';
export * from './repositories/inbound-unrouted-repos.js';
export * from './repositories/admin-repos.js';
export * from './repositories/playground-repos.js';
export * from './repositories/objective-repos.js';
export * from './repositories/mcp-repos.js';
export * from './repositories/approval-repos.js';
export * from './repositories/turn-repos.js';

// Calendar v2 — re-export of holidaysRepo + holidayEntidadesRepo from dedicated modules.
export { holidaysRepo } from './repositories/holidays-repo.js';
export { holidayEntidadesRepo, CrossTenantIntegrityError } from './repositories/holiday-entidades-repo.js';

// P9a — re-export skillsRepo from control-plane/skill-registry. Convention:
// `repositories.ts` é o ponto único de import para callers; `control-plane/`
// hospeda a implementação propriamente dita (Source of Truth + Admin UI).
// Ver `src/control-plane/skill-registry/skills-repo.ts`.
export { skillsRepo } from '@/control-plane/skill-registry/index.js';
export type { SkillsRepo, ProposeInput as SkillProposeInput } from '@/control-plane/skill-registry/index.js';

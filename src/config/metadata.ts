/**
 * Configuration contract — types and shared vocabulary (issue #515).
 *
 * PURITY CONTRACT: this module (and every module it imports) must have ZERO
 * import-time side effects — no `dotenv/config`, no `process.env` read, no
 * filesystem, no network, no global instantiation. It is imported by the CLI
 * (`maia config`), by `maia doctor` (#517), by the migration runner (#516) and
 * by the Admin UI, all of which must be able to reason about configuration
 * WITHOUT booting the world.
 *
 * Only types, literal constants and pure functions belong here.
 */
import type { z } from 'zod';

/**
 * Deployment profile. Explicit and independent from `NODE_ENV` (which keeps
 * controlling Node platform optimisations only). `MAIA_ENV` selects the
 * profile; when absent it is derived from `NODE_ENV` (see `profiles.ts`), and
 * a contradiction between the two is an error.
 */
export type MaiaProfile = 'development' | 'staging' | 'production';

export const MAIA_PROFILES: readonly MaiaProfile[] = [
  'development',
  'staging',
  'production',
] as const;

/**
 * Deployable surfaces that consume configuration. Each variable declares the
 * services allowed to read it, which is what makes "minimum configuration per
 * service" (and the secret blast radius) computable.
 */
export type MaiaService =
  | 'runtime'
  | 'admin-ui'
  | 'migrator'
  | 'backup'
  | 'maintenance';

export const MAIA_SERVICES: readonly MaiaService[] = [
  'runtime',
  'admin-ui',
  'migrator',
  'backup',
  'maintenance',
] as const;

/** Documentation grouping — drives the section order of generated artifacts. */
export type ConfigGroup =
  | 'core'
  | 'database'
  | 'redis'
  | 'llm'
  | 'speech'
  | 'embeddings'
  | 'whatsapp'
  | 'owner'
  | 'governance'
  | 'routing'
  | 'alerts'
  | 'backup'
  | 'cost'
  | 'feature-flags'
  | 'probe'
  | 'runtime-trace'
  | 'outbox'
  | 'procedures'
  | 'performance'
  | 'setup'
  | 'admin-ui';

/** Section order + human title for every group, used by the generators. */
export const GROUP_ORDER: readonly { group: ConfigGroup; title: string }[] = [
  { group: 'core', title: 'Core / processo' },
  { group: 'database', title: 'Banco de dados' },
  { group: 'redis', title: 'Redis' },
  { group: 'llm', title: 'LLM provider' },
  { group: 'speech', title: 'Transcrição de áudio (Whisper)' },
  { group: 'embeddings', title: 'Embeddings' },
  { group: 'whatsapp', title: 'WhatsApp / Baileys' },
  { group: 'owner', title: 'Owner' },
  { group: 'governance', title: 'Governança (limites financeiros e TTLs)' },
  { group: 'routing', title: 'Roteamento multi-linha' },
  { group: 'alerts', title: 'Observabilidade / alertas' },
  { group: 'backup', title: 'Backup / restore' },
  { group: 'cost', title: 'Custo' },
  { group: 'feature-flags', title: 'Feature flags' },
  { group: 'probe', title: 'Sonda sintética' },
  { group: 'runtime-trace', title: 'Runtime trace' },
  { group: 'outbox', title: 'Outbox / sweeper' },
  { group: 'procedures', title: 'Procedures / reaper' },
  { group: 'performance', title: 'Performance / caches' },
  { group: 'setup', title: 'Bootstrap / setup' },
  { group: 'admin-ui', title: 'Admin UI (container Next.js separado)' },
];

/**
 * One canonical variable definition. `schema` is the single Zod source of
 * truth: the runtime object schema, the JSON Schema, the generated docs and
 * the validator all derive from it.
 */
export interface EnvVarSpec {
  /** Env var name, exactly as it appears in `.env`. */
  readonly name: string;
  /** One-line operator-facing description (pt-BR, matching the repo). */
  readonly description: string;
  readonly group: ConfigGroup;
  /**
   * True when the value is a credential. Secret values are NEVER printed by
   * the validator, the generators or the manifests.
   */
  readonly secret: boolean;
  /** Services allowed to read this variable. */
  readonly services: readonly MaiaService[];
  /** Profiles in which the variable may be ACTIVE. Defaults to all three. */
  readonly profiles?: readonly MaiaProfile[];
  /**
   * What counts as "active" for the `profiles` allow-list. `set` (default) —
   * any non-empty value; `truthy` — only an enabling value. A kill-switch
   * explicitly pinned to `false` in production is legitimate configuration, so
   * gated flags use `truthy`.
   */
  readonly activeWhen?: 'set' | 'truthy';
  /** Profiles in which the variable MUST be present and non-empty. */
  readonly requiredIn?: readonly MaiaProfile[];
  /** Canonical Zod schema (includes coercion, defaults and transforms). */
  readonly schema: z.ZodTypeAny;
  /**
   * Example value for `.env.example` / fixtures. NEVER a real credential —
   * secrets carry an explicit placeholder marker instead.
   */
  readonly example?: string;
  /**
   * Synthetic but structurally valid value used by the strict per-profile
   * fixtures. Required for secrets (whose `example` is a placeholder).
   */
  readonly fixture?: string;
  /** Per-profile override of `fixture` (e.g. https URLs outside development). */
  readonly fixtureByProfile?: Partial<Record<MaiaProfile, string>>;
  /** Human-readable conditional requirement, e.g. "LLM_PROVIDER=anthropic". */
  readonly requiredWhen?: string;
  /** Release/date the variable was deprecated in. Presence ⇒ warning. */
  readonly deprecatedSince?: string;
  /** Variable that replaces a deprecated one. */
  readonly replacement?: string;
  /** Whether changing the value requires a process restart. */
  readonly restartRequired: boolean;
  /** Commented out in `.env.example` (optional knobs stay out of the way). */
  readonly commentedInExample?: boolean;
}

/**
 * A variable that WAS real and is now gone. Tombstones exist so a stale
 * deployment fails loudly instead of silently carrying a no-op knob that
 * makes the operator believe a code path is still gated.
 */
export interface Tombstone {
  readonly name: string;
  /** PR/issue that removed it, for the remediation message. */
  readonly removedIn: string;
  /** Why it is gone / what happens now. */
  readonly reason: string;
  /** Replacement variable, when the behaviour moved rather than vanished. */
  readonly replacement?: string;
  /**
   * `any-value`: any non-empty value is an error (the knob is fully gone).
   * `truthy`: only an enabling value errors (kept for knobs whose historical
   * `=false` line is harmless and widespread).
   */
  readonly failsOn: 'any-value' | 'truthy';
}

/**
 * Namespaces owned by Maia. A key matching one of these prefixes that is
 * neither in the contract nor in the tombstones is an UNKNOWN Maia variable
 * (warning in development, error in staging/production). Keys outside these
 * namespaces belong to the OS / hosting platform and are never rejected.
 */
export const MAIA_KEY_PREFIXES: readonly string[] = [
  'MAIA_',
  'FEATURE_',
  'BACKUP_',
  'OUTBOX_',
  'OUTBOUND_',
  'ALERT_',
  'CLAUDE_',
  'OPENROUTER_',
  'EMBEDDING_',
  'WHISPER_',
  'BAILEYS_',
  'WHATSAPP_',
  'OWNER_',
  'VALOR_',
  'DUAL_',
  'AUDIT_',
  'IDEMPOTENCY_',
  'PENDING_',
  'RATE_LIMIT_',
  'DECISION_ENGINE_',
  'DAILY_LLM_',
  'DLQ_',
  'POLICY_RESOLVER_',
  'RUNTIME_TRACE_',
  'SYNC_LATENCY_',
  'MESSAGE_DEBOUNCE_',
  'PROCEDURE_',
  'OCCURRENCE_',
  'SETUP_',
  'ADMIN_UI_',
  'OIDC_',
  'REAPER_',
  'CONTRADICTION_',
  'ANTHROPIC_',
  'VOYAGE_',
  'COHERE_',
] as const;
// Deliberately NOT listed: POSTGRES_, REDIS_, SMTP_, NEXTAUTH_, OPENAI_. Those
// namespaces are routinely populated by hosting platforms and managed add-ons
// (a Coolify/Heroku-style POSTGRES_HOST, a REDIS_TLS_URL). Rejecting them would
// turn a legitimate platform injection into a boot failure. The variables Maia
// actually owns inside those namespaces are still covered — they are in the
// contract by name.

/** True when `key` sits in a Maia-owned namespace. */
export function isMaiaNamespacedKey(key: string): boolean {
  return MAIA_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** Severity of a validation finding. */
export type ProblemSeverity = 'error' | 'warning';

/**
 * A single validation finding. Carries the variable, the rule id and an
 * actionable remediation — and NEVER the value of a secret.
 */
export interface ConfigProblem {
  readonly severity: ProblemSeverity;
  /** Variable the finding is about; `null` for whole-config findings. */
  readonly variable: string | null;
  /** Stable rule identifier (greppable, safe for dashboards). */
  readonly rule: string;
  readonly message: string;
  readonly remediation: string;
}

/**
 * Values that look like a placeholder rather than a real credential. Mirrors
 * `src/admin-ui/lib/auth-gating.ts` `KNOWN_PLACEHOLDER_PATTERNS` and extends it
 * with the markers used by the generated `.env.example`.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^changeme-/i,
  /change-?me/i,
  /change_me/i,
  /__PLACEHOLDER/i,
  /__SET_ME__/i,
  // Unanchored on purpose: the `.env.example` DSN embeds the placeholder
  // password mid-string (`postgres://maia:trocar_senha_forte@…`).
  /trocar_/i,
  /\.\.\.$/,
  /^your[-_]/i,
  /^xxx+$/i,
];

/** True when the value is a documented placeholder, not a usable credential. */
export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((rx) => rx.test(value));
}

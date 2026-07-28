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
 * EXECUTABLE conditional requirement.
 *
 * `requiredWhen` used to be a prose string. Prose does not run: PR #522 review
 * round 1 found that `FEATURE_OUTBOUND_VOICE=true` without `OPENAI_API_KEY`
 * validated clean even though the contract said the key was required, and the
 * same hole existed for the trace-debug AES key and the dev-auth token. The
 * condition is now data the validator EVALUATES, and the human sentence in the
 * docs is DERIVED from it (`describeRequiredWhen`), so the two cannot drift.
 */
export type RequiredWhen =
  /** The variable's effective value equals `equals`. */
  | { readonly var: string; readonly equals: string }
  /** The variable is a comma-list (e.g. ALERT_CHANNELS) containing `includes`. */
  | { readonly var: string; readonly includes: string }
  /** The variable is an enabled boolean flag (`true` / `1`). */
  | { readonly var: string; readonly truthy: true }
  /** The variable is set to a non-empty value. */
  | { readonly var: string; readonly present: true }
  | { readonly anyOf: readonly RequiredWhen[] }
  | { readonly allOf: readonly RequiredWhen[] };

/**
 * What a condition is evaluated against: the schema-parsed view when available
 * (coerced numbers, booleans, `ALERT_CHANNELS` already split) and the raw
 * environment as fallback, so a condition still evaluates when its subject
 * failed schema validation or is outside the parsed subset.
 */
export interface ConditionView {
  readonly values: Record<string, unknown>;
  readonly raw: Record<string, string | undefined>;
}

function effectiveValue(name: string, view: ConditionView): unknown {
  const parsed = view.values[name];
  if (parsed !== undefined) return parsed;
  const raw = view.raw[name];
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim());
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Evaluate a conditional requirement. Pure; never throws. */
export function evaluateRequiredWhen(cond: RequiredWhen, view: ConditionView): boolean {
  if ('anyOf' in cond) return cond.anyOf.some((c) => evaluateRequiredWhen(c, view));
  if ('allOf' in cond) return cond.allOf.every((c) => evaluateRequiredWhen(c, view));

  const value = effectiveValue(cond.var, view);
  if ('equals' in cond) return value !== undefined && String(value) === cond.equals;
  if ('includes' in cond) return asList(value).includes(cond.includes);
  if ('truthy' in cond) return value === true || value === 'true' || value === '1';
  // `present`
  return value !== undefined && String(value).trim() !== '';
}

/** Human sentence for a condition — the ONLY source of the documented prose. */
export function describeRequiredWhen(cond: RequiredWhen): string {
  if ('anyOf' in cond) return cond.anyOf.map(describeRequiredWhen).join(' ou ');
  if ('allOf' in cond) return cond.allOf.map(describeRequiredWhen).join(' e ');
  if ('equals' in cond) return `${cond.var}=${cond.equals}`;
  if ('includes' in cond) return `${cond.var} contém ${cond.includes}`;
  if ('truthy' in cond) return `${cond.var}=true`;
  return `${cond.var} está definida`;
}

/** Every variable a condition depends on (for docs and template closure). */
export function requiredWhenDependencies(cond: RequiredWhen): string[] {
  if ('anyOf' in cond) return cond.anyOf.flatMap(requiredWhenDependencies);
  if ('allOf' in cond) return cond.allOf.flatMap(requiredWhenDependencies);
  return [cond.var];
}

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
  /**
   * Conditional requirement, EVALUATED by the validator (rule
   * `contract/required-when`) and rendered to prose for the docs. Never a
   * free-form string — see `RequiredWhen`.
   */
  readonly requiredWhen?: RequiredWhen;
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
 * Values a HUMAN is expected to replace. Mirrors
 * `src/admin-ui/lib/auth-gating.ts` `KNOWN_PLACEHOLDER_PATTERNS` and extends it
 * with the markers used by the generated `.env.example` and by
 * `maia config init`.
 */
const OPERATOR_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
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

/**
 * Values produced by `buildFixture()` — the SYNTHETIC configuration CI uses to
 * prove the contract is satisfiable.
 *
 * They are deliberately predictable (`sk-ant-fixture-not-a-real-key`,
 * `fixture0000pass`, an all-zero base64 key block), which is fine for a CI
 * witness and catastrophic in a real deployment: they authenticate against
 * nothing, so a process configured with them is inoperable while looking
 * configured. PR #522 review round 1 [P1] found `maia config init` promoting
 * exactly these into a production `.env`.
 *
 * They are therefore treated as placeholders too. The dedicated rule
 * `secret/synthetic-fixture` reports them in staging/production, and only the
 * explicit `--allow-fixtures` opt-in (used solely to validate the generated
 * fixtures themselves) silences it.
 */
const SYNTHETIC_FIXTURE_PATTERNS: readonly RegExp[] = [
  // `fixture…` at the start, or after any non-alphanumeric separator, so it
  // matches `sk-ant-fixture-…`, `1=fixture-…` and `postgres://u:fixture0000pass@…`.
  /(^|[^a-z0-9])fixture/i,
  // All-zero base64 blocks used for the key-shaped fixture fields.
  /A{20,}=/,
];

/** True when the value is a marker a human must replace before deploying. */
export function isOperatorPlaceholder(value: string): boolean {
  return OPERATOR_PLACEHOLDER_PATTERNS.some((rx) => rx.test(value));
}

/** True when the value came from the synthetic CI fixture set. */
export function isSyntheticFixtureValue(value: string): boolean {
  return SYNTHETIC_FIXTURE_PATTERNS.some((rx) => rx.test(value));
}

/**
 * True when the value is NOT a real, usable value — either an operator
 * placeholder or a synthetic CI fixture. Used by the contract tests and by the
 * `config init` template renderer.
 */
export function isPlaceholderValue(value: string): boolean {
  return isOperatorPlaceholder(value) || isSyntheticFixtureValue(value);
}

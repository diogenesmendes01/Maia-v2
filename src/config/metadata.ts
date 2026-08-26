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
  | 'onboarding'
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
  | 'lifecycle'
  | 'setup'
  | 'tool-requests'
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
  // Decisão 13 (#519). As alavancas da saga de onboarding e do worker
  // `onboarding_expirer` moravam em `governance`, entre TTLs de aprovação
  // dupla e limites financeiros — grupos são o índice do operador, e ali a
  // resposta a "onde configuro o onboarding" ficava numa seção de outro
  // domínio. Logo depois de `governance` de propósito: é de onde as chaves
  // saíram, então a seção nova nasce onde o leitor já procurava.
  { group: 'onboarding', title: 'Onboarding (saga e expirer)' },
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
  { group: 'lifecycle', title: 'Lifecycle do processo (readiness e shutdown)' },
  { group: 'setup', title: 'Bootstrap / setup' },
  // #638 (fatia C da épica #471). O destino e a credencial das issues geradas
  // pela triagem de pedidos de ferramenta. Grupo próprio, e não `governance`,
  // porque a pergunta do operador é "para onde vão as issues do backlog do
  // agente?" — e a resposta não pertence à seção de limites financeiros.
  { group: 'tool-requests', title: 'Pedidos de ferramenta (issues da triagem)' },
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
  // Issue #520: RETENTION_DRY_RUN governa exclusão IRREVERSÍVEL. Sob este
  // prefixo, um typo (`RETENTION_DRYRUN=false`) vira variável desconhecida e
  // falha o boot, em vez de ser ignorado silenciosamente enquanto o operador
  // acredita ter desligado o dry-run.
  'RETENTION_',
  'OUTBOX_',
  'OUTBOUND_',
  'ALERT_',
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
  'OPENROUTER_',
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
  'VOYAGE_',
  'COHERE_',
  // Issue #512 — lifecycle do processo. Namespaces exclusivamente da Maia
  // (nenhuma plataforma de hospedagem injeta SHUTDOWN_*/READINESS_*), então um
  // typo como SHUTDOWN_GRACE_MSS é detectado em vez de virar knob silencioso.
  // `REDIS_` continua FORA de propósito: provedores gerenciados (Upstash,
  // Heroku) injetam REDIS_* próprios, e rejeitá-los quebraria o boot.
  'SHUTDOWN_',
  'READINESS_',
] as const;
// Deliberately NOT listed, because these namespaces belong to somebody else and
// an unknown key in them is NOT a Maia misconfiguration:
//
//   POSTGRES_, REDIS_, SMTP_, NEXTAUTH_, OPENAI_
//     routinely populated by hosting platforms and managed add-ons (a
//     Coolify/Heroku-style POSTGRES_HOST, a REDIS_TLS_URL).
//
//   CLAUDE_, ANTHROPIC_
//     owned by Anthropic tooling, not by Maia. A developer machine running
//     Claude Code carries ~18 of them (CLAUDE_CODE_ENTRYPOINT, CLAUDE_PID,
//     ANTHROPIC_BASE_URL, …). Since the boot now fails closed on an unknown
//     Maia key in EVERY profile, listing these prefixes would abort `npm run
//     dev` and the whole test suite on any machine with the CLI installed.
//
// The variables Maia actually owns inside those namespaces are still covered —
// they are in the contract BY NAME.

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
  /**
   * EVERY variable this finding is about, when the rule that produced it knows
   * more than `variable` can say (issue #602).
   *
   * `variable` holds ONE name — a Zod issue path, or the single key a rule
   * files itself under — and that is not enough for the cross-field rules:
   * `backup/encryption-key` fires for the PAIR
   * `BACKUP_ENCRYPTION_KEYRING` + `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` and files
   * itself under the first, and the boot-scope rules that preserve the
   * historical `<root>` Zod path carry `variable: null` while naming a real
   * variable (`llm/provider-key` → `ANTHROPIC_API_KEY`). A consumer listing
   * "which variables does this problem involve?" by `variable` alone omits the
   * second key, or every key.
   *
   * Populated from `CrossFieldFinding.covers` by `validateConfig()`. ABSENT —
   * not empty — when the finding is about exactly the variable in `variable`,
   * so the serialized shape of every other problem is unchanged. Read it as
   * `p.covers ?? (p.variable ? [p.variable] : [])`.
   */
  readonly covers?: readonly string[];
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

/** True when the value is a marker a human must replace before deploying. */
export function isOperatorPlaceholder(value: string): boolean {
  return OPERATOR_PLACEHOLDER_PATTERNS.some((rx) => rx.test(value));
}

/**
 * Detection of the SYNTHETIC CI fixture values lives in
 * `src/config/contract.ts` (`isSyntheticFixtureValue`), keyed BY VARIABLE.
 *
 * It used to live here as a regex over any value containing the word
 * `fixture`. That reserved a common English word across the whole value space
 * — and, since the boot now fails closed in every profile, a tenant named
 * `OWNER_NOME=Fixture Labs`, a bucket `maia-fixture-store` or a host
 * `https://fixture.example.com` would have aborted a production process with a
 * message claiming their value was a CI fixture. PR #522 review round 2 caught
 * it.
 *
 * The lesson, recorded in `docs/runbooks/config-contract.md`: a broad heuristic
 * and a fail-closed boot do not mix. Rejection has to be EXACT. Since the
 * fixtures come from this same contract, the exact value for each key is known.
 */

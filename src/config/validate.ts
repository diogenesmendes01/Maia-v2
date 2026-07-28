/**
 * Pure configuration validator (issue #515).
 *
 * Answers "is this `.env` valid for this profile?" WITHOUT connecting to
 * Postgres, Redis or any provider — liveness belongs to `maia doctor` (#517).
 *
 * Contract for consumers:
 *   - reports EVERY problem in one run (never stops at the first);
 *   - every problem carries variable + rule + remediation;
 *   - a secret VALUE never appears in any message (canary-tested);
 *   - no side effects: nothing is read from `process.env` unless the caller
 *     passes it in, nothing is written anywhere.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  CONTRACT_ENTRIES,
  CONTRACT_VERSION,
  TOMBSTONES,
  allowedProfiles,
  entriesForService,
  findSpec,
  isUnknownMaiaKey,
} from '@/config/contract.js';
import {
  type ConfigProblem,
  type EnvVarSpec,
  type MaiaProfile,
  type MaiaService,
  type Tombstone,
} from '@/config/metadata.js';
import { isStrictProfile, resolveProfile } from '@/config/profiles.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { scrubSecrets } from '@/config/redact.js';

export interface ValidateConfigInput {
  /** Environment snapshot to validate. Never defaults to `process.env`. */
  readonly env: Record<string, string | undefined>;
  /** Profile to validate against. Defaults to the one resolved from `env`. */
  readonly profile?: MaiaProfile;
  /** Restrict to one service's subset. `'all'` (default) validates everything. */
  readonly service?: MaiaService | 'all';
  /**
   * Structural mode: accept documented placeholders (`sk-ant-...`,
   * `__SET_ME__…`). Used to check `.env.example` itself.
   */
  readonly allowPlaceholders?: boolean;
  /** Contract override — tests only. */
  readonly entries?: readonly EnvVarSpec[];
  /** Tombstone override — tests only. */
  readonly tombstones?: readonly Tombstone[];
}

export interface ValidateConfigResult {
  readonly ok: boolean;
  readonly profile: MaiaProfile;
  readonly contractVersion: string;
  readonly errors: readonly ConfigProblem[];
  readonly warnings: readonly ConfigProblem[];
  /** Non-reversible hash of the NON-SECRET configuration, for boot logs. */
  readonly configHash: string;
  /** Schema-parsed values for the variables that did parse. */
  readonly values: Readonly<Record<string, unknown>>;
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

function isTruthyFlag(v: string | undefined): boolean {
  return v === 'true' || v === '1';
}

/** Per-variable parse: gives partial values AND per-variable errors. */
function parseEntry(
  spec: EnvVarSpec,
  raw: string | undefined,
): { value?: unknown; issues: z.ZodIssue[] } {
  const result = spec.schema.safeParse(raw);
  if (result.success) return { value: result.data, issues: [] };
  return { issues: result.error.issues };
}

/**
 * Validate an environment snapshot against the contract.
 *
 * Pure. Deterministic: the same input always yields the same problems in the
 * same order (contract order, then raw-key order).
 */
export function validateConfig(input: ValidateConfigInput): ValidateConfigResult {
  const { env } = input;
  const entries =
    input.entries ??
    (input.service && input.service !== 'all'
      ? entriesForService(input.service)
      : CONTRACT_ENTRIES);
  const tombstones = input.tombstones ?? TOMBSTONES;

  const resolved = resolveProfile(env);
  const profile = input.profile ?? resolved.profile;
  const strict = isStrictProfile(profile);

  const problems: ConfigProblem[] = [];
  // Profile-resolution findings only apply when the caller did not force a
  // profile (forcing one is how CI checks a fixture against every profile).
  if (input.profile === undefined || input.profile === resolved.profile) {
    problems.push(...resolved.problems);
  }

  const values: Record<string, unknown> = {};

  // ---- per-variable schema + profile rules ------------------------------
  for (const spec of entries) {
    const raw = env[spec.name];
    const present = nonEmpty(raw);

    const { value, issues } = parseEntry(spec, present ? raw : undefined);
    if (issues.length === 0) {
      values[spec.name] = value;
    }
    for (const issue of issues) {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: `schema/${issue.code}`,
        message: `${spec.name}: ${issue.message}`,
        remediation: spec.example
          ? `Formato esperado, ex.: ${spec.name}=${spec.example}`
          : `Corrija ${spec.name} conforme o contrato.`,
      });
    }

    if (spec.requiredIn?.includes(profile) && !present) {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: 'profile/required',
        message: `${spec.name} é obrigatória no profile ${profile}.`,
        remediation: spec.requiredWhen
          ? `Defina ${spec.name} (${spec.requiredWhen}).`
          : `Defina ${spec.name}.`,
      });
    }

    const active = spec.activeWhen === 'truthy' ? isTruthyFlag(raw) : present;
    if (active && !allowedProfiles(spec).includes(profile)) {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: 'profile/not-allowed',
        message: `${spec.name} não pode estar ativa no profile ${profile}.`,
        remediation: `Permitida apenas em: ${allowedProfiles(spec).join(', ')}.`,
      });
    }

    if (spec.deprecatedSince && present) {
      problems.push({
        severity: 'warning',
        variable: spec.name,
        rule: 'contract/deprecated',
        message: `${spec.name} está depreciada desde ${spec.deprecatedSince}.`,
        remediation: spec.replacement
          ? `Migre para ${spec.replacement} e remova ${spec.name}.`
          : `Remova ${spec.name} do ambiente.`,
      });
    }
  }

  // ---- cross-field rules -------------------------------------------------
  // When the caller narrowed to ONE service, a rule about a variable that
  // service is not even allowed to read must not fire: the migrator has no
  // business failing because the runtime's HMAC master secret is absent from
  // its (correctly minimal) environment. `variable: null` findings stay — they
  // are naturally inert, because their inputs are absent from `values`.
  const scopeNames =
    input.entries || !input.service || input.service === 'all'
      ? null
      : new Set(entries.map((s) => s.name));

  const crossField = evaluateCrossFieldRules({ values, raw: env, profile });
  for (const f of crossField) {
    if (input.allowPlaceholders && f.rule === 'secret/placeholder') continue;
    if (scopeNames && f.variable !== null && !scopeNames.has(f.variable)) continue;
    problems.push({
      severity: f.severity,
      variable: f.variable,
      rule: f.rule,
      message: f.message,
      remediation: f.remediation,
    });
  }

  const alreadyFlagged = new Set(
    problems.map((p) => p.variable).filter((v): v is string => v !== null),
  );

  // ---- tombstones --------------------------------------------------------
  for (const t of tombstones) {
    const raw = env[t.name];
    const set = t.failsOn === 'truthy' ? isTruthyFlag(raw) : nonEmpty(raw);
    if (!set || alreadyFlagged.has(t.name)) continue;
    problems.push({
      severity: strict ? 'error' : 'warning',
      variable: t.name,
      rule: 'contract/removed',
      message: `${t.name} foi REMOVIDA (${t.removedIn}) e não tem mais efeito. ${t.reason}`,
      remediation: t.replacement
        ? `Remova ${t.name} do ambiente; o gate real é ${t.replacement}.`
        : `Remova ${t.name} do ambiente.`,
    });
  }

  // ---- unknown Maia-namespaced keys --------------------------------------
  for (const key of Object.keys(env).sort()) {
    if (!nonEmpty(env[key]) || !isUnknownMaiaKey(key)) continue;
    problems.push({
      severity: strict ? 'error' : 'warning',
      variable: key,
      rule: 'contract/unknown',
      message: `${key} está em um namespace da Maia mas não existe no contrato (versão ${CONTRACT_VERSION}).`,
      remediation:
        `Se a variável é real, declare-a em src/config/contract.ts e regenere os artefatos ` +
        `(npm run config:generate). Se não, remova-a do ambiente.`,
    });
  }

  // ---- redaction gate ----------------------------------------------------
  // Nothing above interpolates a secret value, but a Zod issue message (or a
  // future rule) could. This is the last gate before anything is returned.
  const safe: ConfigProblem[] = problems.map((p) => ({
    ...p,
    message: scrubSecrets(p.message, env),
    remediation: scrubSecrets(p.remediation, env),
  }));

  const errors = safe.filter((p) => p.severity === 'error');
  const warnings = safe.filter((p) => p.severity === 'warning');

  return {
    ok: errors.length === 0,
    profile,
    contractVersion: CONTRACT_VERSION,
    errors,
    warnings,
    configHash: configHash(env),
    values,
  };
}

/**
 * Non-reversible hash of the NON-SECRET configuration. Two processes booting
 * with the same hash are running the same knobs; a secret rotation does not
 * change it (secrets are excluded by construction, not merely masked).
 */
export function configHash(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const spec = findSpec(key);
    if (!spec || spec.secret) continue;
    const value = env[key];
    if (!nonEmpty(value)) continue;
    parts.push(`${key}=${value}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** Human-readable report. Safe to print: secrets are never included. */
export function formatHuman(result: ValidateConfigResult): string {
  const lines: string[] = [];
  lines.push(
    `Maia config — profile ${result.profile} (contrato ${result.contractVersion}, hash ${result.configHash})`,
  );
  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('OK: nenhuma inconsistência encontrada.');
    return lines.join('\n');
  }
  if (result.errors.length > 0) {
    lines.push('', `ERROS (${result.errors.length}):`);
    for (const p of result.errors) {
      lines.push(`  [${p.rule}] ${p.variable ?? '<config>'}: ${p.message}`);
      lines.push(`      → ${p.remediation}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', `AVISOS (${result.warnings.length}):`);
    for (const p of result.warnings) {
      lines.push(`  [${p.rule}] ${p.variable ?? '<config>'}: ${p.message}`);
      lines.push(`      → ${p.remediation}`);
    }
  }
  return lines.join('\n');
}

/** Machine-readable report. Safe to print: secrets are never included. */
export function formatJson(result: ValidateConfigResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      profile: result.profile,
      contract_version: result.contractVersion,
      config_hash: result.configHash,
      errors: result.errors,
      warnings: result.warnings,
    },
    null,
    2,
  );
}

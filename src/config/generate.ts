/**
 * Deterministic generators for every configuration artifact (issue #515).
 *
 * `.env.example`, `docs/configuration.md`, the JSON Schema, the per-service
 * manifest and the per-profile fixtures are GENERATED, never hand-edited. CI
 * regenerates and diffs (`npm run config:check:drift`), so documentation cannot
 * silently drift away from the schema again.
 *
 * PURE module: every function returns a string / plain object. Writing to disk
 * is the CLI's job (`scripts/config.ts`).
 */
import {
  CONTRACT_ENTRIES,
  CONTRACT_VERSION,
  TOMBSTONES,
  allowedProfiles,
  entriesForService,
} from '@/config/contract.js';
import {
  GROUP_ORDER,
  MAIA_PROFILES,
  MAIA_SERVICES,
  type ConfigGroup,
  type EnvVarSpec,
  type MaiaProfile,
} from '@/config/metadata.js';

const BANNER_ENV = [
  '# =====================================================================',
  '# Maia — Variáveis de ambiente',
  '#',
  '# ARQUIVO GERADO — não edite à mão.',
  '#   Fonte da verdade: src/config/contract.ts',
  '#   Regenerar:        npm run config:generate',
  '#   Verificar drift:  npm run config:check:drift',
  '#',
  '# Copie para .env e preencha. NUNCA comite o .env real.',
  '# Valores marcados com __SET_ME__ / ... são PLACEHOLDERS: a validação',
  '# estrita de staging e produção os recusa.',
  '# =====================================================================',
  '',
];

// ---------------------------------------------------------------------------
// Minimal Zod introspection (same approach as src/tools/describe-schema.ts:30 —
// read the `_def.typeName` discriminator instead of importing zod's classes).
// ---------------------------------------------------------------------------

interface ZodDefLike {
  typeName?: string;
  innerType?: { _def?: ZodDefLike };
  defaultValue?: () => unknown;
  schema?: { _def?: ZodDefLike };
  values?: readonly string[];
  checks?: readonly { kind?: string; value?: unknown }[];
}

interface SchemaFacts {
  /** JSON Schema primitive type. Everything arrives as a string in `.env`. */
  readonly type: 'string' | 'number' | 'boolean' | 'array';
  readonly enumValues?: readonly string[];
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
  readonly optional: boolean;
}

/** Unwrap ZodDefault / ZodOptional / ZodEffects down to the base schema. */
export function schemaFacts(schema: { _def?: ZodDefLike }): SchemaFacts {
  let def: ZodDefLike | undefined = schema._def;
  let hasDefault = false;
  let defaultValue: unknown;
  let optional = false;
  let type: SchemaFacts['type'] = 'string';
  let enumValues: readonly string[] | undefined;
  let isTransform = false;

  // Bounded walk — the deepest contract schema is 3 wrappers.
  for (let i = 0; i < 8 && def; i += 1) {
    switch (def.typeName) {
      case 'ZodDefault':
        hasDefault = true;
        try {
          defaultValue = def.defaultValue?.();
        } catch {
          defaultValue = undefined;
        }
        def = def.innerType?._def;
        continue;
      case 'ZodOptional':
        optional = true;
        def = def.innerType?._def;
        continue;
      case 'ZodEffects':
        isTransform = true;
        def = def.schema?._def;
        continue;
      case 'ZodNumber':
        type = 'number';
        def = undefined;
        continue;
      case 'ZodBoolean':
        type = 'boolean';
        def = undefined;
        continue;
      case 'ZodEnum':
        enumValues = def.values;
        type = 'string';
        def = undefined;
        continue;
      default:
        def = undefined;
        continue;
    }
  }

  // A `.transform()` on a string produces a boolean flag or a string list in
  // this contract; the ENV value itself is still a string, which is what the
  // JSON Schema describes.
  if (isTransform) type = 'string';

  return { type, enumValues, hasDefault, defaultValue, optional };
}

/** Human-readable default for docs. `undefined` when there is none. */
function documentedDefault(spec: EnvVarSpec): string | undefined {
  const facts = schemaFacts(spec.schema);
  if (!facts.hasDefault) return undefined;
  const v = facts.defaultValue;
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function groupsInOrder(entries: readonly EnvVarSpec[]): {
  group: ConfigGroup;
  title: string;
  specs: EnvVarSpec[];
}[] {
  return GROUP_ORDER.map(({ group, title }) => ({
    group,
    title,
    specs: entries.filter((s) => s.group === group),
  })).filter((g) => g.specs.length > 0);
}

/** Wrap a description into `# ` comment lines at ~76 columns. */
function commentBlock(text: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '#';
  for (const word of words) {
    if (current.length + word.length + 1 > 76) {
      lines.push(current);
      current = '#';
    }
    current += ` ${word}`;
  }
  if (current !== '#') lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// .env.example
// ---------------------------------------------------------------------------

/** Deterministic `.env.example`, in contract order. */
export function renderEnvExample(): string {
  const lines: string[] = [...BANNER_ENV];

  for (const { title, specs } of groupsInOrder(CONTRACT_ENTRIES)) {
    lines.push(`# ---- ${title} ----`);
    for (const spec of specs) {
      lines.push(...commentBlock(spec.description));
      const def = documentedDefault(spec);
      const meta: string[] = [];
      if (def !== undefined) meta.push(`default: ${def}`);
      if (spec.requiredWhen) meta.push(`obrigatória quando ${spec.requiredWhen}`);
      if (spec.requiredIn?.length) meta.push(`obrigatória em: ${spec.requiredIn.join(', ')}`);
      if (spec.secret) meta.push('SEGREDO');
      if (!spec.restartRequired) meta.push('aplicável sem restart');
      const restricted = allowedProfiles(spec);
      if (restricted.length < MAIA_PROFILES.length) {
        meta.push(`ativa apenas em: ${restricted.join(', ')}`);
      }
      if (meta.length > 0) lines.push(...commentBlock(`(${meta.join(' · ')})`));
      const prefix = spec.commentedInExample ? '# ' : '';
      lines.push(`${prefix}${spec.name}=${spec.example ?? ''}`);
      lines.push('');
    }
  }

  if (TOMBSTONES.length > 0) {
    lines.push('# ---- Variáveis REMOVIDAS (tombstones) ----');
    lines.push(
      ...commentBlock(
        'As variáveis abaixo não existem mais. Mantê-las no ambiente é recusado pela validação ' +
          '(erro em staging/produção, aviso em development) para que nenhum operador acredite ' +
          'estar controlando um caminho que já foi deletado.',
      ),
    );
    for (const t of TOMBSTONES) {
      lines.push(`#   ${t.name} — removida em ${t.removedIn}${t.replacement ? ` (use ${t.replacement})` : ''}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// docs/configuration.md
// ---------------------------------------------------------------------------

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Deterministic `docs/configuration.md`. */
export function renderConfigDoc(): string {
  const out: string[] = [];
  out.push('# Configuração da Maia');
  out.push('');
  out.push('> **ARQUIVO GERADO — não edite à mão.**');
  out.push('> Fonte da verdade: [`src/config/contract.ts`](../src/config/contract.ts).');
  out.push('> Regenerar: `npm run config:generate`. Verificar drift: `npm run config:check:drift`.');
  out.push('');
  out.push(`Versão do contrato: \`${CONTRACT_VERSION}\``);
  out.push('');

  out.push('## Profiles');
  out.push('');
  out.push(
    '`MAIA_ENV` seleciona o profile (`development` | `staging` | `production`). `NODE_ENV` ' +
      'continua controlando apenas as otimizações da plataforma Node — ele nem sequer consegue ' +
      'expressar `staging`. Quando `MAIA_ENV` está ausente, o profile é derivado de `NODE_ENV`; ' +
      'quando os dois se contradizem, a validação falha.',
  );
  out.push('');
  out.push('| Profile | Postura |');
  out.push('|---|---|');
  out.push('| `development` | Endpoints locais permitidos, alertas podem ser só `log`, backup remoto opcional, auth de desenvolvimento explicitamente permitida. Variáveis desconhecidas/removidas geram **aviso**. |');
  out.push('| `staging` | Equivalente a produção sempre que possível: secrets de teste obrigatórios, backup validado, nenhum placeholder. Desconhecidas/removidas são **erro**. |');
  out.push('| `production` | Placeholders e auth de desenvolvimento recusados, dependências condicionais obrigatórias, thresholds validados, configuração mínima por serviço. Desconhecidas/removidas são **erro**. |');
  out.push('');

  out.push('## Comandos');
  out.push('');
  out.push('```bash');
  out.push('npm run config:generate                 # regenera .env.example, docs, manifest, fixtures');
  out.push('npm run config:check:drift              # falha se os artefatos gerados estiverem desatualizados');
  out.push('npm run config:check -- --profile production --env-file .env');
  out.push('npm run config:check -- --profile development --env-file .env.example --allow-placeholders');
  out.push('npm run config:init -- --profile development');
  out.push('```');
  out.push('');
  out.push(
    '`config:check` reporta **todos** os problemas numa única execução (nunca só o primeiro), com ' +
      'variável, regra violada e remediação — e **nunca** o valor de um segredo. Aceita `--json` ' +
      'para automações.',
  );
  out.push('');

  out.push('## Configuração mínima por serviço');
  out.push('');
  out.push('| Serviço | Variáveis | Segredos |');
  out.push('|---|---:|---:|');
  for (const service of MAIA_SERVICES) {
    const specs = entriesForService(service);
    out.push(
      `| \`${service}\` | ${specs.length} | ${specs.filter((s) => s.secret).length} |`,
    );
  }
  out.push('');
  out.push(
    'O manifest completo (por serviço e por profile) é gerado em ' +
      '[`src/config/generated/service-env-manifest.json`](../src/config/generated/service-env-manifest.json).',
  );
  out.push('');

  out.push('## Variáveis');
  out.push('');
  for (const { title, specs } of groupsInOrder(CONTRACT_ENTRIES)) {
    out.push(`### ${title}`);
    out.push('');
    out.push('| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |');
    out.push('|---|---|---|---|---|---|---|');
    for (const spec of specs) {
      const facts = schemaFacts(spec.schema);
      const type = facts.enumValues ? facts.enumValues.map((v) => `\`${v}\``).join(' \\| ') : facts.type;
      const def = documentedDefault(spec);
      const notes: string[] = [mdEscape(spec.description)];
      if (spec.requiredWhen) notes.push(`Obrigatória quando ${mdEscape(spec.requiredWhen)}.`);
      if (spec.requiredIn?.length) notes.push(`Obrigatória em: ${spec.requiredIn.join(', ')}.`);
      const restricted = allowedProfiles(spec);
      if (restricted.length < MAIA_PROFILES.length) {
        notes.push(`Ativa apenas em: ${restricted.join(', ')}.`);
      }
      if (spec.deprecatedSince) {
        notes.push(
          `**Depreciada** desde ${spec.deprecatedSince}${spec.replacement ? ` — use \`${spec.replacement}\`` : ''}.`,
        );
      }
      out.push(
        `| \`${spec.name}\` | ${type} | ${def === undefined ? '—' : `\`${mdEscape(def)}\``} | ` +
          `${spec.secret ? 'sim' : 'não'} | ${spec.services.map((s) => `\`${s}\``).join(', ')} | ` +
          `${spec.restartRequired ? 'sim' : 'não'} | ${notes.join(' ')} |`,
      );
    }
    out.push('');
  }

  out.push('## Variáveis removidas (tombstones)');
  out.push('');
  out.push(
    'Nenhuma remoção é silenciosa. Uma variável removida permanece listada aqui por pelo menos um ' +
      'ciclo de release, e configurá-la é recusado pela validação.',
  );
  out.push('');
  out.push('| Variável | Removida em | Substituta | Motivo |');
  out.push('|---|---|---|---|');
  for (const t of TOMBSTONES) {
    out.push(
      `| \`${t.name}\` | ${t.removedIn} | ${t.replacement ? `\`${t.replacement}\`` : '—'} | ${mdEscape(t.reason)} |`,
    );
  }
  out.push('');

  out.push('## Runbook — adicionar, depreciar, remover');
  out.push('');
  out.push('**Adicionar**');
  out.push('');
  out.push('1. Declare a entrada em `src/config/contract.ts` (schema + `description` + `group` + `secret` + `services` + `example` + `fixture` + `restartRequired`).');
  out.push('2. Se a variável tem dependência de outra, escreva a regra em `src/config/rules.ts` (escopo `contract`) com mensagem e remediação.');
  out.push('3. `npm run config:generate` e commite os artefatos regenerados.');
  out.push('4. Consuma via o loader do serviço — nunca `process.env` direto (a regra ESLint `no-restricted-properties` bloqueia leituras novas fora da allowlist em `eslint.config.js`).');
  out.push('');
  out.push('**Depreciar**');
  out.push('');
  out.push('1. Preencha `deprecatedSince` (e `replacement`) na entrada. A validação passa a emitir aviso identificável (`contract/deprecated`).');
  out.push('2. Mantenha o comportamento funcionando por, no mínimo, um ciclo de release.');
  out.push('');
  out.push('**Remover**');
  out.push('');
  out.push('1. Remova a entrada de `ENV_CONTRACT` e adicione um `Tombstone` em `TOMBSTONES` com `removedIn`, `reason` e `failsOn`.');
  out.push('2. `npm run config:generate`. O tombstone aparece no `.env.example` e nesta página.');
  out.push('3. Nunca renomeie nem reutilize o nome de uma variável removida.');
  out.push('');

  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/** JSON Schema (draft-07) describing the whole environment. */
export function buildJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const spec of CONTRACT_ENTRIES) {
    const facts = schemaFacts(spec.schema);
    const prop: Record<string, unknown> = {
      // Values always arrive as strings from the process environment; `type`
      // records the SEMANTIC type so automations can coerce.
      type: 'string',
      description: spec.description,
      'x-maia-type': facts.type,
      'x-maia-group': spec.group,
      'x-maia-secret': spec.secret,
      'x-maia-services': [...spec.services],
      'x-maia-restart-required': spec.restartRequired,
    };
    if (facts.enumValues) prop.enum = [...facts.enumValues];
    const def = documentedDefault(spec);
    if (def !== undefined) prop.default = def;
    if (spec.requiredWhen) prop['x-maia-required-when'] = spec.requiredWhen;
    if (spec.requiredIn) prop['x-maia-required-in'] = [...spec.requiredIn];
    if (spec.deprecatedSince) {
      prop.deprecated = true;
      prop['x-maia-deprecated-since'] = spec.deprecatedSince;
    }
    if (spec.replacement) prop['x-maia-replacement'] = spec.replacement;
    // Secrets never carry an `examples` entry — the placeholder is documented
    // in `.env.example`, and a JSON Schema is a machine-readable artifact that
    // gets copied around.
    if (!spec.secret && spec.example !== undefined) prop.examples = [spec.example];
    properties[spec.name] = prop;
    if (!facts.hasDefault && !facts.optional) required.push(spec.name);
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://maia.local/schemas/env-contract.json',
    title: 'Maia environment contract',
    'x-maia-contract-version': CONTRACT_VERSION,
    type: 'object',
    required,
    properties,
    'x-maia-tombstones': TOMBSTONES.map((t) => ({
      name: t.name,
      removed_in: t.removedIn,
      reason: t.reason,
      replacement: t.replacement ?? null,
      fails_on: t.failsOn,
    })),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Synthetic-but-strictly-valid environment for a profile. Used by CI to prove
 * that the contract can actually be satisfied, and by tests that need a valid
 * config without touching `process.env`.
 *
 * Contains NO real credentials — every value is a `fixture-*` literal.
 */
export function buildFixture(profile: MaiaProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of CONTRACT_ENTRIES) {
    if (spec.fixture === undefined) continue;
    if (!allowedProfiles(spec).includes(profile)) continue;
    out[spec.name] = spec.fixtureByProfile?.[profile] ?? spec.fixture;
  }
  return out;
}

/** Render a fixture as a `.env`-shaped file. */
export function renderFixture(profile: MaiaProfile): string {
  const lines: string[] = [
    '# =====================================================================',
    `# Maia — fixture sintética do profile ${profile}`,
    '#',
    '# ARQUIVO GERADO — não edite à mão (npm run config:generate).',
    '# Valores sintéticos: NENHUM segredo real. Usado pelo CI para provar que',
    '# o contrato é satisfazível e pelos testes que precisam de uma config',
    '# válida sem tocar em process.env.',
    '# =====================================================================',
    '',
  ];
  const fixture = buildFixture(profile);
  for (const spec of CONTRACT_ENTRIES) {
    const value = fixture[spec.name];
    if (value === undefined) continue;
    lines.push(`${spec.name}=${value}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// .env parsing (shared by the CLI and by the parity tests)
// ---------------------------------------------------------------------------

/**
 * Minimal `.env` parser — deliberately NOT `dotenv`, because dotenv mutates
 * `process.env` and the validator must stay pure. Handles `KEY=value`,
 * `export KEY=value`, `#` comments and single/double quotes.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

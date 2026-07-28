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
  describeRequiredWhen,
  evaluateRequiredWhen,
  isOperatorPlaceholder,
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
// .env.example and the `maia config init` operational template
// ---------------------------------------------------------------------------

/**
 * Variables whose value IS the profile. The operator does not choose them, so
 * the template writes them out rather than asking for a value.
 */
const PROFILE_DETERMINED = new Set(['MAIA_ENV', 'NODE_ENV']);

/** True when the schema itself rejects an absent value. */
function schemaRequires(spec: EnvVarSpec): boolean {
  return spec.schema.safeParse(undefined).success === false;
}

/**
 * True when the operator MUST supply this value for this profile. Those get a
 * `__SET_ME__` marker in the template so `maia config check` fails until they
 * are filled in.
 */
function mustBeSupplied(spec: EnvVarSpec, profile: MaiaProfile): boolean {
  if (PROFILE_DETERMINED.has(spec.name)) return false;
  if (spec.secret) return true;
  if (spec.requiredIn?.includes(profile)) return true;
  if (schemaRequires(spec)) return true;
  // An `http://localhost` default is a development convenience; outside
  // development it is a deployment-specific public URL.
  return profile !== 'development' && (spec.example ?? '').startsWith('http://');
}

/**
 * Placeholder that keeps enough SHAPE to be schema-valid where possible, so the
 * template fails on the explicit `secret/placeholder` rule (clear message)
 * rather than on an opaque schema error.
 */
function templatePlaceholder(spec: EnvVarSpec, profile: MaiaProfile): string {
  const example = spec.example ?? '';
  const url = /^([a-z][a-z0-9+.-]*):\/\//i.exec(example);
  if (url?.[1]) {
    const scheme =
      url[1].toLowerCase() === 'http' && profile !== 'development' ? 'https' : url[1];
    return `${scheme}://__SET_ME__`;
  }
  // Keep the documented example ONLY when a bare marker would not satisfy the
  // schema and the example would — i.e. when the example carries structure the
  // operator needs to preserve (`sk-ant-…` prefix, a 16-char minimum). For
  // everything else the bare marker reads better than `trocar_senha_forte`.
  const bareRejected = !spec.schema.safeParse(MARKER).success;
  if (bareRejected && example && isOperatorPlaceholder(example)) {
    if (spec.schema.safeParse(example).success) return example;
  }
  return MARKER;
}

/** The marker every value the operator owns carries in a generated template. */
const MARKER = '__SET_ME__';

function templateValue(spec: EnvVarSpec, profile: MaiaProfile): string {
  if (PROFILE_DETERMINED.has(spec.name)) {
    return spec.fixtureByProfile?.[profile] ?? spec.fixture ?? spec.example ?? '';
  }
  if (mustBeSupplied(spec, profile)) return templatePlaceholder(spec, profile);
  return spec.example ?? '';
}

/**
 * Which variables the template writes UNCOMMENTED for a profile: the ones the
 * example already writes, the ones the profile requires, and the transitive
 * closure of `requiredWhen` over those (a required `BACKUP_S3_BUCKET` pulls in
 * its credentials).
 */
function templateActiveNames(profile: MaiaProfile): Set<string> {
  const allowed = CONTRACT_ENTRIES.filter((s) => allowedProfiles(s).includes(profile));
  const active = new Set(
    allowed
      .filter((spec) => {
        if (spec.requiredIn?.includes(profile) || schemaRequires(spec)) return true;
        // A CONDITIONAL secret (a provider key) starts commented out: demanding
        // COHERE_API_KEY from a deployment that runs Voyage would block a
        // perfectly good `.env`. The `requiredWhen` closure below turns on
        // exactly the ones the chosen providers need.
        if (spec.secret && spec.requiredWhen) return false;
        return !spec.commentedInExample;
      })
      .map((s) => s.name),
  );

  // Fixed point — the deepest chain in the contract is 2 hops.
  for (let pass = 0; pass < 5; pass += 1) {
    const raw: Record<string, string | undefined> = {};
    for (const spec of allowed) {
      if (active.has(spec.name)) raw[spec.name] = templateValue(spec, profile);
    }
    let changed = false;
    for (const spec of allowed) {
      if (active.has(spec.name) || !spec.requiredWhen) continue;
      if (evaluateRequiredWhen(spec.requiredWhen, { values: {}, raw })) {
        active.add(spec.name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return active;
}

interface EnvRenderOptions {
  readonly profile: MaiaProfile;
  /**
   * `example` — the committed `.env.example`: documents EVERY variable with its
   * example value, development-shaped.
   * `template` — `maia config init`: a per-profile starting point where every
   * value the operator must supply is a placeholder that FAILS
   * `maia config check` until replaced.
   */
  readonly mode: 'example' | 'template';
}

function renderEnvFile(options: EnvRenderOptions): string {
  const { profile, mode } = options;
  const template = mode === 'template';
  const active = template ? templateActiveNames(profile) : null;
  const entries = template
    ? CONTRACT_ENTRIES.filter((s) => allowedProfiles(s).includes(profile))
    : CONTRACT_ENTRIES;

  const lines: string[] = template ? [...bannerTemplate(profile)] : [...BANNER_ENV];

  for (const { title, specs } of groupsInOrder(entries)) {
    lines.push(`# ---- ${title} ----`);
    for (const spec of specs) {
      lines.push(...commentBlock(spec.description));
      const def = documentedDefault(spec);
      const meta: string[] = [];
      if (def !== undefined) meta.push(`default: ${def}`);
      if (spec.requiredWhen)
        meta.push(`obrigatória quando ${describeRequiredWhen(spec.requiredWhen)}`);
      if (spec.requiredIn?.length) meta.push(`obrigatória em: ${spec.requiredIn.join(', ')}`);
      if (spec.secret) meta.push('SEGREDO');
      if (!spec.restartRequired) meta.push('aplicável sem restart');
      const restricted = allowedProfiles(spec);
      if (restricted.length < MAIA_PROFILES.length) {
        meta.push(`ativa apenas em: ${restricted.join(', ')}`);
      }
      if (meta.length > 0) lines.push(...commentBlock(`(${meta.join(' · ')})`));

      const value = template ? templateValue(spec, profile) : (spec.example ?? '');
      if (template && mustBeSupplied(spec, profile) && spec.example && spec.example !== value) {
        lines.push(...commentBlock(`formato/exemplo: ${spec.example}`));
      }
      const commented = template ? !active!.has(spec.name) : Boolean(spec.commentedInExample);
      lines.push(`${commented ? '# ' : ''}${spec.name}=${value}`);
      lines.push('');
    }
  }

  if (TOMBSTONES.length > 0) {
    lines.push('# ---- Variáveis REMOVIDAS (tombstones) ----');
    lines.push(
      ...commentBlock(
        'As variáveis abaixo não existem mais. Mantê-las no ambiente é recusado pela validação ' +
          '(ERRO DE BOOT em todos os profiles, development incluído) para que nenhum operador ' +
          'acredite estar controlando um caminho que já foi deletado. Rollback de emergência: ' +
          'MAIA_CONFIG_STRICT_BOOT=false — ver docs/runbooks/config-contract.md.',
      ),
    );
    for (const t of TOMBSTONES) {
      lines.push(`#   ${t.name} — removida em ${t.removedIn}${t.replacement ? ` (use ${t.replacement})` : ''}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function bannerTemplate(profile: MaiaProfile): string[] {
  return [
    '# =====================================================================',
    `# Maia — ponto de partida operacional do profile ${profile}`,
    '#',
    `# Gerado por: npm run config:init -- --profile ${profile}`,
    '#',
    '# Todo valor marcado __SET_ME__ é SEU: preencha antes do deploy. Enquanto',
    '# houver qualquer um deles, o comando abaixo FALHA de propósito —',
    '# é assim que uma configuração incompleta não passa por completa:',
    `#     npm run config:check -- --profile ${profile} --env-file .env`,
    '#',
    '# Este arquivo NÃO é uma fixture de CI. As fixtures em',
    '# src/config/generated/fixtures/ têm valores sintéticos que não',
    '# autenticam em nada e nunca devem virar um .env.',
    '#',
    '# NUNCA comite o .env real.',
    '# =====================================================================',
    '',
  ];
}

/** Deterministic `.env.example`, in contract order. */
export function renderEnvExample(): string {
  return renderEnvFile({ profile: 'development', mode: 'example' });
}

/**
 * Operational starting point for `maia config init`. Every value the operator
 * must supply is a `__SET_ME__` placeholder, so the generated file FAILS
 * `maia config check --profile <p>` until it is filled in.
 */
export function renderEnvTemplate(profile: MaiaProfile): string {
  return renderEnvFile({ profile, mode: 'template' });
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
  out.push('| `development` | Endpoints locais permitidos, alertas podem ser só `log`, backup remoto opcional, auth de desenvolvimento explicitamente permitida, placeholders tolerados. |');
  out.push('| `staging` | Equivalente a produção sempre que possível: secrets de teste obrigatórios, backup validado, nenhum placeholder. |');
  out.push('| `production` | Placeholders e auth de desenvolvimento recusados, dependências condicionais obrigatórias, thresholds validados, configuração mínima por serviço. |');
  out.push('');
  out.push(
    '**O boot falha fechado em TODOS os profiles.** Variável desconhecida, variável removida ' +
      '(tombstone) e contradição `NODE_ENV` × `MAIA_ENV` abortam o boot em `development` ' +
      'exatamente como em produção: um `.env` que sobe no laptop e morre em staging é o drift ' +
      'que este contrato existe para eliminar. O que muda por profile é o rigor sobre ' +
      'placeholders, endpoints locais e auth de desenvolvimento.',
  );
  out.push('');
  out.push(
    '**Rollback de emergência, sem redeploy:** `MAIA_CONFIG_STRICT_BOOT=false` volta ao loader ' +
      'anterior (schema Zod + regras de boot legadas) e desliga a validação de contrato inteira. ' +
      'É uma alavanca para destravar um ambiente, não um estado estável — o boot degradado ' +
      'loga um aviso a cada start. Procedimento completo em ' +
      '[`docs/runbooks/config-contract.md`](runbooks/config-contract.md).',
  );
  out.push('');

  out.push('## Comandos');
  out.push('');
  out.push('```bash');
  out.push('npm run config:generate                 # regenera .env.example, docs, manifest, fixtures');
  out.push('npm run config:check:drift              # falha se os artefatos gerados estiverem desatualizados');
  out.push('npm run config:check -- --profile production --env-file .env');
  out.push('npm run config:check -- --profile development --env-file .env.example --allow-placeholders');
  out.push('npm run config:init -- --profile production   # ponto de partida operacional');
  out.push('```');
  out.push('');
  out.push(
    '`config:check` reporta **todos** os problemas numa única execução (nunca só o primeiro), com ' +
      'variável, regra violada e remediação — e **nunca** o valor de um segredo. Aceita `--json` ' +
      'para automações.',
  );
  out.push('');
  out.push(
    '`config:init` gera um **ponto de partida operacional**: todo valor que pertence ao operador ' +
      'vem marcado com `__SET_ME__`, e a validação estrita **falha de propósito** até que ele seja ' +
      'substituído. Ele NÃO é uma fixture.',
  );
  out.push('');
  out.push('### Fixtures sintéticas vs. configuração real');
  out.push('');
  out.push(
    'As fixtures em `src/config/generated/fixtures/` existem para o CI provar que o contrato é ' +
      '**satisfazível**: valores previsíveis (`sk-ant-fixture-…`) que não autenticam em nada. Um ' +
      'processo configurado com elas fica inoperante parecendo configurado, então `config:check` ' +
      'as **recusa** fora de development (regra `secret/synthetic-fixture`). Só o opt-in explícito ' +
      '`--allow-fixtures`, usado para validar esses próprios arquivos, as aceita:',
  );
  out.push('');
  out.push('```bash');
  out.push('npm run config:check -- --profile production \\');
  out.push('  --env-file src/config/generated/fixtures/production.env --allow-fixtures');
  out.push('```');
  out.push('');
  out.push(
    'Os dois opt-ins são separados de propósito: `--allow-placeholders` (usado no `.env.example`) ' +
      'não concede permissão para valores de fixture, e vice-versa.',
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
      if (spec.requiredWhen)
        notes.push(`Obrigatória quando ${mdEscape(describeRequiredWhen(spec.requiredWhen))}.`);
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
    if (spec.requiredWhen) prop['x-maia-required-when'] = describeRequiredWhen(spec.requiredWhen);
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
    `# Maia — fixture SINTÉTICA do profile ${profile}`,
    '#',
    '# ARQUIVO GERADO — não edite à mão (npm run config:generate).',
    '#',
    '# NÃO USE COMO .env. Os valores aqui são previsíveis de propósito e não',
    '# autenticam em NADA: um processo configurado com eles fica inoperante',
    '# parecendo configurado. `maia config check` recusa estes valores fora de',
    '# development (regra secret/synthetic-fixture) — só o opt-in explícito',
    '# --allow-fixtures, usado para validar ESTE arquivo, os aceita.',
    '#',
    '# Para um ponto de partida real:',
    `#     npm run config:init -- --profile ${profile}`,
    '#',
    '# Serve para o CI provar que o contrato é satisfazível e para os testes',
    '# que precisam de uma configuração completa sem tocar em process.env.',
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
// .env parsing
// ---------------------------------------------------------------------------

/**
 * Re-exported for convenience. The implementation lives in
 * `src/config/env-file.ts` and delegates to `dotenv.parse`, so the CLI, the
 * validator and the runtime boot share ONE interpretation of a `.env` file.
 * A hand-rolled parser used to live here and diverged from dotenv on inline
 * comments, quoting and multi-line values (PR #522 review round 1).
 */
export { parseEnvFile } from '@/config/env-file.js';

/**
 * O ambiente EFETIVO de um serviço do Compose (issue #572).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este módulo existe
 * ─────────────────────────────────────────────────────────────────────────
 * `npm run config:check -- --env-file .env.app` dá FALSO POSITIVO no serviço
 * `app`. O container não recebe só o `.env.app`: `compose.prod.yml` injeta
 * `DATABASE_URL`, `REDIS_URL`, `POSTGRES_*`, `NODE_ENV` e `MAIA_ENV` pelo
 * `environment:`, interpolados a partir do `.env.infra`. Checar uma das duas
 * fontes sozinha responde a uma pergunta que ninguém fez — o operador quer
 * saber se o CONTAINER sobe, e o container vê a UNIÃO.
 *
 * Aqui mora a união, e só ela: dado o TEXTO do compose, o TEXTO de cada
 * `env_file` e o `.env.infra` de interpolação, devolve exatamente o que o
 * processo lerá em `process.env` — `env_file` primeiro, `environment:` por
 * cima (a precedência do Compose).
 *
 * Um só lugar de propósito: `scripts/config.ts preflight` (o comando que o
 * runbook manda rodar ANTES do `up`) e
 * `tests/unit/migrations/compose-prod-effective-env.spec.ts` (o teste que
 * prova que os `.prod.example` do repositório satisfazem o loader) derivam o
 * ambiente DAQUI. Duas derivações seriam duas respostas possíveis para "o que
 * o container recebe", e a do teste é a que ninguém roda em produção.
 *
 * PUREZA: nada aqui toca disco, rede ou `process.env`. O chamador lê os
 * arquivos e passa o conteúdo. `tests/unit/config/contract-purity.spec.ts`
 * cobre os módulos puros de `src/config/`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O parser
 * ─────────────────────────────────────────────────────────────────────────
 * Subset estrito, extraído verbatim de `tests/unit/migrations/_compose-yaml.ts`
 * (issue #516), que continua reexportando daqui. NÃO é uma biblioteca YAML:
 * `yaml` só existe como dependência transitiva neste repositório e promovê-la
 * mexeria no `package-lock.json`, que o guard `preinstall` fixa em npm 11.5.2.
 * NÃO é regex: a propriedade é NINHO (`services.app.env_file`), e um regex
 * sobre arquivo plano não sabe de que serviço uma linha é.
 *
 * É deliberadamente ESTRITO: qualquer linha que ele não entenda por inteiro
 * lança `ComposeParseError` com arquivo e linha. Um parser que pulasse em
 * silêncio o que não entende transformaria um compose mal lido num preflight
 * VERDE — o único modo de falha que um gate assim não pode ter.
 */
import type { MaiaService } from '@/config/metadata.js';
import { parseEnvFile } from '@/config/env-file.js';

export type ComposeNode = string | ComposeNode[] | { [key: string]: ComposeNode };

export class ComposeParseError extends Error {
  constructor(file: string, lineNo: number, line: string, why: string) {
    super(`${file}:${lineNo}: ${why}\n  ${line}`);
    this.name = 'ComposeParseError';
  }
}

interface RawLine {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/** Strip a quoted scalar; leave everything else byte-for-byte. */
function scalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Flow sequence (`["CMD", "x"]`) — kept as a real array so `command:` can be
 * asserted the same way whether it was written in flow or block style.
 * Splits on top-level commas only, so a comma inside a quoted element stays
 * part of that element.
 */
function flowSequence(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      buf += ch;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(scalar(buf));
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(scalar(buf));
  return out;
}

const KEY_LINE = /^([A-Za-z0-9_.@/+-]+):(?:\s+(.*))?$/;

function parseBlock(lines: RawLine[], start: number, indent: number, file: string): [ComposeNode, number] {
  const first = lines[start];
  if (!first) return ['', start];

  if (first.text.startsWith('- ') || first.text === '-') {
    const seq: ComposeNode[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new ComposeParseError(file, line.no, line.text, 'unexpected indentation inside a sequence');
      }
      if (!line.text.startsWith('- ') && line.text !== '-') {
        break;
      }
      const item = line.text === '-' ? '' : line.text.slice(2);
      const inline = KEY_LINE.exec(item);
      if (inline && (inline[2] === undefined || inline[2] === '')) {
        // `- key:` opening a nested map inside a sequence: not used by these
        // files. Refuse rather than guess.
        throw new ComposeParseError(file, line.no, line.text, 'nested map inside a sequence is not supported');
      }
      seq.push(scalar(item));
      i += 1;
    }
    return [seq, i];
  }

  const map: Record<string, ComposeNode> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new ComposeParseError(file, line.no, line.text, 'unexpected indentation inside a map');
    }
    const m = KEY_LINE.exec(line.text);
    if (!m) {
      throw new ComposeParseError(file, line.no, line.text, 'line is neither a `key: value` nor a `- item`');
    }
    const key = m[1]!;
    const value = m[2];
    if (value === undefined || value === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        map[key] = '';
        i += 1;
        continue;
      }
      const [child, consumed] = parseBlock(lines, i + 1, next.indent, file);
      map[key] = child;
      i = consumed;
      continue;
    }
    const trimmed = value.trim();
    map[key] = trimmed.startsWith('[') && trimmed.endsWith(']') ? flowSequence(trimmed) : scalar(trimmed);
    i += 1;
  }
  return [map, i];
}

/**
 * Parse Compose TEXT. `label` só aparece nas mensagens de erro (normalmente o
 * caminho do arquivo que o chamador leu). Lança em tudo que não entender.
 */
export function parseComposeText(text: string, label: string): Record<string, ComposeNode> {
  const lines: RawLine[] = [];
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((raw, idx) => {
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
      if (raw.includes('\t')) {
        throw new ComposeParseError(label, idx + 1, raw, 'tab in indentation');
      }
      lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
    });
  const [node, consumed] = parseBlock(lines, 0, 0, label);
  if (consumed !== lines.length) {
    const stray = lines[consumed]!;
    throw new ComposeParseError(label, stray.no, stray.text, 'trailing content the parser did not consume');
  }
  return node as Record<string, ComposeNode>;
}

/** Narrowing helpers — a wrong shape is an error, not a silent `undefined`. */
export function asMap(node: ComposeNode | undefined, what: string): Record<string, ComposeNode> {
  if (node === undefined || typeof node === 'string' || Array.isArray(node)) {
    throw new Error(`expected ${what} to be a map, got ${JSON.stringify(node)}`);
  }
  return node;
}

export function asString(node: ComposeNode | undefined, what: string): string {
  if (typeof node !== 'string') {
    throw new Error(`expected ${what} to be a scalar, got ${JSON.stringify(node)}`);
  }
  return node;
}

/**
 * Compose interpolation: `${VAR}`, `${VAR:-default}`, `${VAR:?message}`.
 * Uma variável `:?` ausente LANÇA — o mesmo fail-closed do `docker compose`,
 * para que o preflight não "resolva" uma credencial obrigatória para string
 * vazia e siga em frente.
 */
export function interpolate(value: string, env: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}/g, (_all, name: string, op, rest: string) => {
    const present = env[name];
    if (present !== undefined && present !== '') return present;
    if (op === '-') return rest;
    if (op === '?') throw new Error(`compose interpolation: ${name} is required (\${${name}:?...})`);
    return '';
  });
}

// ---------------------------------------------------------------------------
// Serviço do Compose → serviço do contrato
// ---------------------------------------------------------------------------

/**
 * Qual loader é dono de cada container. É esta tabela que faz o preflight
 * cobrir os TRÊS consumidores, e não só o subset do migrator.
 */
export const COMPOSE_SERVICE_CONTRACT: Readonly<Record<string, MaiaService>> = {
  migrate: 'migrator',
  app: 'runtime',
  'admin-ui': 'admin-ui',
};

/**
 * Serviços do Compose que rodam imagem de terceiro e NÃO leem configuração da
 * Maia. Listados por nome de propósito: um serviço novo que não esteja nem
 * aqui nem em `COMPOSE_SERVICE_CONTRACT` faz `preflightTargets` LANÇAR, em vez
 * de sair silenciosamente do preflight — que é como um consumidor novo
 * voltaria a descobrir a configuração no boot.
 */
export const COMPOSE_SERVICES_WITHOUT_MAIA_CONFIG: readonly string[] = ['postgres', 'redis'];

export interface PreflightTarget {
  /** Nome do serviço em `compose.prod.yml`. */
  readonly compose: string;
  /** Loader dono dele em `src/config/contract.ts`. */
  readonly contract: MaiaService;
  /** `env_file:` declarados, na ordem, exatamente como escritos no compose. */
  readonly envFiles: readonly string[];
}

/** `services:` do compose já parseado. */
export function composeServices(compose: Record<string, ComposeNode>): Record<string, ComposeNode> {
  return asMap(compose.services, 'services');
}

/** Os `env_file:` de um serviço, na ordem. Lista vazia quando não há nenhum. */
export function envFileNamesOf(
  compose: Record<string, ComposeNode>,
  service: string,
): string[] {
  const declared = asMap(composeServices(compose)[service], `services.${service}`).env_file;
  if (declared === undefined) return [];
  const list = Array.isArray(declared) ? declared : [asString(declared, 'env_file')];
  return list.map((f) => asString(f, 'env_file[]'));
}

/** O bloco `environment:` de um serviço, interpolado com o `.env.infra`. */
export function environmentOf(
  compose: Record<string, ComposeNode>,
  service: string,
  infra: Readonly<Record<string, string>>,
): Record<string, string> {
  const raw = asMap(composeServices(compose)[service], `services.${service}`).environment;
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asMap(raw, `services.${service}.environment`))) {
    out[key] = interpolate(asString(value, `services.${service}.environment.${key}`), infra);
  }
  return out;
}

/**
 * Todo serviço do compose que consome configuração da Maia, com o loader dono
 * e os `env_file` a ler. LANÇA quando o compose tem um serviço que este módulo
 * não sabe classificar.
 */
export function preflightTargets(compose: Record<string, ComposeNode>): PreflightTarget[] {
  const names = Object.keys(composeServices(compose));
  const desconhecidos = names.filter(
    (n) => !(n in COMPOSE_SERVICE_CONTRACT) && !COMPOSE_SERVICES_WITHOUT_MAIA_CONFIG.includes(n),
  );
  if (desconhecidos.length > 0) {
    throw new Error(
      `compose: serviço(s) sem classificação no preflight: ${desconhecidos.join(', ')}. ` +
        'Declare o loader dono em COMPOSE_SERVICE_CONTRACT (src/config/compose-env.ts), ou ' +
        'liste-o em COMPOSE_SERVICES_WITHOUT_MAIA_CONFIG se ele roda imagem de terceiro e não ' +
        'lê configuração da Maia. Sem isso o serviço sairia do preflight em silêncio.',
    );
  }
  return names
    .filter((n) => n in COMPOSE_SERVICE_CONTRACT)
    .map((compose_) => ({
      compose: compose_,
      contract: COMPOSE_SERVICE_CONTRACT[compose_]!,
      envFiles: envFileNamesOf(compose, compose_),
    }));
}

/**
 * O ambiente que o container REALMENTE recebe: `env_file` na ordem declarada,
 * `environment:` por cima. É a precedência do Compose, e é a razão de
 * `MAIA_ENV` não precisar aparecer em `env_file` nenhum.
 *
 * `envFileContents` é o CONTEÚDO de cada `env_file`, na mesma ordem de
 * `envFileNamesOf`. Parseado por `parseEnvFile` — o mesmo `dotenv.parse` que o
 * boot usa —, para que preflight e boot não possam discordar sobre o que uma
 * linha significa.
 */
export function effectiveServiceEnv(
  compose: Record<string, ComposeNode>,
  service: string,
  opts: {
    readonly envFileContents: readonly string[];
    readonly infra: Readonly<Record<string, string>>;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const content of opts.envFileContents) {
    Object.assign(env, parseEnvFile(content));
  }
  Object.assign(env, environmentOf(compose, service, opts.infra));
  return env;
}

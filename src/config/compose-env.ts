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

/**
 * Erro de parse do compose.
 *
 * A mensagem carrega ARQUIVO, LINHA e MOTIVO — e NUNCA o conteúdo da linha.
 * Ela era `${file}:${lineNo}: ${why}\n  ${line}`, e o `${line}` é um vazamento:
 * `cmdPreflight` imprime esta mensagem em stderr (e em `--json`), então um
 * compose passado por `--compose` com um segredo literal numa linha malformada
 * despejava o valor no terminal e no log do CI — contradizendo a garantia do
 * cabeçalho de `scripts/config.ts` de nunca imprimir secret values (review de
 * PR #595, achado [Alta] nº 2). Arquivo + linha localizam o problema tão bem
 * quanto o eco, e um `sed -n '<n>p'` do próprio operador mostra o resto.
 */
export class ComposeParseError extends Error {
  /** Rótulo do compose (normalmente o caminho lido). */
  readonly file: string;
  /** Linha 1-based. */
  readonly lineNo: number;

  constructor(file: string, lineNo: number, why: string) {
    super(`${file}:${lineNo}: ${why}`);
    this.name = 'ComposeParseError';
    this.file = file;
    this.lineNo = lineNo;
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
        throw new ComposeParseError(file, line.no, 'unexpected indentation inside a sequence');
      }
      if (!line.text.startsWith('- ') && line.text !== '-') {
        break;
      }
      const item = line.text === '-' ? '' : line.text.slice(2);
      const inline = KEY_LINE.exec(item);
      if (inline && (inline[2] === undefined || inline[2] === '')) {
        // `- key:` opening a nested map inside a sequence: not used by these
        // files. Refuse rather than guess.
        throw new ComposeParseError(file, line.no, 'nested map inside a sequence is not supported');
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
      throw new ComposeParseError(file, line.no, 'unexpected indentation inside a map');
    }
    const m = KEY_LINE.exec(line.text);
    if (!m) {
      throw new ComposeParseError(file, line.no, 'line is neither a `key: value` nor a `- item`');
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
        throw new ComposeParseError(label, idx + 1, 'tab in indentation');
      }
      lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
    });
  const [node, consumed] = parseBlock(lines, 0, 0, label);
  if (consumed !== lines.length) {
    const stray = lines[consumed]!;
    throw new ComposeParseError(label, stray.no, 'trailing content the parser did not consume');
  }
  return node as Record<string, ComposeNode>;
}

/**
 * O TIPO de um nó, para mensagem de erro. Nunca o CONTEÚDO.
 *
 * `asMap`/`asString` serializavam o nó com `JSON.stringify` — e o nó de um
 * shape inesperado carrega valores do compose, que `cmdPreflight` imprime sem
 * redaction (review de PR #595, achado [Alta] nº 2). O caminho estrutural
 * (`services.app.environment.DATABASE_URL`) já diz onde olhar; o valor não
 * acrescenta diagnóstico e é a única parte que pode ser segredo.
 */
function nodeKind(node: ComposeNode | undefined): string {
  if (node === undefined) return 'nothing';
  if (typeof node === 'string') return 'a scalar';
  if (Array.isArray(node)) return `a sequence of ${node.length} item(s)`;
  return `a map with ${Object.keys(node).length} key(s)`;
}

/** Narrowing helpers — a wrong shape is an error, not a silent `undefined`. */
export function asMap(node: ComposeNode | undefined, what: string): Record<string, ComposeNode> {
  if (node === undefined || typeof node === 'string' || Array.isArray(node)) {
    throw new Error(`expected ${what} to be a map, got ${nodeKind(node)}`);
  }
  return node;
}

export function asString(node: ComposeNode | undefined, what: string): string {
  if (typeof node !== 'string') {
    throw new Error(`expected ${what} to be a scalar, got ${nodeKind(node)}`);
  }
  return node;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Interpolação — a do Compose, não uma aproximação dela
 * ─────────────────────────────────────────────────────────────────────────
 * A primeira versão entendia três formas (`${VAR}`, `${VAR:-d}`, `${VAR:?m}`)
 * e deixava todo o resto passar VERBATIM. Isso não é conservador: `$$` (o
 * escape do Compose para um `$` literal), `$VAR` sem chaves e `${VAR:+x}` são
 * sintaxe legítima, e um compose que as use produzia aqui um ambiente
 * DIFERENTE do que o `docker compose up` produz — com o preflight verde
 * (review de PR #595, achado [Média]).
 *
 * Agora as formas do `compose-go/template` estão todas implementadas, e o que
 * não for nenhuma delas LANÇA. Um `$` solto é erro no Compose também; falhar
 * aqui é a única alternativa honesta a "resolver diferente e seguir em frente".
 *
 *   $$            → `$` literal
 *   $VAR   ${VAR} → valor, ou '' se ausente
 *   ${VAR:-d}     → d se ausente OU vazia
 *   ${VAR-d}      → d só se AUSENTE (vazia continua vazia)
 *   ${VAR:+r}     → r se presente E não vazia, senão ''
 *   ${VAR+r}      → r se PRESENTE (mesmo vazia), senão ''
 *   ${VAR:?m}     → LANÇA se ausente OU vazia
 *   ${VAR?m}      → LANÇA se AUSENTE
 *
 * `:?`/`?` fail-closed é o mesmo do `docker compose`: o preflight não pode
 * "resolver" uma credencial obrigatória para string vazia e seguir em frente.
 * O default/replacement é ele próprio interpolado (o Compose aninha).
 */
const NAME_HEAD = /[A-Za-z_]/;
const NAME_TAIL = /[A-Za-z0-9_]/;

/** Lê `${...}` a partir do `{`, respeitando aninhamento. Devolve o miolo e o índice após o `}`. */
function readBraced(value: string, open: number, where: string): [string, number] {
  let depth = 0;
  for (let i = open; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return [value.slice(open + 1, i), i + 1];
    }
  }
  throw new Error(`compose interpolation (${where}): unterminated \${...}`);
}

/**
 * Expande uma expressão do Compose. `where` é um CAMINHO ESTRUTURAL
 * (`services.app.environment.DATABASE_URL`, `.env.app:PGHOST`) — nunca o
 * valor, que pode ser segredo.
 */
export function interpolate(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  where = 'compose',
): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }
    const next = value[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next !== undefined && NAME_HEAD.test(next)) {
      let j = i + 1;
      while (j < value.length && NAME_TAIL.test(value[j]!)) j += 1;
      out += env[value.slice(i + 1, j)] ?? '';
      i = j;
      continue;
    }
    if (next === '{') {
      const [inner, after] = readBraced(value, i + 1, where);
      out += expandBraced(inner, env, where);
      i = after;
      continue;
    }
    // `$` seguido de qualquer outra coisa. O Compose recusa o template inteiro;
    // aceitar aqui significaria certificar um ambiente que o `up` não produz.
    throw new Error(
      `compose interpolation (${where}): a lone \`$\` is not valid — write \`$$\` for a literal dollar sign`,
    );
  }
  return out;
}

/** O miolo de um `${...}` já sem as chaves. */
function expandBraced(
  inner: string,
  env: Readonly<Record<string, string | undefined>>,
  where: string,
): string {
  let n = 0;
  while (n < inner.length && (n === 0 ? NAME_HEAD : NAME_TAIL).test(inner[n]!)) n += 1;
  const name = inner.slice(0, n);
  if (name === '') {
    throw new Error(`compose interpolation (${where}): \${…} without a variable name`);
  }
  const rest = inner.slice(n);
  const raw = env[name];

  if (rest === '') return raw ?? '';

  const colon = rest.startsWith(':');
  const op = colon ? rest[1] : rest[0];
  const arg = rest.slice(colon ? 2 : 1);
  // "vazio conta como ausente" é o que o `:` liga.
  const missing = colon ? raw === undefined || raw === '' : raw === undefined;

  switch (op) {
    case '-':
      return missing ? interpolate(arg, env, where) : raw!;
    case '+':
      return missing ? '' : interpolate(arg, env, where);
    case '?':
      if (missing) {
        // A mensagem do operador (`arg`) é texto do compose, não valor de
        // variável — mas o nome basta, e não arrastar o `arg` mantém a
        // mensagem imune a um compose que escreva segredo ali.
        throw new Error(
          `compose interpolation (${where}): ${name} is required (\${${name}${colon ? ':' : ''}?...})`,
        );
      }
      return raw!;
    default:
      throw new Error(
        `compose interpolation (${where}): unsupported operator in \${${name}…} — ` +
          'use :-, -, :+, +, :? or ?',
      );
  }
}

/**
 * Todo nome de variável referenciado por interpolação num texto. Base da
 * checagem de divergência com o shell (ver `preflightTargets` / `runPreflight`).
 */
export function interpolationRefs(text: string, into: Set<string> = new Set()): Set<string> {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '$') {
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === '$') {
      i += 2;
      continue;
    }
    if (next !== undefined && NAME_HEAD.test(next)) {
      let j = i + 1;
      while (j < text.length && NAME_TAIL.test(text[j]!)) j += 1;
      into.add(text.slice(i + 1, j));
      i = j;
      continue;
    }
    if (next === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const inner = text.slice(i + 2, j);
      let n = 0;
      while (n < inner.length && (n === 0 ? NAME_HEAD : NAME_TAIL).test(inner[n]!)) n += 1;
      if (n > 0) into.add(inner.slice(0, n));
      // O default/replacement também é interpolado.
      interpolationRefs(inner.slice(n), into);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return into;
}

// ---------------------------------------------------------------------------
// `env_file` — a semântica do Compose, não a do `dotenv/config`
// ---------------------------------------------------------------------------

/**
 * Classificação de aspas por chave. Só isso: o VALOR continua vindo de
 * `parseEnvFile` (`dotenv.parse`), para que preflight e boot não possam
 * discordar sobre o que uma linha significa. O que este regex acrescenta é a
 * única informação que o `dotenv.parse` apaga e da qual o Compose depende —
 * se o valor estava entre aspas SIMPLES.
 *
 * Deriva do regex do próprio `dotenv` (v16), reduzido ao que interessa aqui.
 */
const ENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)?\s*(?:#.*)?(?:$|$)/gm;

/** Chaves cujo valor bruto estava entre aspas SIMPLES (a última ocorrência vence, como no dotenv). */
function singleQuotedKeys(text: string): Set<string> {
  const out = new Set<string>();
  const src = text.replace(/\r\n?/g, '\n');
  ENV_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_LINE.exec(src)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    const raw = (m[2] ?? '').trim();
    if (raw.startsWith("'")) out.add(key);
    else out.delete(key);
  }
  return out;
}

/**
 * Um `env_file` do Compose, com a semântica do Compose.
 *
 * O módulo lia `env_file` com `dotenv.parse` e mais nada. Está errado, e o
 * review de PR #595 (achado [Média]) nomeia o erro: o `docker compose`
 * INTERPOLA `${VAR}` dentro de um `env_file`
 * (`compose-go/dotenv.ParseWithLookup`, chamado por `GetEnvFromFile`), o
 * `dotenv.parse` do Node não interpola nada, e um `.env.app` com
 * `NEXTAUTH_URL=https://${DOMAIN}/admin` produzia aqui o literal `${DOMAIN}` e
 * lá o valor expandido. Dois ambientes, um verde.
 *
 * A cadeia de resolução é a do `compose-go`, nesta ordem:
 *   1. o ambiente do projeto (`--env-file`, aqui o `.env.infra`, mais o shell
 *      quando o operador o exporta — ver `runPreflight`);
 *   2. as chaves JÁ definidas por este e pelos `env_file` anteriores.
 *
 * Valor entre ASPAS SIMPLES não é interpolado (o Compose também não interpola),
 * e é por isso que `singleQuotedKeys` existe.
 *
 * `label` entra nas mensagens de erro como CAMINHO (`.env.app:PGHOST`), nunca
 * o valor.
 */
export function parseComposeEnvFile(
  text: string,
  label: string,
  opts: {
    /** Ambiente do PROJETO (`--env-file` + shell). Vence tudo, como no compose-go. */
    readonly project: Readonly<Record<string, string | undefined>>;
    /** Chaves já definidas pelos `env_file` ANTERIORES da mesma lista. */
    readonly previous?: Readonly<Record<string, string>>;
  },
): Record<string, string> {
  const literal = singleQuotedKeys(text);
  const parsed = parseEnvFile(text);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (literal.has(key)) {
      out[key] = value;
      continue;
    }
    // Precedência do `GetEnvFromFile`: projeto/shell primeiro, depois o `envMap`
    // acumulado (arquivos anteriores, e as chaves já lidas DESTE arquivo).
    out[key] = interpolate(
      value,
      { ...opts.previous, ...out, ...opts.project },
      `${label}:${key}`,
    );
  }
  return out;
}

/**
 * Todo nome de variável que o Compose resolve por interpolação DENTRO de um
 * `env_file` — a OUTRA metade do conjunto que o shell do operador pode
 * sequestrar (review de PR #595, rodada 2, achado [Média]).
 *
 * `composeInterpolationRefs` anda pelo YAML e só pelo YAML. Mas o ambiente
 * efetivo também interpola `${VAR}` dentro de cada `env_file`, e ali a
 * precedência é a mesma: em `parseComposeEnvFile` o mapa do PROJETO (o
 * `--env-file` mais o shell) vence as chaves do próprio arquivo. Um
 * `.env.admin` com `NEXTAUTH_URL=https://${DOMAIN}` e um `DOMAIN` exportado
 * diferente do `.env.infra` produzia um `up` com OUTRA URL — e como `DOMAIN`
 * não aparece no YAML, a checagem de divergência não a via. Verde falso, mesma
 * classe do achado que ela existia para fechar.
 *
 * VARRE OS VALORES PARSEADOS, não o texto cru, e por duas razões que são a
 * mesma: o `dotenv.parse` já descartou comentários (`# ${MAIA_ENV:?…}` aparece
 * literalmente nos dois `.prod.example` e NÃO é interpolado por ninguém), e
 * `singleQuotedKeys` diz quais valores o Compose trata como literais. Varrer o
 * texto cru daria o alarme falso permanente que `composeInterpolationRefs`
 * já evita para o `$HOME` do comentário do `tmpfs`.
 *
 * Coleta NOMES. Nenhum valor é lido, guardado nem devolvido, e nada aqui
 * interpola de fato — logo um `${VAR:?}` sem valor não lança por este caminho.
 */
export function composeEnvFileInterpolationRefs(
  text: string,
  into: Set<string> = new Set(),
): Set<string> {
  const literal = singleQuotedKeys(text);
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (literal.has(key)) continue;
    interpolationRefs(value, into);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Serviço do Compose → serviço do contrato
// ---------------------------------------------------------------------------

/**
 * TODOS os validadores de contrato que o processo de cada container roda de
 * fato — não "o loader nominal dele".
 *
 * A tabela era `Record<string, MaiaService>` e mapeava `admin-ui → 'admin-ui'`.
 * Isso descrevia o loader que o container DEVERIA usar, não o que ele usa: o
 * console importa `src/config/env.ts` transitivamente
 * (`src/admin-ui/trpc/tool-enablement.ts` e
 * `src/admin-ui/trpc/routers/tools-catalog.ts` importam `@/config/env.js`
 * diretamente; `@/db/client.ts` também), e aquele singleton chama
 * `validateConfig({ service: 'runtime' })`. Ou seja: o container do console
 * valida o subset `runtime` no boot, e o preflight validava OUTRO contrato.
 *
 * A consequência é o falso verde que o review de PR #595 nomeia (achado [Alta]
 * nº 1): tirar do `.env.admin` uma chave EXCLUSIVA de `runtime` deixava
 * preflight e testes verdes e derrubava o container no boot. Agora cada serviço
 * declara a LISTA de subsets efetivamente avaliados, e o preflight roda todos.
 *
 * Ordem importa só para o relatório: o subset mais amplo primeiro.
 */
export const COMPOSE_SERVICE_CONTRACT: Readonly<Record<string, readonly MaiaService[]>> = {
  migrate: ['migrator'],
  app: ['runtime'],
  // `runtime` porque o boot do Next.js importa `@/config/env.js`; `admin-ui`
  // porque `npm run config:preflight` é, hoje, o ÚNICO lugar que avalia aquele
  // subset (as `OIDC_*` são `services: ['admin-ui']` e ficam fora do
  // `runtime`). Fazer o boot chamar `loadAdminConfig()` é a issue #596 —
  // enquanto ela não landar, o preflight é o gate, e é por isso que ele valida
  // os DOIS em vez de escolher um.
  'admin-ui': ['runtime', 'admin-ui'],
};

/**
 * Serviços cujo BOOT aplica gates PRÓPRIOS, mais estritos que o contrato.
 *
 * Hoje só o console: `resolveSecret()` e `oidcProviderEnabled()` em
 * `src/admin-ui/lib/auth-gating.ts` exigem `NEXTAUTH_SECRET` >= 32 e
 * `OIDC_CLIENT_SECRET` >= 16 e recusam placeholders, onde o contrato pede
 * `min(8)` e só presença. Um `.env.admin` que passe no contrato e falhe no gate
 * é o segundo falso verde do achado [Alta] nº 1, e é por isso que ele é
 * DECLARADO aqui em vez de ficar implícito num `if (service === 'admin-ui')`
 * dentro do preflight.
 */
export const COMPOSE_SERVICES_WITH_ADMIN_BOOT_GATES: readonly string[] = ['admin-ui'];

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
  /**
   * TODOS os subsets do contrato que o processo deste container avalia no boot
   * (`src/config/contract.ts`). Lista, não escalar — ver
   * `COMPOSE_SERVICE_CONTRACT`.
   */
  readonly contracts: readonly MaiaService[];
  /** `env_file:` declarados, na ordem, exatamente como escritos no compose. */
  readonly envFiles: readonly string[];
  /** O boot deste container aplica os gates de `src/config/admin-boot-gates.ts`. */
  readonly adminBootGates: boolean;
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

/**
 * Todo `env_file` declarado no compose, sem repetição e na ordem em que
 * aparecem — de TODOS os serviços, não só dos que o preflight valida.
 *
 * A escolha de escopo é deliberada e é a mesma de `composeInterpolationRefs`,
 * que anda pelo documento INTEIRO: `shellDivergence` é um veredito sobre o
 * PROJETO, não sobre um serviço. O que ele afirma é "o `docker compose up`
 * neste terminal produziria outro ambiente que o certificado aqui", e o `up`
 * sobe todos os serviços. Restringir aos alvos do preflight deixaria de fora
 * justamente os serviços que rodam imagem de terceiro
 * (`COMPOSE_SERVICES_WITHOUT_MAIA_CONFIG`): um `POSTGRES_PASSWORD` sequestrado
 * no `env_file` do banco não reprova contrato nenhum e ainda assim faz o `app`
 * falhar ao conectar — que é exatamente o bring-up quebrado que este gate
 * existe para evitar.
 */
export function composeEnvFileNames(compose: Record<string, ComposeNode>): string[] {
  const seen = new Set<string>();
  for (const service of Object.keys(composeServices(compose))) {
    for (const name of envFileNamesOf(compose, service)) seen.add(name);
  }
  return [...seen];
}

/** O bloco `environment:` de um serviço, interpolado com o ambiente do projeto. */
export function environmentOf(
  compose: Record<string, ComposeNode>,
  service: string,
  infra: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const raw = asMap(composeServices(compose)[service], `services.${service}`).environment;
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asMap(raw, `services.${service}.environment`))) {
    const where = `services.${service}.environment.${key}`;
    out[key] = interpolate(asString(value, where), infra, where);
  }
  return out;
}

/**
 * Todo nome de variável que o compose resolve por interpolação. É o conjunto
 * que o shell do operador pode SEQUESTRAR: o `docker compose` dá precedência
 * ao ambiente exportado sobre o `--env-file`, então uma `MAIA_ENV` exportada
 * vence o `.env.infra` e o `up` produz um ambiente diferente do certificado
 * aqui (review de PR #595, achado [Média]). `runPreflight` usa isto para
 * REPROVAR a divergência em vez de fingir que ela não existe.
 *
 * Anda pela ÁRVORE PARSEADA, e não pelo texto: o `docker compose` interpola
 * valores de YAML, não comentários. `compose.prod.yml` menciona `$HOME` num
 * comentário explicando um `tmpfs`, e uma varredura textual reportava o `HOME`
 * do shell como divergência em toda execução — um alarme falso permanente é um
 * alarme que o operador aprende a ignorar.
 *
 * É METADE do conjunto: o Compose também interpola dentro de cada `env_file`, e
 * essas referências saem de `composeEnvFileInterpolationRefs`. `runPreflight`
 * usa a UNIÃO das duas — sozinha, esta função deixava passar uma variável
 * referenciada só no `env_file` (review de PR #595, rodada 2).
 */
export function composeInterpolationRefs(node: ComposeNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: ComposeNode): void => {
    if (typeof n === 'string') {
      interpolationRefs(n, out);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    Object.values(n).forEach(visit);
  };
  visit(node);
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
      contracts: COMPOSE_SERVICE_CONTRACT[compose_]!,
      envFiles: envFileNamesOf(compose, compose_),
      adminBootGates: COMPOSE_SERVICES_WITH_ADMIN_BOOT_GATES.includes(compose_),
    }));
}

/**
 * O ambiente que o container REALMENTE recebe: `env_file` na ordem declarada,
 * `environment:` por cima. É a precedência do Compose, e é a razão de
 * `MAIA_ENV` não precisar aparecer em `env_file` nenhum.
 *
 * `envFileContents` é o CONTEÚDO de cada `env_file`, na mesma ordem de
 * `envFileNamesOf`; `envFileNames` são os nomes, usados só como CAMINHO nas
 * mensagens de erro. Cada arquivo passa por `parseComposeEnvFile`, que é
 * `dotenv.parse` (o mesmo parser do boot, para que preflight e boot não
 * discordem sobre o que uma linha significa) MAIS a interpolação que o Compose
 * aplica em cima — sem ela, um `${VAR}` dentro de um `env_file` chegava aqui
 * literal e no container expandido.
 *
 * `infra` é o ambiente do PROJETO: o `--env-file` do `docker compose`. Quando o
 * chamador quiser modelar também o shell, é ele quem funde os dois nessa
 * precedência — este módulo não lê `process.env` (ver PUREZA no topo).
 */
export function effectiveServiceEnv(
  compose: Record<string, ComposeNode>,
  service: string,
  opts: {
    readonly envFileContents: readonly string[];
    readonly infra: Readonly<Record<string, string | undefined>>;
    /** Nomes correspondentes, só para o caminho nas mensagens. */
    readonly envFileNames?: readonly string[];
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  opts.envFileContents.forEach((content, idx) => {
    Object.assign(
      env,
      parseComposeEnvFile(content, opts.envFileNames?.[idx] ?? `env_file[${idx}]`, {
        project: opts.infra,
        previous: { ...env },
      }),
    );
  });
  Object.assign(env, environmentOf(compose, service, opts.infra));
  return env;
}

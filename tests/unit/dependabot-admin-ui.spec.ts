/**
 * Item 9 do dono — o Dependabot precisa cobrir o `src/admin-ui`.
 *
 * O ponto cego
 * ------------
 * O admin-ui é um projeto npm separado, com `package.json` e lockfile
 * próprios. `.github/dependabot.yml` declarava um único bloco npm ancorado em
 * `"/"`, e um bloco npm só enxerga o manifesto do diretório que ele aponta —
 * então NENHUMA atualização do admin-ui virava PR automática. É o mesmo ponto
 * cego que deixou um `critical` do Next passar despercebido no `npm audit`
 * (#521) e que o ledger de exceções (#526) depois tornou visível.
 *
 * Visível não é resolvido: com o ledger, o próximo advisory do admin-ui
 * REPROVA o CI. Sem Dependabot ali, esse CI reprovado fica esperando alguém
 * abrir a correção à mão.
 *
 * O que este spec tranca
 * ----------------------
 * Duas coisas, e a segunda é a que costuma apodrecer sem ninguém notar:
 *   1. existe um bloco npm para `/src/admin-ui`;
 *   2. ele ESPELHA o bloco da raiz — cadência, limite de PRs abertas e
 *      agrupamentos. Um segundo bloco que diverge em silêncio é uma política
 *      de atualização paralela que ninguém decidiu ter.
 *
 * WHY NOT A YAML LIBRARY. `yaml` só existe aqui como dependência TRANSITIVA, e
 * o repo já recusou promovê-la para um guard exatamente desta forma — ver a
 * nota no topo de `tests/unit/migrations/_compose-yaml.ts`. Promovê-la
 * significaria mexer no `package-lock.json` por causa de um teste de 40 linhas.
 *
 * WHY NOT `_compose-yaml.ts`. Aquele parser recusa `nested map inside a
 * sequence` de propósito (os arquivos de Compose não usam), e é exatamente a
 * forma de TODO item de `updates:` aqui. Estender um helper de outro concern
 * para caber neste seria pior do que o leitor mínimo abaixo.
 *
 * WHY NOT REGEX. A propriedade sob teste é aninhamento
 * (`updates[].groups.eslint.patterns`), e um regex sobre arquivo plano não sabe
 * a qual bloco um `interval:` pertence — que é justamente o erro que este guard
 * existe para pegar.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = '.github/dependabot.yml';

type Node = string | Node[] | { [key: string]: Node };

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

class YamlSubsetError extends Error {
  constructor(lineNo: number, line: string, why: string) {
    super(`${CONFIG_PATH}:${lineNo}: ${why}\n  ${line}`);
    this.name = 'YamlSubsetError';
  }
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

/** Sequência de fluxo — `["eslint*", "@typescript-eslint/*"]`. */
function flowSequence(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => scalar(part.trim()));
}

function scalar(raw: string): string {
  const t = raw.trim();
  const quoted =
    t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
  return quoted ? t.slice(1, -1) : t;
}

function value(raw: string): Node {
  const t = raw.trim();
  return t.startsWith('[') && t.endsWith(']') ? flowSequence(t) : scalar(t);
}

/**
 * Parser do subconjunto que este arquivo usa: indentação de 2 espaços, mapas
 * de bloco, sequências de bloco cujos itens são mapas, escalares e sequências
 * de fluxo. ESTRITO por decisão: qualquer linha que ele não entenda por
 * completo lança. Um parser que pulasse em silêncio o que não entende
 * transformaria um `dependabot.yml` mal lido em teste verde — o único modo de
 * falha que um guard destes não pode ter.
 */
function parseBlock(lines: Line[], start: number, indent: number): [Node, number] {
  const first = lines[start];
  if (!first) return ['', start];

  if (first.text.startsWith('- ')) {
    const seq: Node[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.indent < indent || !line.text.startsWith('- ')) break;
      if (line.indent > indent) {
        throw new YamlSubsetError(line.no, line.text, 'indentação inesperada dentro de sequência');
      }
      const head = line.text.slice(2);
      const m = KEY_LINE.exec(head);
      if (!m) {
        // Item escalar (`- foo`).
        seq.push(scalar(head));
        i += 1;
        continue;
      }
      // Item que abre um mapa. As linhas seguintes do MESMO item vêm indentadas
      // em `indent + 2`; reescrevemos o cabeçalho nesse nível e delegamos.
      const itemLines: Line[] = [{ indent: indent + 2, text: head, no: line.no }];
      i += 1;
      while (i < lines.length && lines[i]!.indent >= indent + 2) {
        itemLines.push(lines[i]!);
        i += 1;
      }
      const [node, consumed] = parseBlock(itemLines, 0, indent + 2);
      if (consumed !== itemLines.length) {
        const stray = itemLines[consumed]!;
        throw new YamlSubsetError(stray.no, stray.text, 'conteúdo não consumido dentro do item');
      }
      seq.push(node);
    }
    return [seq, i];
  }

  const map: Record<string, Node> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlSubsetError(line.no, line.text, 'indentação inesperada dentro de mapa');
    }
    const m = KEY_LINE.exec(line.text);
    if (!m) throw new YamlSubsetError(line.no, line.text, 'linha não é `key: value` nem `- item`');
    const key = m[1]!;
    const raw = m[2];
    if (raw === undefined || raw.trim() === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        map[key] = '';
        i += 1;
        continue;
      }
      const [child, consumed] = parseBlock(lines, i + 1, next.indent);
      map[key] = child;
      i = consumed;
      continue;
    }
    map[key] = value(raw);
    i += 1;
  }
  return [map, i];
}

function parseConfig(path: string): Record<string, Node> {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines: Line[] = [];
  text.split('\n').forEach((raw, idx) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    if (raw.includes('\t')) throw new YamlSubsetError(idx + 1, raw, 'tab na indentação');
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
  });
  const [node, consumed] = parseBlock(lines, 0, 0);
  if (consumed !== lines.length) {
    const stray = lines[consumed]!;
    throw new YamlSubsetError(stray.no, stray.text, 'conteúdo final não consumido');
  }
  return node as Record<string, Node>;
}

const config = parseConfig(join(process.cwd(), CONFIG_PATH));
const updates = config.updates as Record<string, Node>[];

function npmBlock(directory: string): Record<string, Node> | undefined {
  return updates.find((u) => u['package-ecosystem'] === 'npm' && u.directory === directory);
}

describe('dependabot cobre os DOIS projetos npm (item 9)', () => {
  it('o arquivo declara a versão 2 e uma lista de updates', () => {
    expect(config.version).toBe('2');
    expect(Array.isArray(updates)).toBe(true);
  });

  // Âncora anti-vacuidade. Os testes seguintes comparam o bloco do admin-ui
  // COM o da raiz; se o parser devolvesse `undefined` dos dois lados, aquelas
  // igualdades passariam sem ler nada. Aqui o conteúdo da raiz é afirmado
  // literalmente, então um parser quebrado fica vermelho aqui primeiro.
  it('o leitor enxerga mesmo o bloco da raiz (âncora do parser)', () => {
    const raiz = npmBlock('/');
    expect(raiz).toBeDefined();
    expect(raiz!.schedule).toEqual({ interval: 'weekly' });
    expect(raiz!['open-pull-requests-limit']).toBe('5');
    expect(raiz!.groups).toEqual({
      types: { patterns: ['@types/*'] },
      eslint: { patterns: ['eslint*', '@typescript-eslint/*'] },
    });
  });

  it('há um bloco npm para /src/admin-ui', () => {
    const diretorios = updates
      .filter((u) => u['package-ecosystem'] === 'npm')
      .map((u) => u.directory);
    expect(
      diretorios,
      'o admin-ui tem lockfile próprio; sem bloco dele, o primeiro advisory novo trava o CI ' +
        '(ledger #526) sem nenhuma PR automática para corrigir',
    ).toContain('/src/admin-ui');
  });

  it('o bloco do admin-ui espelha a política do bloco da raiz', () => {
    const raiz = npmBlock('/');
    const admin = npmBlock('/src/admin-ui');
    expect(raiz, 'bloco npm da raiz sumiu').toBeDefined();
    expect(admin, 'bloco npm do admin-ui ausente').toBeDefined();

    expect(admin!.schedule, 'cadência divergente da raiz').toEqual(raiz!.schedule);
    expect(
      admin!['open-pull-requests-limit'],
      'limite de PRs abertas divergente da raiz',
    ).toEqual(raiz!['open-pull-requests-limit']);
    expect(admin!.groups, 'agrupamentos divergentes da raiz').toEqual(raiz!.groups);
  });
});

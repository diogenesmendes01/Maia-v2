/**
 * PR #766 — a supressão do falso positivo de `request_key` sintético no gitleaks
 * é ESTREITA e está na forma que a versão do CI realmente lê.
 *
 * ─── O que reprovou ────────────────────────────────────────────────────────
 *
 * O job `gitleaks (secret scan)` achou 12 ocorrências da regra
 * `generic-api-key`, todas o MESMO UUID escrito à mão, usado como chave de
 * idempotência do run no contrato `maia.hermes.worker.v1` — não credencial.
 * (O valor é montado por partes abaixo, e não escrito inteiro neste arquivo, para
 * que o próprio spec não vire um achado do gitleaks fora da allowlist.)
 * A regra dispara pelo nome com `key`, pela forma de token e pela entropia
 * (3.898, acima do corte de 3.5).
 *
 * ─── Por que `[[rules]]` e não `[[allowlists]]` ────────────────────────────
 *
 * O `gitleaks-action@v3` instala o gitleaks 8.24.3, cujo `ViperConfig` só lê
 * `[allowlist]` (singular, sem `condition`) no topo; `[[allowlists]]` de topo só
 * existe a partir da 8.25.0 e, antes disso, é IGNORADO em silêncio. Já as
 * allowlists dentro de uma regra são fundidas à regra padrão de mesmo `id`
 * quando a config estende a padrão (`useDefault = true`), e a validação da regra
 * roda depois da fusão. Por isso a supressão fica em
 * `[[rules]] id = "generic-api-key"` + `[[rules.allowlists]]` com
 * `condition = "AND"`: casa só quando o CAMINHO é um dos arquivos de teste
 * listados E o segredo extraído é exatamente o UUID sintético. Um fingerprint
 * no `.gitleaksignore` não bastaria: não sobrevive ao squash do merge.
 *
 * O gitleaks não roda aqui (não há binário nem parser TOML no projeto). Este
 * spec prende a FORMA e a ESTREITEZA da config; quem prova o efeito é o job.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const RAIZ = resolve(__dirname, '../../..');
const VALOR = ['8a1e2c3d', '4b5a', '4c7d', '8e9f', '0a1b2c3d4e5f'].join('-');
const config = readFileSync(join(RAIZ, '.gitleaks.toml'), 'utf8');

type Allowlist = { condition: string | null; paths: RegExp[]; regexes: RegExp[] };

/** Literais `'''…'''` de um array TOML `chave = [ … ]` dentro de um bloco. */
function literais(bloco: string, chave: string): string[] {
  const m = bloco.match(new RegExp(`^${chave}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'm'));
  if (!m) return [];
  return [...m[1]!.matchAll(/'''([\s\S]*?)'''/g)].map((x) => x[1]!);
}

/** As allowlists de REGRA sob `[[rules]] id = "generic-api-key"`. */
function allowlistsDaRegraGenericApiKey(): Allowlist[] {
  // Blocos de tabela TOML: cada cabeçalho `[...]`/`[[...]]` abre um bloco.
  const blocos = config.split(/^(?=\[)/m);
  const out: Allowlist[] = [];
  let dentroDaRegra = false;
  for (const b of blocos) {
    const cabecalho = b.split('\n', 1)[0]!.trim();
    if (cabecalho === '[[rules]]') {
      dentroDaRegra = /^id\s*=\s*"generic-api-key"\s*$/m.test(b);
      continue;
    }
    if (cabecalho === '[[rules.allowlists]]') {
      if (!dentroDaRegra) continue;
      const cond = b.match(/^condition\s*=\s*"([^"]+)"\s*$/m);
      out.push({
        condition: cond ? cond[1]! : null,
        paths: literais(b, 'paths').map((p) => new RegExp(p)),
        regexes: literais(b, 'regexes').map((r) => new RegExp(r)),
      });
      continue;
    }
    dentroDaRegra = false;
  }
  return out;
}

const suprime = (path: string, segredo: string): boolean =>
  allowlistsDaRegraGenericApiKey().some(
    (a) =>
      a.condition === 'AND' &&
      a.paths.some((p) => p.test(path)) &&
      a.regexes.some((r) => r.test(segredo)),
  );

function ocorrenciasNosTestes(): string[] {
  const achados: string[] = [];
  const ignorar = new Set(['node_modules', '__pycache__', '.pytest_cache', '.venv']);
  const varrer = (dir: string): void => {
    for (const nome of readdirSync(dir)) {
      if (ignorar.has(nome)) continue;
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) {
        varrer(caminho);
        continue;
      }
      const rel = relative(RAIZ, caminho).split('\\').join('/');
      const texto = readFileSync(caminho, 'utf8');
      for (let i = texto.indexOf(VALOR); i !== -1; i = texto.indexOf(VALOR, i + 1)) {
        achados.push(rel);
      }
    }
  };
  varrer(join(RAIZ, 'tests'));
  varrer(join(RAIZ, 'services/hermes_worker/tests'));
  return achados;
}

describe('gitleaks — request_key sintético suprimido de forma estreita e legível pela 8.24.3', () => {
  it('a varredura não é vácua: o UUID sintético aparece nos arquivos que o CI acusou', () => {
    const achados = ocorrenciasNosTestes();
    // 15 hoje: 10 na fixture, 3 specs TS e 3 testes Python (os Python só
    // aparecem numa varredura do squash, não na da PR).
    expect(achados.length).toBeGreaterThanOrEqual(15);
    expect(new Set(achados)).toContain('tests/fixtures/hermes-wire/frames.json');
  });

  it('toda ocorrência do UUID sintético é suprimida pela allowlist da regra, com AND', () => {
    const naoCobertas = ocorrenciasNosTestes().filter((path) => !suprime(path, VALOR));
    expect(naoCobertas).toEqual([]);
  });

  it('a supressão NÃO depende de `[[allowlists]]` de topo, que a 8.24.3 ignora', () => {
    // O que importa é que exista a allowlist DE REGRA; blocos de topo antigos
    // (#326, #515) não são tocados por esta correção.
    expect(allowlistsDaRegraGenericApiKey().length).toBeGreaterThanOrEqual(1);
  });

  it('continua ESTREITA: outros segredos e outros caminhos seguem sendo acusados (controles)', () => {
    // Token aleatório na própria fixture.
    expect(suprime('tests/fixtures/hermes-wire/frames.json', 'Zx9Qw3Lp7Rt2Yv6Nm1Kb8Hc4Jd5Gf0Se')).toBe(false);
    // O valor com sufixo.
    expect(suprime('tests/fixtures/hermes-wire/frames.json', `${VALOR}x`)).toBe(false);
    // O MESMO valor em código de produção.
    expect(suprime('src/integrations/hermes/protocol.ts', VALOR)).toBe(false);
    // Um arquivo vizinho que só compartilha o prefixo do nome.
    expect(suprime('tests/fixtures/hermes-wire/frames.json.bak', VALOR)).toBe(false);
  });
});

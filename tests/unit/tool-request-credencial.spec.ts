/**
 * #638 (fatia C da épica #471) — "credencial do GitHub não vaza para o payload
 * da proposta nem para log", afirmado onde a garantia realmente mora.
 *
 * A garantia NÃO é "tomamos cuidado ao escrever log". É que o token não existe
 * no processo que serve o botão "aceitar", e que o único módulo que o usa
 * nunca o coloca em texto persistido. Este arquivo trava as duas metades:
 *
 *   1. o CONTRATO de configuração declara o token como `secret` e fora do
 *      subset do `admin-ui`;
 *   2. o CAMINHO DO CONSOLE — seguido pelo grafo de imports a partir do router
 *      real — não alcança o cliente HTTP nem lê a variável do token.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { arquivosAlcancados } from '../helpers/grafo-de-imports.js';

const contrato = moduloDeProducao(() => import('@/config/contract.js'));
const servicos = moduloDeProducao(() => import('@/config/services.js'));
const redact = moduloDeProducao(() => import('@/config/redact.js'));

const TOKEN = 'MAIA_TOOL_REQUEST_GITHUB_TOKEN';
const REPO = 'MAIA_TOOL_REQUEST_ISSUE_REPO';

describe('#638 — o contrato separa o DESTINO da CREDENCIAL', () => {
  it('o token é declarado `secret`, logo é redigido em toda saída de config', () => {
    const spec = contrato().findSpec(TOKEN);
    expect(spec, 'a variável do token sumiu do contrato').toBeDefined();
    expect(spec!.secret).toBe(true);
    expect(redact().isSecretVar(TOKEN)).toBe(true);
    expect(redact().redactValue(TOKEN, 'valor-real')).toBe(redact().REDACTED);
  });

  it('o token NÃO está no subset do `admin-ui` — o console não pode lê-lo', () => {
    const spec = contrato().findSpec(TOKEN)!;
    expect(spec.services).not.toContain('admin-ui');
    expect(spec.services).toContain('runtime');

    // E a mesma coisa dita pelo manifesto GERADO, que é o que o boot usa.
    for (const perfil of ['development', 'staging', 'production'] as const) {
      const nomes = servicos()
        .manifestForService('admin-ui', perfil)
        .variables.map((v: { name: string }) => v.name);
      expect(nomes, `perfil ${perfil}`).not.toContain(TOKEN);
      // O DESTINO, sim: o dono precisa ver para onde a issue vai antes de
      // aceitar. Ele não é credencial.
      expect(nomes, `perfil ${perfil}`).toContain(REPO);
    }
  });

  it('`scrubSecrets` apaga o valor do token de um texto arbitrário', () => {
    const texto = 'falhou com Bearer valor-secreto-longo no header';
    const limpo = redact().scrubSecrets(texto, { [TOKEN]: 'valor-secreto-longo' });
    expect(limpo).not.toContain('valor-secreto-longo');
    expect(limpo).toContain(redact().REDACTED);
  });
});

describe('#638 — o CAMINHO DO CONSOLE não alcança a credencial', () => {
  const raizDoSrc = fileURLToPath(new URL('../../src/', import.meta.url));
  const doSrc = (rel: string) => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));

  /**
   * A entrada é o router REAL da triagem. As barreiras são as mesmas do
   * guardrail (`db/`, `lib/`, `config/`, …) EXCETO `admin-ui/`: o objetivo aqui
   * é justamente atravessar o console.
   */
  const alcancados = (): string[] =>
    arquivosAlcancados({
      entradas: [doSrc('admin-ui/trpc/routers/tool-requests.ts')],
      raizDoSrc,
      barreiras: [
        'db/',
        'tools/_registry.ts',
        'tools/packs.ts',
        'tools/grant-math.ts',
        'tools/runtime-filter.ts',
        'lib/',
        // `config/` é BARREIRA pelo mesmo motivo que `db/` é no guardrail: ele
        // DECLARA a variável do token (é onde o nome existe), e varrê-lo
        // acusaria a definição como se fosse uso. A primeira versão deste caso
        // ficou vermelha exatamente assim, via `admin-ui/lib/env.ts` →
        // `@/config/contract.js`.
        'config/',
        'governance/',
        'observability/',
        'shared/',
        'types/',
        'admin-ui/trpc/server.ts',
        'admin-ui/lib/auth.ts',
      ],
    });

  it('o grafo alcança o aceite de verdade (senão a varredura seria vazia)', () => {
    const rel = alcancados().map((f) => f.slice(raizDoSrc.length));
    expect(rel).toContain('admin-ui/trpc/routers/tool-requests.ts');
    expect(rel).toContain('cognition/tool-request/acceptance.ts');
    expect(rel).toContain('cognition/tool-request/issue-body.ts');
    expect(rel).toContain('cognition/tool-request/aggregation.ts');
  });

  it('nenhum arquivo do caminho do console lê o token nem chama o GitHub', () => {
    const achados: string[] = [];
    for (const arquivo of alcancados()) {
      const codigo = readFileSync(arquivo, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (codigo.includes(TOKEN)) achados.push(`${arquivo}: lê a variável do token`);
      if (/api\.github\.com/.test(codigo)) achados.push(`${arquivo}: fala com a API do GitHub`);
      if (/github-issues\.js/.test(codigo)) {
        achados.push(`${arquivo}: importa o cliente de issues`);
      }
    }
    expect(achados).toEqual([]);
  });

  it('a varredura enxergaria um vazamento plantado (autoteste do detector)', () => {
    // Sem isto, `toEqual([])` poderia estar passando por o detector ser cego.
    const plantado = `const t = process.env.${TOKEN}; fetch('https://api.github.com/x');`;
    expect(plantado.includes(TOKEN)).toBe(true);
    expect(/api\.github\.com/.test(plantado)).toBe(true);
  });
});

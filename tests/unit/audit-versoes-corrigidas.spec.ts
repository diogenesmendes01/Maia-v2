/**
 * Piso de versão dos advisories que foram CORRIGIDOS no lockfile.
 *
 * O defeito que originou este guard
 * ---------------------------------
 * O primeiro conjunto tinha dez advisories (`fastify` x2, `qs` x2,
 * `fast-uri` x4, `browserslist` x2). Depois, novos advisories publicados sobre
 * versões que já estavam na `main` exigiram pisos também para `hono`,
 * `nodemailer`, `sharp`, `next`, `vitest` e `@vitest/mocker`. Nenhum deles
 * precisou de exceção: havia versão corrigida alcançável, por bump do lockfile
 * dentro do range existente ou, no pin exato do Next, por bump explícito do
 * manifesto.
 *
 * A terceira rodada (SC25-A, PR #791) fechou o `npm audit` do CI, que reprovava
 * a PR sem que ela tocasse em dependência: `ip-address` (SSRF/trust boundary em
 * classificadores IPv6 e no `isInSubnet`), `undici` (dezenas de advisories de
 * DoS/validação de TLS na linha 7.x) e `brace-expansion` (DoS por recursão)
 * foram bumps de lockfile dentro dos ranges existentes — os dois lockfiles, o
 * do root e o do `src/admin-ui`; `fast-uri` voltou com dois advisories novos
 * sobre a versão que já estava aqui; e `nodemailer` exigiu o único bump de
 * MANIFESTO desta rodada (`^9.0.5` → `^10.0.9`), porque a linha 9.x não tem
 * versão corrigida para os advisories novos.
 *
 * O problema de uma correção que vive SÓ no lockfile é que ela não está
 * declarada em lugar nenhum. Como vários deles estão dentro de um range `^`/`>=`
 * que a versão VULNERÁVEL também satisfazia, qualquer regeneração de lockfile
 * a partir do manifesto (um `rm package-lock.json && npm install` de alguém
 * destravando um conflito, um merge resolvido pelo lado errado) pode
 * reinstalar a versão antiga sem que nada no manifesto mude. O bump não tem
 * piso: ele é uma decisão sem registro.
 *
 * A propriedade sob teste
 * ----------------------
 * **Nenhuma instância destes pacotes, em nenhum dos dois lockfiles, pode estar
 * abaixo da primeira versão corrigida.** Não é "a versão é exatamente X" —
 * isso reprovaria no próximo bump legítimo, que é justamente o que queremos
 * incentivar. É um PISO.
 *
 * Por que isto não é redundante com `scripts/check-audit-exceptions.ts`
 * --------------------------------------------------------------------
 * Aquele guard é a autoridade sobre o risco: ele consulta o registro de
 * advisories AO VIVO e enxerga o que ainda não sabemos. Mas ele depende de
 * rede e do estado do registro — se a advisory for retirada, reclassificada ou
 * o job rodar sem acesso ao registry, ele deixa de falar sobre estes casos.
 * Este spec é offline, determinístico e afirma a decisão que foi tomada
 * aqui, com os GHSA escritos por extenso. Os dois cobrem coisas diferentes: um
 * pergunta "há advisory novo?", o outro "a correção que já fizemos continua no
 * lugar?".
 *
 * Os quatro do `fast-uri` são a prova viva dessa diferença: eles NÃO estavam no
 * relatório quando esta mudança começou e apareceram no registro no meio da
 * própria rodada de validação, sobre uma versão (3.1.5) que já estava na
 * `main`. Quem os viu foi o `check-audit-exceptions`, ao vivo. Quem impede que
 * a correção deles seja desfeita amanhã é este spec.
 *
 * O QUE ELE NÃO COBRE. Ele não sabe se apareceu advisory NOVO nestes pacotes
 * acima do piso — isso é do `check-audit-exceptions`. E ele lê o lockfile, não
 * o `node_modules`: prova o que o `npm ci` vai instalar, não o que está
 * instalado agora na sua árvore.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Um pacote cujo advisory foi fechado por bump de lockfile. */
interface PisoCorrigido {
  /** Projeto npm, como o `check-audit-exceptions` o nomeia. */
  readonly projeto: '.' | 'src/admin-ui';
  readonly pkg: string;
  /** Primeira versão SEM os advisories listados abaixo. */
  readonly piso: string;
  readonly advisories: readonly string[];
  /** Por que o bump coube sem mexer no manifesto. */
  readonly porque: string;
}

const PISOS: readonly PisoCorrigido[] = [
  {
    projeto: '.',
    pkg: 'fastify',
    piso: '5.12.1',
    advisories: ['GHSA-w2qp-rph6-63g4', 'GHSA-3m5p-2c4r-xxw2'],
    porque:
      'dependência direta em `^5.1.0`; 5.12.1 é a primeira sem o bypass de validação de ' +
      'schema por coerção de primitivo na raiz nem o spoofing de X-Forwarded-* sob trustProxy',
  },
  {
    projeto: '.',
    pkg: 'qs',
    piso: '6.16.0',
    advisories: ['GHSA-4mjr-xmp4-gh2g', 'GHSA-x5fp-wj9c-mxmx'],
    porque:
      'transitivo de `express` (via `@modelcontextprotocol/sdk` e `express-rate-limit`); ' +
      '`body-parser` pede `^6.15.2` e `express` pede `^6.14.0`, ambos satisfeitos por 6.16.0',
  },
  {
    projeto: '.',
    pkg: 'fast-uri',
    piso: '3.1.8',
    advisories: [
      'GHSA-5jgf-p345-68v8',
      'GHSA-f65p-4m7j-42xc',
      'GHSA-fph4-wmhf-6fwf',
      'GHSA-jqff-g426-hqxp',
      'GHSA-hrr3-gc8f-f4qj',
    ],
    porque:
      'transitivo do `ajv` (`^3.0.1`), do `fast-json-stringify` (`^3.0.0`) e do ' +
      '`@fastify/ajv-compiler` (`^3.0.0`); os quatro primeiros cobrem `<3.1.6` e ' +
      '`GHSA-hrr3-gc8f-f4qj` (normalização de host por octeto percent-encoded) cobre ' +
      '`<3.1.8`, que passou a ser o piso da linha 3.x. A segunda cópia, aninhada sob ' +
      '`fastify/fast-json-stringify`, foi para 4.2.1: ela fecha os dois advisories da ' +
      'linha 4.x (`GHSA-hrr3-gc8f-f4qj` e `GHSA-jvvf-x445-j334`, ambos corrigidos em ' +
      '4.1.5) e, sendo maior que o piso, satisfaz a mesma asserção sem caso especial',
  },
  {
    projeto: '.',
    pkg: 'hono',
    piso: '4.13.5',
    advisories: ['GHSA-gqvv-2mrq-wpjv', 'GHSA-g6gw-c38x-mqfc', 'GHSA-crvj-82cr-hjcx'],
    porque:
      'transitivo de `@modelcontextprotocol/sdk` e `@hono/node-server`, que aceitam ' +
      '`hono@^4`; 4.13.5 fecha traversal em `toSSG()`, exaustão no `parseBody()` e ' +
      'divergência de interpretação da query após fragmento',
  },
  {
    projeto: '.',
    pkg: 'nodemailer',
    piso: '10.0.9',
    advisories: [
      'GHSA-8m3c-c648-2xjj',
      'GHSA-wmmp-3585-3rmp',
      'GHSA-2x7j-588g-ccc2',
      'GHSA-cc9r-2j5m-2m83',
      'GHSA-6vj9-mwq6-2f5v',
      'GHSA-8vvx-rff5-p5rq',
      'GHSA-g57g-f23g-4646',
      'GHSA-v53p-9fqp-m79j',
    ],
    porque:
      'dependência direta; a rodada anterior parava em 9.1.1 (`^9.0.5`) e esta subiu o ' +
      'MANIFESTO para `^10.0.9`, porque os quatro advisories novos não têm correção na ' +
      'linha 9.x: `GHSA-6vj9-mwq6-2f5v` e `GHSA-8vvx-rff5-p5rq` exigem 10.0.2, ' +
      '`GHSA-v53p-9fqp-m79j` (backtracking quadrático no addressparser) exige 10.0.6 e ' +
      '`GHSA-g57g-f23g-4646` (local-part entre aspas) exige 10.0.9 — o maior dos quatro ' +
      'é o piso. O lockfile ficou em 10.0.13',
  },
  {
    projeto: '.',
    pkg: 'ip-address',
    piso: '10.7.1',
    advisories: [
      'GHSA-rpw4-54j3-4h4q',
      'GHSA-2vr4-cq9g-pvrc',
      'GHSA-j6r3-76f7-8jcv',
      'GHSA-h3mg-xc3c-68pw',
    ],
    porque:
      'transitivo de `@fastify/rate-limit` (`^10.2.0`) e de `express-rate-limit` (via ' +
      '`@modelcontextprotocol/sdk`); os dois primeiros (classificador de link-local em ' +
      '`fe80::/10` e faixa NAT64 local-use) cobrem `<=10.5.0`, e os dois últimos ' +
      '(`isInSubnet`/`isHostInSubnet` comparando famílias diferentes e diagnóstico de ' +
      'parse sem limite de tamanho) cobrem `<=10.7.0` — daí o piso 10.7.1. O lockfile ' +
      'ficou em 10.7.2',
  },
  {
    projeto: '.',
    pkg: 'undici',
    piso: '7.29.1',
    advisories: [
      'GHSA-3wwx-pv8p-q78v',
      'GHSA-pmjh-fq2x-6v4x',
      'GHSA-r53p-7pc4-xj5r',
      'GHSA-rfgv-xxqx-mfg5',
      'GHSA-3xpg-4rpp-hhhm',
      'GHSA-2jfj-6hjv-fm6j',
      'GHSA-2gqq-gqf2-x968',
      'GHSA-w293-vg96-wgc3',
      'GHSA-8436-99hf-9mmv',
      'GHSA-rx4f-c7p8-82vq',
    ],
    porque:
      'dependência de desenvolvimento, transitiva do `testcontainers@12` (que aceita ' +
      '`undici@^7`); os dez advisories cobrem `<7.29.1` — DoS por `permessage-deflate`, ' +
      'por corpo órfão do `RetryHandler`, por subprotocolo WebSocket e por descompressão ' +
      'sem limite, além do bypass de validação de certificado no `BalancedPool` — e o ' +
      'lockfile ficou em 7.30.0',
  },
  {
    projeto: '.',
    pkg: 'brace-expansion',
    piso: '2.1.7',
    advisories: ['GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p'],
    porque:
      'transitivo do `glob` e do `readdir-glob` (`^2.0.1`/`^2.0.2`); os três advisories ' +
      '(expansão quadrática do rewrite e recursão sem controle) cobrem `<2.1.5`..`<2.1.7` ' +
      'na linha 2.x, que é o piso desta entrada. A outra linha presente no lockfile é a ' +
      '5.x, pedida pelo `glob` `^5.0.5`, com piso 5.0.12 — acima deste, então satisfaz a ' +
      'mesma asserção sem caso especial. O lockfile ficou em 5.0.12 (hoisted) e 2.1.7 ' +
      '(aninhado)',
  },
  {
    projeto: '.',
    pkg: 'sharp',
    piso: '0.35.4',
    advisories: ['GHSA-rgj7-g3m4-5g8c'],
    porque:
      'dependência direta em `^0.35.3` e também transitiva do Baileys; 0.35.4 traz a ' +
      'libheif corrigida para processamento de imagens não confiáveis',
  },
  {
    projeto: '.',
    pkg: 'vitest',
    piso: '4.1.11',
    advisories: ['GHSA-82fw-gwwq-j7x9'],
    porque:
      'dependência de desenvolvimento direta em `^4.1.8`; 4.1.11 valida redirects de ' +
      'mocks contra a allowlist de arquivos do servidor Vite',
  },
  {
    projeto: '.',
    pkg: '@vitest/mocker',
    piso: '4.1.11',
    advisories: ['GHSA-82fw-gwwq-j7x9'],
    porque:
      'dependência interna de `vitest`, pinada na mesma versão do runner; o bump do pacote ' +
      'pai para 4.1.11 traz o mocker com a validação de caminho corrigida',
  },
  {
    projeto: 'src/admin-ui',
    pkg: 'brace-expansion',
    piso: '1.1.21',
    advisories: ['GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p'],
    porque:
      'transitivo do `minimatch@3` do console (`^1.1.7`); os três advisories cobrem ' +
      '`<1.1.19`..`<1.1.21` na linha 1.x, que é o piso desta entrada. A outra linha ' +
      'presente no lockfile do console é a 5.x (pedida pelo `minimatch@10` usado por ' +
      '`eslint` e `@typescript-eslint`), com piso 5.0.12 — acima deste, então satisfaz a ' +
      'mesma asserção sem caso especial. O lockfile ficou em 1.1.21 e 5.0.12',
  },
  {
    projeto: 'src/admin-ui',
    pkg: 'browserslist',
    piso: '4.28.7',
    advisories: ['GHSA-73wf-gq98-2v4g', 'GHSA-c83g-rgw3-j3cx'],
    porque:
      'transitivo de `@babel/helper-compilation-targets` e `update-browserslist-db`, que ' +
      'pedem `^4.24.0` e `>= 4.21.0`; 4.28.7 é a primeira acima do range vulnerável `<=4.28.6`',
  },
  {
    projeto: 'src/admin-ui',
    pkg: 'next',
    piso: '16.3.3',
    advisories: ['GHSA-2xp9-vwfh-vxw4', 'GHSA-p293-qw3h-jr36'],
    porque:
      'dependência direta com pin exato; o manifesto foi movido de 16.3.2 para 16.3.3, ' +
      'primeira versão 16.x corrigida para as duas variantes de execução remota de código',
  },
  {
    projeto: 'src/admin-ui',
    pkg: 'sharp',
    piso: '0.35.4',
    advisories: ['GHSA-rgj7-g3m4-5g8c'],
    porque:
      'dependência transitiva do Next fixada por `overrides.sharp` em `^0.35.3`; 0.35.4 ' +
      'traz a libheif corrigida usada pelo pipeline de otimização de imagens do console',
  },
];

/** Compara `a` com `b` numericamente por componente. <0, 0 ou >0. */
function comparaVersao(a: string, b: string): number {
  const na = a.split('.').map(Number);
  const nb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Todas as instâncias de `pkg` no lockfile, com a chave em que aparecem. Um
 * pacote pode estar hoisted na raiz E aninhado sob um dependente que exige
 * outro range — as duas contam, porque as duas são instaladas pelo `npm ci`.
 */
function instancias(lockfile: string, pkg: string): { chave: string; versao: string }[] {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const sufixo = `node_modules/${pkg}`;
  return Object.entries(lock.packages)
    .filter(([chave]) => chave === sufixo || chave.endsWith(`/${sufixo}`))
    .map(([chave, valor]) => ({ chave, versao: valor.version ?? '' }));
}

describe('advisories corrigidos no lockfile não regridem abaixo do piso', () => {
  for (const alvo of PISOS) {
    const lockfile = join(process.cwd(), alvo.projeto, 'package-lock.json');

    it(`${alvo.projeto} → ${alvo.pkg} >= ${alvo.piso} (${alvo.advisories.join(', ')})`, () => {
      const encontradas = instancias(lockfile, alvo.pkg);

      // Sem esta asserção o teste passaria VAZIO no dia em que o pacote saísse
      // da árvore por renomeação de chave — verde sem ter olhado para nada. Se
      // ele sair de verdade (dependente removido), a correção é apagar a linha
      // de PISOS, deliberadamente, e não deixar o guard mudo.
      expect(
        encontradas.length,
        `nenhuma instância de "${alvo.pkg}" em ${lockfile}. Se o pacote saiu mesmo da ` +
          'árvore, remova a entrada correspondente de PISOS neste spec — um guard que não ' +
          'encontra seu alvo passa vazio, e passar vazio é pior do que reprovar.',
      ).toBeGreaterThan(0);

      for (const { chave, versao } of encontradas) {
        expect(
          comparaVersao(versao, alvo.piso) >= 0,
          `${alvo.projeto}/${chave} está em ${versao}, abaixo do piso ${alvo.piso}. ` +
            `Essa versão volta a expor ${alvo.advisories.join(' e ')}. O bump coube sem ` +
            `tocar no manifesto (${alvo.porque}), então uma regeneração de lockfile pode ` +
            'tê-lo desfeito em silêncio: rode `npm update ' +
            alvo.pkg +
            ' --package-lock-only` no projeto ' +
            alvo.projeto +
            ' e confira `npm run audit:exceptions:check`.',
        ).toBe(true);
      }
    });
  }

  it('o ledger de exceções não aceita nenhum destes advisories — eles foram CORRIGIDOS', () => {
    const ledger = JSON.parse(
      readFileSync(join(process.cwd(), 'security/audit-exceptions.json'), 'utf8'),
    ) as { advisory?: string }[];
    const aceitos = new Set(ledger.map((e) => e.advisory));

    for (const ghsa of PISOS.flatMap((p) => p.advisories)) {
      expect(
        aceitos.has(ghsa),
        `${ghsa} aparece em security/audit-exceptions.json. Ele foi CORRIGIDO por bump de ` +
          'lockfile, não aceito como risco residual — uma exceção para ele seria uma ' +
          'justificativa escrita para um problema que não existe mais, e o ' +
          '`check-audit-exceptions` a reprovaria como exceção OBSOLETA. Remova a linha; ' +
          'se a correção precisou ser revertida, remova também o piso deste spec para que ' +
          'a decisão apareça no diff.',
      ).toBe(false);
    }
  });
});

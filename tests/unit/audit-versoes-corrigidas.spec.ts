/**
 * Piso de versão dos advisories que foram CORRIGIDOS no lockfile.
 *
 * O defeito que originou este guard
 * ---------------------------------
 * Dez advisories (`fastify` x2, `qs` x2, `fast-uri` x4, `browserslist` x2)
 * reprovaram o job `npm audit` em toda PR aberta. Nenhum deles precisou de
 * exceção: os quatro pacotes tinham correção DENTRO do range que os manifestos
 * já declaravam, e a correção foi um bump de lockfile — `fastify` 5.8.5 →
 * 5.12.1, `qs` 6.15.2 → 6.16.0 (transitivo do `express`, que vem do
 * `@modelcontextprotocol/sdk`), `fast-uri` 3.1.5 → 3.1.7 (transitivo do `ajv` e
 * do `fast-json-stringify`) e `browserslist` 4.28.2 → 4.28.8 no console.
 *
 * O problema de uma correção que vive SÓ no lockfile é que ela não está
 * declarada em lugar nenhum. Como os três estão dentro de um range `^`/`>=`
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
 * o job rodar sem acesso ao registry, ele deixa de falar sobre estes seis
 * casos. Este spec é offline, determinístico e afirma a decisão que foi tomada
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
    piso: '3.1.6',
    advisories: [
      'GHSA-5jgf-p345-68v8',
      'GHSA-f65p-4m7j-42xc',
      'GHSA-fph4-wmhf-6fwf',
      'GHSA-jqff-g426-hqxp',
    ],
    porque:
      'transitivo do `ajv` (`^3.0.1`), do `fast-json-stringify` (`^3.0.0`) e do ' +
      '`@fastify/ajv-compiler` (`^3.0.0`); os quatro advisories cobrem `<3.1.6` e o ' +
      'lockfile ficou em 3.1.7. Há uma segunda cópia, 4.1.4, aninhada sob ' +
      '`fastify/fast-json-stringify`: ela está fora do range vulnerável e, sendo maior ' +
      'que o piso, satisfaz a mesma asserção sem precisar de caso especial',
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

  it('o ledger de exceções não aceita nenhum destes dez — eles foram CORRIGIDOS', () => {
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

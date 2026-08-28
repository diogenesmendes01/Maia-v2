import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * A FRONTEIRA do bootstrap global (#519), como invariante verificável.
 *
 * O desenho: `openRun()` recusa `global_bootstrap` sempre; quem abre é
 * `startGlobalBootstrapRun()`, e só DEPOIS de resgatar a credencial. O corpo
 * comum vive em `openRunChecked()`, que NÃO é exportado — e é exatamente aí
 * que mora a garantia inteira.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Se alguém exportar `openRunChecked`, a fronteira
 * evapora: passa a existir um caminho para abrir uma run de bootstrap sem
 * credencial nenhuma, e NENHUM teste de comportamento reclama — todos
 * continuam verdes, porque nada do que eles exercitam mudou. É a mesma classe
 * de defeito da #673 (fiação de produção que podia ser arrancada sem ninguém
 * perceber), e a mesma da #605 (dependência sem importador): o problema não é
 * o código estar errado, é o código certo poder desaparecer em silêncio.
 *
 * Guard de FONTE, não de comportamento, de propósito. O que se quer proibir é
 * uma mudança de superfície do módulo, e isso não se observa chamando funções.
 */

const WIZARD = join(process.cwd(), 'src/onboarding/wizard.ts');
const fonte = (): string => readFileSync(WIZARD, 'utf8');

describe('#519 — a fronteira do bootstrap global não pode ser contornada', () => {
  it('`openRunChecked` existe (âncora anti-vacuidade)', () => {
    // Sem esta asserção, renomear a função faria as duas de baixo passarem
    // VAZIAS: não encontrariam export porque não encontrariam nada.
    expect(fonte()).toMatch(/async function openRunChecked\(/);
  });

  it('`openRunChecked` NÃO é exportado', () => {
    const s = fonte();
    expect(
      /export\s+(async\s+)?function openRunChecked\b/.test(s),
      'openRunChecked foi EXPORTADO. Isso abre um caminho para criar uma run ' +
        '`global_bootstrap` sem resgatar a credencial — a autorização inteira ' +
        'do bootstrap depende de este símbolo ser privado ao módulo. Se a ' +
        'intenção é reusá-lo, extraia a parte comum SEM a criação da run, ou ' +
        'exporte um wrapper que exija a credencial.',
    ).toBe(false);
    // Também não vale sair por `export { openRunChecked }`.
    expect(
      /export\s*\{[^}]*\bopenRunChecked\b[^}]*\}/.test(s),
      'openRunChecked foi reexportado num bloco `export { ... }` — mesma brecha.',
    ).toBe(false);
  });

  it('`openRun` recusa `global_bootstrap` com o código de fronteira, não com `kind_not_implemented`', () => {
    const s = fonte();
    // `kind_not_implemented` dizia "ainda não existe". Trocar de volta para ele
    // reintroduziria a leitura de que basta implementar para liberar o caminho
    // genérico — quando o ponto é que o caminho genérico NUNCA libera.
    expect(s).toMatch(/'bootstrap_not_allowed'/);
    const trecho = s.slice(s.indexOf('async function openRun('), s.indexOf('async function openRunChecked('));
    expect(
      trecho.includes("'kind_not_implemented'"),
      'openRun voltou a recusar bootstrap global como "não implementado". A ' +
        'recusa é de FRONTEIRA (`bootstrap_not_allowed`) e é permanente: ' +
        'autorizar por `actor` seria circular, porque o ator que autorizaria é ' +
        'o que o bootstrap existe para criar.',
    ).toBe(false);
  });

  it('o segredo não entra em `StartRunInput` (que é projetado para metadata persistida)', () => {
    const s = fonte();
    const ini = s.indexOf('export type StartRunInput = {');
    const bloco = s.slice(ini, s.indexOf('};', ini));
    expect(
      /secret/i.test(bloco),
      'apareceu um campo com "secret" em StartRunInput. Esse tipo passa por ' +
        '`projectRunMetadata` e viaja para o banco — o segredo do bootstrap ' +
        'vive em StartGlobalBootstrapInput, que não é persistido.',
    ).toBe(false);
  });
});

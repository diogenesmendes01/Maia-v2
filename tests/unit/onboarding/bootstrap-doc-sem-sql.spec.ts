import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #519 — o doc de deploy não pode voltar a mandar criar o primeiro operador
 * por `psql`.
 *
 * Este guard existe porque a regressão aqui é BARATA e silenciosa: alguém
 * copia a seção antiga de um histórico, ou reintroduz o `INSERT` "só para
 * desbloquear um ambiente", e o caminho manual volta a ser a rota documentada.
 * Nenhum teste de código pegaria — a instrução vive num arquivo `.md`.
 *
 * Os dois defeitos do `INSERT` que saiu, e que não podem voltar:
 *   1. exigia credencial de banco para INSTALAR o produto;
 *   2. gravava `tenant_id = 'default'`, o literal que a plataforma proíbe em
 *      path dinâmico e que todo guard de escopo do repo recusa.
 */

const DOC = join(process.cwd(), 'docs/admin-ui-deploy.md');
const doc = (): string => readFileSync(DOC, 'utf8');

describe('#519 — o deploy do console não instrui SQL manual', () => {
  it('a seção do primeiro operador existe (âncora anti-vacuidade)', () => {
    // Sem isto, renomear/remover a seção faria as asserções de baixo passarem
    // VAZIAS — não encontrariam o INSERT porque não encontrariam nada.
    expect(doc()).toMatch(/## Seeding the first owner/);
  });

  it('não manda inserir em `app_users` por SQL', () => {
    expect(
      /INSERT\s+INTO\s+app_users/i.test(doc()),
      'o doc voltou a documentar `INSERT INTO app_users`. O caminho suportado ' +
        'é POST /setup/bootstrap com a credencial de uso único — ele provisiona ' +
        'o tenant e cria o founder, e só funciona uma vez.',
    ).toBe(false);
  });

  it('aponta a rota de bootstrap como o caminho suportado', () => {
    const s = doc();
    expect(s).toMatch(/\/setup\/bootstrap/);
    // O segredo no CORPO é parte do contrato, não detalhe de exemplo: em query
    // string ele vaza em log de proxy, Referer e histórico do navegador.
    expect(s).toMatch(/body.*never in the URL|secret travels in the \*\*body\*\*/i);
  });

  it("não instrui gravar `tenant_id = 'default'`", () => {
    // A única menção tolerada é a que EXPLICA por que o literal foi banido —
    // ela vem acompanhada de "forbids". Uma instrução para usá-lo, não.
    const linhas = doc()
      .split('\n')
      .filter((l) => l.includes("'default'") && !/forbid|proib/i.test(l));
    expect(
      linhas,
      `o doc voltou a mencionar 'default' fora do contexto de proibição:\n${linhas.join('\n')}`,
    ).toEqual([]);
  });
});

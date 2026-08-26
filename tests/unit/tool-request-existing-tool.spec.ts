/**
 * #636 — "esta lacuna precisa de uma tool que NÃO EXISTE?"
 *
 * O casamento é feito contra o REGISTRO REAL de tools (`src/tools/_registry.ts`),
 * não contra uma lista escrita no teste. É isso que faz o caso "gap com tool
 * disponível não gera pedido" continuar significando alguma coisa quando o
 * catálogo do produto muda: se `query_balance` for renomeada, este arquivo
 * quebra junto — que é o aviso certo.
 */
import { describe, it, expect } from 'vitest';
import {
  encontrarToolExistente,
  esbocarNomeDeTool,
  normalizarTexto,
} from '@/cognition/tool-request/existing-tool.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const registro = moduloDeProducao(() => import('@/tools/_registry.js'));

describe('#636 — normalização e esboço de nome', () => {
  it('tira acento, caixa e pontuação', () => {
    expect(normalizarTexto('Consultar SALDO da conta!')).toBe('consultar saldo da conta');
  });

  it('esboça um identificador estável a partir da descrição', () => {
    expect(esbocarNomeDeTool('consultar o estoque do produto na loja')).toBe(
      'consultar_estoque_produto_loja',
    );
    // Mesma descrição, mesmo nome — duas rodadas do worker não podem produzir
    // dois nomes concorrentes para a mesma coisa.
    expect(esbocarNomeDeTool('consultar o estoque do produto na loja')).toBe(
      esbocarNomeDeTool('consultar o estoque do produto na loja'),
    );
  });

  it('devolve null quando não sobra token — sem nome genérico de reserva', () => {
    expect(esbocarNomeDeTool('de a o')).toBeNull();
    expect(esbocarNomeDeTool('!!! ???')).toBeNull();
    // Curto demais para um identificador utilizável.
    expect(esbocarNomeDeTool('ir')).toBeNull();
  });
});

describe('#636 — casamento contra o REGISTRO REAL de tools', () => {
  it('o catálogo de referência é o REGISTRY de produção, e não está vazio', () => {
    const nomes = Object.keys(registro().REGISTRY);
    expect(nomes.length).toBeGreaterThan(10);
    expect(nomes).toContain('query_balance');
  });

  it('lacuna que nomeia uma tool existente é reconhecida como já coberta', () => {
    const catalogo = Object.keys(registro().REGISTRY);
    expect(
      encontrarToolExistente({
        texto: 'preciso usar query_balance mas não tenho acesso',
        catalogo,
      }),
    ).toBe('query_balance');
    // Também com espaço no lugar do underscore — é como o LLM costuma escrever.
    expect(
      encontrarToolExistente({ texto: 'não consigo fazer query balance', catalogo }),
    ).toBe('query_balance');
  });

  it('lacuna cujo nome esboçado JÁ é uma tool registrada também é coberta', () => {
    const catalogo = Object.keys(registro().REGISTRY);
    expect(encontrarToolExistente({ texto: 'explain limitation', catalogo })).toBe(
      'explain_limitation',
    );
  });

  it('lacuna sem tool correspondente devolve null', () => {
    const catalogo = Object.keys(registro().REGISTRY);
    expect(
      encontrarToolExistente({
        texto: 'consultar o estoque do produto no ERP do cliente',
        catalogo,
      }),
    ).toBeNull();
  });
});

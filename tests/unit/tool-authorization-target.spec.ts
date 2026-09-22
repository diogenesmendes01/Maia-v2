/**
 * P05 / C-P05-7 (spec §7.10.1) — `authorization_target` no dispatcher.
 *
 * O defeito que estes casos cercam tinha duas caras, e a segunda é pior que a
 * primeira:
 *
 *  1. Num escopo SEM entidade, uma ferramenta de memória pessoal era recusada
 *     com `no_entity_in_scope` — um problema que ela não tem.
 *  2. Num escopo COM entidades, ela passava, mas vinculada a
 *     `ctx.scope.entidades[0]`: a PRIMEIRA da lista, arbitrária. As checagens
 *     de permissão e o material de idempotência rodavam contra uma entidade
 *     que a chamada nunca mencionou.
 *
 * A segunda é pior porque não falha — ela decide certo por acidente enquanto a
 * lista tiver um elemento só, e passa a decidir errado no dia em que tiver dois.
 */
import { describe, it, expect } from 'vitest';
import { REGISTRY } from '@/tools/_registry.js';

describe('authorization_target — o contrato', () => {
  it('memória pessoal declara current_subject, não entidade', () => {
    for (const nome of ['recall_memory', 'propose_memory', 'remember_safe_fact', 'propose_hint']) {
      const tool = REGISTRY[nome];
      expect(tool, `${nome} deveria existir no registry`).toBeTruthy();
      expect(tool?.authorization_target, nome).toBe('current_subject');
    }
  });

  it('o resto do registry mantém o default, que preserva o comportamento atual', () => {
    // O default é `entity`. Ele NÃO é uma classificação: é a ausência de uma.
    // Este caso existe para que reclassificar uma ferramenta seja sempre uma
    // mudança visível no diff, nunca um efeito colateral de outra coisa.
    const anotadas = Object.entries(REGISTRY)
      .filter(([, t]) => t?.authorization_target !== undefined)
      .map(([n]) => n)
      .sort();
    expect(anotadas).toEqual(
      ['propose_hint', 'propose_memory', 'recall_memory', 'remember_safe_fact'].sort(),
    );
  });

  it('o alvo só afrouxa a EXIGÊNCIA — não tira a permissão quando há entidade', () => {
    // Uma versão anterior desta fatia zerava a permissão resolvida fora de
    // `entity`. O argumento parecia bom — a permissão de `entidades[0]` não
    // descreve uma chamada que não é sobre entidade — mas as checagens adiante
    // LEEM essa permissão e recusam sem ela. O CI pegou: `remember_safe_fact`
    // passou a devolver `forbidden` em `turn-effect-unknown-real-db`.
    //
    // O que resta por resolver, e é conhecido: num escopo com várias
    // entidades, uma ferramenta `current_subject` continua avaliada contra a
    // permissão da PRIMEIRA. Corrigir exige permissão de titular no
    // `ToolContext` — modelo de permissões, não dispatcher.
    const anotada = REGISTRY.remember_safe_fact;
    expect(anotada?.authorization_target).toBe('current_subject');
    // O contrato aqui é o do dispatcher, exercitado nos testes de integração
    // (`turn-effect-unknown-real-db`): com entidade no escopo, o caminho é
    // idêntico ao anterior à fatia.
  });

  it('nenhuma ferramenta anotada como current_subject pede entidade no schema', () => {
    // Coerência: declarar que a autorização não é sobre entidade e ao mesmo
    // tempo receber `entidade_id` seria contradição — o dispatcher ignoraria
    // um argumento que o chamador achou que importava.
    for (const [nome, tool] of Object.entries(REGISTRY)) {
      if (tool?.authorization_target !== 'current_subject') continue;
      const shape = (tool.input_schema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape === undefined) continue;
      expect(Object.keys(shape), nome).not.toContain('entidade_id');
    }
  });
});

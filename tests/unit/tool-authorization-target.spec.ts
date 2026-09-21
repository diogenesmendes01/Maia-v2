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

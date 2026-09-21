/**
 * P09 (spec §7.8.4, §7.9.2) — política de aprendizado e seletor de aprovação.
 *
 * O caso que dá nome a este arquivo é o primeiro: uma REGRA aprendida de risco
 * baixo era aprovável por analyst, porque o seletor antigo
 * (`getApprovalClassFor`) mapeava `knowledge_proposal` só pelo risco.
 *
 * Isso é errado por semântica, não por calibragem. Uma regra reescreve o
 * comportamento do agente em todo turno seguinte, e quem responde por isso é o
 * owner — mesmo quando o texto parece inofensivo. E a saída tentadora está
 * proibida junto pelo §7.9.2: "não falsificar risco high para obter owner".
 */
import { describe, it, expect } from 'vitest';
import {
  destinationFor,
  getLearningApprovalClassFor,
  alwaysRequiresHumanReview,
  sharedLearningAuthorizations,
  LEARNING_KINDS,
} from '@/learning/policy.js';
import { getApprovalClassFor } from '@/admin-ui/lib/approval-matrix.js';

describe('getLearningApprovalClassFor — semântica, não só risco', () => {
  it('regra aprendida é knowledge_rule em TODOS os riscos', () => {
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      expect(getLearningApprovalClassFor({ kind: 'learned_rule', risk })).toBe('knowledge_rule');
    }
  });

  it('e é exatamente aí que ele diverge do seletor antigo', () => {
    // O contraste é a prova do defeito: com risco baixo, o seletor por tipo
    // devolvia a classe de analyst para a MESMA proposta.
    expect(getApprovalClassFor('knowledge_proposal', 'low')).toBe('knowledge_guidance');
    expect(getLearningApprovalClassFor({ kind: 'learned_rule', risk: 'low' })).toBe(
      'knowledge_rule',
    );
  });

  it('fato e orientação compartilhados sobem com risco ou com lock', () => {
    expect(getLearningApprovalClassFor({ kind: 'shared_fact', risk: 'low' })).toBe(
      'knowledge_guidance',
    );
    expect(getLearningApprovalClassFor({ kind: 'shared_fact', risk: 'high' })).toBe(
      'knowledge_rule',
    );
    // Lock sobe mesmo com risco baixo: o travamento é sobre o que a mudança
    // toca, não sobre o quanto o conteúdo assusta.
    expect(
      getLearningApprovalClassFor({ kind: 'shared_guidance', risk: 'low', locks: ['soul_core'] }),
    ).toBe('knowledge_rule');
  });

  it('skill draft NÃO cai na classe permissiva de refinamento', () => {
    // §7.9.2 proíbe nominalmente o atalho: "não ativar via classe
    // `skill_refinement` mais permissiva para contornar a escolha v1".
    expect(getLearningApprovalClassFor({ kind: 'skill_draft', risk: 'low' })).toBe(
      'skill_new_domain',
    );
  });

  it('procedure draft alcança a classe que o switch antigo nunca selecionava', () => {
    expect(getLearningApprovalClassFor({ kind: 'procedure_draft', risk: 'low' })).toBe(
      'procedure_update',
    );
  });

  it('todo kind conhecido tem classe — sem buraco silencioso', () => {
    for (const kind of LEARNING_KINDS) {
      expect(getLearningApprovalClassFor({ kind, risk: 'medium' })).toBeTruthy();
    }
  });
});

describe('destinationFor — o proponente não escolhe onde o item vai parar', () => {
  it('drafts de skill e procedure NÃO são item de conhecimento', () => {
    expect(destinationFor('skill_draft')).toEqual({
      channel: 'governed_draft',
      artifact: 'skill',
    });
    expect(destinationFor('procedure_draft')).toEqual({
      channel: 'governed_draft',
      artifact: 'procedure',
    });
  });

  it('os pessoais vão para escopo de titular; os compartilhados nascem no agente', () => {
    expect(destinationFor('personal_memory')).toMatchObject({ kind: 'memory', scope: 'user' });
    expect(destinationFor('shared_fact')).toMatchObject({ kind: 'fact', scope: 'agent' });
  });

  it('regra aprendida vira KSM rule', () => {
    expect(destinationFor('learned_rule')).toMatchObject({ kind: 'rule', scope: 'agent' });
  });
});

describe('revisão humana obrigatória', () => {
  it('só preferência pessoal pode ser liberada por política', () => {
    expect(alwaysRequiresHumanReview('personal_preference')).toBe(false);
    for (const kind of LEARNING_KINDS.filter((k) => k !== 'personal_preference')) {
      expect(alwaysRequiresHumanReview(kind)).toBe(true);
    }
  });
});

describe('aprendizado compartilhado tem DUAS autorizações', () => {
  it('conteúdo e sanitização/destino são registrados separadamente', () => {
    // §7.9.2: mesmo quando a mesma pessoa assina as duas no caminho solo
    // permitido, registrar separadamente o que ela autorizou — não inventar
    // quatro olhos universais, mas também não deixar parecer que uma decisão
    // respondeu às duas perguntas.
    const a = sharedLearningAuthorizations({ kind: 'shared_fact', risk: 'low' });
    expect(a.content).toBe('knowledge_guidance');
    expect(a.sanitization_and_destination).toBe('knowledge_rule');
  });
});

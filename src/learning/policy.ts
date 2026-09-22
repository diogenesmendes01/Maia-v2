/**
 * P09 (spec §7.8.4, §7.9.2) — POLÍTICA DE APRENDIZADO.
 *
 * ─── As duas perguntas que este módulo responde ─────────────────────────────
 *
 * 1. Um `kind` público de aprendizado vira o quê no canônico da Maia?
 * 2. Quem precisa assinar para ele virar realidade?
 *
 * As duas eram respondidas implicitamente e em lugares errados. A primeira não
 * existia — o chamador montava o item do KSM na mão, o que significa que cada
 * escritor tinha a própria opinião sobre destino e nativos. A segunda existia,
 * mas mapeava só por RISCO (`getApprovalClassFor`), e é aí que estava o
 * defeito que o §7.9.2 nomeia.
 *
 * ─── O defeito do seletor por risco ─────────────────────────────────────────
 *
 * `getApprovalClassFor('knowledge_proposal', risk)` devolve `knowledge_rule`
 * (owner declarado) quando o risco é alto, e `knowledge_guidance` (analyst)
 * caso contrário. Uma REGRA APRENDIDA de risco baixo, portanto, era aprovável
 * por analyst.
 *
 * Isso é errado por semântica, não por calibragem: uma regra muda como o
 * agente se comporta em todos os turnos seguintes, e quem responde por isso é
 * o owner — independentemente de o scorer ter achado o conteúdo inofensivo. O
 * §7.9.2 é literal: "`learned_rule` seleciona `knowledge_rule`
 * independentemente de o scorer dizer low".
 *
 * E a saída tentadora é proibida junto: "não falsificar risco high para obter
 * owner". Mentir o risco para conseguir o aprovador certo estraga o risco, que
 * é lido por outras coisas. O que muda é o SELETOR, não a entrada dele.
 *
 * ─── O que este módulo não faz ──────────────────────────────────────────────
 *
 * Não autentica ninguém e não decide se a assinatura é válida. Ele diz QUAL
 * classe se aplica; quem verifica identidade de sessão e ACL é o backend do
 * inbox (§7.9.2, primeiro item). `KnowledgeStateMachine.transition` aceita
 * `decided_by` e não autentica humano nenhum — por isso a decisão humana não
 * pode ser delegada a ela.
 */
import type { ApprovalClassId, RiskLevelId } from '@/db/schema.js';

/**
 * Os `kind` públicos do §7.8.4. São a superfície que um proponente usa, e
 * deliberadamente NÃO são os `KnowledgeKind` internos: o destino canônico é
 * decisão do backend, e deixar o proponente nomeá-lo seria deixá-lo escolher
 * onde o próprio item vai parar.
 */
export const LEARNING_KINDS = [
  'personal_preference',
  'personal_memory',
  'shared_fact',
  'shared_guidance',
  'learned_rule',
  'skill_draft',
  'procedure_draft',
] as const;

export type LearningKind = (typeof LEARNING_KINDS)[number];

/**
 * Para onde o item vai no canônico.
 *
 * `ksm` são os que viram item de conhecimento. `governed_draft` são os dois que
 * NÃO são item de conhecimento e seguem caminho administrativo próprio — o
 * §7.8.4 é explícito em que `skill_draft` não é `KnowledgeKind=skill` e que
 * `procedure_draft` não se confunde com `procedure_hint`.
 */
export type LearningDestination =
  | {
      channel: 'ksm';
      kind: 'fact' | 'memory' | 'rule' | 'behavioral_hint';
      scope: 'user' | 'agent';
    }
  | { channel: 'governed_draft'; artifact: 'skill' | 'procedure' };

const DESTINO: Record<LearningKind, LearningDestination> = {
  personal_preference: { channel: 'ksm', kind: 'fact', scope: 'user' },
  personal_memory: { channel: 'ksm', kind: 'memory', scope: 'user' },
  // Os dois `shared_*` nascem DRAFT PRIVADO. O escopo amplo só aparece numa
  // revisão administrativa sanitizada, depois — nunca aqui, e nunca porque o
  // proponente pediu (§7.8.4).
  shared_fact: { channel: 'ksm', kind: 'fact', scope: 'agent' },
  shared_guidance: { channel: 'ksm', kind: 'behavioral_hint', scope: 'agent' },
  learned_rule: { channel: 'ksm', kind: 'rule', scope: 'agent' },
  skill_draft: { channel: 'governed_draft', artifact: 'skill' },
  procedure_draft: { channel: 'governed_draft', artifact: 'procedure' },
};

export function destinationFor(kind: LearningKind): LearningDestination {
  return DESTINO[kind];
}

/**
 * Nasce exigindo revisão humana, sem exceção de política?
 *
 * `learned_rule` sempre (§7.8.4: "sempre pending_review"). `personal_memory`
 * por default. Os `shared_*` porque são draft privado com
 * `require_human_review=true`.
 *
 * `personal_preference` é o único que a política PODE liberar para automático
 * — e "pode" é o verbo certo: quem decide é a política de memória pessoal do
 * §7.5, não este mapa. Aqui ele aparece como `false` no sentido de "não é
 * obrigatório por semântica", e não no sentido de "é automático".
 */
export function alwaysRequiresHumanReview(kind: LearningKind): boolean {
  return kind !== 'personal_preference';
}

/**
 * O SELETOR NOVO do §7.9.2.
 *
 * Diferente de `getApprovalClassFor`, ele recebe a SEMÂNTICA (o `kind`) além
 * do risco, e é por isso que consegue dar a resposta certa sem mentir a
 * entrada.
 *
 * `locks` são os travamentos de arquitetura que a mudança toca. Quando há
 * qualquer lock, o router exige duas pessoas founder distintas — regra que
 * vive no `proposals.ts` e que este seletor NÃO tenta reproduzir. O que ele
 * faz é escolher a classe mais forte disponível, para que a regra de lock
 * incida sobre ela.
 */
export function getLearningApprovalClassFor(input: {
  kind: LearningKind;
  risk: RiskLevelId;
  locks?: readonly string[];
}): ApprovalClassId {
  const { kind, risk } = input;
  const temLock = (input.locks?.length ?? 0) > 0;

  switch (kind) {
    /**
     * REGRA APRENDIDA — `knowledge_rule` SEMPRE.
     *
     * O risco não entra nesta linha, e essa ausência é o ponto da fatia. Uma
     * regra reescreve o comportamento do agente em todo turno seguinte; quem
     * responde por isso é o owner, mesmo quando o texto parece inofensivo.
     */
    case 'learned_rule':
      return 'knowledge_rule';

    /**
     * ORIENTAÇÃO COMPARTILHADA — `knowledge_guidance` por default, mas sobe
     * para `knowledge_rule` em risco alto ou com lock.
     *
     * Ela não muda comportamento por si (é orientação, não regra), então o
     * analyst basta no caso comum. O que a faz subir é o conteúdo ser
     * arriscado ou tocar um travamento — não o fato de ser compartilhada.
     */
    case 'shared_guidance':
      return risk === 'critical' || risk === 'high' || temLock
        ? 'knowledge_rule'
        : 'knowledge_guidance';

    /**
     * FATO COMPARTILHADO — sobe com o risco, como antes.
     *
     * Aqui o seletor por risco estava certo: um fato é uma afirmação sobre o
     * mundo, e o que determina quem assina é o quanto ela pode causar dano.
     */
    case 'shared_fact':
      return risk === 'critical' || risk === 'high' || temLock
        ? 'knowledge_rule'
        : 'knowledge_guidance';

    /**
     * PESSOAIS — `knowledge_guidance`, e o titular corrige o próprio dado.
     *
     * O §7.9.2 separa os dois papéis: o titular pode corrigir ou optar por não
     * usar a própria preferência, e NÃO é approver de política compartilhada.
     * Risco alto sobe para owner porque aí já não é só preferência: é dado
     * sensível de uma pessoa.
     */
    case 'personal_preference':
    case 'personal_memory':
      return risk === 'critical' || risk === 'high' ? 'knowledge_rule' : 'knowledge_guidance';

    /**
     * SKILL — caminho administrativo founder-only, PRESERVADO.
     *
     * O §7.9.2 proíbe nominalmente o atalho: "não ativar via classe
     * `skill_refinement` mais permissiva para contornar a escolha v1". Por isso
     * o baixo risco NÃO devolve `skill_refinement` aqui; um draft vindo de
     * aprendizado entra pela porta forte, e usar o inbox unificado para skill
     * exige primeiro a primitiva InTx e a harmonização explícita da matriz.
     */
    case 'skill_draft':
      return 'skill_new_domain';

    /**
     * PROCEDURE — classe declarada que o switch atual nunca seleciona.
     *
     * `procedure_update` existe na matriz e o seletor por tipo não chega nela
     * (§7.9.2). Aqui ela passa a ser alcançável. O teste técnico de
     * `proposed→active` continua sendo gate — e continua NÃO sendo
     * autenticação do campo `actor`.
     */
    case 'procedure_draft':
      return 'procedure_update';
  }
}

/**
 * O caminho do aprendizado compartilhado tem DUAS autorizações, e elas são
 * coisas diferentes.
 *
 * O §7.9.2 pede que sejam registradas separadamente mesmo quando a mesma
 * pessoa assina as duas no caminho solo permitido — "não inventar quatro olhos
 * universais", mas também não deixar parecer que uma decisão cobriu as duas
 * perguntas.
 */
export type SharedLearningAuthorizations = {
  /** O conteúdo pode existir? */
  content: ApprovalClassId;
  /** Ele pode ser desidentificado e publicado NESTE destino? */
  sanitization_and_destination: ApprovalClassId;
};

export function sharedLearningAuthorizations(input: {
  kind: Extract<LearningKind, 'shared_fact' | 'shared_guidance'>;
  risk: RiskLevelId;
  locks?: readonly string[];
}): SharedLearningAuthorizations {
  return {
    content: getLearningApprovalClassFor(input),
    // A publicação é sempre a decisão mais forte disponível para conhecimento:
    // ela expõe o item para além do titular de origem, e o §7.8.4 exige revisão
    // administrativa sanitizada própria.
    sanitization_and_destination: 'knowledge_rule',
  };
}

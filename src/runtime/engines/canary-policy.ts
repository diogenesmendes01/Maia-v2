/**
 * P12 (spec §10.1, §10 linha P12) — A ESCADA DE HABILITAÇÃO DO CANÁRIO.
 *
 * ─── O que este módulo é ────────────────────────────────────────────────────
 *
 * A tradução em código da ordem do §10.1. Ela não é uma lista de sugestões: é
 * uma escada em que cada degrau pressupõe o anterior, e o texto da spec fecha
 * cada um com uma proibição própria — "nada de dados reais", "resultados não
 * enviados", "sem cópia de dados de clientes nos bundles", "não entra
 * automaticamente ao terminar a integração do reasoner".
 *
 * Sem um lugar onde a escada exista como DADO, cada uma dessas proibições vira
 * um `if` espalhado, e a pergunta "este agente já pode aprender?" passa a ter
 * tantas respostas quantos forem os lugares que a fazem.
 *
 * ─── O que ele NÃO é ────────────────────────────────────────────────────────
 *
 * Não é o canário. O §10 é explícito em que a P12 exige "autorização humana de
 * deploy" e "todos os gates relevantes" — coisas que não saem de uma PR. Este
 * módulo responde "o que este degrau permite?"; quem responde "em que degrau
 * este agente está?" é a configuração que um humano escreveu, e quem responde
 * "pode subir de degrau?" é esse mesmo humano, com evidência de aceite.
 *
 * Também não define percentual, duração nem throughput. O §10.1 fecha assim:
 * "Não definir percentuais, duração de canário ou throughput sem volume e
 * janela operacional conhecidos". Um default aqui seria um número inventado
 * com aparência de decisão.
 */

/**
 * Os degraus, na ordem do §10.1.
 *
 * O índice no array É a ordem. Comparações usam a posição, não o nome, para
 * que acrescentar um degrau no meio não exija reescrever as comparações.
 */
export const CANARY_STAGES = [
  /** Maia local, nenhuma chamada Hermes. Migrations aditivas podem entrar. */
  'off',
  /** Modelo, canal e tool de teste explicitamente identificados. Zero dado real. */
  'synthetic',
  /** Snapshots minimizados; resultados NÃO enviados; escrita/learning desligados. */
  'shadow_offline',
  /** Coorte cadastrada no backend; requisitos de isolamento e custo satisfeitos. */
  'live_informational',
  /** Recall autorizado; preferências automáticas só com policy opt-in. */
  'private_memory',
  /** Propostas, revisão, publicação e revogação completas. */
  'governed_shared_learning',
  /** Etapa SEPARADA por ferramenta, com prova de idempotência e aprovações. */
  'business_effect_tools',
] as const;

export type CanaryStage = (typeof CANARY_STAGES)[number];

/**
 * As capacidades que a escada governa.
 *
 * Cada uma é uma pergunta que alguém faz no código, e a resposta precisa vir
 * de um lugar só.
 */
export type CanaryCapability =
  /** Chamar o motor remoto para um turno de verdade. */
  | 'hermes_live_turn'
  /** Usar dado real de pessoa (em vez de fixture). */
  | 'real_personal_data'
  /** Entregar a resposta do motor ao usuário. */
  | 'deliver_to_user'
  /** Projetar memória privada do titular ao modelo. */
  | 'private_recall'
  /** Gravar aprendizado automático (proposta). */
  | 'write_learning_proposal'
  /** Publicar conhecimento compartilhado. */
  | 'publish_shared_learning'
  /** Executar ferramenta com efeito de negócio. */
  | 'business_effect_tool';

/** Em qual degrau cada capacidade passa a ser permitida. */
const EXIGIDO: Record<CanaryCapability, CanaryStage> = {
  hermes_live_turn: 'live_informational',
  // Dado real só a partir do live: o degrau `synthetic` é literalmente "nada
  // de dados reais", e `shadow_offline` trabalha sobre snapshots MINIMIZADOS.
  real_personal_data: 'live_informational',
  // Entregar ao usuário é o que separa shadow de live. O §10.1 descreve
  // `shadow_offline` como "resultados não enviados".
  deliver_to_user: 'live_informational',
  private_recall: 'private_memory',
  // Propor aprendizado exige memória privada funcionando antes: uma proposta
  // derivada de dado que o sistema ainda não sabe projetar com autorização
  // seria derivada de dado que ninguém conferiu.
  write_learning_proposal: 'private_memory',
  publish_shared_learning: 'governed_shared_learning',
  business_effect_tool: 'business_effect_tools',
};

function posicao(stage: CanaryStage): number {
  return CANARY_STAGES.indexOf(stage);
}

/**
 * O degrau atual permite esta capacidade?
 *
 * Comparação por POSIÇÃO: estar num degrau superior implica tudo que os
 * anteriores permitiam. Um mapa de booleanos por degrau permitiria descrever
 * uma escada furada — "pode publicar mas não pode entregar" —, que é um estado
 * que a ordem do §10.1 não admite e que ninguém iria querer defender.
 */
export function canaryStageAllows(stage: CanaryStage, capability: CanaryCapability): boolean {
  return posicao(stage) >= posicao(EXIGIDO[capability]);
}

/**
 * A configuração de canário de UM agente.
 *
 * `cohort_ref` é obrigatório a partir de `live_informational` porque o §10.1
 * exige coorte "listada por IDs autorizados no backend". E a frase seguinte é
 * a que este campo existe para honrar: "nenhuma chave do usuário WhatsApp
 * habilita Hermes" — a coorte é cadastro, não um número de telefone que
 * alguém digitou.
 */
export type AgentCanaryPolicyV1 = {
  tenant_id: string;
  agent_id: string;
  stage: CanaryStage;
  /** Referência ao cadastro da coorte autorizada. */
  cohort_ref: string | null;
  /**
   * Evidência de ACEITE do degrau atual — quem autorizou e contra o quê.
   *
   * O §10 lista "evidência de aceite" como artefato da P12. Sem ela, subir de
   * degrau é uma edição de configuração indistinguível de um engano.
   */
  acceptance_evidence_ref: string | null;
};

export type CanaryPolicyProblem =
  | 'missing_cohort'
  | 'missing_acceptance_evidence'
  | 'unknown_stage';

/**
 * A política está COERENTE para o degrau que declara?
 *
 * Isto é validação de configuração, não autorização de runtime: uma política
 * incoerente não deve chegar a produção. Separar as duas importa — validar no
 * runtime, a cada turno, transformaria erro de configuração em incidente
 * intermitente.
 */
export function validateCanaryPolicy(policy: AgentCanaryPolicyV1): CanaryPolicyProblem[] {
  const problemas: CanaryPolicyProblem[] = [];
  if (posicao(policy.stage) < 0) {
    // Degrau desconhecido: não dá para dizer o que ele permite, e assumir o
    // mais baixo esconderia uma configuração errada em vez de mostrá-la.
    return ['unknown_stage'];
  }

  const exigeCoorte = posicao(policy.stage) >= posicao('live_informational');
  if (exigeCoorte && (policy.cohort_ref === null || policy.cohort_ref.length === 0)) {
    problemas.push('missing_cohort');
  }

  // O aceite é exigido a partir do momento em que algo sai para o mundo. Em
  // `off` e `synthetic` não há o que aceitar.
  const exigeAceite = posicao(policy.stage) >= posicao('shadow_offline');
  if (
    exigeAceite &&
    (policy.acceptance_evidence_ref === null || policy.acceptance_evidence_ref.length === 0)
  ) {
    problemas.push('missing_acceptance_evidence');
  }

  return problemas;
}

/**
 * A decisão de runtime: esta capacidade está liberada para este agente?
 *
 * Política ausente vale `off`. É o default seguro e também o honesto: um
 * agente sem configuração de canário não foi incluído em canário nenhum, e
 * tratar ausência como "o degrau mais alto que o código suporta" seria ligar o
 * Hermes para quem nunca foi cadastrado.
 *
 * Política INCOERENTE também vale `off`. Ela já deveria ter sido barrada na
 * validação; se chegou aqui, a resposta segura é não agir com base nela.
 */
export function canaryAllows(
  policy: AgentCanaryPolicyV1 | null,
  capability: CanaryCapability,
): boolean {
  if (policy === null) return canaryStageAllows('off', capability);
  if (validateCanaryPolicy(policy).length > 0) return canaryStageAllows('off', capability);
  return canaryStageAllows(policy.stage, capability);
}

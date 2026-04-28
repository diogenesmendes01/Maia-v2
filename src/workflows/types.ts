export type WorkflowType =
  | 'dual_approval'
  | 'fechamento_mes'
  | 'cobranca_balancete'
  | 'consolidacao_caixa'
  | 'follow_up';

export type WorkflowContext = Record<string, unknown>;

export type StepInput = {
  ordem: number;
  descricao: string;
  tool?: string;
  args?: Record<string, unknown>;
  depends_on?: number[];
};

/**
 * Work loop — registry de kinds (issue #469, spec §1/§3).
 *
 * PRINCÍPIO CENTRAL: perceptores e executores são CÓDIGO REVISADO por kind —
 * o LLM nunca decide "que trabalho existe" (backend decide, LLM propõe). Um
 * kind novo (ex.: `inadimplencia`, v2 da spec) entra por PR, declarando:
 *
 *   - perceive (opcional): varre o estado do mundo sob o contexto do tenant
 *     e materializa tarefas idempotentes (upsertTask por natural_key).
 *   - execute (obrigatório): processa UMA tarefa claimada; retorna a
 *     transição tipada. Side-effects SOMENTE pelos caminhos existentes
 *     (procedures/tools/scheduling) — o work loop não cria atalho novo.
 *
 * v1 entrega o kind sintético `manual` (spec §8): tarefas criadas pelo
 * owner no console; o executor valida o ciclo claim→execução→exceção→
 * retomada sem exigir conector novo. `payload.flow` controla o caminho:
 *   - 'auto'      (default) → conclui com outcome registrado;
 *   - 'exception' → vai para waiting_human (fila de exceções) e só sai
 *                   quando o owner resolve no console.
 */
import type { AgentObjective, ObjectiveTask } from '@/db/schema.js';

export type ExecuteResult =
  | { transition: 'done'; outcome: Record<string, unknown> }
  | { transition: 'waiting_human'; outcome?: Record<string, unknown> }
  | { transition: 'failed'; error_detail: string };

export interface ObjectiveKind {
  id: string;
  /** Materializa tarefas (idempotente). Omitido ⇒ tarefas só via console. */
  perceive?: (objective: AgentObjective) => Promise<
    Array<{ natural_key: string; title: string; payload: Record<string, unknown> }>
  >;
  execute: (args: {
    objective: AgentObjective;
    task: ObjectiveTask;
  }) => Promise<ExecuteResult>;
}

const manualKind: ObjectiveKind = {
  id: 'manual',
  async execute({ task }) {
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const flow = typeof payload.flow === 'string' ? payload.flow : 'auto';
    if (flow === 'exception') {
      // Fila de exceções: a tarefa para aqui até o owner resolvê-la no
      // console (objectives.resolveTask). v2 vincula pending questions
      // reais (pending_question_id) para destravar via WhatsApp.
      return { transition: 'waiting_human' };
    }
    return {
      transition: 'done',
      outcome: {
        kind: 'manual',
        executed_at: new Date().toISOString(),
        note:
          'Kind manual (v1) — execução de validação do ciclo. Kinds com ' +
          'side-effects reais (ex.: inadimplencia) entram na v2 via procedures.',
      },
    };
  },
};

export const OBJECTIVE_KINDS: Readonly<Record<string, ObjectiveKind>> = {
  manual: manualKind,
};

export const OBJECTIVE_KIND_IDS = Object.keys(OBJECTIVE_KINDS) as readonly string[];

export function getObjectiveKind(id: string): ObjectiveKind | null {
  return OBJECTIVE_KINDS[id] ?? null;
}

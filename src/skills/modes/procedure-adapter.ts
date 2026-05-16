/**
 * P9a — `procedure_adapter` execution mode.
 *
 * Modo 2: adapta a skill para o runtime de procedures (P3a-c). A
 * `skill.procedure` esperada é `{ procedure_definition_id?: string }` ou
 * `{ procedure_descriptor?: string }`; o adapter procura uma procedure
 * ativa correspondente e dispara `procedureExecutionsRepo.create` (start)
 * + delega ao engine quando rodando síncrono. Em P9a a integração é
 * minimalista: cria-se a execution e retorna-se um envelope com o id;
 * o engine (P3b) posteriormente avança o estado.
 *
 * Out-of-scope para P9a:
 *  - Aguardar conclusão da procedure (multi-step state pode levar minutos)
 *  - Mapear input do skill para `step_input` específico
 *
 * Quando uma skill precisa de procedure síncrona end-to-end, prefira
 * `prompt_only` ou `tool_mediated`.
 */
import { procedureDefinitionsRepo, procedureExecutionsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import type { ModeContext } from '../types.js';

interface ProcedureSpec {
  procedure_definition_id?: string;
  procedure_descriptor?: string;
  /** Sometimes skill.procedure is just opaque data with no procedure ref. */
  [key: string]: unknown;
}

export async function procedureAdapterMode(
  ctx: ModeContext,
): Promise<Record<string, unknown>> {
  const procedure = (ctx.skill.procedure ?? {}) as ProcedureSpec;

  // Resolve procedure definition id (descriptor lookup is best-effort).
  let definitionId = procedure.procedure_definition_id ?? null;
  if (!definitionId && procedure.procedure_descriptor) {
    const def = await procedureDefinitionsRepo.findActiveByName(procedure.procedure_descriptor);
    definitionId = def?.id ?? null;
  }

  if (!definitionId) {
    throw new Error('procedure_definition_not_found');
  }

  // Resolve definition to grab version (procedure_executions requires both).
  const def = await procedureDefinitionsRepo.findById(definitionId);
  if (!def) {
    throw new Error('procedure_definition_not_found');
  }

  // Best-effort start. The engine worker (P3b) advances the state.
  const exec = await procedureExecutionsRepo.create({
    definition_id: definitionId,
    definition_version: def.version_number,
    conversa_id: ctx.conversa_id ?? null,
    status: 'in_progress',
    current_step_id: null,
    execution_state: { input: ctx.input },
    completed_steps: [],
    ended_at: null,
    outcome: null,
    notes: `started by skill ${ctx.skill.skill_descriptor} v${ctx.skill.version}`,
  });

  logger.info(
    { skill_id: ctx.skill.id, execution_id: exec.id, definition_id: definitionId },
    'p9a.procedure_adapter.started',
  );

  return {
    procedure_execution_id: exec.id,
    procedure_definition_id: definitionId,
    status: exec.status,
  };
}

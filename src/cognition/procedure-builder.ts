import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { runCognitiveModule } from './runner.js';

/** Maximum length for descricao_livre input. Caps cost/abuse. (M4) */
const MAX_DESCRICAO_LIVRE_LENGTH = 8000;

const ProcedureDraftSchema = z.object({
  intencao: z.string(),
  when_apply: z.object({}).passthrough(),
  when_not_apply: z.object({}).passthrough().optional(),
  steps: z.array(z.object({
    id: z.string(),
    intencao: z.string(),
    como: z.string(),
    sucesso_criteria_ref: z.string().optional(),
    armadilhas: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    tools_used: z.array(z.string()).optional(),
  })),
  success_criteria: z.array(z.object({
    id: z.string(),
    type: z.enum(['machine_check', 'tool_result', 'user_signal', 'llm_judge', 'human_confirmed']),
  }).passthrough()),
  failure_modes: z.array(z.string()).optional(),
  tools_referenced: z.array(z.string()).optional(),
});

/**
 * Schema for the LLM "soft-error" envelope. When the model decides input
 * is incomprehensible, the prompt instructs it to emit {"error":"..."}.
 */
const ProcedureErrorEnvelopeSchema = z.object({ error: z.string() });

export type ProcedureDraft = {
  nome: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  intencao: string;
  when_apply: Record<string, unknown>;
  when_not_apply: Record<string, unknown>;
  steps: Array<{ id: string; intencao: string; como: string; [k: string]: unknown }>;
  success_criteria: Array<{ id: string; type: string; [k: string]: unknown }>;
  failure_modes: string[];
  tools_referenced: string[];
  source: 'ensino' | 'observacao' | 'pratica' | 'platform_wisdom';
};

/**
 * Typed result of a successful schema parse — the LLM emitted a valid
 * procedure draft envelope.
 */
type BuilderOk = { ok: true; data: z.infer<typeof ProcedureDraftSchema> };

/**
 * Typed failure reasons surfaced by the builder. Per project north-star
 * (governança/escopo/evidência), every ENSINO failure must produce a
 * typed, auditable reason instead of a silent null. (C1)
 */
export type ProcedureBuilderFailureReason =
  | 'input_too_long'
  | 'llm_empty'
  | 'no_json_envelope'
  | 'llm_rejected'   // model returned {"error":"..."}
  | 'invalid_json'   // could not JSON.parse
  | 'invalid_schema' // JSON parsed but failed schema validation
  | 'llm_call_failed';

type BuilderFail = {
  ok: false;
  reason: ProcedureBuilderFailureReason;
  detail?: string;
};

type BuilderResult = BuilderOk | BuilderFail;

/**
 * Discriminated union returned by teachProcedure. Callers MUST inspect
 * `ok` before consuming the draft.
 */
export type TeachProcedureResult =
  | { ok: true; draft: ProcedureDraft }
  | BuilderFail;

/**
 * Modo ENSINO entry-point.
 *
 * @deprecated Prefer the discriminated-result form `teachProcedureSafe`,
 *   which surfaces typed failure reasons for governance/audit. This
 *   wrapper returns `null` on any failure (kept for callers that have
 *   not migrated yet); the failure reason is still logged.
 */
export async function teachProcedure(input: {
  nome: string;
  descricao_livre: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  source?: 'ensino' | 'observacao' | 'pratica' | 'platform_wisdom';
}): Promise<ProcedureDraft | null> {
  const result = await teachProcedureSafe(input);
  return result.ok ? result.draft : null;
}

/**
 * Discriminated-result form of `teachProcedure`. Returns a typed
 * failure reason instead of a silent null. (C1)
 */
export async function teachProcedureSafe(input: {
  nome: string;
  descricao_livre: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  source?: 'ensino' | 'observacao' | 'pratica' | 'platform_wisdom';
}): Promise<TeachProcedureResult> {
  // M4: bounded input.
  if (input.descricao_livre.length > MAX_DESCRICAO_LIVRE_LENGTH) {
    return {
      ok: false,
      reason: 'input_too_long',
      detail: `descricao_livre length ${input.descricao_livre.length} exceeds cap ${MAX_DESCRICAO_LIVRE_LENGTH}`,
    };
  }

  const result = await runCognitiveModule<BuilderResult>(
    { name: 'procedure-builder.ensino', triggered_by: 'sync_required', timeoutMs: 15000 },
    async () => {
      let res;
      try {
        res = await callLLM({
          workload: 'procedure_builder',
          system: builderPrompt(),
          messages: [{ role: 'user', content: input.descricao_livre }],
          max_tokens: 1500,
          temperature: 0.0,
        });
      } catch (err) {
        return {
          ok: false,
          reason: 'llm_call_failed',
          detail: (err as Error).message,
        } as BuilderFail;
      }

      const text = (res.content ?? '').trim();
      if (!text) return { ok: false, reason: 'llm_empty' };

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { ok: false, reason: 'no_json_envelope' };

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(match[0]);
      } catch (err) {
        return {
          ok: false,
          reason: 'invalid_json',
          detail: (err as Error).message,
        };
      }

      // Detect the LLM "soft-error" envelope explicitly so callers can
      // distinguish `{"error":"..."}` from a schema-shaped hallucination.
      const errEnvelope = ProcedureErrorEnvelopeSchema.safeParse(parsedJson);
      if (errEnvelope.success) {
        return { ok: false, reason: 'llm_rejected', detail: errEnvelope.data.error };
      }

      const parsed = ProcedureDraftSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'invalid_schema',
          detail: parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        };
      }
      return { ok: true, data: parsed.data };
    },
  );

  // runCognitiveModule swallows thrown errors and returns null. Treat a
  // null output as a runtime-level failure so we still surface a typed
  // reason instead of returning silently.
  if (!result.output) {
    return {
      ok: false,
      reason: 'llm_call_failed',
      detail: result.status === 'timeout' ? 'timeout' : 'unknown',
    };
  }

  if (result.output.ok === false) {
    logger.warn(
      { reason: result.output.reason, detail: result.output.detail, nome: input.nome },
      'procedure_builder.failed',
    );
    return result.output;
  }

  const data = result.output.data;
  return {
    ok: true,
    draft: {
      nome: input.nome,
      scope: input.scope,
      intencao: data.intencao,
      when_apply: data.when_apply,
      when_not_apply: data.when_not_apply ?? {},
      steps: data.steps as ProcedureDraft['steps'],
      success_criteria: data.success_criteria as ProcedureDraft['success_criteria'],
      failure_modes: data.failure_modes ?? [],
      tools_referenced: data.tools_referenced ?? [],
      source: input.source ?? 'ensino',
    },
  };
}

function builderPrompt(): string {
  return `Você é o Procedure Builder. Recebe uma descrição livre de um procedimento (como o owner explicaria) e estrutura em JSON com:
- intencao: 1 frase resumindo o objetivo
- when_apply: { tags?: [...], conditions?: [...] } — quando o procedimento aplica
- when_not_apply: idem — quando NÃO aplica
- steps: [{ id, intencao, como, sucesso_criteria_ref?, armadilhas?, depends_on?, tools_used? }] — passos em ordem lógica
- success_criteria: [{ id, type: 'machine_check'|'tool_result'|'user_signal'|'llm_judge'|'human_confirmed', ... }] — critérios verificáveis
- failure_modes: [string] — armadilhas comuns
- tools_referenced: [string] — tools que o procedimento usa

Use snake_case pra ids. Cada step deve ser concreto e verificável.

Exemplo de formato esperado (P83-L5, apenas pra ancorar o shape — não copie o conteúdo):
{
  "intencao": "Qualificar lead novo de inglês adulto via primeiras mensagens",
  "when_apply": { "tags": ["lead_novo", "ingles_adulto"] },
  "when_not_apply": { "tags": ["lead_kids"] },
  "steps": [
    { "id": "descobrir_motivo", "intencao": "Entender por que quer aprender", "como": "Pergunta aberta: 'O que te levou a procurar inglês agora?'" }
  ],
  "success_criteria": [
    { "id": "motivo_capturado", "type": "user_signal" }
  ],
  "failure_modes": ["Pular descoberta e oferecer plano direto"],
  "tools_referenced": []
}

Retorne APENAS JSON. Se input incompreensível, retorne {"error":"..."}.`;
}

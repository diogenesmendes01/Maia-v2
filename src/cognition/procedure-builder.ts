import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

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

export async function teachProcedure(input: {
  nome: string;
  descricao_livre: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  source?: 'ensino' | 'observacao' | 'pratica' | 'platform_wisdom';
}): Promise<ProcedureDraft | null> {
  const result = await runCognitiveModule(
    { name: 'procedure-builder.ensino', triggered_by: 'sync_required', timeoutMs: 15000 },
    async () => {
      const res = await callLLM({
        system: builderPrompt(),
        messages: [{ role: 'user', content: input.descricao_livre }],
        max_tokens: 1500,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = ProcedureDraftSchema.safeParse(JSON.parse(match[0]));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  );

  if (!result.output) return null;

  return {
    nome: input.nome,
    scope: input.scope,
    intencao: result.output.intencao,
    when_apply: result.output.when_apply,
    when_not_apply: result.output.when_not_apply ?? {},
    steps: result.output.steps as ProcedureDraft['steps'],
    success_criteria: result.output.success_criteria as ProcedureDraft['success_criteria'],
    failure_modes: result.output.failure_modes ?? [],
    tools_referenced: result.output.tools_referenced ?? [],
    source: input.source ?? 'ensino',
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

Retorne APENAS JSON. Se input incompreensível, retorne {"error":"..."}.`;
}

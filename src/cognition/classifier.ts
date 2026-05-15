import { z } from 'zod';
import type { ClassifiedCandidate } from './types.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

// Note: `regra.confianca_sugerida_llm` is accepted as METADATA-ONLY. The
// Persister DISCARDS it and derives the canonical `confianca` via the
// deterministic formula in `confidence.ts`. North-star invariant: confidence
// NEVER comes from the LLM (see `project_self_model_design` / `project_reflection_pipeline_design`).
const ClassifiedSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fato'), content: z.string(), scope: z.enum(['agent', 'role', 'conversation']), subject_id: z.string().optional() }),
  z.object({
    type: z.literal('regra'),
    contexto: z.string(),
    acao: z.string(),
    tipo: z.enum(['classificacao', 'identificacao_entidade', 'tom_resposta', 'recorrencia']),
    // METADATA-ONLY. Not used as canonical confidence. Optional so older LLM
    // outputs still parse.
    confianca_sugerida_llm: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal('procedimento'), nome: z.string(), intencao: z.string(), passos_draft: z.array(z.string()) }),
  z.object({ type: z.literal('lacuna'), capability_description: z.string(), tipo: z.enum(['tool', 'knowledge', 'procedure']), contexto: z.string() }),
  z.object({ type: z.literal('tool_request'), tool_name_sketch: z.string(), description: z.string(), inputs_sketch: z.string(), outputs_sketch: z.string() }),
  z.object({ type: z.literal('descarte'), reason: z.string() }),
]);

export async function classify(insight: string): Promise<ClassifiedCandidate | null> {
  const result = await runCognitiveModule(
    { name: 'classifier', triggered_by: 'async_event', timeoutMs: 8000 },
    async () => {
      const res = await callLLM({
        system: classifierSystemPrompt(),
        messages: [{ role: 'user', content: insight }],
        max_tokens: 400,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = ClassifiedSchema.safeParse(JSON.parse(match[0]));
      return parsed.success ? parsed.data : null;
    },
  );
  return result.output;
}

function classifierSystemPrompt(): string {
  return `Você é o Classifier. Recebe um insight (texto livre) e o tipa em um dos 6 destinos:
- fato: informação sobre o mundo/interlocutor
- regra: se-contexto-então-ação atômico
- procedimento: como-fazer multi-passo
- lacuna: capacidade faltante (tool/knowledge/procedure)
- tool_request: proposta de tool específica
- descarte: ruído, não útil

Retorne APENAS JSON conforme schema:
- fato: { type, content, scope: 'agent'|'role'|'conversation', subject_id? }
- regra: { type, contexto, acao, tipo: 'classificacao'|'identificacao_entidade'|'tom_resposta'|'recorrencia', confianca_sugerida_llm?: 0..1 }
- procedimento: { type, nome, intencao, passos_draft: string[] }
- lacuna: { type, capability_description, tipo: 'tool'|'knowledge'|'procedure', contexto }
- tool_request: { type, tool_name_sketch, description, inputs_sketch, outputs_sketch }
- descarte: { type, reason }

Sobre confianca_sugerida_llm: é OPCIONAL e METADATA. O sistema descarta esse
valor — a confiança real é calculada deterministicamente a partir de evidência.
Pode omitir.

Na dúvida, prefira descarte. Não invente conteúdo.`;
}

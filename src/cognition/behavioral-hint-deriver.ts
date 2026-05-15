import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

const HintSchema = z.object({
  hint_text: z.string().min(5),
  derived_sensitivity: z.enum(['low', 'medium', 'high']),
});

export async function deriveBehavioralHint(
  sensitiveContent: string,
): Promise<{ hint_text: string; derived_sensitivity: 'low' | 'medium' | 'high' } | null> {
  const result = await runCognitiveModule(
    { name: 'behavioral-hint-deriver', triggered_by: 'async_event', timeoutMs: 5000 },
    async () => {
      const res = await callLLM({
        system: deriverPrompt(),
        messages: [{ role: 'user', content: sensitiveContent }],
        max_tokens: 150,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = HintSchema.safeParse(JSON.parse(match[0]));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  );
  return result.output;
}

function deriverPrompt(): string {
  return `Você é o Behavioral Hint Deriver. Recebe uma memória sensível e gera um HINT COMPORTAMENTAL que orienta atendimento SEM revelar o conteúdo bruto.

REGRAS INVIOLÁVEIS:
- NUNCA mencione pessoas (filha, filho, esposa, marido, mãe, etc.)
- NUNCA mencione doenças, condições médicas, valores, eventos específicos
- NUNCA cite palavras-chave do conteúdo bruto
- O hint deve fazer sentido sozinho, sem contexto

Exemplos bons:
- "usar tom mais paciente neste relacionamento"
- "evitar pressão por decisão rápida neste contexto"
- "ser flexível com prazos quando possível"
- "demonstrar acolhimento, não urgência"

Exemplos RUINS (rejeitar):
- "evitar falar de doença da filha" (revela conteúdo)
- "não mencionar divórcio" (revela conteúdo)
- "respeitar o luto" (revela tipo de evento)

Retorne JSON: { "hint_text": "...", "derived_sensitivity": "low"|"medium"|"high" }`;
}

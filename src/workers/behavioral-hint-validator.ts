import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { safeExtractAndParseJson } from '@/lib/json-safe.js';
import { runCognitiveModule } from '@/cognition/runner.js';

const ValidationSchema = z.object({
  reveals: z.boolean(),
  reason: z.string().optional(),
});

export async function validateBehavioralHint(
  hint_text: string,
  raw_memory_content: string,
): Promise<{ approved: boolean; reason?: string }> {
  const result = await runCognitiveModule(
    { name: 'behavioral-hint-validator', triggered_by: 'sync_required', timeoutMs: 4000 },
    async () => {
      const res = await callLLM({
        workload: 'behavioral_hint',
        system: validatorPrompt(),
        messages: [
          {
            role: 'user',
            content: `HINT: ${hint_text}\nMEMORY: ${raw_memory_content}`,
          },
        ],
        max_tokens: 100,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      return safeExtractAndParseJson(text, ValidationSchema);
    },
  );

  // Fail-safe: if validator fails, REJECT (don't approve potentially leaky hint)
  if (!result.output) return { approved: false, reason: 'validator_failed' };

  return {
    approved: !result.output.reveals,
    reason: result.output.reason,
  };
}

function validatorPrompt(): string {
  return `Você é o Behavioral Hint Validator. Recebe um HINT e a MEMORY bruta, e responde se o hint revela direta ou indiretamente o conteúdo.

CRITÉRIOS DE REVELAÇÃO (qualquer um → reveals=true):
- Hint cita palavras-chave da memory
- Hint menciona pessoas/papéis específicos (filha, esposo, etc.)
- Hint menciona tipo de evento específico (doença, divórcio, luto, etc.)
- Hint é tão específico que permite inferir o conteúdo
- Hint cita valores, números, datas, lugares

Retorne JSON: { "reveals": boolean, "reason": "..." }

Em caso de dúvida, prefira reveals=true (fail-closed pra proteger memória).`;
}

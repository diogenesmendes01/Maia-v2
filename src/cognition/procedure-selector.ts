import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';
import { procedureAssignmentsRepo, procedureDefinitionsRepo } from '@/db/repositories.js';
import { getCurrentAgent } from '@/db/tenant-context.js';

const MatchResponseSchema = z.object({
  matches: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

const CONFIDENCE_THRESHOLD = 0.6;

export type SelectorDecision = {
  decision: 'start' | 'continue' | 'switch' | 'escalate' | 'none';
  selected_procedure_id?: string;
  candidates: Array<{ procedure_id: string; confidence: number; reason: string }>;
  conflicts: Array<{ procedure_id: string; reason: string }>;
  reason: string;
};

export async function selectProcedure(input: {
  conversa_id: string;
  current_message: string;
  current_execution: { id: string; definition_id: string; status: string } | null;
}): Promise<SelectorDecision> {
  // Has active execution? Default = continue
  if (input.current_execution && input.current_execution.status === 'in_progress') {
    return {
      decision: 'continue',
      selected_procedure_id: input.current_execution.definition_id,
      candidates: [],
      conflicts: [],
      reason: 'active execution exists',
    };
  }

  // List active procedures for this agent
  const agent_id = getCurrentAgent();
  const assignments = await procedureAssignmentsRepo.listForTarget('agent', agent_id);
  if (assignments.length === 0) {
    return { decision: 'none', candidates: [], conflicts: [], reason: 'no procedures assigned' };
  }

  const candidates: SelectorDecision['candidates'] = [];

  for (const assignment of assignments) {
    const def = await procedureDefinitionsRepo.findById(assignment.definition_id);
    if (!def || def.status !== 'active') continue;

    const result = await runCognitiveModule(
      { name: `procedure-selector.${def.nome}`, triggered_by: 'sync_conditional', timeoutMs: 5000 },
      async () => {
        const res = await callLLM({
          system: matchPrompt(def),
          messages: [{ role: 'user', content: input.current_message }],
          max_tokens: 150,
          temperature: 0.0,
        });
        const text = (res.content ?? '').trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
          const parsed = MatchResponseSchema.safeParse(JSON.parse(match[0]));
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      },
    );

    if (result.output) {
      candidates.push({
        procedure_id: def.id,
        confidence: result.output.confidence,
        reason: result.output.reason ?? '',
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0];

  if (!top || top.confidence < CONFIDENCE_THRESHOLD) {
    return { decision: 'none', candidates, conflicts: [], reason: 'no candidate above threshold' };
  }

  // Detect conflicts: 2+ candidates within 0.1 of top → flag
  const conflicts = candidates
    .slice(1)
    .filter((c) => top.confidence - c.confidence < 0.1)
    .map((c) => ({ procedure_id: c.procedure_id, reason: 'close confidence to top' }));

  return {
    decision: 'start',
    selected_procedure_id: top.procedure_id,
    candidates,
    conflicts,
    reason: `top candidate ${top.confidence.toFixed(2)} > threshold ${CONFIDENCE_THRESHOLD}`,
  };
}

function matchPrompt(def: any): string {
  return `Você decide se a mensagem do usuário match com o procedimento abaixo.

Procedimento: ${def.nome}
Intenção: ${def.intencao}
Quando aplicar: ${JSON.stringify(def.when_apply)}

Retorne JSON: { "matches": bool, "confidence": 0..1, "reason": "..." }`;
}

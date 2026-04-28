import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { rulesRepo, mensagensRepo, selfStateRepo } from '@/db/repositories.js';
import { writeMemory } from '@/memory/vector.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

const ReflectionRule = z.object({
  applicable: z.boolean(),
  tipo: z.enum(['classificacao', 'identificacao_entidade', 'tom_resposta', 'recorrencia']).optional(),
  contexto: z.string().optional(),
  acao: z.string().optional(),
  contexto_jsonb: z.record(z.unknown()).optional(),
  acoes_jsonb: z.record(z.unknown()).optional(),
  justificativa: z.string().optional(),
});

const CORRECTION_HINTS = [
  /\bn[ãa]o\b/i,
  /\berrad/i,
  /\bcorrige/i,
  /\bn[ãa]o foi\b/i,
  /\b[ée] outr/i,
  /\bcancela\b/i,
];

export function detectCorrection(message: string): boolean {
  return CORRECTION_HINTS.some((re) => re.test(message));
}

export async function reflectOnCorrection(input: {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  previousAssistant: Mensagem | null;
}): Promise<void> {
  if (!input.previousAssistant) return;
  const system = `Você é a Maia analisando uma correção do usuário. Responda APENAS em JSON conforme o schema.
Se a correção é genuína (categoria errada, entidade errada, valor errado, etc.), proponha uma regra que evite repetição.
Schema:
{
  "applicable": boolean,
  "tipo": "classificacao" | "identificacao_entidade" | "tom_resposta" | "recorrencia",
  "contexto": string,
  "acao": string,
  "contexto_jsonb": object,
  "acoes_jsonb": object,
  "justificativa": string
}
Se não for aplicável, retorne {"applicable": false}.`;
  const user = `Resposta anterior da Maia:
${input.previousAssistant.conteudo}

Correção do usuário:
${input.inbound.conteudo}

Proponha uma regra ou diga não aplicável.`;
  try {
    const res = await callLLM({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 400,
      temperature: 0.0,
    });
    const text = res.content?.trim() ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = ReflectionRule.safeParse(JSON.parse(match[0]));
    if (!parsed.success || !parsed.data.applicable) return;
    if (!parsed.data.tipo || !parsed.data.contexto || !parsed.data.acao) return;

    const r = await rulesRepo.create({
      tipo: parsed.data.tipo,
      contexto: parsed.data.contexto,
      acao: parsed.data.acao,
      contexto_jsonb: parsed.data.contexto_jsonb ?? {},
      acoes_jsonb: parsed.data.acoes_jsonb ?? {},
      confianca: '0.50',
      acertos: 0,
      erros: 0,
      ativa: true,
      exemplo_origem_id: input.inbound.id,
    });
    await audit({
      acao: 'rule_learned',
      pessoa_id: input.pessoa.id,
      conversa_id: input.conversa.id,
      mensagem_id: input.inbound.id,
      alvo_id: r.id,
      metadata: { tipo: parsed.data.tipo, justificativa: parsed.data.justificativa },
    });
    logger.info({ rule_id: r.id, tipo: parsed.data.tipo }, 'reflection.rule_created');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'reflection.failed');
  }
}

export async function reflectOnWorkflowCompletion(input: {
  workflow_id: string;
  pessoa_id: string;
  summary: string;
  scope_entidades: string[];
}): Promise<void> {
  // Append to self_state.resumo_aprendizados
  await selfStateRepo.appendLearning(input.summary).catch(() => undefined);
  // Vectorize for recall
  const escopo = input.scope_entidades.length > 0 ? `entidade:${input.scope_entidades[0]}` : 'global';
  await writeMemory({
    conteudo: input.summary,
    tipo: 'reflexao',
    escopo,
    metadata: { workflow_id: input.workflow_id },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'reflection.vector_write_failed'));
  await audit({
    acao: 'reflection_completed',
    pessoa_id: input.pessoa_id,
    alvo_id: input.workflow_id,
  });
}

export async function findPreviousAssistantMessage(
  conversa_id: string,
  before_id: string,
): Promise<Mensagem | null> {
  const recent = await mensagensRepo.recentInConversation(conversa_id, 5);
  for (const m of recent) {
    if (m.id === before_id) continue;
    if (m.direcao === 'out') return m;
  }
  return null;
}

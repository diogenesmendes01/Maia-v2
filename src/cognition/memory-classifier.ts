import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { safeExtractAndParseJson } from '@/lib/json-safe.js';
import { runCognitiveModule } from './runner.js';

const ClassificationSchema = z.object({
  memory_type: z.enum(['operational', 'preference', 'personal', 'sensitive']),
  scope_type: z.enum(['conversation', 'interlocutor', 'channel', 'role', 'agent', 'tenant']).optional(),
  sensitivity: z.enum(['low', 'medium', 'high']).optional(),
  ttl_days: z.number().nullable().optional(),
});

type ClassifierOutput = {
  memory_type: 'operational' | 'preference' | 'personal' | 'sensitive';
  scope_type: 'conversation' | 'interlocutor' | 'channel' | 'role' | 'agent' | 'tenant';
  sensitivity: 'low' | 'medium' | 'high';
  proactive_use: boolean;
  mention_allowed: boolean;
  ttl_days: number | null;
};

type MemoryType = ClassifierOutput['memory_type'];

const DEFAULTS_BY_TYPE: Record<MemoryType, Omit<ClassifierOutput, 'memory_type'>> = {
  operational: { scope_type: 'agent', sensitivity: 'low', proactive_use: true, mention_allowed: true, ttl_days: null },
  preference: { scope_type: 'interlocutor', sensitivity: 'low', proactive_use: true, mention_allowed: true, ttl_days: null },
  personal: { scope_type: 'role', sensitivity: 'medium', proactive_use: false, mention_allowed: false, ttl_days: 30 },
  sensitive: { scope_type: 'conversation', sensitivity: 'high', proactive_use: false, mention_allowed: false, ttl_days: 7 },
};

export async function classifyMemory(content: string): Promise<ClassifierOutput | null> {
  const result = await runCognitiveModule(
    { name: 'memory-classifier', triggered_by: 'sync_conditional', timeoutMs: 5000 },
    async () => {
      const res = await callLLM({
        workload: 'memory_classifier',
        system: classifierSystemPrompt(),
        messages: [{ role: 'user', content }],
        max_tokens: 200,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const parsed = safeExtractAndParseJson(text, ClassificationSchema);
      if (!parsed) return null;
      const defaults = DEFAULTS_BY_TYPE[parsed.memory_type];
      return {
        memory_type: parsed.memory_type,
        scope_type: parsed.scope_type ?? defaults.scope_type,
        sensitivity: parsed.sensitivity ?? defaults.sensitivity,
        proactive_use: defaults.proactive_use,
        mention_allowed: defaults.mention_allowed,
        ttl_days: parsed.ttl_days !== undefined ? parsed.ttl_days : defaults.ttl_days,
      };
    },
  );

  // Conservative fallback: classifier failed → treat as personal+restricted.
  // Nota: a tabela aceita memory_type='unknown' (usado pela migração 017 para
  // legacy facts pendentes de revisão), mas aqui escolhemos 'personal' em vez
  // de 'unknown' porque o classificador rodando em runtime já passa pelo
  // persister normal — quem grava precisa de mention_allowed=false explícito,
  // não do gate needs_review. 'unknown' fica reservado pra rows que ainda
  // precisam passar pelo legacy-memory-reclassifier.
  if (result.output === null) {
    return {
      memory_type: 'personal',
      scope_type: 'role',
      sensitivity: 'medium',
      proactive_use: false,
      mention_allowed: false,
      ttl_days: 30,
    };
  }

  return result.output;
}

function classifierSystemPrompt(): string {
  return `Você é o Memory Classifier. Recebe um fato sobre o mundo/interlocutor e classifica em 4 tipos:

- operational: dado factual do negócio (CNPJ, endereço, valor, status) — pode ser mencionado livre
- preference: gosto/preferência declarada (horário, formato, canal) — pode mencionar
- personal: info pessoal/familiar (idade, profissão, família) — NÃO mencionar espontaneamente
- sensitive: disclosure íntimo (saúde, divórcio, dificuldade emocional/financeira pessoal) — NUNCA mencionar

Retorne JSON: { "memory_type": ..., "scope_type": ..., "sensitivity": ..., "ttl_days": ... }

scope_type pode ser: conversation, interlocutor, channel, role, agent, tenant.

Na dúvida entre dois tipos, ESCOLHA O MAIS RESTRITIVO (personal > operational; sensitive > personal).`;
}

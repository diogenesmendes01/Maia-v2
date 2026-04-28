import { config } from '@/config/env.js';
import {
  selfStateRepo,
  factsRepo,
  rulesRepo,
  mensagensRepo,
  entityStatesRepo,
  entidadesRepo,
} from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { fmtBR } from '@/lib/brazilian.js';
import type { LLMMessage } from '@/lib/claude.js';

const LLM_BOUNDARIES = `
Você é uma camada de interpretação. Você NÃO PODE:
- Escolher entidade, conta ou pessoa que o usuário não mencionou explicitamente.
- Compor lista de ações além do profile_id do interlocutor.
- Burlar dual approval (4-eyes). O backend impõe independente do que você emitir.
- Inventar valores, datas ou nomes ausentes do contexto e dos resultados de tools.
Você emite INTENTS estruturados; o backend executa.
`.trim();

export type PromptContext = {
  pessoa: Pessoa;
  conversa: Conversa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  inbound: Mensagem;
};

export async function buildPrompt(ctx: PromptContext): Promise<{ system: string; messages: LLMMessage[] }> {
  const self = await selfStateRepo.getActive();
  const recent = await mensagensRepo.recentInConversation(ctx.conversa.id, 10);
  const ents = await entidadesRepo.byIds(ctx.scope.entidades);
  const facts = await factsRepo.listForScopes([
    'global',
    `pessoa:${ctx.pessoa.id}`,
    ...ctx.scope.entidades.map((e) => `entidade:${e}`),
  ]);
  const rules = await rulesRepo.listActive('classificacao');

  const profileBlock = Array.from(ctx.scope.byEntity.entries())
    .map(([eid, rp]) => {
      const ent = ents.find((e) => e.id === eid);
      return `  - ${ent?.nome ?? eid}: profile=${rp.profile.id}, limite=R$ ${rp.effective_limits.valor_max}`;
    })
    .join('\n');

  const factsBlock = facts
    .slice(0, 20)
    .map((f) => `  - ${f.escopo}/${f.chave}: ${JSON.stringify(f.valor)}`)
    .join('\n');

  const rulesBlock = rules
    .slice(0, 20)
    .map((r) => `  - [#${r.id.slice(0, 8)}] (${r.tipo}, conf ${r.confianca}) ${r.contexto} → ${r.acao}`)
    .join('\n');

  const entityStateBlocks: string[] = [];
  for (const eid of ctx.scope.entidades) {
    const st = await entityStatesRepo.byId(eid);
    if (!st) continue;
    const ent = ents.find((e) => e.id === eid);
    entityStateBlocks.push(
      `  - ${ent?.nome ?? eid}: saldo=${st.saldo_consolidado ?? '?'}, próximo_venc=${st.proximo_vencimento ?? '?'}`,
    );
  }

  const system = [
    self?.system_prompt ?? 'Você é a Maia.',
    '',
    '## LLM Boundaries',
    LLM_BOUNDARIES,
    '',
    '## Sobre você',
    `- Versão self_state: ${self?.versao ?? 0}`,
    `- Resumo de aprendizados:\n${self?.resumo_aprendizados ?? '(vazio)'}`,
    '',
    '## Sobre o interlocutor',
    `- Nome: ${ctx.pessoa.nome}`,
    `- Tipo: ${ctx.pessoa.tipo}`,
    `- Apelido: ${ctx.pessoa.apelido ?? '-'}`,
    '',
    '## Escopo desta conversa',
    profileBlock || '  (sem entidades acessíveis)',
    '',
    '## Estado atual',
    `- Hoje: ${fmtBR(new Date())}`,
    entityStateBlocks.join('\n') || '  (sem estados ativos)',
    '',
    '## Fatos relevantes',
    factsBlock || '  (vazio)',
    '',
    '## Regras aprendidas relevantes',
    rulesBlock || '  (vazio)',
  ].join('\n');

  // Build conversation messages: oldest first
  const ordered = [...recent].reverse();
  const messages: LLMMessage[] = [];
  for (const m of ordered) {
    if (m.id === ctx.inbound.id) continue;
    if (m.direcao === 'in') messages.push({ role: 'user', content: m.conteudo ?? '' });
    else messages.push({ role: 'assistant', content: m.conteudo ?? '' });
  }
  messages.push({ role: 'user', content: ctx.inbound.conteudo ?? '' });

  return { system, messages };
}

export const _internal = { LLM_BOUNDARIES };
export const PROMPT_TOKEN_BUDGET_INPUT = 11000;
export const PROMPT_TOKEN_BUDGET_OUTPUT = 1024;
export { config as _config };

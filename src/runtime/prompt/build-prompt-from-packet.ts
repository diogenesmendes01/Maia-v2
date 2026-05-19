/**
 * P8a — buildPromptFromPacket().
 *
 * Renders an ExecutionContextPacket into a system+messages prompt structure
 * for the LLM. This is the "Context Packet path" of the dual-path described
 * in plan Task 14. When FEATURE_CONTEXT_PACKET_V1 is enabled and a packet is
 * present, the react-loop calls this function instead of the legacy
 * `src/agent/prompt-builder.ts#buildPrompt`.
 *
 * TODO(prompt-builder integration): wire this into src/agent/react-loop.ts
 * once the legacy prompt-builder is repaired (it has pre-existing syntax
 * errors on main). For P8a this function is self-contained and unit-tested.
 */
import type {
  ExecutionContextPacket,
  IdentitySlice,
  KnowledgeSlice,
  PolicySlice,
  SkillSlice,
  SoulSlice,
  ToolPermissionSlice,
  UserSlice,
} from '../context-packet/types.js';

export interface PromptFromPacketResult {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export function buildPromptFromPacket(
  packet: ExecutionContextPacket,
): PromptFromPacketResult {
  const blocks: string[] = [];

  blocks.push(renderIdentity(packet.identity));
  if (packet.policy.applicable_rules.length > 0) {
    blocks.push(renderPolicy(packet.policy));
  }
  if (packet.soul.active_biases.length > 0) {
    blocks.push(renderSoul(packet.soul));
  }
  if (packet.user.pessoa) {
    blocks.push(renderUser(packet.user));
  }
  if (packet.knowledge.facts.length > 0 || packet.knowledge.rules.length > 0) {
    blocks.push(renderKnowledge(packet.knowledge));
  }
  if (
    packet.skill.selected_skill ||
    packet.skill.candidate_skills.length > 0
  ) {
    blocks.push(renderSkill(packet.skill));
  }
  if (packet.tool.available_tools.length > 0) {
    blocks.push(renderTool(packet.tool));
  }

  const system = blocks.join('\n\n');
  const messages = packet.history.turns
    .filter((t) => t.role === 'user' || t.role === 'agent')
    .map((t) => ({
      role: t.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: t.content,
    }));

  return { system, messages };
}

function renderIdentity(slice: IdentitySlice): string {
  const lines = ['## Identidade operacional'];
  lines.push(`- Papel: ${slice.role_descriptor || '(não definido)'}`);
  lines.push(
    `- Voz: tom=${slice.voice.tone || '-'}, formalidade=${slice.voice.formality}, verbosity=${slice.voice.verbosity}`,
  );
  lines.push(
    `- Limites cognitivos: inferência ≤ ${slice.cognitive_limits.max_inference_depth}, especulação ≤ ${slice.cognitive_limits.max_speculation_in_response}, confiança mínima para ação = ${slice.cognitive_limits.confidence_floor_for_action}`,
  );
  if (slice.priorities.length > 0) {
    lines.push(`- Prioridades: ${slice.priorities.join('; ')}`);
  }
  if (slice.learned_voice_modifiers.length > 0) {
    lines.push(
      '- Modificadores de voz aprendidos: ' +
        slice.learned_voice_modifiers
          .map(
            (m) => `${m.aspect}: ${m.modifier} (força ${m.strength.toFixed(2)})`,
          )
          .join('; '),
    );
  }
  return lines.join('\n');
}

function renderPolicy(slice: PolicySlice): string {
  const lines = ['## Políticas aplicáveis (PEPs)'];
  for (const rule of slice.applicable_rules) {
    lines.push(
      `- [${rule.rule_kind}] ${rule.rule_descriptor} (policy ${rule.policy_id} v${rule.version}, peps=${rule.applies_to_peps.join(',')})`,
    );
  }
  if (slice.truncated) {
    lines.push('- (lista truncada por budget; hard_limits sempre preservados)');
  }
  return lines.join('\n');
}

function renderSoul(slice: SoulSlice): string {
  // P8b ships a pre-rendered markdown block; prefer it when available so the
  // ranking + disclaimer logic stays in the slice builder.
  if (slice.rendered_block) {
    return slice.rendered_block;
  }
  const lines = ['## Vieses ativos (orientam, não bloqueiam)'];
  for (const b of slice.active_biases) {
    lines.push(
      `- ${b.principle} (força ${b.strength.toFixed(2)}, origem ${b.origin})`,
    );
  }
  if (slice.total_active > slice.truncated_to) {
    lines.push('- (lista truncada)');
  }
  return lines.join('\n');
}

function renderUser(slice: UserSlice): string {
  const lines = ['## Sobre o interlocutor'];
  if (slice.pessoa) {
    lines.push(
      `- Nome: ${slice.pessoa.display_name ?? '(não fornecido)'} (locale ${slice.pessoa.locale})`,
    );
  }
  if (Object.keys(slice.preferences).length > 0) {
    lines.push(`- Preferências: ${JSON.stringify(slice.preferences)}`);
  }
  if (slice.memories.length > 0) {
    lines.push('## Memória relevante');
    for (const m of slice.memories) {
      lines.push(`- [${m.kind}] ${m.content}`);
    }
  }
  if (slice.behavioral_hints.length > 0) {
    lines.push('## Instruções comportamentais ativas');
    for (const h of slice.behavioral_hints) {
      lines.push(
        `- ${h.aspect}: ${h.suggestion} (força ${h.strength.toFixed(2)})`,
      );
    }
  }
  return lines.join('\n');
}

function renderKnowledge(slice: KnowledgeSlice): string {
  const lines: string[] = [];
  if (slice.facts.length > 0) {
    lines.push('## Fatos relevantes');
    for (const f of slice.facts) {
      lines.push(
        `- ${f.scope}/${f.key}: ${JSON.stringify(f.value)} (conf ${f.confidence.toFixed(2)}, status=${f.lifecycle_status})`,
      );
    }
    if (slice.truncated.facts) lines.push('- (fatos truncados)');
  }
  if (slice.rules.length > 0) {
    lines.push('## Regras aprendidas');
    for (const r of slice.rules) {
      lines.push(
        `- [#${r.id.slice(0, 8)}] (conf ${r.confidence.toFixed(2)}, status=${r.lifecycle_status}) ${r.context} → ${r.action}`,
      );
    }
    if (slice.truncated.rules) lines.push('- (regras truncadas)');
  }
  return lines.join('\n');
}

function renderSkill(slice: SkillSlice): string {
  const lines = ['## Skill / Procedimento'];
  if (slice.selected_skill) {
    lines.push(
      `- Selecionada: ${slice.selected_skill.name} v${slice.selected_skill.version} (id ${slice.selected_skill.id})`,
    );
    const hints = slice.selected_skill.runtime_hints;
    if (hints && Object.keys(hints).length > 0) {
      lines.push(`- Runtime hints: ${JSON.stringify(hints)}`);
    }
  } else if (slice.candidate_skills.length > 0) {
    lines.push('- Candidatos:');
    for (const c of slice.candidate_skills) {
      lines.push(`  - ${c.name} (${c.id}): ${c.reason}`);
    }
  }
  return lines.join('\n');
}

function renderTool(slice: ToolPermissionSlice): string {
  const lines = ['## Tools disponíveis'];
  for (const t of slice.available_tools) {
    const conf = t.requires_confirmation ? ' [CONFIRMAÇÃO]' : '';
    lines.push(
      `- ${t.name}: side_effect=${t.side_effect_level}, audit=${t.audit_level}, idempotent=${t.idempotent}${conf}`,
    );
  }
  if (slice.blocked_tools.length > 0) {
    lines.push('- Bloqueadas: ' + slice.blocked_tools.join(', '));
  }
  return lines.join('\n');
}

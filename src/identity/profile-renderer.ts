/**
 * P4 Task 5 — profile-renderer: renderOperationalProfile (v3.1.1).
 *
 * Determinístico (sem async, sem LLM). Converte uma versão do perfil
 * operacional (`AgentOperationalProfileVersion` — JSONB `profile_body` em 3
 * namespaces v3.1.1: identity / style / metadata) em um bloco de texto que o
 * `prompt-builder` (Task 7) injeta no system prompt.
 *
 * API v3.1.1:
 *   - `system_prompt_block` — identidade (papel, voz, prioridades, limites
 *                              cognitivos) + estilo (idioma). Sempre presente.
 *   - `version_label`       — rótulo curto da versão (ex: `op_profile_v3`),
 *                              usado em logging e debug.
 *
 * Removidos de versões anteriores (não pertencem mais à Identidade):
 *   - `growth_hints_block`     → migrou para o Evolution Pipeline (P5/P9 —
 *                                 propostas de capacidade, não identidade).
 *   - `episodic_summary_block` → migrou para o User Layer (P8c — memória
 *                                 episódica é do usuário, não do agente).
 */
import type { ProfileBody, AgentOperationalProfileVersion } from '../db/schema.js';

export interface RenderedProfile {
  /** Identidade + estilo, sempre presente. Substitui o antigo `self?.system_prompt`. */
  system_prompt_block: string;
  /** Rótulo da versão renderizada (ex: `op_profile_v1`). */
  version_label: string;
}

export function renderOperationalProfile({
  version,
}: {
  version: AgentOperationalProfileVersion;
}): RenderedProfile {
  const body = version.profile_body as ProfileBody;
  const { identity, style } = body;

  const lines: string[] = [];

  // ---- Identidade ----------------------------------------------------------
  lines.push('## Identidade operacional');
  lines.push(`- Papel: ${identity.role_descriptor}`);
  lines.push(
    `- Tom: ${identity.voice.tone} (formalidade ${identity.voice.formality}, ${identity.voice.verbosity})`,
  );

  if (identity.priorities.length > 0) {
    lines.push('- Prioridades (em ordem):');
    identity.priorities.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
  }

  lines.push(
    `- Limites cognitivos: profundidade máx ${identity.cognitive_limits.max_inference_depth}, especulação ≤ ${identity.cognitive_limits.max_speculation_in_response}, confiança mínima para agir ${identity.cognitive_limits.confidence_floor_for_action}`,
  );

  // ---- Estilo --------------------------------------------------------------
  lines.push('');
  lines.push('## Estilo');
  lines.push(`- Idioma: ${style.language}`);

  return {
    system_prompt_block: lines.join('\n'),
    version_label: `op_profile_v${version.version}`,
  };
}

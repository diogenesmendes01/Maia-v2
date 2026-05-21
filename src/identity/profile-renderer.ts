/**
 * P4 Task 6 — profile-renderer: renderOperationalProfile.
 *
 * Determinístico (sem async, sem LLM). Converte uma versão do perfil
 * operacional (`AgentOperationalProfileVersion`, 4 camadas) em 3 blocos de
 * texto que o `prompt-builder` (Task 7) injeta no system prompt.
 *
 *   - `system_prompt_block`        ← identidade + princípios + voz + parâmetros
 *                                    (substitui o antigo `self?.system_prompt`)
 *   - `growth_hints_block` | null  ← backlog de capacidades aprovadas mas ainda
 *                                    não consolidadas
 *   - `episodic_summary_block` | null ← resumo de episódios recentes filtrados
 *                                       por permissões de uso
 *
 * Invariante defense-in-depth: entries em `episodic_temp.entries` com
 * `mention_allowed=false` OU `proactive_use=false` (controles do P2) NUNCA
 * aparecem em qualquer bloco renderizado. A camada de memória já filtra na
 * origem, mas o renderer também recusa, como segunda trava de segurança.
 * Padrão restritivo: se a entry não declara explicitamente `true` para ambos
 * os flags, é OMITIDA.
 */
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import { resolveLegacyPayload } from './profile-legacy-resolver.js';

export type RenderedProfile = {
  /** Sempre presente; substitui o antigo `self?.system_prompt`. */
  system_prompt_block: string;
  /** Apenas se houver itens no backlog. */
  growth_hints_block: string | null;
  /** Apenas se houver entries autorizadas (`mention_allowed && proactive_use`). */
  episodic_summary_block: string | null;
};

// Local type only describes the optional-key item shape of growth_backlog
// entries (the resolver hands back raw legacy data). The resolver owns the
// read-precedence + synthesized fallback logic; this file only renders the
// resolved view.
type GrowthBacklogItemObject = { descricao?: unknown };

export function renderOperationalProfile({
  version,
}: {
  version: AgentOperationalProfileVersion;
}): RenderedProfile {
  // v3.1.1 contract (migration 061 + Codex review #163 rounds 1-4):
  //
  // Read precedence + shape unification live in `resolveLegacyPayload`. The
  // resolver returns the 4-layer view regardless of whether the row carries
  // the data via profile_body.{core_immutable,...} (production), top-level
  // legacy columns (test fixtures), or only the canonical profile_body.identity
  // shape (synthesized fallback for admin-ui newly-created rows, which now
  // includes thresholds derived from cognitive_limits — see resolver).
  const resolved = resolveLegacyPayload(version);
  const core = resolved.core_immutable;
  const op = resolved.operational_profile;
  const ep = resolved.episodic_temp;
  const bk = resolved.growth_backlog;

  // ---- system_prompt_block (sempre presente, nunca null) -------------------
  const lines: string[] = [];

  if (typeof core.identity_block === 'string' && core.identity_block.trim()) {
    lines.push(core.identity_block.trim());
  }

  if (Array.isArray(core.principles) && core.principles.length > 0) {
    const principleLines: string[] = [];
    for (const p of core.principles) {
      if (typeof p === 'string' && p.trim()) {
        principleLines.push(`- ${p.trim()}`);
      }
    }
    if (principleLines.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('## Princípios');
      lines.push(...principleLines);
    }
  }

  if (typeof op.voice_descriptor === 'string' && op.voice_descriptor.trim()) {
    if (lines.length > 0) lines.push('');
    lines.push('## Voz operacional');
    lines.push(op.voice_descriptor.trim());
  }

  const thresholdsTxt = formatThresholds(op.thresholds);
  if (thresholdsTxt) {
    if (lines.length > 0) lines.push('');
    lines.push('## Parâmetros calibrados');
    lines.push(thresholdsTxt);
  }

  const system_prompt_block = lines.join('\n').trim();

  // ---- growth_hints_block ---------------------------------------------------
  const items: unknown[] = Array.isArray(bk)
    ? bk
    : Array.isArray((bk as { items?: unknown[] }).items)
      ? ((bk as { items: unknown[] }).items)
      : [];

  const growthLines: string[] = [];
  for (const it of items) {
    if (typeof it === 'string' && it.trim()) {
      growthLines.push(`- ${it.trim()}`);
      continue;
    }
    if (it && typeof it === 'object') {
      const descricao = (it as GrowthBacklogItemObject).descricao;
      if (typeof descricao === 'string' && descricao.trim()) {
        growthLines.push(`- ${descricao.trim()}`);
      }
    }
  }

  const growth_hints_block =
    growthLines.length > 0
      ? `## Capacidades em desenvolvimento (aprovadas, ainda não consolidadas)\n${growthLines.join('\n')}`
      : null;

  // ---- episodic_summary_block (defense in depth) ---------------------------
  const entries = Array.isArray(ep.entries) ? ep.entries : [];
  const epLines: string[] = [];
  for (const e of entries) {
    // Padrão restritivo: AMBOS os flags devem ser EXPLICITAMENTE `true`. Se
    // qualquer um for `false`, `undefined` ou outro tipo, a entry é omitida.
    if (e?.mention_allowed !== true) continue;
    if (e?.proactive_use !== true) continue;
    if (typeof e.summary === 'string' && e.summary.trim()) {
      epLines.push(`- ${e.summary.trim()}`);
    }
  }

  const episodic_summary_block =
    epLines.length > 0 ? `## Contexto recente\n${epLines.join('\n')}` : null;

  return { system_prompt_block, growth_hints_block, episodic_summary_block };
}

function formatThresholds(
  t: Record<string, unknown> | undefined,
): string | null {
  if (!t || typeof t !== 'object') return null;
  const keys = Object.keys(t);
  if (keys.length === 0) return null;

  const out: string[] = [];
  for (const k of keys) {
    const v = t[k];
    if (v === null || v === undefined) continue;
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    out.push(`- ${k}: ${rendered}`);
  }
  return out.length > 0 ? out.join('\n') : null;
}

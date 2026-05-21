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

export type RenderedProfile = {
  /** Sempre presente; substitui o antigo `self?.system_prompt`. */
  system_prompt_block: string;
  /** Apenas se houver itens no backlog. */
  growth_hints_block: string | null;
  /** Apenas se houver entries autorizadas (`mention_allowed && proactive_use`). */
  episodic_summary_block: string | null;
};

type CoreImmutable = {
  identity_block?: string;
  principles?: unknown[];
};

type OperationalProfileLayer = {
  voice_descriptor?: string;
  thresholds?: Record<string, unknown>;
};

type EpisodicEntry = {
  summary?: string;
  mention_allowed?: boolean;
  proactive_use?: boolean;
};

type EpisodicTemp = {
  entries?: EpisodicEntry[];
};

type GrowthBacklogItemObject = { descricao?: unknown };
type GrowthBacklog = unknown[] | { items?: unknown[] };

// Treat `{}` and `[]` as "no content" so the renderer doesn't lock in the
// empty-default legacy_mirror over a populated canonical profile_body. A
// shallow check is enough — both legacy and canonical shapes are plain
// JSONB and a non-empty object/array carries at least one key/element.
function hasAnyContent(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

export function renderOperationalProfile({
  version,
}: {
  version: AgentOperationalProfileVersion;
}): RenderedProfile {
  // v3.1.1 contract (migration 061 + Codex review #163 rounds 1-3):
  //
  // The legacy 4-layer payload now lives directly inside profile_body —
  // `profile_body.core_immutable / .operational_profile / .episodic_temp /
  // .growth_backlog`. This is the ONLY shape the renderer needs to handle
  // at runtime. Both writers emit it:
  //   * `seedInitialOperationalProfile` (proposal-generator.ts) writes the
  //     direct-embed keys when seeding from maia-prompt.md + self_state.
  //   * `migration 061` backfills the same direct-embed keys when
  //     consolidating pre-v3.1.1 rows.
  //
  // schema.ts declares only `profile_body` on the Drizzle table, so a
  // production `.select().from(agent_operational_profile_versions)` returns
  // exactly that JSONB column. Reading the legacy keys from inside it is
  // the only path that reaches real rows.
  //
  // Two LOWER-PRIORITY fallbacks remain so older test fixtures keep
  // working (no production data takes these paths):
  //   * top-level row.core_immutable etc. — fixtures that hand-merge the
  //     keys onto the row instead of nesting under profile_body.
  //   * synthesized view from profile_body.identity.* — newly-created rows
  //     from admin-ui agents.create that have no legacy payload to mirror.
  const row = version as unknown as {
    profile_body?: {
      identity?: {
        role_descriptor?: unknown;
        voice?: { tone?: unknown };
        priorities?: unknown[];
      };
      core_immutable?: CoreImmutable;
      operational_profile?: OperationalProfileLayer;
      episodic_temp?: EpisodicTemp;
      growth_backlog?: GrowthBacklog;
    };
    core_immutable?: CoreImmutable;
    operational_profile?: OperationalProfileLayer;
    episodic_temp?: EpisodicTemp;
    growth_backlog?: GrowthBacklog;
  };

  const body = row.profile_body ?? {};

  // Synthesize a legacy-shaped view from canonical profile_body for rows
  // that have NO direct-embed legacy keys (rare — only newly-created
  // admin-ui rows that skipped the legacy_mirror writer).
  const synthesizedCore: CoreImmutable = {
    identity_block:
      typeof body.identity?.role_descriptor === 'string'
        ? body.identity.role_descriptor
        : undefined,
    principles: Array.isArray(body.identity?.priorities)
      ? body.identity!.priorities
      : undefined,
  };
  const synthesizedOp: OperationalProfileLayer = {
    voice_descriptor:
      typeof body.identity?.voice?.tone === 'string'
        ? body.identity.voice.tone
        : undefined,
  };

  // Priority order for each section:
  //   1. profile_body.* (the production path — proposal-generator + 061)
  //   2. top-level row.* (test fixtures / non-Drizzle paths)
  //   3. synthesized from profile_body.identity.* (pure-canonical fallback)
  function pickWithMirror<T extends object>(
    embedded: T | undefined,
    topVal: T | undefined,
    synthesized: T,
  ): T {
    if (embedded && hasAnyContent(embedded)) return embedded;
    if (topVal && hasAnyContent(topVal)) return topVal;
    return synthesized;
  }

  const core = pickWithMirror<CoreImmutable>(
    body.core_immutable,
    row.core_immutable,
    synthesizedCore,
  );
  const op = pickWithMirror<OperationalProfileLayer>(
    body.operational_profile,
    row.operational_profile,
    synthesizedOp,
  );
  const ep =
    (body.episodic_temp ?? row.episodic_temp ?? ({} as EpisodicTemp));
  const bk =
    (body.growth_backlog ?? row.growth_backlog ?? ([] as GrowthBacklog));

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

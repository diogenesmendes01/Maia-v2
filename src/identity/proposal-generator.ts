/**
 * P4 Task 5 — Proposal generator: seedInitialOperationalProfile.
 *
 * Esta é a ÚNICA situação onde criamos a primeira versão `active` do perfil
 * operacional. O caminho continua sendo `create+transition`: o `create` do
 * repo SEMPRE força `status='proposed'`; logo em seguida fazemos uma
 * `transition({ to: 'active' })` que respeita o invariant do partial unique
 * index (1 active por (tenant, agent)).
 *
 * Determinístico — sem chamada a LLM. Decompõe `src/identity/maia-prompt.md`
 * em 4 camadas:
 *   - core_immutable      ← seção "## Identidade" + "## Princípios" (intocável)
 *   - operational_profile ← seção "## Como você fala" + thresholds derivados de self_state
 *   - episodic_temp       ← {} (preenchido em runtime conforme conversa rola)
 *   - growth_backlog      ← [] (preenchido conforme propostas aprovadas)
 *
 * Idempotente: se já existe versão `active` para o (tenant, agent), retorna a
 * existente sem criar nada. Também trata a corrida em que outra propose ganhou
 * entre o `getActive()` inicial e a `transition` — nesse caso retorna a versão
 * vencedora com `reason: 'already_active'`.
 */
import { readFile } from 'node:fs/promises';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';
import type { AgentOperationalProfileVersion, ProfileBody, SelfState } from '@/db/schema.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';

export type ProposalGeneratorResult =
  | { created: true; version: AgentOperationalProfileVersion }
  | { created: false; existing: AgentOperationalProfileVersion; reason: 'already_active' };

const DEFAULT_PROMPT_PATH = 'src/identity/maia-prompt.md';

export async function seedInitialOperationalProfile(args?: {
  source_self_state?: SelfState | null;
  source_prompt_path?: string;
}): Promise<ProposalGeneratorResult> {
  // 1. Idempotency check up-front.
  const active = await operationalProfileVersionsRepo.getActive();
  if (active && active.status === 'active') {
    return { created: false, existing: active, reason: 'already_active' };
  }

  // 2. Ler o prompt-base (o conteúdo é o "source of truth" estático da
  //    identidade que o owner definiu).
  const path = args?.source_prompt_path ?? DEFAULT_PROMPT_PATH;
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `seed_prompt_unavailable: ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // 3. Quebrar em seções e montar as 4 camadas.
  const sections = parseMarkdownSections(content);
  const principles = parseNumberedList(
    sections.get('princípios') ?? sections.get('principios') ?? '',
  );
  const core_immutable = {
    identity_block: sections.get('identidade') ?? '',
    principles,
  };
  const thresholds = extractThresholdsFromSelf(args?.source_self_state) ?? {};
  const operational_profile = {
    voice_descriptor:
      sections.get('como você fala') ?? sections.get('como voce fala') ?? '',
    thresholds,
  };
  const episodic_temp: Record<string, unknown> = {};
  const growth_backlog: unknown[] = [];

  // P8d §3 — extrai priorities do mesmo markdown (Prioridades / Princípios)
  const priorities = parsePrioritiesFromSections(sections);

  // 4. Two-step seed: create defaults a proposed, depois transitiona pra active.
  // TODO(v3.1.1 migration): the legacy 4-layer shape (core_immutable +
  // operational_profile + episodic_temp + growth_backlog) was collapsed into
  // `profile_body`. We pack the legacy fields into profile_body via a non-
  // standard extension so existing renderer/detector code (which still reads
  // the legacy keys) keeps working at runtime. When all consumers move to the
  // new identity/style/metadata structure, this generator becomes the source
  // of truth for the migration.
  const profile_body = {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: core_immutable.identity_block,
      voice: { tone: '', formality: 'medium' as const, verbosity: 'medium' as const },
      cognitive_limits: {
        max_inference_depth: 0,
        max_speculation_in_response: 0,
        confidence_floor_for_action: 0,
      },
      priorities,
      learned_voice_modifiers: [],
    },
    style: { language: 'pt-BR', rhythm: {} },
    metadata: { effective_from: new Date().toISOString(), created_by: 'system_seed', previous_version_id: null },
    // legacy mirror for renderer/detector consumers (TODO migrate)
    core_immutable,
    operational_profile,
    episodic_temp,
    growth_backlog,
  } as unknown as ProfileBody;
  const created = await operationalProfileVersionsRepo.create({
    profile_body,
    proposed_by: 'system_seed',
    proposed_reason: 'initial seed from self_state + maia-prompt.md',
  });

  const r = await operationalProfileVersionsRepo.transition({
    id: created.id,
    to: 'active',
    approved_by: 'system_seed',
  });
  if (!r.ok) {
    // Corrida: outra propose foi promovida a active entre nosso getActive
    // inicial e a transition. Devolve a vencedora.
    if (r.reason === 'already_has_active') {
      const existing = await operationalProfileVersionsRepo.getActive();
      if (existing) return { created: false, existing, reason: 'already_active' };
    }
    throw new Error(`seed_transition_failed: ${r.reason}`);
  }
  return { created: true, version: r.updated };
}

function parseMarkdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Match "## Title" headers e captura tudo até o próximo "## " ou EOF.
  const regex = /^## ([^\n]+)\n([\s\S]*?)(?=^## |\Z)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const title = (m[1] ?? '').trim().toLowerCase();
    const body = (m[2] ?? '').trim();
    sections.set(title, body);
  }
  return sections;
}

function parseNumberedList(body: string): string[] {
  // Aceita dois formatos:
  //   "1. **Termo destacado.** resto da explicação"  → concatena
  //   "1. linha simples"                              → captura inteira
  // Linhas em branco ou que não casam o padrão numerado são ignoradas.
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const bold = line.match(/^\d+\.\s+\*\*([^*]+)\*\*(.*)$/);
    if (bold) {
      out.push(`${(bold[1] ?? '').trim()}${bold[2] ?? ''}`.trim());
      continue;
    }
    const plain = line.match(/^\d+\.\s+(.*)$/);
    if (plain) {
      out.push((plain[1] ?? '').trim());
    }
  }
  return out;
}

function extractThresholdsFromSelf(
  self: SelfState | null | undefined,
): Record<string, unknown> | undefined {
  if (!self?.resumo_aprendizados) return undefined;
  // Best-effort: leva o resumo + a versão legacy adiante. As fases seguintes
  // (P4 Task 7+) vão derivar thresholds estruturados via reflector.
  return { resumo: self.resumo_aprendizados, versao_legacy: self.versao };
}

// ============================================================================
// P8d §3 — priorities extraction (determinístico, sem LLM)
// ============================================================================

/**
 * Slug snake_case válido: começa com letra, [a-z0-9_], 3-80 chars.
 * Justifica `papel_drift` matching contra slugs.
 */
const PRIORITY_SLUG_RE = /^[a-z][a-z0-9_]{2,79}$/;

/**
 * Versão exportada — recebe o markdown bruto e devolve as prioridades
 * inferidas. Wrapper sobre `parsePrioritiesFromSections` para reuse pelo
 * script de migração de dados (§8) que precisa lidar com o markdown direto
 * de `maia-prompt.md`.
 *
 * Usa um parser local `parseAllSections` (lida corretamente com seção final
 * sem `## ` posterior, ao contrário de `parseMarkdownSections` que depende
 * de `\Z` PCRE-only).
 */
export function parsePrioritiesFromMarkdown(markdown: string): string[] {
  return parsePrioritiesFromSections(parseAllSections(markdown));
}

/**
 * Parser de seções `## Title` robusto a EOF — itera sobre headers achados,
 * captura o body de cada um até o próximo header ou fim do arquivo. Necessário
 * porque `parseMarkdownSections` (legado P4) usa `\Z` que não existe em JS regex
 * e por isso não captura a última seção.
 */
function parseAllSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headerRe = /^## ([^\n]+)$/gm;
  const headers: { title: string; bodyStart: number; headerStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    headers.push({
      title: (m[1] ?? '').trim().toLowerCase(),
      bodyStart: headerRe.lastIndex + 1, // skip newline after header
      headerStart: m.index,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const next = headers[i + 1];
    const body = content.slice(h.bodyStart, next ? next.headerStart : content.length).trim();
    sections.set(h.title, body);
  }
  return sections;
}

/**
 * Extrai prioridades dado o mapa de seções já parseado.
 * Ordem de precedência:
 *   1. ## Prioridades (lista numerada → slug)
 *   2. ## Princípios (primeiras 3 entradas → slugifyFirstSentence)
 * Filtra slugs malformados; respeita máx 5; devolve [] em qualquer falha.
 */
function parsePrioritiesFromSections(sections: Map<string, string>): string[] {
  const explicit = parseNumberedList(sections.get('prioridades') ?? '')
    .map((s) => slugify(s))
    .filter((s) => PRIORITY_SLUG_RE.test(s));
  if (explicit.length > 0) return explicit.slice(0, 5);

  const principles = parseNumberedList(
    sections.get('princípios') ?? sections.get('principios') ?? '',
  );
  return principles
    .slice(0, 3)
    .map((line) => slugifyFirstSentence(line))
    .filter((s) => PRIORITY_SLUG_RE.test(s));
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function slugifyFirstSentence(line: string): string {
  // Pega só a primeira sentença/oração (até `.` ou `,`).
  const head = line.split(/[.,]/)[0] ?? line;
  return slugify(head);
}

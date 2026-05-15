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
 * em um único `profile_body: ProfileBody` (v3.1.1) com 3 namespaces:
 *   - identity      ← role_descriptor, voice, cognitive_limits, priorities, learned_voice_modifiers
 *   - style         ← language, rhythm
 *   - metadata      ← effective_from, created_by, previous_version_id
 *
 * Idempotente: se já existe versão `active` para o (tenant, agent), retorna a
 * existente sem criar nada. Também trata a corrida em que outra propose ganhou
 * entre o `getActive()` inicial e a `transition` — nesse caso retorna a versão
 * vencedora com `reason: 'already_active'`.
 */
import { readFile } from 'node:fs/promises';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';
import type { AgentOperationalProfileVersion, ProfileBody, SelfState } from '@/db/schema.js';

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

  // 3. Quebrar em seções e montar profile_body v3.1.1.
  const sections = parseMarkdownSections(content);
  const principles = parseNumberedList(
    sections.get('princípios') ?? sections.get('principios') ?? '',
  );
  const identity_block = sections.get('identidade') ?? '';
  const voice_descriptor =
    sections.get('como você fala') ?? sections.get('como voce fala') ?? '';
  const thresholds = extractThresholdsFromSelf(args?.source_self_state) ?? {};

  const profile_body: ProfileBody = {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: identity_block,
      voice: {
        tone: voice_descriptor,
        formality: 'medium',
        verbosity: 'medium',
      },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      priorities: principles,
      learned_voice_modifiers: [],
    },
    style: {
      language: 'pt-BR',
      rhythm: thresholds,
    },
    metadata: {
      effective_from: new Date().toISOString(),
      created_by: 'system_seed',
      previous_version_id: null,
    },
  };

  // 4. Two-step seed: create defaults a proposed, depois transitiona pra active.
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

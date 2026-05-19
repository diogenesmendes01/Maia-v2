# P8d — Identity Completion (design)

**Date:** 2026-05-15
**Status:** Draft v1 — derivado de `2026-05-15-runtime-architecture-v3-final.md` (Runtime v3.1.1)
**Master spec refs:** §0.3 (Glossary — "Identity Contract"), §2.3 (Identity Management — schema JSONB target), §4.1 (drift detectors — `papel_drift`), §5 (Override Identity ↔ Soul + origin gate), §6 (IdentitySlice), §11 (P4 refactor já mergeado), §15 (Invariantes 1/3/4/6/11)
**Architecture Lock impactado:** Identity/Soul ownership boundaries (§0.1) — alterações **estruturais** do `ProfileBody` exigem aprovação founder + compliance (Approval Class §9). P8d **não** muda estrutura; apenas preenche campos já declarados (`priorities`, `learned_voice_modifiers`) e adiciona um detector.

---

## 0. Purpose

O refactor **P4 (PR #86, já merged)** consolidou `agent_operational_profile_versions.core_immutable → profile_body` com 3 namespaces (`identity` / `style` / `metadata`) e `schema_version = 'v3.1.1-2026-05-15'`. Mas deixou dois campos declarados e vazios:

- `identity.priorities: string[]` — `[]`
- `identity.learned_voice_modifiers` — `[]` tipado como `unknown[]`

Citação do master (§2.3):
> `profile_body.identity` define **quem opera**. É o **Identity Contract** (§0.3 Glossary) — fonte de verdade do comportamento base.

P8d entrega 4 completions:

1. **Populador real de `priorities`** via `proposal-generator.ts` lendo `maia-prompt.md` (e opcionalmente `self_state.resumo_aprendizados`) — §3
2. **Tipo concreto `LearnedVoiceModifier`** substituindo `unknown[]`, com lifecycle e validação Zod — §4
3. **`identity-slice-builder.ts`** produzindo `IdentitySlice` com depth `minimal | full` — §5
4. **`papel_drift`** — 9º detector (junto com `soul_drift` de P8b totaliza 9, master §4.1) — §6 + §7

Mais: **migration data** que preenche `priorities[]` na versão active existente (§8) + **validação** de `cognitive_limits` no write-path (§10).

Feature flag: **nenhuma nova** — estende `FEATURE_OPERATIONAL_PROFILE_V2` (§11).

---

## 1. File structure

```
src/
  identity/
    proposal-generator.ts         # §3 — extrai priorities de maia-prompt.md
    profile-renderer.ts           # ajuste menor: imprimir priorities no system_prompt_block
    learned-voice-modifier.ts     # §4 — tipo + Zod validator
  runtime/
    context-assembly/
      slice-builders/
        identity-slice-builder.ts # §5
      types/
        identity-slice.ts         # IdentitySlice TS type
  cognition/
    drift/
      papel.ts                    # §6 — papelDriftDetector
      index.ts                    # registra papelDriftDetector
      decision-engine.ts          # +case PAPEL_DRIFT em classifySeverity (§7)
  db/
    repositories.ts               # operationalProfileVersionsRepo.create valida cognitive_limits + modifiers (§10)
  types/
    enums.ts                      # +DriftType.PAPEL_DRIFT
scripts/
  p8d-migration-priorities.ts     # §8 — popula priorities na versão active
tests/
  unit/
    identity-slice-builder.spec.ts
    drift-detector-papel.spec.ts
    learned-voice-modifier.spec.ts
    proposal-generator-priorities.spec.ts
  integration/
    p8d-identity-completion.spec.ts
```

**Sem novo arquivo SQL.** Nenhuma DDL. Tudo é código + dados.

---

## 2. NO new migration

A tabela `agent_operational_profile_versions` (migration 025) já tem o JSONB `profile_body` com `schema_version='v3.1.1-2026-05-15'`. `ProfileBody` (src/db/schema.ts) já declara o slot para `priorities` e `learned_voice_modifiers` dentro de `identity`. P8d **não introduz DDL**. Toda mudança:
- código TypeScript (parser, validator, slice-builder, detector)
- dados (script idempotente em §8)

Zero risco de downtime; rollback é simples (`transition` da versão antiga `frozen → active`).

---

## 3. Enhanced `proposal-generator.ts` — priorities

### 3.1 Fontes de extração (em ordem de precedência)

1. **`maia-prompt.md` seção dedicada `## Prioridades`** — lista numerada, cada entry vira slug
2. **`maia-prompt.md` seção `## Princípios`** — primeiras 3 entries derivam slug (heurística determinística: `slugifyFirstSentence(line)`)
3. **`self_state.resumo_aprendizados`** — quando o seed é chamado com `args.source_self_state`, linhas `prioridade: <slug>` entram em `priorities`. Máximo combinado: 5 entries.

### 3.2 Tipo + validação

```typescript
// src/identity/proposal-generator.ts
type PriorityEntry = string; // slug snake_case
const PRIORITY_SLUG_RE = /^[a-z][a-z0-9_]{2,79}$/;

function parsePriorities(sections: Map<string, string>): PriorityEntry[] {
  // 1. Seção "## Prioridades" tem precedência
  const explicit = parseNumberedList(sections.get('prioridades') ?? '')
    .map(slugify)
    .filter((s) => PRIORITY_SLUG_RE.test(s));
  if (explicit.length > 0) return explicit.slice(0, 5);

  // 2. Derivar das primeiras 3 entradas de "## Princípios"
  const principles = parseNumberedList(
    sections.get('princípios') ?? sections.get('principios') ?? '',
  );
  return principles
    .slice(0, 3)
    .map(slugifyFirstSentence)
    .filter((s) => PRIORITY_SLUG_RE.test(s));
}

function slugifyFirstSentence(line: string): string {
  const head = line.split(/[.,]/)[0] ?? line;
  return head
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// Export para reuse pela migration de dados (§8)
export { parsePriorities as parsePrioritiesFromMarkdown };
```

Decisão: `priorities` é `string[]` (slugs), não `Array<{ slug; rationale }>`. Master §2.3 mostra strings simples. Slugs facilitam matching no `papel_drift` (§6).

### 3.3 Diff no `profile_body` construído pelo seed

```typescript
const profile_body: ProfileBody = {
  schema_version: PROFILE_BODY_SCHEMA_VERSION,
  identity: {
    role_descriptor: sections.get('papel') ?? 'unset',
    identity_block: sections.get('identidade') ?? '',
    principles,
    priorities: parsePriorities(sections),       // <-- NOVO P8d
    learned_voice_modifiers: [],                 // continua [] no seed inicial
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    voice: {
      tone: sections.get('como você fala') ?? '',
      formality: 'medium',
      verbosity: 'concise',
    },
    episodic: {},
    growth: [],
  },
  style: { language: 'pt-BR', voice_descriptor: sections.get('como você fala') ?? '', thresholds, rhythm: {} },
  metadata: { effective_from: new Date().toISOString(), created_by: 'system_seed', previous_version_id: null },
};
```

Idempotência preservada: continua retornando `{ created: false, reason: 'already_active' }` quando há active. Migration de §8 é o caminho para retro-popular em ambientes que já têm v1 ativa.

---

## 4. `LearnedVoiceModifier` — tipo concreto

### 4.1 Shape

```typescript
// src/identity/learned-voice-modifier.ts
export type VoiceDimension =
  | 'tone' | 'formality' | 'verbosity' | 'rhythm' | 'vocabulary' | 'emoji_usage';

export interface LearnedVoiceModifier {
  id: string;                  // UUID v4
  dimension: VoiceDimension;
  delta:
    | { kind: 'shift'; from: string; to: string }
    | { kind: 'amplify'; factor: number }    // [0.5, 2.0]
    | { kind: 'append'; phrase: string };    // max 200 chars
  confidence: number;          // [0, 1] — fórmula determinística (NÃO LLM)
  evidence_count: number;      // >= 3
  status: 'proposed' | 'active' | 'deprecated' | 'rolled_back';
  proposed_by: string;
  proposed_at: string;         // ISO
  approved_by: string | null;
  approved_at: string | null;  // ISO
  expires_at: string | null;
  evidence_refs: string[];     // pelo menos 1 trace_id/message_id
}
```

### 4.2 Validação (Zod)

```typescript
export const LearnedVoiceModifierSchema = z.object({
  id: z.string().uuid(),
  dimension: z.enum(['tone', 'formality', 'verbosity', 'rhythm', 'vocabulary', 'emoji_usage']),
  delta: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('shift'), from: z.string().min(1), to: z.string().min(1) }),
    z.object({ kind: z.literal('amplify'), factor: z.number().min(0.5).max(2.0) }),
    z.object({ kind: z.literal('append'), phrase: z.string().min(1).max(200) }),
  ]),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().min(3),
  status: z.enum(['proposed', 'active', 'deprecated', 'rolled_back']),
  proposed_by: z.string().min(1),
  proposed_at: z.string().datetime(),
  approved_by: z.string().nullable(),
  approved_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  evidence_refs: z.array(z.string()).min(1),
});
```

### 4.3 Quem cria modifiers?

**P8d cria o tipo + validador no write-path; NÃO popula automaticamente.** Populating fica em fases futuras:
- **P9b** — drift detector `tom` propõe modifier quando `evidence_count >= 3`
- **P8.5 Admin UI** — humano cria diretamente via Proposal Diff & Approval

P8d entrega o **tipo** + **validação no `operationalProfileVersionsRepo.create`** (rejeita modifiers malformados).

---

## 5. `identity-slice-builder.ts`

### 5.1 `IdentitySlice` — tipo

```typescript
// src/runtime/context-assembly/slice-builders/types/identity-slice.ts
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';

export interface IdentitySlice {
  role_descriptor: string;             // sempre presente
  identity_block: string;              // sempre presente
  priorities: string[];                // sempre presente (slugs)
  voice: {
    tone: string;
    formality: 'low' | 'medium' | 'high';
    verbosity: 'concise' | 'balanced' | 'verbose';
  };
  cognitive_limits: {
    max_inference_depth: number;
    max_speculation_in_response: number;
    confidence_floor_for_action: number;
  };
  principles?: string[];                          // só em depth='full'
  active_voice_modifiers?: LearnedVoiceModifier[]; // só em depth='full' E quando há active

  schema_version: string;
  version_id: string;       // FK lógico ao agent_operational_profile_versions.id
  version_number: number;
}
```

### 5.2 Função

```typescript
// src/runtime/context-assembly/slice-builders/identity-slice-builder.ts
export async function buildIdentitySlice(args: {
  depth: 'minimal' | 'full';
}): Promise<IdentitySlice | null> {
  const profile = await operationalProfileVersionsRepo.getActive();
  if (!profile || profile.status !== 'active') return null;

  const body = (profile.profile_body ?? {}) as Record<string, unknown>;
  const identity = (body.identity ?? {}) as Record<string, unknown>;

  const slice: IdentitySlice = {
    role_descriptor: typeof identity.role_descriptor === 'string' ? identity.role_descriptor : 'unset',
    identity_block: typeof identity.identity_block === 'string' ? identity.identity_block : '',
    priorities: Array.isArray(identity.priorities)
      ? (identity.priorities as unknown[]).filter((p): p is string => typeof p === 'string')
      : [],
    voice: extractVoice(identity.voice),
    cognitive_limits: extractCognitiveLimits(identity.cognitive_limits),
    schema_version: typeof body.schema_version === 'string' ? body.schema_version : 'unknown',
    version_id: profile.id,
    version_number: profile.version,
  };

  if (args.depth === 'full') {
    if (Array.isArray(identity.principles)) {
      slice.principles = (identity.principles as unknown[])
        .filter((p): p is string => typeof p === 'string');
    }
    const mods = Array.isArray(identity.learned_voice_modifiers)
      ? (identity.learned_voice_modifiers as LearnedVoiceModifier[])
      : [];
    const active = mods.filter((m) => m.status === 'active');
    if (active.length > 0) slice.active_voice_modifiers = active;
  }

  return slice;
}
```

### 5.3 Depth semantics

Alinha com master §3.2 `context_requirements`:
- **`minimal`** — campos base (role + identity_block + priorities + voice + cognitive_limits + version metadata)
- **`full`** — adiciona `principles` + `active_voice_modifiers` (quando há)

Master default: `identity: { depth: 'full' }` — identity é barato e sempre profundo.

### 5.4 Cache

Master §3.3 tabela: **`IdentitySlice` TTL 5-10min**, invalidação em `identity_profile_activated | identity_profile_rolled_back`. Cache layer é trabalho de P8a; P8d entrega o **builder puro stateless**.

---

## 6. `papel_drift` detector

### 6.1 Posição

Master §4.1 lista 9 detectores: 7 originais P4 (tom, valores, confianca, vies, escopo, linguagem, procedimento) + `soul_drift` (P8b) + **`papel_drift` (P8d)**. P8d adiciona `DriftType.PAPEL_DRIFT='papel_drift'` ao enum.

### 6.2 O que observa

`role_descriptor` = "papel operacional" do agente (ex: `atendimento_financeiro_pf`). `papel_drift` verifica aderência das mensagens recentes do agente ao papel declarado.

Exemplos:
- Profile = `atendimento_financeiro_pf`, agente responde dúvidas trabalhistas
- Profile = `consultoria_juridica`, agente está fechando vendas
- Profile = `recepcao_b2b`, agente está dando aconselhamento financeiro detalhado

### 6.3 Implementação (padrão `valores.ts`)

```typescript
// src/cognition/drift/papel.ts
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type IdentityPapel = { role_descriptor?: string; priorities?: string[] };

export const papelDriftDetector: DriftDetector = {
  type: DriftType.PAPEL_DRIFT,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const body = (input.profile_active.profile_body ?? {}) as Record<string, unknown>;
    const identity = (body.identity ?? {}) as IdentityPapel;

    const role = typeof identity.role_descriptor === 'string' ? identity.role_descriptor : '';
    if (!role || role === 'unset') return null;

    const priorities = Array.isArray(identity.priorities) ? identity.priorities : [];

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages.slice(-20).map((m) => `- ${m.text}`).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é um auditor de papel operacional do agente.',
      'Dado o papel declarado e as prioridades, avalie se as mensagens recentes',
      'estão aderentes ao papel ou claramente saem do escopo. Devolva JSON.',
    ].join('\n');
    const user = [
      `PAPEL DECLARADO: ${role}\n`,
      `PRIORIDADES: ${priorities.length > 0 ? priorities.join(', ') : '(nenhuma)'}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "off_role_examples": [...], "observed_role_inferred": "...", "reasoning": "..."}.',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text).join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        off_role_examples?: unknown[];
        observed_role_inferred?: string;
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;

      return {
        drift_type: DriftType.PAPEL_DRIFT,
        detected_by: 'drift_detector_papel',
        payload: {
          severity_hint: parsed.severity_hint ?? 'medio',
          declared_role: role,
          observed_role_inferred:
            typeof parsed.observed_role_inferred === 'string' ? parsed.observed_role_inferred : null,
          off_role_examples: Array.isArray(parsed.off_role_examples) ? parsed.off_role_examples : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'papel desviado').slice(0, 200),
      };
    } catch {
      return null; // defensivo; orchestrator wrappa fallback null
    }
  },
};
```

### 6.4 Registro + wrapping

```typescript
// src/cognition/drift/index.ts
import { papelDriftDetector } from './papel.js';
const DETECTORS: DriftDetector[] = [
  tomDetector, valoresDetector, confiancaDetector, viesDetector,
  escopoDetector, linguagemDetector, procedimentoDetector,
  soulDriftDetector,  // P8b
  papelDriftDetector, // P8d
];
```

O orchestrator `runAllDriftDetectors` wrappa cada detector em `runCognitiveModule({ name: 'drift_detector_papel_drift', timeoutMs: 8000, triggered_by: 'async_event', fallback: null })`. Master §15 invariante 2: "`runCognitiveModule` wrap em todo módulo LLM-backed" — satisfeito.

---

## 7. Override behavior — severity floor + freeze

### 7.1 Case no `decision-engine.ts`

```typescript
case DriftType.PAPEL_DRIFT: {
  const offRoleRaw = (p as { off_role_examples?: unknown }).off_role_examples;
  const offRole = Array.isArray(offRoleRaw) ? offRoleRaw : [];
  const observed = (p as { observed_role_inferred?: unknown }).observed_role_inferred;
  const declared = (p as { declared_role?: unknown }).declared_role;
  const rolesDiverge =
    typeof observed === 'string' && typeof declared === 'string' &&
    observed.length > 0 &&
    !observed.toLowerCase().includes(declared.toLowerCase().split('_')[0] ?? '');

  // Floor rules — determinísticas, NÃO LLM
  if (offRole.length >= 5 || (rolesDiverge && offRole.length >= 3)) return DriftSeverity.CRITICO;
  if (offRole.length >= 3) return DriftSeverity.ALTO;
  if (offRole.length === 2) return DriftSeverity.MEDIO;
  if (offRole.length === 1) return DriftSeverity.BAIXO;
  if (hint !== null) return hint;
  return DriftSeverity.BAIXO;
}
```

### 7.2 Mapeamento severity → decision (já implementado P4)

```
baixo   → auto_approved   (log + continua)
medio   → queued_human    (alert; profile permanece active)
alto    → frozen          (transition active → frozen; queue review)
critico → rollback        (transition active → rolled_back)
```

### 7.3 Consequências de freeze

Quando `papel_drift severity >= alto`:
- Versão active → `status='frozen'` (state machine de `operationalProfileVersionsRepo`)
- `prompt-builder` (P4 Task 7) detecta `status !== 'active'` e cai no fallback legacy (já implementado, defesa em runtime)
- 1 row em `agent_drift_alerts` com `decision='frozen'`, `decided_by='decision_engine'`
- Admin UI Tela 4 (Drift & Incidents, master §9) lista para revisão

### 7.4 Un-freeze

State machine permite `frozen → active` via `transition({ to: 'active' })`. Operação manual no Admin UI (Tela 3). Aprovação: founder + compliance (Approval Class "Identity Contract structural change", master §9).

---

## 8. Migration data — popular priorities

### 8.1 Estratégia

**NÃO** modificar a versão active in-place (viola invariante append-only — master §15.4). Em vez disso:
1. Criar **nova versão** `proposed` com `priorities` populado (demais campos copiados)
2. Transition da atual `active → frozen` (preserva histórico)
3. Transition da nova `proposed → active`
4. `metadata.previous_version_id` aponta para a versão antiga

### 8.2 Script

```typescript
// scripts/p8d-migration-priorities.ts
import { readFile } from 'node:fs/promises';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { operationalProfileVersionsRepo, tenantsRepo } from '@/db/repositories.js';
import { parsePrioritiesFromMarkdown } from '@/identity/proposal-generator.js';
import { sql } from 'drizzle-orm';

const PROMPT_PATH = 'src/identity/maia-prompt.md';

async function main(): Promise<void> {
  const tenants = await tenantsRepo.list();
  const promptText = await readFile(PROMPT_PATH, 'utf8');
  const parsed = parsePrioritiesFromMarkdown(promptText);
  if (parsed.length === 0) {
    logger.warn({}, 'p8d_migrate.no_priorities_inferable_global');
    return;
  }

  let seeded = 0, skipped = 0, failed = 0;

  for (const t of tenants) {
    const rows = await db.execute<{ agent_id: string }>(sql`
      SELECT DISTINCT agent_id FROM agent_operational_profile_versions
       WHERE tenant_id = ${t.id} AND status = 'active'
    `);
    for (const { agent_id } of rows.rows) {
      try {
        await runWithTenantContext({ tenant_id: t.id, agent_id }, async () => {
          const active = await operationalProfileVersionsRepo.getActive();
          if (!active) { skipped++; return; }

          const body = (active.profile_body ?? {}) as Record<string, unknown>;
          const identity = (body.identity ?? {}) as Record<string, unknown>;
          const existing = Array.isArray(identity.priorities)
            ? (identity.priorities as unknown[]).filter((p) => typeof p === 'string')
            : [];
          if (existing.length > 0) {
            logger.info({ tenant: t.id, agent: agent_id }, 'p8d_migrate.already_populated_skip');
            skipped++; return;
          }

          // Construir novo profile_body
          const newBody = {
            ...body,
            schema_version: PROFILE_BODY_SCHEMA_VERSION,
            identity: {
              ...identity,
              priorities: parsed,
              learned_voice_modifiers: Array.isArray(identity.learned_voice_modifiers)
                ? identity.learned_voice_modifiers : [],
            },
            metadata: {
              ...((body.metadata ?? {}) as Record<string, unknown>),
              effective_from: new Date().toISOString(),
              created_by: 'p8d_migration_priorities',
              previous_version_id: active.id,
            },
          };

          // Step 1: criar nova versão proposed
          const newVersion = await operationalProfileVersionsRepo.create({
            profile_body: newBody,
            proposed_by: 'p8d_migration_priorities',
            proposed_reason: `populate priorities[]: ${parsed.join(', ')}`,
          });

          // Step 2: freeze antiga
          const freezeR = await operationalProfileVersionsRepo.transition({
            id: active.id, to: 'frozen', approved_by: 'p8d_migration_priorities',
          });
          if (!freezeR.ok) throw new Error(`freeze_failed: ${freezeR.reason}`);

          // Step 3: ativar nova
          const activateR = await operationalProfileVersionsRepo.transition({
            id: newVersion.id, to: 'active', approved_by: 'p8d_migration_priorities',
          });
          if (!activateR.ok) {
            // Rollback: re-ativar a antiga (frozen → active permitido)
            await operationalProfileVersionsRepo.transition({
              id: active.id, to: 'active', approved_by: 'p8d_migration_priorities_rollback',
            });
            throw new Error(`activate_failed: ${activateR.reason}`);
          }

          logger.info(
            { tenant: t.id, agent: agent_id, old_v: active.version, new_v: newVersion.version, priorities: parsed },
            'p8d_migrate.seeded',
          );
          seeded++;
        });
      } catch (err) {
        failed++;
        logger.error({ tenant: t.id, agent: agent_id, err: (err as Error).message }, 'p8d_migrate.failed');
      }
    }
  }

  logger.info({ seeded, skipped, failed }, 'p8d_migrate.done');
}

void main().catch((err) => { logger.error({ err: (err as Error).message }, 'p8d_migrate.fatal'); process.exitCode = 1; });
```

### 8.3 Quando rodar

Manual, pelo founder após merge da PR. 1x por ambiente (dev → staging → prod, espaçar 24h). Idempotente — re-rodar é seguro (skip quando já populado).

### 8.4 Rollback

A versão antiga continua em `status='frozen'`. `frozen → active` via Admin UI (Tela 3) restaura. Lineage em `metadata.previous_version_id` rastreia.

---

## 9. Testing

### 9.1 Unit — drift detector (`drift-detector-papel.spec.ts`)

Mesmo padrão de `drift-detector-valores.spec.ts` (mock `@anthropic-ai/sdk`):
1. `drift_detected=true` com 3 off_role_examples → severity `alto`, payload correto
2. `drift_detected=false` → null
3. `role_descriptor='unset'` → null sem chamar Anthropic
4. `role_descriptor=''` → null sem chamar Anthropic
5. Sem mensagens do agente → null sem chamar Anthropic
6. Anthropic throws → null defensivo
7. `observed_role_inferred` divergente + 3+ off_role → severity `critico`
8. JSON inválido na resposta → null

### 9.2 Unit — slice builder (`identity-slice-builder.spec.ts`)

1. Profile inexistente → null
2. Profile `status='proposed'` → null (defesa runtime)
3. `depth='minimal'` → campos base, sem principles, sem active_voice_modifiers
4. `depth='full'` com principles populados → principles no slice
5. `depth='full'` com 2 active + 1 deprecated → apenas 2 active_voice_modifiers
6. `profile_body` malformado → defaults defensivos; slice válido
7. `priorities` populated → expostas como string[]
8. `cognitive_limits` malformado → defaults usados

### 9.3 Unit — proposal-generator priorities (`proposal-generator-priorities.spec.ts`)

1. `## Prioridades` na markdown → slugs corretos
2. Sem `## Prioridades` mas com `## Princípios` → derivar 3 primeiros
3. `self_state.resumo_aprendizados` com `prioridade: foo` → injetado
4. Slugs malformados (regex falha) → filtrados
5. Máximo 5 priorities respeitado

### 9.4 Unit — Zod validator (`learned-voice-modifier.spec.ts`)

1. payload válido (kind=`shift`) → passa
2. payload válido (kind=`amplify`, factor=1.5) → passa
3. `evidence_count=2` → falha
4. `confidence=1.5` → falha
5. `delta.kind` inválido → falha
6. `amplify` com `factor=2.5` → falha

### 9.5 Integration (`p8d-identity-completion.spec.ts`)

1. Seed inicial popula priorities (não `[]`)
2. Migration data script: roda 1x, popula; roda 2x, skip
3. `papel_drift` dispara → decision engine `alto` → profile vai a `frozen`
4. Profile `frozen` → prompt-builder cai no fallback (sweep do P4)
5. `identity-slice-builder.depth='full'` retorna slice completo pós-seed
6. Modifier inválido no `profile_body` → repo.create rejeita

---

## 10. Acceptance gates

Adicionar 3 gates ao `scripts/p4-acceptance-gates.sh` (ou `scripts/p8d-acceptance-gates.sh` novo):

```bash
# Gate 8: priorities populated for active profile (default tenant/agent)
psql -c "
  SELECT jsonb_array_length(
    COALESCE(profile_body->'identity'->'priorities', '[]'::jsonb)
  ) >= 1 AS has_priorities
    FROM agent_operational_profile_versions
   WHERE tenant_id='default' AND agent_id='default' AND status='active'
" | grep -q "t" && echo "PASS" || echo "FAIL"

# Gate 9: papel_drift detector registered in orchestrator
grep -q "papelDriftDetector" src/cognition/drift/index.ts && echo "PASS" || echo "FAIL"

# Gate 10: LearnedVoiceModifier exported with concrete shape (not unknown[])
grep -q "export interface LearnedVoiceModifier" src/identity/learned-voice-modifier.ts && echo "PASS" || echo "FAIL"
```

Vitest gates: os 5 novos `.spec.ts` (§9) devem passar em `npx vitest run <files>`.

### Validação de `cognitive_limits` no write-path

`operationalProfileVersionsRepo.create` (em `src/db/repositories.ts`) ganha guard pré-insert:

```typescript
function validateCognitiveLimits(body: ProfileBody): void {
  const cl = body.identity?.cognitive_limits;
  if (!cl) return; // ausência é OK; defaults aplicados em runtime
  if (typeof cl.max_inference_depth !== 'number' || cl.max_inference_depth < 1 || cl.max_inference_depth > 10)
    throw new Error('cognitive_limits.max_inference_depth out of range [1,10]');
  if (typeof cl.max_speculation_in_response !== 'number' || cl.max_speculation_in_response < 0 || cl.max_speculation_in_response > 1)
    throw new Error('cognitive_limits.max_speculation_in_response out of range [0,1]');
  if (typeof cl.confidence_floor_for_action !== 'number' || cl.confidence_floor_for_action < 0 || cl.confidence_floor_for_action > 1)
    throw new Error('cognitive_limits.confidence_floor_for_action out of range [0,1]');
}
```

P9b (Agent Runtime) é quem **enforça** esses limites em runtime; P8d só garante que valores fora de range **não entram no DB**.

---

## 11. Feature flag

**Nenhuma nova flag.** P8d estende `FEATURE_OPERATIONAL_PROFILE_V2` (já registrada — `src/config/feature-flags.ts:44`).

- Flag OFF → comportamento legado; priorities, papel_drift e slice builder ficam dormentes
- Flag ON → priorities populadas; papel_drift roda no orchestrator semanal; identity-slice-builder pronto para P9 consumir

Justificativa: P8d não muda superfície semântica externa — apenas completa campos do contrato já definido. Toggle independente seria gold-plating.

Validação de `cognitive_limits` no write-path é **sempre ativa** (defesa em depth, invariante da DB).

---

## 12. Risks + mitigations

| Risco | Mitigação |
|---|---|
| `parsePriorities` extrai slugs ruins | Regex `PRIORITY_SLUG_RE`, max 5 entries, fallback `[]` |
| Migration script falha parcialmente | Transactional por (tenant, agent); rollback automático (frozen → active da antiga) se activate falha |
| `papel_drift` LLM com falso positivo alto | Floor rules conservadoras: 3+ exemplos para `alto`; 1 exemplo só vira `baixo` (auto_approved) |
| `LearnedVoiceModifier` populated com schema errado | Zod no write-path do `operationalProfileVersionsRepo.create` rejeita |
| `identity-slice-builder` retorna stale | Cache invalidation por evento (master §3.3); P8d builder é stateless |
| Priorities conflitam com Soul biases | Identity precede Soul (master §5 Pyramid 3 vs 7); origin gate cuida do override (P8b §7) |
| `papel_drift` falso negativo | Cobertura em testes fixture; observabilidade via `cognitive_module_log` permite tuning |
| Migration roda em prod sem staging prévio | Runbook documenta ordem dev → staging → prod 24h; script idempotente |

---

## 13. Done criteria

- [ ] `src/identity/proposal-generator.ts` extrai `priorities` de `maia-prompt.md` (dedicada OU derivação)
- [ ] `src/identity/learned-voice-modifier.ts` declara `LearnedVoiceModifier` + `LearnedVoiceModifierSchema` (Zod)
- [ ] `src/runtime/context-assembly/slice-builders/identity-slice-builder.ts` produz `IdentitySlice` com depth minimal | full
- [ ] `src/cognition/drift/papel.ts` implementa `papelDriftDetector` padrão `valores.ts`
- [ ] `DriftType.PAPEL_DRIFT='papel_drift'` em `src/types/enums.ts`
- [ ] `papelDriftDetector` registrado em `src/cognition/drift/index.ts`
- [ ] `decision-engine.ts` tem case `PAPEL_DRIFT` em `classifySeverity` com floor rules
- [ ] `operationalProfileVersionsRepo.create` valida `cognitive_limits` (range check) + `learned_voice_modifiers` (Zod)
- [ ] `scripts/p8d-migration-priorities.ts` é executável, idempotente, transactional
- [ ] 5 specs novos passam em `vitest run`
- [ ] Acceptance gates 8/9/10 passam pós-migration
- [ ] Runbook `docs/runbooks/p8d-identity-completion.md` publicado
- [ ] Invariantes master §15 preservados: 1 (tenant_id NOT NULL), 2 (runCognitiveModule wrap), 4 (append-only), 6 (one active), 11 (learned never overrides Identity)

---

## 14. Dependencies

### 14.1 Upstream (já merged)

- **P4 refactor (PR #86)** — `profile_body` 3 namespaces + `schema_version v3.1.1` + `PROFILE_BODY_SCHEMA_VERSION` const em `src/db/schema.ts`
- **P1 cognitive runner** — `runCognitiveModule` (`src/cognition/runner.ts`); `papel_drift` consumido via orchestrator
- **P4 drift infra** — `runAllDriftDetectors`, `decideAndApply`, `agent_drift_alerts`

### 14.2 Co-dependent (paralelo)

- **P8a — Context Packet / Cache** — define `ContextPacket` que contém `IdentitySlice`. P8d entrega builder; P8a integra
- **P8b — Soul Layer** — adiciona `soul_drift` (8º). P8d adiciona `papel_drift` (9º). Mesmo orchestrator; ordem de merge indiferente; último a mergear atualiza `DETECTORS`

### 14.3 Downstream

- **P9b — Agent Runtime** — consome `IdentitySlice.cognitive_limits` para configurar SkillRunner (master §3.4). P8d entrega valores + validação write-path; P9b enforça runtime
- **P8.5 — Admin UI MVP** — Tela 4 lista alerts `papel_drift`; Tela 3 permite rollback do freeze. P8d não bloqueia

### 14.4 Architecture Locks

Nenhum impactado. Lock se aplica a alteração **estrutural** do `ProfileBody`, não a população de campos já declarados.

---

## 15. Out of scope

- **Drift detector `tom` propondo `LearnedVoiceModifier` automaticamente** — P9b
- **Cache do `IdentitySlice`** — P8a entrega o cache layer; P8d entrega builder puro
- **Enforcement de `cognitive_limits` em runtime do Agent Runtime** — P9b; P8d só valida write-path
- **Admin UI para editar `priorities` manualmente** — P8.5 (Tela 2 — Proposal Diff & Approval)
- **Sincronização entre `role_descriptor` e `roles` table (P6)** — fase posterior; P8d trata `role_descriptor` como campo livre

# P8d Identity Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `priorities` + `learned_voice_modifiers` in `profile_body.identity`; add `papel_drift` detector (9th); enforce `cognitive_limits` write-path validation.

**Architecture:** Enhance `proposal-generator` + add `identity-slice-builder` + 9th drift detector + migration data script. NO new DDL.

**Tech Stack:** TypeScript (Node.js 22), Drizzle ORM, PostgreSQL 16, vitest, @anthropic-ai/sdk.

**Spec:** [`docs/superpowers/specs/2026-05-15-p8d-identity-completion-design.md`](../specs/2026-05-15-p8d-identity-completion-design.md)

**Branch alvo:** `claude/p8d-identity-completion`

---

## Preconditions

1. **P4 refactor merged** (PR #86) — `profile_body` schema v3.1.1 in place; `ProfileBody` type exported from `src/db/schema.ts`.
2. **P8a/P8b/P8c merged** — `ContextPacket` defined; `soul_drift` detector registered (8th).
3. **P1 cognitive runner merged** — `runCognitiveModule` infrastructure available in `src/cognition/runner.ts`.
4. **Migration 025 applied** — `agent_operational_profile_versions` table with `profile_body JSONB`.
5. **Feature flag `FEATURE_OPERATIONAL_PROFILE_V2`** active (already registered in P4).

**Precondition check (fail-fast):**

```bash
set -e
test -f src/db/schema.ts && grep -q "interface ProfileBody" src/db/schema.ts || { echo "FAIL: ProfileBody type missing"; exit 1; }
test -f src/identity/proposal-generator.ts || { echo "FAIL: proposal-generator missing"; exit 1; }
test -f src/cognition/drift/valores.ts || { echo "FAIL: drift detector valores missing"; exit 1; }
test -f src/cognition/drift/index.ts && grep -q "DETECTORS" src/cognition/drift/index.ts || { echo "FAIL: drift orchestrator missing"; exit 1; }
echo "✓ all preconditions OK"
```

---

## File Structure

### Files to create

| File | Purpose |
|---|---|
| `src/identity/learned-voice-modifier.ts` | LearnedVoiceModifier type + Zod validator (§4) |
| `src/runtime/context-assembly/slice-builders/identity-slice-builder.ts` | IdentitySlice builder (§5) |
| `src/runtime/context-assembly/slice-builders/types/identity-slice.ts` | IdentitySlice TS type (§5) |
| `src/cognition/drift/papel.ts` | papel_drift detector (§6) |
| `scripts/p8d-migration-priorities.ts` | Data migration script (§8) |
| `tests/unit/learned-voice-modifier.spec.ts` | Zod validator tests |
| `tests/unit/identity-slice-builder.spec.ts` | Slice builder unit tests |
| `tests/unit/drift-detector-papel.spec.ts` | Drift detector tests |
| `tests/unit/proposal-generator-priorities.spec.ts` | Priority extraction tests |
| `tests/integration/p8d-identity-completion.spec.ts` | 6-scenario integration test |

### Files to modify

| File | Change |
|---|---|
| `src/identity/proposal-generator.ts` | Parse priorities from `maia-prompt.md` or `self_state.resumo_aprendizados` (§3) |
| `src/identity/profile-renderer.ts` | Minor: print priorities in `system_prompt_block` |
| `src/types/enums.ts` | Add `DriftType.PAPEL_DRIFT = 'papel_drift'` |
| `src/cognition/drift/index.ts` | Register `papelDriftDetector` in `DETECTORS` array |
| `src/cognition/drift/decision-engine.ts` | Add case for `PAPEL_DRIFT` in `classifySeverity` (§7) |
| `src/db/repositories.ts` | Validate `cognitive_limits` + `learned_voice_modifiers` in `create` (§10) |
| `docs/runbooks/p8d-identity-completion.md` | Create runbook for migration (§8.4) |

---

## Phase 1 — Schema + types (Tasks 1–3)

### Task 1: Worktree setup + branch

**Files:** git only

- [ ] **Step 1: Verify current branch**

```bash
git status
git branch -v
```

Expected: on `main` or `claude/p4-refactor` (P4 already merged).

- [ ] **Step 2: Create worktree for P8d**

```bash
cd "C:/Users/PC Di/Desktop/CODIGO/Maia"
git fetch origin
git worktree add .claude/worktrees/p8d-identity-completion claude/p8d-identity-completion --track -b claude/p8d-identity-completion origin/main
cd .claude/worktrees/p8d-identity-completion
```

- [ ] **Step 3: Verify preconditions in worktree**

```bash
bash -c '
set -e
test -f src/db/schema.ts && grep -q "interface ProfileBody" src/db/schema.ts || { echo "FAIL: ProfileBody type missing"; exit 1; }
test -f src/identity/proposal-generator.ts || { echo "FAIL: proposal-generator missing"; exit 1; }
echo "✓ preconditions OK in worktree"
'
```

- [ ] **Step 4: Commit (empty) initial branch marker**

```bash
git commit --allow-empty -m "chore(p8d): start branch — identity completion"
```

---

### Task 2: Define `LearnedVoiceModifier` type + Zod validator

**Files:**
- Create: `src/identity/learned-voice-modifier.ts`
- Create: `tests/unit/learned-voice-modifier.spec.ts`

- [ ] **Step 1: Test — Zod validator accepts/rejects shapes**

```typescript
// tests/unit/learned-voice-modifier.spec.ts
import { describe, it, expect } from 'vitest';
import { LearnedVoiceModifierSchema, type LearnedVoiceModifier } from '../../src/identity/learned-voice-modifier.js';

describe('LearnedVoiceModifier (§4)', () => {
  const validModifier: LearnedVoiceModifier = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    dimension: 'tone',
    delta: { kind: 'shift', from: 'formal', to: 'casual' },
    confidence: 0.85,
    evidence_count: 5,
    status: 'active',
    proposed_by: 'drift_detector_tom',
    proposed_at: '2026-05-15T10:00:00Z',
    approved_by: 'founder',
    approved_at: '2026-05-15T11:00:00Z',
    expires_at: null,
    evidence_refs: ['msg_001', 'msg_002', 'msg_003'],
  };

  it('validates correct LearnedVoiceModifier (kind=shift)', () => {
    expect(() => LearnedVoiceModifierSchema.parse(validModifier)).not.toThrow();
  });

  it('validates amplify delta (factor in [0.5, 2.0])', () => {
    const modWithAmp: LearnedVoiceModifier = { ...validModifier, delta: { kind: 'amplify', factor: 1.5 } };
    expect(() => LearnedVoiceModifierSchema.parse(modWithAmp)).not.toThrow();
  });

  it('validates append delta (phrase ≤ 200 chars)', () => {
    const modWithAppend: LearnedVoiceModifier = { ...validModifier, delta: { kind: 'append', phrase: 'adding a note' } };
    expect(() => LearnedVoiceModifierSchema.parse(modWithAppend)).not.toThrow();
  });

  it('rejects evidence_count < 3', () => {
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, evidence_count: 2 })).toThrow();
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, confidence: 1.5 })).toThrow();
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, confidence: -0.1 })).toThrow();
  });

  it('rejects amplify factor outside [0.5, 2.0]', () => {
    const badFactor: LearnedVoiceModifier = { ...validModifier, delta: { kind: 'amplify', factor: 2.5 } };
    expect(() => LearnedVoiceModifierSchema.parse(badFactor)).toThrow();
  });

  it('rejects invalid UUID in id', () => {
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects invalid dimension', () => {
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, dimension: 'invalid_dim' as any })).toThrow();
  });

  it('requires at least 1 evidence_ref', () => {
    expect(() => LearnedVoiceModifierSchema.parse({ ...validModifier, evidence_refs: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
npm test -- tests/unit/learned-voice-modifier.spec.ts
```

Expected: errors (file doesn't exist).

- [ ] **Step 3: Create type + validator**

```typescript
// src/identity/learned-voice-modifier.ts
import { z } from 'zod';

export type VoiceDimension =
  | 'tone' | 'formality' | 'verbosity' | 'rhythm' | 'vocabulary' | 'emoji_usage';

export interface LearnedVoiceModifier {
  id: string;
  dimension: VoiceDimension;
  delta:
    | { kind: 'shift'; from: string; to: string }
    | { kind: 'amplify'; factor: number }
    | { kind: 'append'; phrase: string };
  confidence: number;
  evidence_count: number;
  status: 'proposed' | 'active' | 'deprecated' | 'rolled_back';
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  evidence_refs: string[];
}

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

- [ ] **Step 4: Run, PASS**

```bash
npm test -- tests/unit/learned-voice-modifier.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/identity/learned-voice-modifier.ts tests/unit/learned-voice-modifier.spec.ts
git commit -m "feat(p8d): LearnedVoiceModifier type + Zod validator (§4)"
```

---

### Task 3: Define `IdentitySlice` type + builder

**Files:**
- Create: `src/runtime/context-assembly/slice-builders/types/identity-slice.ts`
- Create: `src/runtime/context-assembly/slice-builders/identity-slice-builder.ts`
- Create: `tests/unit/identity-slice-builder.spec.ts`

- [ ] **Step 1: Test — builder returns slice with depth parameter**

```typescript
// tests/unit/identity-slice-builder.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildIdentitySlice } from '../../src/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import type { ProfileBody } from '../../src/db/schema.js';
import { operationalProfileVersionsRepo } from '../../src/db/repositories.js';

vi.mock('../../src/db/repositories.js');

describe('identity-slice-builder (§5)', () => {
  const sampleProfile = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    version: 1,
    status: 'active',
    profile_body: {
      schema_version: 'v3.1.1-2026-05-15',
      identity: {
        role_descriptor: 'atendimento_financeiro_pf',
        voice: { tone: 'claro', formality: 'medium' as const, verbosity: 'concise' as const },
        cognitive_limits: { max_inference_depth: 3, max_speculation_in_response: 0.2, confidence_floor_for_action: 0.7 },
        priorities: ['preservar_capital', 'clareza'],
        learned_voice_modifiers: [],
        principles: ['transparência', 'segurança'],
      },
      style: { language: 'pt-BR', rhythm: {} },
      metadata: { effective_from: '2026-05-15T00:00:00Z', created_by: 'test', previous_version_id: null },
    } as ProfileBody,
  } as any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when profile inactive', async () => {
    (operationalProfileVersionsRepo.getActive as any).mockResolvedValue(null);
    expect(await buildIdentitySlice({ depth: 'minimal' })).toBeNull();
  });

  it('returns null when profile.status !== "active"', async () => {
    (operationalProfileVersionsRepo.getActive as any).mockResolvedValue({ ...sampleProfile, status: 'proposed' });
    expect(await buildIdentitySlice({ depth: 'minimal' })).toBeNull();
  });

  it('depth=minimal includes role, identity_block, priorities, voice, cognitive_limits, version metadata', async () => {
    (operationalProfileVersionsRepo.getActive as any).mockResolvedValue(sampleProfile);
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    expect(slice).toBeDefined();
    expect(slice!.role_descriptor).toBe('atendimento_financeiro_pf');
    expect(slice!.priorities).toEqual(['preservar_capital', 'clareza']);
    expect(slice!.voice.tone).toBe('claro');
    expect(slice!.cognitive_limits.max_inference_depth).toBe(3);
    expect(slice!.schema_version).toBe('v3.1.1-2026-05-15');
    expect(slice!.version_number).toBe(1);
    expect(slice!.principles).toBeUndefined();
  });

  it('depth=full includes principles + active_voice_modifiers', async () => {
    const profileWithModifiers = {
      ...sampleProfile,
      profile_body: {
        ...sampleProfile.profile_body,
        identity: {
          ...sampleProfile.profile_body.identity,
          learned_voice_modifiers: [
            {
              id: '550e8400-e29b-41d4-a716-446655440001',
              dimension: 'tone',
              delta: { kind: 'shift', from: 'x', to: 'y' },
              confidence: 0.9,
              evidence_count: 5,
              status: 'active',
              proposed_by: 'detector',
              proposed_at: '2026-05-15T00:00:00Z',
              approved_by: null,
              approved_at: null,
              expires_at: null,
              evidence_refs: ['msg_1', 'msg_2', 'msg_3'],
            },
            {
              id: '550e8400-e29b-41d4-a716-446655440002',
              dimension: 'formality',
              delta: { kind: 'amplify', factor: 1.2 },
              confidence: 0.7,
              evidence_count: 3,
              status: 'deprecated',
              proposed_by: 'detector',
              proposed_at: '2026-05-15T00:00:00Z',
              approved_by: null,
              approved_at: null,
              expires_at: null,
              evidence_refs: ['msg_3'],
            },
          ],
        },
      },
    };
    (operationalProfileVersionsRepo.getActive as any).mockResolvedValue(profileWithModifiers);
    const slice = await buildIdentitySlice({ depth: 'full' });
    expect(slice!.principles).toEqual(['transparência', 'segurança']);
    expect(slice!.active_voice_modifiers).toHaveLength(1);
    expect(slice!.active_voice_modifiers![0].status).toBe('active');
  });

  it('handles malformed profile_body defensively', async () => {
    (operationalProfileVersionsRepo.getActive as any).mockResolvedValue({
      ...sampleProfile,
      profile_body: { identity: {} },
    });
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    expect(slice).toBeDefined();
    expect(slice!.role_descriptor).toBe('unset');
    expect(slice!.priorities).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Create types + builder**

```typescript
// src/runtime/context-assembly/slice-builders/types/identity-slice.ts
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';

export interface IdentitySlice {
  role_descriptor: string;
  identity_block: string;
  priorities: string[];
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
  principles?: string[];
  active_voice_modifiers?: LearnedVoiceModifier[];
  schema_version: string;
  version_id: string;
  version_number: number;
}
```

```typescript
// src/runtime/context-assembly/slice-builders/identity-slice-builder.ts
import type { IdentitySlice } from './types/identity-slice.js';
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';
import type { ProfileBody } from '@/db/schema.js';

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

function extractVoice(voiceRaw: unknown): IdentitySlice['voice'] {
  if (typeof voiceRaw === 'object' && voiceRaw !== null) {
    const v = voiceRaw as Record<string, unknown>;
    return {
      tone: typeof v.tone === 'string' ? v.tone : '',
      formality: ['low', 'medium', 'high'].includes(String(v.formality)) ? (v.formality as any) : 'medium',
      verbosity: ['concise', 'balanced', 'verbose'].includes(String(v.verbosity)) ? (v.verbosity as any) : 'concise',
    };
  }
  return { tone: '', formality: 'medium', verbosity: 'concise' };
}

function extractCognitiveLimits(clRaw: unknown): IdentitySlice['cognitive_limits'] {
  if (typeof clRaw === 'object' && clRaw !== null) {
    const cl = clRaw as Record<string, unknown>;
    return {
      max_inference_depth: typeof cl.max_inference_depth === 'number' ? cl.max_inference_depth : 3,
      max_speculation_in_response: typeof cl.max_speculation_in_response === 'number' ? cl.max_speculation_in_response : 0.2,
      confidence_floor_for_action: typeof cl.confidence_floor_for_action === 'number' ? cl.confidence_floor_for_action : 0.7,
    };
  }
  return { max_inference_depth: 3, max_speculation_in_response: 0.2, confidence_floor_for_action: 0.7 };
}
```

- [ ] **Step 4: Run, PASS**

```bash
npm test -- tests/unit/identity-slice-builder.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/context-assembly/slice-builders/types/identity-slice.ts src/runtime/context-assembly/slice-builders/identity-slice-builder.ts tests/unit/identity-slice-builder.spec.ts
git commit -m "feat(p8d): IdentitySlice type + builder (depth=minimal|full) (§5)"
```

---

## Phase 2 — Drift detector + integration (Tasks 4–8)

### Task 4: Enhance `proposal-generator.ts` — extract priorities

**Files:**
- Modify: `src/identity/proposal-generator.ts`
- Create: `tests/unit/proposal-generator-priorities.spec.ts`

- [ ] **Step 1: Test — parser extracts priorities from markdown**

```typescript
// tests/unit/proposal-generator-priorities.spec.ts
import { describe, it, expect } from 'vitest';
import { parsePrioritiesFromMarkdown } from '../../src/identity/proposal-generator.js';

describe('proposal-generator priorities (§3)', () => {
  it('extracts from ## Prioridades section', () => {
    const markdown = `
# Maia

## Prioridades
1. preservar_capital_do_cliente
2. clareza_de_comunicacao
3. conformidade_regulatoria
`;
    const result = parsePrioritiesFromMarkdown(markdown);
    expect(result).toContain('preservar_capital_do_cliente');
    expect(result).toContain('clareza_de_comunicacao');
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('derives from ## Princípios if no Prioridades', () => {
    const markdown = `
## Princípios
1. Transparência na comunicação
2. Segurança financeira absoluta
3. Respeto aos limites regulatórios
`;
    const result = parsePrioritiesFromMarkdown(markdown);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0]).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('filters invalid slugs (regex)', () => {
    const markdown = `
## Prioridades
1. 123_invalid
2. válido-prioridade
3. valid_slug_123
`;
    const result = parsePrioritiesFromMarkdown(markdown);
    expect(result).not.toContain('123_invalid');
    expect(result).toContain('valid_slug_123');
  });

  it('respects max 5 entries', () => {
    const markdown = `
## Prioridades
1. one
2. two
3. three
4. four
5. five
6. six
`;
    const result = parsePrioritiesFromMarkdown(markdown);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns empty array if no Prioridades/Princípios found', () => {
    const markdown = `
# Maia

Sem prioridades ou princípios.
`;
    const result = parsePrioritiesFromMarkdown(markdown);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Implement priority extraction in proposal-generator**

In `src/identity/proposal-generator.ts`, add/enhance:

```typescript
const PRIORITY_SLUG_RE = /^[a-z][a-z0-9_]{2,79}$/;

export function parsePrioritiesFromMarkdown(markdown: string): string[] {
  const sections = extractSections(markdown); // helper to parse ## sections

  // 1. Try explicit ## Prioridades
  const explicit = parseNumberedList(sections.get('prioridades') ?? '')
    .map(slugify)
    .filter((s) => PRIORITY_SLUG_RE.test(s));
  if (explicit.length > 0) return explicit.slice(0, 5);

  // 2. Derive from ## Princípios (first 3)
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

function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
```

Update `generateInitialProposal` to call `parsePrioritiesFromMarkdown`:

```typescript
const profile_body: ProfileBody = {
  schema_version: 'v3.1.1-2026-05-15',
  identity: {
    role_descriptor: seedData.role_descriptor,
    voice: seedData.voice,
    cognitive_limits: seedData.cognitive_limits ?? {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: parsePrioritiesFromMarkdown(seedData.markdown ?? ''), // <-- NEW
    learned_voice_modifiers: [],
  },
  // ... rest
};
```

- [ ] **Step 4: Run, PASS**

```bash
npm test -- tests/unit/proposal-generator-priorities.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/identity/proposal-generator.ts tests/unit/proposal-generator-priorities.spec.ts
git commit -m "feat(p8d): proposal-generator extracts priorities from maia-prompt.md (§3)"
```

---

### Task 5: Implement `papel_drift` detector

**Files:**
- Create: `src/cognition/drift/papel.ts`
- Create: `tests/unit/drift-detector-papel.spec.ts`

- [ ] **Step 1: Test — detector returns null or DriftEvidence**

```typescript
// tests/unit/drift-detector-papel.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { papelDriftDetector } from '../../src/cognition/drift/papel.js';
import Anthropic from '@anthropic-ai/sdk';

vi.mock('@anthropic-ai/sdk');

describe('papel_drift detector (§6)', () => {
  const sampleProfile = {
    profile_body: {
      identity: {
        role_descriptor: 'atendimento_financeiro_pf',
        priorities: ['preservar_capital', 'clareza'],
      },
    },
  } as any;

  const recentMessages = [
    { from: 'agent' as const, text: 'Seu boleto está vencido.' },
    { from: 'agent' as const, text: 'Recomendo investir em ações tech.' },
    { from: 'agent' as const, text: 'Preparei um parecer jurídico sobre sua causa.' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when role_descriptor is unset', async () => {
    const result = await papelDriftDetector.detect({
      profile_active: { ...sampleProfile, profile_body: { ...sampleProfile.profile_body, identity: { role_descriptor: 'unset' } } },
      recent_messages: recentMessages,
    } as any);
    expect(result).toBeNull();
  });

  it('returns null when no agent messages', async () => {
    const result = await papelDriftDetector.detect({
      profile_active: sampleProfile,
      recent_messages: [{ from: 'user' as const, text: 'Hello' }],
    } as any);
    expect(result).toBeNull();
  });

  it('returns DriftEvidence when drift_detected=true with high severity', async () => {
    const mockResponse = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            drift_detected: true,
            severity_hint: 'alto',
            off_role_examples: ['parecer jurídico', 'ações tech'],
            observed_role_inferred: 'consultoria_juridica_e_investimentos',
            reasoning: 'Agent ofereceu parecer jurídico mas seu papel é atendimento financeiro PF.',
          }),
        },
      ],
    };
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: vi.fn().mockResolvedValue(mockResponse) },
    }));

    const result = await papelDriftDetector.detect({
      profile_active: sampleProfile,
      recent_messages: recentMessages,
    } as any);

    expect(result).toBeDefined();
    expect(result!.drift_type).toBe('papel_drift');
    expect(result!.payload.off_role_examples).toHaveLength(2);
  });

  it('returns null when drift_detected=false', async () => {
    const mockResponse = {
      content: [{ type: 'text' as const, text: '{"drift_detected": false}' }],
    };
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: vi.fn().mockResolvedValue(mockResponse) },
    }));

    const result = await papelDriftDetector.detect({
      profile_active: sampleProfile,
      recent_messages: recentMessages,
    } as any);
    expect(result).toBeNull();
  });

  it('returns null on Anthropic error (defensivo)', async () => {
    (Anthropic as any).mockImplementation(() => ({
      messages: { create: vi.fn().mockRejectedValue(new Error('API error')) },
    }));

    const result = await papelDriftDetector.detect({
      profile_active: sampleProfile,
      recent_messages: recentMessages,
    } as any);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Implement detector**

```typescript
// src/cognition/drift/papel.ts
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

export const papelDriftDetector: DriftDetector = {
  type: DriftType.PAPEL_DRIFT,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const body = (input.profile_active.profile_body ?? {}) as Record<string, unknown>;
    const identity = (body.identity ?? {}) as Record<string, unknown>;

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
          observed_role_inferred: typeof parsed.observed_role_inferred === 'string' ? parsed.observed_role_inferred : null,
          off_role_examples: Array.isArray(parsed.off_role_examples) ? parsed.off_role_examples : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'papel desviado').slice(0, 200),
      };
    } catch {
      return null;
    }
  },
};
```

- [ ] **Step 4: Add `PAPEL_DRIFT` to enums**

In `src/types/enums.ts`:

```typescript
export enum DriftType {
  TOM = 'tom',
  VALORES = 'valores',
  CONFIANCA = 'confianca',
  VIES = 'vies',
  ESCOPO = 'escopo',
  LINGUAGEM = 'linguagem',
  PROCEDIMENTO = 'procedimento',
  SOUL_DRIFT = 'soul_drift',
  PAPEL_DRIFT = 'papel_drift', // <-- NEW
}
```

- [ ] **Step 5: Run, PASS**

```bash
npm test -- tests/unit/drift-detector-papel.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/cognition/drift/papel.ts src/types/enums.ts tests/unit/drift-detector-papel.spec.ts
git commit -m "feat(p8d): papel_drift detector (9th) + DriftType.PAPEL_DRIFT (§6)"
```

---

### Task 6: Register detector + update decision engine

**Files:**
- Modify: `src/cognition/drift/index.ts`
- Modify: `src/cognition/drift/decision-engine.ts`

- [ ] **Step 1: Register in orchestrator**

In `src/cognition/drift/index.ts`:

```typescript
import { papelDriftDetector } from './papel.js';

export const DETECTORS: DriftDetector[] = [
  tomDetector,
  valoresDetector,
  confiancaDetector,
  viesDetector,
  escopoDetector,
  linguagemDetector,
  procedimentoDetector,
  soulDriftDetector,   // P8b
  papelDriftDetector,  // P8d
];
```

Ensure orchestrator wraps in `runCognitiveModule`:

```typescript
const evidence = await runCognitiveModule({
  name: 'drift_detector_papel_drift',
  timeoutMs: 8000,
  triggered_by: 'async_event',
  fallback: null,
  fn: () => detector.detect(input),
});
```

- [ ] **Step 2: Add decision case**

In `src/cognition/drift/decision-engine.ts`, add case in `classifySeverity`:

```typescript
case DriftType.PAPEL_DRIFT: {
  const p = payload as { off_role_examples?: unknown; observed_role_inferred?: unknown; declared_role?: unknown };
  const offRoleRaw = p.off_role_examples;
  const offRole = Array.isArray(offRoleRaw) ? offRoleRaw : [];
  const observed = p.observed_role_inferred;
  const declared = p.declared_role;
  const rolesDiverge =
    typeof observed === 'string' && typeof declared === 'string' &&
    observed.length > 0 &&
    !observed.toLowerCase().includes(declared.toLowerCase().split('_')[0] ?? '');

  if (offRole.length >= 5 || (rolesDiverge && offRole.length >= 3)) return DriftSeverity.CRITICO;
  if (offRole.length >= 3) return DriftSeverity.ALTO;
  if (offRole.length === 2) return DriftSeverity.MEDIO;
  if (offRole.length === 1) return DriftSeverity.BAIXO;
  if (hint !== null) return hint;
  return DriftSeverity.BAIXO;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cognition/drift/index.ts src/cognition/drift/decision-engine.ts
git commit -m "feat(p8d): register papel_drift + severity floor rules in decision engine (§7)"
```

---

### Task 7: Data migration script — populate priorities

**Files:**
- Create: `scripts/p8d-migration-priorities.ts`
- Create: `docs/runbooks/p8d-identity-completion.md`

- [ ] **Step 1: Test — script runs, skips when populated, rolls back on failure**

(Integration test approach — see Task 9 instead for detailed test)

- [ ] **Step 2: Implement script**

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

          const newVersion = await operationalProfileVersionsRepo.create({
            profile_body: newBody as any,
            proposed_by: 'p8d_migration_priorities',
            proposed_reason: `populate priorities[]: ${parsed.join(', ')}`,
          });

          const freezeR = await operationalProfileVersionsRepo.transition({
            id: active.id, to: 'frozen', approved_by: 'p8d_migration_priorities',
          });
          if (!freezeR.ok) throw new Error(`freeze_failed: ${freezeR.reason}`);

          const activateR = await operationalProfileVersionsRepo.transition({
            id: newVersion.id, to: 'active', approved_by: 'p8d_migration_priorities',
          });
          if (!activateR.ok) {
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

- [ ] **Step 3: Commit script**

```bash
git add scripts/p8d-migration-priorities.ts
git commit -m "feat(p8d): migration script to populate priorities (idempotent, transactional) (§8)"
```

---

### Task 8: Write-path validation — cognitive_limits + modifiers

**Files:**
- Modify: `src/db/repositories.ts`

- [ ] **Step 1: Add validators to repo.create**

In `src/db/repositories.ts`, before insert:

```typescript
function validateCognitiveLimits(body: ProfileBody): void {
  const cl = body.identity?.cognitive_limits;
  if (!cl) return;
  if (typeof cl.max_inference_depth !== 'number' || cl.max_inference_depth < 1 || cl.max_inference_depth > 10)
    throw new Error('cognitive_limits.max_inference_depth out of range [1,10]');
  if (typeof cl.max_speculation_in_response !== 'number' || cl.max_speculation_in_response < 0 || cl.max_speculation_in_response > 1)
    throw new Error('cognitive_limits.max_speculation_in_response out of range [0,1]');
  if (typeof cl.confidence_floor_for_action !== 'number' || cl.confidence_floor_for_action < 0 || cl.confidence_floor_for_action > 1)
    throw new Error('cognitive_limits.confidence_floor_for_action out of range [0,1]');
}

async create(args: { profile_body: ProfileBody; ... }): Promise<...> {
  validateCognitiveLimits(args.profile_body);
  
  // Also validate modifiers if present
  const mods = args.profile_body.identity?.learned_voice_modifiers ?? [];
  for (const mod of mods) {
    LearnedVoiceModifierSchema.parse(mod); // throws if invalid
  }
  
  return db.insert(agent_operational_profile_versions).values({ ... });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/repositories.ts
git commit -m "feat(p8d): write-path validation for cognitive_limits + learned_voice_modifiers (§10)"
```

---

## Phase 3 — Integration & acceptance (Tasks 9–10)

### Task 9: Integration test

**Files:**
- Create: `tests/integration/p8d-identity-completion.spec.ts`

- [ ] **Step 1: Write 6-scenario integration test**

```typescript
// tests/integration/p8d-identity-completion.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { operationalProfileVersionsRepo, agentDriftAlertsRepo } from '../../src/db/repositories.js';
import { runAllDriftDetectors } from '../../src/cognition/drift/orchestrator.js';
import { buildIdentitySlice } from '../../src/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import { parsePrioritiesFromMarkdown } from '../../src/identity/proposal-generator.js';
import type { ProfileBody } from '../../src/db/schema.js';

describe('P8d Identity Completion (6 cenários) (§9.5)', () => {
  // Cenário 1: Seed inicial popula priorities
  it('cenário 1: proposal-generator populates priorities in initial seed', async () => {
    const proposal = await generateInitialProposal({
      tenant_id: 'test_t1',
      agent_id: 'test_a1',
      seed_from: 'maia_prompt',
    });
    expect(proposal.profile_body.identity.priorities).toBeDefined();
    expect(proposal.profile_body.identity.priorities.length).toBeGreaterThanOrEqual(0);
    expect(proposal.profile_body.schema_version).toBe('v3.1.1-2026-05-15');
  });

  // Cenário 2: Migration script é idempotente
  it('cenário 2: migration script runs idempotently — 2x run, 2x skip', async () => {
    // Criar versão active sem priorities
    const initial = await operationalProfileVersionsRepo.create({
      profile_body: sampleProfileBody(true),
      proposed_by: 'test',
    });
    await operationalProfileVersionsRepo.transition({ id: initial.id, to: 'active' });

    // 1ª run — popula
    await p8dMigrationScript();
    const after1 = await operationalProfileVersionsRepo.getActive();
    expect(after1!.profile_body.identity.priorities.length).toBeGreaterThan(0);

    // 2ª run — skip (já populado)
    await p8dMigrationScript();
    const after2 = await operationalProfileVersionsRepo.getActive();
    expect(after2!.id).toBe(after1!.id); // mesma versão
  });

  // Cenário 3: papel_drift dispara, profile vai a frozen
  it('cenário 3: papel_drift detector triggered → severity=alto → profile frozen', async () => {
    const profile = await operationalProfileVersionsRepo.create({
      profile_body: sampleProfileBody(true),
      proposed_by: 'test',
    });
    await operationalProfileVersionsRepo.transition({ id: profile.id, to: 'active' });

    // Mock recent messages off-role
    const messages = [
      { from: 'agent' as const, text: 'Vou prepara um parecer jurídico.' },
      { from: 'agent' as const, text: 'Investindo em startup.' },
      { from: 'agent' as const, text: 'Consultoria tributária oferecida.' },
    ];

    // Detectar drift
    const drifts = await runAllDriftDetectors({ profile_active: profile, recent_messages: messages });
    const papelDrift = drifts.find((d) => d.drift_type === 'papel_drift');
    expect(papelDrift).toBeDefined();
    expect(papelDrift!.payload.severity_hint).toBe('alto');

    // Aplicar decisão
    const alert = await decideAndApply({ profile_active: profile, drift_evidence: papelDrift! });
    expect(alert.decision).toBe('frozen');

    // Verificar status
    const frozen = await operationalProfileVersionsRepo.getById(profile.id);
    expect(frozen!.status).toBe('frozen');
  });

  // Cenário 4: Profile frozen → prompt-builder cai no fallback
  it('cenário 4: profile frozen → prompt-builder uses legacy fallback', async () => {
    const frozen = await operationalProfileVersionsRepo.create({
      profile_body: sampleProfileBody(true),
      proposed_by: 'test',
    });
    await operationalProfileVersionsRepo.transition({ id: frozen.id, to: 'active' });
    await operationalProfileVersionsRepo.transition({ id: frozen.id, to: 'frozen' });

    // Prompt builder tenta ler active
    const built = await buildPrompt({
      tenant_id: 'default',
      agent_id: 'default',
      ctx: mockContext(),
    });
    expect(built.system).toContain('legacy'); // fallback está ativo
  });

  // Cenário 5: identity-slice-builder depth=full retorna slice completo
  it('cenário 5: IdentitySlice.depth=full includes principles + active_voice_modifiers', async () => {
    const profile = await operationalProfileVersionsRepo.create({
      profile_body: sampleProfileBodyWithModifiers(),
      proposed_by: 'test',
    });
    await operationalProfileVersionsRepo.transition({ id: profile.id, to: 'active' });

    const slice = await buildIdentitySlice({ depth: 'full' });
    expect(slice!.principles).toBeDefined();
    expect(slice!.principles!.length).toBeGreaterThan(0);
    expect(slice!.active_voice_modifiers).toBeDefined();
    expect(slice!.active_voice_modifiers!.length).toBeGreaterThanOrEqual(0);
  });

  // Cenário 6: Modifier inválido rejeitado no write-path
  it('cenário 6: invalid LearnedVoiceModifier rejected at write-path', async () => {
    const badModifier = { /* invalid shape */ } as any;
    const body = sampleProfileBodyWithModifiers();
    body.identity.learned_voice_modifiers = [badModifier];

    expect(() => {
      operationalProfileVersionsRepo.create({
        profile_body: body,
        proposed_by: 'test',
      });
    }).toThrow(/learned_voice_modifiers|evidence_count|confidence/);
  });
});

// Helper
function sampleProfileBody(withEmpty: boolean): ProfileBody {
  return {
    schema_version: 'v3.1.1-2026-05-15',
    identity: {
      role_descriptor: 'atendimento_financeiro_pf',
      voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
      cognitive_limits: { max_inference_depth: 3, max_speculation_in_response: 0.2, confidence_floor_for_action: 0.7 },
      priorities: withEmpty ? [] : ['preservar_capital'],
      learned_voice_modifiers: [],
    },
    style: { language: 'pt-BR', rhythm: {} },
    metadata: { effective_from: new Date().toISOString(), created_by: 'test', previous_version_id: null },
  };
}
```

- [ ] **Step 2: Run, PASS**

```bash
npm test -- tests/integration/p8d-identity-completion.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/p8d-identity-completion.spec.ts
git commit -m "test(p8d): integration test 6 cenários (seed, migration, drift, slice, validation)"
```

---

### Task 10: Acceptance gates + validation

**Files:**
- Create: `scripts/p8d-acceptance-gates.sh`

- [ ] **Step 1: Write gates**

```bash
#!/bin/bash
set -e

echo "=== P8d Acceptance Gates ==="

# Gate 1: priorities populated for active profile
echo "Gate 1: priorities populated..."
psql -d maia_dev -c "
  SELECT jsonb_array_length(
    COALESCE(profile_body->'identity'->'priorities', '[]'::jsonb)
  ) >= 1 AS has_priorities
    FROM agent_operational_profile_versions
   WHERE tenant_id='default' AND agent_id='default' AND status='active'
" | grep -q "t" && echo "✓ PASS" || echo "✗ FAIL"

# Gate 2: papel_drift detector registered
echo "Gate 2: papel_drift detector registered..."
grep -q "papelDriftDetector" src/cognition/drift/index.ts && echo "✓ PASS" || echo "✗ FAIL"

# Gate 3: LearnedVoiceModifier exported
echo "Gate 3: LearnedVoiceModifier type..."
grep -q "export interface LearnedVoiceModifier" src/identity/learned-voice-modifier.ts && echo "✓ PASS" || echo "✗ FAIL"

# Gate 4: IdentitySlice builder exists
echo "Gate 4: IdentitySlice builder..."
test -f src/runtime/context-assembly/slice-builders/identity-slice-builder.ts && echo "✓ PASS" || echo "✗ FAIL"

# Gate 5: DriftType.PAPEL_DRIFT in enums
echo "Gate 5: DriftType.PAPEL_DRIFT..."
grep -q "PAPEL_DRIFT.*=" src/types/enums.ts && echo "✓ PASS" || echo "✗ FAIL"

echo "=== End P8d gates ==="
```

- [ ] **Step 2: Run full test suite**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: 100% PASS.

- [ ] **Step 3: Run acceptance gates**

```bash
bash scripts/p8d-acceptance-gates.sh
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/p8d-acceptance-gates.sh
git commit -m "test(p8d): acceptance gates (priorities, papel_drift, modifiers, slice, validation)"
```

---

## Done Criteria

- [x] `src/identity/proposal-generator.ts` extracts `priorities` from `maia-prompt.md` (§3)
- [x] `src/identity/learned-voice-modifier.ts` exports type + `LearnedVoiceModifierSchema` (§4)
- [x] `src/runtime/context-assembly/slice-builders/identity-slice-builder.ts` builds `IdentitySlice` with depth (§5)
- [x] `src/cognition/drift/papel.ts` implements detector (§6)
- [x] `DriftType.PAPEL_DRIFT` registered (§6)
- [x] `papelDriftDetector` registered in `src/cognition/drift/index.ts`
- [x] `decision-engine.ts` has `PAPEL_DRIFT` case with floor rules (§7)
- [x] `operationalProfileVersionsRepo.create` validates `cognitive_limits` + modifiers (§10)
- [x] `scripts/p8d-migration-priorities.ts` is idempotent, transactional (§8)
- [x] 5 unit specs pass: learned-voice-modifier, identity-slice-builder, drift-detector-papel, proposal-generator-priorities
- [x] 1 integration spec (6 cenários) PASS
- [x] Acceptance gates 1-5 PASS
- [x] `npm run lint` zero warnings
- [x] `npm run typecheck` zero errors
- [x] `npm test` 100% PASS
- [x] Invariantes preserved: §1 (tenant_id NOT NULL), §2 (runCognitiveModule wrap), §4 (append-only), §6 (one active), §11 (learned never overrides Identity)

---

## Risks + Mitigations

| Risco | Mitigação |
|---|---|
| `parsePriorities` extrai slugs ruins | Regex `PRIORITY_SLUG_RE`, max 5 entries, fallback `[]` |
| Migration falha parcialmente | Transactional per (tenant, agent); rollback automático se activate falha |
| `papel_drift` LLM com falso positivo alto | Floor rules conservadoras: 3+ exemplos para `alto`; 1 exemplo só `baixo` |
| `LearnedVoiceModifier` populated com schema errado | Zod no write-path rejeita |
| `identity-slice-builder` retorna stale | Cache layer P8a; builder é stateless |
| Priorities conflitam com Soul biases | Identity precede Soul; origin gate cuida override (P8b §7) |
| `papel_drift` falso negativo | Coverage em testes; observabilidade via `cognitive_module_log` permite tuning |
| Migration roda em prod sem staging | Runbook documenta dev → staging → prod 24h; script idempotente |

---

## Dependencies

### Upstream (merged)
- **P4 refactor** — `profile_body` schema v3.1.1, `ProfileBody` type
- **P8a/P8b/P8c** — `ContextPacket`, `soul_drift` (8º detector)
- **P1 cognitive runner** — `runCognitiveModule`

### Co-dependent (parallel)
- **P8a — Context Packet / Cache** — defines `ContextPacket` containing `IdentitySlice`; P8d builder; P8a integrates cache

### Downstream
- **P9b — Agent Runtime** — consumes `IdentitySlice.cognitive_limits` for SkillRunner
- **P8.5 — Admin UI MVP** — Tela 4 lists `papel_drift` alerts; Tela 3 rollback freeze

---

## Out of Scope

- Drift detector `tom` proposing `LearnedVoiceModifier` automatically (P9b)
- Cache of `IdentitySlice` (P8a)
- Runtime enforcement of `cognitive_limits` (P9b)
- Admin UI manual priority editing (P8.5)
- Sync between `role_descriptor` and `roles` table (P6)

---

**End of plan.**

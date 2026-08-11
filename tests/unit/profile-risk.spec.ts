/**
 * Spec perfil-inbox v4 §1.2 / §4 — classificador de risco do perfil
 * operacional. Tabela exaustiva por campo canônico + casos fail-UP (campo
 * desconhecido, schema_version fora do mapa, predecessor nulo, shape
 * inválido) + garantia de que o diff deriva do MESMO walker (rhythm,
 * learned_voice_modifiers e schema_version aparecem nas entradas).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProfileChangeRisk,
  PROFILE_FIELD_CLASSIFICATIONS,
  type ProfileRiskLevel,
} from '@/db/profile-risk.js';
import {
  PROFILE_BODY_SCHEMA_VERSION,
  PROFILE_SCHEMA_COMPAT,
  parseKnownProfileSchemaVersion,
  type ProfileBody,
} from '@/db/schema.js';

/** Corpo canônico válido na versão corrente (v3.1.2). */
function baseBody(): ProfileBody {
  return {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: 'Atendente de leads do WhatsApp',
      voice: { tone: 'profissional e cordial', formality: 'medium', verbosity: 'medium' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      priorities: ['precisao', 'clareza'],
      principles: ['nunca prometer prazos de terceiros'],
      learned_voice_modifiers: [],
    },
    style: { language: 'pt-BR', rhythm: {} },
    metadata: {
      effective_from: '2026-07-13T00:00:00.000Z',
      created_by: 'user-1',
      previous_version_id: 'version-prev',
    },
  };
}

/** Corpo legado válido na versão predecessora (v3.1.1 — sem `principles`). */
function legacyBody(): Record<string, unknown> {
  const b = baseBody() as unknown as Record<string, unknown>;
  const identity = { ...(b.identity as Record<string, unknown>) };
  delete identity.principles;
  return { ...b, schema_version: 'v3.1.1-2026-05-15', identity };
}

function mutate(body: ProfileBody, fn: (b: ProfileBody) => void): ProfileBody {
  const clone = structuredClone(body);
  fn(clone);
  return clone;
}

describe('classifyProfileChangeRisk — tabela por campo canônico', () => {
  const cases: Array<[string, (b: ProfileBody) => void, ProfileRiskLevel]> = [
    ['identity.role_descriptor', (b) => (b.identity.role_descriptor = 'Outro papel'), 'medium'],
    ['identity.voice.tone', (b) => (b.identity.voice.tone = 'direto'), 'low'],
    ['identity.voice.formality', (b) => (b.identity.voice.formality = 'high'), 'low'],
    ['identity.voice.verbosity', (b) => (b.identity.voice.verbosity = 'concise'), 'low'],
    [
      'identity.cognitive_limits.max_inference_depth',
      (b) => (b.identity.cognitive_limits.max_inference_depth = 5),
      'high',
    ],
    [
      'identity.cognitive_limits.max_speculation_in_response',
      (b) => (b.identity.cognitive_limits.max_speculation_in_response = 0.5),
      'high',
    ],
    [
      'identity.cognitive_limits.confidence_floor_for_action',
      (b) => (b.identity.cognitive_limits.confidence_floor_for_action = 0.9),
      'high',
    ],
    ['identity.priorities', (b) => b.identity.priorities.push('rapidez'), 'medium'],
    ['identity.principles', (b) => b.identity.principles!.push('novo contrato'), 'high'],
    [
      'identity.learned_voice_modifiers',
      (b) => (b.identity.learned_voice_modifiers = [{ aspect: 'tone', strength: 0.4 }]),
      'medium',
    ],
    ['style.language', (b) => (b.style.language = 'en-US'), 'low'],
    ['style.rhythm', (b) => (b.style.rhythm = { pace: 'slow' }), 'medium'],
    ['metadata.effective_from', (b) => (b.metadata.effective_from = '2026-08-01T00:00:00.000Z'), 'low'],
    ['metadata.created_by', (b) => (b.metadata.created_by = 'user-2'), 'low'],
    // Linhagem, não conteúdo — classificada low mas NUNCA omitida do diff.
    ['metadata.previous_version_id', (b) => (b.metadata.previous_version_id = 'version-other'), 'low'],
  ];

  it.each(cases)('mudança em %s ⇒ risco %s', (path, apply, expected) => {
    const predecessor = baseBody();
    const proposed = mutate(predecessor, apply);
    const result = classifyProfileChangeRisk(predecessor, proposed);
    expect(result.risk).toBe(expected);
    expect(result.reasons).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path, risk: expected });
    expect(result.changes[0]!.unknown_field).toBeUndefined();
  });

  it('corpo idêntico ⇒ low, sem entradas nem razões', () => {
    const result = classifyProfileChangeRisk(baseBody(), baseBody());
    expect(result).toEqual({ risk: 'low', reasons: [], changes: [] });
  });

  it('risco geral = máximo dos campos alterados', () => {
    const predecessor = baseBody();
    const proposed = mutate(predecessor, (b) => {
      b.style.language = 'en-US'; // low
      b.identity.role_descriptor = 'Outro papel'; // medium
    });
    const result = classifyProfileChangeRisk(predecessor, proposed);
    expect(result.risk).toBe('medium');
    expect(result.changes.map((c) => c.path).sort()).toEqual([
      'identity.role_descriptor',
      'style.language',
    ]);
  });

  it('toda folha canônica tem classificação explícita na tabela exportada', () => {
    const paths = PROFILE_FIELD_CLASSIFICATIONS.map((c) => c.path);
    expect(paths).toContain('schema_version');
    expect(paths).toContain('identity.principles');
    expect(paths).toContain('identity.learned_voice_modifiers');
    expect(paths).toContain('style.rhythm');
    expect(paths).toContain('metadata.previous_version_id');
  });
});

describe('classifyProfileChangeRisk — fail-UP (nunca down)', () => {
  it('campo desconhecido na raiz ⇒ high + unknown_field na entrada', () => {
    const proposed = { ...baseBody(), legacy_extension: { foo: 1 } };
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    expect(result.risk).toBe('high');
    const entry = result.changes.find((c) => c.path === 'legacy_extension');
    expect(entry).toMatchObject({ risk: 'high', unknown_field: true, after: { foo: 1 } });
    expect(result.reasons.some((r) => r.includes('legacy_extension'))).toBe(true);
  });

  it('campo desconhecido aninhado (identity) ⇒ high, mesmo vindo só do predecessor', () => {
    const predecessor = baseBody() as unknown as Record<string, unknown>;
    (predecessor.identity as Record<string, unknown>).campo_legado = 'x';
    const result = classifyProfileChangeRisk(predecessor, baseBody());
    expect(result.risk).toBe('high');
    const entry = result.changes.find((c) => c.path === 'identity.campo_legado');
    expect(entry).toMatchObject({ risk: 'high', unknown_field: true, before: 'x' });
  });

  it('schema_version proposto desconhecido ⇒ high (nunca erro de parse)', () => {
    const proposed = { ...baseBody(), schema_version: 'v9.9.9-2099-01-01' };
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    expect(result.risk).toBe('high');
    expect(result.reasons.some((r) => r.includes('v9.9.9-2099-01-01'))).toBe(true);
  });

  it('schema_version do predecessor desconhecido ⇒ high', () => {
    const predecessor = { ...baseBody(), schema_version: 'v0.0.1' };
    const result = classifyProfileChangeRisk(predecessor, baseBody());
    expect(result.risk).toBe('high');
  });

  it('predecessor null ⇒ high, mas o diff ainda renderiza o conteúdo proposto', () => {
    const result = classifyProfileChangeRisk(null, baseBody());
    expect(result.risk).toBe('high');
    expect(result.reasons.some((r) => r.toLowerCase().includes('predecessor'))).toBe(true);
    // Conteúdo integral do proposto vira entradas (before undefined).
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.every((c) => c.before === undefined)).toBe(true);
  });

  it('predecessor ilegível (não-objeto) ⇒ high', () => {
    expect(classifyProfileChangeRisk('garbage', baseBody()).risk).toBe('high');
    expect(classifyProfileChangeRisk(42, baseBody()).risk).toBe('high');
  });

  it('corpo proposto ilegível ⇒ high com entrada raiz nunca omitida', () => {
    const result = classifyProfileChangeRisk(baseBody(), null);
    expect(result.risk).toBe('high');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path: '(corpo)', unknown_field: true });
  });

  it('valor fora do shape esperado ⇒ high', () => {
    const proposed = mutate(baseBody(), (b) => {
      (b.identity as unknown as Record<string, unknown>).priorities = 'not-an-array';
    });
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    expect(result.risk).toBe('high');
    const entry = result.changes.find((c) => c.path === 'identity.priorities');
    expect(entry).toMatchObject({ risk: 'high', after: 'not-an-array' });
    expect(result.reasons.some((r) => r.includes('identity.priorities'))).toBe(true);
  });

  it('campo obrigatório ausente no corpo proposto ⇒ high', () => {
    const proposed = baseBody() as unknown as Record<string, unknown>;
    delete ((proposed.identity as Record<string, unknown>).voice as Record<string, unknown>).tone;
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    expect(result.risk).toBe('high');
    expect(result.reasons.some((r) => r.includes('identity.voice.tone'))).toBe(true);
  });
});

describe('classifyProfileChangeRisk — mapa de compatibilidade de versões', () => {
  it('par compatível v3.1.1→v3.1.2 NÃO eleva o risco por si só', () => {
    // Predecessor legado (sem principles) → proposto v3.1.2 idêntico nos
    // campos: só a versão muda. Ausência legada ≡ vazio: sem entrada espúria.
    const proposed = mutate(baseBody(), (b) => {
      b.identity.principles = [];
    });
    const result = classifyProfileChangeRisk(legacyBody(), proposed);
    expect(result.risk).toBe('low');
    expect(result.reasons).toEqual([]);
    // A mudança de versão APARECE no diff (nunca omitida), com risco low.
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'schema_version',
      risk: 'low',
      before: 'v3.1.1-2026-05-15',
      after: PROFILE_BODY_SCHEMA_VERSION,
    });
  });

  it('par compatível + campo medium alterado ⇒ medium (só os campos pesam)', () => {
    const proposed = mutate(baseBody(), (b) => {
      b.identity.principles = [];
      b.identity.role_descriptor = 'Outro papel';
    });
    const result = classifyProfileChangeRisk(legacyBody(), proposed);
    expect(result.risk).toBe('medium');
  });

  it('par conhecido FORA do mapa (downgrade v3.1.2→v3.1.1) ⇒ high', () => {
    const proposed = { ...legacyBody() };
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    expect(result.risk).toBe('high');
    expect(result.reasons.some((r) => r.includes('compatibilidade'))).toBe(true);
  });

  it('versões idênticas não geram entrada de schema_version', () => {
    const result = classifyProfileChangeRisk(baseBody(), baseBody());
    expect(result.changes.find((c) => c.path === 'schema_version')).toBeUndefined();
  });

  it('o mapa usa os literais REAIS persistidos', () => {
    expect(PROFILE_SCHEMA_COMPAT[PROFILE_BODY_SCHEMA_VERSION]).toEqual(['v3.1.1-2026-05-15']);
    expect(parseKnownProfileSchemaVersion('v3.1.1-2026-05-15')).toBe('v3.1.1-2026-05-15');
    expect(parseKnownProfileSchemaVersion(PROFILE_BODY_SCHEMA_VERSION)).toBe(
      PROFILE_BODY_SCHEMA_VERSION,
    );
    expect(parseKnownProfileSchemaVersion('v3.1.1')).toBeNull();
    expect(parseKnownProfileSchemaVersion(undefined)).toBeNull();
  });
});

describe('diff deriva do MESMO walker (single source of truth)', () => {
  it('entradas incluem rhythm, learned_voice_modifiers e schema_version', () => {
    const proposed = mutate(baseBody(), (b) => {
      b.identity.principles = [];
      b.style.rhythm = { pace: 'slow' };
      b.identity.learned_voice_modifiers = [{ aspect: 'tone', strength: 0.2 }];
    });
    const result = classifyProfileChangeRisk(legacyBody(), proposed);
    const paths = result.changes.map((c) => c.path).sort();
    expect(paths).toEqual([
      'identity.learned_voice_modifiers',
      'schema_version',
      'style.rhythm',
    ]);
    expect(result.risk).toBe('medium');
  });

  it('campo desconhecido carrega flag unknown_field para a seção dedicada da UI', () => {
    const proposed = {
      ...baseBody(),
      metadata: { ...baseBody().metadata, migrated_from_legacy: true },
    };
    const result = classifyProfileChangeRisk(baseBody(), proposed);
    const entry = result.changes.find((c) => c.path === 'metadata.migrated_from_legacy');
    expect(entry).toMatchObject({ risk: 'high', unknown_field: true, after: true });
    expect(result.risk).toBe('high');
  });
});

/**
 * Spec perfil-inbox v4 §1.2 — classificador de risco + walker exaustivo do
 * ProfileBody canônico. Fonte ÚNICA de verdade para o classificador E para o
 * diff (`DiffOperationalProfile` renderiza exatamente o que o classificador
 * enxerga — nada é omitido).
 *
 * Vive em src/db/ (padrão de capability-risk.ts) para ser consumível tanto
 * pelo motor unificado (server-side) quanto pela admin-ui — o re-export para
 * a UI está em src/admin-ui/lib/profile-risk.ts; nunca importar na direção
 * contrária (src/db não pode depender de src/admin-ui).
 *
 * Contratos:
 *  - Função pura, backend-safe, nunca LLM (invariante 4 da spec).
 *  - Compara contra o predecessor DECLARADO da proposta
 *    (`metadata.previous_version_id`), fornecido pelo chamador — coerente com
 *    o guard de predecessor que decidirá a ativação.
 *  - FAIL-UP, nunca down: campo desconhecido (extensão legada, chave extra),
 *    `schema_version` fora do PROFILE_SCHEMA_COMPAT (e não idêntico),
 *    predecessor ausente/ilegível, ou valor fora do shape esperado ⇒ `high`.
 */
import {
  PROFILE_SCHEMA_COMPAT,
  parseKnownProfileSchemaVersion,
} from './schema.js';

export type ProfileRiskLevel = 'low' | 'medium' | 'high';

export type ProfileFieldClassification = {
  path: string;
  risk: ProfileRiskLevel;
};

export type ProfileChangeEntry = {
  path: string;
  risk: ProfileRiskLevel;
  before: unknown;
  after: unknown;
  /** Chave fora do schema canônico (extensão legada / campo extra). */
  unknown_field?: boolean;
};

const RISK_ORDER: Record<ProfileRiskLevel, number> = { low: 0, medium: 1, high: 2 };

function maxRisk(a: ProfileRiskLevel, b: ProfileRiskLevel): ProfileRiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Folha conhecida do walker: classificação explícita + shape esperado.
 *
 *  - `optional: true` ⇒ ausência no corpo PROPOSTO não é violação de shape
 *    (campo obrigatório ausente no proposto ⇒ high, fail-up).
 *  - `absentEquivalent` ⇒ ausência da chave equivale a este valor vazio na
 *    COMPARAÇÃO (predecessor legado sem a chave ≡ `[]`/`{}` — sem isto, o
 *    upgrade v3.1.1→v3.1.2 geraria entradas espúrias tipo `principles: []`
 *    e derrotaria o próprio mapa de compatibilidade). As entradas do diff
 *    preservam os valores BRUTOS.
 */
type LeafSpec = {
  risk: ProfileRiskLevel;
  optional?: boolean;
  absentEquivalent?: unknown;
  validate: (v: unknown) => boolean;
};

/**
 * Tabela de classificação por campo (spec §1.2 — "low/medium conforme tabela
 * no código"). Decisões documentadas:
 *  - `identity.principles` e `cognitive_limits.*` ⇒ high (contratos de valor
 *    e limites cognitivos podem congelar/rollbackar o próprio agente);
 *  - `identity.role_descriptor` e `identity.priorities` ⇒ medium;
 *  - `identity.voice.*` e `style.language` ⇒ low (apresentação);
 *  - `style.rhythm` e `identity.learned_voice_modifiers` ⇒ medium (conteúdo
 *    livre/aprendido: mais que cosmético, menos que contrato);
 *  - `metadata.*` ⇒ low (linhagem/bookkeeping — `previous_version_id` é
 *    lineage, não conteúdo; classificado mas NUNCA omitido do diff);
 *  - `schema_version` é caso especial (mapa de compatibilidade, abaixo).
 */
const LEAF_SPECS: Record<string, LeafSpec> = {
  'identity.role_descriptor': { risk: 'medium', validate: (v) => typeof v === 'string' },
  'identity.voice.tone': { risk: 'low', validate: (v) => typeof v === 'string' },
  'identity.voice.formality': {
    risk: 'low',
    validate: (v) => v === 'low' || v === 'medium' || v === 'high',
  },
  'identity.voice.verbosity': {
    risk: 'low',
    validate: (v) => v === 'concise' || v === 'medium' || v === 'detailed',
  },
  'identity.cognitive_limits.max_inference_depth': {
    risk: 'high',
    validate: (v) => typeof v === 'number',
  },
  'identity.cognitive_limits.max_speculation_in_response': {
    risk: 'high',
    validate: (v) => typeof v === 'number',
  },
  'identity.cognitive_limits.confidence_floor_for_action': {
    risk: 'high',
    validate: (v) => typeof v === 'number',
  },
  'identity.priorities': { risk: 'medium', absentEquivalent: [], validate: isStringArray },
  'identity.principles': {
    risk: 'high',
    optional: true,
    absentEquivalent: [],
    validate: isStringArray,
  },
  // Folha OPACA: o conteúdo dos modifiers é livre — o walker compara o array
  // inteiro; itens não viram "campos desconhecidos".
  'identity.learned_voice_modifiers': {
    risk: 'medium',
    absentEquivalent: [],
    validate: (v) => Array.isArray(v),
  },
  'style.language': { risk: 'low', validate: (v) => typeof v === 'string' },
  // Folha OPACA (Record livre) — chaves internas não são campos do schema.
  'style.rhythm': { risk: 'medium', absentEquivalent: {}, validate: isPlainObject },
  'metadata.effective_from': { risk: 'low', validate: (v) => typeof v === 'string' },
  'metadata.created_by': { risk: 'low', validate: (v) => typeof v === 'string' },
  'metadata.previous_version_id': {
    risk: 'low',
    validate: (v) => v === null || typeof v === 'string',
  },
};

/** Contêineres conhecidos → chaves canônicas admitidas em cada nível. */
const CONTAINER_KEYS: Record<string, string[]> = {
  '': ['schema_version', 'identity', 'style', 'metadata'],
  identity: [
    'role_descriptor',
    'voice',
    'cognitive_limits',
    'priorities',
    'principles',
    'learned_voice_modifiers',
  ],
  'identity.voice': ['tone', 'formality', 'verbosity'],
  'identity.cognitive_limits': [
    'max_inference_depth',
    'max_speculation_in_response',
    'confidence_floor_for_action',
  ],
  style: ['language', 'rhythm'],
  metadata: ['effective_from', 'created_by', 'previous_version_id'],
};

/**
 * Tabela exportada (uso em testes/documentação): todo campo conhecido tem
 * classificação explícita. `schema_version` aparece como `low` — é o risco
 * de um par COMPATÍVEL; par fora do mapa escala para `high` no classificador.
 */
export const PROFILE_FIELD_CLASSIFICATIONS: ProfileFieldClassification[] = [
  { path: 'schema_version', risk: 'low' },
  ...Object.entries(LEAF_SPECS).map(([path, spec]) => ({ path, risk: spec.risk })),
];

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function getAtPath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function classifyProfileChangeRisk(
  predecessorBody: unknown,
  proposedBody: unknown,
): { risk: ProfileRiskLevel; reasons: string[]; changes: ProfileChangeEntry[] } {
  const reasons: string[] = [];
  const changes: ProfileChangeEntry[] = [];
  let risk: ProfileRiskLevel = 'low';

  // Corpo proposto ilegível ⇒ high; nada caminhável, mas o diff nunca omite:
  // uma entrada raiz carrega o JSON bruto para a seção de não reconhecidos.
  if (!isPlainObject(proposedBody)) {
    reasons.push('Corpo proposto ausente ou ilegível (não é um objeto) — fail-up.');
    changes.push({
      path: '(corpo)',
      risk: 'high',
      before: predecessorBody,
      after: proposedBody,
      unknown_field: true,
    });
    return { risk: 'high', reasons, changes };
  }

  // Predecessor DECLARADO ausente/ilegível ⇒ high (fail-up). Ainda caminhamos
  // contra `{}` para o diff render(izar) o conteúdo integral proposto.
  let predecessor: Record<string, unknown> = {};
  let predecessorMissing = false;
  if (isPlainObject(predecessorBody)) {
    predecessor = predecessorBody;
  } else {
    predecessorMissing = true;
    risk = 'high';
    reasons.push('Predecessor declarado ausente ou ilegível — fail-up para risco alto.');
  }

  // schema_version — par avaliado contra o mapa de compatibilidade aditiva.
  const beforeVersionRaw = predecessor['schema_version'];
  const afterVersionRaw = proposedBody['schema_version'];
  const afterVersion = parseKnownProfileSchemaVersion(afterVersionRaw);
  if (afterVersion === null) {
    risk = 'high';
    reasons.push(
      `schema_version proposto desconhecido (${JSON.stringify(afterVersionRaw)}) — fail-up.`,
    );
  }
  if (!predecessorMissing) {
    const beforeVersion = parseKnownProfileSchemaVersion(beforeVersionRaw);
    if (beforeVersion === null) {
      risk = 'high';
      reasons.push(
        `schema_version do predecessor desconhecido (${JSON.stringify(beforeVersionRaw)}) — fail-up.`,
      );
    }
    if (!deepEqual(beforeVersionRaw, afterVersionRaw)) {
      // Par no mapa ⇒ a diferença de versão NÃO pesa no risco (só os campos).
      const compatible =
        beforeVersion !== null &&
        afterVersion !== null &&
        (PROFILE_SCHEMA_COMPAT[afterVersion] ?? []).includes(beforeVersion);
      const entryRisk: ProfileRiskLevel = compatible ? 'low' : 'high';
      if (!compatible) {
        risk = 'high';
        reasons.push(
          `Par de schema_version fora do mapa de compatibilidade: ` +
            `${JSON.stringify(beforeVersionRaw)} → ${JSON.stringify(afterVersionRaw)}.`,
        );
      }
      changes.push({
        path: 'schema_version',
        risk: entryRisk,
        before: beforeVersionRaw,
        after: afterVersionRaw,
      });
      risk = maxRisk(risk, entryRisk);
    }
  }

  // Folhas conhecidas — tudo que o classificador enxerga, o diff renderiza.
  for (const [path, spec] of Object.entries(LEAF_SPECS)) {
    const before = predecessorMissing ? undefined : getAtPath(predecessor, path);
    const after = getAtPath(proposedBody, path);

    // Campo obrigatório ausente no corpo PROPOSTO ⇒ fora do shape ⇒ high
    // (a equivalência de ausência vale para o predecessor legado, não para
    // um corpo proposto malformado — buildProfileBody sempre grava a chave).
    if (after === undefined && !spec.optional) {
      risk = 'high';
      reasons.push(`Campo obrigatório ausente no corpo proposto: ${path} — fail-up.`);
      changes.push({ path, risk: 'high', before, after: undefined });
      continue;
    }

    const beforeCmp = before === undefined ? spec.absentEquivalent : before;
    const afterCmp = after === undefined ? spec.absentEquivalent : after;

    if (afterCmp !== undefined && !spec.validate(afterCmp)) {
      // Valor fora do shape esperado ⇒ high, e a entrada nunca é omitida.
      risk = 'high';
      reasons.push(`Valor fora do shape esperado em ${path} — fail-up.`);
      changes.push({ path, risk: 'high', before, after });
      continue;
    }

    if (!deepEqual(beforeCmp, afterCmp)) {
      changes.push({ path, risk: spec.risk, before, after });
      risk = maxRisk(risk, spec.risk);
    }
  }

  // Chaves desconhecidas em QUALQUER nível conhecido, de QUALQUER um dos
  // corpos (extensão legada, chave extra) ⇒ high, sinalizadas para a seção
  // "Campos não reconhecidos (risco alto)" — nunca omitidas.
  for (const [containerPath, knownKeys] of Object.entries(CONTAINER_KEYS)) {
    const beforeContainer =
      containerPath === '' ? predecessor : getAtPath(predecessor, containerPath);
    const afterContainer =
      containerPath === '' ? proposedBody : getAtPath(proposedBody, containerPath);
    const known = new Set(knownKeys);
    const unknownKeys = new Set<string>();
    if (isPlainObject(afterContainer)) {
      for (const k of Object.keys(afterContainer)) if (!known.has(k)) unknownKeys.add(k);
    }
    if (!predecessorMissing && isPlainObject(beforeContainer)) {
      for (const k of Object.keys(beforeContainer)) if (!known.has(k)) unknownKeys.add(k);
    }
    for (const k of unknownKeys) {
      const path = containerPath === '' ? k : `${containerPath}.${k}`;
      risk = 'high';
      reasons.push(`Campo não reconhecido: ${path} — fail-up.`);
      changes.push({
        path,
        risk: 'high',
        before: isPlainObject(beforeContainer) ? beforeContainer[k] : undefined,
        after: isPlainObject(afterContainer) ? afterContainer[k] : undefined,
        unknown_field: true,
      });
    }
  }

  return { risk, reasons, changes };
}

/**
 * P9c — KnowledgeRiskScorer (real implementation).
 *
 * Replaces the P10a stub (`source: 'stub:p10a'`) with the actual P9c
 * scorer from `src/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts`.
 *
 * Adapter responsibilities (inline, <25 LoC):
 *  1. Maps `KnowledgeRiskScoreInput` (KSM-domain types) → `KnowledgeRiskSignals`
 *     (shared-risk domain types).
 *  2. Maps `KnowledgeKind` ('fact','rule','memory',...) → `knowledge_type`
 *     ('fato','regra','procedimento','lacuna','tool_request').
 *  3. Maps `ScoredRisk` → `KnowledgeRiskScoreOutput` (same shape the KSM
 *     state machine already reads: level/sensitivity/reasons/source).
 *
 * Signal mapping:
 *  - `kind` → `knowledge_type` via KIND_TO_KNOWLEDGE_TYPE table.
 *  - `confidence` → `derived_confidence`.
 *  - `origin` 'user_explicit'/'human_approved' → mark as high-evidence
 *    by setting derived_confidence=max(input, 0.8).
 *  - `proposer_sensitivity_hint` → `topic` proxy (high → 'critical_decision',
 *    medium → 'financial', low → omit).
 *  - Gate can be injected for tests via `input.gate` or the second arg.
 *
 * The new `score()` signature adds an optional second argument `{ gate }`
 * so tests can inject a mock gate without touching state-machine.ts.
 * `state-machine.ts` calls `KnowledgeRiskScorer.score(input)` (no second
 * arg) and gets `haikuRiskGate` as default.
 */

import { scoreKnowledge } from './knowledge-risk-scorer.js';
import { scanPayload, riskFloorFromScan } from './payload-scan.js';
import type { LLMGate } from '@/shared/risk/types.js';
import type {
  KnowledgeKind,
  KnowledgeOrigin,
  KnowledgeRiskLevel,
  KnowledgeScope,
  KnowledgeSensitivity,
} from './types.js';
import type { TopicSignal } from '@/shared/risk/types.js';

export interface KnowledgeRiskScoreInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  content_text: string;
  confidence: number;
  origin: KnowledgeOrigin;
  /**
   * G3 (§7.6.2) — o PAYLOAD canônico, varrido por inteiro.
   *
   * `content_text` é derivação textual e pode não conter tudo que o item
   * carrega. A varredura (`./payload-scan.js`) percorre este valor, que é o
   * JSON de fato persistido. Ausente, o scorer varre `content_text` — cobertura
   * pior, mas ainda integral sobre o que recebeu, e nunca um prefixo.
   */
  content_payload?: unknown;
  /**
   * Evidência VERIFICADA de origem humana, ligada a uma revisão.
   *
   * Não é o enum `origin`, e a distinção é o ponto (§7.6.2): `origin` chega do
   * cliente, e uma tool que aceite `fonte='configurado'` do modelo faz o modelo
   * declarar a própria proveniência. Este campo só é preenchido por quem
   * conseguiu APONTAR a revisão humana correspondente.
   */
  verified_human_evidence?: { review_id: string } | undefined;
  proposer_sensitivity_hint?: KnowledgeSensitivity;
  /** Optional gate injection for tests (avoids real Haiku calls). */
  gate?: LLMGate;
  /** @internal Test-only: force knowledge_type to an arbitrary string. */
  _test_force_knowledge_type?: string;
}

export interface KnowledgeRiskScoreOutput {
  level: KnowledgeRiskLevel;
  sensitivity: KnowledgeSensitivity;
  reasons: string[];
  source: 'p9c:knowledge' | 'heuristic' | 'llm_elevated' | 'cache';
}

// ---------------------------------------------------------------------------
// Adapter: KnowledgeKind → knowledge_type
// ---------------------------------------------------------------------------

const KIND_TO_KNOWLEDGE_TYPE: Record<
  KnowledgeKind,
  'fato' | 'regra' | 'procedimento' | 'lacuna' | 'tool_request'
> = {
  fact: 'fato',
  rule: 'regra',
  memory: 'fato', // memory is a scoped fact
  behavioral_hint: 'lacuna', // behavioral hints are observed gaps / tendencies
  procedure_hint: 'procedimento',
};

// ---------------------------------------------------------------------------
// Adapter: sensitivity_hint → topic proxy
// ---------------------------------------------------------------------------

function sensitivityToTopic(s: KnowledgeSensitivity | undefined): TopicSignal | undefined {
  if (s === 'high') return 'critical_decision';
  if (s === 'medium') return 'financial';
  return undefined;
}

// ---------------------------------------------------------------------------
// Real scorer class (same static API as the stub)
// ---------------------------------------------------------------------------

/** Ordem dos níveis. Índice maior = mais restritivo. */
const ORDEM_DO_RISCO = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Combina o nível decidido com o piso da varredura tomando o MAIS RESTRITIVO.
 *
 * É a função inteira que garante a propriedade "a varredura só eleva". Trocar
 * este `max` por uma atribuição — ou deixar o piso sobrescrever — daria ao
 * scanner o poder de BAIXAR um `critical` que a heurística já tinha decidido,
 * e a ausência de achado viraria um voto em "seguro".
 */
function maisRestritivo(
  nivel: KnowledgeRiskLevel,
  piso: 'high' | 'medium' | null,
): KnowledgeRiskLevel {
  if (piso === null) return nivel;
  const i = ORDEM_DO_RISCO.indexOf(nivel as (typeof ORDEM_DO_RISCO)[number]);
  const j = ORDEM_DO_RISCO.indexOf(piso);
  // Nível fora da escala conhecida não é rebaixado: preserva o que veio.
  if (i < 0) return nivel;
  return (i >= j ? nivel : piso) as KnowledgeRiskLevel;
}

export class KnowledgeRiskScorer {
  static async score(
    input: KnowledgeRiskScoreInput,
    opts?: { gate?: LLMGate },
  ): Promise<KnowledgeRiskScoreOutput> {
    const gate = opts?.gate ?? input.gate;

    // Derive knowledge_type (allow test override for coercion path validation)
    const knowledge_type = (input._test_force_knowledge_type ??
      KIND_TO_KNOWLEDGE_TYPE[input.kind]) as
      | 'fato'
      | 'regra'
      | 'procedimento'
      | 'lacuna'
      | 'tool_request';

    /**
     * G3 (§7.6.2) — o bônus humano deixa de vir do enum do cliente.
     *
     * Antes: `origin === 'user_explicit' || origin === 'human_approved'` elevava
     * a confiança para 0.8. O `origin` chega de quem propõe, e `propose_fact`
     * derivava-o de um campo que o MODELO escolhia (`fonte='configurado'` →
     * `human_approved`). O encadeamento completo era: o modelo declara a
     * proveniência, a confiança sobe, o risco cai, e o item pode nascer visível
     * em vez de esperar revisão.
     *
     * Agora o bônus exige evidência VERIFICADA ligada a uma revisão. Quem não
     * consegue apontar a revisão não recebe bônus, por mais que o enum diga.
     */
    const derived_confidence =
      input.verified_human_evidence !== undefined
        ? Math.max(input.confidence, 0.8)
        : input.confidence;

    /**
     * G3 — varredura INTEGRAL, no lugar do prefixo de 200 caracteres.
     *
     * O `slice(0, 200)` que estava aqui alimentava o gate de LLM com um pedaço
     * do texto, e a heurística nunca olhou conteúdo nenhum. Um CPF no caractere
     * 400 atravessava os dois. A varredura percorre o payload inteiro, só
     * ELEVA, e cobertura incompleta vale `high` — porque a alternativa é
     * liberar um payload que ninguém terminou de ler.
     */
    const scan = scanPayload(input.content_payload ?? input.content_text);
    const piso = riskFloorFromScan(scan);

    const scored = await scoreKnowledge(
      {
        knowledge_type,
        topic: sensitivityToTopic(input.proposer_sensitivity_hint),
        derived_confidence,
        // evidence_count: not available in the KSM input shape; omit (scorer
        // treats undefined as 0, which makes regra/procedimento ambiguous —
        // conservative default, matches stub behaviour of routing rule→pending).
      },
      // O gate continua recebendo texto truncado, e agora isso é seguro: ele
      // não é mais o único a ver conteúdo, e o que ele pode fazer é ELEVAR.
      { gate, contextText: input.content_text.slice(0, 200) },
    );

    // Map ScoredRisk → KnowledgeRiskScoreOutput
    const level = maisRestritivo(scored.level as KnowledgeRiskLevel, piso);
    const sensitivity: KnowledgeSensitivity =
      level === 'critical' || level === 'high' ? 'high' : level === 'medium' ? 'medium' : 'low';

    const reasons = [
      ...scored.triggers.map((t) => t.signal),
      ...(scored.llm_reason ? [`llm:${scored.llm_reason}`] : []),
      // Os achados entram como SINAL e CAMINHO, nunca o valor: o motivo da
      // elevação vai para auditoria e console, e copiar o CPF para o campo que
      // explica por que o CPF é sensível seria o mesmo vazamento noutro lugar.
      ...scan.findings.map((f) => `scan:${f.signal}@${f.path}`),
      ...(scan.coverage === 'incomplete' ? [`scan:incomplete:${scan.reason}`] : []),
    ];

    const source: KnowledgeRiskScoreOutput['source'] =
      scored.decided_by === 'llm_upgrade' ? 'llm_elevated' : 'p9c:knowledge';

    return { level, sensitivity, reasons, source };
  }
}

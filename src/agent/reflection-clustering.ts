import { stripDiacritics } from '@/lib/utils.js';

/**
 * G1 (spec §7.6.1 itens 1 e 2) — UM SINAL DE CORREÇÃO, COM DONO.
 *
 * ─── O que estava faltando, e por que importava ─────────────────────────────
 *
 * O tipo tinha três campos: `alvo_id`, `descricao` e `contexto`. Nenhum deles
 * diz de QUEM é o dado corrigido, e a chave do cluster era só a descrição
 * normalizada. A consequência é direta: duas correções com a mesma descrição,
 * feitas sobre dados de pessoas diferentes, caíam no MESMO cluster, e a regra
 * proposta a partir dele era derivada de um conjunto que mistura titulares.
 *
 * A spec enumera exatamente esses campos como obrigatórios e é explícita sobre
 * a consequência: "Cluster por tenant/agente/**titular/finalidade** antes de
 * qualquer chamada de modelo. Mesma descrição em A/B não funde clusters."
 *
 * ─── O ator não é o titular ─────────────────────────────────────────────────
 *
 * `actor_pessoa_id` e `data_subject_ref` são campos SEPARADOS de propósito. O
 * §7.6.1 item 1 diz: "`pessoa_id` é o ator da correção, **não presumir que
 * seja titular de todos os dados do payload**". Quem corrige pode ser um
 * operador, um dono de empresa, um terceiro autorizado — e tratar o ator como
 * titular é como o dado de uma pessoa acaba num cluster que fala de outra.
 *
 * Quando o titular não é demonstrável, o sinal NÃO entra num cluster: vai para
 * quarentena (`quarantineSignals`), que é o que a mesma linha da spec manda.
 */
export type CorrectionSignal = {
  alvo_id: string | null;
  descricao: string;
  contexto: Record<string, unknown>;
  /** Id ESTÁVEL do evento de auditoria que originou o sinal. Linhagem. */
  source_event_id: string;
  /** Quando o evento aconteceu. Entra na linhagem, não na chave. */
  occurred_at: string;
  /** Quem FEZ a correção. Não é, por si, titular do dado corrigido. */
  actor_pessoa_id: string | null;
  /**
   * De quem é o dado. `null` quando não foi possível demonstrar — e nesse caso
   * o sinal não é agrupado, é posto em quarentena.
   */
  data_subject_ref: string | null;
  conversa_id: string | null;
  /** Finalidade declarada do tratamento. Entra na chave do cluster. */
  purpose: string | null;
  /** Recurso autorizado a que a correção se refere. */
  authorized_resource: string | null;
};

export type Cluster = {
  key: string;
  descricao_normalized: string;
  /** Titular COMUM a todos os sinais do cluster. Nunca misturado. */
  data_subject_ref: string;
  purpose: string | null;
  signals: CorrectionSignal[];
};

/** Por que um sinal não pôde ser agrupado. */
export type QuarantinedSignal = {
  signal: CorrectionSignal;
  reason: 'subject_not_demonstrable' | 'empty_descricao';
};

export type ClusteringResult = {
  clusters: Cluster[];
  quarantined: QuarantinedSignal[];
};

const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'a',
  'o',
  'as',
  'os',
  'e',
  'em',
  'no',
  'na',
  'um',
  'uma',
  'pra',
  'para',
  'por',
  'com',
  'sem',
]);

export function normalizeDescricao(input: string): string {
  return stripDiacritics(input.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, 4)
    .join(' ');
}

/**
 * A CHAVE do cluster.
 *
 * Titular e finalidade entram ANTES da descrição, e o separador é um caractere
 * que não aparece em UUID nem na descrição normalizada (que passa por
 * `normalizeDescricao` e só tem `[a-z0-9 ]`). Sem um separador reservado,
 * `"a|b" + "c"` e `"a" + "b|c"` produziriam a mesma chave — colisão silenciosa
 * entre titulares, que é precisamente o defeito que esta chave existe para
 * impedir.
 *
 * `tenant` e `agent` NÃO entram: o worker já roda um `runWithTenantContext`
 * por par, e a consulta filtra por eles. Repetir aqui daria a impressão de uma
 * segunda barreira que não existe — o isolamento é do escopo, não da string.
 */
function clusterKey(subject: string, purpose: string | null, norm: string): string {
  return `${subject}\u0000${purpose ?? ''}\u0000${norm}`;
}

/**
 * Agrupa sinais de correção por (titular, finalidade, descrição normalizada).
 *
 * Um cluster de tamanho >= 2 significa o mesmo tipo de erro repetido — o sinal
 * mais forte de que uma regra é necessária. Singletons ainda produzem
 * candidato, com prioridade menor.
 *
 * O que mudou em relação à versão anterior: sinais sem titular demonstrável
 * saem do fluxo em vez de entrarem num cluster qualquer, e a mesma descrição
 * sobre titulares diferentes produz clusters DIFERENTES.
 */
export function clusterCorrections(signals: CorrectionSignal[]): ClusteringResult {
  const map = new Map<string, Cluster>();
  const quarantined: QuarantinedSignal[] = [];

  for (const s of signals) {
    const norm = normalizeDescricao(s.descricao);
    if (!norm) {
      quarantined.push({ signal: s, reason: 'empty_descricao' });
      continue;
    }
    if (s.data_subject_ref === null || s.data_subject_ref.length === 0) {
      // §7.6.1 item 1: "se não for demonstrável, quarentena". Usar o ator como
      // titular aqui seria a presunção que a spec proíbe nominalmente.
      quarantined.push({ signal: s, reason: 'subject_not_demonstrable' });
      continue;
    }

    const key = clusterKey(s.data_subject_ref, s.purpose, norm);
    const existing = map.get(key);
    if (existing) {
      existing.signals.push(s);
    } else {
      map.set(key, {
        key,
        descricao_normalized: norm,
        data_subject_ref: s.data_subject_ref,
        purpose: s.purpose,
        signals: [s],
      });
    }
  }

  // Clusters com mais sinais primeiro (evidência mais forte).
  const clusters = [...map.values()].sort((a, b) => b.signals.length - a.signals.length);
  return { clusters, quarantined };
}

/**
 * A CHAVE DE DEDUPE PERSISTIDA de um cluster (§7.6.1 item 3).
 *
 * O worker usava `rulesRepo.findByContext` para decidir se já havia proposto
 * aquilo. Isso não serve para idempotência de aprendizado por duas razões, e a
 * segunda é a que quebra: ele procura só entre regras VISÍVEIS, e uma proposta
 * pendente de revisão não é visível. Ou seja, toda rodada do lote reabria
 * proposta para o mesmo cluster enquanto o humano não decidisse — a fila
 * enchia com duplicatas da mesma decisão.
 *
 * A chave inclui titular, tipo e as FONTES, e não só a descrição: dois
 * clusters com a mesma descrição e fontes diferentes são propostas
 * diferentes, e colapsá-los esconderia evidência nova.
 */
export function clusterDedupeKey(cluster: Cluster, kind: string): string {
  const fontes = cluster.signals
    .map((s) => s.source_event_id)
    .filter((id) => id.length > 0)
    .sort()
    .join(',');
  return [
    'learning',
    kind,
    cluster.data_subject_ref,
    cluster.purpose ?? '',
    cluster.descricao_normalized,
    fontes,
  ].join('\u0000');
}

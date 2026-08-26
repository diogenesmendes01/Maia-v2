/**
 * #636 (fatia A da épica #471) — o CONTRATO do "pedido de ferramenta".
 *
 * Um pedido de ferramenta é o que um gap recorrente vira quando o que falta é
 * uma TOOL QUE NÃO EXISTE. Ele responde as quatro perguntas que hoje um dev
 * teria de reconstruir do zero para avaliar o pedido:
 *
 *   1. o que o agente queria fazer .... `intent`
 *   2. em que situações reais ......... `situations` (link para o trace do turno)
 *   3. quantas vezes, em que janela ... `frequency`
 *   4. qual seria o contrato .......... `contract_draft` (rascunho Zod)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL — e por que ele mora TAMBÉM aqui
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Nada nesta fatia
 * registra tool, executa código proposto ou cria capability. Uma proposta é um
 * DOCUMENTO INERTE.
 *
 * `contract_draft.zod_source` é a peça que mais se parece com código de
 * produção — e é exatamente por isso que ela é a mais perigosa de deixar
 * ambígua. É TEXTO: nunca é `eval`/`Function`/`import`, nunca vira entrada do
 * registro de tools (`src/tools/_registry.ts`), nunca é comparada com o
 * contrato vigente de uma tool instalada.
 *
 * A marcação que impede a confusão é redundante DE PROPÓSITO, em três camadas
 * independentes:
 *
 *   · `contract_status: 'draft_proposal_not_in_force'` — o literal Zod abaixo.
 *     Um spec sem ele não passa por `ToolRequestSpecSchema`.
 *   · o CHECK `capability_proposals_tool_request_marking_check` (migração 125)
 *     — um INSERT sem a marcação é RECUSADO PELO BANCO, venha de onde vier
 *     (inclusive de um `psql`, que não passa por Zod nenhum).
 *   · o cabeçalho literal de `zod_source` (`MARCADOR_DE_RASCUNHO`), para que a
 *     marcação sobreviva a um copiar-e-colar do trecho para fora do JSON.
 *
 * Uma camada só seria contornável por quem editasse o outro lado; as três
 * juntas exigem que alguém desfaça deliberadamente a marcação em código, em
 * SQL e no texto — e cada uma delas tem teste que fica vermelho quando isso
 * acontece.
 */
import { z } from 'zod';

/** O `capability_type` da linha em `capability_proposals`. */
export const TOOL_REQUEST_CAPABILITY_TYPE = 'tool_request' as const;

/** Discriminador do `proposed_spec` — casado com o CHECK da migração 125. */
export const TOOL_REQUEST_SPEC_KIND = 'tool_request' as const;

/**
 * A MARCAÇÃO. Não é decorativa: o CHECK da migração 125 exige literalmente este
 * valor em `proposed_spec->>'contract_status'`. Mudá-lo aqui sem mudar a
 * migração torna toda proposta irrecusável — no sentido de recusada pelo banco.
 */
export const TOOL_REQUEST_CONTRACT_STATUS = 'draft_proposal_not_in_force' as const;

/** Versão do formato do spec. Sobe quando o shape mudar de forma incompatível. */
export const TOOL_REQUEST_SPEC_VERSION = 1 as const;

/** O guardrail, escrito na própria linha, para quem lê o JSON cru. */
export const TOOL_REQUEST_GUARDRAIL =
  'o agente especifica; humano implementa e instala' as const;

/**
 * Cabeçalho obrigatório de `zod_source`. Sobrevive ao copiar-e-colar: quem tirar
 * o trecho do JSON e colar num arquivo `.ts` leva o aviso junto.
 */
export const MARCADOR_DE_RASCUNHO = '// PROPOSTA — NÃO É CONTRATO VIGENTE.';

/**
 * Uma SITUAÇÃO: uma ocorrência real do gap, com o link do turno.
 *
 * `trace_resolved` é o que separa link de promessa. Ele é `true` só quando o
 * envelope existe EM `runtime_trace_envelopes` NO MESMO tenant+agent (ver
 * `capabilityGapObservationsRepo.resolveTraceIdsInScope`). Um id que não
 * resolve — porque a retenção já purgou o envelope, ou porque apontava para
 * fora do escopo — vira situação SEM link, nunca link inválido.
 */
export const SituacaoSchema = z
  .object({
    observed_at: z.string(),
    conversa_id: z.string().uuid().nullable(),
    root_trace_id: z.string().uuid().nullable(),
    trace_id: z.string().uuid().nullable(),
    trace_resolved: z.boolean(),
    intent: z.string(),
    detail: z.string().nullable(),
  })
  .strict();
export type Situacao = z.infer<typeof SituacaoSchema>;

/**
 * A frequência COM JANELA. `occurrences` conta as observações usadas; a janela
 * é o intervalo entre a primeira e a última delas. `gap_frequency_score` é o
 * contador do gap, mantido lado a lado de propósito: os dois números divergem
 * quando o ledger de observações começou depois do gap, e esconder isso faria
 * a proposta mentir sobre a própria evidência.
 */
export const FrequenciaSchema = z
  .object({
    occurrences: z.number().int().nonnegative(),
    window_days: z.number().nonnegative(),
    first_observed_at: z.string(),
    last_observed_at: z.string(),
    gap_frequency_score: z.number().int(),
    gap_severity_score: z.number().int(),
  })
  .strict();
export type Frequencia = z.infer<typeof FrequenciaSchema>;

/**
 * Um campo do rascunho de contrato.
 *
 * NÃO carrega amostra de valor, e isso é decisão de privacidade, não economia:
 * `attempted_args` vem de turno real e pode conter dado do interlocutor. O nome
 * da chave e o tipo inferido bastam para um dev desenhar o contrato; o VALOR
 * observado não acrescenta nada ao desenho e transformaria a proposta — um
 * documento feito para circular entre humanos — em vazamento.
 */
export const CampoDoContratoSchema = z
  .object({
    name: z.string().min(1),
    /** Expressão Zod inferida do tipo observado, ex.: `z.string()`. */
    zod: z.string().min(1),
    /** `true` quando a chave apareceu em TODAS as ocorrências com argumentos. */
    required: z.boolean(),
    /** Em quantas ocorrências a chave foi observada. Evidência, não palpite. */
    observed_in: z.number().int().nonnegative(),
  })
  .strict();
export type CampoDoContrato = z.infer<typeof CampoDoContratoSchema>;

/**
 * `completeness` diz o que o rascunho SABE, em vez de preencher o que não sabe.
 *
 *   · `name_only` .................... nenhuma ocorrência registrou argumentos
 *                                      nem retorno esperado: só o nome.
 *   · `partially_observed` ........... um dos dois lados saiu de evidência.
 *   · `inputs_and_outputs_observed` .. os dois lados saíram de evidência.
 *
 * Um rascunho com campos inventados pareceria mais completo e valeria menos:
 * o dev perderia tempo desenhando contra um contrato que ninguém observou.
 */
export const ContratoRascunhoSchema = z
  .object({
    proposed_tool_name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    completeness: z.enum(['name_only', 'partially_observed', 'inputs_and_outputs_observed']),
    inputs: z.array(CampoDoContratoSchema),
    outputs: z.array(CampoDoContratoSchema),
    /** TEXTO INERTE. Nunca avaliado, nunca registrado. Ver o cabeçalho. */
    zod_source: z.string().startsWith(MARCADOR_DE_RASCUNHO),
  })
  .strict();
export type ContratoRascunho = z.infer<typeof ContratoRascunhoSchema>;

/**
 * O `proposed_spec` inteiro de uma proposta `tool_request`.
 *
 * `.strict()` em todos os níveis: uma chave a mais é erro, não enriquecimento.
 * Um spec que o schema recusa NÃO vira proposta — a fatia falha fechada em vez
 * de persistir um documento que o console de triagem (#638) não saberia ler.
 */
export const ToolRequestSpecSchema = z
  .object({
    spec_kind: z.literal(TOOL_REQUEST_SPEC_KIND),
    spec_version: z.literal(TOOL_REQUEST_SPEC_VERSION),
    contract_status: z.literal(TOOL_REQUEST_CONTRACT_STATUS),
    guardrail: z.literal(TOOL_REQUEST_GUARDRAIL),
    gap_id: z.string().uuid(),
    intent: z.string().min(1),
    situations: z.array(SituacaoSchema),
    frequency: FrequenciaSchema,
    contract_draft: ContratoRascunhoSchema,
  })
  .strict();
export type ToolRequestSpec = z.infer<typeof ToolRequestSpecSchema>;

/**
 * `true` só para um `proposed_spec` que se declara rascunho de proposta pelas
 * DUAS chaves que o CHECK do banco também exige. É o predicado que qualquer
 * leitor (console, relatório, export) deve usar antes de mostrar o
 * `zod_source` — nunca "é do tipo tool_request, então é rascunho".
 */
export function eRascunhoDeProposta(spec: unknown): boolean {
  if (typeof spec !== 'object' || spec === null) return false;
  const s = spec as Record<string, unknown>;
  return (
    s.spec_kind === TOOL_REQUEST_SPEC_KIND &&
    s.contract_status === TOOL_REQUEST_CONTRACT_STATUS
  );
}

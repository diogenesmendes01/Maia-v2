/**
 * SC25-A (spec §9.1 "Campos admitidos" e "Cobertura de auxiliares"; §6.10 itens
 * 3 e 6-7; §6.12 gate 11; T18) — o CONTRATO do request EFETIVO do cliente Hermes
 * PINADO. É a decisão D09 em forma executável.
 *
 * ─── O problema que este módulo resolve ─────────────────────────────────────
 *
 * O gateway admitia a enumeração LITERAL do §9.1. Isso é correto, mas não prova
 * nada sobre o cliente que existe: o §9.1 diz "capturar o request real do SHA
 * fixado e fechar JSON Schema explícito", e admite até "`max_tokens` OU o campo
 * de limite realmente emitido pelo cliente fixado". Enquanto a captura não
 * existe, um cliente que emitisse outro nome seria recusado com
 * `unsupported_parameter` — comportamento certo contra um payload desconhecido
 * e, ao mesmo tempo, a razão pela qual a coorte não podia ser habilitada.
 *
 * ─── O que está pinado aqui, e onde ele foi MEDIDO ──────────────────────────
 *
 * Os fatos abaixo vêm da captura executável
 * `tests/hermes-spike/hermes-inference-d09-capture.spec.ts`, cujo artefato
 * redigido está em `tests/hermes-spike/fixtures/d09-sdk-requests.json`
 * (principal, retry do SDK, follow-up e a lista auxiliar). Nada aqui foi
 * deduzido de leitura de SDK: cada campo foi observado chegando ao gateway.
 *
 *  1. o cliente emite EXATAMENTE `model`, `messages`, `stream`,
 *     `stream_options`, `tools` e o teto de saída — nada de `temperature`,
 *     `top_p` ou `tool_choice` no caminho textual comum;
 *  2. `stream: true` com `stream_options`; o relay tira os dois e chama o
 *     provider com `stream: false`, e o gateway reemite SSE — que é como a
 *     escolha "inicialmente `stream=false`" do §9.1 se realiza no ÚNICO ponto
 *     em que ela importa (o egresso), sem exigir um cliente que não streama;
 *  3. na família `gpt-5` o teto muda de nome (`max_completion_tokens`) e o
 *     prompt de sistema vira `developer` — observado, não presumido;
 *  4. nenhuma rota auxiliar/compressão aparece: a lista auxiliar do worker as
 *     mantém desligadas (ver `services/hermes_worker/main.py`), e é essa lista
 *     que a fixture guarda.
 *
 * ─── Por que isto é GATE e não documentação ─────────────────────────────────
 *
 * `checkPinnedSdkSurface` compara uma captura com o que o gateway ADMITE. Se o
 * SDK pinado passar a emitir um campo que o gateway não conhece (drift), ou se
 * alguém estreitar a lista admitida abaixo do que o cliente já envia, a função
 * devolve o achado e `assertPinnedSdkSurfaceReady` RECUSA — readiness bloqueada,
 * não degradada silenciosamente. "Não pedir ao usuário que escolha campos de
 * SDK" (AC04) é exatamente isto: a escolha é medida e verificada em CI.
 */
import { INFERENCE_ADMITTED_FIELDS } from './inference-gateway.js';

/** SHA do checkout Hermes contra o qual a captura foi feita. */
export const HERMES_PINNED_SDK_SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';

/** Campos de TOPO que o cliente pinado emitiu (captura, ordenados). */
export const PINNED_SDK_TOP_LEVEL_FIELDS = [
  'max_tokens',
  'messages',
  'model',
  'stream',
  'stream_options',
  'tools',
] as const;

/**
 * Nomes que o teto de saída pode ter. Os dois são recusa simultânea no gateway
 * (`parseInferenceRequest`), e é por isso que a captura precisa dizer QUAL veio.
 */
export const PINNED_SDK_OUTPUT_LIMIT_FIELDS = ['max_tokens', 'max_completion_tokens'] as const;

/**
 * Campos que só aparecem em família específica: o teto alternativo é o único
 * caso medido. O conjunto "pinado" é a UNIÃO, senão um pedido de `gpt-5`
 * apareceria como campo não pinado por não estar no caminho default.
 */
const PINNED_FIELDS_UNION: ReadonlySet<string> = new Set<string>([
  ...PINNED_SDK_TOP_LEVEL_FIELDS,
  ...PINNED_SDK_OUTPUT_LIMIT_FIELDS,
]);

/** Teto emitido na família default (não-gpt-5) observada. */
export const PINNED_SDK_DEFAULT_OUTPUT_LIMIT_FIELD = 'max_tokens';

/** Papéis de mensagem observados/previstos no caminho textual. */
export const PINNED_SDK_MESSAGE_ROLES = ['system', 'developer', 'user', 'assistant', 'tool'] as const;

/**
 * Desvios por FAMÍLIA de modelo, observados. A lista larga de famílias que o
 * cliente troca (`utils.model_forces_max_completion_tokens`) já é coberta pelo
 * gateway, que admite os DOIS nomes e o papel `developer`; aqui fica o que foi
 * medido ponta a ponta, com o caso do spike que o mede.
 */
export const PINNED_SDK_FAMILIES: Record<string, { output_limit_field: string; system_role: string }> = {
  'gpt-5': { output_limit_field: 'max_completion_tokens', system_role: 'developer' },
};

/**
 * Rotas auxiliares/compressão PERMITIDAS fora do relay de inferência. Vazia é o
 * estado correto e o único admitido: o §9.1 exige que toda rota auxiliar
 * habilitada passe pelo mesmo enforcement. Uma rota auxiliar que constrói
 * cliente próprio escaparia do gateway — a lista auxiliar autoritativa vive em
 * `services/hermes_worker/main.py` (que é quem renderiza o `config.yaml`), e
 * esta constante existe para que o lado Maia recuse a mesma coisa.
 */
export const PINNED_SDK_AUX_ROUTES_ALLOWED_OUTSIDE_RELAY: readonly string[] = [];

/** Um request efetivo observado, já redigido (só estrutura). */
export interface PinnedSdkObservedRequestV1 {
  top_level_fields: readonly string[];
  message_roles?: readonly string[];
  output_limit_field?: string | null;
}

export interface PinnedSdkSurfaceInputV1 {
  /** SHA do checkout que produziu a captura. */
  hermes_sha: string;
  /** Requests observados. Vazio é válido: significa "só a consistência interna". */
  requests?: readonly PinnedSdkObservedRequestV1[];
  /** Lista admitida pelo gateway. Injetável para que o gate seja testável. */
  admitted_fields?: readonly string[];
  /** Papéis admitidos. Injetável pelo mesmo motivo. */
  admitted_roles?: readonly string[];
  /** Rotas auxiliares permitidas fora do relay. */
  aux_allowed_outside_relay?: readonly string[];
}

export type PinnedSdkDriftFindingV1 =
  /** O cliente emite um campo que o gateway NÃO admite: ele seria recusado. */
  | { kind: 'gateway_cannot_admit_field'; field: string }
  /** A captura traz um campo que o contrato pinado não declara. */
  | { kind: 'field_not_pinned'; field: string }
  /** O teto de saída veio com nome que o contrato não reconhece. */
  | { kind: 'unpinned_output_limit_field'; field: string }
  /** Papel de mensagem fora do vocabulário admitido. */
  | { kind: 'role_not_admitted'; role: string }
  /** Rota auxiliar habilitada fora do relay. */
  | { kind: 'aux_route_outside_relay'; route: string }
  /** A captura é de outro checkout: o pin não descreve o cliente. */
  | { kind: 'hermes_sha_mismatch'; observed: string; pinned: string };

export type PinnedSdkSurfaceVerdictV1 =
  | { ok: true; checked_requests: number }
  | { ok: false; findings: readonly PinnedSdkDriftFindingV1[] };

export class PinnedSdkSurfaceDriftError extends Error {
  readonly findings: readonly PinnedSdkDriftFindingV1[];

  constructor(findings: readonly PinnedSdkDriftFindingV1[]) {
    // Mensagem SEM conteúdo de conversa: só tipos e nomes de campo.
    super(
      `pinned_sdk_surface_drift: ${findings
        .map((f) => f.kind + ':' + ('field' in f ? f.field : 'role' in f ? f.role : 'route' in f ? f.route : f.observed))
        .join(',')}`,
    );
    this.name = 'PinnedSdkSurfaceDriftError';
    this.findings = findings;
  }
}

/**
 * Compara a captura (ou o pin interno, quando não há captura) com o que o
 * gateway admite. Função TOTAL: devolve TODOS os achados, não o primeiro — quem
 * lê o relatório precisa ver a extensão do drift, não a primeira linha dele.
 */
export function checkPinnedSdkSurface(input: PinnedSdkSurfaceInputV1): PinnedSdkSurfaceVerdictV1 {
  const findings: PinnedSdkDriftFindingV1[] = [];
  const visto = new Set<string>();
  // Achado repetido não é achado novo: o mesmo campo pode aparecer na checagem
  // estática e na captura, e o relatório não deve engrossar por isso.
  const anotar = (f: PinnedSdkDriftFindingV1): void => {
    const alvo = 'field' in f ? f.field : 'role' in f ? f.role : 'route' in f ? f.route : f.observed;
    const chave = `${f.kind}:${alvo}`;
    if (visto.has(chave)) return;
    visto.add(chave);
    findings.push(f);
  };
  if (input.hermes_sha !== HERMES_PINNED_SDK_SHA) {
    anotar({
      kind: 'hermes_sha_mismatch',
      observed: input.hermes_sha,
      pinned: HERMES_PINNED_SDK_SHA,
    });
  }
  const admitted = new Set<string>(input.admitted_fields ?? INFERENCE_ADMITTED_FIELDS);
  const pinned = PINNED_FIELDS_UNION;
  const rolesAdmitidos = new Set<string>(input.admitted_roles ?? PINNED_SDK_MESSAGE_ROLES);
  const tetos = new Set<string>(PINNED_SDK_OUTPUT_LIMIT_FIELDS);

  // Consistência ESTÁTICA: todo campo que o contrato pina tem de continuar
  // admitido pelo gateway, mesmo quando a captura de hoje não o exercitou — é o
  // caso do teto por família (`max_completion_tokens`), que só aparece no
  // request de gpt-5. Sem esta linha, estreitar a lista abaixo dele passaria
  // enquanto nenhuma captura de família existisse.
  for (const field of PINNED_FIELDS_UNION) {
    if (!admitted.has(field)) anotar({ kind: 'gateway_cannot_admit_field', field });
  }

  const requests = input.requests ?? [];
  for (const req of requests) {
    for (const field of req.top_level_fields) {
      if (!admitted.has(field)) anotar({ kind: 'gateway_cannot_admit_field', field });
      if (!pinned.has(field)) anotar({ kind: 'field_not_pinned', field });
    }
    for (const role of req.message_roles ?? []) {
      if (!rolesAdmitidos.has(role)) anotar({ kind: 'role_not_admitted', role });
    }
    if (req.output_limit_field != null && !tetos.has(req.output_limit_field)) {
      anotar({ kind: 'unpinned_output_limit_field', field: req.output_limit_field });
    }
  }

  for (const route of input.aux_allowed_outside_relay ?? PINNED_SDK_AUX_ROUTES_ALLOWED_OUTSIDE_RELAY) {
    anotar({ kind: 'aux_route_outside_relay', route });
  }

  return findings.length === 0
    ? { ok: true, checked_requests: requests.length }
    : { ok: false, findings };
}

/**
 * Readiness do motor remoto: o pin do SDK tem de ser consistente com o gateway.
 *
 * Roda no ponto em que a implantação sintética é aceita. A consistência interna
 * (sem captura) já é o suficiente para pegar a regressão que importa: alguém
 * estreitar `INFERENCE_ADMITTED_FIELDS` abaixo do que o cliente pinado JÁ envia
 * derruba inferência em produção silenciosamente; aqui isso reprova a
 * construção do runtime, com um erro de código fechado.
 */
export function assertPinnedSdkSurfaceReady(
  input?: Pick<PinnedSdkSurfaceInputV1, 'requests'>,
): void {
  const verdict = checkPinnedSdkSurface({
    hermes_sha: HERMES_PINNED_SDK_SHA,
    requests:
      input?.requests ??
      PINNED_SDK_TOP_LEVEL_FIELDS.map((field) => ({
        top_level_fields: [field],
        message_roles: [...PINNED_SDK_MESSAGE_ROLES],
        output_limit_field: PINNED_SDK_DEFAULT_OUTPUT_LIMIT_FIELD,
      })),
  });
  if (!verdict.ok) throw new PinnedSdkSurfaceDriftError(verdict.findings);
}
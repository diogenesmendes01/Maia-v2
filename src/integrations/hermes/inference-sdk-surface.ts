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
 * `tests/integration/hermes-inference-d09-capture.spec.ts`, cujo artefato
 * redigido está em `tests/fixtures/d09-sdk-requests.json`
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

/**
 * Headers que a rota ADMITE num pedido de inferência. AC03: "Headers/body
 * desconhecidos … recusados" — a lista é FECHADA, e o que não está nela (nem
 * casa com um prefixo declarado) é recusado com `invalid_request` antes de o
 * corpo ser lido.
 *
 * São DUAS origens, e por isso ficam separadas:
 *
 *  1. `INFERENCE_REQUEST_HEADERS_STANDARD` — o que um cliente HTTP/1.1 precisa
 *     para falar com a rota (RFC 9110) mais o que Fastify/undici/httpx emitem.
 *     Sem eles o transporte não funciona; e os headers de PROXY continuam
 *     recusados antes (`isInternalRequest` → 404), inclusive `via`/`forwarded`.
 *  2. `INFERENCE_REQUEST_HEADER_PREFIXES` — o que o cliente pinado REALMENTE
 *     envia, MEDIDO na captura D09 (seção `headers` da fixture). `x-stainless-*`
 *     é o fingerprint do gerador do SDK
 *     (lang/package-version/os/arch/runtime/runtime-version/retry-count/
 *     read-timeout): a FAMÍLIA é estável, os valores não — por isso é prefixo, e
 *     o teste confere que TODO header observado está coberto por esta lista.
 *
 * Autoridade NÃO viaja por header: `authorization` carrega só o grant de
 * inferência (hash no banco), e qualquer header de autoridade alternativo
 * (`openai-organization`, `x-maia-tenant`, `x-model`, `x-provider-base-url`,
 * `x-session-id`) cai fora da lista e RECUSA. Ampliar a lista é uma decisão
 * visível: exige a medição (o header na captura) e a linha aqui.
 */
export const INFERENCE_REQUEST_HEADERS_STANDARD: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'pragma',
  /**
   * MEDIDO: o `fetch` do runtime Node (undici) marca todo pedido com
   * `sec-fetch-mode: cors`. Não carrega autoridade — é metadado do transporte,
   * e sem ele qualquer chamador que use `fetch` legítimo levaria 400.
   */
  'sec-fetch-mode',
  'te',
  'transfer-encoding',
  'user-agent',
];

/**
 * Famílias de header do cliente pinado, admitidas por PREFIXO porque o VALOR
 * muda (arquitetura, versão do pacote, contagem de retry) e a família não:
 * `x-stainless-*` é o fingerprint do gerador do SDK. Os nomes exatos medidos
 * ficam na seção `headers` da fixture D09, e o teste confere que TODO header
 * observado é coberto por esta lista (nome exato do transporte OU prefixo).
 */
export const INFERENCE_REQUEST_HEADER_PREFIXES: readonly string[] = ['x-stainless-'];

/** Lista efetiva admitida pela rota (e conferida contra a captura). */
export const INFERENCE_REQUEST_HEADERS_ALLOWED: readonly string[] = [
  ...INFERENCE_REQUEST_HEADERS_STANDARD,
];

/**
 * NOMES de header que o cliente pinado REALMENTE emitiu na captura D09 — o par
 * exato de `PINNED_SDK_TOP_LEVEL_FIELDS`: lá são os campos do corpo, aqui os
 * headers. `x-stainless-*` entra NOME A NOME (arch, async, lang, os,
 * package-version, read-timeout, retry-count, runtime, runtime-version) porque
 * o gate compara o NOME medido contra a lista fechada; a FAMÍLIA é que é
 * admitida por prefixo, para não quebrar quando só o valor muda.
 *
 * A readiness confere estes nomes contra a lista admitida: estreitar a lista
 * abaixo do que o SDK já envia derruba inferência em produção silenciosamente,
 * e é isso que o gate reprova antes.
 */
export const PINNED_SDK_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-async',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-read-timeout',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
];

export interface InferenceHeaderVerdictV1 {
  ok: boolean;
  /** Headers apresentados que a lista NÃO admite (nomes, sem valor). */
  refused: readonly string[];
}

/**
 * Confere os headers de um pedido contra a lista fechada. Devolve TODOS os
 * recusados (não o primeiro): o relatório precisa da extensão da divergência.
 * Comparação sem case (o Node já entrega minúsculo; header é case-insensitive).
 */
export function checkInferenceRequestHeaders(
  headers: Readonly<Record<string, unknown>>,
  options: {
    allowed?: readonly string[];
    prefixes?: readonly string[];
  } = {},
): InferenceHeaderVerdictV1 {
  const allowed = new Set((options.allowed ?? INFERENCE_REQUEST_HEADERS_ALLOWED).map((h) => h.toLowerCase()));
  const prefixes = (options.prefixes ?? INFERENCE_REQUEST_HEADER_PREFIXES).map((p) => p.toLowerCase());
  const refused: string[] = [];
  for (const nome of Object.keys(headers)) {
    const h = nome.toLowerCase();
    if (allowed.has(h)) continue;
    if (prefixes.some((p) => h.startsWith(p))) continue;
    refused.push(h);
  }
  return { ok: refused.length === 0, refused: refused.sort() };
}

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
  /** Headers observados na captura (só NOMES). Vazio dispensa a checagem. */
  observed_headers?: readonly string[];
  /** Lista admitida de headers. Injetável pelo mesmo motivo dos campos. */
  admitted_headers?: readonly string[];
  /** Prefixos de header admitidos (famílias do SDK). */
  admitted_header_prefixes?: readonly string[];
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
  | { kind: 'hermes_sha_mismatch'; observed: string; pinned: string }
  /**
   * O cliente emite um header que a rota NÃO admite: a recusa de header
   * derrubaria a chamada do SDK pinado (mesma classe do campo não admitido).
   */
  | { kind: 'observed_header_not_allowed'; header: string };

export type PinnedSdkSurfaceVerdictV1 =
  | { ok: true; checked_requests: number }
  | { ok: false; findings: readonly PinnedSdkDriftFindingV1[] };

/** Rótulo curto de um achado: tipo + o NOME do alvo, nunca conteúdo. */
function driftTarget(f: PinnedSdkDriftFindingV1): string {
  if ('field' in f) return f.field;
  if ('role' in f) return f.role;
  if ('route' in f) return f.route;
  if ('header' in f) return f.header;
  return f.observed;
}

export class PinnedSdkSurfaceDriftError extends Error {
  readonly findings: readonly PinnedSdkDriftFindingV1[];

  constructor(findings: readonly PinnedSdkDriftFindingV1[]) {
    // Mensagem SEM conteúdo de conversa: só tipos e nomes de campo.
    super(`pinned_sdk_surface_drift: ${findings.map((f) => f.kind + ':' + driftTarget(f)).join(',')}`);
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
    const chave = `${f.kind}:${driftTarget(f)}`;
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

  // Headers: o cliente que emite um header fora da lista fechada seria RECUSADO
  // pela rota (`checkInferenceRequestHeaders`). É a mesma classe de drift do
  // campo não admitido — por isso mora no mesmo veredito, e por isso a captura
  // D09 guarda os NOMES de header observados.
  for (const raw of input.observed_headers ?? []) {
    const verdict = checkInferenceRequestHeaders({ [raw]: true }, {
      allowed: input.admitted_headers,
      prefixes: input.admitted_header_prefixes,
    });
    if (!verdict.ok) anotar({ kind: 'observed_header_not_allowed', header: verdict.refused[0]! });
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
 * estreitar `INFERENCE_ADMITTED_FIELDS` — ou a lista FECHADA de headers — abaixo
 * do que o cliente pinado JÁ envia derruba inferência em produção
 * silenciosamente; aqui isso reprova a construção do runtime, com um erro de
 * código fechado. Os dois fatos medidos (`PINNED_SDK_TOP_LEVEL_FIELDS` e
 * `PINNED_SDK_REQUEST_HEADERS`) entram por padrão; a injeção existe para o teste
 * provar que o gate MORDE.
 */
export function assertPinnedSdkSurfaceReady(
  input?: Pick<
    PinnedSdkSurfaceInputV1,
    'requests' | 'observed_headers' | 'admitted_headers' | 'admitted_header_prefixes'
  >,
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
    observed_headers: input?.observed_headers ?? PINNED_SDK_REQUEST_HEADERS,
    ...(input?.admitted_headers ? { admitted_headers: input.admitted_headers } : {}),
    ...(input?.admitted_header_prefixes
      ? { admitted_header_prefixes: input.admitted_header_prefixes }
      : {}),
  });
  if (!verdict.ok) throw new PinnedSdkSurfaceDriftError(verdict.findings);
}
/**
 * P05 (spec §6.9.1, §7.10.1; INV-03, INV-04, INV-10) — a POLÍTICA PURA do
 * broker: a superfície EFETIVA de ferramentas e a decisão de admissão por
 * chamada.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * §7.10.1, o enforcement NOVO da bridge, antes do dispatcher:
 *
 *   nomes permitidos = allowlist do deployment ∩ manifest do run ∩ grant vigente
 *                      do agente ∩ escopo efetivo da role ∩ tools da skill
 *                      ∩ capacidades autorizadas à pessoa/recurso − todos os denies
 *
 * É o INV-03 ("tool disponível = interseção das permissões do agente, role,
 * decisão, skill, cliente, modo e política atual") como função total.
 *
 * ─── A INVERSÃO deliberada em relação ao `runtime-filter.ts` ────────────────
 *
 * O §7.10.1 é explícito: "falha de lookup de uma role/skill requerida **não**
 * volta para baseline mais amplo. O runtime-filter atual permite ausência de role
 * narrowing e elimina scope de skill bloqueada (`runtime-filter.ts:132-185`); a
 * nova bridge não pode tratar isso como autorização para expandir tools."
 *
 * No filtro atual, eixo ausente = eixo que não estreita — e essa escolha é
 * defensável lá, porque o dispatcher continua sendo o piso e o eixo só pode
 * REMOVER. Aqui não: este é o único lugar que aplica o narrowing de skill por
 * turno (o dispatcher deliberadamente não o aplica, `_dispatcher.ts:300-324`),
 * então "não consegui resolver a skill" não pode significar "então vale tudo o
 * que o agente tem". Eixo que falha FECHA a superfície.
 *
 * ─── Por que PURO ───────────────────────────────────────────────────────────
 *
 * Sem `db`, sem ALS, sem env, sem métricas e sem o dispatcher. Os eixos entram
 * como PARÂMETRO, já resolvidos pelo chamador — se este módulo os lesse, todo
 * teste de política passaria a medir o banco do ambiente de teste em vez da
 * regra, que é a mesma razão registrada em `poison-policy.ts` e `recovery.ts`.
 *
 * ─── O que este módulo NÃO é ────────────────────────────────────────────────
 *
 * Não despacha. `decideToolCall` devolve admitir/recusar/adiar e nada mais: não
 * abre contexto, não reserva ledger, não chama `dispatchTool`. O §6.9.1 tem sete
 * passos e este arquivo é a parte determinística dos passos 1, 3 e 5 — os
 * passos que dependem do banco (reconsulta de lease/epoch, ledger, aprovação,
 * efeito) são de outra fatia, e fingir que estão aqui seria afirmar garantia que
 * este código não dá.
 */
import {
  INITIAL_TOOL_DENY,
  classifyReservedToolName,
  computeManifestDigest,
  type ManifestToolV1,
  type RuntimeManifestV1,
} from './manifest.js';
import {
  authorizeResourceRefs,
  checkFrameCorrelation,
  collectResourceRefs,
  type ResourceKind,
  type RunBindingV1,
} from './run-binding.js';

/**
 * Os SETE eixos do §7.10.1 e do INV-03. Conjunto fechado, e a ordem é a da
 * spec — é ela que o caso de teste "cada eixo sozinho remove" percorre.
 *
 * `subject` é "capacidades autorizadas à pessoa/recurso" e `policy` é "política
 * atual" (INV-03). Eles existem separados do `agent_grant` porque respondem a
 * perguntas diferentes: o grant é do AGENTE, o subject é do CLIENTE daquele run,
 * e a política é do tenant. Colapsá-los perderia a distinção que o T24 e o T22
 * medem em lados opostos.
 */
export const SURFACE_AXES = [
  'deployment',
  'manifest',
  'agent_grant',
  'role',
  'skill',
  'subject',
  'policy',
] as const;

export type SurfaceAxis = (typeof SURFACE_AXES)[number];

/**
 * O estado de um eixo. `not_applicable` e `lookup_failed` são fatos DIFERENTES,
 * e mantê-los separados é o que impede a confusão do §7.10.1: o primeiro é "este
 * run não tem role/skill por desenho", o segundo é "não consegui saber". Um
 * `null` para os dois transformaria uma falha de infraestrutura em declaração de
 * ausência — que é como um lookup quebrado vira autorização.
 */
export type ToolAxisV1 =
  | { kind: 'allow'; names: readonly string[] }
  | { kind: 'not_applicable' }
  | { kind: 'lookup_failed' };

/**
 * `baseline_only` é o "tipo de run" que o §7.10.1 autoriza a declarar conjunto
 * fechado sem role/skill. Não é um modo mais permissivo: os outros cinco eixos
 * continuam valendo integralmente.
 */
export type RunSurfaceKind = 'baseline_only' | 'scoped';

export interface ToolSurfaceInputV1 {
  run_kind: RunSurfaceKind;
  axes: Record<SurfaceAxis, ToolAxisV1>;
  /** O termo "− todos os denies" do §7.10.1, além do deny inicial do §7.10.3. */
  denies: readonly string[];
}

export interface SurfaceClosedReasonV1 {
  kind: 'lookup_failed' | 'axis_required';
  axis: SurfaceAxis;
}

export interface EffectiveSurfaceV1 {
  /** Ordenado e sem repetição: a superfície é um CONJUNTO. */
  names: string[];
  /**
   * Por que a superfície ficou vazia POR FECHAMENTO, e não por interseção. A
   * distinção é operacional: interseção vazia é configuração, fechamento é
   * incidente — e um dashboard que não os separa mostra os dois como "0 tools".
   */
  closed_reason: SurfaceClosedReasonV1 | null;
}

const FECHADA = (reason: SurfaceClosedReasonV1): EffectiveSurfaceV1 => ({
  names: [],
  closed_reason: reason,
});

/**
 * A interseção do INV-03. Função TOTAL.
 *
 * Fail-closed em três lugares, e nenhum deles é redundante:
 *
 *  1. eixo com lookup falho → superfície VAZIA (T23: "fail-closed; não fallback
 *     para baseline/owner");
 *  2. role/skill ausente em run `scoped` → superfície VAZIA. É a inversão do
 *     cabeçalho;
 *  3. nome reservado ou no deny inicial não sobrevive nem que TODOS os eixos o
 *     listem. É defesa em profundidade contra um eixo mal carregado, e é o que
 *     garante o K-19 mesmo se alguém alimentar a superfície por fora do manifest.
 */
export function computeEffectiveToolSurface(input: ToolSurfaceInputV1): EffectiveSurfaceV1 {
  const conjuntos: Array<ReadonlySet<string>> = [];

  for (const axis of SURFACE_AXES) {
    const eixo = input.axes[axis];
    if (eixo.kind === 'lookup_failed') {
      return FECHADA({ kind: 'lookup_failed', axis });
    }
    if (eixo.kind === 'not_applicable') {
      const podeFaltar =
        input.run_kind === 'baseline_only' && (axis === 'role' || axis === 'skill');
      if (!podeFaltar) return FECHADA({ kind: 'axis_required', axis });
      continue;
    }
    conjuntos.push(new Set(eixo.names));
  }

  const denies = new Set(input.denies);
  const [primeiro, ...resto] = conjuntos;
  const nomes = new Set<string>();
  for (const nome of primeiro ?? []) {
    if (!resto.every((c) => c.has(nome))) continue;
    if (denies.has(nome)) continue;
    if (INITIAL_TOOL_DENY.has(nome)) continue;
    if (classifyReservedToolName(nome) !== null) continue;
    nomes.add(nome);
  }

  return { names: [...nomes].sort(), closed_reason: null };
}

// ─── argumentos ─────────────────────────────────────────────────────────────

/**
 * Campos que NUNCA são argumento de negócio, em nenhuma profundidade e mesmo que
 * o schema da ferramenta os declare (T20).
 *
 * O §6.9.1 item 3 manda "rejeitar campos de identidade/proveniência/aprovação
 * que não pertencem ao schema" — e este conjunto vai além, recusando-os
 * ainda que pertençam, porque um schema de tool que declarasse `approved` seria
 * o próprio defeito. §5.3.3 tem a mesma postura no wire.
 *
 * O que NÃO está aqui, de propósito: `pessoa_id`, `conversa_id`, `entidade_id`.
 * O §6.9.1 item 3 os chama de "recursos legítimos em domínio", que "só selecionam
 * objetos DENTRO da ACL, nunca autoridade" — quem decide sobre eles é
 * `authorizeResourceRefs`, não uma recusa de sintaxe.
 */
export const RESERVED_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  'tenant_id',
  'agent_id',
  'run_id',
  'execution_id',
  'turn_id',
  'turn_attempt',
  'claim_token',
  'origin_claim_token',
  'dispatch_token',
  'control_epoch',
  'control_id',
  'approved',
  'approval',
  'approval_token',
  'approval_claim_token',
  'actor',
  'principal',
  'authorization',
  'api_key',
  'token',
  'grants',
  'permissions',
  'role_id',
  'dispatched',
  'side_effects_committed',
]);

export type ArgScreenResultV1 =
  | { kind: 'ok' }
  | {
      kind: 'reject';
      reason: 'reserved_argument' | 'unknown_argument' | 'too_deep';
      field: string;
    };

/**
 * O resultado da varredura por chave reservada. São TRÊS estados, e o terceiro é
 * a correção de um defeito real: a versão anterior devolvia `string | null`, e
 * `null` querendo dizer ao mesmo tempo "varri tudo e está limpo" e "desisti por
 * profundidade" é fail-OPEN — um `tenant_id` abaixo do teto atravessava como se
 * o payload tivesse sido conferido.
 *
 * Com três estados o tipo não consegue mais confundir as duas coisas: quem
 * consome é obrigado a decidir o que fazer com `too_deep`.
 */
type VarreduraReservadaV1 =
  | { kind: 'clean' }
  | { kind: 'found'; field: string }
  | { kind: 'too_deep'; field: string };

export const MAX_ARG_DEPTH = 16;

/**
 * Varre em busca de chave reservada. Estourar o teto é RECUSA, não silêncio.
 *
 * O teto continua existindo — ele protege a pilha, e subi-lo não consertaria
 * nada: 1000 níveis teria o mesmo defeito mais fundo. O que muda é a POSTURA no
 * limite. Note também que o teto daqui (16) é deliberadamente mais estrito que o
 * do wire (`WIRE_LIMITS.max_json_depth`, 32): existia portanto uma FAIXA — entre
 * 17 e 32 — em que o frame passava no P00 e esta varredura desistia calada. Era
 * exatamente a faixa explorável.
 *
 * A guarda de profundidade vem DEPOIS da checagem de tipo de propósito: um
 * escalar fundo não esconde nada abaixo de si, então recusá-lo seria recusar
 * payload legítimo sem ganho. O que dispara a recusa é estrutura NÃO VARRIDA.
 */
function encontraChaveReservada(
  valor: unknown,
  caminho: string,
  profundidade: number,
): VarreduraReservadaV1 {
  if (valor === null || typeof valor !== 'object') return { kind: 'clean' };
  if (profundidade > MAX_ARG_DEPTH) return { kind: 'too_deep', field: caminho || '$' };
  if (Array.isArray(valor)) {
    for (const [i, v] of valor.entries()) {
      const r = encontraChaveReservada(v, `${caminho}[${i}]`, profundidade + 1);
      if (r.kind !== 'clean') return r;
    }
    return { kind: 'clean' };
  }
  for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
    const caminhoFilho = caminho ? `${caminho}.${chave}` : chave;
    if (RESERVED_ARGUMENT_KEYS.has(chave)) return { kind: 'found', field: caminhoFilho };
    const r = encontraChaveReservada(v, caminhoFilho, profundidade + 1);
    if (r.kind !== 'clean') return r;
  }
  return { kind: 'clean' };
}

/**
 * Triagem de argumentos. Duas passadas, nesta ordem:
 *
 *  1. chave RESERVADA em qualquer profundidade — precede a triagem de
 *     desconhecido porque um `approved` declarado no schema tem de morrer
 *     mesmo assim;
 *  2. chave de primeiro nível fora do schema declarado.
 *
 * O que esta função NÃO faz, e é importante não confundir: ela não valida o
 * JSON Schema da ferramenta. Tipos, formatos, enums e a forma dos objetos
 * aninhados são do Zod do dispatcher (`_dispatcher.ts`), que já existe e é o
 * dono disso. Aqui se decide só o que a bridge acrescenta.
 */
export function screenToolArgs(
  declared: readonly string[],
  args: unknown,
): ArgScreenResultV1 {
  const varredura = encontraChaveReservada(args, '', 0);
  if (varredura.kind === 'found') {
    return { kind: 'reject', reason: 'reserved_argument', field: varredura.field };
  }
  if (varredura.kind === 'too_deep') {
    // Fail-closed: a recusa não afirma "achei algo ruim", afirma "não consigo
    // certificar este payload". Um payload fundo demais e inocente também morre,
    // e é deliberado — o contrário seria dar por conferido o que não foi varrido.
    return { kind: 'reject', reason: 'too_deep', field: varredura.field };
  }

  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const permitidas = new Set(declared);
    for (const chave of Object.keys(args as Record<string, unknown>)) {
      if (!permitidas.has(chave)) {
        return { kind: 'reject', reason: 'unknown_argument', field: chave };
      }
    }
  }
  return { kind: 'ok' };
}

// ─── decisão por chamada ────────────────────────────────────────────────────

/**
 * As razões de RECUSA do broker. Fechado, e cada membro é alcançável — um ramo
 * que nenhum caso consegue observar é um ramo que o próximo refactor apaga (a
 * lição registrada em `recovery.ts`).
 *
 * `approval_required` NÃO está aqui, e isso é uma CONTRADIÇÃO REGISTRADA, não um
 * esquecimento: o §6.9.2 fala em "retorno da tool `approval_required`", o
 * vocabulário durável tem o estado (`EngineToolCallStateV1`), mas o wire fechado
 * do P00 (`protocol.ts`, `tool.result`) não tem esse código de recusa — e
 * inventá-lo quebraria o espelho Python. Por isso a espera é uma disposição
 * PRÓPRIA (`defer`), e não uma recusa: uma recusa diria ao modelo "não pode",
 * quando a verdade é "ainda não".
 */
export const BROKER_REFUSAL_REASONS = [
  'binding_mismatch',
  'manifest_digest_mismatch',
  'context_lookup_failed',
  'tool_not_in_surface',
  'reserved_argument',
  'unknown_argument',
  /**
   * O payload é fundo demais para a varredura garantir o que ela afirma —
   * de chave reservada (§6.9.1 item 3) ou de id de recurso (item 5). Um membro
   * só para os dois porque o FATO é o mesmo: visão parcial não autoriza.
   */
  'too_deep',
  'resource_out_of_acl',
  'shadow_write_blocked',
] as const;

export type BrokerRefusalReason = (typeof BROKER_REFUSAL_REASONS)[number];

/** Os códigos que o wire do P00 aceita em `tool.result.outcome.refused`. */
export type BrokerWireRefusalCode =
  | 'run_not_authorized'
  | 'tool_not_allowed'
  | 'payload_conflict'
  | 'budget_exhausted'
  | 'effect_unknown'
  | 'protocol_error';

/**
 * Traduz a razão RICA (que vai para auditoria) no código POBRE que atravessa o
 * wire. A assimetria é deliberada nos dois sentidos:
 *
 *  - o wire é grosseiro de propósito. `resource_out_of_acl` vira
 *    `run_not_authorized`, e não um código próprio, porque um código específico
 *    para "aquele recurso não é seu" diria ao modelo que o recurso EXISTE —
 *    a mesma fuga que o T19 e o T24 fecham;
 *  - a razão é rica porque quem opera precisa distinguir configuração
 *    (`tool_not_in_surface`) de incidente (`context_lookup_failed`).
 *
 * O `switch` é exaustivo com `never`: acrescentar uma razão sem decidir seu
 * código de wire não compila.
 */
export function refusalWireCode(reason: BrokerRefusalReason): BrokerWireRefusalCode {
  switch (reason) {
    case 'binding_mismatch':
    case 'manifest_digest_mismatch':
    case 'context_lookup_failed':
    case 'resource_out_of_acl':
      return 'run_not_authorized';
    case 'tool_not_in_surface':
    case 'shadow_write_blocked':
      return 'tool_not_allowed';
    // `too_deep` é erro de PROTOCOLO, e o P00 já usa esse nome para o mesmo fato
    // no wire (`WireErrorCode`). Não inventei código novo.
    case 'reserved_argument':
    case 'unknown_argument':
    case 'too_deep':
      return 'protocol_error';
    default: {
      const _never: never = reason;
      void _never;
      throw new TypeError(`refusalWireCode: razão sem código de wire (${String(reason)})`);
    }
  }
}

export interface ToolCallFrameV1 {
  run_id: string;
  name: string;
  args: unknown;
  call_seq: number;
}

export interface ToolCallDecisionInputV1 {
  /** Resolvido pelo canal já autenticado (§6.9.1 item 1), nunca pelo frame. */
  binding: RunBindingV1;
  manifest: RuntimeManifestV1;
  frame: ToolCallFrameV1;
  /** Os eixos RECARREGADOS para esta chamada — nunca um snapshot de `ready`. */
  surface: ToolSurfaceInputV1;
  /** Campos que ESTA ferramenta declara como seletor de recurso. */
  selectors: Readonly<Record<string, ResourceKind>>;
}

export type ToolAdmissionV1 =
  | { kind: 'admit'; tool: ManifestToolV1 }
  | { kind: 'refuse'; reason: BrokerRefusalReason; wire: BrokerWireRefusalCode; detail: string }
  | { kind: 'defer'; reason: 'approval_required'; tool: ManifestToolV1 };

const recusa = (reason: BrokerRefusalReason, detail: string): ToolAdmissionV1 => ({
  kind: 'refuse',
  reason,
  wire: refusalWireCode(reason),
  detail,
});

function declaredArgKeys(tool: ManifestToolV1): string[] {
  const props = (tool.input_schema as { properties?: unknown }).properties;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>);
}

/**
 * A decisão de uma chamada, na ORDEM do §6.9.1. A ordem é parte do contrato, não
 * detalhe de implementação:
 *
 *  1. **identidade** (item 1) — binding do canal contra a correlação do frame;
 *  2. **manifest efetivo e seu digest** (item 3);
 *  3. **superfície** (INV-03/§7.10.1) — inclusive o fechamento por lookup falho;
 *  4. **argumentos** (item 3, segunda metade) — reservados e desconhecidos;
 *  5. **ACL de recurso** (item 5), inclusive ids aninhados;
 *  6. **modo** (INV-10) — shadow não produz efeito externo;
 *  7. **aprovação** (item 5) — que não é recusa, é espera.
 *
 * Por que a ordem importa: uma chamada com DOIS problemas — frame de outro run
 * pedindo uma tool inexistente — tem de ser recusada pela identidade. Se o
 * catálogo respondesse primeiro, a resposta diria a um chamador não autorizado
 * se aquela ferramenta existe naquele run. A mesma lógica desce um degrau: o
 * catálogo vem antes do argumento, senão a recusa conta que os args estavam
 * errados para uma ferramenta que o chamador nem podia usar.
 *
 * O que esta função NÃO decide: lease viva, deadline, epoch de controle humano,
 * orçamento, idempotência e efeito. Tudo isso é releitura do banco a cada
 * chamada (§6.9.1 item 2) e pertence ao gateway — `admit` aqui significa
 * "nenhuma regra ESTÁTICA barra", nunca "pode executar".
 */
export function decideToolCall(input: ToolCallDecisionInputV1): ToolAdmissionV1 {
  const { binding, manifest, frame } = input;

  // 1. Identidade.
  const correlacao = checkFrameCorrelation(binding, { run_id: frame.run_id });
  if (correlacao.kind === 'mismatch') {
    return recusa('binding_mismatch', `correlação divergente em ${correlacao.field}`);
  }

  // 2. Manifest efetivo: é DESTE run, e é o que a Maia compilou.
  if (manifest.run_id !== binding.run_id) {
    return recusa('binding_mismatch', 'manifest de outro run');
  }
  if (computeManifestDigest(manifest) !== binding.manifest_digest) {
    return recusa('manifest_digest_mismatch', 'digest do manifest não bate com o binding');
  }

  // 3. Superfície efetiva (INV-03).
  const superficie = computeEffectiveToolSurface(input.surface);
  if (superficie.closed_reason) {
    return recusa(
      'context_lookup_failed',
      `superfície fechada (${superficie.closed_reason.kind} em ${superficie.closed_reason.axis})`,
    );
  }
  if (!superficie.names.includes(frame.name)) {
    // Sem detalhe sobre o nome pedido: um chamador que descobre POR QUE um nome
    // não está disponível aprende o que existe do outro lado.
    return recusa('tool_not_in_surface', 'nome fora da superfície efetiva');
  }

  const tool = manifest.tools.find((t) => t.name === frame.name);
  if (!tool) {
    return recusa('tool_not_in_surface', 'nome ausente do manifest');
  }

  // 4. Argumentos.
  const triagem = screenToolArgs(declaredArgKeys(tool), frame.args);
  if (triagem.kind === 'reject') {
    return recusa(triagem.reason, `campo ${triagem.field}`);
  }

  // 5. ACL de recurso, inclusive ids aninhados.
  const varreduraRecursos = collectResourceRefs(frame.args, input.selectors);
  const acl = authorizeResourceRefs(binding, varreduraRecursos);
  if (acl.kind === 'deny') {
    // `scan_truncated` NÃO é "o recurso não é seu" — é "não enxerguei o payload
    // inteiro". Reportá-lo como `resource_out_of_acl` afirmaria uma decisão de
    // pertencimento que ninguém tomou.
    return recusa(
      acl.reason === 'scan_truncated' ? 'too_deep' : 'resource_out_of_acl',
      `campo ${acl.field} (${acl.reason})`,
    );
  }

  // 6. Modo (INV-10): "nenhum efeito externo […] é alterado por um run shadow".
  if (binding.mode === 'shadow' && tool.side_effect !== 'none' && tool.side_effect !== 'read') {
    return recusa('shadow_write_blocked', 'run shadow não executa ferramenta com efeito');
  }

  // 7. Aprovação: espera, não recusa. O modelo não consegue concedê-la — o campo
  //    que tentaria (`approved`) já morreu no passo 4.
  if (tool.approval_mode !== 'none') {
    return { kind: 'defer', reason: 'approval_required', tool };
  }

  return { kind: 'admit', tool };
}

export interface ObservedToolCallsV1 {
  /** A evidência: o que o JOURNAL registrou. */
  refs: string[];
  /** O que o motor AFIRMOU e o journal não conhece. Nunca vira evidência. */
  fabricated: string[];
}

/**
 * T29 — "Hermes retorna ToolCallRef inexistente: não é aceito como evidência de
 * execução".
 *
 * §6.8: "O campo `toolCallRefs` da saída proposta no plano deve vir do ledger
 * broker, não de uma lista de IDs que o modelo afirma ter executado." Por isso
 * `refs` é SEMPRE o journal — a lista afirmada não contribui com nenhum membro,
 * só com a denúncia do que foi inventado.
 */
export function reconcileObservedToolCalls(
  journal: readonly string[],
  claimed: readonly string[],
): ObservedToolCallsV1 {
  const conhecidas = new Set(journal);
  return {
    refs: [...journal],
    fabricated: claimed.filter((id) => !conhecidas.has(id)),
  };
}

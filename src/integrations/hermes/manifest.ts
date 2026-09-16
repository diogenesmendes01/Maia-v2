/**
 * P05 (spec §4.2, §7.10; K-19) — o MANIFEST `maia-hermes-runtime-manifest/v1`.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * §4.2: "O manifest é dado interno compilado pelo backend; o modelo não pode
 * fornecê-lo. […] Default é lista vazia; não permitir `maia_*`, `mcp:*`, `all`
 * nem usar nomes inexistentes como placeholders de configuração habilitada."
 *
 * O manifest é a ÚNICA lista do que um run pode chamar. Por isso ele é o lugar
 * onde um schema frouxo deixa de ser dívida de tipagem e vira escalada de
 * privilégio: cada campo opcional aqui é uma autorização que ninguém decidiu.
 *
 * ─── Por que PURO (mesma razão de `recovery.ts` e `poison-policy.ts`) ───────
 *
 * Sem `db`, sem ALS, sem `@/config/env.js`, sem métricas e — o que mais importa
 * aqui — sem o REGISTRY. Importar `_registry.ts` arrastaria o grafo inteiro de
 * ferramentas para dentro de um módulo cuja pergunta é "este documento é um
 * manifest válido?". Os vocabulários que este arquivo precisa são os módulos
 * FOLHA da casa (`effect-class.ts`, `audit-actions.ts`, `mcp-tool-names.ts`),
 * não o hot path.
 *
 * ─── O que este módulo NÃO é ────────────────────────────────────────────────
 *
 * Não é o broker e não despacha nada. Validar o manifest não autoriza chamada
 * nenhuma: a autorização por chamada é a interseção do INV-03, que vive em
 * `tool-broker.ts`, e o efeito continua sendo do `dispatchTool` (§7.10.1). Um
 * manifest válido é condição NECESSÁRIA, nunca suficiente.
 */
import { z } from 'zod';
import { ACTION_KEYS, AUDIT_ACTIONS } from '@/governance/audit-actions.js';
import { TOOL_EFFECT_CLASSES } from '@/tools/effect-class.js';
import { isMcpToolName } from '@/tools/mcp-tool-names.js';
import { canonicalDigest } from './canonical-json.js';

export const RUNTIME_MANIFEST_SCHEMA = 'maia-hermes-runtime-manifest/v1' as const;

/**
 * Por que a recusa é TIPADA e fechada: um manifest recusado precisa dizer QUAL
 * regra o recusou, porque as consequências operacionais são diferentes —
 * `schema` é bug do compilador de manifest, `reserved_tool_name` é tentativa de
 * habilitar superfície proibida, `denied_tool_name` é o deny do §7.10.3 mordendo.
 * Colapsar os três num `Error` genérico jogaria fora exatamente a informação que
 * um humano usa para decidir se aquilo é erro de digitação ou incidente.
 */
export const MANIFEST_REJECTION_CODES = [
  'schema',
  'reserved_tool_name',
  'denied_tool_name',
  'duplicate_tool_name',
] as const;

export type ManifestRejectionCode = (typeof MANIFEST_REJECTION_CODES)[number];

/** QUAL regra do K-19 pegou o nome. `null` = nome livre. */
export type ReservedToolNameRule = 'maia_prefix' | 'mcp_prefix' | 'wildcard_all' | 'wildcard';

/**
 * K-19, letra por letra. Três observações sobre o desenho:
 *
 *  - a regra é PREFIXO, não substring: `consulta_maia_interna` é um nome
 *    legítimo, e barrá-lo seria inventar uma proibição que a spec não fez;
 *  - o `mcp:` não é redigitado aqui — vem de `isMcpToolName`
 *    (`src/tools/mcp-tool-names.ts:14`), que é a gramática REAL dos nomes MCP
 *    desta casa. Uma cópia local envelheceria em silêncio no dia em que o
 *    separador mudasse, e a checagem passaria a não pegar nada;
 *  - `all` e `*` são recusados porque são o vocabulário usual de "tudo" em
 *    allowlist. §4.2 nomeia `all`; `*` entra pelo mesmo motivo e está registrado
 *    como decisão minha, não como leitura da spec.
 */
export function classifyReservedToolName(name: string): ReservedToolNameRule | null {
  if (name.startsWith('maia_')) return 'maia_prefix';
  if (isMcpToolName(name)) return 'mcp_prefix';
  if (name === 'all') return 'wildcard_all';
  if (name.includes('*')) return 'wildcard';
  return null;
}

/**
 * O DENY INICIAL do §7.10.3 — o termo "− todos os denies" do INV-03, como dado.
 *
 * Duas famílias, e a segunda é a que surpreende:
 *
 *  1. **Hermes nativo**: memória, gestão de skills, filesystem genérico,
 *     terminal/execução de código, browser, HTTP genérico, busca de sessão,
 *     cron/background, delegação, plugins/credenciais e envio de mensagens.
 *  2. **Wrappers LEGADOS de aprendizado da Maia**: `save_fact`, `save_rule`,
 *     `propose_fact`, `propose_memory`, `propose_rule`, `propose_hint` e
 *     `remember_safe_fact`. O §7.10.3 é explícito: "são wrappers legados em
 *     migração, não rotas paralelas. Apenas `learning_propose` governado pode
 *     aprender."
 *
 * `remember_safe_fact` é o caso que morde, e vale registrar: ele está em
 * `BASELINE_CORE_PACK` (`src/tools/grant-math.ts`), o piso que TODO agente tem.
 * Quer dizer que o eixo "grant do agente" da interseção do §7.10.1 o traria para
 * dentro sozinho — e é só este deny que o tira. Sem ele, a coorte Hermes ganharia
 * uma rota de escrita de memória por herança, sem ninguém ter decidido isso.
 */
export const INITIAL_TOOL_DENY: ReadonlySet<string> = new Set([
  // §7.10.3, Hermes
  'memory',
  'skill_manage',
  'write_file',
  'patch_file',
  'read_file',
  'terminal',
  'execute_code',
  'browser',
  'web_search',
  'http_request',
  'session_search',
  'cron',
  'goals',
  'background_learning',
  'delegate_task',
  'plugin_manage',
  'vault',
  'send_message',
  // §7.10.3, wrappers legados da Maia
  'save_fact',
  'save_rule',
  'propose_fact',
  'propose_memory',
  'propose_rule',
  'propose_hint',
  'remember_safe_fact',
]);

// ─── primitivos ─────────────────────────────────────────────────────────────

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const DECIMAL_UINT_RE = /^(0|[1-9][0-9]*)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = () => z.string().regex(UUID_RE, 'uuid inválido');
const sha256 = () => z.string().regex(SHA256_RE, 'sha256 hex inválido');
const decimalUint = () => z.string().regex(DECIMAL_UINT_RE, 'inteiro decimal não negativo');
const isoInstant = () => z.string().datetime({ offset: false });
const shortText = (max: number) => z.string().min(1).max(max);

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

/**
 * `side_effect` é redigitado, e não importado de `_registry.ts:135`, porque
 * aquele arquivo é o hot path do registro inteiro — importá-lo aqui destruiria a
 * pureza deste módulo por um alias de quatro strings. A citação fica no lugar do
 * import; se o vocabulário de lá mudar, é este comentário que leva alguém de
 * volta ao par.
 */
export const MANIFEST_SIDE_EFFECTS = ['none', 'read', 'write', 'communication'] as const;

/**
 * §7.10.1, o campo NOVO de catálogo: `authorization_target: entity |
 * current_subject | current_turn`. Existe porque o dispatcher atual exige uma
 * entidade até para tools baseline (`_dispatcher.ts:387-389`) e "memória pessoal
 * não pode inventar entidade para passar esse gate".
 */
export const AUTHORIZATION_TARGETS = ['entity', 'current_subject', 'current_turn'] as const;

/**
 * "Modo de aprovação" (§4.2) — o vocabulário é DECISÃO MINHA, registrada:
 * a spec pede o campo e não enumera valores. Os três espelham o que a casa já
 * executa: nenhuma aprovação, confirmação humana simples (`approval_requested`)
 * e a classe dual de quatro olhos (`dual_approval_*`, `audit-actions.ts`).
 * Não invento um quarto valor "auto", que seria aprovação sem humano.
 */
export const APPROVAL_MODES = ['none', 'single', 'dual'] as const;

// ─── schema ─────────────────────────────────────────────────────────────────

const manifestToolSchema = z
  .object({
    /** Nome exposto ao motor. */
    name: shortText(256),
    /** Nome no registry Maia — quem `dispatchTool` resolveria (§7.10.1). */
    maia_tool_name: shortText(256),
    input_schema: z.record(jsonValue),
    output_schema: z.record(jsonValue),
    input_schema_hash: sha256(),
    output_schema_hash: sha256(),
    implementation_version: shortText(64),
    side_effect: z.enum(MANIFEST_SIDE_EFFECTS),
    /**
     * NÃO é nullable, ao contrário da coluna `engine_tool_calls.effect_class`.
     * §4.1: "null NUNCA autoriza handler". A coluna aceita null porque uma call
     * ainda não classificada existe; um MANIFEST com null seria uma ferramenta
     * habilitada sem semântica de cancelamento, e o tipo aqui não consegue
     * expressar isso.
     */
    effect_class: z.enum(TOOL_EFFECT_CLASSES),
    /** Permissões granulares exigidas — o vocabulário REAL de `canAct`. */
    required_actions: z.array(z.enum(ACTION_KEYS)).max(16),
    authorization_target: z.enum(AUTHORIZATION_TARGETS),
    /**
     * OBRIGATÓRIO (T31): o §4.2 lista `output_projection_id` entre os campos do
     * manifest, e sem ele não existe "projeção/redação antes de devolver ao
     * LLM" — existe devolver o resultado cru e torcer. Uma ferramenta sem
     * projeção declarada não entra na allowlist.
     */
    output_projection_id: shortText(128),
    /** Ação de auditoria REAL: auditoria não se inventa (INV-12). */
    audit_action: z.enum(AUDIT_ACTIONS),
    limits: z
      .object({
        max_calls: z.number().int().min(1).max(1_000),
        result_limit_chars: z.number().int().min(1).max(1_000_000),
        timeout_ms: z.number().int().min(1).max(600_000),
      })
      .strict(),
    approval_mode: z.enum(APPROVAL_MODES),
  })
  .strict();

/**
 * As negações do §4.2, como literais `true`.
 *
 * ─── Por que literal, e não `z.boolean()` ───────────────────────────────────
 *
 * Com `z.boolean()`, um compilador de manifest com defeito poderia emitir
 * `mcp: false` e LIGAR a capacidade — e o manifest continuaria válido, porque o
 * schema só perguntaria "é booleano?". Com `z.literal(true)`, a única coisa que
 * "desligar a negação" consegue produzir é um manifest INVÁLIDO. É o mesmo
 * mecanismo do `definitely_not_accepted: z.literal(true)` em `schemas.ts:329`:
 * o tipo não consegue expressar o estado proibido.
 *
 * Quando a V1 habilitar alguma dessas superfícies, o caminho é mudar ESTE
 * arquivo num diff visível, com revisão — não um booleano num JSON gerado.
 */
const manifestDeniesSchema = z
  .object({
    native_memory: z.literal(true),
    generic_filesystem: z.literal(true),
    code_execution: z.literal(true),
    browsing: z.literal(true),
    mcp: z.literal(true),
    delegation: z.literal(true),
    background_review: z.literal(true),
    cron: z.literal(true),
    messaging: z.literal(true),
    discovery_expanding_tools: z.literal(true),
  })
  .strict();

export const runtimeManifestV1Schema = z
  .object({
    schema: z.literal(RUNTIME_MANIFEST_SCHEMA),
    run_id: uuid(),
    policy_revision: shortText(64),
    mode: z.enum(['live', 'shadow']),
    bundle_digest: sha256(),
    context_digest: sha256(),
    control_epoch: decimalUint(),
    exposure_epoch: decimalUint(),
    runtime_pin: z
      .object({
        hermes_sha: z.string().regex(SHA1_RE, 'sha do checkout Hermes inválido'),
        adapter_revision: shortText(128),
        image_digest: sha256(),
        dependency_lock_digest: sha256(),
      })
      .strict(),
    /**
     * DEFAULT VAZIO (§4.2). Ausência é o conjunto vazio, jamais o universo — e
     * é por isso que o default mora no schema e não num `?? TODAS`: um call site
     * que esqueça o campo recebe zero ferramentas, que é o erro seguro.
     */
    tools: z.array(manifestToolSchema).max(64).default([]),
    limits: z
      .object({
        deadline_at: isoInstant(),
        max_tool_calls: z.number().int().min(0).max(10_000),
        max_inference_calls: z.number().int().min(0).max(1_000),
        max_context_tokens: z.number().int().min(1).max(10_000_000),
        max_output_tokens: z.number().int().min(1).max(200_000),
        max_payload_bytes: z.number().int().min(1).max(16_777_216),
        max_json_depth: z.number().int().min(1).max(256),
        /** Unidade EXPLÍCITA e inteiro decimal: dinheiro nunca em float (§4.2). */
        budget: z
          .object({ amount_microusd: decimalUint(), unit: z.literal('microusd') })
          .strict(),
      })
      .strict(),
    data_policy: z.object({ ref: shortText(128), version: shortText(32) }).strict(),
    publication_refs: z.array(shortText(256)).max(64),
    retention_policy_ref: shortText(128),
    denies: manifestDeniesSchema,
  })
  .strict();

export type RuntimeManifestV1 = z.infer<typeof runtimeManifestV1Schema>;
export type ManifestToolV1 = RuntimeManifestV1['tools'][number];

export type ManifestParseResultV1 =
  | { kind: 'ok'; manifest: RuntimeManifestV1 }
  | { kind: 'rejected'; code: ManifestRejectionCode; detail: string };

/**
 * Valida um manifest COMPILADO. Recusa determinística: mesma entrada, mesmo
 * código — nunca exceção genérica, nunca aviso em log com o manifest seguindo em
 * frente.
 *
 * A ordem das checagens é a ordem da gravidade, e ela importa para quem lê o
 * código: primeiro o documento é bem formado, depois nenhum nome é RESERVADO
 * (tentativa de habilitar superfície proibida), depois nenhum nome está no DENY
 * (§7.10.3), depois a allowlist é um conjunto. Um manifest com dois problemas
 * reporta o mais grave.
 *
 * Os dois nomes de cada ferramenta passam pelas mesmas regras. O motivo é o
 * `maia_tool_name`: é ELE que o dispatcher resolveria, então um `mcp:servidor:x`
 * ali habilitaria o bridge MCP por dentro — que o §7.10.3 mantém fora do piloto —
 * atrás de um nome exposto de aparência inocente.
 */
export function parseRuntimeManifest(input: unknown): ManifestParseResultV1 {
  const parsed = runtimeManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'rejected',
      code: 'schema',
      // Só o CAMINHO e o código: a mensagem do Zod pode ecoar o valor recebido.
      detail: `${issue?.path.join('.') || 'manifest'}: ${issue?.code ?? 'invalid'}`,
    };
  }

  const manifest = parsed.data;

  for (const tool of manifest.tools) {
    for (const [campo, nome] of [
      ['name', tool.name],
      ['maia_tool_name', tool.maia_tool_name],
    ] as const) {
      const regra = classifyReservedToolName(nome);
      if (regra) {
        return {
          kind: 'rejected',
          code: 'reserved_tool_name',
          detail: `${campo}: ${regra} (K-19)`,
        };
      }
    }
  }

  for (const tool of manifest.tools) {
    for (const [campo, nome] of [
      ['name', tool.name],
      ['maia_tool_name', tool.maia_tool_name],
    ] as const) {
      if (INITIAL_TOOL_DENY.has(nome)) {
        return {
          kind: 'rejected',
          code: 'denied_tool_name',
          detail: `${campo}: deny inicial do §7.10.3`,
        };
      }
    }
  }

  const vistos = new Set<string>();
  for (const tool of manifest.tools) {
    if (vistos.has(tool.name)) {
      return { kind: 'rejected', code: 'duplicate_tool_name', detail: 'name repetido' };
    }
    vistos.add(tool.name);
  }

  return { kind: 'ok', manifest };
}

/** Os nomes EXPOSTOS. Vazio quando o manifest não declarou ferramenta alguma. */
export function manifestToolNames(manifest: RuntimeManifestV1): string[] {
  return manifest.tools.map((t) => t.name);
}

/**
 * `manifest_digest` do binding (§4.1): identidade do manifest COMPILADO.
 *
 * Canônico de propósito — é o mesmo digest que o `ready` do worker usa para
 * provar que a superfície registrada corresponde ao que a Maia compilou
 * (`protocol.ts`, `binding.manifest_digest`). Se ele dependesse da ordem das
 * chaves, dois processos que montassem o mesmo manifest em ordens diferentes
 * discordariam sobre a identidade dele, e a prova viraria ruído.
 */
export function computeManifestDigest(manifest: RuntimeManifestV1): string {
  return canonicalDigest(manifest);
}

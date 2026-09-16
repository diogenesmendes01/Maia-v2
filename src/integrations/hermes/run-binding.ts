/**
 * P05 (spec §6.3, §6.4.1, §6.9.1; INV-01, INV-02) — o `RunBinding` e a ACL de
 * recurso/cliente.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * §6.3: "O broker nunca usa IDs de tenant/cliente/execução vindos do frame.
 * Resolve contexto pelo objeto de conexão já vinculado. Campos de correlação
 * repetidos no frame, se presentes, só são COMPARADOS e recusados em
 * divergência."
 *
 * Isso separa duas coisas que, juntas, são a falha clássica desta fronteira: o
 * que IDENTIFICA a execução (o binding, construído pela Maia depois do claim) e
 * o que CORRELACIONA um frame (campos repetidos, que só servem para conferir).
 * Enquanto as duas moram no mesmo lugar, um `tenant_id` de frame acaba, algum
 * dia, escolhendo contexto.
 *
 * ─── Por que PURO ───────────────────────────────────────────────────────────
 *
 * Sem `db`, sem ALS, sem env. A pergunta "este recurso pertence a este cliente?"
 * é uma função da ACL que a Maia já resolveu para aquele run — e mantê-la pura é
 * o que permite responder à pergunta do T24 sem Postgres. Quem CARREGA a ACL do
 * banco é o supervisor, na construção do binding; aqui só se decide com ela.
 *
 * ─── O que este módulo NÃO é ────────────────────────────────────────────────
 *
 * Não é revalidação. §6.3: "A identidade fixa não contém estado mutável de
 * revogação. Ela aponta para tentativa/fence/epoch fixos; a validade é
 * consultada novamente na Maia a cada efeito. 'Imutável' não significa
 * 'permissão irrevogável'." Este arquivo congela a identidade; quem reconsulta
 * lease, deadline, epoch de controle e grants é o broker, contra o banco, a cada
 * chamada.
 */
import { z } from 'zod';

/**
 * `schema` é documento malformado; `identity_mismatch` é um binding que se
 * contradiz — os dois pedem ações diferentes de quem opera, então não colapsam
 * num código só.
 */
export const BINDING_REJECTION_CODES = ['schema', 'identity_mismatch'] as const;
export type BindingRejectionCode = (typeof BINDING_REJECTION_CODES)[number];

export const RESOURCE_KINDS = ['pessoa', 'conversa', 'entidade'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DECIMAL_UINT_RE = /^(0|[1-9][0-9]*)$/;

const uuid = () => z.string().regex(UUID_RE, 'uuid inválido');
const sha256 = () => z.string().regex(SHA256_RE, 'sha256 hex inválido');

/**
 * A tupla do §6.4.1, validada. Note o que ela carrega e o que NÃO carrega:
 *
 *  - carrega `origin_claim_token` porque o binding é objeto do SUPERVISOR, e o
 *    fence de origem é o que o journal usa para reconhecer o dono do run
 *    (`engine-repos.ts`). Ele nunca desce ao worker — ver `workerBindingProjection`;
 *  - NÃO carrega grants, lease viva nem estado de revogação: tudo isso é mutável
 *    e é reconsultado a cada efeito (§6.3). Um campo `revoked: boolean` aqui
 *    seria um snapshot de autorização, que é exatamente o que o INV-04 proíbe.
 */
export const runBindingV1Schema = z
  .object({
    version: z.literal(1),
    run_id: uuid(),
    /** §4.1 linha 272: o MESMO uuid do run, não um segundo registro de autoridade. */
    execution_id: uuid(),
    task_id: z.string().min(1).max(128),
    initial_session_id: z.string().min(1).max(128),
    tenant_id: z.string().min(1).max(128),
    agent_id: z.string().min(1).max(128),
    pessoa_id: uuid(),
    conversa_id: uuid(),
    mensagem_id: uuid(),
    turn_id: uuid(),
    turn_attempt: z.number().int().min(1).max(10_000),
    origin_claim_token: uuid(),
    control_id: uuid(),
    control_epoch: z.string().regex(DECIMAL_UINT_RE, 'inteiro decimal não negativo'),
    mode: z.enum(['live', 'shadow']),
    manifest_digest: sha256(),
    context_digest: sha256(),
    bundle_digest: sha256(),
    deadline_at: z.string().datetime({ offset: false }),
    /**
     * A ACL do RUN: os objetos que ESTA execução pode selecionar. É o conjunto
     * que o INV-01 exige ("pessoa/conversa quando o dado é privado") e o que o
     * §6.9.1 item 3 quer dizer com "recursos legítimos em domínio só selecionam
     * objetos DENTRO da ACL, nunca autoridade".
     */
    acl: z
      .object({
        pessoa_ids: z.array(uuid()).max(64),
        conversa_ids: z.array(uuid()).max(64),
        entidade_ids: z.array(uuid()).max(256),
      })
      .strict(),
  })
  .strict();

export type RunBindingV1 = z.infer<typeof runBindingV1Schema>;

export type RunBindingParseResultV1 =
  | { kind: 'ok'; binding: RunBindingV1 }
  | { kind: 'rejected'; code: BindingRejectionCode; detail: string };

export function parseRunBinding(input: unknown): RunBindingParseResultV1 {
  const parsed = runBindingV1Schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'rejected',
      code: 'schema',
      detail: `${issue?.path.join('.') || 'binding'}: ${issue?.code ?? 'invalid'}`,
    };
  }
  const binding = parsed.data;
  if (binding.execution_id !== binding.run_id) {
    return {
      kind: 'rejected',
      code: 'identity_mismatch',
      detail: 'execution_id precisa ser o MESMO uuid do run (§4.1)',
    };
  }
  return { kind: 'ok', binding };
}

/**
 * Congela RECURSIVAMENTE (§6.4.1: "congelar recursivamente").
 *
 * Raso não bastaria: `Object.freeze(binding)` deixaria `binding.acl.pessoa_ids`
 * mutável, e a ACL é justamente a parte cuja alteração no meio de um run seria
 * indetectável depois. O §6.4.1 registra o mesmo erro do lado Python
 * (`frozen=True` com dict aninhado não congela o conteúdo).
 */
export function freezeRunBinding(binding: RunBindingV1): Readonly<RunBindingV1> {
  Object.freeze(binding.acl.pessoa_ids);
  Object.freeze(binding.acl.conversa_ids);
  Object.freeze(binding.acl.entidade_ids);
  Object.freeze(binding.acl);
  return Object.freeze(binding);
}

/** Campos de correlação que um frame PODE repetir. Nenhum deles escolhe nada. */
export interface FrameCorrelationV1 {
  run_id?: string;
  execution_id?: string;
}

export type CorrelationCheckV1 = { kind: 'match' } | { kind: 'mismatch'; field: string };

/**
 * T19 — "Binding/canal de run A usado com frame/ID de B: recusa e auditoria,
 * **sem revelar se B existe**".
 *
 * Duas decisões de desenho carregam esse requisito:
 *
 *  1. o retorno de divergência carrega o CAMPO, e não o valor recebido. Ecoar o
 *     `run_id` de B — mesmo só num log de auditoria do lado de A — transforma a
 *     recusa num oráculo de existência;
 *  2. ausência de campo é MATCH, não divergência. O frame não é a fonte da
 *     autoridade (§6.3); exigir correlação faria o contrário do que o invariante
 *     diz, dando ao frame o papel de credencial obrigatória.
 */
export function checkFrameCorrelation(
  binding: RunBindingV1,
  frame: FrameCorrelationV1,
): CorrelationCheckV1 {
  if (frame.run_id !== undefined && frame.run_id !== binding.run_id) {
    return { kind: 'mismatch', field: 'run_id' };
  }
  if (frame.execution_id !== undefined && frame.execution_id !== binding.execution_id) {
    return { kind: 'mismatch', field: 'execution_id' };
  }
  return { kind: 'match' };
}

export interface ResourceRefV1 {
  kind: ResourceKind;
  id: string;
  /** Caminho do campo que trouxe o id. Para auditoria — nunca o id em si. */
  field: string;
}

/**
 * O resultado de uma varredura de recursos. `truncated` não é diagnóstico: é o
 * que faz `authorizeResourceRefs` RECUSAR.
 *
 * A varredura e a decisão viajam juntas de propósito. Se `collectResourceRefs`
 * devolvesse só a lista, o fail-closed dependeria de cada call site lembrar de
 * conferir o truncamento — e um call site que esquece produz exatamente o
 * defeito que isto corrige: autorizar com visão parcial.
 */
export interface ResourceScanV1 {
  refs: ResourceRefV1[];
  /** Caminho onde a varredura PAROU por profundidade; `null` = varreu até o fim. */
  truncated: string | null;
}

export type ResourceAclDecisionV1 =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: 'out_of_acl' | 'empty_acl' | 'scan_truncated'; field: string };

export const MAX_REF_DEPTH = 16;

/**
 * Colhe os ids de recurso dos argumentos, em QUALQUER profundidade — §6.9.1 item
 * 5: "validar schema e ACL de recursos, **inclusive nested IDs**".
 *
 * Aninhado importa porque a checagem rasa é a que falha em produção: um
 * `{filtro:{alvos:[{entidade_id:...}]}}` passa por qualquer validação de
 * primeiro nível e chega ao handler com o id de outro cliente dentro.
 *
 * `selectors` é DECLARADO pelo chamador (os campos que aquela ferramenta
 * declara como seletor de recurso), e não adivinhado por nome. Heurística de
 * nome aqui teria os dois erros: trataria `observacao` com cara de uuid como
 * pedido de ACL, e deixaria passar um seletor cujo nome ninguém previu.
 */
export function collectResourceRefs(
  args: unknown,
  selectors: Readonly<Record<string, ResourceKind>>,
): ResourceScanV1 {
  const refs: ResourceRefV1[] = [];
  let truncated: string | null = null;
  const visitar = (valor: unknown, caminho: string, profundidade: number): void => {
    if (valor === null || typeof valor !== 'object') return;
    // Estourar o teto REGISTRA a desistência em vez de voltar calado. A ACL não
    // pode recusar o que não enxerga, então uma varredura que para no meio tem
    // de contaminar a decisão — e não devolver uma lista que parece completa.
    if (profundidade > MAX_REF_DEPTH) {
      truncated ??= caminho || '$';
      return;
    }
    if (Array.isArray(valor)) {
      valor.forEach((v, i) => visitar(v, `${caminho}[${i}]`, profundidade + 1));
      return;
    }
    for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
      const caminhoFilho = caminho ? `${caminho}.${chave}` : chave;
      const kind = selectors[chave];
      if (kind && typeof v === 'string') {
        refs.push({ kind, id: v, field: caminhoFilho });
        continue;
      }
      visitar(v, caminhoFilho, profundidade + 1);
    }
  };
  visitar(args, '', 0);
  return { refs, truncated };
}

/**
 * A ACL de recurso (T24, INV-01: "IDs não conferem autorização").
 *
 * ─── Por que ACL vazia RECUSA em vez de "não restringir" ────────────────────
 *
 * G-AUTH: "contexto vazio recusa acesso". Uma lista vazia significa que a Maia
 * não autorizou objeto nenhum daquele tipo para este run — tratar isso como
 * "sem restrição" inverteria o invariante exatamente no caso em que menos se
 * sabe, e seria o mesmo erro que o §7.10.1 aponta no `runtime-filter.ts` para
 * role ausente.
 *
 * ─── Por que a recusa não carrega o id ──────────────────────────────────────
 *
 * Mesmo motivo do T19: um id ecoado numa recusa diz ao chamador que o objeto foi
 * reconhecido. O que volta é o CAMPO, que basta para auditar e não prova
 * existência de nada.
 */
export function authorizeResourceRefs(
  binding: RunBindingV1,
  scan: ResourceScanV1,
): ResourceAclDecisionV1 {
  // PRIMEIRA guarda, antes de qualquer pertencimento: uma varredura truncada não
  // sabe o que deixou de ver, e "não vi nada" jamais pode significar "não há
  // nada". É o par exato do `empty_acl` — os dois são o mesmo princípio
  // (G-AUTH), um sobre contexto vazio e outro sobre visão incompleta.
  if (scan.truncated !== null) {
    return { kind: 'deny', reason: 'scan_truncated', field: scan.truncated };
  }
  for (const ref of scan.refs) {
    const permitidos =
      ref.kind === 'pessoa'
        ? binding.acl.pessoa_ids
        : ref.kind === 'conversa'
          ? binding.acl.conversa_ids
          : binding.acl.entidade_ids;
    if (permitidos.length === 0) {
      return { kind: 'deny', reason: 'empty_acl', field: ref.field };
    }
    if (!permitidos.includes(ref.id)) {
      return { kind: 'deny', reason: 'out_of_acl', field: ref.field };
    }
  }
  return { kind: 'allow' };
}

/**
 * O `WorkerBinding` do §6.4.1: o que desce ao filho Python, e SÓ isso.
 *
 * "Não precisa carregar tenant/cliente nem segredo." A forma é exatamente o
 * sub-objeto `binding` do frame `start` (`protocol.ts`), e essa correspondência
 * é o ponto: a projeção existe para que ninguém monte esse sub-objeto à mão a
 * partir do binding completo e leve junto o que não devia (T67 — token de
 * execução vazando em prompt/erro/log).
 */
export function workerBindingProjection(binding: RunBindingV1): {
  execution_id: string;
  task_id: string;
  initial_session_id: string;
  manifest_digest: string;
  mode: 'live' | 'shadow';
} {
  return {
    execution_id: binding.execution_id,
    task_id: binding.task_id,
    initial_session_id: binding.initial_session_id,
    manifest_digest: binding.manifest_digest,
    mode: binding.mode,
  };
}

/**
 * Issue #505 — derivação CANÔNICA da `stream_key`.
 *
 * Este módulo é PURO: sem banco, sem ALS, sem relógio, sem log, sem config.
 * Ele responde a uma pergunta e só a ela — "qual é a identidade durável da
 * stream de ordenação deste ingresso?" — e devolve ou a chave ou o motivo
 * tipado da recusa.
 *
 * ─── Por que a pureza é ESTRUTURAL aqui, e não estética ────────────────────
 *
 * A fronteira fail-closed é aplicada em `mensagensRepo.createInbound`, que vive
 * em `src/db/repositories/` — um módulo COMPARTILHADO entre o container `app` e
 * o console `admin-ui`. Um import de valor daqui até `src/config/env.ts` faria
 * o console validar o subset `runtime` inteiro no boot e exigir dele as seis
 * `BACKUP_*` (credencial de S3 inclusive) num processo que nunca roda backup —
 * exatamente o que a issue #596 fechou, e o que
 * `tests/unit/config/admin-import-boundary.spec.ts` mantém fechado.
 *
 * Por isso a divisão: aqui fica TUDO o que o repositório precisa (derivação,
 * erro tipado, guarda que lança), e a OBSERVABILIDADE — métrica, auditoria,
 * log — mora em `stream-ingress.ts`, consumido pelo gateway, que é a camada que
 * já paga por `@/config/env.js`. Não é organização: é o que mantém o console
 * bootável.
 *
 * ─── Por que a chave existe ────────────────────────────────────────────────
 *
 * A #505 exige FIFO POR CONVERSA sem serializar a fila inteira. Para isso a
 * unidade de exclusão mútua precisa ser (a) durável, (b) conhecida JÁ NO
 * INGRESSO e (c) escopada por tenant+agent. `conversa_id` falha em (b): ele é
 * resolvido depois, e é NULL na hora em que a ordem de chegada é decidida. Uma
 * unidade de ordenação que às vezes é NULL colapsa todo mundo numa stream só —
 * a serialização global que a issue proíbe.
 *
 * ─── A propriedade que o encoding tem de ter ──────────────────────────────
 *
 * A chave é um hash de MATERIAL CANÔNICO. Se dois conjuntos DIFERENTES de
 * componentes puderem produzir a mesma string de material, duas conversas
 * distintas passam a compartilhar lock, ordem e — na fase de enforcement —
 * exclusão mútua. A issue classifica isso como risco de SEGURANÇA, não de
 * qualidade ("colisões sejam tratadas como risco de segurança").
 *
 * Concatenar com um separador é a forma ingênua, e ela é ambígua:
 *
 *     ["a:b", "c"]  ->  "a:b:c"
 *     ["a", "b:c"]  ->  "a:b:c"      <- MESMA string, streams diferentes
 *
 * Escapar o separador conserta, mas transfere a corretude para a função de
 * escape (e para quem lembrar de aplicá-la em cada componente novo). O encoding
 * usado aqui é COMPRIMENTO-PREFIXADO, no formato netstring:
 *
 *     LP(s) = <bytes(s)> ":" <s> ","
 *
 * O leitor sabe QUANTOS bytes ler antes de ler qualquer um deles, então o
 * conteúdo do componente não pode influenciar a fronteira. `"a:b"` vira
 * `3:a:b,` e `"a"` vira `1:a,` — não existe par de listas distintas com a mesma
 * concatenação. A prova disso é `tests/unit/runtime/stream-key-canonical.spec.ts`,
 * que varre pares adversariais.
 *
 * O comprimento é em BYTES UTF-8, não em code units: `'é'` tem 1 caractere, 2
 * bytes. Medir em `.length` faria a fronteira depender da codificação e
 * reintroduziria a ambiguidade por uma porta lateral.
 *
 * ─── Versão ───────────────────────────────────────────────────────────────
 *
 * A versão do algoritmo aparece DUAS vezes de propósito: como prefixo do valor
 * (`v1:<hash>`) e como coluna própria (`stream_key_version`). O prefixo torna a
 * chave auto-descritiva — duas versões nunca colidem entre si, porque o
 * namespace difere antes do hash — e a coluna torna a versão consultável sem
 * parsear texto. `streamKeyVersionOf` extrai a versão do valor sem reimplementar
 * o parsing, e o teste a usa para provar que as duas concordam.
 *
 * ─── Fail-closed ──────────────────────────────────────────────────────────
 *
 * `tenant_id` e `agent_id` são OBRIGATÓRIOS (invariante MUST nº 1) e o literal
 * `'default'` é recusado (invariante MUST nº 8). Não existe caminho neste
 * módulo que devolva uma chave "genérica", "de fallback" ou "provisória": a
 * função ou devolve uma stream inequívoca ou devolve `{ ok: false, reason }`.
 * Um `default` aqui não seria um valor ruim — seria a fusão de todas as
 * conversas irresolvíveis do sistema numa fila só, com lock compartilhado entre
 * tenants.
 */
import { createHash } from 'node:crypto';

/**
 * Versão CORRENTE do algoritmo. Incrementar isto muda TODA stream_key nova, o
 * que quebra a continuidade de ordenação das streams vivas — exige a política
 * de migração da issue (§Identidade da stream), não é uma edição local.
 */
export const STREAM_KEY_VERSION = 1;

/** Namespace do material canônico. Entra no hash; muda com a versão. */
const STREAM_KEY_NAMESPACE = `maia.stream.v${STREAM_KEY_VERSION}`;

/** Prefixo do VALOR persistido, para que a chave seja auto-descritiva. */
const STREAM_KEY_PREFIX = `v${STREAM_KEY_VERSION}:`;

/**
 * Motivos de recusa. Vocabulário FECHADO — vira label de métrica e coluna de
 * auditoria, e um motivo em texto livre aqui seria cardinalidade controlada por
 * quem manda a mensagem.
 */
export type StreamKeyRejection =
  /** `tenant_id` ausente, em branco, ou com espaço nas bordas. */
  | 'missing_tenant'
  /** `agent_id` ausente, em branco, ou com espaço nas bordas. */
  | 'missing_agent'
  /** `tenant_id` ou `agent_id` é um sentinela reservado (`default` / `system`). */
  | 'reserved_scope_literal'
  /** Tipo de canal ausente ou fora do vocabulário conhecido. */
  | 'missing_channel_kind'
  /** A LINHA (channel_id) não foi resolvida — sem ela não há conversa canônica. */
  | 'missing_channel'
  /** Nenhuma identidade remota foi fornecida. */
  | 'missing_remote_identity'
  /** A identidade remota existe mas não normaliza para uma forma canônica. */
  | 'unnormalizable_remote_identity';

export const STREAM_KEY_REJECTIONS: readonly StreamKeyRejection[] = Object.freeze([
  'missing_tenant',
  'missing_agent',
  'reserved_scope_literal',
  'missing_channel_kind',
  'missing_channel',
  'missing_remote_identity',
  'unnormalizable_remote_identity',
]);

/** Canais cujo `external_id` é um telefone. Hoje só WhatsApp está habilitado. */
const PHONE_CHANNEL_KINDS: ReadonlySet<string> = new Set(['whatsapp', 'sms']);

/**
 * Vocabulário de canal aceito. Espelha o union de `resolveChannel`
 * (`src/gateway/channel-resolver.ts`). Fechado de propósito: um `channel` livre
 * viraria componente do material canônico controlado pelo chamador.
 */
const CHANNEL_KINDS: ReadonlySet<string> = new Set([
  'whatsapp',
  'telegram',
  'email',
  'sms',
  'web',
  'api',
  'other',
]);

/**
 * Sentinelas que NUNCA podem escopar uma stream.
 *
 * `'default'` é o bucket legado eliminado na #323, e a invariante MUST nº 8 o
 * recusa em caminho dinâmico. `'system'` é o bucket sancionado para trabalho
 * GLOBAL SEM DONO — e um ingresso de conversa tem dono por definição, então uma
 * stream sob `system` é dado corrompido, não trabalho de plataforma. Mesmo
 * raciocínio (e mesmo par) de `usableScopeField` em `scope-resolver.ts`.
 */
const RESERVED_SCOPE_LITERALS: ReadonlySet<string> = new Set(['default', 'system']);

export type StreamKeyInput = {
  readonly tenant_id: string | null | undefined;
  readonly agent_id: string | null | undefined;
  /** Tipo do canal (`whatsapp`, …) — o vocabulário de `resolveChannel`. */
  readonly channel_kind: string | null | undefined;
  /** `channels.id` da LINHA que recebeu o evento. */
  readonly channel_id: string | null | undefined;
  /**
   * Identidade remota crua: telefone E.164, JID do Baileys, ou o identificador
   * do canal correspondente. É normalizada aqui — passar a forma crua é o
   * contrato, para que a normalização não fique espalhada por call sites.
   */
  readonly remote_identity: string | null | undefined;
};

export type StreamKeyDerivation =
  | {
      readonly ok: true;
      readonly stream_key: string;
      readonly stream_key_version: number;
    }
  | { readonly ok: false; readonly reason: StreamKeyRejection };

/** Netstring de um componente: `<bytes> ":" <valor> ","`. */
function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value},`;
}

/**
 * Campo de escopo utilizável: string não-vazia, JÁ APARADA (`' primary'` é
 * recusado em vez de aparado — aparar aqui aceitaria duas grafias do mesmo
 * tenant e, com elas, duas streams para a mesma conversa).
 */
function usableScopeField(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  return value.length > 0 && value.trim() === value;
}

/**
 * Normaliza a identidade remota para a forma canônica do canal.
 *
 * WhatsApp/SMS: o material é um TELEFONE. As formas que chegam ao ingresso são
 * `+5511999999999`, `5511999999999@s.whatsapp.net`, `5511999999999:12@…` e
 * `123456@lid`. Todas designam a mesma stream, então todas têm de normalizar
 * para a mesma string — senão o mesmo interlocutor ganha duas streams e a
 * ordem entre elas some. Saída canônica: `+<dígitos>`.
 *
 * Demais canais: forma genérica conservadora — sem espaço nas bordas, sem
 * caractere de controle, minúsculas. Não inventamos normalização específica
 * para canal que ainda não existe no runtime; um canal novo deve ACRESCENTAR
 * seu ramo aqui, com teste, em vez de herdar um genérico que talvez esteja
 * errado para ele.
 *
 * Devolve `null` quando a entrada não normaliza — o chamador transforma isso em
 * `unnormalizable_remote_identity`, nunca em uma chave aproximada.
 */
export function normalizeRemoteIdentity(
  channel_kind: string,
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (PHONE_CHANNEL_KINDS.has(channel_kind)) {
    // Ordem: corta o domínio do JID, corta o sufixo de dispositivo, corta o
    // `+`. `split('@')[0]` é seguro mesmo sem `@` (devolve a string inteira).
    const local = trimmed.split('@')[0]!.split(':')[0]!.replace(/^\+/, '');
    if (!/^[1-9][0-9]{6,19}$/.test(local)) return null;
    return `+${local}`;
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Material canônico do hash. EXPORTADO só para os testes de encoding — nenhum
 * caminho de produção deve chamá-lo, e NADA deve logá-lo: ele contém a
 * identidade remota em claro (telefone), que é PII.
 */
export function canonicalStreamMaterial(components: readonly string[]): string {
  return (
    lengthPrefixed(STREAM_KEY_NAMESPACE) + components.map(lengthPrefixed).join('')
  );
}

/**
 * Deriva a `stream_key`. Determinística, pura, sem fallback.
 *
 * A ordem dos componentes é parte do contrato: trocar duas posições muda toda
 * chave. Ela é (tenant, agent, canal, linha, remoto) — do escopo mais amplo ao
 * mais específico, que é também a ordem em que uma investigação percorre o
 * problema.
 */
export function deriveStreamKey(input: StreamKeyInput): StreamKeyDerivation {
  if (!usableScopeField(input.tenant_id)) return { ok: false, reason: 'missing_tenant' };
  if (!usableScopeField(input.agent_id)) return { ok: false, reason: 'missing_agent' };
  if (
    RESERVED_SCOPE_LITERALS.has(input.tenant_id) ||
    RESERVED_SCOPE_LITERALS.has(input.agent_id)
  ) {
    return { ok: false, reason: 'reserved_scope_literal' };
  }

  const kind = typeof input.channel_kind === 'string' ? input.channel_kind.trim() : '';
  if (kind.length === 0 || !CHANNEL_KINDS.has(kind)) {
    return { ok: false, reason: 'missing_channel_kind' };
  }

  // A LINHA é obrigatória. Não é rigor gratuito: desde a migration 090 a
  // conversa é ESCOPADA POR CANAL, então o mesmo interlocutor em duas linhas do
  // mesmo agente são duas conversas. Sem `channel_id` no material, as duas
  // colapsariam numa stream — o oposto exato do que a issue pede. Em produção
  // o valor sempre existe: TODO ramo não-lançante de `resolveChannel`
  // (`src/gateway/channel-resolver.ts`) devolve `channel_id` não-nulo, e o
  // ingresso já cai fail-closed antes daqui quando a resolução falha.
  if (!usableScopeField(input.channel_id)) return { ok: false, reason: 'missing_channel' };

  if (typeof input.remote_identity !== 'string' || input.remote_identity.trim().length === 0) {
    return { ok: false, reason: 'missing_remote_identity' };
  }
  const remote = normalizeRemoteIdentity(kind, input.remote_identity);
  if (remote === null) return { ok: false, reason: 'unnormalizable_remote_identity' };

  const material = canonicalStreamMaterial([
    input.tenant_id,
    input.agent_id,
    kind,
    input.channel_id,
    remote,
  ]);
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');

  return {
    ok: true,
    stream_key: `${STREAM_KEY_PREFIX}${digest}`,
    stream_key_version: STREAM_KEY_VERSION,
  };
}

/** A stream resolvida, selada. Os dois campos vieram da MESMA derivação. */
export type ResolvedStream = {
  readonly stream_key: string;
  readonly stream_key_version: number;
};

/**
 * O ingresso não pôde ser atribuído a uma stream inequívoca.
 *
 * Carrega o motivo de vocabulário fechado e NADA do conteúdo — a mensagem do
 * erro pode acabar num log genérico, e ela não pode ser o vetor por onde
 * telefone ou texto vazam.
 */
export class StreamIdentityUnresolvedError extends Error {
  readonly code = 'STREAM_IDENTITY_UNRESOLVED';
  readonly reason: StreamKeyRejection;

  constructor(reason: StreamKeyRejection) {
    super(
      `identidade de stream não pôde ser resolvida (reason=${reason}); ` +
        `o ingresso é recusado em vez de cair numa stream genérica — issue #505, invariante MUST nº 2/nº 8`,
    );
    this.name = 'StreamIdentityUnresolvedError';
    this.reason = reason;
  }
}

/** `true` para o erro acima, sem depender de `instanceof` cruzando módulos. */
export function isStreamIdentityUnresolved(
  err: unknown,
): err is StreamIdentityUnresolvedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'STREAM_IDENTITY_UNRESOLVED'
  );
}

/**
 * A GUARDA FAIL-CLOSED: devolve a stream ou LANÇA.
 *
 * ─── Por que um `throw`, e não um `null` ──────────────────────────────────
 *
 * Um `null` convida o chamador a seguir em frente. Um erro TIPADO obriga a
 * decidir: ou trata (o gateway derruba a mensagem com trilha) ou propaga. É a
 * mesma escolha, pela mesma razão, de `TurnScopeUnresolvedError` em
 * `scope-resolver.ts` — sem stream não há ordem, e persistir sem ordem é
 * precisamente o fail-open que a issue proíbe (§Falhas 8: "mensagem sem
 * identidade resolvida cai em stream `default` ou global").
 *
 * Quem chama isto é o REPOSITÓRIO, no ponto em que o inbound seria persistido.
 * A recusa acontece, portanto, ANTES de qualquer escrita — recusar depois de
 * persistir seria fail-open com log bonito.
 */
export function requireStreamIdentity(input: StreamKeyInput): ResolvedStream {
  const derived = deriveStreamKey(input);
  if (!derived.ok) throw new StreamIdentityUnresolvedError(derived.reason);
  return Object.freeze({
    stream_key: derived.stream_key,
    stream_key_version: derived.stream_key_version,
  });
}

/**
 * A versão embutida no VALOR e a versão da COLUNA descrevem o mesmo algoritmo?
 *
 * Existe para que o teste possa provar a concordância sem reimplementar o
 * parsing — se alguém trocar só o prefixo ou só a constante, isto fica falso.
 */
export function streamKeyVersionOf(stream_key: string): number | null {
  const match = /^v([1-9][0-9]*):[0-9a-f]{64}$/.exec(stream_key);
  return match ? Number(match[1]) : null;
}

/**
 * Issue #505 — a FRONTEIRA FAIL-CLOSED do ingresso.
 *
 * `stream-key.ts` decide QUAL é a stream. Este módulo decide o que acontece
 * quando ela não pode ser decidida — e a resposta é sempre a mesma: o ingresso
 * é RECUSADO, medido e auditado. Nunca agrupado numa stream genérica, nunca
 * `'default'`, nunca "processa assim mesmo e resolve depois".
 *
 * ─── Por que a recusa é um `throw`, e não um `null` ────────────────────────
 *
 * Um `null` convida o chamador a seguir em frente. Um erro TIPADO obriga a
 * decidir: quem chama ou trata (o gateway derruba a mensagem com trilha) ou
 * propaga. É a mesma escolha, pela mesma razão, de
 * `TurnScopeUnresolvedError` em `scope-resolver.ts` — sem stream não há ordem,
 * e executar sem ordem é precisamente o fail-open que a issue proíbe (§Falhas
 * 8: "mensagem sem identidade resolvida cai em stream `default` ou global").
 *
 * ─── O que vira métrica e o que vira audit_log ─────────────────────────────
 *
 * A régua é a mesma de #503/#504: só entra em `audit_log` o que um humano
 * precisa RECONSTRUIR depois.
 *
 *   * TODA recusa vira `audit_log`. É uma mensagem de usuário que a
 *     plataforma decidiu não processar — a decisão governável por excelência,
 *     e o operador precisa saber que ela existiu.
 *   * O NASCIMENTO de uma stream (`ingress_seq === 1`) vira `audit_log`. É o
 *     registro durável de "esta stream passou a existir, sob este algoritmo",
 *     e é o que permite reconstruir o começo de uma ordem meses depois.
 *   * TODO ingresso sequenciado vira LOG ESTRUTURADO (`stream.ingress_sequenced`),
 *     nunca audit. Auditar uma row por mensagem inflaria `audit_log` na razão
 *     do tráfego sem acrescentar decisão governável — e a issue pede a
 *     auditoria "quando relevante" (§Observability), exatamente essa ressalva.
 *     A reconstrução de `first_ingress_seq`/`last_ingress_seq` que a issue
 *     exige sai desse log, que é onde ela pertence.
 *
 * NENHUM dos três carrega `stream_key`, `remote_jid`, telefone ou conteúdo em
 * LABEL de métrica (a issue proíbe explicitamente). `stream_key` aparece em log
 * estruturado — é um hash, não a identidade em claro — e em `audit_log`, que é
 * armazenamento protegido, jamais como dimensão de série.
 */
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { counter } from '@/observability/metrics.js';
import { METRIC, closedVocabulary } from '@/observability/taxonomy.js';
import {
  deriveStreamKey,
  STREAM_KEY_REJECTIONS,
  type StreamKeyInput,
  type StreamKeyRejection,
} from './stream-key.js';

/** A stream resolvida, selada. Os dois campos vieram da MESMA derivação. */
export type ResolvedStream = {
  readonly stream_key: string;
  readonly stream_key_version: number;
};

/**
 * O ingresso não pôde ser atribuído a uma stream inequívoca.
 *
 * Carrega o motivo de vocabulário fechado e NADA do conteúdo — a mensagem do
 * erro pode acabar num log de erro genérico, e ela não pode ser o vetor por
 * onde telefone ou texto vazam.
 */
export class StreamIdentityUnresolvedError extends Error {
  readonly code = 'STREAM_IDENTITY_UNRESOLVED';
  readonly reason: StreamKeyRejection;

  constructor(reason: StreamKeyRejection) {
    super(
      `resolveIngressStream: identidade de stream não pôde ser resolvida (reason=${reason}); ` +
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
 * Resolve a stream do ingresso ou RECUSA-O.
 *
 * @throws {StreamIdentityUnresolvedError} em qualquer desfecho que não seja uma
 *   derivação inequívoca. A recusa já foi medida e auditada quando o erro sobe.
 */
export async function resolveIngressStream(input: StreamKeyInput): Promise<ResolvedStream> {
  const derived = deriveStreamKey(input);
  if (derived.ok) {
    counter(METRIC.STREAM_INGRESS, {
      channel_kind: closedVocabulary(input.channel_kind ?? null, CHANNEL_KIND_LABELS),
      result: 'resolved',
    });
    return Object.freeze({
      stream_key: derived.stream_key,
      stream_key_version: derived.stream_key_version,
    });
  }

  counter(METRIC.STREAM_INGRESS, {
    channel_kind: closedVocabulary(input.channel_kind ?? null, CHANNEL_KIND_LABELS),
    result: 'rejected',
  });
  counter(METRIC.STREAM_INGRESS_REJECTED, {
    reason: closedVocabulary(derived.reason, STREAM_KEY_REJECTIONS),
  });
  logger.error(
    {
      reason: derived.reason,
      // Só a FORMA dos componentes, nunca os valores. `tenant_id`/`agent_id`
      // seriam seguros, mas quando o motivo é `missing_tenant` não há o que
      // registrar — e registrar "presente/ausente" responde a pergunta inteira.
      has_tenant: typeof input.tenant_id === 'string' && input.tenant_id.length > 0,
      has_agent: typeof input.agent_id === 'string' && input.agent_id.length > 0,
      has_channel: typeof input.channel_id === 'string' && input.channel_id.length > 0,
      has_remote_identity:
        typeof input.remote_identity === 'string' && input.remote_identity.length > 0,
      ops_alert: true,
    },
    'stream.ingress_rejected',
  );
  // Sem contexto de tenant ativo, `audit()` embrulha em `system` — a atribuição
  // HONESTA de uma recusa cujo tema é justamente não saber o dono.
  await audit({
    acao: 'stream_ingress_rejected',
    metadata: {
      reason: derived.reason,
      channel_kind: typeof input.channel_kind === 'string' ? input.channel_kind : null,
    },
  });
  throw new StreamIdentityUnresolvedError(derived.reason);
}

/**
 * Registra que um ingresso recebeu sua posição na stream.
 *
 * Chamado DEPOIS do commit da transação de alocação — antes dele o número ainda
 * pode ser devolvido por um rollback, e um log de "sequenciado" que o rollback
 * desmente é pior que nenhum log.
 */
export async function noteIngressSequenced(args: {
  stream_key: string;
  stream_key_version: number;
  ingress_seq: number;
  mensagem_id: string;
  channel_kind: string | null;
}): Promise<void> {
  logger.info(
    {
      // `stream_key` é um hash — não identifica o interlocutor por si só, e é
      // a única âncora que liga os eventos de uma mesma conversa na trilha.
      stream_key: args.stream_key,
      stream_key_version: args.stream_key_version,
      ingress_seq: args.ingress_seq,
      mensagem_id: args.mensagem_id,
    },
    'stream.ingress_sequenced',
  );
  // Só o NASCIMENTO da stream vira audit — ver o bloco no topo do arquivo.
  if (args.ingress_seq === 1) {
    await audit({
      acao: 'stream_ingress_sequenced',
      metadata: {
        stream_key: args.stream_key,
        stream_key_version: args.stream_key_version,
        ingress_seq: args.ingress_seq,
        channel_kind: args.channel_kind,
        event: 'stream_opened',
      },
    });
  }
}

/**
 * Vocabulário FECHADO do label `channel_kind`. Espelha o union de
 * `resolveChannel`; qualquer outra coisa colapsa para o fallback do
 * `closedVocabulary` em vez de virar série nova.
 */
const CHANNEL_KIND_LABELS: readonly string[] = Object.freeze([
  'whatsapp',
  'telegram',
  'email',
  'sms',
  'web',
  'api',
  'other',
]);

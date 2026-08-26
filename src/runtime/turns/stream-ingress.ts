/**
 * Issue #505 — a OBSERVABILIDADE da fronteira de identidade de stream.
 *
 * ─── A divisão de responsabilidade, e por que ela é estrutural ─────────────
 *
 * A DECISÃO (derivar a stream, ou recusar o ingresso) mora em `stream-key.ts`,
 * que é puro e é chamado pelo REPOSITÓRIO, no ponto em que o inbound seria
 * persistido. A recusa acontece portanto ANTES de qualquer escrita.
 *
 * O RELATO da decisão — métrica, auditoria, log — mora aqui, e é chamado pelo
 * GATEWAY. A separação não é estética: `src/db/repositories/` é COMPARTILHADO
 * entre o container `app` e o console `admin-ui`, e a cadeia
 * `métrica -> labels -> src/config/env.ts` faria o console validar o subset
 * `runtime` inteiro no boot, exigindo dele as seis `BACKUP_*` (credencial de S3
 * inclusive) num processo que nunca roda backup — a issue #596, fixada por
 * `tests/unit/config/admin-import-boundary.spec.ts`. O gateway já paga por
 * `@/config/env.js`; o repositório não pode passar a pagar.
 *
 * Consequência honesta dessa divisão: um chamador futuro de `createInbound` que
 * NÃO chame estas funções continua FAIL-CLOSED (o repositório recusa), mas a
 * recusa dele não vira métrica nem `audit_log`. O que impede isso hoje é haver
 * um único chamador de produção (`src/gateway/baileys.ts`); o que impediria
 * estruturalmente seria o repositório poder falar com a camada de métrica — e é
 * exatamente isso que a fronteira de import do console proíbe.
 *
 * ─── O que vira métrica e o que vira audit_log ─────────────────────────────
 *
 * A régua é a mesma de #503/#504: só entra em `audit_log` o que um humano
 * precisa RECONSTRUIR depois.
 *
 *   * TODA recusa vira `audit_log`. É uma mensagem de usuário que a plataforma
 *     decidiu não processar — a decisão governável por excelência.
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
import { STREAM_KEY_REJECTIONS, type StreamKeyRejection } from './stream-key.js';

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

/** O ingresso foi atribuído a uma stream. Só métrica — o detalhe vai no log. */
export function reportStreamIngressResolved(channel_kind: string | null): void {
  counter(METRIC.STREAM_INGRESS, {
    channel_kind: closedVocabulary(channel_kind, CHANNEL_KIND_LABELS),
    result: 'resolved',
  });
}

/**
 * O ingresso foi RECUSADO por identidade irresolúvel: mede, loga e audita.
 *
 * Chamado pelo gateway no `catch` de `StreamIdentityUnresolvedError`.
 */
export async function reportStreamIngressRejected(args: {
  reason: StreamKeyRejection;
  channel_kind: string | null;
  /** Identificador do evento no provedor. A row NÃO foi persistida. */
  whatsapp_id?: string | null;
}): Promise<void> {
  counter(METRIC.STREAM_INGRESS, {
    channel_kind: closedVocabulary(args.channel_kind, CHANNEL_KIND_LABELS),
    result: 'rejected',
  });
  counter(METRIC.STREAM_INGRESS_REJECTED, {
    reason: closedVocabulary(args.reason, STREAM_KEY_REJECTIONS),
  });
  logger.error(
    {
      reason: args.reason,
      // O `whatsapp_id` é o ÚNICO identificador estável que sobra: a mensagem
      // não foi persistida, então não existe `mensagem_id` para citar.
      whatsapp_id: args.whatsapp_id ?? null,
      ops_alert: true,
    },
    'stream.ingress_rejected',
  );
  await audit({
    acao: 'stream_ingress_rejected',
    metadata: {
      reason: args.reason,
      channel_kind: args.channel_kind,
      whatsapp_id: args.whatsapp_id ?? null,
    },
  });
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

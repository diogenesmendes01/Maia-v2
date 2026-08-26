/**
 * Issue #632 (fatia C da épica #506) — identidade DETERMINÍSTICA do job de
 * entrega na BullMQ.
 *
 * Módulo PURO (nem `bullmq` nem `ioredis`), pelo mesmo motivo de
 * `src/runtime/turns/job.ts` (#504): importável sem abrir conexão Redis e
 * testável sem infraestrutura.
 *
 * ─── O que é "o mesmo trabalho lógico" aqui ─────────────────────────────────
 *
 * É a LINHA DO OUTBOX (`outbound_messages.id`), e não o turno, nem a mensagem,
 * nem o evento de enfileiramento. A distinção é obrigatória: uma resposta
 * multipart (#635) tem N saídas lógicas do MESMO turno, e um id derivado do
 * turno faria a segunda parte colidir com a primeira e ser silenciosamente
 * descartada pela BullMQ — uma resposta que some.
 *
 * O critério de pronto da issue diz isto em uma linha: "job de delivery usa ID
 * determinístico por `outbound_id`".
 *
 * ─── Por que colidir é o comportamento desejado ─────────────────────────────
 *
 * A mesma linha é enfileirada por caminhos INDEPENDENTES que não se conhecem:
 * o commit transacional (#631), o recovery/sweeper (#633) — que roda em várias
 * réplicas — e um replay manual de operação. Com id gerado pela BullMQ cada um
 * criaria um job próprio e N workers puxariam N jobs da MESMA linha. Derivando
 * o id do `outbound_id`, os enfileiramentos COLIDEM: a BullMQ ignora o `add`
 * quando já existe job com aquele id.
 *
 * Colidir não é suficiente sozinho — jobs armados antes deste deploy, ou um
 * job já removido da fila e re-adicionado, continuam produzindo concorrência
 * real. É por isso que o claim atômico com lease existe
 * (`delivery-contract.ts`). As duas camadas são independentes de propósito: o
 * `jobId` evita a duplicata no TRANSPORTE; o claim evita a execução dupla
 * mesmo quando ela acontece assim mesmo.
 *
 * ─── Por que `outbound-<uuid>` e não um digest ──────────────────────────────
 *
 * Mesma razão de `agentTurnJobId`: a chave natural já é um UUID — um campo só,
 * sem `:` (que a BullMQ reserva em ids custom), de comprimento fixo e legível.
 * Hashear tornaria o id ilegível no `npm run dlq` e no Bull Board sem ganhar
 * nada. O prefixo é um namespace explícito para não colidir com `turn-*` nem
 * com `debounce:*`.
 */
import { z } from 'zod';

/** Prefixo do id. Namespace explícito, distinto de `TURN_JOB_ID_PREFIX`. */
export const OUTBOUND_DELIVERY_JOB_ID_PREFIX = 'outbound-';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `jobId` ESTÁVEL da entrega de uma linha do outbox. Mesma entrada ⇒ mesma
 * saída, sempre, em qualquer processo e em qualquer deploy: nenhum relógio,
 * nenhum contador, nenhum aleatório entra na derivação.
 *
 * NÃO participa `attempt`. Incluí-lo daria um id novo por tentativa e a
 * colisão — que é a garantia inteira — desapareceria exatamente no cenário que
 * ela existe para cobrir: o retry.
 *
 * FAIL-LOUD em id malformado, como em #504: um `outbound_id` inválido
 * produziria um `jobId` imprevisível e a não-duplicação sumiria em silêncio.
 */
export function outboundDeliveryJobId(outbound_id: string): string {
  if (!UUID_RE.test(outbound_id)) {
    throw new Error(
      `outboundDeliveryJobId: outbound_id inválido (${outbound_id.length} chars). O jobId ` +
        `determinístico é a garantia de não-duplicação no transporte; derivá-lo de um id ` +
        `malformado a anularia em silêncio.`,
    );
  }
  // Minúsculas: o UUID é case-insensitive como VALOR, mas o jobId é uma CHAVE
  // de string no Redis. Sem normalizar, a mesma linha com o UUID em maiúsculas
  // viraria um segundo job — e dois jobs é exatamente o que este módulo evita.
  return `${OUTBOUND_DELIVERY_JOB_ID_PREFIX}${outbound_id.toLowerCase()}`;
}

/** Extrai o `outbound_id` de um jobId de entrega; `null` se não for um deles. */
export function outboundIdFromJobId(job_id: string | null | undefined): string | null {
  if (typeof job_id !== 'string' || !job_id.startsWith(OUTBOUND_DELIVERY_JOB_ID_PREFIX)) {
    return null;
  }
  const candidate = job_id.slice(OUTBOUND_DELIVERY_JOB_ID_PREFIX.length);
  return UUID_RE.test(candidate) ? candidate : null;
}

/**
 * Payload do job. SÓ a identidade durável — nada de tenant, agent, telefone,
 * texto ou canal.
 *
 * Pelo mesmo motivo do `AgentTurnJobV2Schema` (#504): o worker recarrega tudo
 * do PostgreSQL DEPOIS do claim. Confiar em tenant vindo do payload seria
 * aceitar um escopo que ninguém reconciliou com a linha persistida — e aqui
 * seria pior, porque o payload de entrega passaria pelo Redis carregando
 * destinatário e conteúdo.
 *
 * `.strict()`: campo desconhecido é REJEITADO, não ignorado. É o que impede
 * que alguém "só acrescente o telefone para facilitar o debug".
 */
export const OutboundDeliveryJobSchema = z
  .object({
    version: z.literal(1),
    outbound_id: z.string().regex(UUID_RE, 'outbound_id deve ser UUID'),
  })
  .strict();

export type OutboundDeliveryJob = z.infer<typeof OutboundDeliveryJobSchema>;

/** Constrói o payload canônico. Uma função para que ninguém monte o literal. */
export function buildOutboundDeliveryJob(outbound_id: string): OutboundDeliveryJob {
  return OutboundDeliveryJobSchema.parse({ version: 1, outbound_id: outbound_id.toLowerCase() });
}

/**
 * Leitura TIPADA do payload. Resultado, e não throw, pela razão de #504: um
 * payload irreconhecível não pode derrubar o worker inteiro — ele vira métrica
 * e DLQ, com o job identificado.
 *
 * A mensagem do erro carrega só o CAMINHO do campo, nunca o valor: o payload
 * de um job malformado pode conter qualquer coisa que alguém tenha enfiado
 * nele, inclusive conteúdo de conversa.
 */
export type ParsedOutboundDeliveryJob =
  | { kind: 'valid'; outbound_id: string }
  | { kind: 'invalid'; issue: string };

export function parseOutboundDeliveryJob(data: unknown): ParsedOutboundDeliveryJob {
  const parsed = OutboundDeliveryJobSchema.safeParse(data);
  if (parsed.success) {
    return { kind: 'valid', outbound_id: parsed.data.outbound_id.toLowerCase() };
  }
  return { kind: 'invalid', issue: parsed.error.issues[0]?.path.join('.') || 'shape' };
}

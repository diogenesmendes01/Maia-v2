/**
 * Issue #504 — identidade DETERMINÍSTICA do job de turno na BullMQ.
 *
 * Módulo PURO (nem `bullmq` nem `ioredis`): importável por qualquer lado sem
 * abrir conexão Redis, e testável sem infraestrutura. `src/gateway/queue.ts` o
 * consome para carimbar o `jobId`.
 *
 * ─── O que é "o mesmo trabalho lógico" ──────────────────────────────────────
 *
 * É o TURNO, não a mensagem e não o evento de enfileiramento.
 *
 * A distinção não é acadêmica. O debounce agrega N mensagens numa execução, de
 * modo que "por mensagem" enfileiraria N vezes o mesmo trabalho. E o mesmo
 * turno é enfileirado por caminhos INDEPENDENTES que não se conhecem — o
 * ingresso (`src/gateway/baileys.ts`) e o sweep de recovery
 * (`src/workers/message-recovery.ts`), que pode rodar em várias réplicas ao
 * mesmo tempo. Enquanto o `jobId` era gerado pela BullMQ, cada um desses
 * caminhos criava um job próprio e o Postgres via duas tentativas do mesmo
 * turno. Derivar o id do `turn_id` faz os enfileiramentos COLIDIREM: a BullMQ
 * ignora o `add` quando já existe job com aquele id.
 *
 * Colidir é o comportamento desejado, mas não é suficiente sozinho — é por isso
 * que o claim atômico existe. O `jobId` evita a duplicata no TRANSPORTE; o
 * claim evita a execução dupla mesmo quando a duplicata acontece assim mesmo
 * (dois consumidores puxando jobs distintos armados antes deste deploy, por
 * exemplo). As duas camadas são independentes de propósito.
 *
 * ─── Por que `turn-<uuid>` e não um digest ──────────────────────────────────
 *
 * `unroutedReplayJobId` usa digest porque a chave natural dele é um PAR de
 * campos de formato livre (linha, wid) e a BullMQ reserva `:` em ids custom.
 * Aqui a chave natural já é um UUID: um único campo, sem `:`, de comprimento
 * fixo e legível. Hashear só tornaria o id ilegível no `npm run dlq` e no
 * Bull Board sem ganhar nada.
 */
import { z } from 'zod';

/** Prefixo do id. Namespace explícito para não colidir com `debounce:*`. */
export const TURN_JOB_ID_PREFIX = 'turn-';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `jobId` ESTÁVEL do turno. Mesma entrada ⇒ mesma saída, sempre, em qualquer
 * processo e em qualquer deploy (nenhum relógio, nenhum contador, nenhum
 * aleatório entra na derivação).
 *
 * FAIL-LOUD em id malformado: um `turn_id` inválido produziria um `jobId`
 * inválido, o `add` cairia num id imprevisível e a colisão — que é a garantia
 * inteira — desapareceria silenciosamente.
 */
export function agentTurnJobId(turn_id: string): string {
  if (!UUID_RE.test(turn_id)) {
    throw new Error(
      `agentTurnJobId: turn_id inválido (${turn_id.length} chars). O jobId determinístico é a ` +
        `garantia de não-duplicação no transporte; derivá-lo de um id malformado a anularia em silêncio.`,
    );
  }
  // Minúsculas: o UUID é case-insensitive como valor, mas o jobId é uma CHAVE
  // de string no Redis. Sem normalizar, o mesmo turno com o UUID em maiúsculas
  // viraria um segundo job.
  return `${TURN_JOB_ID_PREFIX}${turn_id.toLowerCase()}`;
}

/** Extrai o `turn_id` de um `jobId` de turno; `null` se não for um deles. */
export function turnIdFromJobId(job_id: string | null | undefined): string | null {
  if (typeof job_id !== 'string' || !job_id.startsWith(TURN_JOB_ID_PREFIX)) return null;
  const candidate = job_id.slice(TURN_JOB_ID_PREFIX.length);
  return UUID_RE.test(candidate) ? candidate : null;
}

// ─── Contrato do payload ────────────────────────────────────────────────────

/**
 * Payload V2 (issue §Contrato do job): SÓ a identidade durável.
 *
 * Nada de tenant, agent ou conteúdo — o worker recarrega tudo do PostgreSQL
 * DEPOIS do claim. Confiar em tenant vindo do payload seria aceitar um escopo
 * que ninguém reconciliou com a linha persistida.
 */
export const AgentTurnJobV2Schema = z
  .object({
    version: z.literal(2),
    turn_id: z.string().regex(UUID_RE, 'turn_id deve ser UUID'),
  })
  .strict();

export type AgentTurnJobV2 = z.infer<typeof AgentTurnJobV2Schema>;

/**
 * Payload V1 (legado, o que roda hoje): a identidade é a MENSAGEM, e o worker
 * reencontra o turno por ela. Campos de correlação (#514) são opcionais e não
 * participam da identidade.
 */
export const AgentTurnJobV1Schema = z
  .object({
    mensagem_id: z.string().regex(UUID_RE, 'mensagem_id deve ser UUID'),
    /** #504: additivo — presente quando o produtor conhecia o turno. */
    turn_id: z.string().regex(UUID_RE).optional(),
    trace_id: z.string().optional(),
    enqueued_at_ms: z.number().optional(),
    received_at_ms: z.number().optional(),
  })
  .passthrough();

/**
 * Leitura DUAL do payload (janela de compatibilidade da issue §Contrato do
 * job). Um worker novo entende os dois formatos; um worker antigo só entende
 * V1 — por isso o produtor só pode migrar DEPOIS que todos os consumidores
 * souberem ler V2, e é essa ordem que o rollout do runbook impõe.
 *
 * Resultado TIPADO em vez de throw: um payload irreconhecível não pode derrubar
 * o worker inteiro; ele vira métrica + DLQ, com o job identificado.
 */
export type ParsedAgentTurnJob =
  | { kind: 'v2'; turn_id: string }
  | { kind: 'v1'; mensagem_id: string; turn_id: string | null }
  | { kind: 'invalid'; issue: string };

export function parseAgentTurnJob(data: unknown): ParsedAgentTurnJob {
  const v2 = AgentTurnJobV2Schema.safeParse(data);
  if (v2.success) return { kind: 'v2', turn_id: v2.data.turn_id.toLowerCase() };
  const v1 = AgentTurnJobV1Schema.safeParse(data);
  if (v1.success) {
    return {
      kind: 'v1',
      mensagem_id: v1.data.mensagem_id.toLowerCase(),
      turn_id: v1.data.turn_id ? v1.data.turn_id.toLowerCase() : null,
    };
  }
  // Mensagem SEM o payload: ele pode conter texto da conversa. Só o caminho do
  // erro, que é estrutura.
  return { kind: 'invalid', issue: v1.error.issues[0]?.path.join('.') || 'shape' };
}

/**
 * Label de MÉTRICA da versão observada, para o critério de remoção do caminho
 * legado ("zero jobs V1 observados por uma janela definida" — issue §Notas de
 * implementação). Cardinalidade fechada em três valores.
 */
export function jobVersionLabel(parsed: ParsedAgentTurnJob): 'v1' | 'v2' | 'invalid' {
  return parsed.kind;
}

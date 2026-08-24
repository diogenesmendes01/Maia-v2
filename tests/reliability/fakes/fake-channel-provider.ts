/**
 * Issue #510 — cliente TIPADO do fake de provider de canal.
 *
 * O servidor vive em `fake-channel-provider-server.mjs`, num processo separado
 * (o motivo está no cabeçalho de lá). Este arquivo é a única forma de um
 * cenário falar com ele: sobe o processo pelo `ProcessSupervisor`, faz o
 * handshake de prontidão, e expõe o ledger com tipos.
 *
 * Por que o cliente não conhece o `ChildProcess`: quem gerencia ciclo de vida
 * de processo é o supervisor, e ele já sabe matar por PID exato, capturar
 * stdout e reprovar o cenário numa saída inesperada. Duplicar isso aqui seria
 * um segundo caminho de kill — exatamente o que a issue proíbe.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProcessSupervisor, SupervisedChild } from '../harness/process-supervisor.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
export const CAMINHO_DO_SERVIDOR = join(AQUI, 'fake-channel-provider-server.mjs');

/** Os comportamentos que o cenário pode roteirizar, na ordem em que serão consumidos. */
export const comportamentoSchema = z.discriminatedUnion('kind', [
  /** Caminho feliz: aceita, registra efeito lógico, responde. */
  z.object({ kind: z.literal('accept'), delayMs: z.number().int().min(0).optional() }),
  /** Rejeita ANTES de aceitar: nenhum efeito, chave permanece livre. */
  z.object({
    kind: z.literal('reject'),
    status: z.number().int().min(400).max(599).optional(),
    reason: z.string().optional(),
    delayMs: z.number().int().min(0).optional(),
  }),
  /**
   * Aceita, registra o efeito e DERRUBA a conexão antes de responder — o
   * `delivery_unknown` da FI-18. Quem chamou não pode concluir "falhou".
   */
  z.object({ kind: z.literal('accept_then_drop'), delayMs: z.number().int().min(0).optional() }),
]);
export type ComportamentoDoProvider = z.infer<typeof comportamentoSchema>;

export const entradaDeLedgerSchema = z.object({
  idempotency_key: z.string(),
  payload_hash: z.string(),
  tenant_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  /** Quantas vezes a REDE chegou ao provider com esta chave. */
  physical_call_count: z.number().int().min(0),
  /** Quantas mensagens o destinatário realmente veria. A garantia é `<= 1`. */
  logical_effect_count: z.number().int().min(0),
  provider_message_id: z.string(),
  outcome: z.enum(['accepted', 'rejected', 'unknown', 'conflict']),
  first_seen_at: z.number(),
  conflicts: z.number().int().optional(),
});
export type EntradaDeLedger = z.infer<typeof entradaDeLedgerSchema>;

export const ledgerSchema = z.object({
  entries: z.array(entradaDeLedgerSchema),
  calls: z.array(
    z.object({
      idempotency_key: z.string(),
      payload_hash: z.string(),
      at: z.number(),
      kind: z.string(),
    }).passthrough(),
  ),
  physical_call_total: z.number().int().min(0),
  logical_effect_total: z.number().int().min(0),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export interface RespostaDeEnvio {
  status: number;
  corpo: Record<string, unknown>;
}

export interface PedidoDeEnvio {
  idempotency_key: string;
  payload_hash: string;
  tenant_id?: string;
  agent_id?: string;
}

/**
 * Hash canônico de payload. O provider compara HASH, não conteúdo — assim o
 * ledger nunca guarda mensagem de usuário, e o artefato não tem o que vazar.
 */
export function hashDePayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

export class FakeChannelProvider {
  readonly baseUrl: string;
  readonly filho: SupervisedChild;

  private constructor(baseUrl: string, filho: SupervisedChild) {
    this.baseUrl = baseUrl;
    this.filho = filho;
  }

  /**
   * Sobe o servidor como filho DO SUPERVISOR e espera o handshake de
   * prontidão. A porta é efêmera e vem no handshake — o harness nunca fixa
   * porta, senão duas worktrees colidem.
   */
  static async iniciar(
    supervisor: ProcessSupervisor,
    opts: { label?: string; readyTimeoutMs?: number } = {},
  ): Promise<FakeChannelProvider> {
    const label = opts.label ?? 'fake-channel-provider';
    const filho = supervisor.spawn({ label, script: CAMINHO_DO_SERVIDOR });
    const carga = await filho.esperarPronto(opts.readyTimeoutMs ?? 10_000);
    const porta = Number(carga.port);
    if (!Number.isInteger(porta) || porta <= 0) {
      throw new Error(
        `O fake de provider anunciou prontidão sem porta utilizável: ${JSON.stringify(carga)}`,
      );
    }
    return new FakeChannelProvider(`http://127.0.0.1:${porta}`, filho);
  }

  /** Enfileira comportamentos, consumidos em ordem por chave NOVA. */
  async roteirizar(comportamentos: readonly ComportamentoDoProvider[]): Promise<void> {
    const validados = comportamentos.map((c) => comportamentoSchema.parse(c));
    const r = await fetch(`${this.baseUrl}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behaviors: validados }),
    });
    if (!r.ok) throw new Error(`roteirizar falhou: HTTP ${r.status}`);
  }

  /**
   * Um envio físico. Devolve status + corpo SEM jogar em 4xx/5xx: o cenário
   * precisa afirmar sobre o 409 de conflito, e uma exceção o esconderia atrás
   * de um `try`.
   */
  async enviar(pedido: PedidoDeEnvio): Promise<RespostaDeEnvio> {
    const r = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pedido),
    });
    const corpo = (await r.json()) as Record<string, unknown>;
    return { status: r.status, corpo };
  }

  /** O ledger completo, validado por Zod na fronteira. */
  async ledger(): Promise<Ledger> {
    const r = await fetch(`${this.baseUrl}/ledger`);
    if (!r.ok) throw new Error(`ledger falhou: HTTP ${r.status}`);
    return ledgerSchema.parse(await r.json());
  }

  /** Entrada de uma chave, ou `undefined`. */
  async entrada(idempotencyKey: string): Promise<EntradaDeLedger | undefined> {
    const l = await this.ledger();
    return l.entries.find((e) => e.idempotency_key === idempotencyKey);
  }

  async reset(): Promise<void> {
    const r = await fetch(`${this.baseUrl}/reset`, { method: 'POST' });
    if (!r.ok) throw new Error(`reset falhou: HTTP ${r.status}`);
  }
}

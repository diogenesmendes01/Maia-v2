/**
 * SC01 (spec §5.2, §5.3.1) — O CONTEXTO DE HOST DO MOTOR LOCAL.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * A porta (`AgentEnginePortV1`) recebe `EngineRequestV1` + `EngineIOV1`, e NENHUM
 * dos dois carrega `conversa_id`/`turno_id`. Isso é deliberado: o pedido é a
 * parte SERIALIZÁVEL de um run (system, messages, tools, limites) e não pode
 * ganhar campos de identidade da casa sem virar transporte de contexto Maia
 * (§5.3.1 — `claim_token`, destinatário e grants são exclusivamente da Maia).
 *
 * O raciocínio local, porém, precisa desses ids: `runCognitiveModule` registra
 * a execução em `cognitive_module_log` chaveada por `conversa_id`/`turno_id`, e
 * o `pessoa_id` acompanha a chamada ao provedor (`callLLM`). Sem eles, o motor
 * local perderia o registro que hoje existe — e o registro é justamente o que a
 * extração não pode apagar (§5.1.1).
 *
 * A ligação entre "qual turno" e "qual raciocínio" é feita AQUI, por um escopo
 * de `AsyncLocalStorage` aberto pelo stage (quem tem o host é quem chama o
 * motor), e lida pelo `runReasoning` injetado na instância local. É o mesmo
 * desenho de `synthetic-core-context.ts`: um fato de COMPOSIÇÃO do processo que
 * a porta não precisa conhecer.
 *
 * ─── O que ele NÃO é ────────────────────────────────────────────────────────
 *
 * Não é autenticação e não atravessa processo: é um objeto local de composição,
 * e um motor remoto — que recebe o pedido por fio — nunca o enxerga. Também não
 * substitui o `EngineIOV1`: o `AbortSignal` da tentativa e o `invokeTool`
 * continuam vindo por parâmetro, porque são a fronteira de efeito do turno, não
 * um detalhe de composição.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LocalEngineHostV1 = {
  /** `conversas.id` — chave do log de módulo cognitivo. */
  conversa_id: string;
  /** `mensagens.id` do inbound representativo — o "turno" da Maia. */
  turno_id: string;
  /** `pessoas.id` — acompanha a chamada ao provedor. */
  pessoa_id: string;
};

const store = new AsyncLocalStorage<LocalEngineHostV1>();

export function runWithLocalEngineHost<T>(host: LocalEngineHostV1, fn: () => Promise<T>): Promise<T> {
  return store.run(host, fn);
}

/**
 * O host do turno em curso, ou `null` fora de um.
 *
 * `null` é um valor REAL e não um erro: o motor local é chamado por caminhos
 * que não são um turno reivindicado (playground, workers de agenda, specs
 * unitárias do laço). Nesses casos o raciocínio degrada para os ids sentinela —
 * o mesmo tratamento que `runReActLoop` já dava antes da extração, quando os
 * ids vinham direto de `params`.
 */
export function currentLocalEngineHost(): LocalEngineHostV1 | null {
  return store.getStore() ?? null;
}
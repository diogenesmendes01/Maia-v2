/**
 * P01/P02.2 · SC01 — OS TIPOS DO TURNO LOCAL, num módulo sem dependência de
 * implementação.
 *
 * ─── Por que eles saíram de `react-loop.ts` ─────────────────────────────────
 *
 * A extração partiu o laço em três: raciocínio (`./maia-reasoning.js` atrás da
 * porta), gateway de ferramentas (`@/runtime/engines/reasoner-stage.js`) e
 * entrega (`@/runtime/engines/coordinator.js`). Os três PRECISAM destes tipos —
 * e o tipo de saída do coordenador é o de entrada do `decideTurnAction`. Deixá-
 * los em `react-loop.ts` obrigaria cada um a importar de um módulo que, por sua
 * vez, importa o stage: um ciclo de módulos por motivo puramente nominal.
 *
 * Aqui eles não importam nada de implementação. `react-loop.ts` continua
 * REEXPORTANDO todos eles, então os imports existentes (`core.ts`,
 * `turn-outcome.ts`, o coordenador e as specs) seguem valendo sem alteração.
 */
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import type { LLMMessage } from '@/lib/llm/types.js';

export type RunReActLoopParams = {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  jid: string;
  system: string;
  messages: LLMMessage[];
  tools: import('@/lib/llm/types.js').ToolSchema[];
  /**
   * [P88-C4] Optional announcement (e.g., "switching to suporte mode")
   * prepended to the final outbound text. null when policy.announce_mode
   * says no announcement should be emitted this turn. The model never sees
   * this text — it's a system-emitted prefix attached at dispatch time.
   */
  outboundPrefix?: string | null;
};

export type ReActLoopResult = {
  totalTokens: number;
  /** Final assistant text sent to the user (empty string when no end_turn produced text). */
  outboundText: string;
  /**
   * P3b Task 9: captured tool invocations across all iterations so the
   * post-turn step-evaluator can match tool_result success criteria.
   * Each entry has the tool name and the raw dispatcher output.
   */
  toolsCalled: Array<{ name: string; result: unknown }>;
  /**
   * Issue #503 — resultado DURÁVEL do turno, para que `core.ts` decida o
   * outcome da máquina de estados em vez de assumir "a função retornou, logo o
   * turno terminou". Antes desta issue o loop encerrava com texto vazio tanto
   * numa falha do reasoner quanto numa falha pre-send do outbound, e o caller
   * marcava tudo como processado — os cenários A e B da issue.
   */
  delivery: ReActDelivery;
};

export type ReActDelivery = {
  /** true quando o outbound foi efetivamente despachado ao usuário. */
  dispatched: boolean;
  /**
   * Por que o loop terminou sem despachar (ou, quando despachou, o motivo é
   * irrelevante e vale `empty_final_text`).
   *   reasoner_failed  — timeout/erro do LLM: NADA foi produzido, retry é seguro;
   *   outbound_failure — resposta produzida, envio falhou PRE-SEND: nada chegou
   *                      ao usuário, retry é seguro;
   *   empty_final_text — o modelo terminou sem texto: turno concluído sem resposta;
   *   iteration_cap    — teto de iterações com tools executadas: NÃO reexecutar
   *                      (efeitos colaterais já ocorreram).
   */
  exitReason: ReActExitReason;
  /**
   * Enviado ao usuário, mas a persistência do outbound falhou/ficou ambígua.
   * NUNCA reenviar: o outcome correto é `reply_delivery_unknown`.
   */
  persistUnknown: boolean;
  /**
   * Alguma tool com `side_effect` `write`/`communication` foi INVOCADA neste
   * turno. Quando true, um retry pode DUPLICAR o efeito (transação criada duas
   * vezes, mensagem enviada duas vezes), então o turno não pode voltar para a
   * fila — vai para dead letter com outcome `unsafe_to_retry` e exige decisão
   * humana. Conservador por construção: marca na invocação, não no sucesso.
   */
  sideEffectsCommitted: boolean;
};

export type ReActExitReason =
  | 'reasoner_failed'
  | 'outbound_failure'
  | 'empty_final_text'
  | 'iteration_cap'
  | 'claim_divergence_blocked'
  /**
   * T22 — as capacidades do run foram revogadas ANTES do envio. A resposta
   * existia e foi retida de propósito; não é ausência de resposta.
   */
  | 'egress_revoked'
  /**
   * U-P04.7a — o commit de outbound foi recusado porque um humano assumiu a
   * conversa.
   *
   * Separado de `outbound_failure` porque as duas pedem reações opostas.
   * `outbound_failure` é retentável: nada chegou ao usuário e o envio pode dar
   * certo na próxima. Aqui o envio NÃO vai dar certo na próxima — a conversa
   * está com um atendente, e o fence continuará recusando. Retentar é a
   * automação insistindo para voltar ao canal de onde foi tirada.
   */
  | 'human_control_blocked';
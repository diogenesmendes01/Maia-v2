/**
 * Issue #507 §Tools — a SEMÂNTICA DE CANCELAMENTO de cada ferramenta, e o que
 * o sistema tem o direito de dizer quando um cancelamento chega tarde.
 *
 * ─── O problema que este módulo resolve ─────────────────────────────────────
 *
 * A #504 fechou o LIMITE: o dispatcher recusa executar uma tool quando a
 * tentativa perdeu a posse do turno. Aquilo cobre o caso fácil — o sinal chegou
 * ANTES de o handler começar, então nada aconteceu e `turn_ownership_lost` é a
 * verdade inteira.
 *
 * O caso difícil é o outro: o sinal chega DEPOIS de o handler poder ter
 * produzido efeito. Aí `cancelled` é mentira. Não sabemos se a transação foi
 * criada, se o boleto foi cancelado, se a API externa recebeu a chamada. A
 * resposta honesta é "não sei" — e "não sei" precisa de um nome próprio no
 * vocabulário, senão ele colapsa em `cancelled` (que afirma ausência de efeito)
 * ou em `error` (que convida a um retry).
 *
 * Só que "não sei" não é a mesma coisa para toda ferramenta. Cancelar um
 * `query_balance` no meio não deixa nada para reconciliar; cancelar um
 * `register_transaction` deixa. A diferença não é derivável do código: é uma
 * DECLARAÇÃO de quem escreve a ferramenta. Por isso ela é obrigatória, e por
 * isso o registro recusa subir sem ela (`assertToolDefinitionsComplete`).
 *
 * ─── As quatro classes ──────────────────────────────────────────────────────
 *
 * São as da decisão do dono na #507, e o conjunto é FECHADO:
 *
 *   `abort_safe`        — cancelar não deixa efeito. Leituras, parses,
 *                         classificações, atos de fala. "Sem efeito" aqui
 *                         significa: nada que um humano precise reconciliar
 *                         depois. Uma linha append-only de auditoria ou uma
 *                         entrada de cache endereçada por hash de conteúdo
 *                         continuam sendo `abort_safe` — ninguém concilia um
 *                         cache; já uma linha de razão financeira, não.
 *
 *   `idempotent`        — o efeito PRÓPRIO da ferramenta converge: repetir com a
 *                         mesma entrada leva ao mesmo estado (upsert por chave
 *                         natural, cancelamento de algo já cancelado, escrita de
 *                         um campo). Um cancelamento tardio ainda produz
 *                         `effect_unknown` — o que muda é que a reconciliação é
 *                         barata: reexecutar sob a MESMA chave de idempotência.
 *
 *                         Atenção ao que esta classe NÃO significa: o
 *                         dispatcher dá chave de idempotência a TODA ferramenta,
 *                         então "tem chave" não distingue ninguém. O que
 *                         distingue é a convergência do efeito em si.
 *
 *   `non_interruptible` — uma vez iniciada, o resultado pode ficar incerto e não
 *                         há repetição segura nem compensação declarada.
 *                         Criações que geram linha nova, envios externos,
 *                         tickets. Reconciliação é humana.
 *
 *   `compensatable`     — pode ficar incerta, MAS existe uma compensação
 *                         explícita e nomeada (`compensated_by`), que é uma
 *                         ferramenta do próprio registro. Sem o nome, a classe
 *                         seria uma promessa vazia — por isso o validador exige
 *                         o par e recusa a declaração solta.
 *
 * ─── A regra que dá o nome ao módulo ────────────────────────────────────────
 *
 * `effect_unknown` NUNCA nasce `retryable`. Retry de um efeito que talvez tenha
 * acontecido é duplicata: a segunda transação, o segundo boleto, a segunda
 * mensagem. O que `effect_unknown` pede é RECONCILIAÇÃO — descobrir o que de
 * fato aconteceu — e o tipo de retorno de `classifyToolCancellation` torna isso
 * uma regra do compilador, não uma convenção: no ramo `effect_unknown`,
 * `retryable` é o literal `false` e não existe outro valor atribuível.
 *
 * ─── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 * Não fala com o banco, não emite métrica, não conhece o REGISTRY (importá-lo
 * seria ciclo — o registro é quem importa daqui). É uma folha: vocabulário,
 * matriz determinística e um validador que lança.
 */

/**
 * As quatro classes, na ordem "menos efeito → mais efeito". Conjunto FECHADO:
 * acrescentar um quinto valor é decisão de produto, e obriga a revisitar a
 * matriz de cancelamento abaixo (o `switch` exaustivo não compila sem isso).
 */
export const TOOL_EFFECT_CLASSES = [
  'abort_safe',
  'idempotent',
  'non_interruptible',
  'compensatable',
] as const;

export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[number];

/**
 * COMO se descobre o que aconteceu, quando não se sabe. É o campo que
 * transforma `effect_unknown` de lamento em tarefa: vai para a linha de
 * auditoria `tool_effect_unknown` e é o que um operador lê no runbook.
 *
 *   `replay_idempotency_key` — reexecutar sob a MESMA chave é seguro e
 *                              converge. Note que isso NÃO é o retry automático
 *                              que a issue proíbe: a reserva fica marcada
 *                              `failed`, então a repetição é uma decisão
 *                              deliberada, tomada por quem reconcilia.
 *   `compensate`             — existe uma ferramenta de compensação declarada
 *                              (`compensated_by`); a reconciliação é verificar
 *                              se o efeito existe e, existindo indevidamente,
 *                              compensá-lo.
 *   `manual_reconciliation`  — não há repetição segura nem compensação. Um
 *                              humano precisa olhar o sistema de destino.
 */
export const RECONCILIATION_STRATEGIES = [
  'replay_idempotency_key',
  'compensate',
  'manual_reconciliation',
] as const;

export type ReconciliationStrategy = (typeof RECONCILIATION_STRATEGIES)[number];

/**
 * O veredito de um cancelamento que chegou DEPOIS de o handler poder ter
 * produzido efeito.
 *
 * União discriminada de propósito: `retryable: true` só existe no ramo
 * `cancelled`, e `reconciliation` só existe no ramo `effect_unknown`. Um call
 * site não consegue escrever `{ outcome: 'effect_unknown', retryable: true }` —
 * o compilador recusa. É a invariante do dono expressa em tipo.
 */
export type ToolCancellationVerdict =
  | { outcome: 'cancelled'; retryable: true }
  | {
      outcome: 'effect_unknown';
      retryable: false;
      reconciliation: ReconciliationStrategy;
    };

function isEffectClass(v: unknown): v is ToolEffectClass {
  return typeof v === 'string' && (TOOL_EFFECT_CLASSES as readonly string[]).includes(v);
}

/**
 * A matriz determinística: classe declarada → o que o backend tem o direito de
 * afirmar quando o cancelamento chegou tarde demais para impedir o efeito.
 *
 * O caso `abort_safe` é o único que pode dizer "cancelado", e ele pode
 * PRECISAMENTE porque a classe é a declaração de que não há efeito a
 * reconciliar. Se essa declaração for falsa, o defeito está na declaração — que
 * é o ponto de ter uma.
 */
export function classifyToolCancellation(effect_class: ToolEffectClass): ToolCancellationVerdict {
  // DEFESA EM PROFUNDIDADE, e a direção importa. O registro recusa subir com
  // uma ferramenta sem classificação, então em produção este ramo é
  // inalcançável — mas o dispatcher também atende superfícies que não passam
  // pelo registro estático (mocks, injeção dinâmica, um catálogo futuro vindo
  // do banco). Se um valor fora do vocabulário chegar aqui, a resposta é a MAIS
  // conservadora que existe: não sei o que aconteceu, ninguém repete sozinho,
  // um humano reconcilia. Errar para o lado de `cancelled` seria afirmar
  // ausência de efeito sobre uma ferramenta da qual não se sabe nada.
  if (!isEffectClass(effect_class)) {
    return {
      outcome: 'effect_unknown',
      retryable: false,
      reconciliation: 'manual_reconciliation',
    };
  }
  switch (effect_class) {
    case 'abort_safe':
      return { outcome: 'cancelled', retryable: true };
    case 'idempotent':
      return {
        outcome: 'effect_unknown',
        retryable: false,
        reconciliation: 'replay_idempotency_key',
      };
    case 'compensatable':
      return { outcome: 'effect_unknown', retryable: false, reconciliation: 'compensate' };
    case 'non_interruptible':
      return {
        outcome: 'effect_unknown',
        retryable: false,
        reconciliation: 'manual_reconciliation',
      };
  }
}

/**
 * ORÇAMENTO MÍNIMO para SEQUER COMEÇAR uma ferramenta, em milissegundos de
 * prazo restante do turno.
 *
 * Duas parcelas, e a segunda é a que importa:
 *
 *   `TOOL_MIN_BUDGET_MS` — abaixo disso começar qualquer coisa é desperdício:
 *   o handler não termina e o turno paga a latência de um trabalho que será
 *   descartado.
 *
 *   `TOOL_EFFECT_RESERVE_MS` — a folga EXTRA que só ferramentas com efeito
 *   possível exigem. Não é para o handler: é para o que vem DEPOIS dele —
 *   completar a reserva de idempotência, gravar o outbox na mesma transação,
 *   auditar. Começar um efeito sem tempo de PERSISTIR o registro dele é
 *   fabricar `effect_unknown` de propósito, que é exatamente o estado caro que
 *   o resto deste módulo existe para evitar.
 *
 * Constantes de módulo, e não env vars, por uma razão de escopo: o orçamento
 * GLOBAL do turno (`TURN_DEADLINE_MS`, `TURN_MIN_STAGE_BUDGET_MS`,
 * `TURN_FALLBACK_RESERVE_MS`) é outra fatia da #507 e mora no contrato de
 * configuração. Quando ela chegar, estes valores viram o piso por estágio dela;
 * até lá, um número declarado aqui é melhor que nenhum número em lugar nenhum.
 */
export const TOOL_MIN_BUDGET_MS = 250;
export const TOOL_EFFECT_RESERVE_MS = 1_500;

/** Quanto prazo restante uma ferramenta desta classe exige para começar. */
export function minimumBudgetMs(effect_class: ToolEffectClass): number {
  return effect_class === 'abort_safe'
    ? TOOL_MIN_BUDGET_MS
    : TOOL_MIN_BUDGET_MS + TOOL_EFFECT_RESERVE_MS;
}

/**
 * A classe das ferramentas MCP (`mcp:<server>:<tool>`), que são dinâmicas (vêm
 * do banco) e por isso não podem declarar nada num arquivo do registro.
 *
 * `abort_safe` não é otimismo: `mcpServerToolsRepo.listExecutable` só devolve
 * tool APROVADA e READ-ONLY (fase v1 da #478), então o bridge estruturalmente
 * não consegue despachar uma escrita. Uma chamada HTTP de leitura abortada não
 * deixa nada para reconciliar.
 *
 * Quando a fase de ESCRITA do MCP chegar, esta constante deixa de valer para
 * todas as tools e a classe precisa passar a ser um campo por tool no catálogo
 * (`mcp_server_tools`), com a mesma recusa fail-closed do registro estático.
 * `tests/unit/tools/effect-class-registry.spec.ts` guarda essa condição.
 */
export const MCP_TOOL_EFFECT_CLASS: ToolEffectClass = 'abort_safe';

/** O erro que impede o processo de subir com um registro incompleto. */
export class ToolDefinitionError extends Error {
  readonly code = 'TOOL_DEFINITION_INCOMPLETE';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `registro de ferramentas RECUSADO — ${problems.length} definição(ões) incompleta(s) ou incoerente(s):\n` +
        problems.map((p) => `  · ${p}`).join('\n') +
        `\n\nToda ferramenta declara UMA classe de efeito (${TOOL_EFFECT_CLASSES.join(' | ')}). ` +
        `Sem ela o dispatcher não sabe se um cancelamento tardio pode ser chamado de 'cancelado' ` +
        `ou precisa virar 'effect_unknown', e a resposta padrão seria um palpite. ` +
        `Ver src/tools/effect-class.ts.`,
    );
    this.name = 'ToolDefinitionError';
    this.problems = problems;
  }
}

/**
 * A FORMA mínima que o validador precisa enxergar. Estrutural de propósito:
 * importar `AnyTool` de `_registry.ts` faria ciclo, já que é o registro quem
 * chama este validador.
 */
export type ClassifiableToolDefinition = {
  name: string;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  effect_class?: unknown;
  compensated_by?: unknown;
};

/**
 * O PORTÃO. Chamado no carregamento de `_registry.ts`: uma ferramenta sem
 * classificação (ou com uma classificação que contradiz o resto da própria
 * definição) DERRUBA o processo, não emite um aviso.
 *
 * Por que fatal e não lint: um lint roda quando alguém o roda. Este código roda
 * sempre que o processo sobe, inclusive no boot de produção, e é o que garante
 * que a décima primeira ferramenta — escrita daqui a um mês, por quem nunca
 * leu esta issue — não nasça sem classificação. O custo de errar para o outro
 * lado (subir com uma tool não classificada) é um cancelamento tardio
 * respondido com um palpite.
 *
 * As quatro perguntas, e por que cada uma:
 *
 *   1. A classe existe e pertence ao conjunto fechado. O caso base.
 *   2. `side_effect: 'write'` não pode ser `abort_safe`. A definição já
 *      DECLAROU que muta estado de negócio; dizer em seguida que cancelá-la não
 *      deixa efeito é uma contradição interna, e é o erro mais fácil de cometer
 *      copiando a definição de uma leitura.
 *   3. `compensatable` exige `compensated_by` apontando para uma ferramenta que
 *      EXISTE no registro. Compensação sem compensador é dívida declarada.
 *   4. Quem não é `compensatable` não declara `compensated_by`. Um campo que
 *      ninguém lê envelhece mentindo.
 */
export function assertToolDefinitionsComplete(
  tools: readonly ClassifiableToolDefinition[],
  knownToolNames: ReadonlySet<string>,
): void {
  const problems: string[] = [];

  for (const tool of tools) {
    const name = typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : '<sem nome>';
    const cls = tool.effect_class;

    if (!isEffectClass(cls)) {
      problems.push(
        cls === undefined
          ? `${name}: não declara \`effect_class\``
          : `${name}: \`effect_class\` inválida (${JSON.stringify(cls)})`,
      );
      continue;
    }

    if (tool.side_effect === 'write' && cls === 'abort_safe') {
      problems.push(
        `${name}: declara \`side_effect: 'write'\` e \`effect_class: 'abort_safe'\` ao mesmo tempo — ` +
          `uma mutação de negócio não pode ser cancelada sem efeito`,
      );
    }

    if (cls === 'compensatable') {
      if (typeof tool.compensated_by !== 'string' || tool.compensated_by.length === 0) {
        problems.push(
          `${name}: \`effect_class: 'compensatable'\` sem \`compensated_by\` — ` +
            `compensação sem compensador declarado`,
        );
      } else if (!knownToolNames.has(tool.compensated_by)) {
        problems.push(
          `${name}: \`compensated_by: '${tool.compensated_by}'\` não é uma ferramenta do registro`,
        );
      }
    } else if (tool.compensated_by !== undefined) {
      problems.push(
        `${name}: declara \`compensated_by\` sem ser \`compensatable\` (classe: ${cls})`,
      );
    }
  }

  if (problems.length > 0) throw new ToolDefinitionError(problems);
}

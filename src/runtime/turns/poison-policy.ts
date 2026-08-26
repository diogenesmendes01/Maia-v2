/**
 * Issue #629 (fatia F da #505) — a POLÍTICA DE POISON/DLQ, num módulo PURO.
 *
 * ─── A frase da issue-mãe que este arquivo torna executável ───────────────
 *
 * "Ao exceder tentativas, a política escolhe **conscientemente** entre
 * `dead_letter` terminal, que **libera** o próximo turno, ou **stream
 * bloqueada** para intervenção, em casos de efeito ou governança críticos.
 * Configurável **por categoria de erro** e **auditada**. As duas opções são
 * defensáveis e incompatíveis: liberar preserva disponibilidade às custas da
 * semântica; bloquear preserva a semântica às custas da conversa. Deixar isso
 * implícito é a falha #5 da issue-mãe."
 *
 * Até esta fatia só a primeira saída existia — e existia por OMISSÃO, que é a
 * pior forma de uma política existir. `dead_letter` é terminal (#503); um turno
 * terminal sai do predicado de head-of-line (#626); logo o sucessor vira
 * reivindicável. Ninguém decidiu isso; foi um efeito colateral da máquina de
 * estados. Este módulo transforma o efeito colateral numa DECLARAÇÃO.
 *
 * ─── Por que PURO (a mesma razão de `claim.ts` e `stream-head-sql.ts`) ────
 *
 * Sem `db`, sem ALS, sem `@/config/env.js`, sem `@/lib/metrics.js`. A
 * classificação é uma função total de `(código, outcome) -> categoria` e a
 * disposição é uma função total de `(categoria, conjunto configurado) ->
 * saída`. As duas são testáveis sem Postgres, sem Redis e sem boot — e, mais
 * importante, o CONJUNTO configurado entra como PARÂMETRO. Ler a env aqui
 * dentro faria todo teste de política precisar mexer em `process.env`, e a
 * pergunta "o que a política decide para esta categoria?" viraria "o que o
 * ambiente do processo de teste tinha configurado?".
 *
 * Quem lê a configuração é `src/runtime/turns/lifecycle.ts` (`deadLetterTurn`),
 * onde `contractEnv` já mora. Quem executa o bloqueio é o repositório, na MESMA
 * transação do CAS terminal.
 */

/**
 * As CATEGORIAS de erro sobre as quais a política é configurável.
 *
 * Cardinalidade FECHADA porque isto vira label de
 * `maia_stream_poison_total{category,disposition}` — e `last_error_code`, que é
 * `[a-z0-9_]{1,64}` livre (`normalizeTurnErrorCode`), não pode virar label:
 * cada tool nova, cada exceção de provedor e cada `unknown_error` de um caminho
 * não previsto criaria uma série, e a cardinalidade cresceria com o CÓDIGO da
 * plataforma em vez de com a operação dela.
 *
 * A régua para uma categoria existir é operacional, não taxonômica: duas causas
 * pertencem a categorias diferentes quando a resposta à pergunta *"esta conversa
 * pode continuar sem este turno?"* é diferente.
 *
 *  - `effect_committed` — uma tool com efeito externo IRREVERSÍVEL já rodou e o
 *    turno falhou depois. É a única categoria em que continuar é
 *    semanticamente errado por construção: a plataforma responderia M2 tendo
 *    executado metade de M1 no mundo real, sem ninguém saber qual metade;
 *  - `model` — o LLM expirou, recusou, ou devolveu algo que não parseia. Nada
 *    aconteceu fora da plataforma. Continuar perde uma resposta, não a
 *    consistência;
 *  - `transport` — a resposta estava pronta e o ENVIO falhou. Também não mudou
 *    o mundo (o pre-send é o que #506 protege), e a conversa continuar é o
 *    comportamento que o usuário espera;
 *  - `infrastructure` — banco, Redis, fila, lease. A causa é compartilhada e
 *    quase nunca é DESTE turno; bloquear a conversa por ela puniria o usuário
 *    por um incidente de plataforma;
 *  - `operator` — um humano cancelou. Ele já decidiu; a política não tem o que
 *    acrescentar;
 *  - `unknown` — não classificado. Deliberadamente uma categoria PRÓPRIA e não
 *    um apelido de `infrastructure`: um código que ninguém previu é exatamente
 *    o caso em que o operador pode querer parar para olhar, e colapsá-lo numa
 *    categoria "benigna" tiraria dele a escolha.
 */
export const POISON_CATEGORIES = [
  'effect_committed',
  'model',
  'transport',
  'infrastructure',
  'operator',
  'unknown',
] as const;

export type PoisonCategory = (typeof POISON_CATEGORIES)[number];

/**
 * As duas SAÍDAS, e elas são o vocabulário da decisão — não do efeito.
 *
 *  - `release` — `dead_letter` terminal, e a stream anda. É o comportamento da
 *    #627, agora nomeado;
 *  - `block_stream` — `dead_letter` terminal E um bloqueio ATIVO em
 *    `agent_stream_blocks` (migration 133). Todo claim da conversa passa a ser
 *    recusado com `stream_poisoned` até um operador desbloquear.
 *
 * Note o que `block_stream` NÃO é: não é um estado novo do turno. O turno vai
 * para `dead_letter` nos dois casos, e isso é deliberado — a pergunta "este
 * turno acabou?" e a pergunta "esta conversa pode continuar?" são diferentes, e
 * tê-las no mesmo campo é como se perde uma das duas.
 */
export const POISON_DISPOSITIONS = ['release', 'block_stream'] as const;

export type PoisonDisposition = (typeof POISON_DISPOSITIONS)[number];

/**
 * POR QUE uma stream está bloqueada. Vocabulário fechado, espelhado na coluna
 * `agent_stream_blocks.reason` (migration 133).
 *
 * Hoje há um só valor. A coluna existe mesmo assim porque um segundo motivo de
 * bloqueio (governança, quarentena de tenant) é previsível, e acrescentá-lo
 * depois numa tabela sem o campo custaria uma migration numa tabela que a essa
 * altura já tem histórico.
 */
export const STREAM_BLOCK_REASONS = ['poison'] as const;

export type StreamBlockReason = (typeof STREAM_BLOCK_REASONS)[number];

/**
 * O DEFAULT da configuração: só `effect_committed` bloqueia.
 *
 * ─── Por que não "nenhuma" (que seria o default inerte) ──────────────────
 *
 * Um default vazio preservaria exatamente o comportamento da #627 e não
 * mudaria nada em nenhum deploy — o que soa prudente e é, na verdade, a falha
 * nº 5 da issue-mãe entregue com outro nome. A política existiria como código
 * que ninguém executa, e a escolha continuaria implícita: quem não configurasse
 * nada continuaria liberando a stream depois de um efeito irreversível ter
 * ficado pela metade, sem nunca ter decidido isso.
 *
 * ─── Por que não mais do que `effect_committed` ──────────────────────────
 *
 * Porque bloquear PARA a conversa, e o preço tem de ser proporcional. Em
 * `model`, `transport` e `infrastructure` a causa é compartilhada e transitória:
 * um incidente de LLM ou de rede que produzisse bloqueio bloquearia MILHARES de
 * conversas ao mesmo tempo, e o desbloqueio seria manual, uma a uma. Isso não é
 * "preservar a semântica" — é transformar uma degradação em parada, com um
 * trabalho de recuperação que cresce com o tráfego.
 *
 * `effect_committed` é a única em que a conversa já está semanticamente
 * quebrada ANTES de a política decidir: uma tool irreversível rodou, o turno
 * falhou depois, e ninguém — nem o usuário, nem o operador — sabe o que ficou
 * aplicado. Responder a próxima mensagem por cima disso é a inversão que a #505
 * existe para impedir, agravada por um efeito real no mundo.
 *
 * `unknown` fica de FORA do default, e é a decisão mais contestável deste
 * arquivo. O argumento a favor de incluí-la: um código não classificado é
 * justamente o que ninguém analisou. O argumento que venceu: `unknown` é o
 * destino de todo código novo (uma tool nova, um erro de provedor novo), então
 * incluí-la faria a política bloquear conversas por causa de uma OMISSÃO da
 * tabela de classificação — e o sintoma seria conversas paradas depois de um
 * deploy que não mexeu na política. Um operador que prefira o outro lado
 * escreve `TURN_POISON_BLOCK_CATEGORIES=effect_committed,unknown`.
 */
export const DEFAULT_POISON_BLOCK_CATEGORIES: readonly PoisonCategory[] = ['effect_committed'];

/**
 * Prefixos e códigos exatos que mapeiam para cada categoria.
 *
 * A ordem da tabela é a ordem de avaliação, e o primeiro casamento vence.
 * Prefixo, e não regex, de propósito: `normalizeTurnErrorCode` já reduziu o
 * código a `[a-z0-9_]{1,64}`, então prefixo é suficiente e é o que mantém a
 * tabela legível por quem opera — uma regex aqui seria uma segunda linguagem
 * dentro de uma política que precisa ser óbvia às três da manhã.
 */
const CLASSIFICACAO: ReadonlyArray<{ categoria: PoisonCategory; prefixos: readonly string[] }> = [
  {
    categoria: 'effect_committed',
    prefixos: ['side_effect', 'effect_committed', 'unsafe_to_retry', 'irreversible'],
  },
  {
    categoria: 'model',
    prefixos: [
      'reasoner_failed',
      'llm_',
      'model_',
      'anthropic_',
      'empty_final_text',
      'iteration_cap',
      'prompt_',
    ],
  },
  {
    categoria: 'transport',
    prefixos: ['outbound_', 'send_', 'delivery_', 'baileys_', 'whatsapp_'],
  },
  {
    categoria: 'infrastructure',
    prefixos: [
      'db_',
      'database_',
      'postgres_',
      'redis_',
      'queue_',
      'lease_',
      'stale_claim',
      'timeout',
      'econn',
      'network_',
    ],
  },
  { categoria: 'operator', prefixos: ['operator_', 'cancelled_by_operator'] },
];

/**
 * Classifica o turno envenenado numa categoria. Função TOTAL: todo código cai
 * em exatamente uma, e o fundo do poço é `unknown`.
 *
 * ─── Por que o `outcome` DOMINA o código ─────────────────────────────────
 *
 * `unsafe_to_retry` é produzido por `decideTurnAction`
 * (`src/agent/turn-outcome.ts:56`) exatamente quando
 * `delivery.sideEffectsCommitted` é verdade — isto é, a plataforma JÁ SABE que
 * uma tool irreversível rodou, e sabe por um fato durável, não por heurística
 * sobre o texto de um código de erro. O código que acompanha, nesse caminho, é
 * o motivo da SAÍDA do ReAct (`reasoner_failed`, `outbound_failure`), que
 * classificaria como `model` ou `transport` e apagaria a única informação que
 * importa para a decisão.
 *
 * Por isso a precedência: o outcome é evidência de primeira ordem; o código é
 * inferência. Inverter a ordem faria a política decidir pelo sintoma tendo a
 * causa em mãos.
 *
 * `operator_cancelled` domina pela mesma régua e pelo motivo oposto: um humano
 * já decidiu o destino deste turno, e a política não tem o que acrescentar.
 */
export function classifyPoison(input: {
  error_code: string | null | undefined;
  outcome?: 'retry_exhausted' | 'operator_cancelled' | 'unsafe_to_retry' | null;
}): PoisonCategory {
  if (input.outcome === 'unsafe_to_retry') return 'effect_committed';
  if (input.outcome === 'operator_cancelled') return 'operator';

  const code = typeof input.error_code === 'string' ? input.error_code.trim().toLowerCase() : '';
  if (code.length === 0) return 'unknown';
  for (const { categoria, prefixos } of CLASSIFICACAO) {
    for (const prefixo of prefixos) {
      if (code === prefixo || code.startsWith(prefixo)) return categoria;
    }
  }
  return 'unknown';
}

/**
 * A DECISÃO: liberar a stream ou bloqueá-la.
 *
 * O conjunto entra como parâmetro (ver o cabeçalho). `block_stream` só quando a
 * categoria está declarada — nunca por default de código, nunca por inferência
 * sobre a gravidade aparente do erro.
 */
export function poisonDisposition(
  category: PoisonCategory,
  blockCategories: ReadonlySet<PoisonCategory>,
): PoisonDisposition {
  return blockCategories.has(category) ? 'block_stream' : 'release';
}

/**
 * Lê a configuração (`TURN_POISON_BLOCK_CATEGORIES`) para um conjunto tipado.
 *
 * ─── Por que categoria desconhecida LANÇA, e não é ignorada ──────────────
 *
 * Um valor com erro de digitação — `effect_commited`, `governance` — silenciado
 * produziria a pior falha possível desta fatia: o operador acredita ter ligado
 * o bloqueio, o dashboard não mostra bloqueio nenhum porque não há bloqueio
 * nenhum, e a conclusão natural é "não aconteceu nenhum caso" em vez de "a
 * política está desligada". Isso é indistinguível de sucesso, que é a forma de
 * falha que esta leva inteira existe para eliminar.
 *
 * Lançar aqui faz o boot reprovar com o nome da categoria inválida. É
 * fail-closed no sentido correto: a plataforma não sobe com uma política que
 * ela não consegue executar.
 *
 * Lista VAZIA é válida e é o KILL SWITCH da fatia: nenhuma categoria bloqueia,
 * e a conclusão volta a ser a da #627. Explícito, e portanto diferente de um
 * erro de digitação.
 */
export function parsePoisonBlockCategories(raw: string | null | undefined): Set<PoisonCategory> {
  const set = new Set<PoisonCategory>();
  if (typeof raw !== 'string') return set;
  for (const parte of raw.split(',')) {
    const nome = parte.trim().toLowerCase();
    if (nome.length === 0) continue;
    if (!(POISON_CATEGORIES as readonly string[]).includes(nome)) {
      throw new Error(
        `TURN_POISON_BLOCK_CATEGORIES: categoria '${nome}' não existe. ` +
          `Válidas: ${POISON_CATEGORIES.join(', ')}. Uma categoria desconhecida seria ` +
          `SILENCIOSAMENTE ignorada e o operador acreditaria ter ligado o bloqueio — ` +
          `por isso a leitura falha fechada em vez de descartar o valor.`,
      );
    }
    set.add(nome as PoisonCategory);
  }
  return set;
}

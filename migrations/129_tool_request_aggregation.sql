-- 129 — N pedidos de ferramenta parecidos viram UM pedido com contador
-- (issue #637, fatia B da épica #471).
--
-- O QUE ISSO FECHA
--   A fatia A (#636) faz cada gap recorrente de tool virar UMA proposta
--   `capability_type='tool_request'`. Nada nela sabe que dois gaps diferentes
--   podem ser o MESMO pedido dito com outras palavras. O resultado seria um
--   backlog de duplicatas em que nenhum item carrega o peso da demanda real:
--   cinco pedidos de 2 ocorrências cada, em vez de um pedido de 10.
--
--   Esta migração cria as duas tabelas do AGRUPAMENTO — e o desenho delas é a
--   resposta a "fusão é reversível ou auditável?".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A FUSÃO NUNCA APAGA A EVIDÊNCIA. TRÊS CAMADAS.
-- ─────────────────────────────────────────────────────────────────────────────
--   1. A fusão só ESCREVE em tabelas NOVAS. `capability_proposals`,
--      `agent_capability_gaps` e `agent_capability_gap_observations` não são
--      alteradas nem apagadas por agrupamento nenhum — nem uma coluna. Um
--      agrupamento errado é um erro em cima do dado, nunca no lugar dele.
--   2. Cada membro guarda o SPEC ORIGINAL inteiro (`original_spec`), com as
--      situações, os links de trace e o rascunho de contrato como ele entrou.
--      Isso importa porque um pedido que ENTRA num agregado existente NÃO gera
--      linha em `capability_proposals` (é esse o "N vira 1"): sem este
--      snapshot, o segundo pedido não teria onde existir.
--   3. Sair do agregado é `detached_at`, nunca `DELETE`. A linha continua, com
--      motivo e autor. Recontar depois de um destaque é reler as linhas ativas.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ESCOPO: POR TENANT + AGENT, SEM CONTADOR GLOBAL
-- ─────────────────────────────────────────────────────────────────────────────
--   As duas tabelas têm `tenant_id` + `agent_id` NOT NULL com FK, o CHECK
--   fail-closed contra o literal 'default' (invariante #8 do AGENTS.md) e
--   índices cujo PREFIXO é (tenant_id, agent_id) — a busca por candidato à
--   fusão não tem como sair do escopo por acidente de plano de execução.
--
--   Um contador GLOBAL ("quantos clientes pediram esta ferramenta?") seria útil
--   para priorizar roadmap e está deliberadamente FORA. Ele exigiria comparar o
--   texto do pedido de um cliente com o de outro, e a similaridade seria
--   calculada SOBRE os dois textos — isto é, o dado de A entrando no cálculo
--   que produz a linha de B. Isso é exatamente o que a invariante #1 proíbe, e
--   "só o número atravessa" não salva: um contador global é reconstruível
--   quando a contagem é pequena. O caminho legítimo para isso é agregação
--   estatística deliberada com anonimização, com ADR próprio, e não um efeito
--   colateral de agrupar pedidos.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- O LIMIAR E A MÉTRICA MORAM NA LINHA
-- ─────────────────────────────────────────────────────────────────────────────
--   `metrica`, `limiar` e `assinatura_version` são gravados em cada agregado E
--   em cada membro. Um agrupamento é uma decisão automática sobre dado de
--   governança; sem o número que a justificou e a versão da assinatura que a
--   produziu, ninguém consegue dizer depois se a fusão era certa sob a regra
--   vigente na época. Também é o que torna re-medir o limiar uma migração de
--   dados possível (reagrupar só o que foi feito sob a versão antiga) em vez de
--   uma reinterpretação silenciosa do passado.
--
-- POR QUE SEM `maia:no-transaction`
--   As duas tabelas nascem vazias e não há DDL sobre tabela quente. Nenhum
--   `CREATE INDEX CONCURRENTLY` aqui, portanto nada do que a issue #658 alerta
--   (índice inválido não detectado pelo runner) se aplica: todos os índices
--   abaixo nascem dentro da transação e válidos, ou a migração inteira falha.
--
-- POR QUE NENHUMA COLUNA `vector` E NENHUM ÍNDICE ivfflat/hnsw
--   A decisão está fundamentada em `src/cognition/tool-request/similarity.ts`.
--   Em resumo: a similaridade desta fatia é determinística e local (Dice sobre
--   tokens de conteúdo), porque um limiar de cosseno dependeria de uma API paga
--   externa que o CI não tem — logo não seria calibrável nem retestável. Uma
--   coluna `vector` que ninguém popula é dívida com cara de recurso, e um
--   índice ivfflat sobre dezenas de linhas por tenant é mais lento que a
--   varredura sequencial. Quando houver sinal semântico calibrado, ele entra
--   como `assinatura_version` nova, com re-medição — que é o motivo de a versão
--   estar persistida.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · O agregado: UM pedido, com contador
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tool_request_aggregates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),

  -- Os tokens de conteúdo do pedido REPRESENTANTE, únicos e ordenados. É a
  -- chave de comparação, e é TEXTO LEGÍVEL de propósito: quem lê a linha vê
  -- exatamente o que foi comparado, sem precisar rodar código.
  assinatura TEXT NOT NULL,
  assinatura_version INTEGER NOT NULL,
  metrica TEXT NOT NULL,
  -- Em [0,1]. NUMERIC, e não float, porque este número é reproduzido em
  -- relatório e comparado com o da época; ruído binário aqui viraria "o limiar
  -- mudou sozinho".
  limiar NUMERIC(5,4) NOT NULL CHECK (limiar >= 0 AND limiar <= 1),

  -- A proposta que REPRESENTA o agregado. É a única linha de
  -- `capability_proposals` do grupo: os pedidos que entram depois viram membro,
  -- não proposta. É esse o "N vira 1".
  representative_proposal_id UUID NOT NULL REFERENCES capability_proposals(id),
  representative_gap_id UUID NOT NULL REFERENCES agent_capability_gaps(id),

  proposed_tool_name TEXT NOT NULL,
  -- Todos os nomes que os membros propuseram para a MESMA ferramenta. O
  -- representante não apaga os outros; eles são pista de vocabulário para o dev.
  nomes_propostos JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- O CONTADOR. Membros ATIVOS (não destacados). Materializado para a listagem
  -- da triagem; a fonte da verdade continua sendo `count(*)` sobre os membros
  -- ativos, e o repositório o RECALCULA a cada escrita em vez de incrementar —
  -- um contador incrementado diverge em silêncio, um recalculado não.
  member_count INTEGER NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  -- Soma das ocorrências dos membros ativos. "Cinco pedidos" e "dez ocorrências"
  -- são fatos diferentes e os dois interessam a quem prioriza.
  total_occurrences INTEGER NOT NULL DEFAULT 0 CHECK (total_occurrences >= 0),

  -- A POLÍTICA DE FUSÃO DE RASCUNHOS, materializada. Ver
  -- `src/cognition/tool-request/draft-merge.ts`.
  --   single ..... um pedido; o contrato é o dele.
  --   consistent . N pedidos sem conflito; o contrato é a UNIÃO.
  --   divergent .. N pedidos com conflito; NÃO HÁ contrato fundido.
  contract_state TEXT NOT NULL
    CHECK (contract_state IN ('single', 'consistent', 'divergent')),
  merged_contract_draft JSONB,
  contract_conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,

  first_member_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_member_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tool_request_aggregates_no_default_literal
    CHECK (tenant_id <> 'default' AND agent_id <> 'default'),

  -- A metade NÃO-CONTORNÁVEL da política de fusão: `divergent` e "sem rascunho
  -- fundido" são a MESMA coisa, e o banco recusa qualquer linha que separe as
  -- duas. Sem este CHECK, um bug poderia gravar `divergent` com um rascunho
  -- pendurado — e um leitor que só olhasse o rascunho mostraria ao dev uma spec
  -- que a política declarou indefinida. É a mesma disciplina da marcação de
  -- rascunho da migração 125: a defesa vale para QUALQUER escritor, inclusive
  -- um psql.
  CONSTRAINT tool_request_aggregates_divergent_has_no_draft
    CHECK ((contract_state = 'divergent') = (merged_contract_draft IS NULL)),

  -- O rascunho fundido, quando existe, carrega o MESMO marcador de rascunho da
  -- fatia A no `zod_source` — a terceira camada da marcação (a que sobrevive ao
  -- copiar-e-colar do trecho para fora do JSON). Agregar não é o caminho por
  -- onde um contrato vigente entra: um rascunho fundido sem o marcador seria
  -- exatamente o texto que alguém confundiria com contrato instalado.
  --
  -- `IS TRUE`, e NÃO um `LIKE` solto. A diferença aqui é o CHECK inteiro, pela
  -- mesma armadilha que a 125 documenta: um CHECK só recusa quando a expressão
  -- dá FALSE, e NULL PASSA. Com a chave `zod_source` AUSENTE,
  -- `merged_contract_draft->>'zod_source'` vale NULL, `NULL LIKE '…'` vale
  -- NULL, e o CHECK aceitaria a linha — exatamente o caso que ele existe para
  -- barrar (rascunho fundido SEM marcação nenhuma). `IS TRUE` transforma NULL
  -- em FALSE, e a recusa acontece.
  --
  -- (Escrito primeiro com `IS NOT DISTINCT FROM FALSE`, que é a forma da 125
  -- mas com a polaridade invertida: ela dava FALSE para a chave ausente, o
  -- `NOT` a transformava em TRUE, e a linha sem marcação entrava. Pego por uma
  -- sonda de `psql` — não confie na leitura, confie no vermelho.)
  CONSTRAINT tool_request_aggregates_draft_marking
    CHECK (
      merged_contract_draft IS NULL
      OR (merged_contract_draft->>'zod_source'
            LIKE '// PROPOSTA — NÃO É CONTRATO VIGENTE.%') IS TRUE
    ),

  -- Uma proposta representa NO MÁXIMO um agregado.
  CONSTRAINT tool_request_aggregates_representative_unique
    UNIQUE (tenant_id, agent_id, representative_proposal_id)
);

-- A leitura quente da triagem (#638): "os pedidos mais demandados DESTE
-- agente, do maior contador para o menor". Prefixo (tenant_id, agent_id) —
-- não há plano que atravesse escopo.
CREATE INDEX tool_request_aggregates_scope_demand_idx
  ON tool_request_aggregates(tenant_id, agent_id, member_count DESC, last_member_at DESC);

-- A varredura de candidatos à fusão: só agregados da MESMA versão de
-- assinatura entram na comparação (uma assinatura de outra versão foi produzida
-- por outra regra e não é comparável com esta).
CREATE INDEX tool_request_aggregates_scope_signature_idx
  ON tool_request_aggregates(tenant_id, agent_id, assinatura_version);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Os membros: o ledger append-only do agrupamento
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tool_request_aggregate_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  aggregate_id UUID NOT NULL REFERENCES tool_request_aggregates(id) ON DELETE CASCADE,
  gap_id UUID NOT NULL REFERENCES agent_capability_gaps(id) ON DELETE CASCADE,

  -- NULO para todo membro que NÃO é o representante: ele não gerou linha em
  -- `capability_proposals`, e é justamente isso que faz N pedidos virarem 1.
  -- A evidência dele não se perde: está em `original_spec`, aqui do lado.
  proposal_id UUID REFERENCES capability_proposals(id),
  is_representative BOOLEAN NOT NULL DEFAULT false,

  -- Como este membro entrou: contra QUEM foi comparado, com que número, sob
  -- que métrica e que limiar. Um agrupamento sem isso é um fato sem prova.
  assinatura TEXT NOT NULL,
  assinatura_version INTEGER NOT NULL,
  metrica TEXT NOT NULL,
  limiar NUMERIC(5,4) NOT NULL CHECK (limiar >= 0 AND limiar <= 1),
  similaridade NUMERIC(5,4) NOT NULL CHECK (similaridade >= 0 AND similaridade <= 1),

  intent TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0 CHECK (occurrences >= 0),

  -- A EVIDÊNCIA PRESERVADA: o `proposed_spec` INTEIRO do pedido, como ele
  -- entrou — intenção, situações com link de trace, janela de frequência e o
  -- rascunho de contrato original. Nada da fusão o reescreve.
  original_spec JSONB NOT NULL,

  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- REVERSIBILIDADE. Desfazer um agrupamento é marcar aqui, nunca apagar.
  detached_at TIMESTAMPTZ,
  detached_reason TEXT,
  detached_by TEXT,

  CONSTRAINT tool_request_aggregate_members_no_default_literal
    CHECK (tenant_id <> 'default' AND agent_id <> 'default'),

  -- A marcação de rascunho da 125, replicada para o spec guardado aqui. Um
  -- membro cujo spec perdesse a marcação seria a porta de fundo para um
  -- "contrato vigente" entrar pelo caminho da agregação.
  CONSTRAINT tool_request_aggregate_members_draft_marking
    CHECK (
      original_spec->>'spec_kind' IS NOT DISTINCT FROM 'tool_request'
      AND original_spec->>'contract_status'
            IS NOT DISTINCT FROM 'draft_proposal_not_in_force'
    ),

  -- Um destaque tem de dizer por quê. `detached_at` sem motivo é um
  -- agrupamento desfeito por ninguém, sem razão registrada — o oposto de
  -- auditável.
  CONSTRAINT tool_request_aggregate_members_detach_needs_reason
    CHECK ((detached_at IS NULL) = (detached_reason IS NULL)),

  -- Um gap entra NO MÁXIMO uma vez em cada agregado. Rodar o worker duas vezes
  -- sobre o mesmo gap não infla o contador.
  CONSTRAINT tool_request_aggregate_members_gap_unique
    UNIQUE (tenant_id, agent_id, aggregate_id, gap_id)
);

-- Os membros ATIVOS de um agregado: a fonte da verdade do contador e a entrada
-- da refusão de rascunhos. Parcial — membro destacado não entra na conta.
CREATE INDEX tool_request_aggregate_members_ativos_idx
  ON tool_request_aggregate_members(tenant_id, agent_id, aggregate_id, joined_at)
  WHERE detached_at IS NULL;

-- "Este gap já pertence a algum agregado — ou já foi DESTACADO de um?" A
-- segunda pergunta é a que impede um destaque de ser desfeito sozinho pelo
-- worker na próxima rodada.
CREATE INDEX tool_request_aggregate_members_gap_idx
  ON tool_request_aggregate_members(tenant_id, agent_id, gap_id);

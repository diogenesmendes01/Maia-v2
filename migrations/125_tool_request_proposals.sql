-- 125 — "pedido de ferramenta": o gap recorrente que exige uma tool INEXISTENTE
-- vira uma proposta ESTRUTURADA e INERTE (issue #636, fatia A da épica #471).
--
-- O QUE ISSO FECHA
--   Hoje um gap recorrente sobe pela cadeia determinística de escalada
--   (`src/cognition/gap-escalation/engine.ts`: silent → dashboard →
--   mentionable → proposed) e, no topo, ou vira uma spec genérica escrita pelo
--   LLM (`capability-proposer.ts`) ou morre no dashboard. Em nenhum dos dois
--   caminhos um dev recebe o que precisaria para decidir: o que o agente
--   queria fazer, EM QUE situações reais (com link para o trace), quantas vezes
--   e em que janela, e qual seria o contrato Zod da tool que falta.
--
--   Esta migração cria as duas peças de dados que faltavam para isso:
--
--   1. `agent_capability_gap_observations` — o LEDGER de ocorrências do gap.
--      `agent_capability_gaps.frequency_score` é um CONTADOR: sabe "quantas
--      vezes", mas não sabe "em que janela" nem "em quais turnos". Frequência
--      com janela e situação com link para trace são requisitos do pedido de
--      ferramenta, e um contador não os responde. Uma linha por ocorrência
--      responde os três.
--
--   2. `capability_type = 'tool_request'` em `capability_proposals` — o tipo
--      novo de proposta, reusando a tabela, o escopo (tenant_id/agent_id NOT
--      NULL) e a máquina de estados que já existem, em vez de abrir um
--      vocabulário paralelo de proposta.
--
-- O GUARDRAIL, NO BANCO
--   "O agente especifica; humano implementa e instala." Uma proposta de
--   ferramenta é um DOCUMENTO INERTE: nada nela registra tool, executa código
--   ou cria capability. O rascunho de contrato Zod que ela carrega é um
--   RASCUNHO — e precisa ser impossível confundi-lo com o contrato vigente de
--   uma tool instalada.
--
--   O CHECK `capability_proposals_tool_request_marking_check` abaixo é a metade
--   NÃO-CONTORNÁVEL dessa marcação: uma linha `tool_request` só entra se o
--   `proposed_spec` se declarar `spec_kind='tool_request'` E
--   `contract_status='draft_proposal_not_in_force'`. Tirar a marcação do código
--   não produz uma proposta mal-marcada: produz um INSERT recusado pelo banco.
--   A outra metade (o Zod que valida o corpo inteiro do spec) vive em
--   `src/cognition/tool-request/types.ts`; as duas defesas são independentes de
--   propósito — a do banco vale para QUALQUER escritor, inclusive um psql.
--
-- POR QUE SEM `maia:no-transaction` (ao contrário da 115/117)
--   As duas tabelas envolvidas são FRIAS. `capability_proposals` ganha uma
--   linha por gap que chega a `proposed` (ordem de grandeza: dezenas por
--   tenant, no ano), e a nova tabela nasce vazia. O ACCESS EXCLUSIVE do
--   `DROP`/`ADD CONSTRAINT` retido até o fim da transação não bloqueia nenhum
--   caminho síncrono de turno, e a varredura de validação é sobre um punhado de
--   linhas. Trocar atomicidade por concorrência aqui só compraria risco: se
--   algo falhar no meio, ninguém quer a tabela com o CHECK antigo derrubado e
--   o novo ausente. `migrate.ts` envolve o arquivo em transação.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · O ledger de ocorrências do gap
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `root_trace_id`/`trace_id` NÃO têm FK para `runtime_trace_envelopes`, e isso é
-- deliberado: o envelope de trace é sujeito a retenção (`retention_runs`,
-- migração 102) e some antes da observação. Com FK, ou a purga de traces
-- passaria a apagar evidência de gap em cascata, ou a retenção quebraria por
-- violação de FK — as duas piores que um link pendurado. A integridade que
-- IMPORTA é de leitura, e é onde ela é feita: o resolvedor
-- (`src/db/repositories/capability-repos.ts`) só devolve a situação como
-- "trace resolvido" quando o envelope existe NO MESMO tenant+agent. Um id que
-- aponta para fora do escopo não vira link — vira situação sem link.
CREATE TABLE agent_capability_gap_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  gap_id UUID NOT NULL REFERENCES agent_capability_gaps(id) ON DELETE CASCADE,
  -- O que o agente queria fazer, nas palavras em que a ocorrência foi
  -- registrada. É a "intenção" que o pedido de ferramenta carrega.
  intent TEXT NOT NULL,
  -- Detalhe da situação (o `contexto` do gap naquela ocorrência), quando houver.
  detail TEXT,
  conversa_id UUID,
  root_trace_id UUID,
  trace_id UUID,
  -- Argumentos que o agente TENTOU usar, quando o call site os conhece. É a
  -- evidência de onde os `inputs` do rascunho de contrato são DERIVADOS — nunca
  -- inventados. `{}` significa "não observado", e o rascunho diz isso em vez de
  -- imaginar campos.
  attempted_args JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Idem para o retorno esperado, de onde saem os `outputs` do rascunho.
  expected_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Fail-closed contra o literal proibido (invariante #8 do AGENTS.md; mesmo
  -- CHECK das migrações 109 e 120). Uma observação sob `default` seria a
  -- observação genérica, de ninguém, que o escopo por tenant+agent existe para
  -- tornar impossível.
  CONSTRAINT agent_capability_gap_observations_no_default_literal
    CHECK (tenant_id <> 'default' AND agent_id <> 'default')
);

-- A leitura quente: "as N ocorrências mais recentes DESTE gap, neste escopo".
-- É a que monta as situações e a janela de frequência da proposta.
CREATE INDEX gap_observations_scope_gap_idx
  ON agent_capability_gap_observations(tenant_id, agent_id, gap_id, observed_at DESC);

-- Parcial: só as observações que de fato carregam link de trace. Sustenta a
-- resolução em lote dos envelopes e o caminho inverso ("que gaps este turno
-- gerou?") sem pagar por linha sem trace.
CREATE INDEX gap_observations_root_trace_idx
  ON agent_capability_gap_observations(tenant_id, agent_id, root_trace_id)
  WHERE root_trace_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · O tipo novo de proposta
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A lista reproduzida abaixo é a que está VIGENTE no banco (posta pela 058),
-- mais `tool_request`. Ela NÃO inclui 'skill'/'soul_bias'/'policy_rule': a 058
-- reescreveu o CHECK sem eles e essa regressão é anterior a esta migração —
-- corrigi-la aqui misturaria dois assuntos e mudaria, de carona, o que o
-- fluxo de Skill (P9a) pode gravar. Fica registrada e intocada.
ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other', 'holiday', 'tool_request'
  ));

-- A marcação obrigatória. Ver "O GUARDRAIL, NO BANCO" no cabeçalho.
--
-- Só restringe linhas `tool_request`; qualquer outro `capability_type` passa
-- intocado, então nenhuma linha existente pode violar o CHECK novo e a
-- validação é trivial.
--
-- `IS NOT DISTINCT FROM`, e NÃO `=`. A diferença aqui é o CHECK inteiro.
--   Um CHECK só recusa a linha quando a expressão dá FALSE; NULL passa. Com
--   `=`, uma chave AUSENTE no JSON faz `proposed_spec->>'spec_kind'` valer NULL,
--   `NULL = 'tool_request'` valer NULL, e o `OR` inteiro valer NULL — ou seja, o
--   INSERT SEM MARCAÇÃO NENHUMA seria aceito, que é exatamente o caso que esta
--   constraint existe para barrar. Com `IS NOT DISTINCT FROM` a comparação é
--   FALSE contra NULL, e a recusa acontece. (O caso foi pego pela sonda de
--   marcação em `tests/integration/tool-request-proposal-real-db.spec.ts`, que
--   tenta inserir sem `spec_kind` — não confie na leitura, confie no vermelho.)
ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_tool_request_marking_check
  CHECK (
    capability_type <> 'tool_request'
    OR (
      proposed_spec->>'spec_kind' IS NOT DISTINCT FROM 'tool_request'
      AND proposed_spec->>'contract_status'
            IS NOT DISTINCT FROM 'draft_proposal_not_in_force'
    )
  );

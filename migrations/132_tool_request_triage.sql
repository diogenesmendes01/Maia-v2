-- 132 — a TRIAGEM do pedido de ferramenta: aceitar vira issue, a tool ficar
-- disponível de verdade fecha o gap, e o agente é avisado
-- (issue #638, fatia C da épica #471 — fecha a épica).
--
-- O QUE ISSO FECHA
--   A fatia A (#636) faz o gap recorrente virar um pedido estruturado; a fatia
--   B (#637) faz N pedidos parecidos virarem UM com contador. Nas duas, o
--   pedido morre no backlog: ninguém decide nada sobre ele, e nada acontece
--   quando a ferramenta finalmente existe. Esta migração cria as três coisas
--   que faltam para o ciclo fechar — o ACEITE, o FECHAMENTO e o AVISO.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · ACEITAR É UM EFEITO EXTERNO, E EFEITO EXTERNO PRECISA DE CHAVE
-- ─────────────────────────────────────────────────────────────────────────────
--   Abrir issue no GitHub é irreversível do lado de fora: dois cliques do dono
--   encheriam o repositório com o mesmo pedido, e ninguém "desabre" uma issue.
--   `tool_request_issues` é a RESERVA que torna o aceite idempotente ANTES de
--   a chamada externa sair:
--
--     · UNIQUE (tenant_id, agent_id, aggregate_id) — um agregado tem no máximo
--       UMA issue. O segundo clique perde a corrida NO BANCO, não no código.
--     · `idempotency_key` UNIQUE e DETERMINÍSTICO — derivado do escopo + do
--       agregado, e por isso reproduzível. Ele viaja no CORPO da issue como
--       marcador, e é o que permite ADOTAR uma issue já existente quando o
--       processo morreu entre a chamada e o registro do resultado. Sem ele, um
--       crash nessa janela abriria a segunda issue na retentativa.
--     · A linha nasce `pending`. A chamada externa acontece DEPOIS, no
--       relayer do runtime; o console nunca fala com o GitHub.
--
--   O `idempotency_key` é um HASH, não o escopo em texto claro. Ele aparece
--   numa issue que pode ser pública: `tenant:acme/agent:financeiro` num corpo
--   de issue é vazamento de cliente por descuido de formato.
--
--   O CORPO da issue é gravado AQUI, no aceite, e não montado pelo relayer.
--   Duas razões: (a) o que o dono aceitou é exatamente o que vai para o
--   GitHub — o relayer não pode reescrever a spec entre o clique e o envio; e
--   (b) o corpo vira evidência auditável mesmo se a chamada externa nunca
--   suceder.
--
--   O QUE ESTA TABELA NÃO TEM, DE PROPÓSITO: nenhuma coluna de credencial.
--   Token do GitHub não é dado de negócio, não entra em linha de banco, não
--   entra em payload de proposta e não entra em log. Ele existe só na
--   configuração do serviço `runtime` (ver `MAIA_TOOL_REQUEST_GITHUB_TOKEN` no
--   contrato) — e o `admin-ui`, que é quem serve o botão "aceitar", NÃO tem
--   essa variável no seu subset. A defesa é estrutural, não é disciplina.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · O GAP FECHA POR FATO VERIFICÁVEL, NUNCA POR CAIXA MARCADA
-- ─────────────────────────────────────────────────────────────────────────────
--   `agent_capability_gaps` ganha `resolved_at` + `resolved_reason` +
--   `resolved_tool_name`. O único escritor de produção é o monitor de
--   fechamento, e ele só escreve quando a tool EXISTE NO CÓDIGO e ESTÁ
--   CONCEDIDA àquele tenant+agent — os dois lados lidos do estado real
--   (o registro de tools committado e `agent_tool_grants`), nunca de uma
--   marcação no console. Não há rota de console que escreva estas colunas.
--
--   `resolved_reason` é NOT NULL exatamente quando `resolved_at` é: um gap
--   fechado sem motivo registrado é um gap fechado por ninguém.
--
--   O nível (`current_level`) NÃO é usado para fechar. Um gap resolvido
--   rebaixado para 'silent' seria indistinguível de um gap que nunca subiu, e
--   apagaria a história da escalada — que é justamente a evidência que
--   justificou o pedido.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · O AVISO AO AGENTE É UMA LINHA, NÃO UM EFEITO COLATERAL
-- ─────────────────────────────────────────────────────────────────────────────
--   `tool_request_notifications` registra que o agente foi avisado de que a
--   ferramenta que ele pediu passou a existir: qual tool, por causa de qual
--   gap e de qual agregado, com que evidência e quando. É o que torna a
--   notificação AUDITÁVEL no sentido literal — ela é um fato guardado, não um
--   efeito que só existiu dentro de um prompt.
--
--   UNIQUE (tenant_id, agent_id, gap_id): avisar duas vezes pelo mesmo gap é
--   ruído, e o monitor roda em cron.
--
-- ESCOPO: as duas tabelas novas são por tenant+agent, com o CHECK fail-closed
-- contra o literal 'default' (invariante #8 do AGENTS.md) e com o prefixo
-- (tenant_id, agent_id) em todo índice de leitura de escopo.
--
-- POR QUE SEM `maia:no-transaction`
--   `tool_request_issues` e `tool_request_notifications` nascem vazias. O
--   `ALTER TABLE ... ADD COLUMN` sem default sobre `agent_capability_gaps` é
--   metadata-only no PG 11+, e a tabela é pequena (um punhado de linhas por
--   agente). Os índices abaixo nascem dentro da transação — não há
--   `CREATE INDEX CONCURRENTLY` aqui, portanto nada do que a issue #658 alerta
--   (índice inválido não detectado pelo runner) se aplica: ou nascem válidos,
--   ou a migração inteira falha.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · A reserva do aceite (e o corpo que o dono aceitou)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tool_request_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  aggregate_id UUID NOT NULL REFERENCES tool_request_aggregates(id),

  -- Determinístico e reproduzível a partir do escopo + agregado. Viaja no
  -- corpo da issue como MARCADOR, e é por ele que o relayer reconhece uma
  -- issue que ele mesmo já abriu antes de um crash.
  idempotency_key TEXT NOT NULL,

  -- 'owner/repo'. Gravado na linha porque o destino pode mudar de configuração
  -- entre o aceite e a criação, e a issue tem de sair onde o dono aceitou.
  repo_slug TEXT NOT NULL,

  -- pending .. aceito, issue ainda não criada (o relayer vai criar)
  -- created .. a issue existe; `issue_number`/`issue_url` dizem qual
  -- failed ... a chamada externa falhou de forma terminal; `last_error` diz por quê
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'created', 'failed')),

  title TEXT NOT NULL,
  -- O corpo COMO O DONO ACEITOU. O relayer envia isto, não uma remontagem.
  body TEXT NOT NULL,

  issue_number INTEGER,
  issue_url TEXT,
  -- true quando o relayer ENCONTROU a issue pelo marcador em vez de criá-la —
  -- isto é, quando um crash o fez repetir uma chamada que já tinha sucedido.
  -- A distinção importa: sem ela, "criada" e "readotada" viram o mesmo fato e
  -- ninguém consegue medir a janela de crash.
  adopted BOOLEAN NOT NULL DEFAULT false,

  accepted_by TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tool_request_issues_no_default_literal
    CHECK (tenant_id <> 'default' AND agent_id <> 'default'),

  -- UM agregado, NO MÁXIMO UMA issue. Este é o critério "aceitar duas vezes
  -- cria uma issue", posto onde nenhuma corrida de aplicação o contorna.
  CONSTRAINT tool_request_issues_aggregate_unique
    UNIQUE (tenant_id, agent_id, aggregate_id),

  -- A chave determinística é única GLOBALMENTE: ela já contém o escopo, e uma
  -- colisão entre escopos significaria que a derivação está errada.
  CONSTRAINT tool_request_issues_key_unique UNIQUE (idempotency_key),

  -- 'created' e "sei qual issue é" são a MESMA coisa. Sem este CHECK, uma
  -- linha poderia dizer que a issue existe sem dizer qual — e a triagem
  -- mostraria "aceito" com um link para lugar nenhum.
  CONSTRAINT tool_request_issues_created_has_number
    CHECK ((status = 'created') = (issue_number IS NOT NULL)),

  -- Adotar é um subcaso de criada. Uma linha `pending` marcada como adotada
  -- seria um fato sem o outro.
  CONSTRAINT tool_request_issues_adopted_implies_created
    CHECK (adopted = false OR status = 'created')
);

-- A leitura quente da triagem: "o que já foi aceito neste escopo?".
CREATE INDEX tool_request_issues_scope_idx
  ON tool_request_issues(tenant_id, agent_id, accepted_at DESC);

-- A fila do relayer, cross-tenant: só o que ainda não virou issue. Parcial —
-- uma issue já criada nunca mais entra na varredura.
CREATE INDEX tool_request_issues_pendentes_idx
  ON tool_request_issues(status, last_attempt_at)
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · O fechamento do gap, a partir do estado REAL da capability
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE agent_capability_gaps
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_reason TEXT,
  ADD COLUMN resolved_tool_name TEXT;

-- Fechar sem motivo é fechar por ninguém.
ALTER TABLE agent_capability_gaps
  ADD CONSTRAINT agent_capability_gaps_resolution_needs_reason
    CHECK ((resolved_at IS NULL) = (resolved_reason IS NULL));

-- Os gaps ABERTOS de um escopo, por nível: a leitura de todo turno
-- (o bloco `<gap>` do prompt) e a do worker de escalada. Parcial, porque um
-- gap fechado nunca mais é candidato a escalar nem a ser anunciado como
-- limitação.
CREATE INDEX caps_gaps_abertos_idx
  ON agent_capability_gaps(tenant_id, agent_id, current_level)
  WHERE resolved_at IS NULL;

-- Os gaps RECÉM-fechados de um escopo: a outra metade da MESMA leitura do
-- turno (o aviso "isto você já consegue"), sem custar uma segunda ida ao banco.
CREATE INDEX caps_gaps_resolvidos_idx
  ON agent_capability_gaps(tenant_id, agent_id, resolved_at DESC)
  WHERE resolved_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · O aviso ao agente, guardado como fato
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tool_request_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  gap_id UUID NOT NULL REFERENCES agent_capability_gaps(id) ON DELETE CASCADE,
  -- NULO quando o pedido nunca chegou a ter agregado (descrição sem token de
  -- conteúdo — ver `sem_assinatura` na fatia B). O aviso continua valendo.
  aggregate_id UUID REFERENCES tool_request_aggregates(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  -- Como a disponibilidade foi comprovada, em JSON legível: o que o monitor
  -- viu no registro e no grant no instante em que decidiu fechar.
  evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tool_request_notifications_no_default_literal
    CHECK (tenant_id <> 'default' AND agent_id <> 'default'),
  -- Um gap gera UM aviso. O monitor roda em cron; sem isto, cada passada
  -- reavisaria.
  CONSTRAINT tool_request_notifications_gap_unique
    UNIQUE (tenant_id, agent_id, gap_id)
);

CREATE INDEX tool_request_notifications_scope_idx
  ON tool_request_notifications(tenant_id, agent_id, notified_at DESC);

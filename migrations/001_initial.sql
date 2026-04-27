-- =====================================================================
-- Lia — Schema inicial (PostgreSQL 16 + pgvector)
-- Migration 001_initial
-- =====================================================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- =====================================================================
-- ENTIDADES E FINANCEIRO
-- =====================================================================

CREATE TABLE entidades (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome            TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pf', 'pj')),
  documento       TEXT,                                  -- CPF ou CNPJ
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'inativa', 'arquivada')),
  cor             TEXT,                                  -- para dashboards
  observacoes     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entidades_status ON entidades (status);

CREATE TABLE contas_bancarias (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID NOT NULL REFERENCES entidades(id) ON DELETE RESTRICT,
  banco           TEXT NOT NULL,
  agencia         TEXT,
  numero          TEXT,
  apelido         TEXT NOT NULL,                         -- "Itaú PF", "Inter Empresa 3"
  tipo            TEXT NOT NULL CHECK (tipo IN ('cc', 'poupanca', 'investimento', 'caixa', 'cartao')),
  saldo_atual     NUMERIC(15,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'inativa')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contas_entidade ON contas_bancarias (entidade_id);

CREATE TABLE categorias (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID REFERENCES entidades(id) ON DELETE CASCADE, -- NULL = global
  parent_id       UUID REFERENCES categorias(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  natureza        TEXT NOT NULL CHECK (natureza IN ('receita', 'despesa', 'movimentacao')),
  cor             TEXT,
  icone           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_categorias_entidade ON categorias (entidade_id);
CREATE INDEX idx_categorias_parent ON categorias (parent_id);

CREATE TABLE transacoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID NOT NULL REFERENCES entidades(id) ON DELETE RESTRICT,
  conta_id        UUID NOT NULL REFERENCES contas_bancarias(id) ON DELETE RESTRICT,
  categoria_id    UUID REFERENCES categorias(id) ON DELETE SET NULL,
  natureza        TEXT NOT NULL CHECK (natureza IN ('receita', 'despesa', 'movimentacao')),
  valor           NUMERIC(15,2) NOT NULL,                -- sempre positivo; sinal vem da natureza
  data_competencia DATE NOT NULL,                        -- quando o evento aconteceu
  data_pagamento  DATE,                                  -- quando foi efetivamente pago/recebido
  status          TEXT NOT NULL CHECK (status IN ('pendente', 'agendada', 'paga', 'recebida', 'cancelada')),
  descricao       TEXT NOT NULL,
  contraparte     TEXT,                                  -- fornecedor, cliente, beneficiário
  origem          TEXT NOT NULL CHECK (origem IN ('whatsapp', 'extrato', 'manual', 'recorrencia', 'api')),
  conversa_id     UUID,                                  -- FK populada após conversas existir
  mensagem_id     UUID,
  registrado_por  UUID,                                  -- pessoa_id
  confianca_ia    NUMERIC(3,2),                          -- 0.00 a 1.00 (auto-classificação)
  confirmada_em   TIMESTAMPTZ,                           -- humano confirmou
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transacoes_entidade_data ON transacoes (entidade_id, data_competencia DESC);
CREATE INDEX idx_transacoes_conta ON transacoes (conta_id);
CREATE INDEX idx_transacoes_status ON transacoes (status);
CREATE INDEX idx_transacoes_pagamento ON transacoes (data_pagamento) WHERE data_pagamento IS NOT NULL;

CREATE TABLE transferencias_internas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transacao_origem_id UUID NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
  transacao_destino_id UUID NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('entre_contas_propria', 'intercompany', 'aporte_socio', 'distribuicao_lucros')),
  observacoes     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recorrencias (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID NOT NULL REFERENCES entidades(id) ON DELETE CASCADE,
  conta_id        UUID NOT NULL REFERENCES contas_bancarias(id),
  categoria_id    UUID REFERENCES categorias(id),
  natureza        TEXT NOT NULL CHECK (natureza IN ('receita', 'despesa')),
  descricao       TEXT NOT NULL,
  valor_aprox     NUMERIC(15,2) NOT NULL,
  dia_do_mes      INT CHECK (dia_do_mes BETWEEN 1 AND 31),
  frequencia      TEXT NOT NULL DEFAULT 'mensal' CHECK (frequencia IN ('mensal', 'quinzenal', 'semanal', 'anual')),
  ativa           BOOLEAN NOT NULL DEFAULT TRUE,
  proxima_em      DATE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recorrencias_proxima ON recorrencias (proxima_em) WHERE ativa = TRUE;

-- =====================================================================
-- PESSOAS, PERMISSÕES, CONVERSAS
-- =====================================================================

CREATE TABLE pessoas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome            TEXT NOT NULL,
  apelido         TEXT,                                  -- como a Lia se refere
  telefone_whatsapp TEXT NOT NULL UNIQUE,                -- formato E.164: +5511999999999
  tipo            TEXT NOT NULL CHECK (tipo IN ('dono', 'co_dono', 'socio', 'contador', 'funcionario', 'fornecedor', 'cliente', 'outro')),
  email           TEXT,
  observacoes     TEXT,
  preferencias    JSONB NOT NULL DEFAULT '{}'::jsonb,    -- horario_briefing, tom, idioma, etc.
  modelo_mental   JSONB NOT NULL DEFAULT '{}'::jsonb,    -- o que a Lia "sabe" sobre essa pessoa
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'inativa', 'bloqueada')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pessoas_telefone ON pessoas (telefone_whatsapp);

CREATE TABLE permissoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  entidade_id     UUID REFERENCES entidades(id) ON DELETE CASCADE, -- NULL = todas (apenas para 'dono')
  papel           TEXT NOT NULL CHECK (papel IN ('dono', 'admin', 'operador', 'leitor', 'contador', 'contato')),
  acoes_permitidas TEXT[] NOT NULL DEFAULT '{}',          -- ex: ['read_transactions', 'create_transaction', 'read_reports']
  limites         JSONB NOT NULL DEFAULT '{}'::jsonb,    -- ex: {valor_max: 5000}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pessoa_id, entidade_id)
);

CREATE INDEX idx_permissoes_pessoa ON permissoes (pessoa_id);
CREATE INDEX idx_permissoes_entidade ON permissoes (entidade_id);

CREATE TABLE conversas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id) ON DELETE RESTRICT,
  escopo_entidades UUID[] NOT NULL DEFAULT '{}',         -- entidades acessíveis nesta conversa
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'pausada', 'encerrada')),
  contexto_resumido TEXT,                                -- resumo gerado pela Lia
  ultima_atividade_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversas_pessoa ON conversas (pessoa_id, status);

CREATE TABLE mensagens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversa_id     UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  direcao         TEXT NOT NULL CHECK (direcao IN ('in', 'out')),
  tipo            TEXT NOT NULL CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'sistema')),
  conteudo        TEXT,                                  -- texto ou transcrição
  midia_url       TEXT,                                  -- caminho local da mídia
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,    -- whatsapp_id, ocr_raw, etc.
  processada_em   TIMESTAMPTZ,
  ferramentas_chamadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokens_usados   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mensagens_conversa ON mensagens (conversa_id, created_at);

-- Agora podemos adicionar a FK em transacoes para conversa
ALTER TABLE transacoes ADD CONSTRAINT fk_transacoes_conversa FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE SET NULL;
ALTER TABLE transacoes ADD CONSTRAINT fk_transacoes_mensagem FOREIGN KEY (mensagem_id) REFERENCES mensagens(id) ON DELETE SET NULL;
ALTER TABLE transacoes ADD CONSTRAINT fk_transacoes_pessoa FOREIGN KEY (registrado_por) REFERENCES pessoas(id) ON DELETE SET NULL;

-- =====================================================================
-- INTELIGÊNCIA — MEMÓRIA E APRENDIZADO
-- =====================================================================

-- Memória semântica: fatos estruturados sobre o mundo da Lia
CREATE TABLE agent_facts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  escopo          TEXT NOT NULL,                         -- 'global', 'entidade:UUID', 'pessoa:UUID'
  chave           TEXT NOT NULL,                         -- 'preferencia.briefing.horario'
  valor           JSONB NOT NULL,
  confianca       NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  fonte           TEXT NOT NULL DEFAULT 'aprendido' CHECK (fonte IN ('configurado', 'aprendido', 'inferido')),
  ultima_validacao TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (escopo, chave)
);

CREATE INDEX idx_facts_escopo ON agent_facts (escopo);

-- Memória procedural: regras aprendidas com correções
CREATE TABLE learned_rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo            TEXT NOT NULL,                         -- 'classificacao', 'identificacao_entidade', 'tom_resposta'
  contexto        TEXT NOT NULL,                         -- "descricao contém 'aluguel'"
  acao            TEXT NOT NULL,                         -- "categoria=aluguel, entidade=empresa-3"
  contexto_jsonb  JSONB NOT NULL DEFAULT '{}'::jsonb,    -- pattern matching estruturado
  acoes_jsonb     JSONB NOT NULL DEFAULT '{}'::jsonb,
  confianca       NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  acertos         INT NOT NULL DEFAULT 0,
  erros           INT NOT NULL DEFAULT 0,
  ativa           BOOLEAN NOT NULL DEFAULT TRUE,
  exemplo_origem_id UUID,                                -- mensagem que gerou
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rules_tipo_ativa ON learned_rules (tipo) WHERE ativa = TRUE;

-- Memória vetorial: embeddings para recall por similaridade
-- Dimensão 1024 (Voyage AI) ou 1536 (OpenAI). Ajuste conforme provedor.
CREATE TABLE agent_memories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conteudo        TEXT NOT NULL,
  embedding       VECTOR(1024),
  tipo            TEXT NOT NULL,                         -- 'mensagem', 'transacao', 'decisao', 'reflexao'
  escopo          TEXT NOT NULL,                         -- 'global', 'entidade:UUID', etc.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ref_tabela      TEXT,
  ref_id          UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_embedding ON agent_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_memories_escopo_tipo ON agent_memories (escopo, tipo);

-- Estado da identidade da Lia (versionado)
CREATE TABLE self_state (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  versao          INT NOT NULL,
  system_prompt   TEXT NOT NULL,
  resumo_aprendizados TEXT,
  ativa           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_self_state_ativa ON self_state (ativa) WHERE ativa = TRUE;

-- =====================================================================
-- WORKFLOWS (tarefas multi-passo)
-- =====================================================================

CREATE TABLE workflows (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo            TEXT NOT NULL,                         -- 'fechamento_mes', 'cobranca_balancete'
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_andamento', 'aguardando_humano', 'aguardando_terceiro', 'concluido', 'cancelado', 'falhou')),
  contexto        JSONB NOT NULL DEFAULT '{}'::jsonb,
  entidade_id     UUID REFERENCES entidades(id) ON DELETE CASCADE,
  pessoa_envolvida UUID REFERENCES pessoas(id),
  proxima_acao_em TIMESTAMPTZ,
  iniciado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em    TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_workflows_status ON workflows (status, proxima_acao_em);

CREATE TABLE workflow_steps (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  ordem           INT NOT NULL,
  descricao       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_andamento', 'concluido', 'pulado', 'falhou')),
  resultado       JSONB,
  iniciado_em     TIMESTAMPTZ,
  concluido_em    TIMESTAMPTZ
);

CREATE INDEX idx_workflow_steps_wf ON workflow_steps (workflow_id, ordem);

-- =====================================================================
-- AUDITORIA
-- =====================================================================

CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID REFERENCES pessoas(id),           -- quem (NULL = sistema/Lia)
  acao            TEXT NOT NULL,                         -- 'transacao.criada', 'permissao.alterada'
  entidade_alvo   TEXT,                                  -- nome da tabela
  alvo_id         UUID,
  conversa_id     UUID REFERENCES conversas(id),
  mensagem_id     UUID REFERENCES mensagens(id),
  diff            JSONB,                                 -- antes/depois
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_pessoa ON audit_log (pessoa_id, created_at DESC);
CREATE INDEX idx_audit_alvo ON audit_log (entidade_alvo, alvo_id);

-- =====================================================================
-- TRIGGERS DE updated_at
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_entidades BEFORE UPDATE ON entidades FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_contas BEFORE UPDATE ON contas_bancarias FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_transacoes BEFORE UPDATE ON transacoes FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_pessoas BEFORE UPDATE ON pessoas FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_facts BEFORE UPDATE ON agent_facts FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at_rules BEFORE UPDATE ON learned_rules FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- SEEDS BÁSICOS (categorias globais)
-- =====================================================================

INSERT INTO categorias (entidade_id, nome, natureza) VALUES
  (NULL, 'Vendas de produto', 'receita'),
  (NULL, 'Vendas de serviço', 'receita'),
  (NULL, 'Aluguéis recebidos', 'receita'),
  (NULL, 'Outras receitas', 'receita'),
  (NULL, 'Aluguel', 'despesa'),
  (NULL, 'Energia', 'despesa'),
  (NULL, 'Água', 'despesa'),
  (NULL, 'Internet', 'despesa'),
  (NULL, 'Folha de pagamento', 'despesa'),
  (NULL, 'Pró-labore', 'despesa'),
  (NULL, 'Impostos', 'despesa'),
  (NULL, 'Software / SaaS', 'despesa'),
  (NULL, 'Marketing', 'despesa'),
  (NULL, 'Manutenção', 'despesa'),
  (NULL, 'Combustível / Transporte', 'despesa'),
  (NULL, 'Alimentação', 'despesa'),
  (NULL, 'Mercado', 'despesa'),
  (NULL, 'Saúde', 'despesa'),
  (NULL, 'Educação', 'despesa'),
  (NULL, 'Lazer', 'despesa'),
  (NULL, 'Veículo particular', 'despesa'),
  (NULL, 'Casa', 'despesa'),
  (NULL, 'Outras despesas', 'despesa'),
  (NULL, 'Transferência entre contas', 'movimentacao'),
  (NULL, 'Empréstimo intercompany', 'movimentacao'),
  (NULL, 'Aporte de sócio', 'movimentacao'),
  (NULL, 'Distribuição de lucros', 'movimentacao');

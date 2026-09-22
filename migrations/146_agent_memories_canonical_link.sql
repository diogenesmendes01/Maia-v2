-- 146 — G2: o vetor deixa de ser memória independente (spec Maia+Hermes §7.6.3).
--
-- ─── O que esta migration conserta ─────────────────────────────────────────
--
-- `agent_memories` guarda o embedding e uma CÓPIA do conteúdo (`conteudo`),
-- com `ref_tabela`/`ref_id` como único vínculo com a fonte. Duas colunas de
-- texto livre não são vínculo: nada impede que apontem para nada, para outra
-- tabela, ou para uma linha que já foi revogada. A spec chama isso de
-- insuficiente e pede FK para o item canônico.
--
-- O efeito prático do que existia: o recall lia `agent_memories` sozinha e
-- devolvia `conteudo` — a cópia — ao modelo. Se o item canônico fosse
-- revogado, expirado ou marcado como necessitando revisão, o vetor continuava
-- lá e continuava respondendo. A autorização vivia numa tabela e o conteúdo
-- entregue vinha de outra.
--
-- ─── Por que FK COMPOSTA ──────────────────────────────────────────────────
--
-- `(tenant_id, agent_id, memory_entry_id)` referencia
-- `memory_entry (tenant_id, agent_id, id)`. Uma FK por `id` simples aceitaria
-- o vetor de um tenant apontando para o item de outro: o UUID prova
-- unicidade, não pertencimento. É a mesma régua da 145.
--
-- ─── Nullable, e por quê ──────────────────────────────────────────────────
--
-- A coluna nasce NULL porque as linhas existentes não têm como ser ligadas
-- retroativamente — nada nelas diz de qual item canônico vieram. Torná-la NOT
-- NULL exigiria apagar o histórico ou inventar vínculo.
--
-- Isso NÃO afrouxa a autorização: quem decide é o `recallAuthorized`, e ele
-- exige o JOIN. Vetor órfão simplesmente não é elegível — fica no banco, fora
-- do alcance do modelo. A coluna registra o vínculo; o predicado é que barra.

BEGIN;

ALTER TABLE agent_memories
  ADD COLUMN IF NOT EXISTS memory_entry_id uuid,
  -- Digest do conteúdo canônico NO MOMENTO da indexação. O projetor compara
  -- com o digest atual: se o item canônico mudou e o vetor não foi
  -- reindexado, a linha está falando de uma revisão que não existe mais.
  ADD COLUMN IF NOT EXISTS content_digest text;

-- O unique de suporte da FK composta, no lado referenciado.
CREATE UNIQUE INDEX IF NOT EXISTS memory_entry_tenant_agent_id_uq
  ON memory_entry (tenant_id, agent_id, id);

ALTER TABLE agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_canonical_fk;

ALTER TABLE agent_memories
  ADD CONSTRAINT agent_memories_canonical_fk
  FOREIGN KEY (tenant_id, agent_id, memory_entry_id)
  REFERENCES memory_entry (tenant_id, agent_id, id)
  ON DELETE CASCADE;

-- O recall filtra por vínculo antes de ordenar por similaridade; sem este
-- índice o JOIN varre a tabela inteira de vetores a cada consulta.
CREATE INDEX IF NOT EXISTS agent_memories_canonical_idx
  ON agent_memories (tenant_id, agent_id, memory_entry_id)
  WHERE memory_entry_id IS NOT NULL;

COMMIT;

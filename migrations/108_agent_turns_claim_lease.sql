-- 108 — claim atômico, lease e fencing do turno inbound (issue #504, Fase 1).
--
-- A 097 (issue #503) já reservou `claimed_by`, `claim_token` e
-- `lease_expires_at` em `agent_turns`, mais o índice `agent_turns_lease_idx`.
-- Esta migration fecha o que faltava para que a posse seja OBSERVÁVEL e
-- CONSISTENTE por row:
--
--   heartbeat_at — última prova de vida do dono. `lease_expires_at` diz até
--                  quando a posse vale; `heartbeat_at` diz quando ela foi
--                  provada pela última vez. São perguntas diferentes na
--                  investigação: "esta lease ainda vale?" vs. "há quanto tempo
--                  este worker não dá sinal?". Sem a segunda, um TTL longo
--                  esconde um worker travado até a expiração.
--
-- E uma CHECK que torna impossível a meia-posse.
--
-- ── Por que a CHECK do trio ────────────────────────────────────────────────
-- Posse é UMA decisão: quem (`claimed_by`), com qual token (`claim_token`) e
-- até quando (`lease_expires_at`). Se um caminho gravasse dois dos três, o
-- fencing viraria teatro: um UPDATE com `claim_token = $token` casaria numa row
-- sem dono real, ou um sweep enxergaria lease sem token e não teria contra o
-- que fazer CAS. A constraint transforma "sempre escreva os três juntos" —
-- convenção que um refactor quebra em silêncio — em invariante do banco.
--
-- Rows LEGADAS (turnos criados pela 097 antes desta issue) têm os três NULL, o
-- que satisfaz a constraint: `claim_token IS NULL` é exatamente "sem dono".
-- Nenhum backfill é necessário e nenhum turno em voo é invalidado — um turno
-- `claimed`/`running` sem lease continua existindo e é justamente o que o
-- recovery desta issue passa a resgatar.
--
-- ── Custo ──────────────────────────────────────────────────────────────────
-- Uma coluna timestamptz nullable (8 bytes quando presente, sem reescrita da
-- tabela no PG >= 11 por ser nullable sem default) e uma CHECK avaliada só na
-- escrita. Nenhum índice novo: o claim é por PK (`id`), a renovação é por PK +
-- token, e a varredura de lease vencida já é servida pelo
-- `agent_turns_lease_idx` parcial criado na 097. Adicionar índice em
-- `heartbeat_at` custaria escrita em TODO heartbeat (o caminho mais quente
-- desta issue) para servir uma consulta que é de diagnóstico, não de hot path.

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

-- Trio de posse: ou os três estão presentes, ou os três estão ausentes.
-- Escrita com `IS NULL`/`IS NOT NULL` (nunca `=`) para que o predicado seja
-- sempre booleano — a armadilha de lógica ternária documentada na 097 (um CHECK
-- que avalia NULL ACEITA a row) é o motivo de este arquivo não usar igualdade.
ALTER TABLE agent_turns
  DROP CONSTRAINT IF EXISTS agent_turns_claim_trio_chk;
ALTER TABLE agent_turns
  ADD CONSTRAINT agent_turns_claim_trio_chk CHECK (
    (claimed_by IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
    OR (claimed_by IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

-- Identidade do dono é `<hostname>:<pid>` (src/runtime/instance-identity.ts).
-- O teto existe pelo mesmo motivo dos limites de `last_error_*`: a coluna sai
-- em log e métrica de diagnóstico, e texto ilimitado vindo de um hostname
-- inesperado é o vetor por onde um label explode.
ALTER TABLE agent_turns
  DROP CONSTRAINT IF EXISTS agent_turns_claimed_by_len_chk;
ALTER TABLE agent_turns
  ADD CONSTRAINT agent_turns_claimed_by_len_chk
    CHECK (claimed_by IS NULL OR length(claimed_by) <= 200);

-- 114 — claim atômico, lease e fencing do turno (issue #504, Fase 1).
--
-- A migration 097 (#503) já criou `claimed_by`, `claim_token`,
-- `lease_expires_at` e `claimed_at` DECLARADAMENTE reservados para esta issue
-- ("Campos de claim/lease/deadline/outbound são criados AQUI mesmo sem uso
-- nesta issue"). Esta migration acrescenta o que faltava para que o lease seja
-- OBSERVÁVEL e para que a varredura de lease vencida seja indexada no caminho
-- que o recovery de fato usa.
--
-- 1. `heartbeat_at` — quando o dono renovou o lease pela última vez.
--
--    Não é redundante com `lease_expires_at`. `lease_expires_at` responde "até
--    quando este claim vale"; `heartbeat_at` responde "quando o dono deu sinal
--    de vida pela última vez". A diferença importa em incidente: um lease com
--    TTL de 60s e `heartbeat_at` de 55s atrás é um worker AGONIZANTE (renovou
--    uma vez e parou), enquanto um lease com o mesmo vencimento e
--    `heartbeat_at` de 2s atrás é um worker SAUDÁVEL processando algo longo.
--    Sem a coluna as duas situações são indistinguíveis até o lease vencer —
--    exatamente quando já é tarde para agir.
--
--    NULLABLE e sem backfill: turnos anteriores a esta issue nunca tiveram
--    dono com lease, então `NULL` é a verdade ("nunca houve heartbeat"), não
--    um buraco. Carimbar `now()` nas rows existentes inventaria um heartbeat
--    que não aconteceu e faria um turno preso desde ontem parecer saudável.
--
-- 2. `agent_turns_lease_expiry_idx` — varredura GLOBAL de lease vencida.
--
--    A 097 criou `agent_turns_lease_idx (tenant_id, agent_id,
--    lease_expires_at) WHERE status IN ('claimed','running')`, que serve a
--    consulta ESCOPADA (`findRecoverableTurns`). O dispatcher do recovery
--    (`listTenantAgentPairsWithRecoverableTurns`) roda FORA de contexto de
--    tenant e pergunta "que pares têm lease vencida?" — com `tenant_id` como
--    primeira coluna do índice existente, esse predicado não tem prefixo
--    utilizável e cai em scan. Este índice põe `lease_expires_at` na frente,
--    que é a coluna do predicado de desigualdade.
--
--    Custo: índice PARCIAL nos dois estados que podem ter dono
--    (`claimed`/`running`) e apenas nas rows com lease. Ele é proporcional ao
--    trabalho EM VOO, não ao histórico — a tabela cresce indefinidamente, este
--    índice não. Nenhum backfill: `CREATE INDEX IF NOT EXISTS` sobre uma
--    tabela cujas rows vivas são poucas por construção.
--
-- Nada aqui é destrutivo e nada muda comportamento por si só: a coluna nasce
-- NULL e só passa a ser escrita quando `FEATURE_TURN_CLAIM` liga o caminho de
-- claim em src/runtime/turns/lease.ts. Rollout compatível com jobs legados: um
-- worker antigo (sem claim) continua ignorando as duas coisas.

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN agent_turns.heartbeat_at IS
  'Issue #504: último heartbeat do dono do lease. NULL = nunca houve dono com lease. Distingue worker agonizante de worker saudável em execução longa.';

CREATE INDEX IF NOT EXISTS agent_turns_lease_expiry_idx
  ON agent_turns (lease_expires_at)
  WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL;

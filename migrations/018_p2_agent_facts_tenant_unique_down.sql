-- Rollback de 018: volta para o UNIQUE global (escopo, chave).
--
-- ATENÇÃO: se houver linhas com mesma (escopo, chave) em tenants diferentes,
-- este down falha. É comportamento esperado — o operador precisa decidir
-- qual linha sobrevive antes de reverter (a separação tenant é a feature).
--
-- IDEMPOTÊNCIA (PR #82 non-blocker followup): o forward 018 hoje detecta
-- a constraint já criada por #75/#81 (slot 013) e não faz nada. O down
-- ainda assim DROPa a constraint multi-tenant (o operador escolheu reverter)
-- e só re-adiciona a legada se ela não existir, mantendo a operação segura
-- contra estados parciais.

ALTER TABLE agent_facts DROP CONSTRAINT IF EXISTS agent_facts_tenant_agent_escopo_chave_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_facts_escopo_chave_key'
      AND conrelid = 'agent_facts'::regclass
  ) THEN
    ALTER TABLE agent_facts
      ADD CONSTRAINT agent_facts_escopo_chave_key
      UNIQUE (escopo, chave);
  END IF;
END
$$;

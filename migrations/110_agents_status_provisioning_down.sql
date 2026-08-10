-- Down de 110 — devolve `agents.status` ao vocabulário de três valores.
--
-- O rollback NÃO pode simplesmente re-adicionar o CHECK estreito: qualquer
-- agente parado no meio de um onboarding está em `provisioning` e o
-- ADD CONSTRAINT falharia. Também não pode reescrever esses agentes para
-- `active` — isso colocaria em serviço um agente sem profile ativo, sem papel
-- padrão e sem política de canal, que é o desastre que a saga existe para
-- evitar.
--
-- Fail-closed, então: agentes em `provisioning` viram `paused` — o único valor
-- do vocabulário antigo que significa "não está operando". A informação
-- "estava em onboarding" não se perde: ela continua legível em
-- `onboarding_runs` (estado da run) e em `admin_audit_log`
-- (`onboarding_agent_provisioned`), que são append-only.

UPDATE agents SET status = 'paused', updated_at = now() WHERE status = 'provisioning';

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;

ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('active', 'paused', 'archived'));

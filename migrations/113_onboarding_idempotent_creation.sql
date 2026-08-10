-- 113 — Onboarding: criação idempotente da saga, resultados conclusivos
-- TIPADOS e ponto de retomada explícito (issue #519, review adversarial do
-- PR #541, achados 2, 3 e 4).
--
-- Três defeitos distintos, um único arquivo porque as três correções tocam as
-- mesmas duas tabelas e precisam ser atômicas entre si: um deploy que aplicasse
-- só parte disto deixaria o código novo escrevendo colunas inexistentes.
--
-- ─── (2) A CRIAÇÃO DA RUN NÃO ERA IDEMPOTENTE ───────────────────────────────
-- `startOnboardingRun` não aceitava idempotency key nem procurava resultado
-- anterior: cada retry (ou duplo-clique no console) inseria OUTRA run e OUTRA
-- trilha. Isso viola dois invariantes do contrato da issue — "cada comando
-- mutável é idempotente" e "retry após timeout devolve o resultado anterior" —
-- justamente no comando que abre a saga.
--
-- E o índice existente NÃO cobria o buraco:
--
--   onboarding_runs_one_live_per_agent_uq ON (tenant_id, agent_id)
--     WHERE agent_id IS NOT NULL AND state NOT IN (terminais)
--
-- O predicado `agent_id IS NOT NULL` exclui exatamente a fase em que a run
-- ainda não tem agente — isto é, de `created` até `provision_agent`, que é
-- metade da saga. Duas runs `tenant_onboarding` em `created` para o MESMO
-- tenant coexistiam alegremente e provisionavam árvores de governança
-- diferentes (dois admins, dois agentes, dois papéis padrão).
--
-- Duas colunas + dois índices fecham os dois lados:
--   * `creation_idempotency_key_hash` + `creation_payload_hash` materializam o
--     ledger de criação NA PRÓPRIA RUN (não há tabela filha onde guardá-lo:
--     `onboarding_step_results.run_id` é FK para a run que ainda não existe).
--     O retry com a MESMA chave encontra a run já materializada e a replaya.
--   * `onboarding_runs_one_live_per_tenant_uq` é o espelho do índice existente
--     para o intervalo `agent_id IS NULL`: no máximo UMA run viva sem agente
--     por tenant. Assim que a run adquire `agent_id` (passo `provision_agent`)
--     ela sai deste índice e entra no de par completo — dois agentes do mesmo
--     tenant continuam podendo ser onboardados em paralelo a partir daí.
--
-- Por que a chave de criação é escopada por `(kind, tenant, hash)` e não só
-- pelo hash: a idempotency key é opaca e escolhida pelo CLIENTE. Duas sessões
-- administrativas de tenants diferentes podem, legitimamente, gerar a mesma
-- chave; colidi-las globalmente devolveria a run de OUTRO tenant para quem
-- fizesse retry — um vazamento horizontal criado pela própria idempotência.
-- `COALESCE(tenant_id, '')` porque uma run `global_bootstrap` nasce sem tenant
-- e, em índice único, NULLs são todos distintos entre si (a deduplicação
-- desapareceria em silêncio exatamente no caso sem tenant).
--
-- ─── (3) NEGAÇÕES E CANCELAMENTO NÃO TINHAM REPLAY ──────────────────────────
-- `onboarding_step_results` só recebia SUCESSOS. Uma NEGATIVA de governança
-- (`deny`) avançava versão e estado, auditava — e não deixava nada no ledger.
-- Consequência: se a resposta se perdesse na rede, repetir a MESMA chave com a
-- MESMA versão devolvia `version_conflict` (a versão já tinha avançado) em vez
-- da negativa anterior, e a mesma chave com payload DIFERENTE deixava de
-- produzir `idempotency_payload_mismatch` — a proteção contra reciclagem de
-- chave sumia justamente no caminho de recusa. O cancelamento era pior: não
-- aceitava chave nenhuma, e o retry pós-commit virava `run_terminal`.
--
-- `outcome_kind` torna o ledger um registro de resultados CONCLUSIVOS tipados
-- (sucesso / negação / cancelamento) em vez de "coisas que deram certo".
-- `outcome_code`/`outcome_message` guardam o veredito para que o replay
-- devolva a MESMA resposta, não uma aproximação. O DEFAULT 'success' mantém
-- as linhas já gravadas semanticamente corretas sem backfill.
--
-- O cancelamento entra no mesmo ledger sob o pseudo-passo `cancel_run`: a
-- coluna `step` não tem CHECK (deliberadamente — ver 109), e o unique
-- `(run_id, step, idempotency_key_hash)` já dá a chave certa. Não há tabela
-- nova porque não há conceito novo: cancelar é um comando conclusivo da run.
--
-- ─── (4) `failed_retryable` PERDIA O PONTO DE RETOMADA ──────────────────────
-- O estado dizia "reexecute o mesmo passo", mas não guardava QUAL passo falhou,
-- e toda definição aceitava `failed_retryable` como origem. Depois de uma
-- negativa em `start_pairing` o backend passava a admitir `provision_tenant`,
-- `provision_admin`, `declare_channel` ou `evaluate_readiness` — passos que
-- rebobinam o estado materializado ou criam recursos adicionais.
--
-- `failed_step` (o passo que falhou) e `resume_state` (o estado de onde ele
-- partiu) tornam a retomada um fato PERSISTIDO, não uma suposição. A máquina
-- de estados passa a autorizar, a partir de `failed_retryable`, apenas o retry
-- do próprio passo e as remediações explicitamente declaradas para ele.
--
-- Os CHECKs abaixo pinam os dois vocabulários no banco: um `failed_step` fora
-- de `ONBOARDING_STEPS` ou um `resume_state` fora de `ONBOARDING_STATES` são
-- recusados pelo Postgres antes de a máquina de estados ter que decidir o que
-- fazer com um valor que ela não conhece.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP
-- CONSTRAINT IF EXISTS). Sem BEGIN/COMMIT: o runner (`src/migrations/`) já
-- envolve cada arquivo numa transação.

-- ── (2) criação idempotente ──────────────────────────────────────────────────

ALTER TABLE onboarding_runs
  ADD COLUMN IF NOT EXISTS creation_idempotency_key_hash text;

ALTER TABLE onboarding_runs
  ADD COLUMN IF NOT EXISTS creation_payload_hash text;

-- Os dois hashes andam juntos: sem o payload não há como detectar a chave
-- reciclada para outra intenção, e um payload sem chave não identifica nada.
ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_creation_key_pair_ck;
ALTER TABLE onboarding_runs ADD CONSTRAINT onboarding_runs_creation_key_pair_ck CHECK (
  (creation_idempotency_key_hash IS NULL) = (creation_payload_hash IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_runs_creation_key_uq
  ON onboarding_runs (kind, COALESCE(tenant_id, ''), creation_idempotency_key_hash)
  WHERE creation_idempotency_key_hash IS NOT NULL;

-- O espelho de `onboarding_runs_one_live_per_agent_uq` para o intervalo que
-- ele não cobre: a run ainda SEM agente. Mesma lista de estados terminais —
-- um re-onboarding depois de `active`/`cancelled`/`failed_terminal` continua
-- possível.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_runs_one_live_per_tenant_uq
  ON onboarding_runs (tenant_id)
  WHERE tenant_id IS NOT NULL
    AND agent_id IS NULL
    AND state NOT IN ('active', 'cancelled', 'failed_terminal');

-- ── (4) ponto de retomada ────────────────────────────────────────────────────

ALTER TABLE onboarding_runs ADD COLUMN IF NOT EXISTS failed_step text;
ALTER TABLE onboarding_runs ADD COLUMN IF NOT EXISTS resume_state text;

ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_failed_step_ck;
ALTER TABLE onboarding_runs ADD CONSTRAINT onboarding_runs_failed_step_ck CHECK (
  failed_step IS NULL OR failed_step IN (
    'provision_tenant',
    'provision_admin',
    'provision_agent',
    'configure_profile',
    'apply_capability_packs',
    'configure_role',
    'declare_channel',
    'start_pairing',
    'confirm_channel_ready',
    'evaluate_readiness',
    'activate'
  )
);

ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_resume_state_ck;
ALTER TABLE onboarding_runs ADD CONSTRAINT onboarding_runs_resume_state_ck CHECK (
  resume_state IS NULL OR resume_state IN (
    'created',
    'tenant_ready',
    'admin_ready',
    'agent_draft',
    'profile_ready',
    'capabilities_ready',
    'policy_ready',
    'channel_declared',
    'pairing_pending',
    'channel_ready',
    'ready_for_activation',
    'activating',
    'active',
    'readiness_failed',
    'failed_retryable',
    'failed_terminal',
    'cancelled'
  )
);

-- Uma run em `failed_retryable` SEM ponto de retomada é irretomável por
-- construção (a máquina de estados recusa tudo, fail-closed). O CHECK torna
-- esse estado impossível de gravar em vez de deixá-lo aparecer como uma run
-- travada que ninguém sabe destravar.
ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_retry_point_ck;
ALTER TABLE onboarding_runs ADD CONSTRAINT onboarding_runs_retry_point_ck CHECK (
  state <> 'failed_retryable' OR failed_step IS NOT NULL
);

-- ── (3) resultados conclusivos tipados ───────────────────────────────────────

ALTER TABLE onboarding_step_results
  ADD COLUMN IF NOT EXISTS outcome_kind text NOT NULL DEFAULT 'success';

ALTER TABLE onboarding_step_results ADD COLUMN IF NOT EXISTS outcome_code text;
ALTER TABLE onboarding_step_results ADD COLUMN IF NOT EXISTS outcome_message text;

ALTER TABLE onboarding_step_results DROP CONSTRAINT IF EXISTS onboarding_step_results_outcome_kind_ck;
ALTER TABLE onboarding_step_results ADD CONSTRAINT onboarding_step_results_outcome_kind_ck CHECK (
  outcome_kind IN ('success', 'denied', 'cancelled')
);

-- Um resultado NÃO-sucesso sem código é indistinguível de um sucesso na hora
-- do replay — e o replay é a única coisa que esta tabela existe para sustentar.
ALTER TABLE onboarding_step_results DROP CONSTRAINT IF EXISTS onboarding_step_results_outcome_code_ck;
ALTER TABLE onboarding_step_results ADD CONSTRAINT onboarding_step_results_outcome_code_ck CHECK (
  outcome_kind = 'success' OR outcome_code IS NOT NULL
);

-- "Que negativas esta run já produziu?" é a pergunta do diagnóstico de uma
-- saga travada, e ela varre por run + tipo de resultado.
CREATE INDEX IF NOT EXISTS onboarding_step_results_outcome_idx
  ON onboarding_step_results (run_id, outcome_kind, created_at);

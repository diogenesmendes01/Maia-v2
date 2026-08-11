-- 110 — `agents.status` ganha o valor `provisioning` (issue #519, follow-up).
--
-- O PROBLEMA
--   `migrations/007_p0_tenants_agents.sql:17` declarou
--     status TEXT NOT NULL DEFAULT 'active'
--       CHECK (status IN ('active','paused','archived'))
--   e a saga de onboarding cria o agente com `status='provisioning'`
--   (`src/onboarding/provisioning.ts`, passo `provision_agent`), porque o
--   contrato central da saga é: **o agente não é operável até o comando
--   explícito de ativação**. Contra Postgres real isso é 23514 — o passo
--   `provision_agent` nunca commitava.
--
-- POR QUE UM VALOR NOVO, E NÃO REAPROVEITAR `paused`
--   `paused` já significa uma coisa, e ela é diferente: "esteve ativo e foi
--   deliberadamente parado". As consequências de mentir aqui são concretas:
--     * REMEDIAÇÃO ERRADA. A ação óbvia diante de `paused` é despausar. Fazer
--       isso num agente meio-provisionado coloca em serviço um agente sem
--       profile ativo, sem papel padrão e sem política de canal — exatamente o
--       estado que o readiness existe para barrar.
--     * FORENSE PERDIDA. "onboarding abandonado no meio" e "operador pausou um
--       agente saudável" viram o mesmo registro, e a auditoria deixa de
--       distinguir os dois.
--     * O CHECK `agent_activated` do readiness (`src/onboarding/readiness.ts`)
--       existe para o doctor separar "pronto e ativo" de "pronto, ainda não
--       ativado". Sem um estado próprio, "nunca esteve ativo" não é dizível.
--   `archived` é pior ainda: é fim de vida, não começo.
--
-- AUDITORIA DOS CONSUMIDORES DE `agents.status` (feita antes de escolher):
--   * `src/admin-ui/trpc/routers/dashboard.ts:33` — `a.status === 'active'`.
--     Um agente `provisioning` deixa de ser contado como ativo: correto.
--   * `src/onboarding/readiness.ts` (check `agent_activated`) — `=== 'active'`,
--     advisório. Correto: `provisioning` é justamente "ainda não ativado".
--   * `src/admin-ui/components/ui/badge.tsx:72` `StatusBadge` — mapa
--     `Record<string, BadgeTone>` com fallback `?? 'neutral'`; um status novo
--     renderiza como badge neutro com o literal. Não quebra.
--   * `src/admin-ui/trpc/routers/agents.ts:51` `z.enum(['active','suspended'])`
--     — schema de ENTRADA do console. `provisioning` não passa a ser
--     escrevível por lá, e é isso que se quer: só a saga o escreve, e só a
--     ativação o remove.
--   * `migrations/015_p0_agents_tenant_status_idx.sql` — índice
--     `(tenant_id, status)`; um valor a mais é transparente.
--   Nenhum consumidor enumera o conjunto como fechado em caminho de decisão.
--
-- Idempotente via DROP CONSTRAINT IF EXISTS. Sem BEGIN/COMMIT: o runner
-- (`src/migrations/`) já envolve cada arquivo numa transação.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;

ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('active', 'paused', 'archived', 'provisioning'));

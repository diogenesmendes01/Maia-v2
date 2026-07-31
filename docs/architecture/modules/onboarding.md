# onboarding

**Path:** `src/onboarding/`

**Purpose** — Provisionamento administrativo de produção (issue #519): uma saga DURÁVEL que leva uma instalação de "banco vazio" a "agente atendendo numa linha WhatsApp", em sequência governada, retomável, idempotente e auditada.

O que este módulo substitui é um conjunto de telas e scripts independentes onde o operador podia criar entidades fora de ordem e terminar em estados intermediários difíceis de detectar: tenant sem administrador utilizável, agente `active` com perfil ainda `proposed`, pack aplicado sem papel/política coerentes, linha declarada mas invisível na checklist, "prontidão global" calculada pela presença de QUALQUER perfil e QUALQUER canal.

## O que "transacional" significa aqui

Uma saga com **transação SQL curta por comando** e **uma transição final de ativação atômica**. NÃO significa manter uma transação aberta enquanto o operador lê instruções, aprova políticas ou escaneia um QR code — isso travaria linhas por minutos e morreria no primeiro timeout de proxy.

Cada passo executa em três transações curtas:

1. **CLAIM** (`claimStep`) — trava a run com `FOR UPDATE`, valida versão/escopo/expiração/transição e insere a linha `pending` do ledger de idempotência.
2. **EFEITO** — o repo de domínio correspondente faz o trabalho e escreve a própria auditoria, atomicamente (`tenantsRepo.createWithAuditAtomic`, `agentsRepo.createWithSeedAndAudit`, `rolesRepo.createWithAudit`, `channelsRepo.createWithAudit`, `operationalProfileVersionsRepo.approveAndActivateAtomic`).
3. **COMPLETE** (`completeStep`) — grava o resultado no ledger, avança estado/passo/escopo e escreve evento + `admin_audit_log` no MESMO commit.

Uma queda entre 1 e 2 (ou entre 2 e 3) deixa o ledger em `pending`. O retry com a MESMA chave reencontra a reivindicação, refaz o efeito — que devolve `duplicate_*` porque o recurso já existe — e o serviço **adota** o recurso em vez de duplicar. A adoção só acontece em retomada e só quando a identidade bate e o recurso está no escopo da run; fora disso, duplicata é conflito.

## Key files

| File | Role |
|---|---|
| `src/onboarding/state-machine.ts` | Vocabulário (kinds, estados, passos) + tabela de transições + códigos de erro sanitizados. **Puro** — zero imports de banco, config ou rede |
| `src/onboarding/commands.ts` | Contrato Zod de cada comando. Compartilhado por router e serviço para que o hash de idempotência seja calculado sobre o payload JÁ validado |
| `src/onboarding/readiness.ts` | `evaluateAgentReadiness(tenantId, agentId)` — o readiness CANÔNICO por `tenant_id + agent_id`, com `checks[]`, `remediation` e os dois fingerprints |
| `src/onboarding/service.ts` | Orquestração: efeito de cada passo, adoção em retomada, métricas, ativação em três momentos |
| `src/db/repositories/onboarding-repos.ts` | Persistência: CAS por `version`, ledger de idempotência, eventos append-only, credencial de bootstrap |
| `src/admin-ui/trpc/routers/onboarding.ts` | Superfície tRPC (autenticada; duas procedures públicas só para o bootstrap global) |
| `src/admin-ui/app/onboarding/` | Wizard: lista/retomada, formulário do passo corrente, painel de prontidão, linha do tempo |
| `scripts/bootstrap-credential.ts` | Emissão/revogação da credencial de uso único do bootstrap global |

## Máquina de estados

```
created → tenant_ready → admin_ready → agent_draft → profile_ready
  → capabilities_ready → policy_ready → channel_declared → pairing_pending
  → channel_ready → ready_for_activation → activating → active
```

Laterais: `readiness_failed`, `failed_retryable`, `failed_terminal`, `cancelled`.

Duas decisões que valem registrar:

- **`role` produz `policy_ready`, e `channel` cria a linha E a política juntas.** A issue lista "papel" e "política de canal" como passos separados, mas `channel_policies.channel_id` é FK: uma política não pode existir antes do canal. Fatiar diferente produziria uma política órfã (impossível no schema) ou um canal permanentemente sem política — o "canal ativo sem governança" que a #518 fechou.
- **`pairing`, `readiness` e `activation` não passam pelo ledger.** São avaliações/declarações de intenção, não criações. Registrá-las lá tornaria impossível o que elas precisam ser: REPETÍVEIS (reparear, reavaliar depois de consertar a política, tentar ativar de novo). A idempotência do pareamento vive no `command_id` da #518; a da avaliação é intrínseca.

## Readiness canônico

Wizard, dashboard, checklist e ativação passam a perguntar para a MESMA função. A regra de ouro: **é proibido compor readiness com recursos de agentes diferentes** — toda consulta carrega o par, e o que volta do banco é reconferido contra o escopo pedido antes de contar como evidência.

Retorno tipado: `ready`, `checks[]` (`code`, `status`, `severity`, `message`, `remediation`), `evaluated_at`, `configuration_fingerprint`, `schema_fingerprint`. Um check `advisory` (hoje só `channel_routing_active`) NÃO bloqueia — travar a ativação do agente nele criaria um deadlock com o gate da #518, que só ativa o roteamento quando a política fica pronta.

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — toda leitura de run é escopada por `actor_tenant_id`/`tenant_id`; uma run de outro tenant devolve `null`, nunca "proibido" (a diferença entre as duas respostas é o oráculo que permitiria enumerar runs alheias). `cross_tenant` só para founder.
- [Governance + observability](../concerns/governance-observability.md) — toda transição produz evento append-only E `admin_audit_log` no mesmo commit; métricas com rótulos de enum fechado (`kind`, `step`, `reason`, `check_code`), nunca id de run, tenant nome, e-mail ou telefone.
- Fail-closed: agente nasce `paused`; a ativação exige laudo verde REAVALIADO dentro da transição; readiness parcial nunca ativa; segredo do bootstrap só existe como SHA-256.
- Reuso da #518 — o pareamento é o `LinePairingModal` + a fila durável de comandos de `channel_line_state`. Este módulo não fala com o Baileys.

## How to extend

| Need | Where |
|---|---|
| Adicionar um passo | `state-machine.ts` (`ONBOARDING_STEPS` + `TRANSITIONS`), a CHECK da migration 113, o schema em `commands.ts`, o efeito em `service.ts`, o rótulo em `src/admin-ui/app/onboarding/_components/labels.ts` (um teste amarra os dois lados) |
| Adicionar um check de prontidão | `readiness.ts` (`READINESS_CHECK_CODES` + o corpo). Todo check precisa de código estável, mensagem sanitizada e remediação |
| Adicionar uma métrica | `src/observability/taxonomy.ts` — rótulo novo exige entrada no allowlist e um budget de cardinalidade |
| Mudar a política de expiração | `RUN_TTL_MS` / `STEP_CLAIM_TTL_MS` em `onboarding-repos.ts` |
| Operar uma run travada | [`docs/runbooks/onboarding-wizard.md`](../../runbooks/onboarding-wizard.md) |

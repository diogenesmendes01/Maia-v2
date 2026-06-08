# Agenda como capacidade base de todo agente — design

> Data: 2026-06-08 · Branch: `claude/calendar-default-pack`

## 1. Problema

Um owner pediu à Maia "cria um lembrete para pagar a conta de luz em 3 minutos" e recebeu *"a função de agendamento automático ainda não está ativa no seu ambiente"*. A resposta é honesta: a capacidade **existe** (tool `schedule_reminder` + `src/scheduling/engine.ts` + os workers `scheduling_tick`/`pending_reminder`), mas **não está concedida ao agente**.

Causa, por design: `DEFAULT_AGENT_PACKS = ['baseline.core']` (`src/tools/grant-math.ts:130`) e domain packs **nunca** são auto-concedidos. A `schedule_reminder` mora no `DOMAIN_CALENDAR_PACK` (`domain.calendar`), que só viria por grant explícito ou role. Todo agente nasce só com `baseline.core` (10 tools de conversa/governança), então o runtime-filter nunca expõe a tool ao LLM.

Decisão do owner: **agenda/lembrete deve ser capacidade base de qualquer agente**, em qualquer tenant.

## 2. Decisões (do brainstorming)

| Decisão | Escolha |
|---|---|
| Escopo do universal | As **7 tools** do calendar: 5 consultas read-only de data/feriado + `schedule_reminder` + `cancel_reminder`. **`register_custom_holiday` fica de fora** (tool de owner, write que altera o calendário do tenant). |
| Alcance | Agentes **existentes (via backfill) + novos**. |
| Skill nova? | **Não.** O grant já torna as tools visíveis (ver §4). |
| Governança | Lembrete + consultas rodam **direto**. `register_custom_holiday` não é universal → some o risco de agente externo mexer no tenant e a necessidade de confirmação. |
| Abordagem de auto-grant | Lista **`PLATFORM_DEFAULT_DOMAIN_PACKS`** separada (calendar continua *domain*, só que auto-concedido) — preserva a semântica de `baseline` e de `DEFAULT_AGENT_PACKS`. |

Restrições que moldam o design:
- **Jogar no `baseline.core`** → bloqueado pelo guard `assertConservative` (`src/tools/packs.ts`): proíbe tool `write` não-allowlistada no baseline.
- **`register_custom_holiday` universal com confirmação** → a confirmação vem da skill selecionada (`skill.requires_confirmation_tools`, `src/runtime/decision/action-decider.ts:294`); no modelo grant-só não há como impô-la. Por isso `register_custom_holiday` saiu do escopo universal.
- **⚠️ O floor `baseline.core` é hardcoded como LITERAL em vários lugares, não derivado de `defaultAgentGrant()`** (decisão deliberada para manter `repositories.ts`/`schema.ts` livres da cadeia de import tools-registry/gateway — comentário em `repositories.ts:4691-4694`). Os sites (verificados pelo review):
  - `src/tools/grant-math.ts:130` — `DEFAULT_AGENT_PACKS`.
  - `src/tools/grant-math.ts:~643` — `defaultAgentGrant()`.
  - `src/db/repositories.ts:~4778-4784` — `createWithSeedAndAudit` insere `granted_packs: ['baseline.core']` (literal).
  - `src/db/repositories.ts:~4808` — payload de audit `default_tool_packs: ['baseline.core']`.
  - `src/db/repositories.ts:~432` — `agentToolGrantsRepo.findForCurrentAgent` fallback (sem row → baseline).
  - `src/tools/runtime-filter.ts:115` e `src/tools/_dispatcher.ts:100` — fallback (sem row → baseline).
  - `src/db/schema.ts:323` — column DEFAULT `'{baseline.core}'::text[]`.

Verificado: **nada hoje concede `domain.calendar` nem usa `register_custom_holiday`** fora da própria tool e do catálogo gerado — então redefinir/separar os packs é seguro.

## 3. Componentes

### 3.1 Estrutura de packs (`src/tools/grant-math.ts`)
- `DOMAIN_CALENDAR_PACK` (`domain.calendar`) passa a conter as **7 tools** universais (remove `register_custom_holiday`).
- Novo `DOMAIN_CALENDAR_ADMIN_PACK` (`domain.calendar.admin`) contém **`register_custom_holiday`** — concessão explícita. Registrado em `DOMAIN_PACKS`/`TOOL_PACKS`, validado por `assertDomainPackToolsKnown`.
- O `default_for_agent_type: ['operacoes','agenda']` do calendar pack fica **inalterado** (é ortogonal ao auto-grant da plataforma; não atrapalha).

### 3.2 Fonte única de verdade + auto-grant
Para a feature funcionar para agentes **novos**, todos os sites de floor da §2 precisam passar a conceder `baseline.core ∪ domain.calendar` — e sem o drift que 6 literais separados causariam.

- **Extrair `BASE_AGENT_PACKS`** para um módulo leve e sem dependências pesadas (ex.: `src/tools/base-agent-packs.ts`, contendo SOMENTE `export const BASE_AGENT_PACKS = ['baseline.core', 'domain.calendar'] as const`). Zero imports de registry/gateway → seguro para `repositories.ts` importar sem violar a separação que o comentário `4691-4694` protege. (O plano valida ausência de ciclo de import.)
- **Reapontar para `BASE_AGENT_PACKS`** todos os sites de literal: `defaultAgentGrant()`, o seed `createWithSeedAndAudit` (`granted_packs` + o payload de audit), e os 3 fallbacks (`repositories.ts:432`, `runtime-filter.ts:115`, `_dispatcher.ts:100`). Assim o "floor" é consistente quer o agente tenha grant row, quer caia no fallback.
- `DEFAULT_AGENT_PACKS` (= `['baseline.core']`) e `PLATFORM_DEFAULT_DOMAIN_PACKS` (= `['domain.calendar']`) permanecem como a decomposição semântica; `BASE_AGENT_PACKS = [...DEFAULT_AGENT_PACKS, ...PLATFORM_DEFAULT_DOMAIN_PACKS]` (com um teste pinando essa igualdade).
- **Column default** (`schema.ts:323`): atualizado para `'{baseline.core,domain.calendar}'` via a **mesma migration** do backfill (não dá pra referenciar a constante TS no SQL — é o único site que fica como literal SQL, coberto por teste).
- **`resolveGrantedToolNames` fica como está** (`grant-math.ts:~518`): ela une `BASELINE_CORE_PACK.tools` incondicionalmente como floor. O calendar entra via o **grant row / fallbacks** (acima), NÃO via essa união — assim `denied_tools` e o split do `domain.calendar.admin` continuam funcionando. Não é site de repoint.

### 3.3 Backfill dos existentes (migration `081_calendar_default_pack`)
- Dois arquivos (convenção do repo): `081_*.sql` (`_up`) + `081_*_down.sql`.
- **Reservar o prefixo `081`** em `migrations/RESERVATIONS.md` (via `npm run migrate:reserve`) — o CI guard `migration-prefix-guard.yml` reprova migration sem reserva.
- `_up`: (a) para cada linha de `agent_tool_grants` cujo `granted_packs` **não** contém `domain.calendar`, adiciona o pack (idempotente, respeita `denied_tools`); (b) altera o column DEFAULT de `granted_packs` para incluir `domain.calendar`.
- `_down`: remove `domain.calendar` dos grants e reverte o column DEFAULT (conservador/reversível).

### 3.4 Governança & isolamento
- Lembrete (`schedule_reminder`/`cancel_reminder`) e as 5 consultas rodam direto; a Maia confirma conversacionalmente.
- `register_custom_holiday` **não** é auto-concedido → fora do alcance de agentes de atendimento externo.
- Isolamento inalterado: cada lembrete é escopado por `(tenant_id, agent_id)` na engine de scheduling (`src/scheduling/repos.ts` + migrations 071-073). O grant é **por-agente** → vale para todos os tenants **sem seed por-tenant**.

## 4. Visibilidade (por que não precisa de skill)

`computeRuntimeVisibleTools` (`src/tools/runtime-filter.ts`) compõe `agent grant ∩ active-role packs ∩ skill scope`. `skillScope` e `roleScope` são **opcionais** (narrow-only; `computeAgentVisibleTools`, `grant-math.ts:~569`). Num turno **sem skill selecionada**, o conjunto visível = todos os tools dos packs concedidos (foi por isso que os 10 do `baseline.core` apareceram no turno "quem é você?"). Logo, conceder `domain.calendar` torna `schedule_reminder` visível ao LLM — sem criar skill.

Risco residual: se algum dia o skill-selector commitar uma skill que **não** inclui a tool num turno de "criar lembrete", a tool seria estreitada para fora. Não acontece hoje (nenhuma das 16 skills casa "criar lembrete"). Mitigação (follow-up, YAGNI): criar uma skill de agendamento se observado.

## 5. Testes

- **Fonte de verdade**: `BASE_AGENT_PACKS == [...DEFAULT_AGENT_PACKS, ...PLATFORM_DEFAULT_DOMAIN_PACKS]` e `BASE_AGENT_PACKS` contém `domain.calendar`.
- **Revisar todos os casos de** `tests/unit/tools/agent-tool-grants.spec.ts` — os que assertam sobre `defaultAgentGrant()` (`:45-52`) mudam (agora inclui as tools de calendar); os que testam um grant explicitamente SEM domain pack (ex.: `:30-43`) permanecem == BASELINE. Distinguir os dois.
- **Novo teste de seed (o gap que o review apontou)**: após `createWithSeedAndAudit`, a **linha de grant semeada** contém `domain.calendar` — pinando o LITERAL do repo, não só `defaultAgentGrant()`. Idem para o fallback `findForCurrentAgent` (sem row → inclui calendar).
- **Guards de pack**: `assertConservative` (baseline intacto), `assertDomainPackToolsKnown` (os dois calendar packs válidos), `assertPackToolsExist`.
- **Backfill**: agente legado ganha `domain.calendar`; idempotente (2× não duplica); respeita `denied_tools`; column DEFAULT novo aplicado.
- **Visibilidade**: turno sem skill + grant de calendar → `schedule_reminder` no conjunto visível; `register_custom_holiday` **ausente** (só com `domain.calendar.admin`).

## 6. Fora de escopo / follow-ups

- Skill dedicada de agendamento (só se §4 virar problema real).
- Conceder `domain.calendar.admin` a um role de operações/owner (decisão de produto separada).
- Habilitar packs financeiros (`domain.finance`) — outro épico.

## 7. Riscos

- **Baixo.** O grant só amplia capacidade; engine de scheduling e isolamento já existem e não mudam. Reversível pela migration `_down` e por `denied_tools` por-agente.
- O maior risco de implementação é **deixar um dos sites de literal `baseline.core` para trás** → mitigado pela constante única `BASE_AGENT_PACKS` + os testes de seed/fallback de §5.
- A separação de packs é segura porque nada hoje concede `domain.calendar`.

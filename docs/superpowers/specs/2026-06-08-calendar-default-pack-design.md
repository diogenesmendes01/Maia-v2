# Agenda como capacidade base de todo agente — design

> Data: 2026-06-08 · Branch: `claude/calendar-default-pack`

## 1. Problema

Um owner pediu à Maia "cria um lembrete para pagar a conta de luz em 3 minutos" e recebeu *"a função de agendamento automático ainda não está ativa no seu ambiente"*. A resposta é honesta: a capacidade **existe** no sistema (tool `schedule_reminder` + `src/scheduling/engine.ts` + os workers `scheduling_tick`/`pending_reminder`), mas **não está concedida ao agente**.

Causa, por design: `DEFAULT_AGENT_PACKS = ['baseline.core']` (`src/tools/grant-math.ts:130`) e domain packs **nunca** são auto-concedidos. A `schedule_reminder` mora no `DOMAIN_CALENDAR_PACK` (`domain.calendar`), que só viria por grant explícito ou role. Todo agente nasce só com `baseline.core` (10 tools de conversa/governança), então o runtime-filter nunca expõe a tool ao LLM.

Decisão do owner: **agenda/lembrete deve ser capacidade base de qualquer agente**, em qualquer tenant.

## 2. Decisões (do brainstorming)

| Decisão | Escolha |
|---|---|
| Escopo do universal | As **7 tools** do calendar: 5 consultas read-only de data/feriado + `schedule_reminder` + `cancel_reminder`. **`register_custom_holiday` fica de fora** (tool de owner, write que altera o calendário do tenant). |
| Alcance | Agentes **existentes (via backfill) + novos**. |
| Skill nova? | **Não.** O grant já torna as tools visíveis (confirmado em §4). |
| Governança | Lembrete + consultas rodam **direto**. `register_custom_holiday` não é universal → some o risco de agente externo mexer no tenant e a necessidade de confirmação. |
| Abordagem de auto-grant | Lista **`PLATFORM_DEFAULT_DOMAIN_PACKS`** separada (calendar continua *domain*, só que auto-concedido) — preserva a semântica de `baseline` e de `DEFAULT_AGENT_PACKS`. |

Restrição que descartou alternativas:
- **Jogar no `baseline.core`** → bloqueado pelo guard `assertConservative` (`src/tools/packs.ts`): proíbe tool `write` não-allowlistada no baseline.
- **`register_custom_holiday` universal com confirmação** → a confirmação vem da skill selecionada (`skill.requires_confirmation_tools`, `src/runtime/decision/action-decider.ts:294`); no modelo grant-só (sem skill) não há como impô-la. Por isso `register_custom_holiday` saiu do escopo universal.

Verificado: **nada hoje concede `domain.calendar` nem usa `register_custom_holiday`** fora da própria tool e do catálogo gerado — então redefinir/separar os packs é seguro.

## 3. Componentes

### 3.1 Estrutura de packs (`src/tools/grant-math.ts`)
- `DOMAIN_CALENDAR_PACK` (`domain.calendar`) passa a conter as **7 tools** universais (remove `register_custom_holiday`).
- Novo `DOMAIN_CALENDAR_ADMIN_PACK` (`domain.calendar.admin`) contém **`register_custom_holiday`** — concessão explícita (ex.: a um role de operações/owner). Registrado em `DOMAIN_PACKS`/`TOOL_PACKS` e validado pelos guards existentes (`assertDomainPackToolsKnown`).

### 3.2 Auto-grant
- Nova constante `export const PLATFORM_DEFAULT_DOMAIN_PACKS: readonly string[] = ['domain.calendar']`, **separada** de `DEFAULT_AGENT_PACKS` (que segue `['baseline.core']`).
- `defaultAgentGrant()` passa a retornar `granted_packs: [...DEFAULT_AGENT_PACKS, ...PLATFORM_DEFAULT_DOMAIN_PACKS]`. Agentes novos nascem com agenda.
- O seed do grant default na criação do agente (`src/db/repositories.ts:~4682`) herda isso por usar `defaultAgentGrant()`.

### 3.3 Backfill dos existentes (migration `0XX_calendar_default_pack.sql`)
- Idempotente: para cada linha de `agent_tool_grants` cujo `granted_packs` **não** contém `domain.calendar`, adiciona o pack.
- Respeita `denied_tools` (não remove denies; um agente que tenha negado uma tool de calendar continua sem ela).
- `_up` adiciona; `_down` remove `domain.calendar` dos grants que ele inseriu (reversível, conservador).

### 3.4 Governança & isolamento
- Lembrete (`schedule_reminder`/`cancel_reminder`) e as 5 consultas rodam direto; a Maia confirma conversacionalmente ("vou te lembrar em 3 min").
- `register_custom_holiday` **não** é auto-concedido → fora do alcance de agentes de atendimento externo.
- Isolamento inalterado: cada lembrete é escopado por `(tenant_id, agent_id)` na engine de scheduling. O grant é **por-agente** → vale para todos os tenants **sem seed por-tenant**.

## 4. Visibilidade (por que não precisa de skill)

`computeRuntimeVisibleTools` (`src/tools/runtime-filter.ts`) compõe `agent grant ∩ active-role packs ∩ skill scope`. `skillScope` e `roleScope` são **opcionais** (narrow-only). Num turno de conversa **sem skill selecionada**, o conjunto visível = todos os tools dos packs concedidos (foi por isso que os 10 do `baseline.core` apareceram no turno "quem é você?"). Logo, conceder `domain.calendar` torna `schedule_reminder` visível ao LLM quando o usuário pede um lembrete — sem criar skill.

Risco residual: se algum dia o skill-selector commitar uma skill que **não** inclui a tool num turno de "criar lembrete", a tool seria estreitada para fora. Não acontece hoje (nenhuma das 16 skills casa "criar lembrete"). Mitigação (follow-up, YAGNI): criar uma skill de agendamento se isso for observado.

## 5. Testes

- **Paridade** (`tests/unit/...`): atualizar o teste que pina `DEFAULT_AGENT_PACKS` ↔ `defaultAgentGrant()` para incluir `PLATFORM_DEFAULT_DOMAIN_PACKS`.
- **Guards de pack**: `assertConservative` (baseline intacto), `assertDomainPackToolsKnown` (os dois calendar packs válidos), `assertPackToolsExist`.
- Novo agente nasce com `domain.calendar` no grant; **não** com `domain.calendar.admin`.
- Backfill: agente legado ganha `domain.calendar`; idempotente (rodar 2× não duplica); respeita `denied_tools`.
- Visibilidade: turno sem skill com o grant de calendar → `schedule_reminder` no conjunto visível; `register_custom_holiday` **ausente**.
- `register_custom_holiday` só visível quando `domain.calendar.admin` é concedido.

## 6. Fora de escopo / follow-ups

- Skill dedicada de agendamento (só se §4 virar problema real).
- Conceder `domain.calendar.admin` a um role de operações/owner (decisão de produto separada).
- Habilitar packs financeiros (`domain.finance`) — a Maia se apresenta como financeira completa, mas isso é outro épico.

## 7. Riscos

- **Baixo.** O grant só amplia capacidade; a engine de scheduling e o isolamento já existem e não mudam. Reversível pela migration `_down` e por `denied_tools` por-agente.
- A separação de packs é segura porque nada hoje concede `domain.calendar`.

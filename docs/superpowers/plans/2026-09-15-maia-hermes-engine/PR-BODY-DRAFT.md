## Summary

RASCUNHO LOCAL — esta PR NÃO foi aberta. O corpo abaixo está preparado para quando o dono
autorizar o push da branch `claude/mh-integracao-c57` e a abertura contra a `main`.

Épica Maia + Hermes (spec `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`): etapas P00–P03, a maior parte do
P04 (controle humano) e as fatias de contrato/política de P05, P06 e P07. O histórico foi
reconstruído para cumprir o gate de trailers (C57) sem mudar nenhuma árvore de commit; o
mapeamento original → reconstruído está em `C57-RECONSTRUCAO-E-INTEGRACAO.md`.

Sem issue vinculada. O nome da worktree de origem (`github-issue-498-…`) não é referência a issue.

## Task Context

- Task spec: `docs/superpowers/plans/2026-09-15-maia-hermes-engine/` (IMPLEMENTATION-STATE.md,
  REQUIREMENTS-MATRIX.md, VERIFICATION-LOG.md) sobre a spec de implementação Maia + Hermes.
- Related issue: nenhuma.
- Related ADR/docs: `C57-RECONSTRUCAO-E-INTEGRACAO.md`; `docs/architecture/modules/integrations.md`.
- Agent role: implementação, verificação e integração feitas com assistência de IA (Claude Code,
  sessão de agente conduzida pelo dono do repositório). Os commits de P05, P06 e P07 foram
  produzidos por agentes paralelos em branches próprias e validados pelo agente orquestrador antes
  de integrar; a integração passou por revisão adversarial independente (V-049). Nenhum commit
  carrega `Co-Authored-By:` de IA — a assistência fica registrada aqui, conforme AGENTS.md
  § Coautoria.
- Context read: AGENTS.md, ARCHITECTURE.md, docs/ai/agent-operating-model.md, a spec e os
  relatórios dos agentes (`AGENT-REPORT-P05/P06/P07.md`).

## Scope

Files changed:

- `AGENTS.md`, `ARCHITECTURE.md` (novo subsistema `src/integrations/`), `docs/architecture/modules/integrations.md` (novo)
- `docs/runbooks/turn-state-machine.md`; docs de plano da épica
- `migrations/139–141` (com `_down`) e `migrations/RESERVATIONS.md` (+3 reservas)
- `src/db/schema.ts`; `src/db/repositories/` (`engine-repos.ts`, `turn-repos.ts`, `conversation-control-repo.ts`, `conversation-control-sql.ts`)
- `src/agent/react-loop.ts` (P02.2: separa deliberação de entrega)
- `src/runtime/turns/claim.ts`, `src/runtime/turns/contract.ts`; `src/runtime/engines/`
- `src/integrations/hermes/`; `src/governance/audit-actions.ts`
- `services/hermes_worker/` (worker Python) e testes unitários, de DB real, de reliability e Python

In scope:

- Contrato wire e worker Python do Hermes; porta de engine e `MaiaEngine`; journal durável de
  execução; controle humano (pausa, reconciliação, retomada `future_only` com descarte do backlog
  retido) e o hold de admissão/claim/recovery/promoção/debounce sob controle humano; políticas
  puras de P05/P06/P07.

Out of scope:

- Serviço de transporte e router do controle humano (C23): pausa e retomada não têm chamador de
  produção. Supervisor rodando, gateway servindo, dispatch instrumentado, tabelas de custo do §9.2,
  fences de egresso restantes do §8.2.4 e smoke com provider real pago (D02).

## Maia Invariants

- [x] Tenant/agent isolation considered — specs de DB real variam tenant E agente separadamente.
  O `test:leak` segue com 8 falhas (ver Validation), uma delas asserção real de isolamento.
- [x] Fail-closed behavior considered
- [x] Backend decides, LLM proposes
- [x] Audit/observability impact considered
- [x] Idempotency and side effects considered
- [x] Runtime trace or policy routing impact considered
- [ ] Not applicable; explain why:

## Validation

- Validation run (local, na árvore integrada; nenhum job de CI rodou sobre este código):
  - typecheck 0; lint 0 erros (481 avisos); build; `docs:ai:check`; `migrate:reservations:check`
    (148/148); `config:check:drift`.
  - `npm test`: `44 failed | 10556 passed | 1293 skipped (11893)`. O conjunto em falha é idêntico
    ao da épica pré-integração medida na mesma worktree; nenhuma falha é de arquivo desta PR, mas
    as 44 existem e não foram investigadas uma a uma aqui.
  - DB real contra banco novo com as 148 migrations aplicadas do zero: família `hermes-*` 598
    passados (260 de DB real).
  - `test:leak` (procedimento local sem Redis real): `151 / 8 falhas / 23 pulados`. Cinco falhas
    são de carga de configuração do procedimento local; a sexta é asserção real de isolamento em
    `turn-context-batch-repos` ("resolveScope no longer resolves a foreign profile into a grant"),
    **sem controle medido na `main`**.
  - pytest do worker 169/169; spike com o AIAgent real do Hermes pinado contra provider STUB 6/6.
  - Gate de trailers com evento real (base = `main`) na tip: exit 0. `pr:body:check` sobre este
    corpo: exit 0 — ele valida ESTRUTURA, não conteúdo.
- [x] `npm run docs:ai:check`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test` (com as 44 falhas acima)
- [x] Targeted tests: `hermes-*` (unit e DB real), `hermes-fixture-k19`, pytest, spike.
- Validation not run: CI inteiro.
- Skipped checks and reason: specs que exigem Redis real, docker compose, gitleaks, promtool, e2e do
  console e `probe:drizzle-kit` — infraestrutura ausente na máquina local.

## Docs Impact

- [ ] Docs not needed; reason:
- [x] Updated `AGENTS.md`
- [ ] Updated `docs/ai/`
- [x] Updated `docs/architecture/`
- [x] Updated `docs/runbooks/`
- [ ] Updated ADR:

## Risk and Rollback

Risk:

- **Caminho vivo alterado:** `src/agent/react-loop.ts` (P02.2) e o predicado de hold sob controle
  humano no claim, no recovery, na promoção e no debounce (`turn-repos.ts`, `claim.ts`), que
  toda execução de turno atravessa. Em produção `conversation_controls` fica vazia (sem chamador
  de pausa), então o predicado responde "sem controle" — o risco é de desempenho e de regressão
  no caminho de claim, não de bloqueio indevido.
- `src/db/schema.ts` e as migrations 139–141 acrescentam tabelas; os módulos de P05/P06/P07 não
  têm call site de produção.

Residual risk:

- O job obrigatório `fault injection (#510)` reprova até decidir como o spike Python roda no CI
  (C58). K-19 não cobre caixa, espaço, homóglifo nem o formato `mcp__` do Hermes (C59).
  `engine_runs` não tem escritor de produção, e o `future_only` é cumprido só pelo descarte
  (C53, C55). A asserção de isolamento em falha no `test:leak` não tem controle na `main`. SHAs
  antigos citados nos docs só resolvem localmente (C62).

Rollback:

- Reverter a PR. Os `_down` de 139–141 existem, mas o de 140 RECUSA com runs abertos ou chamadas
  com efeito não reconciliado, o de 141 RECUSA com comandos sem drenagem confirmada ou conversa
  fora de `bot`, e os dois apagam tabelas.

## Reviewer Notes

- Histórico: `C57-RECONSTRUCAO-E-INTEGRACAO.md` — 37 commits copiados com árvore, autoria, datas e
  patch-id idênticos; só 6 mensagens perderam o trailer de IA. O commit `155d0902` ainda diz "7
  commits" no assunto por ser cópia fiel; o número certo é 6.
- Assistência de IA: todo o trabalho foi feito com Claude Code; ver Task Context.
- Pontos de atenção: `src/db/repositories/turn-repos.ts` (predicados de hold no claim),
  `src/agent/react-loop.ts` (P02.2), `src/db/repositories/conversation-control-repo.ts` (ordem de
  lock e atomicidade do descarte) e as contradições abertas C53–C63 em IMPLEMENTATION-STATE.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

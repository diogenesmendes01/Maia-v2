## Summary

RASCUNHO LOCAL — esta PR NÃO foi aberta. O corpo abaixo está preparado para quando o dono
autorizar o push da branch `claude/mh-integracao-c57` e a abertura contra a `main`.

Épica Maia + Hermes (spec `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`), etapas P00–P04 na linha
principal e as fatias de contrato/política de P05, P06 e P07 integradas localmente. O histórico
foi reconstruído para cumprir o gate de trailers (C57) sem mudar nenhuma árvore de commit.

## Task Context

- Task spec: `docs/superpowers/plans/2026-09-15-maia-hermes-engine/` (IMPLEMENTATION-STATE.md,
  REQUIREMENTS-MATRIX.md, VERIFICATION-LOG.md) sobre a spec de implementação Maia + Hermes.
- Related issue: épica Maia + Hermes (worktree de origem `github-issue-498-cdbb4e`).
- Related ADR/docs: `C57-RECONSTRUCAO-E-INTEGRACAO.md` (mapeamento commit original → reconstruído).
- Agent role: implementação, verificação e integração feitas com assistência de IA (Claude Code,
  sessão de agente conduzida pelo dono do repositório). Commits de P05, P06 e P07 foram
  produzidos por agentes paralelos em branches próprias e validados pessoalmente pelo agente
  orquestrador antes de integrar. Nenhum commit carrega `Co-Authored-By:` de IA — a assistência
  fica registrada aqui, conforme AGENTS.md § Coautoria.
- Context read: AGENTS.md, ARCHITECTURE.md, docs/ai/agent-operating-model.md, a spec e os
  relatórios dos agentes (`AGENT-REPORT-P05/P06/P07.md`).

## Scope

Files changed:

- migrations 139–141 e `migrations/RESERVATIONS.md`
- `src/db/repositories/` (journal do motor, controle de conversa, turnos), `src/runtime/`,
  `src/integrations/hermes/`, `src/governance/audit-actions.ts`
- `services/hermes_worker/` (worker Python) e testes TS/Python/real-db/reliability
- docs de plano da épica

In scope:

- Contratos, journal durável, controle humano (pausa, reconciliação, retomada `future_only`
  com descarte do backlog retido) e as políticas puras de P05/P06/P07.

Out of scope:

- Supervisor rodando, gateway servindo, dispatch instrumentado, tabelas de custo do §9.2 e smoke
  com provider real pago (bloqueado por orçamento, D02). Nada disso tem call site de produção.

## Maia Invariants

- [x] Tenant/agent isolation considered — testes de isolamento nos dois eixos (tenant e agente)
  nas specs de DB real; `test:leak` com perfil idêntico ao da linha de base.
- [x] Fail-closed behavior considered
- [x] Backend decides, LLM proposes
- [x] Audit/observability impact considered
- [x] Idempotency and side effects considered
- [x] Runtime trace or policy routing impact considered
- [ ] Not applicable; explain why:

## Validation

- Validation run (árvore integrada, local): typecheck 0; lint 0 erros; build; `docs:ai:check`;
  `migrate:reservations:check`; `config:check:drift`; suíte unitária com o mesmo conjunto de
  arquivos em falha da linha de base medida na mesma worktree; família de DB real contra banco
  novo com as 148 migrations aplicadas do zero; `test:leak`; pytest do worker (169); spike com
  o AIAgent real do Hermes pinado contra provider stub (6/6); gate de trailers com evento real.
- [x] `npm run docs:ai:check`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [x] Targeted tests: `hermes-*` (unit e real-db), `hermes-fixture-k19`, pytest, spike.
- Validation not run: nenhum job de CI rodou sobre este código (sem push).
- Skipped checks and reason: specs que exigem Redis real, docker compose, gitleaks, promtool e
  e2e do console — infraestrutura ausente na máquina local.

## Docs Impact

- [ ] Docs not needed; reason:
- [ ] Updated `AGENTS.md`
- [ ] Updated `docs/ai/`
- [ ] Updated `docs/architecture/`
- [x] Updated `docs/runbooks/`
- [ ] Updated ADR:

## Risk and Rollback

Risk:

- Os módulos de P05/P06/P07 não têm call site de produção; o risco imediato é baixo.

Residual risk:

- O job obrigatório `fault injection (#510)` reprova até decidir como o spike Python roda no CI
  (C58). K-19 não cobre variações de caixa nem o formato `mcp__` do Hermes (C59). `engine_runs`
  não tem escritor de produção, e o `future_only` é cumprido só pelo descarte (C53, C55).

Rollback:

- Reverter a PR. As migrations 139–141 têm `_down`.

## Reviewer Notes

- A reconstrução do histórico está em `C57-RECONSTRUCAO-E-INTEGRACAO.md`: 37 commits copiados com
  árvore, autoria, datas e patch-id idênticos; só 6 mensagens perderam o trailer de IA.
- Assistência de IA: todo o trabalho foi feito com Claude Code; ver Task Context.
- Pontos de atenção: `src/db/repositories/conversation-control-repo.ts` (ordem de lock e
  atomicidade do descarte) e as contradições abertas C55–C62 em IMPLEMENTATION-STATE.md.

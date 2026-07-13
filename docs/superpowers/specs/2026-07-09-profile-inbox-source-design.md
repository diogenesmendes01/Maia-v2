# Operational Profile as Proposal Inbox Source — Design Spec

**Date:** 2026-07-09
**Status:** Draft v1 — proposta para discussão; sequência natural da fase 2 do relatório de complexidade (#492, mesclado).
**Scope:** Integrar `agent_operational_profile_versions` como source do motor unificado de propostas (`proposalsUnifiedRepo` + `decideAtomically`), fazendo a fila "Aprovações" (`/inbox`) listar E decidir perfis propostos — com caminho para dual-approval. Hoje a fila apenas APONTA para a aba Versões do agente (agregado `agents.pendingProfileApprovals`, #492).

**Referências:**
- `src/admin-ui/trpc/routers/agents.ts` — `approveProfile` (jsdoc antecipa exatamente esta evolução: "If we later decide it warrants dual approval, switch this to a Proposal Inbox source").
- `src/db/repositories/profile-repos.ts` — `approveAndActivateAtomic` (guards de predecessor: `predecessor_conflict`, `migrated_legacy_proposal`, `missing_predecessor`, locks FOR UPDATE no agente pai) e a state machine de 4 estados (`proposed → {active, frozen, rolled_back}`; `rolled_back` terminal).
- `src/admin-ui/trpc/routers/{inbox,proposals}.ts` + `src/admin-ui/lib/{proposal-type-registry,approval-matrix}.ts` — motor unificado (5 sources hoje), classes de aprovação e dual-approval com aprovadores distintos.
- `src/admin-ui/app/agents/_components/profile-diff.tsx` — diff pronto para reuso como diff-renderer.

**Architecture Locks tocados:** nenhum — perfil operacional é estado por-agente, NÃO faz parte do `identity_immutable_core` (lock aplicado só à classe `identity_drift_correction`). A integração NÃO altera a state machine nem os guards de predecessor; ela os REUSA.

**Depends on:** #492 (superfície única + agregado no inbox — mesclado). **Blocks:** dual-approval de perfis; aposentadoria do caminho bespoke `agents.approveProfile`.

---

## §0. Purpose

Depois da fase 2, a aprovação de perfil tem uma superfície única (aba Versões, com diff) e a fila "Aprovações" mostra um card com os perfis pendentes — mas o card é um **link para fora**: o operador sai da fila para decidir, e o perfil é o ÚNICO artefato de governança que não passa pelo motor unificado (policy_rule, soul_bias, skill, capability, knowledge já passam). Consequências:

1. **Dois motores de aprovação** para manter (o `decideAtomically` e o `approveAndActivateAtomic` bespoke) com semânticas de auditoria levemente diferentes.
2. **Sem dual-approval para perfis** — mudanças de princípios (contratos de valor que podem congelar o perfil via valoresDetector) são aprovadas por UM owner, enquanto uma soul_bias periférica pode exigir dois papéis.
3. **Fila incompleta por construção** — o card do #492 mitiga, mas contadores/filtros/bulk do inbox não enxergam perfis.

Este spec fecha o hiato SEM reimplementar a máquina de estados: o motor unificado ganha um source novo cuja transição **delega** para `approveAndActivateAtomic` — os guards de predecessor endurecidos por 3 rodadas de review adversarial (#171/#173/#182/#186) continuam sendo a única autoridade de ativação.

## §1. Mudanças por camada

1. **Tipo + registry** — `ProposalTypeId` ganha `'operational_profile'`; `proposalTypeRegistry` ganha `{ diffComponent: 'DiffOperationalProfile', riskLevels: ['low','medium','high'], displayName: 'Perfil Operacional', defaultApprovalClass: 'operational_profile_change' }`. O diff component é um wrapper fino sobre o `ProfileDiff` existente.
2. **Risco** — derivado deterministicamente do diff (backend, nunca LLM): mudou `principles` OU `cognitive_limits` ⇒ `high`; mudou `role_descriptor`/`priorities` ⇒ `medium`; só voz/estilo ⇒ `low`. Função pura `classifyProfileChangeRisk(activeBody, proposedBody)` com testes de tabela.
3. **Approval matrix** — classe nova `operational_profile_change`: `low/medium` ⇒ owner OU founder (paridade com hoje); `high` ⇒ **dual** owner + founder com aprovadores distintos (`requiresDistinctApprovers`). É a única mudança de comportamento de governança, e é o motivo do spec.
4. **`proposalsUnifiedRepo`** — `list`/`counters`/`getOne` ganham o branch UNION lendo `agent_operational_profile_versions WHERE status='proposed'` (id, tenant, agente como `source_ref`, risco computado, created_at). `decideAtomically` ganha o source transition:
   - `approved` + gate satisfeito ⇒ chama `approveAndActivateAtomic` DENTRO da mesma tx (mesmo pool/tx handle); razões tipadas do helper (`predecessor_conflict` etc.) sobem como `invalid_source_status`+detalhe para o router traduzir — as mensagens de CONFLICT existentes do `approveProfile` são reaproveitadas.
   - `rejected` ⇒ transição `proposed → rolled_back` (permitida pela state machine; terminal) + audit. Rejeitar ≠ congelar: o conteúdo permanece no histórico de versões.
5. **Bulk reject** — perfis ficam FORA do `bulkReject` na v1 (o elegível hoje é `risk=low` sem lock; perfil low é possível, mas rejeição em massa de identidade merece fricção — revisitar depois de telemetria).
6. **UI** — o card do #492 (`pendingProfileApprovals`) é substituído pelos contadores/tabela nativos do inbox; a aba Versões do agente PERMANECE como superfície local, agora chamando o motor unificado (`proposals.approve/reject`) em vez de `agents.approveProfile`. `agents.approveProfile` vira shim deprecado (mesma engine) por 1 release e depois sai.

## §2. Invariantes (stop conditions)

1. **Guards de predecessor intactos** — nenhuma reimplementação; `approveAndActivateAtomic` é a única via de `proposed → active`. Teste de integração: aprovar via inbox com incumbente trocado ⇒ CONFLICT com a mesma mensagem de hoje.
2. **Fail-closed em dual** — `high` sem segunda assinatura NÃO transiciona (motor já garante via `dualComplete` transacional).
3. **Auditoria dupla proibida** — a decisão gera UMA trilha (a do motor unificado); o `approveAndActivateAtomic` é chamado em modo "sem audit próprio" (parâmetro novo `skip_audit: true` — default false preserva o caminho legado durante a transição).
4. **Risco é computado** — `classifyProfileChangeRisk` é determinística; o LLM não participa (invariante #3).

## §3. Rollout

1. **Fase A (read-only):** flag `FEATURE_PROFILE_INBOX_SOURCE` — perfis aparecem em contadores/tabela do inbox; decidir ainda redireciona para a aba Versões. Valida UNION/risco/diff sem tocar o motor de decisão.
2. **Fase B (decide):** `decideAtomically` ativado para o source; aba Versões passa a chamar o motor unificado; `approveProfile` vira shim.
3. **Fase C (cleanup):** remove shim + card `pendingProfileApprovals` + flag.

## §4. Testes

- Unit: registry/matrix/`classifyProfileChangeRisk` (tabela de diffs → risco); router `proposals.approve` com source novo (gates, dual, traduções de razão).
- Integração: aprovar via inbox ativa + congela incumbente atomicamente; race predecessor (mesmo cenário do issue #177) via inbox; reject ⇒ `rolled_back` terminal; dual `high` exige aprovadores distintos.
- E2E: fluxo inbox → diff → aprovar (paridade com `proposal-approval.spec` existente).

## §5. Riscos e alternativas descartadas

- **Risco:** divergência de UX durante a fase B (duas telas decidindo) — mitigado porque ambas chamam a MESMA engine; a resposta é idempotente por status.
- **Descartado — reimplementar a ativação dentro do `decideAtomically`:** duplicaria os guards de predecessor (a parte mais endurecida do sistema) e criaria dois donos para a mesma transição — viola a regra "cada decisão tem exatamente 1 dono" (capability-taxonomy §fonte-da-verdade).
- **Descartado — dual-approval para TODA mudança de perfil:** fricção desproporcional para ajustes de tom/verbosity; o risco derivado do diff dá a fricção onde o blast radius existe (princípios/limites).

# Operational Profile as Proposal Inbox Source — Design Spec

**Date:** 2026-07-09 (revisado 2026-07-13)
**Status:** Draft v2 — incorpora o review de design de 2026-07-13 (1 bloqueante + 3 altos). Mudanças vs. v1: §1.4 primitivo `approveAndActivateInTx(tx)` no lugar de `skip_audit` (bloqueante), §1.3 duas approval classes selecionadas por risco (alto 1), §1.2 schema canônico de `principles` + classificador exaustivo fail-UP + diff exaustivo (alto 2), §1.6 migração de escopo em `proposal_approvals` (alto 3).
**Scope:** Integrar `agent_operational_profile_versions` como source do motor unificado de propostas (`proposalsUnifiedRepo` + `decideAtomically`), fazendo a fila "Aprovações" (`/inbox`) listar E decidir perfis propostos — com dual-approval para mudanças de alto risco.

**Referências:**
- `src/db/repositories/profile-repos.ts` — `approveAndActivateAtomic` (abre a PRÓPRIA transação e escreve o PRÓPRIO audit — motivo do bloqueante da v1) e a state machine de 4 estados (`rolled_back` terminal).
- `src/db/repositories/admin-repos.ts` — `decideAtomically` (o próprio motor já documenta a necessidade de primitivos per-source injetáveis na tx para os demais sources).
- `src/admin-ui/lib/approval-matrix.ts` — `ApprovalClassDef` tem papéis FIXOS por classe (motivo do alto 1); `getApprovalClassFor(type, risk)` já recebe risco e seleciona a classe.
- `src/db/schema.ts` — `ProfileBody` canônico NÃO declara `principles` (persistido hoje por cast em `agents.ts` `buildProfileBody`); `proposal_approvals` tem só `tenant_id + proposal_id` (sem `agent_id`/source).
- `src/admin-ui/app/agents/_components/profile-diff.tsx` — diff atual ignora `learned_voice_modifiers`, `style.rhythm`, extensões legadas e mudanças de `schema_version`.

**Architecture Locks tocados:** nenhum — perfil operacional é estado por-agente, não o `identity_immutable_core`. A integração REUSA a state machine e os guards de predecessor, sem alterá-los.

**Depends on:** #492 (superfície única + agregado no inbox — mesclado). **Blocks:** dual-approval de perfis; aposentadoria do caminho bespoke `agents.approveProfile`.

---

## §0. Purpose

(Inalterado da v1.) O perfil é o único artefato de governança fora do motor unificado: dois motores de aprovação para manter, sem dual-approval para o artefato que pode congelar o próprio agente, e uma fila "Aprovações" incompleta por construção. A integração delega a ativação aos guards existentes — nenhuma reimplementação da parte mais endurecida do sistema.

## §1. Design

### §1.1 Tipo + registry

`ProposalTypeId` ganha `'operational_profile'`; `proposalTypeRegistry` ganha a entrada com `diffComponent: 'DiffOperationalProfile'` e `riskLevels: ['low','medium','high']`. O diff component NÃO reusa o `ProfileDiff` atual às cegas — ver §1.2 (diff exaustivo).

### §1.2 Schema canônico, classificador de risco e diff — exaustivos e fail-UP (review v2, alto 2)

Pré-requisito estrutural: **formalizar `principles` no `ProfileBody` canônico** (hoje é persistido por cast — um campo high-risk fora do tipo). Mudança aditiva: `identity.principles?: string[]` no tipo + bump menor de `PROFILE_BODY_SCHEMA_VERSION`; remove o cast em `buildProfileBody`. Migração de dados: nenhuma (rows existentes já carregam o campo; o tipo passa a admiti-lo).

**`classifyProfileChangeRisk(predecessorBody, proposedBody)`** — função pura, backend, nunca LLM:

- Compara contra o **predecessor DECLARADO** da proposta (`metadata.previous_version_id`), não contra o active do momento da leitura — coerente com o guard de predecessor que decidirá a ativação.
- Caminha um **walker exaustivo** sobre o schema canônico: todo campo conhecido tem classificação explícita (`principles`, `cognitive_limits` ⇒ high; `role_descriptor`, `priorities` ⇒ medium; `voice`, `style.language`, `style.rhythm`, `learned_voice_modifiers` ⇒ low/medium conforme tabela no código).
- **Fail-UP, nunca down**: campo desconhecido (extensão legada, chave extra), `schema_version` diferente entre os corpos, predecessor ausente/ilegível, ou valor fora do shape esperado ⇒ `high`. A v1 falharia para baixo (campo ignorado = risco subestimado); v2 inverte o default.
- Testes de tabela: cada campo canônico + casos de campo desconhecido/schema divergente/predecessor nulo.

**`DiffOperationalProfile`** deriva do MESMO walker (single source of truth): tudo que o classificador enxerga, o diff renderiza — incluindo `learned_voice_modifiers`, `rhythm` e mudança de `schema_version`. Campos desconhecidos aparecem numa seção "Campos não reconhecidos (risco alto)" com o JSON bruto, nunca omitidos. O `ProfileDiff` atual (aba Versões) é substituído pelo novo componente nas duas superfícies para não haver dois diffs divergentes.

### §1.3 Approval matrix — duas classes selecionadas por risco (review v2, alto 1)

`ApprovalClassDef` tem papéis fixos por classe — uma classe única não representa "owner para low/medium, dual para high". Duas classes:

- `operational_profile_change` — `low`/`medium`: owner OU founder (paridade com hoje).
- `operational_profile_change_high` — `high`: **dual** owner + founder com `requiresDistinctApprovers`.

`getApprovalClassFor('operational_profile', risk)` seleciona entre as duas — o mecanismo (type+risk → class) já existe na matriz; nenhum redesign estrutural.

### §1.4 Composição transacional — primitivo `approveAndActivateInTx` (review v2, bloqueante)

A v1 propunha `skip_audit`, que não resolve o problema real: `approveAndActivateAtomic` **abre a própria transação** — não dá para compô-lo dentro da tx do `decideAtomically`. Design v2, alinhado ao que o próprio motor documenta para outros sources:

- **Extrair** o corpo de `approveAndActivateAtomic` para `approveAndActivateInTx(tx, args)`: recebe o handle da transação, executa locks (agente pai FOR UPDATE, proposta, incumbente), guards de predecessor e as transições — **sem** abrir tx e **sem** escrever audit (auditoria é responsabilidade do wrapper).
- `approveAndActivateAtomic` vira wrapper fino: `withTx(tx => InTx(tx, args))` + seu audit atual — comportamento byte-a-byte preservado para o caminho legado (aba Versões durante a transição).
- `decideAtomically` chama `approveAndActivateInTx(tx, ...)` dentro da SUA tx; a trilha é a do motor unificado (uma trilha por decisão, invariante mantido). Razões tipadas do primitivo (`predecessor_conflict` etc.) sobem intactas e o router `proposals.approve` as traduz com as mesmas mensagens de CONFLICT/PRECONDITION_FAILED de hoje.
- `rejected` ⇒ transição `proposed → rolled_back` (terminal) pelo mesmo padrão InTx.

### §1.5 Bulk reject e UI

(Inalterado da v1.) Perfis fora do `bulkReject` na v1 da integração; card `pendingProfileApprovals` do #492 é substituído pelos contadores nativos na fase B; aba Versões passa a chamar o motor unificado; `agents.approveProfile` vira shim deprecado por 1 release.

### §1.6 Escopo de `proposal_approvals` (review v2, alto 3)

Hoje a tabela tem `tenant_id + proposal_id`, e as leituras (`listByProposal`) filtram só por `proposal_id` — insuficiente para um artefato explicitamente per-agent (invariante #1: todo estado escopado por tenant+agent). Migração **append-only** `NNN_proposal_approvals_scope`:

- Colunas novas: `agent_id TEXT NULL`, `proposal_source TEXT NULL` (nullable para as rows legadas; backfill best-effort onde o source permite derivar — capability/skill proposals carregam agent; onde não der, permanece NULL e é tratado como legado).
- Índice composto novo: `(tenant_id, proposal_source, proposal_id)`; queries de leitura passam a filtrar por `tenant_id + proposal_id` no mínimo, e por `agent_id/source` quando o chamador os conhece (o router de perfis SEMPRE conhece).
- Escritas novas (todas as sources, não só perfis) preenchem `agent_id`/`proposal_source` obrigatoriamente na camada repo (guard: escrita de decisão de perfil sem `agent_id` ⇒ erro).
- `_down`: remove índice e colunas.

## §2. Invariantes (stop conditions)

1. **Guards de predecessor intactos** — `approveAndActivateInTx` é extração mecânica; teste de caracterização compara comportamento com o wrapper legado (mesmos cenários do issue #177).
2. **Fail-closed em dual** — `high` sem segunda assinatura não transiciona (motor já garante via `dualComplete` transacional).
3. **Uma trilha por decisão** — audit do motor unificado; o wrapper legado mantém a sua até ser aposentado (as duas superfícies nunca auditam a MESMA decisão duas vezes porque cada decisão passa por exatamente um caminho).
4. **Risco é computado e fail-UP** — desconhecido/inválido ⇒ `high`; o LLM não participa.
5. **Escopo completo** — decisão de perfil sem `tenant_id + agent_id + source` é rejeitada na camada repo.

## §3. Rollout

1. **Fase 0 (pré-requisitos):** `principles` no schema canônico; migração de `proposal_approvals`; extração `approveAndActivateInTx` (com teste de caracterização) — três PRs pequenos e independentes.
2. **Fase A (read-only):** flag `FEATURE_PROFILE_INBOX_SOURCE` — perfis em contadores/tabela/diff do inbox; decidir ainda redireciona à aba Versões. Valida UNION, classificador e diff exaustivo em produção sem tocar decisão.
3. **Fase B (decide):** `decideAtomically` + classes de aprovação ativas; aba Versões chama o motor unificado; `approveProfile` vira shim.
4. **Fase C (cleanup):** remove shim + card do #492 + flag.

## §4. Testes

- Unit: registry/matriz (2 classes por risco); `classifyProfileChangeRisk` (tabela exaustiva + fail-UP); walker compartilhado classificador↔diff; traduções de razão no router.
- Caracterização: `approveAndActivateAtomic` (wrapper) vs. comportamento pré-extração — mesmos resultados nos cenários #171/#173/#182/#186/#177.
- Integração: aprovar via inbox ativa + congela incumbente na MESMA tx do motor; race de predecessor via inbox; reject ⇒ `rolled_back`; dual `high` exige aprovadores distintos; escrita de decisão sem agent_id rejeitada.
- E2E: fluxo inbox → diff exaustivo → aprovar (paridade com `proposal-approval.spec`).

## §5. Riscos e alternativas descartadas

- **Risco:** a extração InTx toca o arquivo mais endurecido do sistema — mitigada por ser mecânica (mover corpo, injetar tx) + teste de caracterização ANTES de qualquer mudança semântica; o PR da fase 0 não muda comportamento.
- **Risco:** backfill parcial de `agent_id` em approvals legadas — aceito; rows NULL são legado somente-leitura e nenhum predicate novo depende delas.
- **Descartado — `skip_audit` (v1):** não resolve a composição de tx; substituído pelo primitivo InTx.
- **Descartado — reimplementar a ativação no motor** e **dual para toda mudança** (v1, mantidos): dois donos para a mesma transição / fricção desproporcional.

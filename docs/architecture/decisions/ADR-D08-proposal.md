# ADR-D08 (proposta) — revisões governadas de fato sem quebrar os writers operacionais

| Field | Value |
|---|---|
| Status | PROPOSTA — **DECISÃO PENDENTE** do reviewer Backend/DB |
| Date | 2026-09-26 |
| Owner | Maia maintainers |
| Slice | SC12-A (caracterização; sem DDL) |
| Revalidado em | `d9553dec5b7b43338b6dd62dbbf047001a1924cc` (branch `harness/sc12-a-native-20260926`) |
| Inventários | `docs/architecture/decisions/d08-writers-inventory.json`, `docs/architecture/decisions/d08-consumers-inventory.json` |
| Base da semente | `df135a4c72538f2c3ad6f6093a0967a7f7da0b48` (reinventário portado, não reiniciado) |
| SPEC | §4.1, §7.4.3, §7.6.3 |

**Este documento é proposta técnica, não decisão aceita.** Ele não autoriza migration,
não escolhe número de migration e não substitui a decisão do reviewer. A alternativa
especializada é permitida em §4.1, mas exige equivalência revisada — que é exatamente o
que se pede abaixo.

## Contexto

`agent_facts` tem uma única identidade por `(tenant_id, agent_id, escopo, chave)`
(`agent_facts_tenant_agent_escopo_chave_key`, presente desde a migration 018) e essa
identidade é a base de DOIS contratos operacionais distintos que rodam hoje em produção:

1. `factsRepo.upsert` (`src/db/repositories/cognitive-repos.ts`) faz `ON CONFLICT DO
   UPDATE` nessa unique — semântica de **replace**;
2. `upsertCostFact` (`src/lib/cost-ledger.ts`) faz `INSERT ... ON CONFLICT
   (tenant_id, agent_id, escopo, chave) DO UPDATE` somando tokens/centavos **dentro do
   statement** (issue #508), e `readDailyLLMUsd` / `readDailyLLMUsdByPessoa` leem a
   mesma linha por `factsRepo.getByKey('global'|'pessoa', ...)`;
3. `knowledgeRepos.create` (`src/control-plane/knowledge-state-machine/repos.ts`) faz
   `INSERT` simples: uma segunda proposta da MESMA chave lógica **não tem onde caber**.

Somando os três: a tabela não distingue "o valor corrente" de "a história de como ele
chegou ali". Enquanto isso, o envelope Hermes exige revisão governada com predecessor,
digest e trilha de decisão. Trocar a unique por `revision` sem migrar os três contratos
quebraria a contabilidade de custo e o conflito do KSM no mesmo passo.

## Evidência revalidada nesta fatia

`d08-writers-inventory.json` e `d08-consumers-inventory.json` são o port SHA-scoped dos
inventários da semente. A revalidação é **textual e item a item** no SHA acima, com
contagem registrada no próprio artefato:

| Métrica | Valor medido |
|---|---|
| writers de fato declarados | 13 |
| writer declarado com faixa presente e símbolo conferido | 13 / 13 |
| ocorrências textuais classificadas (comentário/referência + linha viva) | 157 |
| writers diretos adicionais | 11 |
| suítes existentes lidas estaticamente | 7 |
| consumidores mapeados | 19 |
| citações revalidadas (exatas + trecho contido na mesma linha) | 228 (223 + 5) |
| citações não encontradas / paths ausentes | 0 / 0 |

O inventário separa explicitamente os mecanismos que a decisão precisa distinguir —
`raw_sql_operational` (`cost-ledger`), `orm_repository` (`factsRepo`), `ksm_facade_orm`,
`indirect_caller_legacy` (`cognition/persister`), `ksm_promoter`
(`workers/knowledge-state-promoter`), `settings_dual_read` (`lib/llm-settings`),
`benchmark_fixture` (`scripts/turn-context-benchmark`) e `historical_migration`
(`migrations/062_global_settings_down.sql`, que **não** deve ser editada) — e marca cada
ocorrência como `comment_or_reference` ou `code`, porque comentário não é call site.

## Caracterização em banco exclusivo (executada)

Alvo: `tests/integration/refinement-sc12-a-real-db.spec.ts`, contra o Postgres exclusivo
do card (`card_wip3_sc12a_dev`, template `maia_template`, 154 migrations aplicadas).
Resultado do alvo entregue: **5 executados / 5 passaram / 0 falharam / 0 pulados, exit 0,
`coverage=complete`**.

| Cenário | O que foi lido (row real) | Resultado |
|---|---|---|
| duas somas concorrentes, 2 rodadas × 2 chamadas sobre a MESMA chave | `agent_facts.valor` (global e pessoa) + readers `readDailyLLMUsd` / `readDailyLLMUsdByPessoa` | total exato: 8000 tokens in, 3000 out, 184 centavos; nenhum update perdido |
| isolamento | `getByKey` sob outro tenant e sem ALS | outro tenant/agente não lê nem altera a linha; sem contexto ALS a leitura estoura e a escrita não cria row |
| contrato `getByKey` | duas execuções de `factsRepo.upsert` na mesma chave | mesmo `id`, 1 row, valor substituído — **replace, sem histórico** |
| segunda revisão pelo KSM | `knowledgeRepos.create` com a mesma chave lógica | segunda proposta falha com `23505` em `agent_facts_tenant_agent_escopo_chave_key`; a row original permanece com o conteúdo original |
| recall | `recallAuthorized` sobre item canônico real + agregado de custo existente | **zero** item de custo devolvido; nenhum id de custo, nenhum conteúdo `cost.daily.llm` |

O motivo estrutural da exclusão no recall foi lido do banco, não presumido: o fato
operacional não tem item canônico em `memory_entry` nem vetor em `agent_memories`, e o
JOIN do predicado (migration 146) é o fence.

### Achado registrado — exposição fora do recall (não mascarado)

A leitura legada de fatos para o prompt, `factsRepo.listForScopes(['global'])`, **devolve**
o agregado `cost.daily.llm.<dia>`: `escopo='global'` está entre os escopos pedidos e o
ciclo de vida é `active`. Isso foi caracterizado em teste e numa sonda RED dedicada
(abaixo). Não é vazamento do caminho de recall — é exposição interna da fatia de prompt de
fatos, e é uma das razões pelas quais a opção recomendada mantém os namespaces
operacionais em whitelist interna, fora de `learning_items` elegíveis.

### RED causal (sonda descartável)

Uma sonda temporária (não entregue na PR, preservada como evidência) afirmou o
**comportamento desejado** e falhou nos dois casos, provando que os gaps caracterizados
são reais e detectáveis:

1. RED-1 — segunda revisão do mesmo fato lógico coexistindo com a primeira: *promise
   rejected* por chave duplicada.
2. RED-2 — agregado operacional fora da leitura de fatos para o prompt: recebido
   `['cost.daily.llm.2026-09-26']`, que é exatamente a chave que não deveria estar lá.

## Opções

1. **Adicionar `revision` à própria unique de `agent_facts`.** Uma tabela canônica
   histórica, mas TODOS os upserts passam a ter semântica de corrente: `factsRepo`,
   `upsertCostFact` (que soma na linha travada), `getByKey`, os dois SQL de
   `llm-settings`, os consumidores de custo, as fixtures de benchmark e as leituras de
   prompt. Exige migração simultânea de todos os writers, compatibilidade em rolling
   deploy e plano de locking mais amplo. **Não recomendada para esta fatia.**
2. **Revisões especializadas + ponteiro corrente (recomendada).** Preservar
   identidade/unique operacional em `agent_facts` e separar o histórico imutável do fato
   governado. Impacto menor no ledger operacional, desde que não surjam duas fontes
   editáveis de conteúdo.
3. **Rejeitadas:** sufixo artificial na chave, overwrite de revisão aprovada e JSON de
   histórico livre — perdem identidade, constraints e lineage, e contrariam a SPEC.

## Recomendação

**Opção 2 — revisões especializadas com ponteiro corrente escopado**, com o valor legado
de `agent_facts.valor` tratado como **projeção compatível** da revisão corrente.

Justificativa curta: a caracterização mostra que a unique atual é (a) o mecanismo de
acumulação atômica do ledger de custo e (b) o motivo pelo qual o KSM não consegue
registrar uma segunda proposta. Alterar a unique move os dois problemas ao mesmo tempo e
transforma todo leitor operacional em leitor de "corrente"; separar revisões preserva os
dois contratos e deixa o histórico onde ele pertence.

## Contrato proposto (a validar pelo reviewer)

- `agent_fact_revisions`: UUID de revisão; FK composta `(tenant, agent, fact_id)` para a
  identidade em `agent_facts`; `revision` positivo; `predecessor` escopado; payload JSON
  canônico **imutável**; `content_digest`; lifecycle/evidence; timestamps. Unique
  `(tenant, agent, fact_id, revision)`.
- `agent_fact_current_revisions`: ponteiro escopado `fact_id → revision_id`, com
  `row_version`/CAS; no máximo uma corrente por fato. Draft nunca substitui corrente;
  aprovação válida troca o ponteiro e escreve metadados/audit/outbox na **mesma TX**.
- A identidade lógica permanece em `agent_facts`; o payload autoritativo governado passa a
  pertencer à REVISÃO, e `agent_facts.valor` nesse namespace vira projeção da corrente.
  Nenhum escritor independente pode editar as duas coisas.
- `learning_items` referencia `canonical_kind='fact'` + id da revisão por contrato
  fechado (FK/resolver tipado), nunca nome livre de SQL.
- Namespaces operacionais `cost.daily.llm.*` e `llm.model.*` mantêm o contrato legado
  (mesma unique, mesma acumulação) e **não** geram `learning_items` elegíveis; whitelist
  de writers operacionais é interna, e entrada de cliente com chave reservada é recusada.
- APIs antigas de escrita cognitiva não sobrescrevem chave governada: guard/adapter
  encaminha ao service ou recusa. Autorização vem da origem backend, não de prefixo
  textual vindo do usuário.
- KSM/InTx recebe executor explícito; sem `db` global dentro de `withTx`. Scoring fora da
  TX sobre bytes congelados; ACL/digest/revision/policy/epoch/predecessor revalidados
  dentro.

## Sequência expand–migrate–contract

- **SC12-A (esta fatia):** ADR + inventário revalidado + caracterização em DB exclusivo.
  **Sem DDL.**
- **SC12-B:** esquema aditivo e service draft-only atrás de flag, com a unique operacional
  intacta, guard de writers legados e ponteiro que não troca por proposta.
- **SC12-C:** proposal/evidence/lineage/audit/outbox com InTx e dedupe.
- **SC13:** migração de writers/promoter/reclassifier; **SC14-A/B/C:** leitura, índice,
  cache e fences. Habilitação governada por gates; nunca backfill cego de origem.
- Legado sem proveniência: quarentena/não elegível; `fonte=configurado` histórico não vira
  prova humana.

## Provas exigidas nas PRs seguintes (NÃO executadas aqui)

- Duas somas concorrentes global/pessoa no banco real mantêm o total, e outro
  tenant/agente não altera a row — já caracterizado nesta fatia no contrato atual; a
  prova de SC12-B é a **preservação** desse resultado após o esquema aditivo.
- Duas revisões, uma corrente aprovada e uma draft: correção mantém original e ponteiro;
  aprovação stale/hash errado/CAS rival não troca corrente; revoked não renasce.
- Ataque de chave reservada, id de revisão de outro tenant/fato, ciclo/predecessor errado
  e UPDATE direto de payload imutável: recusados.
- Falha separada em canônico/metadados/evidência/audit/outbox: rollback integral.
  Reprocessar a fonte não soma evidência; aprovação antiga não autoriza nova revisão.
- Recall e loader com `cost.daily.llm.*` / `llm.model.*` e canário privado: zero vazamento
  e nenhum slot de top-K ocupado por item inelegível — e, adicionalmente, fechamento da
  exposição de `factsRepo.listForScopes` registrada acima.
- Up/down em sandbox: down aborta com corrente/revisão/lineage/trabalho pendente, sem
  destruir custos ou fatos; migration antiga não alterada.

## Decisão solicitada (não é pesquisa delegada)

O reviewer Backend/DB valida a **opção 2** e a semântica explícita `canonical_id` lógico
vs. id de revisão — ou rejeita com incompatibilidade demonstrável. Até a decisão:
drafts privados, e migrations não despachadas. Não se pede a ninguém que repita o
inventário de SQL nem que aprove nomes de fatias.

## Limites declarados

- A revalidação é **inspeção textual**: SQL dinâmico, writers fora do checkout e
  configuração viva não são certificados. Comentário não é call site.
- Na caracterização, a única fronteira dobrada é o provedor de embedding (rede externa,
  proibida em teste). O predicado de recall roda no Postgres real; nenhum provedor real é
  chamado.
- `setup`/`globalSetup` rodam com `TEST_WORKTREE_SCOPE=off` e o DB exclusivo do card; o
  resultado vale para esse banco com as 154 migrations do SHA.
- Nenhum resultado de `down`, de equivalência de migração ou de CI é alegado aqui.
  Sem DDL, sem migration e sem mudança em `src/` nesta PR.
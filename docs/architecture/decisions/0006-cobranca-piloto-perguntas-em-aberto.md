# ADR: as doze perguntas do piloto de cobrança são gates com dono nomeado — nenhuma delas é decidível por um agente

| Field | Value |
|---|---|
| Status | **Proposed — aguardando decisão humana.** Este ADR não decide nenhuma das doze perguntas; ele decide **como elas ficam registradas e quem responde cada uma** |
| Date | 2026-09-01 |
| Owner | Maia maintainers (dono do produto, dono da segurança, jurídico, DPO — nomeados por pergunta abaixo) |
| Related issue | [#469](https://github.com/diogenesmendes01/Maia-v2/issues/469) |
| Related PR | PR de spec + decision log (esta) |
| Spec | [`docs/superpowers/specs/2026-07-31-collections-work-loop-design.md`](../../superpowers/specs/2026-07-31-collections-work-loop-design.md) |
| Verificado contra | `origin/main@c1ebc755` |

> **Este documento é um registro, não uma implementação.** Nada aqui está construído. Ele existe porque a alternativa era um agente escolher sozinho, dentro de uma spec, respostas que pertencem ao dono do produto, ao dono da segurança, ao jurídico e ao DPO — e porque uma pergunta esquecida dentro de uma spec de 600 linhas é uma pergunta que ninguém responde.

## Context

A issue #469 pede um work loop com um objetivo de efeito real: uma régua de cobrança amigável. A spec correspondente foi escrita em 2026-07-31 contra o HEAD `7b34e7e0`, ficou 120 commits atrás da `main`, nunca teve PR e listava doze perguntas em aberto no seu §12 — em prosa, sem dono, sem estado e sem evidência.

Três fatos de `main` moldam o que segue:

1. **#521 está mergeada** (`d93624b7`). `evaluateFinancialAuthorization`, `approval_requests`/`approval_decisions` e o LLM fora do circuito de aprovação são fato. Consequência direta: um principal de autorização sem `Pessoa` (Q3) **não é continuação daquele trabalho** — é trabalho novo contra um alvo agora fixo.
2. **#696 está mergeada** (`a45cf85b`, `migrations/138`) e entregou apenas a fatia genérica: lease, fencing, reaper e predicado de tenant em `objective_tasks`. A própria PR registra que as fatias seguintes não começam antes da revisão da spec.
3. **Nada de cobrança existe em `main`.** O único kind do registry é `manual` (`src/objectives/kinds.ts:40`). Não há `cobranca_amigavel`, não há `objective_contact_slots`, não há holdout nem cadência.

**Invariantes relevantes:** invariante 1 (isolamento por `tenant_id + agent_id`), invariante 2 (fail-closed em segurança), invariante 3 (backend decide, LLM propõe), invariante 4 (auditar toda decisão).

## Decision

**Cada uma das doze perguntas ganha estado, dono, consequência e — quando existe — evidência de repositório com caminho e linha. Três delas são declaradas BLOQUEANTES: nenhuma fatia de cobrança começa enquanto Q1, Q2b e Q3 não estiverem assinadas.** O registro é este documento; a spec cita, não duplica.

Duas regras de leitura, e elas são a razão do formato:

- **"Evidência" significa código, schema ou migração que qualquer pessoa pode abrir.** Onde não há evidência, o campo diz *não verificado* — nunca "provavelmente" e nunca "acredito".
- **Estado `proposta` significa que a spec propõe uma resposta e ela ainda precisa de assinatura.** Não significa resolvida.

### Legenda de estado

| Estado | Significado |
|---|---|
| **bloqueante** | Nenhuma fatia de cobrança começa sem resposta assinada |
| **aberta** | Precisa de resposta antes da fatia indicada; não bloqueia o resto |
| **proposta** | A spec propõe uma resposta concreta; falta a assinatura do dono nomeado |

---

### Q1 — A Maia consegue saber quem deve e quem pagou?

| | |
|---|---|
| **Estado** | **BLOQUEANTE** |
| **Decide** | Dono do produto, com o tenant do piloto |
| **Bloqueia** | Fatia 3 |

**Enunciado.** O perceptor só evita cobrar quem já pagou se a liquidação estiver visível para a Maia. Duas perguntas: (a) os recebíveis do tenant do piloto estão na Maia e são mantidos em dia? (b) a liquidação chega por qual caminho e com qual atraso?

**Evidência.**

| Fato | Onde |
|---|---|
| `payment_verification` retorna `paid: null` **sempre**, nunca `false` — o stub é honesto por desenho | `src/tools/payment-verification.ts:59` |
| `boleto_search`, `dda_lookup`, `company_blacklist_check`, `company_history_lookup`, `refund_lookup`, `operational_ticket_create` são stubs (#432) | `src/tools/` |
| O único razão é `transacoes`; o domínio de `status` é `('pendente','agendada','paga','recebida','cancelada')` | `migrations/001_initial.sql:71` |
| Não há métrica de frescor, teste de completude nem tenant de referência verificado para esses dados | **não verificado — porque não existe**: a busca não encontrou nenhum artefato desse tipo |

**O que muda conforme a resposta.** Se os recebíveis não estiverem na Maia ou chegarem com atraso relevante, o passo de revalidação do perceptor (spec §4.4 passo 4) é decorativo, o dano mais provável do piloto (cobrar quem já pagou) fica sem defesa, e o critério de saída em R$ não é mensurável. **Esta pergunta define se o piloto é viável**, não como ele é construído.

---

### Q2 — `transacoes` não tem `data_vencimento`

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 4 |

**Enunciado.** Vencimento não é campo de primeira classe. Usar `data_competencia` como proxy é aceitável para este tenant, ou vencimento precisa virar campo?

**Evidência.** `transacoes` tem `data_competencia` e `data_pagamento`, e nenhuma coluna de vencimento (`src/db/schema.ts:127`). Não existe tabela de contas a receber separada do razão.

**O que muda.** Muda quem entra na carteira e quando cada passo dispara. Se virar campo, é migração aditiva mais backfill — e o backfill precisa de fonte, que é a própria Q1.

---

### Q2b — Quem faz a ponte devedor → WhatsApp?

| | |
|---|---|
| **Estado** | **BLOQUEANTE** |
| **Decide** | Dono do produto, com quem cuida dos dados do tenant |
| **Bloqueia** | Fatia 3 (o desenho) e fatia 4 (a curadoria pronta) |

**Enunciado.** Não existe caminho de "quem deve" para "qual número contatar". Quem monta e mantém esse vínculo para a carteira do piloto: import manual, curadoria no console, ou campo novo em `contrapartes`?

**Evidência.**

| Fato | Onde |
|---|---|
| O devedor no razão é `transacoes.contraparte_id → contrapartes`, que tem `nome`, `documento`, `chave_pix` e **nenhum telefone nem referência a `pessoas`** | `src/db/schema.ts:182` |
| Quem tem `telefone_whatsapp` é `pessoas` | `src/db/schema.ts:199`, coluna em `:211` |
| Não há FK, coluna nem tabela de junção entre as duas | verificado no schema completo — nenhuma existe |
| Pessoa sem perfil de audiência ativo resolve para `quarantined` | `src/identity/resolver.ts:77`, `:92`, `:106` (migração `074`) |
| Um turno `quarantined` é concluído sem chegar ao agente | `src/agent/core.ts:783` |

**O que muda.** Isto vale nos **dois** sentidos, e a draft só via um. No envio, sem vínculo não há `pessoa_id_destino` e o mandato não materializa. **Na resposta, uma mensagem inbound do devedor também exige perfil de audiência ativo** — sem ele, a resposta é descartada antes de virar turno e a exceção humana da spec §8.2 nunca abre. Um piloto com a carteira parcialmente vinculada é um piloto que perde respostas em silêncio.

---

### Q2c — A liquidação chega pela Maia? (a ingestão de extrato existe e está quebrada)

| | |
|---|---|
| **Estado** | aberta — **e contém um defeito confirmado, com issue própria** |
| **Decide** | Dono do produto (para a cobrança); manutenção do repositório (para o conserto) |
| **Bloqueia** | Fatia 4 |

**Enunciado.** A draft afirmava que "nada liga" os parsers de OFX/CSV às tabelas `import_runs`/`import_entries`. **Isso é factualmente impreciso, e a correção é mais forte que a imprecisão:** a ligação existe **e está quebrada**, o que é pior que ausente, porque parece existir.

**Evidência.**

| Fato | Onde |
|---|---|
| As CLIs existem e estão declaradas: `import:ofx`, `import:list`, `import:show`, `import:apply` | `package.json`; `scripts/import-ofx.ts`; `scripts/import-review.ts` |
| `import_runs.tenant_id` e `import_runs.agent_id` são `NOT NULL` | `src/db/schema.ts:1109`, `:1110`; `migrations/012_p0_force_not_null.sql` |
| …e **sem default**: a `083` removeu o `DEFAULT 'default'` de toda coluna que o tinha, fechando o bucketing silencioso da #282/#323 | `migrations/083_drop_default_column_default.sql` |
| O insert de `import:ofx` **não inclui** `tenant_id` nem `agent_id` | `scripts/import-ofx.ts:79` |
| Nenhuma das duas CLIs entra em contexto de tenant — `grep` de `runWithTenantContext`/`getCurrentTenant`: **zero ocorrências** | `scripts/import-ofx.ts`, `scripts/import-review.ts` |
| `applyTenantGuard` é opt-in por chamada de repo, não interceptador global do drizzle; os scripts usam `db` diretamente | `src/db/tenant-guard.ts:16` |
| `import:apply` insere em `transacoes` sem tenant/agent e atualiza `transacoes`/`import_entries` **só por id**, sem predicado de tenant | `scripts/import-review.ts:160`, `:96` |
| O caminho de produção faz o oposto: `updateTransacaoWith` exige tenant e agent no `WHERE` e **falha alto** com 0 linhas | `src/db/repositories/finance-repos.ts:518` |
| Erro literal ao rodar a forma exata do insert contra um banco migrado: `ERROR: null value in column "tenant_id" of relation "import_runs" violates not-null constraint` | reprodução do dono. **Não re-executada nesta revisão** — não há Postgres nem Docker alcançável no ambiente onde ela foi feita |

**Conclusão.** `import:ofx` **está morta desde a `083`**: não grava uma linha. Como ela nunca cria uma run, o caminho tenant-inseguro de `import:apply` está hoje inalcançável — mas voltará a ser alcançável no minuto em que a ingestão for consertada, e por isso os dois defeitos precisam ser tratados juntos. Isso é agravado por o comando continuar listado como operacional em `AGENTS.md` §6.

**O que muda para a cobrança.** A resposta a "a liquidação chega pela Maia?" é **não por extrato bancário**. Hoje entraria apenas por `register_transaction` (manual/WhatsApp); ERP externo via MCP está recusado no boot em produção (#521). O dono precisa dizer se isso basta para o tenant do piloto. **O conserto da CLI não entra nas fatias 3–5 e não entra na PR desta spec** — tem issue própria.

---

### Q3 — Como se modela o principal de serviço?

| | |
|---|---|
| **Estado** | **BLOQUEANTE** |
| **Decide** | **Dono da segurança** |
| **Bloqueia** | Fatia 3 |

**Enunciado.** O agente autônomo precisa de um principal para as decisões de autorização. Criar uma "pessoa robô" encaixa no modelo mas introduz um principal sem humano por trás. A alternativa é um caminho de autorização que não passe por `pessoa`.

**Evidência.**

| Fato | Onde |
|---|---|
| `ToolContext` carrega `pessoa: Pessoa` como campo **obrigatório** | `src/tools/_dispatcher.ts:62` |
| `canAct` exige `pessoa: Pessoa` + `resolved: ResolvedPermission \| null`, e nega quando `resolved` é nulo | `src/governance/permissions.ts:97` |
| `evaluateFinancialAuthorization` idem, e é a decisão financeira única, fail-closed | `src/governance/financial-authorization.ts:172` |
| `agent_objectives` e `objective_tasks` **não têm coluna** para o principal, e portanto não o armazenam nem o reidratam | `migrations/088_agent_objectives.sql`, `migrations/138_objective_tasks_lease_fencing.sql`, `src/db/schema.ts` |
| O principal de serviço não pode ser dono/co_dono, senão herda a isenção de dual-approval da tool | `src/tools/send-proactive-message.ts:30`, `:42` |

**O que muda.** Se a resposta for "pessoa de serviço", é preciso decidir onde ela é ancorada, quem responde por ela e como o objetivo a reidrata a cada tick — nada disso existe. Se a resposta for "caminho sem `pessoa`", é mudança estrutural em três pontos de decisão de autorização. **Em nenhum dos casos é continuação de #521, que está mergeada**: é trabalho novo.

---

### Q4 — Quem sai da carteira por regra, e com qual dado?

| | |
|---|---|
| **Estado** | aberta — **política E dado** |
| **Decide** | Dono do produto + jurídico (a regra); dono do produto (onde o fato passa a viver) |
| **Bloqueia** | Fatia 4 |

**Enunciado.** Dívida contestada, negativada, prescrita, em acordo, devedor falecido, menor. A draft tratava isso como escolha de política. **É também lacuna de dado:** não existe campo autoritativo para nenhum desses estados.

**Evidência.**

| Critério | Onde deveria viver | Estado |
|---|---|---|
| Contestada / em disputa | `transacoes.status` | domínio é `('pendente','agendada','paga','recebida','cancelada')` — `migrations/001_initial.sql:71`. **Não existe** |
| Em acordo / renegociada | idem | **não existe** |
| Prescrita | idem, ou campo de data-base | **não existe** |
| Negativada / judicializada | `contrapartes` | a tabela tem `nome`, `documento`, `chave_pix`, `status` — `src/db/schema.ts:182`. **Nenhum campo de situação jurídica** |
| Falecido | `pessoas` | **não existe** |
| Menor | `pessoas.tipo` é `('pf','pj')` — `migrations/001_initial.sql:19`; não há data de nascimento | **não existe** |

**O que muda.** Cada critério precisa de **duas** respostas, não uma: qual é a regra, e **onde o fato passa a viver de forma autoritativa**. Sem a segunda, o filtro determinístico do perceptor não tem o que ler, e a regra vira comentário. Uma alternativa possível — marcar exclusões diretamente no envelope hash-pinado, item a item — é aceitável para um piloto de uma carteira, mas não escala e não sobrevive a mudança de estado durante a régua; é decisão do dono, não default.

---

### Q5 — Limites regulatórios, e o mecanismo que falta

| | |
|---|---|
| **Estado** | **BLOQUEANTE para a fatia 5** |
| **Decide** | **Jurídico** (os números e a base legal) + **DPO** (retenção e LGPD) |
| **Bloqueia** | Fatia 5 |

**Enunciado.** CDC art. 42 e a normativa aplicável a cobrança por mensagem: horário permitido, frequência máxima por destinatário, conteúdo obrigatório, opt-out e como é honrado, retenção do registro de contato, base legal para contatar o devedor por WhatsApp. A spec parametriza tudo isso no envelope; **os valores são jurídicos**.

**Além dos números, três lacunas de mecanismo — e esta é a parte que não se resolve com uma reunião.**

| Lacuna | Evidência | Consequência |
|---|---|---|
| **Frequência por destinatário não é implementável com o desenho proposto.** O unique é `(objective_id, carteira_item_id, step)`: teto por dívida, não por pessoa | spec §4.2 e §7.1b | Se o jurídico fixar "N contatos por pessoa por período", falta um escopo `(tenant, agent, devedor, janela)` **atravessando objetivos e mandatos**, que não existe |
| **O opt-out não tem registro operacional durável.** Busca por `opt_out`/`opt-out`/`descadastr` em `src/` e `migrations/`: as únicas ocorrências são um default de resolver (`src/user-layer/resolvers/rules-resolver.ts:60`), um comentário sobre contexto de tenant (`src/db/tenant-context.ts:128`) e a **descrição textual** de uma skill (`migrations/079_boleto_proposta_attendant_role_and_skills.sql:220`) | as três ocorrências acima | **Não há tabela, coluna nem tool** que registre "esta pessoa pediu para não ser contatada". Honrar opt-out exige construir isso primeiro |
| **A matriz de retenção segue `DRAFT — NOT APPROVED`**, pendente do jurídico/DPO | `docs/architecture/concerns/data-retention-matrix.md`, linha 3 | O registro de contato de cobrança é classe de dado nova sob uma matriz que ninguém aprovou |

**O que muda.** Números fora do envelope são inaplicáveis; números dentro do envelope entram no hash e ficam auditáveis. Mas dois deles — teto por destinatário e opt-out — exigem **construir mecanismo antes**, não só preencher um campo.

---

### Q6 — Grupo de controle: é aceitável, e qual é a unidade?

| | |
|---|---|
| **Estado** | aberta (a) + **proposta** (b) |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 (o desenho experimental é pré-fixado antes do envio real) |

**Enunciado, em duas partes.**
**(a)** O owner aceita não cobrar uma fatia da carteira durante o piloto? Sem holdout, "R$ recuperado" mede sobretudo quem pagaria de qualquer forma.
**(b)** Qual é a **unidade experimental**?

**Evidência da correção (b).** A draft sorteava **por item de carteira**. Isso contamina o experimento: uma pessoa com duas pendências pode cair em tratamento (item A) e em controle (item B) ao mesmo tempo. Ela recebe a régua e é contada no grupo que supostamente não recebeu nada — *spillover* clássico, que faz a diferença tratamento × controle **subestimar** o efeito real. A contaminação é maior justamente onde há mais dados, porque devedores com múltiplas pendências são os mais frequentes. O mecanismo que permite isso é o mesmo da Q5: nada no desenho agrupa por `devedor_pessoa_id` (spec §4.2).

**Proposta.** A unidade experimental é o **devedor** (`devedor_pessoa_id`): todos os itens de um mesmo devedor caem no mesmo braço. `holdout_unit` entra no envelope e portanto no hash, porque a unidade é parte do desenho pré-registrado, não detalhe do sorteador.

**O que muda.** Qualquer unidade **menor** que o devedor é experimentalmente inválida. Uma unidade **maior** (grupo econômico) é defensável, mas exige um agrupador que hoje não existe no schema. E mesmo com clusterização correta, o holdout continua sujeito a interferência fora do canal — o time humano de cobrança continua trabalhando a carteira. Isso não é resolvível por schema; é limitação a declarar no relatório.

---

### Q7 — O que entra em "líquido"?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 |

**Enunciado.** "R$ líquido recuperado" precisa descontar custo. Quais custos, medidos como?

**Evidência.**

| Componente | Estado | Onde |
|---|---|---|
| Custo de LLM | existe, mas agregado por **dia** (`cost.daily.llm.${day}`) e por **dia+pessoa** (`cost.daily.llm.${day}.${pessoa_id}`), em USD, em `agent_facts` | `src/lib/cost-ledger.ts:94`, `:102` |
| Atribuição de custo por objetivo/slot/régua | **não existe** | nenhuma chave desse escopo no ledger |
| Política cambial USD → BRL | **não existe** — busca por `cambio`/`exchange_rate`/`ptax`: zero ocorrências | `src/` |
| Tempo humano em exceções | **sem fonte** — não há cronômetro nem campo de esforço em `objective_tasks` | `src/db/schema.ts` |

**O que muda.** Se o dono aceitar rateio, é preciso escolher o critério e declará-lo. Se não aceitar, o número honesto passa a ser "recuperado bruto menos custo de mensagem" e **não deve ser chamado de líquido**. Ver também a Q1: sem ledger imutável de liquidação, nem o lado da receita é plenamente reproduzível (spec §9.1b).

---

### Q8 — Quantos passos, com que intervalo, e quando parar?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto (política de cobrança do tenant) |
| **Bloqueia** | Fatia 5 |

**Enunciado.** `max_steps_per_item`, `offset_days` e o critério de desistência. **Inclui, por causa da Q5, a política de parada quando um teto por destinatário for definido**: suprimir o slot, revogar a régua daquele devedor, ou escalar para humano. As três produzem comportamentos diferentes e nenhuma é default óbvio.

**Evidência.** Os campos existem no envelope proposto (spec §5.2) e entram no hash do mandato; o que falta são os valores. Não há valor default no repositório — o kind não existe.

**O que muda.** Muda o volume do piloto e a métrica. Um teto por destinatário sem política de parada definida produz o pior desfecho: a régua para no meio sem ninguém saber por quê.

---

### Q9 — Quem assina o mandato, e por quanto tempo a assinatura fica aberta?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto + dono da segurança (para a classe de aprovação) |
| **Bloqueia** | Fatia 5 |

**Enunciado.** `two_distinct_owners` exige dois owners distintos e ativos. O tenant do piloto tem dois? Se não, `requester_plus_one_owner` é aceitável para um mandato desta natureza? E o TTL: `DUAL_APPROVAL_TIMEOUT_HOURS` é 6h global — curto para juntar dois owners no console. O mandato ganha TTL próprio?

**Evidência.** As classes e o TTL vêm de #521 (`src/governance/approval-requests.ts`, `migrations/095`), e o mecanismo é WhatsApp-nativo por desenho; a spec §5.5 propõe decidir no console usando `approval_requests` só como evidência, o que exige `recordApprovalDecision` aceitar `channel: 'console'`.

**O que muda.** Baixar a classe de aprovação enfraquece o argumento central da spec (§5.1: aprovar o envelope equivale a aprovar cada envio **porque** dois humanos assinaram). É trade-off do dono, não simplificação técnica.

---

### Q10 — O que acontece quando o devedor responde no meio da noite?

| | |
|---|---|
| **Estado** | **proposta** — a spec resolve a contradição e propõe qual regra prevalece |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 4 |

**Enunciado.** A draft se contradizia: o §8.2 afirmava que o agente **nunca** responde autonomamente ao devedor no piloto, e a Q10 perguntava se ele responderia fora da janela. As duas regras não podem valer ao mesmo tempo.

**Evidência da contradição.** Spec draft §8.2 ("o agente não responde ao devedor de forma autônoma no piloto") contra o próprio §12.Q10 ("o agente responde fora da janela, ou fica em silêncio até a janela abrir?"). E o contexto que torna a segunda pergunta perigosa: **não existe gate de horário sobre mensagem de saída** — `horario_permitido` é gate financeiro por pessoa (`src/governance/financial-authorization.ts:172`), a regra semeada `no_action_outside_business_hours_high_risk` referencia `context.is_business_hours`, campo que não existe em lugar nenhum do código (`migrations/037`), e `business-day-rrule.ts` dá dia útil, não hora.

**Proposta.** **O §8.2 prevalece.** Não existe resposta autônoma ao devedor, em nenhum horário; toda resposta vira exceção humana. A Q10 deixa de ter objeto no piloto. Um acuse de recebimento automático, se o dono o quiser, é um **envio novo** — template próprio, dentro do mesmo mecanismo de slot e janela — e portanto decisão separada, não exceção à regra.

**O que muda.** Se o dono decidir o contrário, cai o argumento da spec §6.3 (o agente não redige texto para devedor) e a superfície de risco jurídico muda de natureza. Não é ajuste de configuração.

---

### Q11 — Onde o owner atende as exceções?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 |

**Enunciado.** A spec põe a fila no console. Isso significa que o owner precisa abrir o console para destravar — não resolve pelo WhatsApp. Aceitável para o piloto, ou destravar pelo celular é requisito?

**Evidência.** `uniq_pending_questions_active_per_conversa` (`migrations/004`) permite **uma** pending question aberta por conversa; a segunda cancela a primeira. Uma régua com dezenas de itens gera exceções em paralelo, então o canal WhatsApp seria funil, não fila. Além disso `pending_questions` não tem nenhuma superfície de console (nenhum router do admin-ui lê ou escreve a tabela) e `resolveTask` hoje aceita apenas `done|failed` (`src/admin-ui/trpc/routers/objectives.ts:64`) — a transição `resume` que a spec §8.3 exige **não existe**.

**O que muda.** Se destravar pelo celular for requisito, a limitação do índice precisa ser resolvida **antes**, em trabalho próprio, e isso muda a ordem das fatias.

---

### Q12 — Vale ligar o work loop a procedures algum dia?

| | |
|---|---|
| **Estado** | aberta — **explicitamente pós-piloto** |
| **Decide** | Maia maintainers |
| **Bloqueia** | nada |

**Enunciado.** O executor do kind chama `dispatchTool` diretamente. Isso é definitivo, ou o work loop deveria um dia rodar sobre procedures?

**Evidência de que hoje não dá.**

| Fato | Onde |
|---|---|
| O motor de procedures observa, não causa: não há caminho para o dispatcher | `src/procedures/engine.ts`, `src/cognition/step-evaluator.ts` |
| Nada em produção ativa uma procedure: `transitionProcedureStatus` e `atomicActivate` não têm caller de produção, e o router `procedures` do admin-ui é somente leitura | `src/cognition/procedure-status.ts:100` |
| O avanço de passo é efeito de cauda de um turno de entrada; um loop por cron não tem turno | post-turn graph |

**O que muda.** Nada no piloto. **Registrado aqui para que não seja falsamente resolvida dentro dele**: consertar a ativação de procedures é investimento próprio, e o desfecho honesto é um ADR seu depois da fatia 5 — ou a declaração explícita de que executor-em-código por kind é o desenho definitivo.

---

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| **A — Decision log em ADR próprio (escolhida)** | O registro sobrevive à spec; cada pergunta tem dono e evidência citável; a spec fica legível | Dois documentos para manter em sincronia |
| B — Manter as doze perguntas só no §12 da spec | Um arquivo só | Foi exatamente o que aconteceu na draft: doze perguntas em prosa, sem dono, sem estado, 120 commits sem PR e sem nenhuma respondida |
| C — Um ADR por pergunta | Granularidade máxima | Doze ADRs `Proposed` sobre um piloto que pode não acontecer; o custo de leitura mataria o uso |
| D — Decidir as perguntas dentro da spec e seguir | Rápido | É precisamente o defeito que este documento existe para impedir: nenhuma delas é decidível por quem escreve a spec |

## Consequences

**Positivas**

- As três bloqueantes (Q1, Q2b, Q3) ficam visíveis como gates, não como parágrafos no fim de um documento longo.
- Cada afirmação de estado do repositório tem caminho e linha, então envelhece de forma **detectável**: quando a linha mudar, a citação fica errada e alguém percebe.
- A correção da Q2c fica registrada onde importa — "existe e está quebrado" é um achado operacional que vale além da cobrança.
- As lacunas de **mecanismo** (teto por destinatário, opt-out, ledger de liquidação, atribuição de custo) deixam de ser confundidas com lacunas de **política**.

**Negativas**

- Dois documentos para manter alinhados. A spec cita e não duplica, mas a duplicação pode reaparecer por descuido.
- Um ADR `Proposed` que fica muito tempo aberto vira ruído. Se o piloto for arquivado, este documento deve ser marcado como superseded, não deletado — o inventário de lacunas continua útil.
- Números de linha envelhecem entre PRs. É o preço aceito para que a evidência seja verificável em vez de assertiva.

## Validation

Como saberemos que esta decisão está funcionando:

- Nenhuma PR de cobrança (fatias 3–5) é aberta sem que Q1, Q2b e Q3 estejam respondidas neste documento, com data e quem respondeu.
- A fatia 2 avança sem esperar nenhuma das doze — se ela travar por causa delas, a separabilidade declarada na spec §4.6 não era real.
- Toda revisão da spec de cobrança atualiza este documento no mesmo commit.
- Quando uma pergunta é respondida, o estado muda aqui **antes** de a resposta aparecer em código.

## Reversal Criteria

- Se o piloto de cobrança for arquivado, este ADR vira `Superseded` com o motivo — e o inventário de lacunas (Q2c, Q4, Q5, Q7) migra para as issues que as tratarem, porque nenhuma delas é específica de cobrança.
- Se um segundo objetivo de efeito real aparecer antes de o piloto acontecer, o formato "uma pergunta, um dono, uma evidência" deve ser generalizado em vez de copiado.

## References

- Spec: [`docs/superpowers/specs/2026-07-31-collections-work-loop-design.md`](../../superpowers/specs/2026-07-31-collections-work-loop-design.md)
- Spec v1 do work loop: [`docs/superpowers/specs/2026-06-10-agent-work-loop-design.md`](../../superpowers/specs/2026-06-10-agent-work-loop-design.md)
- Módulo: [`docs/architecture/modules/objectives.md`](../modules/objectives.md)
- Matriz de retenção (DRAFT, pendente do DPO): [`docs/architecture/concerns/data-retention-matrix.md`](../concerns/data-retention-matrix.md)
- Isolamento por tenant: [`docs/architecture/concerns/tenant-isolation.md`](../concerns/tenant-isolation.md)
- `migrations/088_agent_objectives.sql`, `migrations/138_objective_tasks_lease_fencing.sql`, `migrations/083_drop_default_column_default.sql`

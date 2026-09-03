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

**Cada uma das doze perguntas ganha estado, dono, consequência e — quando existe — evidência de repositório com caminho e linha. Três delas são declaradas BLOQUEANTES: nenhuma fatia de cobrança (3, 4 ou 5) começa enquanto Q1, Q2b e Q3 não estiverem assinadas.** O registro é este documento; a spec cita, não duplica.

Duas regras de leitura, e elas são a razão do formato:

- **"Evidência" significa código, schema ou migração que qualquer pessoa pode abrir.** Onde não há evidência, o campo diz *não verificado* — nunca "provavelmente" e nunca "acredito".
- **Uma pergunta em aberto aparece apenas como opções.** Nada afirmado no indicativo, nenhum critério de aceite e nenhum valor concreto — inclusive nenhum valor "de exemplo".

### Legenda de estado

| Estado | Significado |
|---|---|
| **bloqueante** | Nenhuma fatia de cobrança (3, 4 ou 5) começa sem resposta assinada |
| **aberta** | Precisa de resposta antes da fatia indicada; não bloqueia o resto |

O estado **`proposta`** foi **removido desta legenda**, e essa remoção é a correção mais importante desta revisão. «a spec sugere X, falta só assinar» parece cautela e funciona como default: X entra no envelope, vira exemplo num bloco de código, aparece três vezes, e na quarta ninguém lembra que ninguém escolheu. As perguntas que estavam em `proposta` (Q6b e Q10) voltaram para `aberta`, com as opções lado a lado.

### O formato de uma decisão aberta

Toda decisão ainda aberta aparece — **neste documento e na spec, com o mesmo marcador** — assim:

```
> **DECISÃO ABERTA — DA-nn · rótulo** — Qn do ADR 0006
>
> As opções, sem nenhuma marcada como preferida por ordem, diagramação ou tom.
>
> **O que muda.** A consequência de cada escolha.
>
> - `decided_by:`
> - `decided_at:`
```

Os dois campos ficam **presentes e vazios**. O campo vazio é o que torna a ausência de decisão visível em vez de esquecida: um leitor que procura "quem decidiu isso?" encontra a lacuna em vez de encontrar um valor.

**Um valor só entra na spec depois que os dois campos estiverem preenchidos** — e promover um valor é um ato de quatro passos, todos no mesmo PR: preencher os campos, escrever o valor como regra, remover o bloco, e remover o item da lista de `tests/unit/docs/decisoes-abertas-cobranca.spec.ts`. Esse último passo é o que torna a promoção visível em code review; sem ele, o guard reprova.

| Bloco | Onde mora | Pergunta |
|---|---|---|
| **DA-01** — fração do holdout | spec §5.2, e Q6 aqui | Q6(a) |
| **DA-02** — unidade experimental do holdout | spec §5.2 e §9.2, e Q6 aqui | Q6(b) |
| **DA-03** — cadência (passos e intervalo) | spec §5.2, e Q8 aqui | Q8 |
| **DA-04** — janela de contato | spec §5.2, e Q5 aqui | Q5 / Q8 |
| **DA-05** — máximo de passos por item | spec §5.2, e Q8 aqui | Q8 |
| **DA-06** — janela de atribuição da métrica | spec §5.2, e Q7 aqui | Q7 |
| **DA-07** — superfície da fila de exceções | spec §8.4, e Q11 aqui | Q11 |
| **DA-08** — série temporal da métrica (snapshot × ledger) | spec §9.1b, e Q7 aqui | Q1 / Q7 |
| **DA-09** — resposta ao inbound do devedor | spec §8.2, e Q10 aqui | Q10 |
| **DA-10** — classe, canal e TTL do mandato | spec §5.5, e Q9 aqui | Q9 |
| **DA-11** — composição do "R$ líquido" | spec §9.1b, e Q7 aqui | Q7 |
| **DA-12** — limiar do breaker automático | spec §11.3, e Q8 aqui | Q8 / Q5 |

---

### Q1 — A Maia consegue saber quem deve e quem pagou?

| | |
|---|---|
| **Estado** | **BLOQUEANTE** |
| **Decide** | Dono do produto, com o tenant do piloto |
| **Bloqueia** | Fatias 3 a 5 — todas, não só a primeira |

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
| **Bloqueia** | Fatias 3 a 5 — a 3 pelo desenho, a 4 pela curadoria pronta, a 5 porque nenhuma das duas se desfaz |

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
| **Bloqueia** | Fatias 3 a 5 — todas, não só a primeira |

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

> **DECISÃO ABERTA — DA-04 · janela de contato (horário, dias, feriados, fuso)** — Q5 e Q8
>
> O conteúdo de `contact_window` no envelope (spec §5.2). Opções (a ordem não é ranking):
>
> - **(a)** a janela mínima que o jurídico apontar como exigida pela normativa aplicável;
> - **(b)** uma janela mais estreita que a exigida, por política do tenant;
> - **(c)** janela por fuso do devedor, em vez de um fuso único do tenant;
> - **(d)** janela por dia da semana, com regra própria para sábado e véspera de feriado.
>
> **O que muda.** A janela seria o **único** gate de horário deste caminho: não existe gate de horário sobre mensagem de saída hoje (spec §6.2b) — `horario_permitido` é gate financeiro por pessoa (`src/governance/financial-authorization.ts:172`), `no_action_outside_business_hours_high_risk` referencia `context.is_business_hours`, campo inexistente no código (`migrations/037`), e `business-day-rrule.ts` dá dia útil, não hora. A opção (c) exige um fuso por pessoa que o schema não tem. Os números são jurídicos antes de serem operacionais, e interagem com DA-03 e DA-09.
>
> - `decided_by:`
> - `decided_at:`

---

### Q6 — Grupo de controle: é aceitável, e qual é a unidade?

| | |
|---|---|
| **Estado** | aberta (a) + aberta (b) |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 (o desenho experimental é pré-fixado antes do envio real) |

**Enunciado, em duas partes.**
**(a)** O owner aceita não cobrar uma fatia da carteira durante o piloto? Sem holdout, "R$ recuperado" mede sobretudo quem pagaria de qualquer forma.
**(b)** Qual é a **unidade experimental**?

**Evidência da correção (b).** A draft sorteava **por item de carteira**. Isso contamina o experimento: uma pessoa com duas pendências pode cair em tratamento (item A) e em controle (item B) ao mesmo tempo. Ela recebe a régua e é contada no grupo que supostamente não recebeu nada — *spillover* clássico, que faz a diferença tratamento × controle **subestimar** o efeito real. A contaminação é maior justamente onde há mais dados, porque devedores com múltiplas pendências são os mais frequentes. O mecanismo que permite isso é o mesmo da Q5: nada no desenho agrupa por `devedor_pessoa_id` (spec §4.2).

`holdout_unit` entra no envelope e portanto no hash, porque a unidade é parte do desenho pré-registrado, não detalhe do sorteador. **Qual unidade, e qual fração, ninguém decidiu** — e a v2 anterior deste ADR trazia uma "proposta" que, na spec, já tinha virado valor de exemplo dentro de um bloco de código: uma fração e uma unidade escritas no envelope como se fossem detalhe de amostra.

> **DECISÃO ABERTA — DA-01 · fração do holdout** — Q6(a)
>
> Que fatia da carteira fica sem ser cobrada durante o piloto. Opções (a ordem não é ranking):
>
> - **(a)** nenhuma — piloto sem grupo de controle;
> - **(b)** uma fração fixa, a definir pelo dono do produto;
> - **(c)** uma fração dimensionada por poder estatístico, a partir do tamanho da carteira;
> - **(d)** holdout só na primeira janela, com a carteira inteira tratada depois.
>
> **O que muda.** Com (a), "R$ recuperado" mede sobretudo quem pagaria de qualquer forma, e o critério de saída da fase 2 fica sem contrafactual. (b) e (c) custam recuperação real durante o piloto, e (c) exige um cálculo de poder que ninguém fez. (d) mede só efeito de curto prazo. O valor entra no hash do mandato: mudá-lo depois invalida a régua inteira.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-02 · unidade experimental do holdout** — Q6(b)
>
> O que é sorteado entre tratamento e controle. Opções (a ordem não é ranking):
>
> - **(a)** o item de carteira (uma dívida) — o que a draft fazia;
> - **(b)** o devedor (`devedor_pessoa_id`);
> - **(c)** o documento (CPF/CNPJ), agrupando homônimos e duplicatas de `pessoas`;
> - **(d)** o grupo econômico.
>
> **O que muda.** Com (a), uma pessoa com duas pendências cai em tratamento por um item e em controle por outro: recebe a régua e é contada no grupo que não recebeu nada — *spillover*, que faz a diferença tratamento × controle **subestimar** o efeito, e cuja contaminação é maior justamente onde há mais dados. (b) fecha isso dentro de uma carteira, não entre carteiras. (c) e (d) fecham mais, e exigem um agrupador que **não existe no schema** — não há documento normalizado com deduplicação nem noção de grupo econômico; e (c) ainda esbarra em homônimos e duplicatas em `pessoas`, que é trabalho de dados. Nenhuma das quatro elimina a interferência fora do canal: o time humano de cobrança continua trabalhando a carteira, e isso não é resolvível por schema — é limitação a declarar no relatório.
>
> - `decided_by:`
> - `decided_at:`

---

### Q7 — O que entra em "líquido"?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 |

**Enunciado.** "R$ líquido recuperado" promete um desconto de custo embutido no nome. Quais custos entram, medidos como — e o número ainda pode chamar-se "líquido"? (**DA-11**)

**Evidência.**

| Componente | Estado | Onde |
|---|---|---|
| Custo de LLM | existe, mas agregado por **dia** (`cost.daily.llm.${day}`) e por **dia+pessoa** (`cost.daily.llm.${day}.${pessoa_id}`), em USD, em `agent_facts` | `src/lib/cost-ledger.ts:94`, `:102` |
| Atribuição de custo por objetivo/slot/régua | **não existe** | nenhuma chave desse escopo no ledger |
| Política cambial USD → BRL | **não existe** — busca por `cambio`/`exchange_rate`/`ptax`: zero ocorrências | `src/` |
| Tempo humano em exceções | **sem fonte** — não há cronômetro nem campo de esforço em `objective_tasks` | `src/db/schema.ts` |

**O que muda.** O que entra na conta — o critério de rateio, a política cambial, o custo humano, e o nome honesto do número — é a **DA-11** abaixo; a revisão anterior deste ADR respondia isso em prosa ("aceitar rateio ou parar de chamar de líquido"), que é escolher sem assinar. Ver também a Q1: sem ledger imutável de liquidação, nem o lado da receita é plenamente reproduzível (spec §9.1b).

> **DECISÃO ABERTA — DA-11 · composição do "R$ líquido" (o que entra na conta, e o nome honesto do número)** — Q7
>
> Quais custos o "líquido" desconta do recuperado bruto, medidos como — e se o resultado ainda pode chamar-se "líquido". Opções (a ordem não é ranking):
>
> - **(a)** só o custo de mensagem — e o número passa a chamar-se "recuperado bruto menos custo de mensagem", nunca "líquido";
> - **(b)** custo de mensagem mais custo de LLM rateado ao piloto por um critério declarado no relatório, com conversão USD→BRL por política cambial igualmente declarada — ambos inexistentes hoje (`src/lib/cost-ledger.ts:94`, `:102`; nenhuma conversão cambial no repositório);
> - **(c)** (b) mais o custo humano das exceções, estimado por contagem de exceções × constante declarada pelo dono;
> - **(d)** nenhum desconto: reportar recuperado bruto e cada custo separadamente, sem subtração, e aposentar a palavra "líquido" no relatório do piloto.
>
> **O que muda.** O nome do critério de saída da fase 2 — e a honestidade dele. (a) e (d) são computáveis hoje e abandonam a promessa da palavra "líquido"; (b) exige atribuição de custo por objetivo e política cambial, que **não existem**, e todo rateio é uma escolha que muda o número; (c) soma uma constante que ninguém mediu. Seja qual for, o relatório da fatia 5 declara a composição escolhida junto do número. Interage com DA-06 (janela de atribuição) e DA-08 (série temporal da receita).
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-06 · janela de atribuição da métrica** — Q7 e spec §9.1
>
> O `attribution_window_days` do envelope: quanto tempo depois de um contato um pagamento ainda conta como relacionado a ele. Opções (a ordem não é ranking):
>
> - **(a)** uma janela fixa em dias, igual para todos os passos;
> - **(b)** uma janela por passo (o último contato "vale" menos tempo);
> - **(c)** janela até o próximo contato do mesmo item, sem sobreposição;
> - **(d)** sem janela: compara-se só o estado final de tratamento × controle no fim do piloto.
>
> **O que muda.** A janela é o que separa "o contato teve efeito" de "a pessoa ia pagar mesmo". Estar dentro do hash é o que impede ajustá-la depois de ver o resultado — por isso ela precisa ser escolhida **antes** do primeiro envio, e por isso um valor de exemplo aqui é pior que campo vazio. Interage com DA-03: janelas maiores que o intervalo entre passos fazem contatos se sobreporem na atribuição.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-08 · como a métrica recupera a série temporal que `transacoes` não guarda** — Q1 e Q7
>
> `transacoes` é atualizada in-place (`src/db/repositories/finance-repos.ts:518`) e não há ledger de liquidação. Opções (a ordem não é ranking):
>
> - **(a)** nada: a métrica declara-se observável e não reproduzível, e o relatório diz isso;
> - **(b)** ledger append-only de liquidação, com migração própria — resolve na raiz, e é trabalho fora da spec de cobrança;
> - **(c)** cópia imutável e datada do estado dos itens da carteira, gravada a cada ciclo pelo worker de métrica;
> - **(d)** (c) restrita aos itens da carteira do piloto, descartada no fim dele.
>
> **O que muda.** (a) é honesta e de graça, e deixa o critério de saída da fase 2 sem número reproduzível. (b) é a única que torna o passado auditável, e a mais cara. (c) e (d) não tornam o passado imutável retroativamente — criam a série a partir do dia em que o piloto começa — e são **classe de dado nova** sob uma matriz de retenção que segue `DRAFT — NOT APPROVED` (Q5), logo passam pelo DPO. Nenhuma das quatro conserta a atribuição de custo, que continua sendo esta Q7.
>
> - `decided_by:`
> - `decided_at:`

---

### Q8 — Quantos passos, com que intervalo, e quando parar?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto (política de cobrança do tenant) |
| **Bloqueia** | Fatia 5 |

**Enunciado.** `max_steps_per_item`, `offset_days` e o critério de desistência. **Inclui, por causa da Q5, a política de parada quando um teto por destinatário for definido**: suprimir o slot, revogar a régua daquele devedor, ou escalar para humano. As três produzem comportamentos diferentes e nenhuma é default óbvio. E inclui o outro "quando parar": o breaker automático do nível 0 (spec §11.3) tem o **mecanismo** desenhado — pausa, exceção, sem re-arme — e o **gatilho** por decidir (**DA-12**, abaixo).

**Evidência.** Os campos existem no envelope proposto (spec §5.2) e entram no hash do mandato; o que falta são os valores. Não há valor default no repositório — o kind não existe.

**O que muda.** Muda o volume do piloto e a métrica. Um teto por destinatário sem política de parada definida produz o pior desfecho: a régua para no meio sem ninguém saber por quê.

> **DECISÃO ABERTA — DA-03 · cadência (quais passos, com que intervalo)** — Q8
>
> O conteúdo de `steps` no envelope: quantos passos, qual `template_id` em cada um, e o `offset_days` entre eles. Opções (a ordem não é ranking):
>
> - **(a)** passo único, sem follow-up;
> - **(b)** régua curta, com intervalo fixo entre passos;
> - **(c)** régua com intervalos crescentes;
> - **(d)** cadência derivada do atraso do item.
>
> **O que muda.** Volume do piloto, custo por item e leitura da métrica: passos demais fazem o efeito medido incluir fadiga, passos de menos deixam o piloto sem sinal. Interage com DA-04 (a janela empurra passos para o próximo dia útil) e com um eventual teto por destinatário, que hoje **não existe como mecanismo** (spec §7.1b).
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-05 · máximo de passos por item** — Q8
>
> O `max_steps_per_item`, que é o teto físico de linhas materializadas por item. Opções (a ordem não é ranking):
>
> - **(a)** teto pequeno e fixo, igual para toda a carteira;
> - **(b)** teto por faixa de valor ou de atraso;
> - **(c)** teto igual ao número de passos de `steps` (DA-03), sem folga;
> - **(d)** teto derivado de um limite jurídico por destinatário, se a Q5 fixar um.
>
> **O que muda.** É a contagem física de slots: não há caminho pelo qual o loop envie mais do que os slots materializados **para aquele item**. Mas o teto é **por dívida, não por destinatário** — com (d), o mecanismo descrito na spec é insuficiente e precisa de escopo `(tenant, agent, devedor, janela)` atravessando objetivos e mandatos, que não existe.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-12 · limiar do breaker automático (nível 0)** — Q8 e Q5
>
> Quanto sinal dispara o breaker do nível 0 (spec §11.3), contado como, sobre que janela — e onde o valor vive. Opções (a ordem não é ranking):
>
> - **(a)** qualquer ocorrência única — o primeiro sinal jurídico, opt-out ou bloqueio de entrega pausa o objetivo;
> - **(b)** um teto absoluto por objetivo, fixado pelo dono no envelope (e portanto no hash do mandato);
> - **(c)** um teto proporcional ao volume de envios ou ao tamanho da carteira, com o denominador declarado;
> - **(d)** limiar por tipo de sinal — sinal jurídico dispara sozinho; falha de entrega e opt-out acumulam até um teto próprio.
>
> **O que muda.** (a) é a mais conservadora e a única sem número a escolher — e transforma um falso positivo isolado em parada do piloto inteiro. (b) põe o valor sob a mesma assinatura do mandato; mudá-lo re-materializa a régua (spec §5.3). (c) exige definir denominador e janela, que são duas decisões a mais, não menos. (d) reconhece que os sinais têm gravidade diferente — e o que conta como "reclamação" esbarra na Q5: **o opt-out não tem registro operacional durável hoje**, então um limiar sobre sinal que o sistema não registra é decorativo. Em qualquer opção, o critério de aceite 27 da spec §14 só é escrevível depois da assinatura.
>
> - `decided_by:`
> - `decided_at:`

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

> **DECISÃO ABERTA — DA-10 · classe de aprovação, canal e TTL do mandato** — Q9
>
> Quem assina o mandato, por onde, e por quanto tempo a assinatura fica aberta. Opções (a ordem não é ranking):
>
> - **(a)** `two_distinct_owners` assinado no console, com `approval_requests` só como evidência — exige que `recordApprovalDecision` aceite `channel: 'console'`;
> - **(b)** `two_distinct_owners` assinado por WhatsApp, no mecanismo nativo de #521, sem código novo de canal;
> - **(c)** `requester_plus_one_owner`, se o tenant do piloto não tiver dois owners distintos e ativos;
> - **(d)** classe nova, específica de mandato, com TTL próprio maior que `DUAL_APPROVAL_TIMEOUT_HOURS`.
>
> **O que muda.** (c) enfraquece o argumento da spec §5.1. (a) e (d) são código novo. (b) contraria o blueprint, que mantém dual-approval no console. O TTL global de `DUAL_APPROVAL_TIMEOUT_HOURS` (**6h**, fato do repo) é curto para juntar dois owners no console, o que empurra para (d) — ou para um mandato que expira antes de ser assinado. A spec **não escolhe**: até esta decisão, §4.1 e §4.3 referenciam "a classe da DA-10", sem nomear uma.
>
> - `decided_by:`
> - `decided_at:`

---

### Q10 — O que acontece quando o devedor responde no meio da noite?

| | |
|---|---|
| **Estado** | aberta — a contradição da draft está diagnosticada; **a resolução não foi decidida** |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 4 |

**Enunciado.** A draft se contradizia: o §8.2 afirmava que o agente **nunca** responde autonomamente ao devedor no piloto, e a Q10 perguntava se ele responderia fora da janela. As duas regras não podem valer ao mesmo tempo.

**Evidência da contradição.** O §8.2 da draft afirmava silêncio autônomo total no piloto, contra o próprio §12.Q10 ("o agente responde fora da janela, ou fica em silêncio até a janela abrir?"). E o contexto que torna a segunda pergunta perigosa: **não existe gate de horário sobre mensagem de saída** — `horario_permitido` é gate financeiro por pessoa (`src/governance/financial-authorization.ts:172`), a regra semeada `no_action_outside_business_hours_high_risk` referencia `context.is_business_hours`, campo que não existe em lugar nenhum do código (`migrations/037`), e `business-day-rrule.ts` dá dia útil, não hora.

**A revisão anterior "resolveu" isto escolhendo um dos lados** — o do §8.2 — e registrou a escolha como proposta. Isso é a mesma falha em outra forma: a spec passou a afirmar, no indicativo, um comportamento que ninguém assinou, e ganhou um critério de aceite que proibia qualquer envio de volta a qualquer hora, fixando a decisão dentro de um checklist. As quatro opções ficam lado a lado:

> **DECISÃO ABERTA — DA-09 · resposta ao inbound do devedor (inclusive fora da janela)** — Q10
>
> O que o loop faz quando o devedor responde. Opções (a ordem não é ranking):
>
> - **(a)** silêncio: toda resposta vira exceção humana, sem nenhum envio de volta, em qualquer horário;
> - **(b)** acuse de recebimento automático por template próprio, dentro do mesmo mecanismo de slot e janela — logo, silêncio fora da janela;
> - **(c)** acuse de recebimento automático em qualquer horário, fora do mecanismo de slot;
> - **(d)** resposta por template para uma classificação tipada estreita (promessa de pagamento com data, alegação de já ter pago), com tudo o mais virando exceção humana.
>
> **O que muda.** (a) é a mais restritiva e a que menos exige código; deixa o devedor sem retorno até um humano abrir a fila (DA-07). (b) exige mecanismo de janela para inbound, que não existe — **não há gate de horário sobre mensagem de saída** (`horario_permitido` é gate financeiro por pessoa, `src/governance/financial-authorization.ts:172`; `no_action_outside_business_hours_high_risk` referencia `context.is_business_hours`, campo inexistente, `migrations/037`; `business-day-rrule.ts` dá dia útil, não hora). (c) contorna a janela e é a que mais expõe o piloto se a Q5 fixar horário permitido. (d) enfraquece o argumento da spec §6.3 e muda a natureza da superfície de risco jurídico, porque o agente passa a emitir mensagem **em reação ao conteúdo** do devedor. Nenhuma das quatro é ajuste de configuração.
>
> - `decided_by:`
> - `decided_at:`

---

### Q11 — Onde o owner atende as exceções?

| | |
|---|---|
| **Estado** | aberta |
| **Decide** | Dono do produto |
| **Bloqueia** | Fatia 5 |

**Enunciado.** Onde o owner destrava uma tarefa em `waiting_human`: no console, no WhatsApp, ou nos dois? A draft e a v2 anterior davam isto por resolvido no console — mas quem atende a fila é decisão de produto, não consequência técnica de um índice.

**Evidência.** `uniq_pending_questions_active_per_conversa` (`migrations/004`) permite **uma** pending question aberta por conversa; a segunda cancela a primeira. Uma régua com dezenas de itens gera exceções em paralelo, então o canal WhatsApp seria funil, não fila. Além disso `pending_questions` não tem nenhuma superfície de console (nenhum router do admin-ui lê ou escreve a tabela) e `resolveTask` hoje aceita apenas `done|failed` (`src/admin-ui/trpc/routers/objectives.ts:64`) — a transição `resume` que a spec §8.3 exige **não existe**.

**O que muda.** Se destravar pelo celular for requisito, a limitação do índice precisa ser resolvida **antes**, em trabalho próprio, e isso muda a ordem das fatias.

> **DECISÃO ABERTA — DA-07 · superfície em que o humano atende a fila de exceções** — Q11
>
> Onde o owner destrava uma tarefa em `waiting_human`. Opções (a ordem não é ranking):
>
> - **(a)** só no console (`objective_tasks.status='waiting_human'` + `resolveTask`), com `objective_tasks.pending_question_id` NULL;
> - **(b)** só no WhatsApp, caso a caso — exige resolver antes a limitação de `uniq_pending_questions_active_per_conversa` (`migrations/004`), em trabalho próprio;
> - **(c)** console para atender, mais notificação agregada por WhatsApp ("N casos aguardam você"), que não é pergunta por caso e não esbarra no índice;
> - **(d)** as duas superfícies com paridade, o que exige (b) mais reconciliação entre elas.
>
> **O que muda.** (a) obriga o owner a abrir o console para destravar — não resolve pelo celular. (b) e (d) mudam a **ordem das fatias**: o índice da `004` vira pré-requisito da fatia 4. (c) é o meio-termo e ainda exige um agregador que não existe. Em qualquer opção, `resolveTask` precisa passar a aceitar `resume` (hoje só `done|failed`, `src/admin-ui/trpc/routers/objectives.ts:64`) — essa parte não depende da superfície.
>
> - `decided_by:`
> - `decided_at:`

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
- Doze decisões que estavam dentro da spec como valor, regra ou critério de aceite passam a estar como **opções com dono e campo de assinatura vazio**, e um teste mecânico impede que voltem a entrar sem assinatura. (Dez vieram da primeira varredura; a composição do "líquido" — DA-11 — e o limiar do breaker — DA-12 — vieram da releitura do dono em 2026-09-03.)

**Negativas**

- Dois documentos para manter alinhados. A spec cita e não duplica, mas a duplicação pode reaparecer por descuido.
- Um ADR `Proposed` que fica muito tempo aberto vira ruído. Se o piloto for arquivado, este documento deve ser marcado como superseded, não deletado — o inventário de lacunas continua útil.
- Números de linha envelhecem entre PRs. É o preço aceito para que a evidência seja verificável em vez de assertiva.

## Validation

Como saberemos que esta decisão está funcionando:

- Nenhuma PR de cobrança (fatias 3–5) é aberta sem que Q1, Q2b e Q3 estejam respondidas neste documento, com data e quem respondeu. As três bloqueiam as **três** fatias, e a spec §13 as nomeia em cada uma das três linhas — não por herança implícita da linha acima.
- **Nenhum valor de decisão aberta reaparece nas formas que a draft usou** — travado por [`tests/unit/docs/decisoes-abertas-cobranca.spec.ts`](../../../tests/unit/docs/decisoes-abertas-cobranca.spec.ts), que varre prosa, tabelas e blocos de código, item por item, e reprova também um bloco assinado cujo valor não foi promovido. **O guard não cobre prosa arbitrária, e nenhum item pretende cobrir**: o que ele tem é uma lista enumerada de formas conhecidas por item, declarada no cabeçalho daquele arquivo junto com as formas que sabidamente atravessam. A defesa que sustenta esta decisão não é a regex — é a promoção exigir os quatro passos acima no mesmo PR, com o quarto caindo na frente de um revisor.
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

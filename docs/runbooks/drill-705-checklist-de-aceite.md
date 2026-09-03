# Checklist de aceite — drill de migration em staging (issue #705)

> A #705 diz o que a decisão precisa ser: *"para que a decisão seja marcar
> caixas e não redigir texto"*. Este arquivo é essa lista. Ele existe para que
> ninguém precise julgar, no fim de uma janela cansativa, se "o app não subiu" é
> ou não evidência suficiente.
>
> **Não é.** "O app não subiu" e "o app não subiu, o log nomeia a migration X, o
> ledger registra `dirty` com o SQLSTATE, e o `/readyz` ficou vermelho por N
> segundos" são coisas diferentes. Cada item abaixo diz o que **conta** e o que
> **não conta**.
>
> Nenhum agente marca estas caixas. A decisão do item 7 é de
> **@diogenesmendes01**.

Preencher com o [gabarito de coleta](drill-705-gabarito-de-coleta.md) ao lado.

| Campo | Valor |
|---|---|
| **Data** | |
| **Horário BRT (início — fim)** | |
| **Condutor** | |

---

## Evidência 1 — Execução em staging, com data, janela e quem conduziu

**O que conta**

- [ ] Data preenchida
- [ ] Horário de início **e** de término, em BRT
- [ ] Nome do condutor
- [ ] Identificação do alvo (instância/host de staging), e a confirmação
      explícita de que **não** era produção
- [ ] Saída do `--fase=contexto` colada, com `expected_head` e `applied_head`

**O que NÃO conta**

- "rodei em staging semana passada" sem data e horário
- um alvo descrito como "o banco de sempre"
- a saída de `--fase=roteiro` (ela não toca no banco; não prova execução)

---

## Evidência 2 — Uma migration que FALHA impede o app novo de iniciar

> É o item que faz disto um drill. Sem ele é um deploy que deu certo. Ele tem
> **dois lados**, e os dois precisam de evidência própria: o lado do **banco**
> (o ledger e a readiness) e o lado da **aplicação** (o orquestrador e o
> tráfego). Marcar só o primeiro prova que o runner funciona, não que o gate
> existe.

### 2a — Lado do banco

- [ ] `runner_outcome = failed`
- [ ] `falha_ledger_status = dirty` — **não** `failed`, **não** ausente
- [ ] O SQLSTATE da falha está registrado (`falha_classe`; esperado `23514`,
      a violação de CHECK que a fixture provoca de propósito)
- [ ] O evento `migration.dirty` aparece no log, **nomeando a migration**
      `900_drill705_falha_deliberada.sql`
- [ ] `readiness_apos_falha_pronto = false`, com o blocker citado por nome
- [ ] `readiness_como_imagem_quebrada_pronto = false`, com o blocker citado
      por nome

> **Por que dois vereditos de readiness.** A leitura contra `migrations/` da
> build em uso reporta `missing_file` (o ledger tem uma linha para uma migration
> que esta imagem não empacota). A leitura contra o overlay reporta
> `dirty_migration` — que é a forma que um release realmente quebrado produz.
> Os dois reprovam fail-closed; registrar só um faria o gabarito afirmar mais do
> que o drill provou.

### 2b — Lado da aplicação

- [ ] O passo/recurso de migration do orquestrador saiu com código **diferente
      de zero**, e o código está registrado
- [ ] **A aplicação nova não recebeu tráfego.** Uma destas, dita explicitamente:
  - [ ] o painel abortou o rollout e a versão anterior seguiu servindo; **ou**
  - [ ] a aplicação nova subiu e morreu no boot (exit code registrado); **ou**
  - [ ] a aplicação nova subiu, ficou fora de prontidão, e o balanceador não a
        colocou em rotação — com a prova disso, não a suposição
- [ ] `/readyz` do app novo respondeu **não-200**, com pelo menos uma amostra
      colada e o horário BRT dela

**O que NÃO conta**

- "o app não subiu" sem dizer **o quê** o impediu
- readiness vermelha sem nenhuma observação do lado do orquestrador — isso prova
  que o schema sabe que está quebrado, não que o tráfego foi barrado
- um `/readyz` que ninguém consultou, com a conclusão inferida do painel
- o CI (`smoke do job migrate na imagem real`). Ele roda o migrator contra um
  Postgres efêmero; **não** exercita readiness de uma aplicação nova sobre
  schema quebrado. A própria #705 diz isso

---

## Evidência 3 — Recuperação, com `repair` auditável e quanto tempo levou

- [ ] O diagnóstico foi feito **antes** do reparo (`migrate status` e a
      inspeção do schema colados)
- [ ] O efeito parcial foi desfeito, e está dito **qual** era
      (a tabela `drill_705_marcador`)
- [ ] O `repair` foi `--as pending` (não `--as applied`), e o **motivo**
      persistido descreve o que foi conferido — não a palavra "reparando"
- [ ] `readiness_apos_reparo_estado = ready`
- [ ] **Duração registrada**, do momento em que a falha foi notada até a
      readiness voltar ao verde — em horário BRT, não em "uns minutos"

**O que NÃO conta**

- "limpei a flag". O runbook é explícito: nunca limpe o estado sem verificar o
  schema, e o campo de motivo existe para o próximo operador saber o que foi
  conferido
- `duracao_ms` do comando sozinho: ele mede o `repair`, não a recuperação.
  A recuperação inclui o diagnóstico

---

## Evidência 4 — Rollback compatível

- [ ] O *deploy* foi revertido, e está dito **como**
- [ ] **Nenhum `_down.sql` foi executado automaticamente** — confirmado, não
      presumido
- [ ] O ledger v2 continua legível **depois** do rollback (saída de
      `--fase=contexto` colada, com `expected_head`/`applied_head`)
- [ ] A aplicação **anterior** subiu sobre o schema resultante e ficou `ready`

**O que NÃO conta**

- reverter o deploy sem tentar subir a versão anterior: o item é sobre
  compatibilidade do schema com o código antigo, não sobre desligar
- "não rodamos down" quando ninguém verificou se algum passo automático o faria

---

## Evidência 5 — Versão testada

- [ ] Tag **ou** SHA da imagem exercitada, registrada
- [ ] `expected_head` do manifest **dessa** imagem, registrado
- [ ] O `applied_head` do banco antes do drill, registrado

**O que NÃO conta**

- "a última imagem" / "o main de hoje"
- um `expected_head` copiado do repositório em vez de lido da imagem que rodou

---

## Evidência 6 — Logs sanitizados e resultado

- [ ] Todo log colado na issue passou por `--fase=sanitizar`
- [ ] `filtro_idempotente = true`
- [ ] O condutor **releu** o arquivo sanitizado e confirmou, item a item:
  - [ ] nenhuma connection string com credencial
  - [ ] nenhuma senha, token ou chave de API
  - [ ] nenhum SQL com dado de tenant
  - [ ] nenhum telefone, JID ou conteúdo de mensagem
- [ ] A allowlist de `tests/reliability/harness/sanitize.ts` **não** foi
      alterada para acomodar nenhum log

**O que NÃO conta**

- "olhei e não tinha nada" sem rodar o filtro
- afrouxar a allowlist. Se um log só passa depois disso, o certo é não colar o
  log. A allowlist é EXATA por decisão registrada na #510
- esquecer que o filtro mantém **host, porta e nome do banco** de uma connection
  string (só a credencial é redigida). Se o hostname for sensível, editar à mão

---

## Evidência 7 — Resultado explícito

- [ ] **ACEITO** — por @diogenesmendes01, em ____/____/____
- [ ] **NÃO ACEITO** — por @diogenesmendes01, em ____/____/____

**O que ficou pendente (obrigatório mesmo no caso "aceito"):**

```
```

---

## Consequência do aceite

Enquanto esta issue não tiver aceite, **a etapa 9 do rollout da #516 ("Ativar
migration job em produção") continua bloqueada**. O aceite aqui é condição
necessária; a autorização de produção é um ato separado e explícito do dono.

- [ ] Confirmo que o desbloqueio da etapa 9 depende **também** de uma
      autorização explícita minha, e que marcar as caixas acima não a concede

---

## Como esta bancada foi verificada (e o que continua sem prova)

| Afirmação | Status |
|---|---|
| O script recusa qualquer fase sem `--alvo` e `--dsn-env` declarados, em ambiente poluído por `DATABASE_URL`/`POSTGRES_URL`/`TEST_DB_URL`/`PGHOST` | **EXECUTADO** — `tests/unit/ops/drill-705-alvo-declarado.spec.ts` |
| Nenhum pool é aberto antes do portão (e um é aberto depois — controle positivo) | **EXECUTADO** — mesma spec |
| A fixture quebrada não está no artefato real; o overlay é montado fora do repositório; `migrations/` só é lido | **EXECUTADO** — `tests/unit/ops/drill-705-fixture-isolada.spec.ts` |
| A migration quebrada é `no-transaction`, logo a falha vira `dirty` e não `failed` | **EXECUTADO** — mesma spec, via `terminalLedgerStatusFor()` |
| Rodar o drill deixa o ledger `dirty` e a readiness bloqueada nos dois vereditos | **EXECUTADO contra um Postgres local descartável** — nunca contra staging |
| `repair --as pending` + `_down` devolvem a readiness a `ready` | **EXECUTADO contra o mesmo Postgres local** |
| **O orquestrador aborta o rollout quando o passo de migration falha** | **NÃO VERIFICADO** — é o item 2b, e só a janela responde |
| **`/readyz` da aplicação nova fica vermelho, e por quanto tempo** | **NÃO VERIFICADO** — exige instância de pé |
| **A aplicação anterior sobe sobre o schema resultante após o rollback** | **NÃO VERIFICADO** — exige a janela |
| **Que o drill se comporta igual sobre o volume de dados de staging** | **NÃO VERIFICADO** — o ensaio local rodou sobre banco vazio |

# Gabarito de coleta — drill de migration em staging (issue #705)

> **Este formulário é preenchido DURANTE a janela, não depois.** Um relatório
> escrito de memória três horas mais tarde é uma reconstrução, e reconstruções
> lembram do que funcionou. Cada bloco abaixo tem um campo para **o que
> falhou** e um para **o que não foi possível capturar** exatamente por isso:
> um gabarito que só tem espaço para sucesso induz preenchimento otimista.
>
> Copie este arquivo, preencha a cópia, e cole-a na issue #705 quando terminar.
> Os campos do cabeçalho ficam **vazios** aqui de propósito — quem os preenche
> é o dono, quando a janela existir.

---

## Cabeçalho da janela (OBRIGATÓRIO — nenhum campo pode ficar em branco no final)

| Campo | Valor |
|---|---|
| **Data** | |
| **Horário de início (BRT)** | |
| **Horário de término (BRT)** | |
| **Condutor** | |
| Alvo (instância/host de staging) | |
| Imagem exercitada (tag ou SHA) | |
| `expected_head` do manifest dessa imagem | |
| Autorizado por | |
| Diretório de evidências (`--saida`) | |

> Se **qualquer** um dos três primeiros estiver vazio quando você for colar na
> issue, o drill não tem registro de janela e o checklist de aceite não pode ser
> marcado. Volte e preencha, ou anote por que não é possível.

---

## Antes de começar

```bash
# O alvo é DECLARADO, nunca herdado. Exporte um nome PRÓPRIO — o script recusa
# DATABASE_URL, POSTGRES_URL, TEST_DB_URL, PGHOST e afins exatamente porque
# esses já estão exportados no seu terminal por outro motivo.
export DRILL_705_DSN='postgres://<usuario>:<senha>@<host>:<porta>/<banco>'

# Roteiro completo, sem tocar em nada:
tsx scripts/drill-migration-705.ts --fase=roteiro --alvo=staging --dsn-env=DRILL_705_DSN
```

Códigos de saída que aparecem neste gabarito:

| código | significado |
|---:|---|
| 0 | a fase concluiu e produziu a evidência esperada |
| 1 | falha inesperada |
| 2 | contrato de uso (alvo/dsn-env ausente, nome ambiental, sem `--executar`) |
| 3 | o rótulo `--alvo` não bate com o host do DSN resolvido |
| 4 | a fixture do drill vazou para `migrations/` — **pare e limpe** |
| 20 | **a migration quebrada não falhou: o gate não existe.** É um achado |

- [ ] Confirmei que `--alvo=staging` e o DSN apontam para **staging**, não para produção
- [ ] Tenho backup / snapshot recente do banco de staging, ou aceito perdê-lo
- [ ] Avisei quem usa staging que ele ficará indisponível durante a janela

Anotação livre antes de começar (o que você espera que aconteça):

```
```

---

## Passo 1 — Contexto (evidências 1 e 5)

```bash
tsx scripts/drill-migration-705.ts --fase=contexto \
  --alvo=staging --dsn-env=DRILL_705_DSN \
  --imagem=<tag-ou-sha> --saida=<dir>
```

**Capturar:** a linha `contexto · expected_head=… applied_head=… readiness=…` e
o arquivo `e1-e5-contexto.json`.

Cole a saída:

```
```

| Campo | Valor |
|---|---|
| `expected_head` | |
| `applied_head` | |
| `readiness` antes de tudo | |
| Código de saída | |

**O que falhou / divergiu do esperado:**

```
```

**O que NÃO foi possível capturar, e por quê:**

```
```

---

## Passo 2 — A migration que FALHA (evidência 2 — o coração do drill)

> Esta fase **escreve**. Ela exige `--executar` e, em staging, `--janela`.
> Ela monta um diretório efêmero em `os.tmpdir()` com cópias dos `.sql` reais
> mais a migration deliberadamente quebrada, e aponta o runner para ele.
> `migrations/` é apenas lido — a fixture nunca entra lá.

```bash
tsx scripts/drill-migration-705.ts --fase=quebrar \
  --alvo=staging --dsn-env=DRILL_705_DSN --executar \
  --janela="<data · HH:MM BRT · condutor>" --saida=<dir>
```

**Esperado:** exit 0, com `runner_outcome=failed`, `ficou_dirty=true` e as duas
leituras de readiness **bloqueadas**. **Exit 20 é o achado que o drill existe
para produzir: o gate não existe.**

Cole os eventos JSON do runner (`migration.started` / `migration.dirty`):

```
```

| Campo | Valor |
|---|---|
| `runner_outcome` | |
| `falha_ledger_status` (esperado: `dirty`) | |
| `falha_classe` (SQLSTATE) | |
| `readiness_apos_falha_estado` (imagem desta build) | |
| blocker(s) dessa leitura | |
| `readiness_como_imagem_quebrada_estado` | |
| blocker(s) dessa leitura | |
| Código de saída | |

### O lado da APLICAÇÃO (o que o script não consegue provar sozinho)

Este passo prova o lado do banco. O item 2 pede também que a **aplicação nova
não receba tráfego**. Registre aqui o que você observou no orquestrador:

| Pergunta | Resposta |
|---|---|
| O passo/recurso de migration saiu com código diferente de zero? Qual? | |
| O rollout da aplicação foi **abortado** pelo painel, ou ele subiu assim mesmo? | |
| Se subiu: ela entrou em crash-loop, ou ficou de pé respondendo? | |
| Qual exit code o processo do app usou (faixa 90–98 nomeia a invariante)? | |
| A versão ANTERIOR continuou de pé e servindo durante tudo isso? | |

**O que falhou:**

```
```

**O que NÃO foi possível capturar, e por quê:**

```
```

---

## Passo 3 — Readiness vermelha, e por quanto tempo (evidências 2 e 3)

```bash
tsx scripts/drill-migration-705.ts --fase=verificar \
  --alvo=staging --dsn-env=DRILL_705_DSN \
  --readyz=https://<staging>/readyz --amostras=<n> --saida=<dir>
```

> Sem `--readyz` esta fase registra **apenas** o veredito de schema lido do
> banco, e o script avisa isso. O item 2 pede o `/readyz` do app **novo** —
> passe a URL, ou anote abaixo por que não foi possível.

| Campo | Valor |
|---|---|
| URL de `/readyz` usada | |
| Primeira amostra não-200 (horário BRT) | |
| Última amostra não-200 (horário BRT) | |
| **Tempo total vermelho** | |
| HTTP status observado | |
| `readiness_estado` no banco | |

Cole algumas amostras:

```
```

**O que falhou:**

```
```

**O que NÃO foi possível capturar, e por quê:**

```
```

---

## Passo 4 — Recuperação (evidência 3)

> **Cronometre.** "Quanto tempo levou" é parte da evidência, não um detalhe.
> Marque o relógio quando começar a diagnosticar, não quando rodar o comando.

Diagnóstico, antes de reparar (o runbook manda inspecionar o schema à mão):

```bash
tsx scripts/migrate.ts status
```

```sql
-- o efeito parcial que a migration quebrada deixa:
SELECT * FROM drill_705_marcador;
-- índices inválidos (nada esperado aqui, mas confira):
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid;
```

```bash
tsx scripts/drill-migration-705.ts --fase=reparar \
  --alvo=staging --dsn-env=DRILL_705_DSN --executar \
  --janela="<data · HH:MM BRT · condutor>" \
  --desfazer-efeito --motivo="<o que voce conferiu no schema>" --saida=<dir>
```

`--motivo` é obrigatório e vai **persistido na linha do ledger**. Escreva o que
você conferiu, não "reparando".

| Campo | Valor |
|---|---|
| Horário BRT em que a falha foi notada | |
| Horário BRT em que o schema voltou a `ready` | |
| **Duração total da recuperação** | |
| `duracao_ms` reportado pelo comando | |
| `motivo_do_repair` registrado | |
| `readiness_apos_reparo_estado` (esperado: `ready`) | |
| Código de saída | |

Cole a saída:

```
```

**O que falhou:**

```
```

**O que NÃO foi possível capturar, e por quê:**

```
```

---

## Passo 5 — Rollback do deploy (evidência 4)

> Nada neste repositório executa `_down.sql` automaticamente, e nada aqui vai
> começar. Este passo é **manual, no orquestrador**: reverter o *deploy*, não o
> schema.

| Pergunta | Resposta |
|---|---|
| Como o deploy foi revertido (painel / tag / comando)? | |
| Algum `_down.sql` foi executado? (esperado: **não**) | |
| A aplicação ANTERIOR subiu sobre o schema resultante? | |
| Ela ficou `ready`? Em quanto tempo? | |

Ledger v2 continua legível depois do rollback — rode e cole:

```bash
tsx scripts/drill-migration-705.ts --fase=contexto \
  --alvo=staging --dsn-env=DRILL_705_DSN --saida=<dir>
```

```
```

**O que falhou:**

```
```

**O que NÃO foi possível capturar, e por quê:**

```
```

---

## Passo 6 — Sanitização (evidência 6)

> **Rode isto ANTES de colar qualquer log na issue.** O filtro é o mesmo
> `tests/reliability/harness/sanitize.ts` da #510, importado sem alteração. Ele
> tem uma allowlist EXATA — se algum log seu só passa depois de afrouxá-la, a
> resposta certa é não colar o log, não afrouxar a allowlist.

```bash
tsx scripts/drill-migration-705.ts --fase=sanitizar \
  --alvo=staging --dsn-env=DRILL_705_DSN \
  --log=<arquivo-de-log-bruto> --saida=<dir>
```

| Campo | Valor |
|---|---|
| `houve_redacao` | |
| `filtro_idempotente` (esperado: `true`) | |
| Arquivo sanitizado gerado | |

**Confira você mesmo, no arquivo sanitizado, que NÃO aparecem:**

- [ ] connection string com credencial
- [ ] senha, token ou chave de API
- [ ] SQL com dado de tenant
- [ ] telefone / JID / conteúdo de mensagem

> **Limite conhecido do filtro:** ele redige a *credencial* de uma connection
> string, mas mantém host, porta e nome do banco
> (`postgres://[REDACTED]@host:5432/maia`). Se o hostname de staging for
> sensível para você, edite à mão antes de colar — o filtro não fará isso.

**O que falhou:**

```
```

---

## Passo 7 — Resultado (evidência 7)

Não há comando. Preencha o
[checklist de aceite](drill-705-checklist-de-aceite.md) e registre lá a decisão.

**Resumo do condutor, em prosa (o que aconteceu, o que surpreendeu):**

```
```

**Pendências que este drill deixou abertas:**

```
```

---

## Se algo sair do roteiro

| Situação | O que fazer |
|---|---|
| exit **4** (fixture vazou para `migrations/`) | **Pare.** Remova os arquivos, rode `npm test -- tests/unit/ops/drill-705-fixture-isolada.spec.ts`, e só então recomece. |
| exit **20** (a migration quebrada não falhou) | **Pare.** É o achado mais importante que este drill pode produzir. Registre tudo, não repare, não "tente de novo com outra migration". |
| exit **3** (alvo incoerente) | Você declarou um rótulo que não bate com o host. Não force — confira qual dos dois está errado. |
| A janela acabou no meio | Registre exatamente onde parou. Um drill parado no passo 4 com o ledger `dirty` deixa staging **fora do ar** — decida conscientemente se repara agora ou deixa marcado. |
| O ledger ficou `dirty` e o `repair` recusa | `docs/runbooks/migrations.md` § *Recovering a dirty migration* e § *When `repair --as applied` refuses`*. |

---

## O que este gabarito NÃO cobre

Escrito aqui em vez de omitido, na mesma disciplina de
[`deploy-prod.md` §7.0](deploy-prod.md#70-o-que-foi-executado-e-o-que-não-foi):

| Afirmação | Status na preparação |
|---|---|
| O script recusa rodar sem alvo declarado, em qualquer ambiente | **EXECUTADO** — `tests/unit/ops/drill-705-alvo-declarado.spec.ts` |
| A fixture quebrada não está no artefato real e o overlay não escreve em `migrations/` | **EXECUTADO** — `tests/unit/ops/drill-705-fixture-isolada.spec.ts` |
| A migration quebrada deixa o ledger `dirty` e a readiness bloqueada | **EXECUTADO contra Postgres local descartável**, não contra staging |
| O `repair --as pending` devolve a readiness a `ready` | **EXECUTADO contra Postgres local descartável**, não contra staging |
| O filtro de sanitização redige credencial de connection string e é idempotente | **EXECUTADO** com log sintético |
| **O painel do orquestrador aborta o rollout quando o passo de migration falha** | **NÃO VERIFICADO** — depende do painel real. É o passo 2, seção "o lado da APLICAÇÃO" |
| **`/readyz` do app novo fica vermelho e por quanto tempo** | **NÃO VERIFICADO** — exige uma instância de pé. É o passo 3 |
| **A aplicação anterior sobe sobre o schema resultante depois do rollback** | **NÃO VERIFICADO** — exige a janela. É o passo 5 |

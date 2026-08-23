# Contrato de configuração — runbook operacional

O que fazer quando o boot da Maia falha com `Invalid configuration`, e como
destravar um ambiente sem esperar por um deploy de código.

> **TL;DR**: desde a issue [#515](https://github.com/diogenesmendes01/Maia-v2/issues/515)
> o boot **falha fechado em TODOS os profiles** — inclusive `development` —
> para variável desconhecida, variável removida (tombstone) e contradição
> `NODE_ENV` × `MAIA_ENV`. O rollback de emergência é
> **`MAIA_CONFIG_STRICT_BOOT=false`**, que é env-only e não exige redeploy.
> Ele desliga a garantia inteira: use para destravar, não para conviver. Veja §4.

> ### ⚠️ Abortar em `development` é decisão deliberada do owner
>
> **Não "conserte" isto achando que é bug.** O rollout descrito na issue #515
> (passo 6) previa **aviso** em `development` e erro só em staging/produção. O
> owner decidiu explicitamente, durante a review da
> [PR #522](https://github.com/diogenesmendes01/Maia-v2/pull/522), **ligar o
> fail-closed em todos os profiles**, ciente do tradeoff — a review chegou a
> registrar a divergência em relação ao texto da issue, e a decisão foi mantida.
>
> A razão: um `.env` que sobe no laptop e morre em staging é exatamente o drift
> que este contrato existe para eliminar. Consistência total vale mais que a
> conveniência de um boot tolerante em dev.
>
> Se um dia a decisão for revista, o ponto de revert é único e está em §4.3.

---

## 1. Mudança que quebra deploys existentes

**Um ambiente que sobe hoje pode parar de subir no primeiro release que
contiver a #515.** Leia isto antes de deployar.

O boot agora recusa:

| Situação | Regra | Antes | Agora |
|---|---|---|---|
| `FEATURE_MULTI_CHANNEL`, `FEATURE_COGNITIVE_GRAPH`, `APROVAR_MENSAGENS_PROATIVAS` no `.env` | `contract/removed` | ignorado em silêncio | **boot aborta** |
| `FEATURE_CONTEXT_PACKET_V1` (ou seu kill switch) em `true` | `contract/removed` | já abortava | aborta |
| Qualquer `MAIA_*` / `FEATURE_*` / `BACKUP_*` … fora do contrato | `contract/unknown` | ignorado em silêncio | **boot aborta** |
| `MAIA_ENV` ausente em staging/produção | `profile/required` | não existia | **boot aborta** |
| `MAIA_ENV` contradizendo `NODE_ENV` | `profile/node-env-contradiction` | não existia | **boot aborta** |
| Placeholder (`__SET_ME__`, `sk-ant-...`) em staging/produção | `secret/placeholder` | não existia | **boot aborta** |
| Valor de fixture sintética de CI em staging/produção | `secret/synthetic-fixture` | não existia | **boot aborta** |
| Dependência condicional não satisfeita (ex.: `FEATURE_OUTBOUND_VOICE=true` sem `OPENAI_API_KEY`) | `contract/required-when` | não existia | **boot aborta** |

### Checklist antes de deployar

Rode isto **contra o `.env` do ambiente alvo**, antes do deploy — ele reporta
todos os problemas de uma vez e nunca imprime o valor de um segredo:

```bash
npm run config:check -- --profile production --env-file .env
```

Saída `OK` ⇒ o boot vai passar. Qualquer erro ⇒ corrija antes, com a remediação
que o próprio comando imprime. Para automação, `--json`.

> **`covers` (issue #602).** Cada problema traz `variable` — **um** nome. As
> regras cross-field que valem por um PAR de chaves só conseguem arquivar-se sob
> uma delas (`backup/encryption-key` fica sob `BACKUP_ENCRYPTION_KEYRING`, e
> `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` não aparecia em campo nenhum), e as regras de
> boot que preservam o caminho histórico `<root>` do Zod carregam
> `variable: null` nomeando uma variável real (`llm/provider-key` →
> `ANTHROPIC_API_KEY`). Para esses casos o problema agora traz também
> `covers: [...]`, com **todas** as variáveis envolvidas. É **aditivo**: o campo
> é omitido quando o problema é sobre exatamente a variável em `variable`, então
> a forma serializada dos demais não mudou. Quem lista variáveis deve ler
> `covers ?? [variable]` — não procurar nomes dentro da `message`. Vale para o
> `--json` do `config check` e do `config preflight`.

**Ações mais prováveis:**

1. **Adicione `MAIA_ENV`.** Staging e produção passam a exigir o profile
   explícito — `NODE_ENV` nem consegue expressar `staging`.
   ```bash
   MAIA_ENV=production   # ou staging
   ```
2. **Remova as variáveis removidas.** Elas não têm efeito nenhum desde os PRs
   #406/#411/#412; o boot agora diz isso em vez de deixar você acreditar que um
   gate existe. `APROVAR_MENSAGENS_PROATIVAS` nunca teve consumidor — o gate
   real de mensagens proativas é `FEATURE_PROACTIVE_MESSAGES`.
3. **Substitua placeholders.** Qualquer `__SET_ME__…` remanescente.

---

## 2. Ler a mensagem de erro

O boot imprime, para **cada** problema, a variável, a regra e a remediação —
nunca o valor (segredos são redigidos por construção, `src/config/redact.ts`):

```
Invalid configuration: 2 problema(s) no profile development (contrato 1.0.0).

  - FEATURE_MULTI_CHANNEL [contract/removed]: FEATURE_MULTI_CHANNEL foi REMOVIDA (PR #411) e não tem mais efeito. …
      → Remova FEATURE_MULTI_CHANNEL do ambiente. O gate real hoje é …
  - MAIA_TIPO_ERRADO [contract/unknown]: MAIA_TIPO_ERRADO está em um namespace da Maia mas não existe no contrato (versão 1.0.0).
      → Confira se não é erro de digitação. Se a variável é real, declare-a em src/config/contract.ts e rode `npm run config:generate`. Se não, remova-a do ambiente.
```

| Regra | Significa | O que fazer |
|---|---|---|
| `contract/removed` | a variável existiu e foi deletada | remova; migre para a substituta quando houver |
| `contract/unknown` | nome em namespace Maia que o contrato não conhece | quase sempre erro de digitação; senão, declare no contrato |
| `contract/required-when` | dependência condicional não satisfeita | defina a variável, ou desfaça a condição |
| `profile/required` | obrigatória neste profile | defina |
| `profile/node-env-contradiction` | `MAIA_ENV` × `NODE_ENV` incoerentes | `MAIA_ENV` é o profile; `NODE_ENV` só controla otimizações do Node |
| `secret/placeholder` | valor ainda é `__SET_ME__`/`sk-ant-...` | preencha |
| `secret/synthetic-fixture` | valor veio de `src/config/generated/fixtures/` | gere um `.env` de verdade com `npm run config:init` |
| `schema/*` | tipo/formato inválido | corrija conforme `docs/configuration.md` |

**Namespaces de terceiros nunca são recusados.** `CLAUDE_*`, `ANTHROPIC_*`,
`POSTGRES_*`, `REDIS_*`, `SMTP_*`, `NEXTAUTH_*`, `OPENAI_*` ficam de fora da
detecção de desconhecidas: são populados por ferramentas e plataformas de
hosting. As variáveis que a Maia possui nesses namespaces estão no contrato
**pelo nome**. Ver `MAIA_KEY_PREFIXES` em `src/config/metadata.ts`.

---

## 3. Criar um `.env` do zero

```bash
npm run config:init -- --profile production        # escreve .env
npm run config:check -- --profile production --env-file .env
```

O `config:init` gera um **ponto de partida operacional**: tudo que é seu vem
marcado `__SET_ME__` e o `config:check` **falha de propósito** até você
preencher. Ele nunca escreve uma fixture.

> **Fixtures ≠ configuração.** `src/config/generated/fixtures/*.env` existem
> só para o CI provar que o contrato é satisfazível; os valores são previsíveis
> e não autenticam em nada. Copiá-las para `.env` é recusado
> (`secret/synthetic-fixture`) — só o opt-in `--allow-fixtures`, usado para
> validar esses próprios arquivos, as aceita.

---

## 4. Rollback de emergência

### 4.1 Runtime — `MAIA_CONFIG_STRICT_BOOT=false`

Se um ambiente legítimo estiver travado (por exemplo: uma plataforma de hosting
injetou uma variável em namespace Maia que ninguém previu, e você precisa subir
AGORA), a alavanca é **env-only, sem redeploy**:

```bash
MAIA_CONFIG_STRICT_BOOT=false
```

O loader volta a ser exatamente o anterior à #515: **schema Zod + regras de
boot legadas**, com as mensagens históricas preservadas.

**O que ela desliga** (tudo, não só o item que travou você):

- detecção de variável desconhecida (`contract/unknown`);
- detecção de variável removida (`contract/removed`);
- contradição de profile (`profile/node-env-contradiction`);
- obrigatoriedade por profile (`profile/required`);
- dependências condicionais (`contract/required-when`);
- recusa de placeholder e de fixture sintética.

**O que ela NÃO desliga** (continua fatal):

- o schema Zod — `DATABASE_URL` ausente segue abortando o boot;
- as regras de boot legadas — chave do provider LLM/embeddings, canal de alerta
  sem credencial, ordem dos três limites financeiros, segredo HMAC em produção,
  `FEATURE_MCP_TOOLS` em produção, `BAILEYS_AUTH_DIR` inseguro,
  `FEATURE_CONTEXT_PACKET_V1`.

O boot degradado **loga um aviso alto a cada start** — um escape hatch
silencioso é um que ninguém lembra de fechar:

```
[config] MAIA_CONFIG_STRICT_BOOT=false — validação de contrato DESLIGADA …
```

**Procedimento:** ligue a alavanca, suba o ambiente, **abra issue** com a
variável que travou o boot, corrija (remoção do ambiente ou declaração no
contrato) e **remova a alavanca**. Ela não é um estado estável.

### 4.2 Consumidores programáticos — `validate: false`

`loadServiceConfig()` e os loaders nomeados (`loadMigrationConfig`,
`loadAdminConfig`, `loadBackupConfig`) aceitam a mesma alavanca em código:

```ts
loadMigrationConfig({ validate: false });   // schema-only, sem regras de contrato
```

Mesma semântica e mesmo aviso: degrada para parse de schema puro. É o caminho
para o migration runner ([#516](https://github.com/diogenesmendes01/Maia-v2/issues/516))
e o `maia doctor` ([#517](https://github.com/diogenesmendes01/Maia-v2/issues/517))
degradarem sem revert de código.

### 4.3 Reverter o enforcement para o repo inteiro

Se o enforcement se mostrar cedo demais para a frota, o revert de código é
localizado: `src/config/validate.ts` — a severidade de `contract/removed` e
`contract/unknown` está em um único ponto em cada bloco. Voltar para
`severity: isStrictProfile(profile) ? 'error' : 'warning'` restaura o
comportamento "aviso em development" sem tocar em mais nada.

---

## 5. Regra de projeto: heurístico amplo e boot fail-closed não combinam

Vale para qualquer regra nova em `src/config/rules.ts`. Com o boot abortando,
**todo falso positivo de uma regra de rejeição é uma queda de produção** — e a
mensagem ainda diz ao operador que o valor *dele* está errado, o que é falso e
confuso. Antes de a #515 ligar o fail-closed, o mesmo falso positivo teria sido
só um aviso no `config check`.

O caso concreto (rodada 2 da review da PR #522): a detecção de fixture sintética
nasceu como uma regex que casava **qualquer valor contendo a palavra `fixture`**,
aplicada a todas as variáveis. Ou seja, estes três valores perfeitamente
legítimos derrubavam o processo:

```bash
OWNER_NOME=Fixture Labs
BACKUP_S3_BUCKET=maia-fixture-store
NEXTAUTH_URL=https://fixture.example.com
```

A correção foi trocar o heurístico por **igualdade exata, por variável**: as
fixtures são geradas do próprio contrato, então o valor sintético de cada chave
é conhecido — `isSyntheticFixtureValue(name, value)` em
`src/config/contract.ts`. A detecção fica restrita a variáveis marcadas
`secret`, porque é lá que a proteção importa e porque fixture de campo
não-secreto é um valor comum (`POSTGRES_USER=maia`, `TZ=America/Sao_Paulo`).

**Checklist antes de adicionar uma regra que RECUSA um valor:**

1. A condição é **exata** (igualdade, enum, formato fechado) ou é heurística
   sobre texto livre? Heurística sobre texto livre não entra em `error`.
2. Ela olha só as variáveis onde a checagem faz sentido, ou varre `raw` inteiro?
3. Existe um valor real plausível que casa? Escreva o **negativo** como teste —
   `tests/unit/config/init-template.spec.ts` tem o padrão.
4. Se a regra for mesmo necessária mas não puder ser exata, ela é `warning`, não
   `error`.

Um corolário que virou teste: o `fixture` de todo segredo precisa ser
inconfundivelmente sintético (contém `fixture`, ou é o bloco base64 de zeros).
Um fixture que pareça um valor real — `redis://redis.internal:6379`, por
exemplo — vira falso positivo no boot de quem usa exatamente aquele valor.
Ver `tests/unit/config/contract.spec.ts`.

---

## 6. Adicionar, depreciar, remover uma variável

O runbook completo é **gerado** junto com a documentação de configuração:
[`docs/configuration.md`](../configuration.md) (seção "Runbook"). Resumo:

- **adicionar** → entrada em `ENV_CONTRACT` (`src/config/contract.ts`) +
  `npm run config:generate` + commite os artefatos;
- **depreciar** → `deprecatedSince` + `replacement`; vira aviso
  `contract/deprecated`, mantido por ≥ 1 ciclo de release;
- **remover** → tire de `ENV_CONTRACT` **e** adicione um `Tombstone`. Nunca
  renomeie nem reutilize o nome de uma variável removida.

Toda leitura de configuração passa por um loader — `eslint.config.js` recusa
`process.env` novo fora de uma allow-list explícita.

---

## 7. Referências

- Contrato canônico: [`src/config/contract.ts`](../../src/config/contract.ts)
- Documentação gerada: [`docs/configuration.md`](../configuration.md)
- Doc de módulo: [`docs/architecture/modules/config.md`](../architecture/modules/config.md)
- Issue [#515](https://github.com/diogenesmendes01/Maia-v2/issues/515) — contrato único
- PR [#522](https://github.com/diogenesmendes01/Maia-v2/pull/522) — entrega + rodada 1 de review

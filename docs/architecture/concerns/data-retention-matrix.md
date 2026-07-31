# Data retention matrix

> **Status: POLÍTICA PROPOSTA — PENDENTE DE HOMOLOGAÇÃO DO DPO E DO CONTADOR.**
>
> Este documento deixou de ser um DRAFT vazio e passou a carregar uma proposta
> concreta (issue #536, continuação da #520). **Proposta não é aprovação, e nada
> aqui é parecer jurídico.** Cada prazo abaixo é um **default operacional
> configurável, pendente de homologação** — nunca uma afirmação de conformidade.
>
> **A LGPD não estabelece prazos universais de retenção.** Ela exige
> finalidade, necessidade e eliminação ao término do tratamento, salvo as
> exceções específicas que ela mesma lista (arts. 6º e 15–18), com a orientação
> da ANPD. Os **arts. 173–174 do CTN** trazem janelas de cinco anos para
> lançamento e cobrança de tributo, mas **não constituem tabela universal de
> retenção**: o marco inicial depende do documento, e quem o valida é o
> contador.
>
> Issue #520, literalmente: *"prazos, bases legais e exceções precisam de
> aprovação do responsável jurídico/DPO; a implementação não deve codificar
> suposições jurídicas como fatos universais."* Este documento e o código que
> ele espelha existem para respeitar isso, não para contorná-lo.

## O que é mecanismo, o que é política, e o que já está decidido

| | Estado |
|---|---|
| **Mecanismo** (inventário, purge por classe, legal hold, tombstones, dry-run, auditoria) | Implementado e testado — `src/ops/retention/` |
| **Política** (quanto tempo, sob que base, com que exceções) | **Proposta, aguardando homologação do DPO/contador** |
| **Piso do tombstone** | **DECIDIDO** — é decisão técnica, não jurídica, e é enforçada no boot |
| **Ordem de ativação** | **DECIDIDA e executável** — `src/ops/retention/activation.ts` |
| **Herança de prazo de dado derivado** | **DECIDIDA e executável** — `src/ops/retention/derivation.ts` |

O inventário executável continua em
[`src/ops/retention/data-classes.ts`](../../../src/ops/retention/data-classes.ts),
e **continua com `retention_days: null` e `approval_state: 'pending_dpo'` em
toda classe**. Um número ali dentro seria a suposição jurídica que a #520
proíbe. A proposta vive separada, em
[`src/ops/retention/proposed-policy.ts`](../../../src/ops/retention/proposed-policy.ts),
como **configuração** — que é exatamente o que ela é.

O default segue sendo "não apagar". Exclusão é irreversível, então o modo de
falha de uma política não homologada tem que ser guardar dado demais —
recuperável, e visível como métrica de backlog — nunca apagar cedo demais.

## A política proposta, classe a classe

Cada linha traz **a política proposta**, **a base declarada** (declarada, não
estabelecida: nomear uma base é o que o DPO homologa ou rejeita) e **o que
ainda depende de homologação**. A coluna de dias é o que entra em
`RETENTION_POLICY`; onde ela está vazia, a classe não é "apagar após N dias".

### `postgres.messages` — 180 dias

- **Proposta:** 180 dias após a última atividade da conversa. Vinculada a
  disputa ou obrigação legal, entra em legal hold e não expira.
- **Base declarada:** execução do atendimento e prestação de contas ao próprio
  titular; eliminação ao término do tratamento (LGPD art. 15), com as exceções
  do art. 16 quando houver disputa.
- **Pendente de homologação:** o DPO confirma os 180 dias e a base; definir o
  que é "última atividade" (última mensagem da conversa vs. último contato da
  pessoa) — hoje **não existe coluna que a materialize**; confirmar que legal
  hold é o único prolongamento aceito.

### `postgres.messages.audio_transcript` — 30 dias

- **Proposta:** transcrições de áudio vivem menos que o corpo da mensagem que
  as carrega.
- **Base declarada:** necessidade (LGPD art. 6º, III) — a transcrição existe
  para processar o turno, não para constituir histórico.
- **Pendente de homologação:** o DPO confirma o prazo mais curto para voz.
  **Pré-requisito técnico:** não existe coluna nem seletor de transcrição — hoje
  ela vive em `mensagens.conteudo`. Sem esse seletor a classe conta zero e não é
  executável. A classe existe no inventário porque um prazo que não pode ser
  endereçado separadamente é prosa, não política.

### `postgres.conversations` — herda de `postgres.messages`

- **Proposta:** o shell identificável **não sobrevive às mensagens**.
  Estatística só permanece se for efetivamente anônima — sem telefone, JID,
  título, snippet ou identificador correlacionável.
- **Base declarada:** o shell é envelope das mensagens e não tem finalidade
  própria; dado anonimizado sai do escopo da lei (LGPD art. 12), **desde que a
  anonimização seja irreversível**.
- **Pendente de homologação:** o DPO confirma que a estatística proposta é
  efetivamente anônima e não apenas pseudonimizada. **Pré-requisito técnico:** a
  rotina que extrai a estatística anônima antes de apagar o shell não existe.
- **Executável hoje:** o clamp em `derivation.ts` impede que o shell tenha prazo
  maior que o das mensagens, qualquer que seja a política escrita.

### `postgres.people` — 180 dias, anonimização

- **Proposta:** após fim da relação, 180 dias de inatividade ou pedido de
  eliminação deferido: apagar nome, telefone, e-mail, JID, CPF e demais
  identificadores diretos; conservar só ID aleatório e estatística anônima.
  Identificador exigido contabilmente fica **restrito ao registro financeiro
  correspondente**.
- **Base declarada:** eliminação ao término do tratamento (LGPD art. 15) e
  atendimento ao art. 18, VI; a conservação restrita ao registro financeiro é
  exceção do art. 16, I (cumprimento de obrigação legal).
- **Pendente de homologação:** o DPO confirma a lista de identificadores diretos
  a apagar; **o contador confirma QUAL identificador o registro financeiro
  exige, e por quê**. **Pré-requisito técnico:** o executor de anonimização de
  `pessoas` não existe.

### `postgres.memory` — herda o MENOR prazo das fontes

- **Proposta:** herda o **menor** prazo das fontes e **nunca prolonga
  silenciosamente a vida de uma mensagem**.
- **Base declarada:** necessidade (LGPD art. 6º, III) — memória derivada não
  pode ter finalidade mais ampla que o dado do qual deriva.
- **Pendente de homologação:** o DPO confirma a herança como regra, e não caso a
  caso.
- **Executável hoje:** `resolveEffectiveRetention` é o **único** caminho que
  responde "por quanto tempo esta classe pode ser guardada", e ele faz o clamp.
  Uma política que diga memória 365 / mensagens 180 não produz um erro que se
  possa ignorar: produz **180**, e diz qual fonte limitou. Um teste de
  propriedade cobre **toda** combinação de prazos, não só os exemplos.
  A outra direção — memória nunca ser **motivo** para guardar a mensagem — é
  estrutural: o passe de retenção de `postgres.messages` planeja a partir das
  linhas de mensagem e não consulta memória.

### `postgres.memory.pinned` — sem prazo proposto, de propósito

- **Proposta:** memória fixada explicitamente pelo usuário exige **finalidade e
  prazo próprios**. Por isso **não herda** o prazo da fonte, e por isso ainda
  **não tem** período proposto.
- **Base declarada:** a fixar. Um ato explícito do usuário sugere
  consentimento/legítimo interesse próprio, mas a finalidade precisa ser
  declarada antes do prazo.
- **Pendente de homologação:** declarar a finalidade; só então propor o prazo.
  Um número antes da finalidade seria exatamente a suposição que a #520 proíbe.

### `postgres.financial` — piso de 5 anos + exercício corrente (não purgável)

- **Proposta:** piso operacional de **5 anos + exercício corrente**, com
  extensão por disputa ou legal hold. Não purgável a pedido.
- **Base declarada:** obrigação legal/regulatória e exercício regular de
  direitos (LGPD art. 16, I e III). Os **arts. 173–174 do CTN** têm janelas de
  cinco anos, mas **não constituem tabela universal de retenção** — o marco
  inicial depende do documento.
- **Pendente de homologação:** **o contador valida o marco inicial de CADA tipo
  de documento** — é dele a decisão, não do código; o DPO confirma que a exceção
  contábil prevalece sobre um pedido de eliminação, e em que extensão.

### `postgres.audit` — redigir em 180 dias, esqueleto por 5 anos

- **Proposta:** redigir conteúdo livre e identificadores após 180 dias.
  Conservar 5 anos **apenas o esqueleto probatório**: pseudônimo do ator, ação,
  decisão, política, timestamps, hashes e resultado.
- **Base declarada:** exercício regular de direitos e prestação de contas (LGPD
  art. 16, II e III). *"Auditabilidade não justifica conservar conteúdo bruto
  indefinidamente."*
- **Pendente de homologação:** o DPO e o dono de segurança confirmam **quais
  campos** podem ser redigidos sem destruir o valor probatório; confirmar os 5
  anos do esqueleto, que hoje são piso operacional e não prazo legal apurado.
  **Pré-requisito técnico:** o executor de redaction de `audit_logs` não existe.

### `postgres.traces` — 30 dias (primeira classe a ativar)

- **Proposta:** 30 dias para prompts, respostas e bodies de debug. Extensão só
  por legal hold ligado a incidente concreto.
- **Base declarada:** necessidade (LGPD art. 6º, III) — o corpo do trace existe
  para depurar um incidente recente, não para constituir histórico.
- **Pendente de homologação:** o DPO confirma os 30 dias e que legal hold ligado
  a incidente é o único prolongamento.

### `media.blobs` — 7 dias, efêmera, sem backup

- **Proposta:** apagar em até 7 dias após processamento bem-sucedido.
  Comprovante que precise de guarda vai para uma **futura classe documental
  cifrada**, não fica no blob genérico.
- **Base declarada:** necessidade (LGPD art. 6º, III) — o blob existe para ser
  processado; o resultado do processamento é o que tem finalidade duradoura.
- **Pendente de homologação:** o DPO confirma que o descarte da mídia bruta é
  aceitável para o titular. **Pré-requisito técnico:** a classe documental
  cifrada não existe, nem o executor que varre `/app/media`.

### `backup.artifact` — 7 dias local, 30 dias off-site

- **Proposta:** aprovar os valores atuais. Dado eliminado pode persistir no
  backup cifrado por no máximo 30 dias, mas **tombstones devem ser reconciliados
  antes da liberação de tráfego**.
- **Base declarada:** segurança da informação e continuidade (LGPD art. 6º,
  VII); a janela de persistência é limitada e coberta pelo ledger
  anti-ressurreição.
- **Pendente de homologação:** o DPO confirma que 30 dias é a janela máxima
  aceitável de persistência de dado eliminado dentro de um artefato retido.
- **Nota operacional:** a fonte da verdade continua sendo
  `BACKUP_RETENTION_LOCAL_DAYS` / `BACKUP_RETENTION_CLOUD_DAYS`; o número na
  política é o **teto que a política declara**.

### `privacy.export` — 7 dias ou primeiro download

- **Proposta:** expira em 7 dias **ou** no primeiro download confirmado, o que
  ocorrer primeiro. Sempre cifrado, com link revogável.
- **Base declarada:** necessidade e segurança (LGPD art. 6º, III e VII) — o
  pacote é uma cópia integral do titular e cada dia extra é exposição sem
  finalidade.
- **Pendente de homologação:** o DPO confirma os 7 dias e a expiração no
  primeiro download. **Pré-requisito técnico:** a geração do export cifrado
  ainda não existe (#536, critério 2).

### `privacy.tombstone` — mínimo de 60 dias · **DECIDIDO**

- **Decisão técnica, não jurídica:** mínimo de **60 dias** com os backups
  atuais, mantendo a regra automática **`tombstone > maior retenção de
  backup`**. Na v1 continua **não purgável**.
- **Base declarada:** não é retenção de dado pessoal — o ledger guarda
  pseudônimos. É o prazo mínimo para que a proteção anti-ressurreição sobreviva
  a todo artefato que ainda possa conter o dado apagado.
- **Pendente de homologação:** **nada.** Esta é a única linha da matriz que não
  depende do DPO, e é a que protege todas as outras. Ver a seção
  [Piso do tombstone](#piso-do-tombstone--enfor%C3%A7ado-no-boot).

### `gateway.baileys_session` e `queue.redis` — sem pergunta de retenção

- `gateway.baileys_session` é **segredo operacional**, não dado pessoal: ciclo
  de vida é rotação/revogação e a recuperação é re-pareamento. Pendente: o dono
  de segurança aprova re-pareamento vs. backup cifrado.
- `queue.redis` é reconstruível a partir do Postgres; os TTLs pertencem a ops.
  Nada pendente.

## Piso do tombstone — enforçado no boot

Das 11 perguntas em aberto da #520, esta é a **única técnica e não jurídica**.
Dá para respondê-la sem esperar o DPO, e vale respondê-la antes das outras
porque ela protege todas.

Um tombstone é o que impede um restore de ressuscitar dado apagado. Essa
proteção tem prazo de validade: **expirado o tombstone, restaurar um artefato
que ainda contém a linha revive o dado e nada percebe** — o ledger não bloqueia
o que já esqueceu. Logo:

```
RETENTION_TOMBSTONE_MIN_DAYS  >  max(BACKUP_RETENTION_LOCAL_DAYS, BACKUP_RETENTION_CLOUD_DAYS)
```

**Estritamente maior**, não "pelo menos igual": janelas iguais expiram no mesmo
dia, e um artefato restaurado nas horas anteriores à varredura encontraria um
ledger que já esqueceu a exclusão.

| | Valor hoje |
|---|---|
| `BACKUP_RETENTION_LOCAL_DAYS` | 7 |
| `BACKUP_RETENTION_CLOUD_DAYS` | 30 |
| `RETENTION_TOMBSTONE_MIN_DAYS` | **60** — satisfeito com folga |

A regra `retention/tombstone-exceeds-backup` vive em
[`src/config/rules.ts`](../../../src/config/rules.ts) com **escopo `boot`**, ao
lado da família `backup/*`. **Aumentar a retenção remota além do piso trava o
boot até o piso acompanhar** — que é o cenário real: a mudança de uma linha que
reabre a ressurreição em silêncio. O predicado puro está em
[`tombstone-floor.ts`](../../../src/ops/retention/tombstone-floor.ts) e é
exercitado em `tests/unit/config/retention-rules.spec.ts`.

A regra é avaliada **mesmo com `BACKUP_ENABLED=false`**, de propósito: desligar
o job para de produzir artefatos novos, não apaga os já retidos.

## Como uma política vira efetiva

1. O DPO (e, no caso contábil, o contador) responde e **homologa**.
2. A resposta é registrada **aqui**, com base legal e exceções.
3. Vira `RETENTION_POLICY`. **A proposta já está materializada** e é o valor
   comentado no `.env.example`:

   ```json
   {
     "version": "v1-proposta-owner-2026-07",
     "approved_by": "pending_dpo_homologation",
     "approved_at": "2026-07-31T00:00:00.000Z",
     "classes": { "postgres.traces": { "retention_days": 30, "dry_run": true } }
   }
   ```

   Carregar esse valor **começa a contar e não arma nada**: `approved_by` é o
   sentinela `pending_dpo_homologation`, então `parseRetentionPolicy` devolve
   `homologated: false`, e `resolveActivation` recusa armar qualquer classe.
   Homologar é trocar o `approved_by` pelo responsável real.
4. O executor roda em dry-run (`RETENTION_DRY_RUN=true`, o default) e as
   contagens são comparadas com a expectativa.
5. Só então o dry-run é desligado, **por classe** (`"dry_run": false` na
   política) — e ainda assim só depois de **dois ciclos** observados.

`parseRetentionPolicy` recusa tornar purgável uma classe estruturalmente
não-purgável, mesmo que a política peça: `privacy.tombstone`,
`postgres.financial` e `gateway.baileys_session` não são purgáveis por política.

## Ordem de ativação — executável, não só escrita

[`src/ops/retention/activation.ts`](../../../src/ops/retention/activation.ts)
resolve, por classe, se ela pode parar de contar e começar a apagar. **Cinco
condições, todas necessárias**, e falha fechada em cada ramo:

| # | Condição | Onde |
|---|---|---|
| 1 | `RETENTION_DRY_RUN=false` | ambiente |
| 2 | Política **homologada** (não o sentinela) | `RETENTION_POLICY.approved_by` |
| 3 | Classe armada **por escrito** | `classes.<id>.dry_run === false` |
| 4 | Onda alcançada | classes de ondas anteriores já observadas |
| 5 | **≥ 2 ciclos** de dry-run concluídos, na mesma versão da política | `retention_runs` |

**Ondas:**

| Onda | Classes | Por quê |
|---|---|---|
| 1 | `postgres.traces`, `privacy.export`, `backup.artifact` | exaustão de debug, uma cópia que o titular já tem, e um artefato redundante — errar aqui é recuperável |
| 2 | `media.blobs`, `postgres.messages.audio_transcript` | anexos efêmeros, depois que a onda 1 mostrou que o executor apaga o que planejou e nada além |
| 3 | `postgres.messages`, `postgres.conversations`, `postgres.memory`, `postgres.memory.pinned`, `postgres.people`, `postgres.audit` | conteúdo de conversa, identidade e trilha de auditoria — irreversível, e por último de propósito |

**Dois ciclos e não um:** um ciclo prova que a query roda; dois provam que a
contagem é **estável**. O job de retenção é semanal, então dois ciclos são uma
quinzena de evidência. A contagem é por **versão** da política: editar a
política reinicia a observação, porque as contagens comparadas eram de outra
política.

> **Mudança operacional (breaking).** `RETENTION_DRY_RUN=false` deixou de ser
> **suficiente** para armar `backup.artifact`: agora é **necessário**. Um
> ambiente que dependia só do lever passa a contar em vez de apagar, e registra
> `retention.activation_withheld` com o código do motivo — para não parecer que
> a configuração foi ignorada.

## O inventário

`Scope` é a fronteira de isolamento. `Backup` é o que um `pg_dump` de fato
captura — as classes marcadas *excluída* NÃO estão no artefato, o que é decisão
documentada, não omissão (issue §14).

| Classe | Dono | Sensibilidade | Escopo | Purge | Backup | Hold | Proposta |
|---|---|---|---|---|---|---|---|
| `postgres.messages` | platform_ops | pessoal sensível | tenant+agent | delete | no dump | sim | 180d |
| `postgres.messages.audio_transcript` | platform_ops | pessoal sensível | tenant+agent | delete | no dump | sim | 30d |
| `postgres.conversations` | platform_ops | pessoal | tenant+agent | delete | no dump | sim | herda |
| `postgres.people` | platform_ops | pessoal | tenant+agent | anonymize | no dump | sim | 180d |
| `postgres.memory` | platform_ops | pessoal sensível | tenant+agent | delete | no dump | sim | herda |
| `postgres.memory.pinned` | platform_ops | pessoal sensível | tenant+agent | delete | no dump | sim | **indefinido** |
| `postgres.financial` | finance | pessoal | tenant+agent | **não purgável** | no dump | sim | piso 5 anos |
| `postgres.audit` | security | interno | tenant+agent | redact | no dump | sim | 180d + 5 anos |
| `postgres.traces` | platform_ops | pessoal sensível | tenant+agent | delete | no dump | não | 30d |
| `media.blobs` | platform_ops | pessoal sensível | tenant+agent | delete | **excluída (volume)** | sim | 7d |
| `gateway.baileys_session` | platform_ops | segredo | tenant | **não purgável** | **excluída (segredo)** | não | n/a |
| `queue.redis` | platform_ops | interno | system | delete | **excluída (reconstruível)** | não | n/a |
| `backup.artifact` | platform_ops | pessoal sensível | system | delete | no dump | sim | 30d |
| `privacy.export` | security | pessoal sensível | tenant+agent | delete | **excluída (volume)** | não | 7d |
| `privacy.tombstone` | security | interno | tenant+agent | **não purgável** | no dump | não | piso 60d |

### Dado fora do PostgreSQL (issue §14)

- **`media.blobs`** — `docker-compose.yml` monta `/app/media` como volume
  separado; `pg_dump` não o enxerga. A proposta **resolve a decisão em aberto**:
  mídia é efêmera, não durável — 7 dias após processamento, sem backup próprio.
  Um restore reconstitui o banco **sem** os anexos, o que passa a ser
  consequência declarada da política, e não uma lacuna.
- **`gateway.baileys_session`** — credenciais de sessão do WhatsApp. Tratadas
  como segredo operacional: nunca dentro de um dump, nunca num log. O caminho de
  recuperação hoje é **re-pareamento**, documentado em
  [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).
- **`queue.redis`** — jobs BullMQ, DLQ, caches, chaves de idempotência.
  Classificado como reconstruível: a fonte da verdade durável é o Postgres
  (outbox / ledger de idempotência). É deliberado — restaurar um Redis velho ao
  lado de um snapshot antigo do banco redisparia efeitos que já aconteceram.

## Legal hold

Um hold congela uma classe (ou `*`), opcionalmente restrito a um titular
pseudonimizado, para uma referência de caso, com motivo codificado (nunca texto
livre — um motivo sensível não pode chegar a um log). Enquanto ativo, bloqueia o
purge aplicável.

Duas escolhas deliberadas em [`legal-hold.ts`](../../../src/ops/retention/legal-hold.ts):

- Um **hold por titular bloqueia um purge de classe inteira**, porque esse purge
  levaria o titular congelado junto. Conservador de propósito.
- **Liberar um hold não apaga nada.** A política de retenção precisa ser
  reavaliada depois.

## Tombstones e não-ressurreição

Um backup tirado antes de uma exclusão ainda contém o registro excluído.
Restaurá-lo ressuscitaria dado que um titular pediu para apagar.

Toda exclusão escreve um tombstone assinado. Restaurar um snapshot exige
reaplicar todo tombstone mais novo que o `tombstone_watermark` do artefato
**antes** da liberação de tráfego; se o ledger estiver ilegível, se o watermark
for desconhecido, ou se qualquer linha falhar na verificação, o restore é
bloqueado. Ver [`docs/runbooks/backup-restore.md`](../../runbooks/backup-restore.md).

O ledger guarda **pseudônimos** (HMAC com chave), nunca identificadores brutos —
um tombstone guardando o telefone que ele diz ter apagado seria uma cópia do
próprio dado que excluiu. Ele reconhece um titular que lhe é apresentado; não
consegue enumerar titulares.

E, pelo piso acima, ele **sobrevive a todo artefato que ainda possa conter o
dado** — a metade da proteção que faltava.

## Revisão

| | |
|---|---|
| Última atualização | 2026-07-31 (issue #536, continuação da #520) |
| Homologado pelo DPO | **Não — proposta em homologação** |
| Homologado pelo contador | **Não — `postgres.financial` e `postgres.people` dependem dele** |
| Decidido sem depender do jurídico | Piso do tombstone, ordem de ativação, herança de prazo derivado |
| Rever quando | Uma classe for adicionada, um prazo for homologado, ou a classe documental cifrada de `media.blobs` nascer |

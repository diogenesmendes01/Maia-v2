# Runbook — recuperação, reconciliação e DLQ do outbox de saída

> Issue #633 (fatia D da épica #506). Companheiro de
> [`turn-state-machine.md`](turn-state-machine.md): aquele cobre o TURNO, este
> cobre a RESPOSTA depois de o turno ter terminado.

## 0. A regra que este runbook existe para proteger

**Nunca reenvie uma mensagem sobre a qual você não sabe se chegou.**

Reenvio automático só é seguro quando (a) a SEMÂNTICA do desfecho exclui entrega
anterior, ou (b) o PROVEDOR honra a chave idempotente para aquele tipo de
payload. O WhatsApp, via Baileys, honra `messageId` em **`sendText` e em mais
nada** — áudio, documento, reação e enquete geram id novo a cada chamada, e um
reenvio vira uma SEGUNDA mensagem no telefone da pessoa.

Fora desses dois casos: reconcilie, espere ou escale. Nunca reenvie às cegas.
Isso vale para o worker e vale para você às 3h da manhã.

## 1. Os estados, e o que cada um significa

| Estado | O que aconteceu | Quem age |
|---|---|---|
| `pending` | A resposta foi commitada (#631) e ninguém a reivindicou ainda | worker de entrega |
| `retryable` | Uma tentativa falhou de forma TRANSITÓRIA. Nada saiu | worker, após `next_attempt_at` |
| `claimed` | Alguém tem a posse; o adaptador ainda não foi tocado | o dono, ou o takeover se a lease vencer |
| `sending` | A chamada ao provedor foi INICIADA. O desfecho é desconhecido | **nunca reenviar** — takeover vira `delivery_unknown` |
| `delivered` | O provedor devolveu identificador. A mensagem CHEGOU | falta só o histórico — a reconciliação o PROJETA do artefato (#635) |
| `completed` | Chegou E o histórico da conversa registrou | ninguém |
| `delivery_unknown` | Pode ter chegado. Ninguém confirmou | reconciliação |
| `reconciling` | Incerta e triada: o provedor NÃO deduplica este tipo | **um humano** |
| `failed_terminal` | O provedor recusou DEFINITIVAMENTE | ninguém — rearmar é pedir a mesma recusa |
| `cancelled` | **Saída SEM ENVIO.** Abortada antes do canal, ou superada por outra saída do mesmo turno. Nada saiu e nada sairá | ninguém — é terminal para o ciclo de entrega |
| `dead_letter` | **Nós** desistimos: teto de tentativas ou prazo de reconciliação | um humano, com confirmação de risco |

`cancelled` é **terminal para a entrega** apesar de a semântica do desfecho
(`cancelled_before_send`) admitir reenvio: o estado não está em
`DELIVERY_CLAIMABLE_STATUSES` nem em `DELIVERY_TAKEOVER_STATUSES`, então o
worker não o alcança e a varredura não o seleciona. Quem quiser reenviar uma
saída cancelada usa o rearmamento MANUAL.

A distinção que mais importa na madrugada é `failed_terminal` × `dead_letter`.
São estados diferentes porque a ação é oposta: de `failed_terminal` não se
rearma; de `dead_letter` rearmar é legítimo, porque a causa (rede, sessão do
WhatsApp caída) pode ter passado.

## 2. VERIFICAÇÃO PÓS-DEPLOY — rode isto antes de ligar qualquer flag

Uma linha e não é opcional:

```sql
-- Quantas respostas do outbox DURÁVEL foram perdidas pelo sweeper legado?
SELECT count(*) FROM outbound_messages
 WHERE turn_id IS NOT NULL AND status = 'unknown';
```

**O esperado é `0`.** Qualquer número acima disso é uma resposta que foi
commitada, nunca entregue, e marcada com um estado que o claim de entrega trata
como terminal — perda SILENCIOSA, sem exceção e sem métrica.

A causa: `outbound_messages_sweeper` (#292) promovia a `unknown` toda row
`pending` mais velha que `OUTBOUND_SWEEPER_STALE_PENDING_SEC` (300s). Depois da
#630 a mesma tabela passou a hospedar o outbox durável, cuja row **nasce** em
`pending`. A #633 fechou isso (`turn_id IS NULL` nas três consultas daquele
worker, protegido por
`tests/integration/outbound-legacy-sweeper-ignora-outbox-duravel-real-db.spec.ts`),
mas **quem rodou #630/#631 por mais de cinco minutos com o sweeper ligado já tem
o estrago no banco.**

Se o número for > 0, inventarie antes de agir:

```sql
SELECT id, payload_type, attempt, delivery_outcome, error, created_at
  FROM outbound_messages
 WHERE turn_id IS NOT NULL AND status = 'unknown'
 ORDER BY created_at;
```

`error = 'sweeper_promoted_stale_pending'` identifica as promovidas pelo
sweeper. Elas **nunca foram enviadas** (`delivery_outcome IS NULL`, `attempt =
0`): a promoção acontecia antes de qualquer claim. Ou seja, reenviá-las NÃO tem
risco de duplicata — é o caso raro em que o rearmamento é seguro. O caminho é
devolvê-las a `retryable` (uma a uma, com `--reason` na trilha) pelo comando da
§6, depois de confirmar `attempt = 0` e `delivery_outcome IS NULL` em cada uma.

Com `delivery_outcome` preenchido, a linha JÁ passou pelo provedor e a decisão
volta a ser a da §5.3 — leia o risco antes.

A retenção do sweeper legado também deixou de apagar a linha durável, então este
inventário continua encontrando o estrago mesmo passados 30 dias. Isso é
deliberado: apagar o rastro forense seria a segunda perda.

## 3. As duas flags, e a ORDEM de ligá-las

| Flag | Default | O que liga |
|---|---|---|
| `FEATURE_OUTBOUND_DELIVERY_WORKER` | `false` | O CONSUMIDOR da fila BullMQ `outbound-delivery` |
| `FEATURE_OUTBOUND_RECOVERY` | `false` | A VARREDURA (`outbound_recovery`, 1 min) que enfileira, reconcilia e manda para a DLQ |

**O consumidor precede o produtor, sempre.** Ligue
`FEATURE_OUTBOUND_DELIVERY_WORKER`, confirme que a fila drena, e só então ligue
`FEATURE_OUTBOUND_RECOVERY`. A ordem inversa acumula jobs no Redis que ninguém
consome — e o contrato de config a RECUSA
(`outbound-recovery/requires-delivery-worker`, severidade `error`).

As duas exigem `FEATURE_OUTBOUND_DURABLE_COMMIT` ligada (sem #631 não existe
linha durável a entregar) e as migrations **121** e **131** aplicadas.

Desligar as duas NÃO restaura fail-open: o caminho síncrono de #631/#632
continua entregando com posse e fence. O que se perde é a RECUPERAÇÃO
automática — uma linha que falhe fica parada até rearmamento manual.

## 4. Os números que o alarme lê

| Série | Rótulos | O que um pico significa |
|---|---|---|
| `maia_outbound_pending_age_seconds` | `tenant_id`, `agent_id` | **A série do alarme.** Idade da resposta não entregue mais antiga. Crescente = algo parou |
| `maia_outbound_reconciliation_total` | `result` | `escalate_manual` crescendo = fila HUMANA acumulando; `await_grace` alto e constante = carência longa demais; **`history_fabricated` ≠ 0 = o delivery worker está MORRENDO na janela `delivered -> completed`** |
| `maia_outbound_dead_letter_total` | `reason` | `attempt_limit` = falha persistente de entrega; `reconciliation_timeout` = incerteza que ninguém resolveu em 24h |
| `maia_outbound_turn_inconsistency_total` | `kind` | **Qualquer valor ≠ 0 é bug**, não ruído esperado |
| `maia_outbound_delivery_unknown_total` | `channel` | (#632) A fila de entrada da reconciliação |
| `maia_outbound_lease_lost_total` | `reason` | (#632) `lease_expired` alto = leases curtas para a latência real do provedor |
| `maia_outbound_rearm_total` | `origin` | `recovery` × `replay` — quanto vem da varredura e quanto de operador |
| `maia_outbound_direct_send_violation_total` | `kind` (a primitiva) | (#634) **Zero absoluto.** Qualquer ponto é um caminho de produção falando com o canal fora do outbox e fora do inventário — o critério de ABORTAR "qualquer envio sem ledger" da issue-mãe. Alerta é `> 0`, não um limiar |

`maia_outbound_pending_age_seconds` é medida uma vez por tick e publicada por um
provider que lê o último valor. Ela é, no pior caso, um minuto velha — para uma
série cujo alerta dispara em minutos, isso é irrelevante; o que se ganha é não
transformar a frequência de scrape em carga de Postgres.

## 5. Diagnóstico por sintoma

### 5.1 `pending` acumulando

```sql
SELECT status, count(*), min(created_at)
  FROM outbound_messages
 WHERE turn_id IS NOT NULL AND status = 'pending'
 GROUP BY 1;
```

Causas, em ordem de probabilidade:

1. **`FEATURE_OUTBOUND_RECOVERY` desligada** e nada mais enfileira. É o estado
   de default hoje — confirme a flag antes de investigar qualquer outra coisa.
2. **Consumidor fora do ar.** `FEATURE_OUTBOUND_DELIVERY_WORKER` off, ou o
   processo com papel `worker` não subiu. A fila `outbound-delivery` cresce.
3. **Redis sem headroom.** `enqueueOutboundDelivery` falha, a varredura loga
   `outbound_recovery.rearm_failed` e tenta de novo no tick seguinte. A ROW
   nunca é perdida.

### 5.2 `sending` antigo

```sql
SELECT id, attempt, claimed_by, lease_expires_at, created_at
  FROM outbound_messages
 WHERE status = 'sending' AND lease_expires_at < now()
 ORDER BY created_at;
```

Um `sending` com lease vencida significa: **a chamada ao provedor foi iniciada e
o desfecho nunca foi registrado.** A mensagem pode estar no telefone da pessoa.

Não faça nada à mão. A varredura reivindica a linha (o takeover a MANTÉM em
`sending`, e `markSending` exige `claimed`, então nem o código consegue
reenviá-la) e a move para `delivery_unknown`. A partir daí é a §5.3.

Se `sending` antigo for FREQUENTE, o problema é lease curta demais para a
latência real do provedor: olhe `maia_outbound_lease_lost_total{reason="lease_expired"}`
antes de mexer em qualquer outra coisa. O heartbeat renova a lease a cada terço
do TTL enquanto a chamada está em voo; um pico aqui com o heartbeat ligado quer
dizer que o banco ficou indisponível durante a chamada.

### 5.3 `delivery_unknown` / `reconciling` acumulando

```sql
SELECT payload_type, delivery_outcome, status, count(*), min(created_at)
  FROM outbound_messages
 WHERE status IN ('delivery_unknown','reconciling')
 GROUP BY 1,2,3 ORDER BY 5;
```

O que a varredura já fez, sozinha, antes de você chegar:

- **`text` / `status_fallback`** → devolvidos a `retryable` e rearmados. O
  reenvio carrega a MESMA `provider_idempotency_key`, então o cliente da pessoa
  colapsa os dois envios em `(remoteJid, fromMe, id)`. Isso não é reenvio cego:
  é reenvio autorizado por propriedade do provedor.
- **`audio` / `document` / `reaction` / `interactive_poll`** → movidos para
  `reconciling` e **parados ali**, esperando você. Reenviar duplicaria.

A decisão que sobra para o humano é uma só, e não tem resposta automática:
**vale mais o risco de o usuário receber a mensagem duas vezes, ou o risco de
ele não receber nenhuma?** Ela depende do conteúdo (uma confirmação de boleto
duplicada não é igual a uma saudação duplicada) e é por isso que o sistema não a
toma.

Antes de decidir, olhe a linha:

```bash
npm run dlq outbound-show <outbound_id>
```

Ele imprime estado, tipo, tentativas, desfecho e — a linha que importa — se há
**RISCO** de duplicata e por quê.

### 5.4 `delivered` sem histórico — FECHADA pela #635

É a janela declarada pela #632: um crash entre `delivered` e `completed`. A
mensagem CHEGOU; o que falta é o registro na conversa.

A varredura, depois de um minuto de carência, faz uma pergunta e tem três
respostas:

- **o histórico existe** (o caminho síncrono o gravou por conta própria) —
  conclui a linha para `completed` sem inserir nada;
  `maia_outbound_reconciliation_total{result="history_recovered"}`;
- **o histórico não existe** — PROJETA o histórico do artefato e o insere junto
  com a conclusão, na mesma transação;
  `maia_outbound_reconciliation_total{result="history_fabricated"}` e o log
  `outbound_recovery.history_fabricated_from_artifact`. **Nada é reenviado ao
  provedor**;
- **o `payload_json` não satisfaz mais a união de #630** (schema evoluído, row
  adulterada) — `escalate_manual` + `ops_alert`
  (`outbound_recovery.history_unrecoverable_invalid_payload`). A linha fica em
  `delivered`. É o único caso em que ainda há trabalho humano aqui, e o §5.4.1
  diz o que fazer.

**Projetar não é re-renderizar, e a diferença é a razão de a #633 ter recusado
fazer isto.** `buildHistoricoFromArtifact`
(`src/runtime/outbound/historico.ts`) é uma função pura, total e sem
dependências externas — sem LLM, sem template, sem locale, sem relógio — sobre
o `payload_json`, que é IMUTÁVEL desde o commit de #631 e coberto por
`payload_hash`. Existe **uma** definição, importada pelo ciclo de entrega e pela
reconciliação. Duplicá-la — que era o risco que a #633 nomeou — é o que
permitiria a divergência; compartilhá-la a torna inexprimível.

Só o `remote_jid` não vem do artefato (o outbox não persiste destinatário, por
política de PII de #630): ele é lido do INGRESSO, nunca derivado do telefone.

A trilha distingue as duas origens: a auditoria `outbound_delivery_completed`
carrega `recovered_by: "reconciliation"` e `history_fabricated: true`.

**O que investigar quando `history_fabricated` ≠ 0**: não é o histórico — ele foi
recuperado. É *por que o processo morreu ali*. Comece pelos reinícios do worker
de entrega na mesma janela de tempo.

#### 5.4.1 `history_unrecoverable_invalid_payload` — o fail-closed

**Não conserte isto fabricando o histórico.** A recusa é deliberada e é a única
propriedade desta fatia que protege o USUÁRIO em vez do estado: um
`payload_json` que não passa pela união de #630 significa artefato corrompido,
ou escrito por uma versão que este processo não sabe ler. Projetar dali gravaria
na conversa um texto que **ninguém enviou** — indistinguível de mensagem real,
com `recovered_by: "reconciliation"` como única pista de que foi inventado.

Achar as linhas afetadas:

```sql
SELECT id, payload_type, payload_version, payload_json, provider_message_id, created_at
  FROM outbound_messages
 WHERE tenant_id = :t AND agent_id = :a
   AND status = 'delivered'
   AND turn_id IS NOT NULL
 ORDER BY created_at;
```

Triagem, nesta ordem:

1. **`payload_version` maior do que a que este binário conhece?** É deploy
   misto: uma réplica nova commitou, uma antiga está reconciliando. Não é
   corrupção — atualize a réplica antiga e a linha se resolve sozinha no tick
   seguinte.
2. **`payload_type` da coluna diverge do `payload_json->>'type'`?** A row foi
   escrita fora do caminho de produção (migração manual, replay artesanal).
   Trate como corrupção.
3. **Corrupção confirmada:** a mensagem CHEGOU (só `accepted_confirmed` produz
   `delivered`), então **não reenvie**. O histórico daquela resposta está
   perdido, e a decisão é humana: ou se reconstrói a row de `mensagens` à mão a
   partir de uma fonte externa confiável (o telefone do usuário, um export do
   WhatsApp), ou se aceita a lacuna e a linha é fechada manualmente. Não há
   comando para isso, de propósito: um comando que "conserta" isto sozinho é a
   fabricação que esta seção proíbe.

A linha fica em `delivered`, portanto continua contando em
`maia_outbound_pending_age_seconds` e continua visível a cada tick. Isso é
intencional — sair do radar seria pior que envelhecer nele.

### 5.5 Divergência turno ↔ outbound

`maia_outbound_turn_inconsistency_total{kind}` ≠ 0. Os dois sentidos têm causas
OPOSTAS:

```sql
-- kind=turn_pending_without_outbound: o turno espera uma resposta que
-- ninguém vai entregar. Silêncio para o usuário.
SELECT t.id, t.created_at FROM agent_turns t
 WHERE t.status = 'outbound_pending'
   AND NOT EXISTS (SELECT 1 FROM outbound_messages o
                    WHERE o.tenant_id=t.tenant_id AND o.agent_id=t.agent_id
                      AND o.turn_id=t.id);

-- kind=outbound_without_live_turn: a linha ainda vai entregar, e o turno já
-- foi dado como encerrado. Mensagem que sai depois do fim.
SELECT o.id, o.status, t.status AS turn_status
  FROM outbound_messages o
  JOIN agent_turns t ON t.tenant_id=o.tenant_id AND t.agent_id=o.agent_id AND t.id=o.turn_id
 WHERE o.turn_id IS NOT NULL
   AND o.status NOT IN ('completed','failed_terminal','cancelled','dead_letter','sent','failed','unknown')
   AND t.status IN ('completed','ignored','superseded','dead_letter');
```

**Nenhum dos dois é corrigido automaticamente**, e a assimetria é deliberada:
consertar o primeiro seria INVENTAR uma resposta que a cognição nunca produziu;
consertar o segundo seria CANCELAR uma entrega possivelmente em voo.

Como #631 move o turno e insere a linha na MESMA transação, o sentido 1 não pode
nascer do commit. Se aparecer, procure escrita fora das fronteiras: migração de
dados, `UPDATE agent_turns` manual, ou uma linha apagada à mão.

## 6. DLQ e rearmamento manual

### 6.1 Ver o que morreu

```sql
SELECT id, payload_type, attempt, last_error_code, delivery_outcome, created_at
  FROM outbound_messages
 WHERE status = 'dead_letter'
 ORDER BY created_at DESC LIMIT 50;
```

`last_error_code` diz por quê: `attempt_limit` (esgotou as
**12** tentativas) ou `reconciliation_timeout` (ficou incerta por 24h). Toda ida
para a DLQ tem uma row de auditoria `outbound_dead_lettered`.

### 6.2 Rearmar

```bash
npm run dlq outbound-show  <outbound_id>
npm run dlq outbound-rearm <outbound_id> --reason "<motivo>" [--actor <quem>] \
                                         [--confirm-duplicate-risk]
```

O que o comando faz, nesta ordem, e por que a ordem é a garantia:

1. **resolve o dono** pela fronteira de confiança — você digita um
   `outbound_id`, nunca um tenant;
2. **calcula o risco de duplicata** a partir do estado real da linha;
3. **RECUSA** sem `--confirm-duplicate-risk` quando há risco. A flag é
   fail-closed: ausente é recusa;
4. transiciona por CAS auditado (`outbound_manual_rearm`, com `actor`, `reason`,
   `duplicate_risk` e `acknowledged_duplicate_risk`) e **só então** rearma o job.

`--reason` é obrigatório sempre. Ele vai para a auditoria, e uma intervenção sem
motivo registrado é uma intervenção que ninguém consegue reconstruir depois.

**`failed_terminal` não é rearmável** e a recusa é intencional: o provedor
recusou de forma definitiva, e rearmar é pedir a mesma recusa num laço.

### 6.3 Rearmar em lote

Não existe, e a ausência é deliberada. Um lote de `dead_letter` mistura linhas
sem risco (`text`) com linhas de risco (`audio`, `document`), e um comando de
lote transformaria a confirmação de risco num flag que se digita uma vez para N
mensagens que o usuário pode receber em dobro. Se você precisa de lote, faça o
laço no shell — e leia cada `outbound-show`.

## 7. Rollback

1. Desligue `FEATURE_OUTBOUND_RECOVERY` (para de enfileirar e de reconciliar).
2. Desligue `FEATURE_OUTBOUND_DELIVERY_WORKER` (para de consumir). Nesta ordem —
   a inversa deixa jobs armados sem consumidor.
3. O caminho síncrono de #631/#632 continua entregando. Linhas em `retryable` e
   `delivery_unknown` param onde estão, visíveis e auditáveis.
4. **Só então**, se for mesmo reverter o schema: drene as linhas em
   `dead_letter` (rearme ou promova a `failed_terminal`) ANTES de aplicar
   `migrations/131_outbound_recovery_dlq_down.sql`. O `_down` pré-checa e
   ABORTA se houver `dead_letter` — de propósito, porque reescrevê-las em
   silêncio apagaria a distinção da §1.

O `_down` é atômico (`BEGIN`/`COMMIT`): ou volta inteiro, ou não volta nada.
Nenhum índice é `CONCURRENTLY`, mas se algum dia for, confira à mão — o runner
NÃO detecta índice inválido (issue #658):

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

## 7.5 Mídia de saída durável (#634)

### Onde ela está

`<MEDIA_ROOT>/outbound/<tenant_id>/<agent_id>/<pessoa_id>/<sha256>.<ext>`.
O artefato do outbox carrega só `{bucket, object_key}` — nunca caminho, URL ou
credencial. Para achar o objeto de uma linha:

```sql
SELECT id, status, payload_type, payload_json->'media' AS media
  FROM outbound_messages
 WHERE id = '<outbound_id>';
```

O caminho no disco é `MEDIA_ROOT + '/outbound/' + (payload_json->'media'->>'object_key')`.

### `media_ref_unresolved` — o que ele significa AGORA

Antes de #634 esse `last_error_code` significava "o worker não sabe resolver
`storage_object`". Depois de #634 significa **"o objeto não está legível neste
volume"**, e as causas são outras:

| Causa | Como confirmar | O que fazer |
|---|---|---|
| A réplica não monta o mesmo volume `MEDIA_ROOT` | `ls <MEDIA_ROOT>/outbound` na réplica que falhou × na que commitou | **Corrigir o deploy.** Rearmar não resolve: a próxima tentativa cai na mesma réplica-classe |
| O objeto foi apagado por um pedido de exclusão do titular (LGPD) | `data_tombstones` com `data_class='media.outbound_artifacts'` e o `subject_ref` daquele titular | **Não rearme.** Cancele a linha: reenviar mídia de um titular que pediu exclusão é o incidente, não a entrega |
| GC apagou depois de uma entrega confirmada e a linha foi rearmada | `status` da linha era `delivered`/`completed` antes do rearme | Não rearme. A mensagem já chegou |
| Chave de outro escopo (row adulterada) | o `object_key` começa com um `tenant_id` diferente do da row | Incidente de segurança. Preserve a row e escale |

`media_ref_unresolved` é sempre `rejected_terminal` — recusa DEFINITIVA. Um
`rejected_retryable` faria a linha girar no backoff para sempre contra um objeto
que não vai reaparecer.

### Crescimento do volume

O objeto é descartado **na entrega confirmada**. O que fica são os objetos de
linhas que terminaram incertas ou terminais — de propósito: a reconciliação e o
rearmamento manual precisam dos bytes. Para medir:

```bash
du -sh "$MEDIA_ROOT/outbound"
find "$MEDIA_ROOT/outbound" -type f -mtime +30 | wc -l
```

**Não existe varredor de TTL, e a ausência é declarada.** O prazo é decisão do
DPO: a classe `media.outbound_artifacts` nasce `pending_dpo` como as outras
treze, e `resolveRetention` devolve `purgeable:false` para todas. O mecanismo
está ligado (o apagamento por titular funciona hoje); a política não. Enquanto
ela não chega, o crescimento é bounded pelo número de entregas que terminaram
mal — se `du` crescer sem que `maia_outbound_dead_letter_total` e
`maia_outbound_delivery_unknown_total` cresçam junto, há órfão de GC e vale
abrir issue.

### A trava de envio direto

Se `maia_outbound_direct_send_violation_total` sair de zero:

1. o log estruturado `outbound.direct_send_violation` (com `ops_alert`) diz qual
   primitiva;
2. a chamada **já foi recusada** — nenhuma mensagem saiu sem ledger. O incidente
   é o caminho existir, não uma mensagem duplicada;
3. o caminho novo tem de escolher: passar pelo outbox, ou entrar em
   `src/runtime/outbound/send-paths.ts` como `declared_exception` com `reason` e
   `containment` escritos. Não há terceira opção, e o teste estático
   (`tests/unit/runtime/outbound-trava-envio-direto.spec.ts`) recusa a terceira.

   **Acrescentar uma exceção não é mais um caminho aberto (#506).** Aquele mesmo
   teste fixa a lista de seis ids, e o número **só desce**: incluir um sétimo
   reprova o CI e é decisão humana, não escolha de quem está implementando. Para
   um aviso PROATIVO — sem turno, para dono/aprovador/requester — o caminho já
   existe e não é exceção nenhuma: `enqueueProactiveNotice`
   (`src/runtime/outbound/proactive-notice.ts`) compromete a saída no ledger de
   agendamento com chave de idempotência, e o `outbox_drain` entrega. É o que
   `workers/briefings.ts`, `workflows/dual-approval.ts`, `workflows/engine.ts` e
   `tools/_dispatcher.ts` passaram a fazer.

Não existe env var para desligar a trava, e a ausência é a decisão: uma trava
desligável em produção é o fail-open que a épica lista como risco.

## 8. O risco residual que esta fatia ADMINISTRA e não resolve

Sem confirmação e idempotência confiáveis do provedor, a janela *"o provedor
recebeu, o processo não confirmou"* é **impossível de fechar**. Nenhuma
quantidade de reconciliação a fecha: o Baileys não oferece uma consulta de
status por `messageId` que permita perguntar "esta mensagem chegou?".

O que o sistema faz é preferir **estado incerto + reconciliação** a prometer
exactly-once ou reenviar às cegas. É por isso que `accepted_unconfirmed` vira
`delivery_unknown` e não `delivered`, que `sending` sobrevive ao takeover, e que
o rearmamento manual pergunta antes de agir.

Se um dia existir uma API de consulta de status, o lugar de ligá-la é
`reconciliationDisposition` (`src/runtime/outbound/recovery-contract.ts`): uma
quinta disposição `query_provider`, ANTES de `escalate_manual`.

## 9. Multipart — a política ESCRITA (#635)

Um turno pode produzir mais de uma saída lógica. Hoje o caso real é um só (o
fallback enquete→texto: a enquete ocupa a posição 0 e o texto a posição 1), mas
a política vale para qualquer número de artefatos.

### 9.1 Ordenação

O eixo é `outbound_messages.sequence_in_turn`, **escolhido pelo call site** e
nunca "a próxima posição livre" — a posição entra no material da
`logical_dedupe_key`, então alocá-la dinamicamente faria o retry da mesma
resposta derivar outra chave e nascer como uma segunda linha (#631).

A entrega respeita essa ordem por construção: `deliverOutbound` recusa um
artefato enquanto existir artefato de posição MENOR do mesmo turno que ainda não
se resolveu. A recusa é `awaiting_earlier_artifact`, acontece **antes do claim**
(para não consumir orçamento de tentativas) e deixa o log
`outbound.delivery_awaiting_earlier_artifact` dizendo qual posição segura a fila.

Custo: zero para a resposta de uma parte só — `sequence_in_turn = 0` não tem
irmã anterior possível e a consulta é pulada.

### 9.2 O que RESOLVE um artefato

`MULTIPART_RESOLVED_STATUSES` (`src/runtime/outbound/delivery-contract.ts`):
`completed`, `delivered`, `failed_terminal`, `cancelled`, `dead_letter`.

`delivery_unknown` e `reconciling` **não** resolvem, e essa é a decisão
importante: a mensagem pode ter chegado e pode ainda ser reenviada pela
reconciliação. Liberar o artefato seguinte ali faria o usuário ler a resposta
fora de ordem. Preferimos parar o turno e deixar a incerteza visível.

É uma lista de INCLUSÃO: um estado novo no vocabulário de #630 é BLOQUEANTE até
alguém decidir o contrário.

### 9.3 Falha parcial

Sintoma: um turno com artefatos em estados diferentes, e
`maia_outbound_pending_age_seconds` subindo sem `pending` acumulando.

```sql
SELECT sequence_in_turn, status, delivery_outcome, attempt, last_error_code
  FROM outbound_messages
 WHERE tenant_id = :t AND agent_id = :a AND turn_id = :turn
 ORDER BY sequence_in_turn;
```

Leitura: a PRIMEIRA linha cujo `status` não está em §9.2 é a que segura o resto.
Trate essa linha pelo sintoma dela (§5), não o turno inteiro.

### 9.4 Retomada

Automática, e sem repetir o que já foi confirmado: a varredura só rearma
`pending`/`retryable` (e faz takeover de lease morta), e nenhum desses estados é
alcançável a partir de `delivered`/`completed`. O artefato confirmado é
literalmente inalcançável pelo ciclo de entrega — o claim o recusa como
`terminal`.

### 9.5 Cancelamento

Uma saída commitada que **não vai ser entregue** — porque outra a substituiu —
é fechada como `cancelled_before_send` ⇒ `cancelled`, com
`last_error_code = 'superseded_by_text_fallback'`. Ela sai do trabalho
entregável, resolve a ordem para os artefatos seguintes, e não mente sobre
entrega.

> **O defeito que isto corrigiu**, e vale como aviso permanente: até a #635 essa
> linha era fechada como `rejected_retryable` ⇒ `retryable`, com o comentário
> "para que o recovery não a reenvie". `retryable` é EXATAMENTE o estado que a
> varredura seleciona. Cinco segundos depois o job era rearmado e o usuário
> recebia o texto do fallback **e** a enquete que ele substituía.

## 10. A CHAVE idempotente do histórico (#635)

`mensagens.outbound_id` (migração 135) diz qual artefato do outbox cada row de
histórico de saída registra. Unique PARCIAL
`mensagens_outbound_history_uq (tenant_id, agent_id, outbound_id) WHERE outbound_id IS NOT NULL`.

É o que torna a gravação do histórico idempotente **por chave** e não só por
ordem de execução — necessário porque a #635 deu ao histórico um SEGUNDO
escritor (a reconciliação). Os dois inserem com `ON CONFLICT DO NOTHING`: o
segundo é um no-op, e a conclusão acontece de qualquer forma.

`NULL` é legítimo: ingresso, histórico anterior à migração, e as saídas que
ainda não têm linha durável (regime de rollback de #631, voz sintetizada —
exceção declarada de #634). Essas rows ficam fora do índice e se comportam como
antes.

Verificação pós-deploy (o runner **não** detecta `CONCURRENTLY` inválido —
issue #658):

```sql
SELECT indisvalid, indisunique, pg_get_indexdef(indexrelid)
  FROM pg_index WHERE indexrelid = 'mensagens_outbound_history_uq'::regclass;
```

`indisvalid = f` ⇒ `DROP INDEX CONCURRENTLY mensagens_outbound_history_uq;` e
reaplique a 135.

Quantas respostas de saída ainda estão sem âncora (esperado: só as três
exceções acima):

```sql
SELECT count(*) FROM mensagens
 WHERE tenant_id = :t AND agent_id = :a AND direcao = 'out' AND outbound_id IS NULL
   AND created_at > now() - interval '1 day';
```

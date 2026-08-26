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
| `delivered` | O provedor devolveu identificador. A mensagem CHEGOU | falta só o histórico |
| `completed` | Chegou E o histórico da conversa registrou | ninguém |
| `delivery_unknown` | Pode ter chegado. Ninguém confirmou | reconciliação |
| `reconciling` | Incerta e triada: o provedor NÃO deduplica este tipo | **um humano** |
| `failed_terminal` | O provedor recusou DEFINITIVAMENTE | ninguém — rearmar é pedir a mesma recusa |
| `cancelled` | Abortada ANTES do envio. Nada saiu | worker (é auto-retryable) |
| `dead_letter` | **Nós** desistimos: teto de tentativas ou prazo de reconciliação | um humano, com confirmação de risco |

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
| `maia_outbound_reconciliation_total` | `result` | `escalate_manual` crescendo = fila HUMANA acumulando; `await_grace` alto e constante = carência longa demais |
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

### 5.4 `delivered` sem histórico

É a janela declarada pela #632: um crash entre `delivered` e `completed`. A
mensagem CHEGOU; o que falta é o registro na conversa.

A varredura, depois de um minuto de carência:

- se o histórico existir (o caminho síncrono o grava por conta própria), conclui
  a linha para `completed` — `maia_outbound_reconciliation_total{result="history_recovered"}`;
- se não existir, **loga `outbound_recovery.delivered_without_history` com
  `ops_alert` e não faz mais nada.** Ela não reenvia (duplicaria) e não fabrica
  o histórico (o texto teria de ser re-renderizado, e isso é #635).

A resposta operacional é reconstruir o histórico a partir de `payload_json`, à
mão, com o `provider_message_id` da linha. Não há comando para isso ainda.

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

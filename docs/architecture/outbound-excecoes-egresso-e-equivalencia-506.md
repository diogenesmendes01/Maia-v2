# #506 — as seis exceções de egresso, uma a uma, e a equivalência com a lane de fault injection da #510

> **O que este documento é.** As duas tabelas que o dono pediu quando recusou
> ratificar as seis exceções de egresso em bloco:
>
> > "Não ratifico as seis exceções em bloco. Tragam uma tabela por exceção com
> > **callsite, justificativa, controle fail-closed, owner, prazo e condição de
> > remoção**. A lane da #510 não substitui automaticamente os oito E2E: aceito
> > substituição apenas com **equivalência cenário a cenário e oracle a
> > oracle**; o que não estiver coberto continua pendente."
>
> **O que ele NÃO é.** Não é uma decisão. Não ratifica nada, não remove nenhuma
> exceção, não muda o comportamento do egress guard e não mexe no teto
> `MAX_DECLARED_EXCEPTIONS = 6`. É o material sobre o qual a decisão é tomada, e
> ele diz explicitamente onde não tem resposta.

**Fonte de verdade.** A Parte 1 é uma renderização de
[`src/runtime/outbound/send-paths.ts`](../../src/runtime/outbound/send-paths.ts) —
o inventário mora em código, e é lá que ele é cobrado (pelo compilador, pelo
import e por dois arquivos de teste). Este markdown é para ler; ele pode
envelhecer, o código não pode. Quando os dois divergirem, o código ganha.

---

## Parte 1 — a tabela por exceção

### 1.1 A tabela, compacta

| # | Exceção | Callsite | Justificativa (resumo) | Controle fail-closed | Owner | Prazo | Condição de remoção (resumo) |
|---|---|---|---|---|---|---|---|
| 1 | `agent.message_update_owner_review` | [`src/agent/message-update.ts:245`](../../src/agent/message-update.ts) — `sendText` | O call site usa o **id do provedor devolvido pelo envio** para gravar a pergunta em `mensagens` (`metadata.whatsapp_id`); o ledger de agendamento devolve "comprometido", não "enviado" | Pendência de revisão já existe no banco **antes** do envio: mensagem perdida vira lembrete, nunca decisão perdida | ⛔ **pendente do dono** | ⛔ **pendente do dono** | `commitStandaloneOutbound` existir + `deliverOutbound` aceitar `anchor_kind` (coorte 3 do ADR 0005) |
| 2 | `agent.react_loop_tool_reaction` | [`src/agent/react-loop.ts:610`](../../src/agent/react-loop.ts) — `sendReaction` | `sendReaction` devolve `void`: um artefato durável nasceria `delivery_unknown` em 100% dos casos e alimentaria a fila **humana** de #633 com ruído | `.catch` que suprime só a reação; a resposta do turno é independente, e uma reação não carrega informação que a resposta já não carregue | ⛔ **pendente do dono** | ⛔ **pendente do dono** | `reaction` deixar de ser `PROVIDER_IDEMPOTENCY_NONE` em `delivery-contract.ts` |
| 3 | `identity.quarantine` | [`src/identity/quarantine.ts:24`](../../src/identity/quarantine.ts) — `sendText` | Roda **antes** de existir turno (decide se a mensagem entra no runtime); e é a resposta **síncrona** a uma mensagem que a pessoa acabou de mandar | Estado da quarentena é durável em `pessoas.status` + pendência; o aviso é sobre esse estado, e o estado sobrevive à perda do aviso | ⛔ **pendente do dono** | ⛔ **pendente do dono** | `commitStandaloneOutbound` existir + `deliverOutbound` aceitar `anchor_kind` (coorte 1 do ADR 0005) |
| 4 | `scheduling.outbox_drain` | [`src/scheduling/outbox-drain.ts:310`](../../src/scheduling/outbox-drain.ts) — `sendText` | **Já é** um outbox durável com claim, retry e DLQ. Migrar o call site aninharia dois senders autoritativos — o que a §Rollback da issue proíbe nominalmente | Persistência antes do envio, claim com lease e DLQ — as mesmas propriedades que a épica exige, num ledger separado | ⛔ **pendente do dono** | ⛔ **pendente do dono** | `commitStandaloneOutbound` existir + `deliverOutbound` aceitar `anchor_kind` (coorte 4 do ADR 0005) |
| 5 | `workers.idempotency_relayer` | [`src/workers/idempotency-outbox-relayer.ts:192`](../../src/workers/idempotency-outbox-relayer.ts) — `sendText` | Segundo outbox durável, e o **único** cuja idempotência é honrada pelo PROVEDOR (`messageId` determinístico). Migração parcial trocaria garantia forte por fraca | Chave de dedupe do provedor derivada da identidade da row; retry e DLQ próprios | ⛔ **pendente do dono** | ⛔ **pendente do dono** | `commitStandaloneOutbound` existir + `deliverOutbound` aceitar `anchor_kind` (coorte 5 do ADR 0005) |
| 6 | `workers.pending_reminder` | [`src/workers/pending-reminder.ts:256`](../../src/workers/pending-reminder.ts) — `sendText` com `{ quoted }` | O lembrete **cita** a pergunta original; `WhatsappTextPayload` (`src/scheduling/types.ts:105`) só carrega `{ jid, text }`. Enfileirar hoje entregaria um "Lembra dessa?" solto | `reminder_count` incrementado com CAS **antes** do envio: falha de envio não gera dois lembretes; o teto limita o total | ⛔ **pendente do dono** | ⛔ **pendente do dono** | as duas acima **+** o payload de texto de #630 carregar a CHAVE da mensagem citada (coorte 2 do ADR 0005) |

**Controle fail-closed comum às seis, além do que está na coluna.** Nenhuma
delas consegue enviar por acidente: a fronteira única
(`src/gateway/line-output.ts`) chama `assertEgressAuthorized` em cada primitiva,
e o único jeito de autorizar é abrir escopo com `withDeclaredEgressException(id)`
— que **recusa em runtime** um id fora do inventário
([`egress-guard.ts:108`](../../src/runtime/outbound/egress-guard.ts)). Uma
violação incrementa `maia_outbound_direct_send_violation_total{kind}`.

### 1.2 Onde o repositório **não** conseguiu responder: `owner` e `prazo`

**As doze células de `owner` e `prazo` estão vazias, e isso é um achado, não uma
omissão.** Nada no repositório designa uma pessoa a nenhuma das seis exceções,
nem escreve uma data para nenhuma delas. O que foi procurado, e o que foi
encontrado:

| Onde se procurou | O que existe |
|---|---|
| As entradas do inventário (`send-paths.ts`) | `reason`, `containment`, `blocked_by`, `remediation`. Nenhum nome, nenhuma data. |
| `docs/architecture/decisions/0005-outbox-sem-turno.md` | `Owner: Maia maintainers` no cabeçalho, e `Status: Proposed — aguardando decisão humana`. Sem data-alvo. |
| `.github/CODEOWNERS` | Só os *Architecture Locks* da máquina de estados de conhecimento (`@diogenes-mendes`). Nenhum caminho de egresso. |
| `security/audit-exceptions.json` (o ledger de #526) | Hoje **vazio**. O histórico mostra o formato do campo (`"owner": "diogenesmendes01"`) — foi de lá que veio o vocabulário desta tabela. |
| `git log` das fatias da épica | Descreve o trabalho; não atribui as exceções. |

`Owner: Maia maintainers` é precisamente o dono coletivo que a recusa mira:
quando um prazo vence, um time não recebe e-mail. Preencher as seis linhas com
`diogenesmendes01` produziria uma tabela que **parece** completa e não é —
seria um chute sobre atribuição de responsabilidade, disfarçado de dado.

Então as duas colunas ficam declaradamente vazias, e a lacuna é **mecânica**, não
editorial:

- o valor `pendente-do-dono` pertence ao vocabulário fechado
  `OUTBOUND_EXCEPTION_OWNERS` e é marcado no tipo como **não sendo um dono**;
- os seis ids estão em `PENDING_OWNER_DECISION_IDS`
  ([`send-paths.ts:847`](../../src/runtime/outbound/send-paths.ts)), que **só
  encolhe**: quando o dono designar `owner` (e, querendo, `prazo`) para uma
  entrada, o id sai dali na mesma PR;
- uma exceção que fique pendente **sem** estar naquela lista **derruba o import
  do módulo** — a sétima lacuna não entra em silêncio.

**Como preencher uma linha** (é uma edição de três campos, e o CI cobra o resto):

```ts
owner: 'diogenesmendes01',
deadline: { kind: 'prazo', expires: '2026-12-31' },
```

…e remover o id de `PENDING_OWNER_DECISION_IDS`. A partir daí,
`expiredExceptions()` reprova o CI no dia seguinte ao vencimento. Um dono novo
que não seja `diogenesmendes01` exige acrescentar um **membro** a
`OUTBOUND_EXCEPTION_OWNERS` — uma linha visível no diff, de propósito.

> **Por que o vencimento reprova o CI e não derruba o processo.** O resto do
> inventário é cobrado no *import* (fail-closed: um inventário inválido não sobe
> o runtime). O prazo não: pendurar a queda do runtime numa data faria uma
> exceção vencida **derrubar a produção num domingo** — trocaria um problema de
> governança por uma indisponibilidade. É o mesmo desenho do ledger de
> `npm audit` (#526/#574), e pela mesma razão.

### 1.3 As condições de remoção, e o que elas revelam

Uma condição de remoção só vale se for um **fato verificável**. Cada uma carrega
`when` (o fato), `why_sufficient` (por que aquele fato basta para apagar *esta*
entrada) e **sondas** — pares `(módulo, símbolo)` que a suíte confere.

A sonda tem duas pontas. `tests/unit/runtime/outbound-excecoes-dono-prazo-remocao.spec.ts`
exige que a condição seja **falsa hoje**; no dia em que o símbolo aparecer, o
teste fica **vermelho** dizendo que a condição passou a valer e a exceção deve
sair do inventário. É a diferença entre uma condição e uma promessa: a promessa
envelhece calada.

| # | Exceção | Sondas (`módulo` → `símbolo`) | Estado hoje |
|---|---|---|---|
| 1 | `agent.message_update_owner_review` | `commit.ts` → `commitStandaloneOutbound`; `delivery.ts` → `anchor_kind` | ausentes |
| 2 | `agent.react_loop_tool_reaction` | `delivery-contract.ts` → `reaction: PROVIDER_IDEMPOTENCY_NATIVE` | ausente (hoje `…_NONE`) |
| 3 | `identity.quarantine` | `commit.ts` → `commitStandaloneOutbound`; `delivery.ts` → `anchor_kind` | ausentes |
| 4 | `scheduling.outbox_drain` | idem | ausentes |
| 5 | `workers.idempotency_relayer` | idem | ausentes |
| 6 | `workers.pending_reminder` | idem **+** `contract.ts` → `quoted` | ausentes |

#### O achado: cinco das seis condições são **o mesmo fato**

Cinco das seis exceções desbloqueiam com **uma decisão só** — aceitar o ADR 0005
e existir `commitStandaloneOutbound` com `deliverOutbound` aceitando a família
`anchor_kind`. Isso muda o que está sobre a mesa: não são cinco trabalhos
independentes com cinco donos, é **uma decisão de modelo** seguida de cinco
coortes de migração que o próprio ADR já ordena (§5), cada uma trocando um
emissor por outro no mesmo commit.

O que sobra por cima do fato comum é pequeno e específico:

- **`workers.pending_reminder`** precisa também que o payload de texto de #630
  carregue a **chave** da mensagem citada (nunca o conteúdo: o payload é
  persistido e logado). Sem isso a migração entrega um "Lembra dessa?" solto —
  regressão de produto disfarçada de migração.
- **`workers.idempotency_relayer`** precisa que o `messageId` determinístico de
  hoje vire o `provider_idempotency_key` da row standalone. É o que impede a
  migração de trocar a idempotência honrada **pelo provedor** pela honrada só
  pelo nosso ledger.
- **`identity.quarantine`** precisa que a entrega seja **imediata** na mesma
  chamada, e não enfileirada num drain de cadência de 1 minuto — o eco síncrono
  é a razão de a mensagem existir. A coorte 1 do ADR prevê exatamente isso.
- **`agent.message_update_owner_review`** não precisa de nada a mais: o ciclo de
  entrega **já** grava `whatsapp_id: ctx.provider_message_id` no histórico
  ([`historico.ts:132`](../../src/runtime/outbound/historico.ts)), que é o
  retorno que o call site hoje captura à mão.

#### A sexta é diferente, e provavelmente é permanente

`agent.react_loop_tool_reaction` **não entra em coorte nenhuma** — o ADR 0005 diz
isso com todas as letras. A condição escrita é verificável (`reaction` virar
`PROVIDER_IDEMPOTENCY_NATIVE`), mas o fato que a torna verdadeira **não está
neste repositório**: depende de o Baileys/WhatsApp passar a confirmar reação com
identificador. Hoje `LineOutput.sendReaction` devolve `void`
([`line-output.ts:74`](../../src/gateway/line-output.ts)).

**Recomendação ao dono, escrita como pergunta e não como decisão tomada:** esta
exceção é candidata a ser declarada **permanente** em vez de temporária. Não
porque falte trabalho, mas porque o trabalho é de terceiro e pode nunca
acontecer — e uma exceção temporária que depende de terceiro é uma exceção
permanente com um rótulo errado. A `remediation` da entrada já registra um
caminho alternativo, que é nosso: **(b)** um desfecho terminal honesto para
saídas sem confirmação possível, para que a reação não entre na fila humana de
#633. Se o dono escolher (b), a condição de remoção desta linha **precisa ser
reescrita** — a sonda atual não acende com ela, e isso está anotado no próprio
`why_sufficient`.

---

## Parte 2 — equivalência: os 8 E2E da #506 × a lane FI da #510

### 2.1 O que está sendo comparado

Da #506, seção **"E2E com fake WhatsApp determinístico"** — oito cenários.
Da #510, a lane de fault injection: **14 dos 25 cenários implementados**
(`tests/reliability/README.md`), rodando com Postgres/Redis reais, processos
filhos de verdade, `SIGKILL` por PID exato e um `FakeChannelProvider` que vive
**fora** do processo e sobrevive ao kill.

**Régua aplicada** (a do dono, literal):

1. o mesmo *tipo* de falha em **outro ponto do pipeline** não é o mesmo cenário;
2. o mesmo cenário com um **oracle mais fraco** não é equivalência — "o claim é
   único" (posse) e "a mensagem não é reenviada" (efeito) são afirmações
   diferentes;
3. na dúvida, **PARCIAL** com a diferença escrita.

### 2.2 O fato que decide metade da tabela

**Nenhum cenário da lane FI roda um turno de verdade.** Verificado: nenhum
cenário nem fixture importa o `FakeLlmServer` (`grep -rl FakeLlmServer
tests/reliability/{scenarios,fixtures}` → vazio). O que os cenários fazem é:

- `motor-de-turno.ts` chama `createInbound` / `enqueueAgent` / `runMessageRecovery`
  **e para aí** — nenhuma resposta é produzida;
- `replica-de-commit.ts` **fabrica** o texto da resposta
  (`const texto = process.env.TEST_FI_TEXTO ?? 'resposta durável do cenário'`) e
  o entrega a `commitOutboundIntent` real;
- `fi-outbound-entrega` e `fi-recuperacao-concorrente` **inserem** a linha do
  outbox por `INSERT` direto.

Consequência: **a cadeia "uma mensagem chega → o agente responde → a resposta é
entregue" não é atravessada por nenhum cenário.** As pontas são provadas
separadamente, com a costura no meio fabricada pelo teste. Isso não desqualifica
os cenários — eles provam o que se propõem a provar, contra infraestrutura real —,
mas impede que qualquer um deles seja a substituição de um E2E cuja premissa é
justamente a cadeia inteira.

**Segunda consequência, para dois cenários específicos:** toda linha de outbox da
lane é `payload_type = 'text'` com `sequence_in_turn = 0`. Não existe áudio, não
existe mídia, não existe segunda parte.

### 2.3 A tabela

| # | Cenário E2E da #506 | Falha injetada / oracle que a #506 pede | Cenário FI que chega mais perto | Veredito | Por quê |
|---|---|---|---|---|---|
| 1 | uma mensagem inbound produz **uma única chamada lógica outbound** | nenhuma falha (caminho feliz); oracle: 1 inbound ⇒ 1 efeito lógico no provider | FI-01 (metade de entrada) + FI-17 (metade de saída) | **NÃO COBERTO** | A cadeia inteira não é percorrida por cenário nenhum. FI-01 prova "um ingresso, um turno" e **para antes de qualquer saída**; FI-17 prova "um claim, um efeito lógico" a partir de uma linha **inserida à mão**. Somar duas metades que nunca se olham não é o cenário: o que a #506 pede é que a saída seja consequência observada daquela entrada. |
| 2 | **redelivery inbound** não duplica resposta | falha: o mesmo evento entregue duas vezes; oracle: **a resposta não é duplicada** | **FI-01** — mesmo evento em duas réplicas de processo, soltas por barreira | **PARCIAL** | A falha injetada é **a mesma**. O oracle não é: FI-01 afirma `createInbound` persistir UM ingresso e criar UM turno, e a perdedora receber a mesma `mensagem_id` com `duplicate: true`. Nenhuma resposta é produzida e o ledger do provider não é consultado — as checagens da família `outbound` do oracle rodam sobre conjunto **vazio** e passam vacuamente. É exatamente a diferença que o dono nomeou: posse × efeito. |
| 3 | **kill do runtime após persistência** ainda entrega | falha: `SIGKILL` depois de persistir; oracle: a mensagem **ainda é entregue**, uma vez | **FI-16** — `SIGKILL` depois do commit do outbox e antes do transporte | **PARCIAL** | O mais forte da tabela, e ainda assim não equivalente. A favor: o commit é `commitOutboundIntent` REAL, a varredura é `runOutboundRecoveryForScope` de produção, o ciclo de entrega é o real, o ledger do provider vive fora e marca `physical_call_total = 1`, e uma **segunda** varredura não produz um segundo envio. Contra: (a) o que morre é uma réplica de commit, não um runtime que recebeu mensagem — não há inbound; (b) **o consumidor da fila fica fora** (o README diz isso): quem chama o ciclo de entrega é o cenário, não o worker de `FEATURE_OUTBOUND_DELIVERY_WORKER`. "Ainda entrega" é provado com um empurrão do teste no último passo. Se a persistência do E2E-3 for lida como a do **inbound**, o cenário correspondente é FI-02, que para no job rearmado e nunca entrega nada. |
| 4 | **kill do delivery após provider aceitar** entra em reconciliação | falha: provider aceita, ACK perdido, worker morto; oracle: **entra em reconciliação**, sem reenvio cego | **FI-18** — `accept_then_drop` + `SIGKILL` no gate 2 | **PARCIAL** | A falha é **a mesma**, e metade do oracle é **mais forte** que a pedida: `estavelDurante` sobre o `physical_call_total` de um processo que sobreviveu ao kill prova que o sucessor **não reenviou**, e a linha termina em `delivery_unknown` / `cancelled_after_send_unknown`, com posse liberada. O que falta é a outra metade: "entra em reconciliação" é provado como **chegar ao estado que a reconciliação consome**, não como a reconciliação consumindo. `runOutboundRecoveryForScope` — que existe e trata `delivery_unknown` via `reconciliationDisposition` — nunca roda neste cenário. Coberto por `tests/integration/outbound-recovery-reconciliation-real-db.spec.ts`, que é in-process e fora da lane. |
| 5 | **retry confirmado seguro reutiliza chave** | falha: desfecho retryable seguro; oracle: o retry usa **a mesma** `provider_idempotency_key` | — (adjacente: FI-15; FI-20 está *parcial*) | **NÃO COBERTO** | Nenhum cenário exercita "provider recusa de forma seguramente retryável → reenvio → mesma chave". FI-15 prova reuso de identidade **lógica** (o segundo commit da mesma saída devolve `inserted: false` e o mesmo `outbound_id`), mas a falha dele é um `SIGKILL` antes do commit — outro ponto do pipeline. FI-20 (colisão chave/payload) continua **parcial**: o FAKE recusa chave igual com hash diferente; a `logical_dedupe_key` de produção não é exercida. |
| 6 | **texto, áudio e ao menos uma mídia** percorrem o mesmo contrato | oracle: as três variantes obedecem ao mesmo contrato | — | **NÃO COBERTO** | Toda linha de outbox da lane é `payload_type = 'text'`. Não há áudio nem mídia em cenário nenhum, e o `FakeChannelProvider` declara não modelar os erros de upload de mídia reais. |
| 7 | **fallback/timeout** também usam o outbox | falha: deadline/timeout; oracle: o fallback sai **pelo outbox**, uma vez | FI-21 (*parcial*), FI-22/FI-23 (*falta*) | **NÃO COBERTO** | FI-21 está declarado parcial: o `FakeLlmServer` observa `AbortSignal`, mas **falta o cenário com o turno real** — e, como nenhum cenário roda o turno, não há caminho por onde um fallback nasça. Fora da lane, `tests/integration/outbound-fallback-enquete-nunca-entrega-real-db.spec.ts` cobre um recorte disso, in-process. |
| 8 | **multipart retoma do artefato correto** sem repetir os confirmados | falha: crash no meio de uma resposta multipart; oracle: retoma do artefato certo, não repete os confirmados | — | **NÃO COBERTO** | `sequence_in_turn` é `0` em toda linha da lane; nenhum cenário tem duas saídas no mesmo turno. O oracle checa a unicidade de `(turn_id, sequence_in_turn)`, mas sobre um conjunto de tamanho 1 — a propriedade de **ordenação e retomada parcial** não é exercida em lugar nenhum. |

**Placar: 0 COBERTO · 3 PARCIAL · 5 NÃO COBERTO.**

### 2.4 A resposta à pergunta do dono

**A lane da #510, como está hoje, não substitui nenhum dos oito E2E.** Os oito
continuam pendentes: três com meio caminho andado (2, 3, 4) e cinco sem começo
(1, 5, 6, 7, 8).

O que a lane **acrescenta** e um E2E in-process não daria: processos que morrem
de verdade, lease que vence pelo relógio do banco e um contador de efeitos que
sobrevive ao `SIGKILL`. Isso é motivo para manter os dois, não para trocar um
pelo outro.

**O que destravaria mais de uma linha de uma vez**, se o dono quiser priorizar:
um cenário FI que rode **um turno de verdade** (inbound → LLM fake → resposta →
outbox → entrega) fecharia a costura fabricada que hoje impede 1, 2, 3 e 7 de
serem equivalentes. É o mesmo bloqueio quatro vezes, e é ele que o `FakeLlmServer`
— já pronto, sem consumidor — existe para resolver.

---

## Anexo — como o inventário é cobrado (para quem for editar)

| Camada | Onde | O que reprova |
|---|---|---|
| Compilador | `OutboundDeclaredException` ([`send-paths.ts:374`](../../src/runtime/outbound/send-paths.ts)) | Exceção sem `reason`, `containment`, `blocked_by`, `remediation`, `owner`, `deadline` ou `removal` — **não compila** |
| Import do módulo | `assertRatifiedInventory` ([`send-paths.ts:927`](../../src/runtime/outbound/send-paths.ts)) | Exceção não ratificada, owner fora do vocabulário, prazo que não é data, prazo sem dono, pendência não declarada, condição de remoção vazia ou sem sonda, teto estourado. **Derruba o processo**, e `egress-guard.ts` importa daqui |
| Suíte (varredura) | `tests/unit/runtime/outbound-trava-envio-direto.spec.ts` | Módulo que envia fora do inventário; entrada fantasma; teto ≠ número real; alegação `no_turn_to_anchor` falsa |
| Suíte (governança) | `tests/unit/runtime/outbound-excecoes-dono-prazo-remocao.spec.ts` | **Prazo vencido**; pendências ≠ lista declarada; módulo de sonda inexistente; **condição de remoção que passou a valer** |

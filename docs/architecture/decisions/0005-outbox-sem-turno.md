# ADR: uma âncora durável para saída SEM turno (PROPOSTA — decisão do dono)

| Field | Value |
|---|---|
| Status | **Proposed — aguardando decisão humana** |
| Date | 2026-08-30 |
| Owner | Maia maintainers |
| Related issue | [#506](https://github.com/diogenesmendes01/Maia-v2/issues/506) |
| Related PR | — |

> Este ADR NÃO foi implementado. Ele existe porque a alternativa era um agente
> decidir sozinho o modelo do outbox durável de uma tabela quente. O que a fatia
> associada entregou está em `src/runtime/outbound/send-paths.ts`; o que está
> aqui é o que falta, escrito como trabalho, para que a decisão seja de quem tem
> autoridade para tomá-la.

## Context

### A correção de fato que abre esta discussão

O inventário de #634 justificava sete das dez exceções de egresso com uma
afirmação sobre o schema:

> "o outbox de #631 exige `turn_id` NOT NULL (migração 121)"

**Essa afirmação é falsa.** O que a migração 121 realmente faz, verificável em
`migrations/121_outbound_messages_durable_outbox.sql`:

| Fato | Onde | Consequência |
|---|---|---|
| `ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS turn_id uuid;` | 121, §(1) | a coluna é **nullable** |
| `COMMENT ... 'NULL = row legada anterior ao outbox duravel'` | 121, §(8) | a nulabilidade é **intencional e documentada** |
| `CHECK ( CASE WHEN turn_id IS NULL THEN true ELSE (...tuplo inteiro...) END )` | 121, §(6e) | sem turno o CHECK **não exige nada**; com turno exige tudo |
| FK composta `(tenant_id, agent_id, turn_id)`, MATCH SIMPLE (default) | 121, §(1) | com `turn_id` NULL a FK é **satisfeita trivialmente** |
| `UNIQUE (tenant_id, agent_id, logical_dedupe_key) WHERE logical_dedupe_key IS NOT NULL` | 121, §(7a) | a proteção contra duplo envio **não depende de `turn_id`** |
| `UNIQUE (tenant_id, agent_id, turn_id, sequence_in_turn) WHERE turn_id IS NOT NULL` | 121, §(7b) | esta sim é do turno, e é **parcial** |

A mesma verificação desmonta a segunda justificativa, `foreign_recipient` ("o
destinatário diverge do turno que ancora a row"): `resolveOutboundDeliveryScope`
(`src/runtime/outbound/delivery-scope.ts`) resolve o JID a partir de
`o.conversa_id` e `o.in_reply_to` **da própria row** — `turn_id` não aparece na
consulta. O destinatário de uma row é o destinatário da conversa da row, e
sempre foi.

**Portanto: nenhuma migração é necessária para expressar uma row durável sem
turno.** Uma linha com `payload_json`, `payload_hash`, `logical_dedupe_key`,
`provider_idempotency_key` e `turn_id NULL` já é gravável hoje, e a única
proteção de unicidade que ela perde é a de posição dentro de um turno — que não
significa nada para uma saída que não pertence a turno nenhum.

### O que de fato bloqueia

Dois pontos de **código**, ambos deliberados e ambos corretos para o escopo em
que foram escritos:

1. **`commitOutboundIntent`** (`src/runtime/outbound/commit.ts`) exige
   `getOutboundTurnScope()`; sem handle devolve `{ committed: false, reason:
   'no_turn_scope' }`. Ela não tem como não exigir: `commitTurnOutboundTx`
   move o turno para `outbound_pending` com CAS de `state_version` e FENCE do
   `claim_token` — sem turno não há nada disso.
2. **`deliverOutbound`** (`src/runtime/outbound/delivery.ts`, entrada do ciclo)
   recusa a row: `if (!row.turn_id || !row.payload_json ||
   !row.provider_idempotency_key) return { delivered: false, reason:
   'row_not_found' }`.

E uma restrição de processo, que é a mais importante: a **§Rollback** de #506
proíbe habilitar dois senders autoritativos ao mesmo tempo. Hoje existem três
emissores duráveis distintos — `outbound_messages` (turno), `outbox_messages`
(agendamento) e o outbox de efeitos idempotentes de #278. Qualquer caminho que
faça uma dessas rotas passar a enviar por `deliverOutbound` **sem desligar o
emissor antigo no mesmo passo** produz envio duplicado.

## Decision (a decidir)

Proposta: **`outbound_messages` ganha uma âncora explícita para saída sem
turno**, e `deliverOutbound` passa a aceitar as duas famílias.

### 1. Schema — o mínimo, e por que é mínimo

Nenhuma coluna precisa mudar de nulabilidade. O que falta é **tornar a família
explícita em vez de inferida por `turn_id IS NULL`**, porque hoje `turn_id NULL`
significa duas coisas incompatíveis: "row LEGADA, anterior ao outbox" e "row
durável SEM turno". Confundir as duas é o defeito silencioso mais provável desta
mudança — `deliverOutbound` passaria a tentar entregar rows de 2025.

Migração aditiva (tabela QUENTE — `CONCURRENTLY` fora de transação, `NOT VALID`
+ `VALIDATE` em statement próprio, conforme o manual):

```sql
-- (a) A FAMÍLIA. Domínio fechado; NULL = row legada, e continua significando
--     exatamente o que sempre significou.
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS anchor_kind text;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_anchor_kind_check
  CHECK (anchor_kind IS NULL OR anchor_kind IN ('turn', 'standalone')) NOT VALID;
-- ... VALIDATE em statement próprio.

-- (b) COERÊNCIA entre família e turno. É o CHECK que impede a confusão
--     "legada" × "durável sem turno".
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_anchor_coherent_check CHECK (
    CASE anchor_kind
      WHEN 'turn'       THEN turn_id IS NOT NULL
      WHEN 'standalone' THEN turn_id IS NULL AND sequence_in_turn IS NULL
      ELSE turn_id IS NULL  -- legada
    END
  ) NOT VALID;

-- (c) COMPLETUDE da row standalone. Espelha o (6e) da 121, sem os campos do
--     turno. Sem ele, `standalone` viraria a porta de entrada de meia-row que
--     o (6e) fechou para o turno.
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_standalone_complete_check CHECK (
    anchor_kind <> 'standalone' OR (
      payload_version IS NOT NULL AND payload_type IS NOT NULL
      AND payload_json IS NOT NULL AND payload_hash IS NOT NULL
      AND logical_dedupe_key IS NOT NULL AND provider_idempotency_key IS NOT NULL
      AND next_attempt_at IS NOT NULL
    )
  ) NOT VALID;

-- (d) O índice de trabalho do worker já serve: idx_outbound_messages_ready é
--     (tenant_id, agent_id, next_attempt_at) WHERE status IN ('pending','retryable').
--     Ele não menciona turn_id, então cobre as duas famílias sem alteração.
```

**A FK composta não muda.** MATCH SIMPLE já a torna inerte com `turn_id NULL`;
tentar "desligá-la" seria mexer numa constraint de tabela quente sem ganho.

O `_down` derruba as três constraints e a coluna, nesta ordem.

### 2. `deliverOutbound` — a guarda que substitui a atual

A linha `if (!row.turn_id || ...)` some e vira, explicitamente:

```ts
// A família decide o que é exigível. Row LEGADA continua fora deste worker.
if (row.anchor_kind === null) return { delivered: false, reason: 'legacy_row' };
if (!row.payload_json || !row.provider_idempotency_key) {
  return { delivered: false, reason: 'row_not_found' };
}
if (row.anchor_kind === 'turn' && !row.turn_id) {
  // Incoerência que o CHECK (b) impede no banco; aqui é defesa em profundidade.
  return { delivered: false, reason: 'row_not_found' };
}
```

E o **gate de ordenação multipart** (§2b) fica condicionado a
`anchor_kind === 'turn'`: `findBlockingEarlierArtifact` consulta por
`(turn_id, sequence_in_turn)` e não tem sentido sem turno. Uma row standalone
não tem irmã anterior por construção — é o mesmo custo zero que
`sequence_in_turn === 0` já tem hoje.

O que **não** muda, e é o ponto: claim com lease, fence do canal (#513),
`markSending` fenced, `statusForOutcome`, `autoResendAllowed`, a política de
`delivery_unknown`. Nada disso lê `turn_id`. A row standalone atravessa o mesmo
ciclo.

### 3. O commit — função nova, não parâmetro opcional

`commitOutboundIntent` **não ganha um modo**. Uma flag `turn?: TurnHandle | null`
tornaria opcional o fence que é a razão de ela existir, e o primeiro call site
que esquecesse de passar o handle reintroduziria o defeito de #631 sem que nada
ficasse vermelho.

Em vez disso, `commitStandaloneOutbound(...)`:

- constrói o artefato com a MESMA `buildOutboundArtifact`, com um material de
  chave que substitui `(turn_id, sequence_in_turn)` pelo par
  **`(anchor_source, anchor_id)`** — a tabela e o UUID da row durável que
  justifica a saída (`approval_requests.id`, `pending_questions.id`,
  `outbox_messages.id`). É o mesmo princípio de derivação: a chave vem da
  identidade do que motivou a saída, nunca do texto;
- abre uma transação que insere a row com `anchor_kind = 'standalone'` e grava a
  auditoria no MESMO `tx` — sem UPDATE de turno, porque não há turno;
- **não tem fence**, e isso é uma diferença REAL que precisa estar escrita: a
  posse que o fence do turno verifica não existe aqui. O que substitui a
  proteção é a `logical_dedupe_key`: dois processos que derivem a mesma chave
  colidem no UNIQUE parcial (7a) e o segundo lê a linha do primeiro. Isso
  protege contra saída DUPLICADA, que é o risco desta família; não protege
  contra "um worker zumbi commitou", que é um risco que só existe quando há
  posse a perder.

### 4. Reconciliação (#633) — como as duas famílias se distinguem

`anchor_kind` entra na projeção de `outbound-recovery-repo.ts` e na fila de
reconciliação humana. As três consequências que o operador precisa ver:

1. **o rearme por turno não enxerga standalone.** O sweeper que procura turnos
   presos em `outbound_pending` filtra `anchor_kind = 'turn'` — uma row
   standalone não trava turno nenhum e não pode aparecer nessa varredura;
2. **a fila humana precisa de outra âncora na tela.** Hoje a linha de
   reconciliação é lida como "resposta do turno X". Para standalone o que faz
   sentido é `anchor_source`/`anchor_id` — "aviso do approval_request Y";
3. **`escalate_manual` fica mais raro, não mais comum.** Todo standalone desta
   família é `text`, que tem chave nativa no provedor, então
   `autoResendAllowed` permite o reenvio automático nos desfechos incertos —
   diferente de `reaction`, que é o caso que alimentaria a fila humana e que
   por isso NÃO entra nesta proposta.

### 5. A ordem de migração — o que impede dois senders autoritativos

Uma coorte por vez, cada uma numa PR, e **nenhuma delas liga o emissor novo sem
desligar o antigo no mesmo commit**:

| # | Coorte | O que muda | Emissor desligado no mesmo commit |
|---|---|---|---|
| 1 | `identity.quarantine` | chama `commitStandaloneOutbound` + entrega imediata (é síncrona) | o `line.sendText` da quarentena |
| 2 | `workers.pending_reminder` | idem, com o payload do ledger estendido para carregar a CHAVE da mensagem citada | o `line.sendText(..., { quoted })` |
| 3 | `agent.message_update_owner_review` | idem, com o histórico gravado pelo ciclo de entrega (que já persiste histórico) em vez de pelo call site | o `line.sendText` + o `mensagensRepo.create` do call site |
| 4 | `scheduling.outbox_drain` | o drain para de chamar o canal e passa a commitar standalone; `deliverOutbound` entrega | o `line.sendText` do `pickChannel` |
| 5 | `workers.idempotency_relayer` | idem, preservando o `messageId` determinístico como `provider_idempotency_key` | o `line.sendText(..., { messageId })` |

As coortes 4 e 5 são as que fundem os ledgers, e são as últimas de propósito:
elas só ficam seguras depois de o caminho standalone ter rodado em produção nas
coortes 1–3. Depois delas, `outbox_messages` e o outbox de #278 continuam
existindo como **agendadores** — o que some é o segundo e o terceiro **sender**.

`agent.react_loop_tool_reaction` **não entra em coorte nenhuma**, e a
justificativa está na própria entrada do inventário: a primitiva devolve `void`,
a row nasceria `delivery_unknown` em 100% dos casos e alimentaria a fila humana
com ruído. Ela sai do inventário no dia em que o provedor devolver id.

## Consequences

**Aceitando:** o egresso converge para um sender único, e a §Rollback é
respeitada porque cada coorte troca um emissor por outro atomicamente. O custo é
uma coluna e três CHECKs numa tabela quente, mais uma segunda função de commit
sem fence — que é uma assimetria real e precisa ficar escrita onde alguém a
leia, não só aqui.

**Recusando:** as seis exceções restantes continuam declaradas, com a
justificativa individual que já têm, e a catraca do inventário
(`tests/unit/runtime/outbound-trava-envio-direto.spec.ts`) continua impedindo
que apareçam novas. É um desfecho estável, não um débito silencioso — só não é
o "inventário vazio" que a issue-mãe chama de ideal.

**O que NÃO se deve fazer em nenhum dos dois casos:** deixar `commitOutboundIntent`
aceitar `turn` opcional. É a versão barata da proposta, e ela desfaz #631.

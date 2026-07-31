# Runbook — claim atômico, lease e fencing do turno (issue #504)

Cobre: rollout, diagnóstico de posse, lease presa, takeover, rejeição por
fencing, rearmamento manual e rollback.

Pré-requisito: [`turn-state-machine.md`](turn-state-machine.md) (#503). Sem a
máquina de estados não existe turno a reivindicar, e o boot recusa
`FEATURE_TURN_CLAIM=true` com `FEATURE_TURN_STATE_MACHINE=false`.

Fontes de verdade:

- vocabulário puro: [`src/runtime/turns/claim.ts`](../../src/runtime/turns/claim.ts)
- statements atômicos: [`src/db/repositories/turn-repos.ts`](../../src/db/repositories/turn-repos.ts)
- detentor da lease: [`src/runtime/turns/lease.ts`](../../src/runtime/turns/lease.ts)

## 1. O modelo em 30 segundos

**PostgreSQL decide quem executa.** A fila é despertador e transporte, nunca
autoridade.

```
job V2 {version:2, turn_id}  →  worker  →  tryClaimTurn (UM UPDATE)  →  venceu?
                                                                   ├─ não → fim, sem efeito
                                                                   └─ sim → lease + heartbeat
                                                                            + fence em toda escrita
```

Três mecanismos, cada um fechando um buraco diferente:

| Mecanismo | Fecha |
|---|---|
| `jobId = turn-<sha256(turn_id)[0..40]>` | dois wake-ups para o mesmo turno |
| claim atômico (`UPDATE ... RETURNING`) | duas réplicas começando o mesmo turno |
| `claim_token` no `WHERE` de toda escrita | worker lento gravando depois de perder a posse |

Nenhum deles depende dos outros. É deliberado: se o `jobId` falhasse, o claim
ainda garantiria um executor; se o claim falhasse, o fence ainda impediria a
segunda gravação.

**O que NÃO é resolvido:** efeito externo não-idempotente. O fence recusa a
escrita no Postgres, não desfaz um POST que já saiu. Ferramentas sem
idempotency key continuam vulneráveis — é o risco residual explícito da issue,
endereçado por outbox (#506) e por chave determinística em cada integração.

## 2. Colunas de posse (`agent_turns`)

| Coluna | Significa |
|---|---|
| `claimed_by` | `<hostname>:<pid>` do dono — diz QUAL container |
| `claim_token` | uuid imprevisível; o fence |
| `lease_expires_at` | até quando a posse vale (relógio do **banco**) |
| `heartbeat_at` | quando ela foi provada pela última vez |
| `attempt_count` | tentativa **canônica**, incrementada pelo claim |
| `next_attempt_at` | backoff persistido, com jitter de ±20% |

O trio `claimed_by`/`claim_token`/`lease_expires_at` é **all-or-nothing**
(`agent_turns_claim_trio_chk`, migration 108). Meia-posse é impossível por
construção: um token sem dono faria o fence casar numa row sem lease real.

## 3. Rollout

1. `npm run db:migrate` — aplica a **108**. Aditiva: uma coluna nullable e duas
   CHECKs. Sem reescrita de tabela, sem backfill.
2. Deploy com `FEATURE_TURN_CLAIM=false` (padrão). Nada muda: produtor arma job
   V1, consumidor entende as duas versões.
3. Confira `TURN_LEASE_TTL_MS` e `TURN_LEASE_HEARTBEAT_MS`. O boot **recusa**
   heartbeat acima de TTL/3.
4. Ligue `FEATURE_TURN_CLAIM=true` numa réplica de cada vez. Durante a janela
   mista, jobs V1 e V2 coexistem — ambos processam.
5. Observe por pelo menos uma hora:
   - `maia_turn_claim_total{result}` — `acquired` deve dominar; `lease_active`
     é normal em multi-réplica;
   - `maia_turn_lease_lost_total{reason}` — deve ser ~0. Ver §5;
   - `maia_turn_fence_rejected_total{operation}` — deve ser ~0 em regime;
     qualquer valor sustentado indica takeover frequente demais (TTL curto);
   - `maia_turn_job_payload_total{version}` — mede a migração V1→V2.
6. Remoção do caminho V1: **zero** `maia_turn_job_payload_total{version="v1"}`
   por 7 dias com o produtor V2 em 100%, em PR separado.

**Abortar o rollout se:** DLQ subir materialmente, `lease_lost` crescer sem
causa entendida, backlog/idade de turno crescer, ou qualquer indício de
vazamento entre tenants.

## 4. Diagnóstico

```sql
-- Quem segura o quê, agora.
SELECT tenant_id, agent_id, id AS turn_id, status, claimed_by,
       attempt_count,
       lease_expires_at - now()  AS lease_restante,
       now() - heartbeat_at      AS desde_ultimo_heartbeat
FROM agent_turns
WHERE status IN ('claimed', 'running', 'outbound_pending')
  AND claim_token IS NOT NULL
ORDER BY lease_expires_at;
```

```sql
-- Leases VENCIDAS: o recovery vai adotá-las no próximo sweep.
SELECT tenant_id, agent_id, id, status, claimed_by, attempt_count,
       now() - lease_expires_at AS vencida_ha
FROM agent_turns
WHERE status IN ('claimed', 'running')
  AND lease_expires_at IS NOT NULL
  AND lease_expires_at <= now()
ORDER BY lease_expires_at;
```

```sql
-- Órfãos pré-#504: estado de posse SEM lease. O claim os adota após 3× TTL.
SELECT tenant_id, agent_id, id, status, updated_at
FROM agent_turns
WHERE status IN ('claimed', 'running') AND lease_expires_at IS NULL
ORDER BY updated_at;
```

Trilha de auditoria: `turn_claimed` (quem pegou, em que tentativa) e
`turn_fence_rejected` (a defesa funcionou — um zumbi tentou gravar). A
**renovação não é auditada** de propósito: é o evento mais frequente do runtime
e enterraria os outros. O sinal dela é
`maia_turn_lease_heartbeat_total{result}`.

## 5. `maia_turn_lease_lost_total` subindo

| `reason` | Leitura | Ação |
|---|---|---|
| `taken_over` | o banco recusou a renovação: outro worker assumiu | TTL curto demais para a latência real do turno, ou GC/pausa longa. Suba `TURN_LEASE_TTL_MS` (e o heartbeat proporcionalmente). |
| `heartbeat_failed` | dois heartbeats consecutivos falharam | é indisponibilidade do **banco**, não de posse. Investigue o Postgres. |
| `released` | devolução ordenada no shutdown | esperado em deploy. |

Um `taken_over` sempre produz `turn_fence_rejected` quando a tentativa antiga
tenta gravar — os dois sinais juntos contam a história completa.

## 6. Rearmamento manual seguro

O `jobId` é determinístico, então rearmar é idempotente por construção. Antes
de rearmar, **confirme que a lease não está viva**:

```sql
SELECT status, claimed_by, lease_expires_at > now() AS lease_viva
FROM agent_turns WHERE id = '<turn_id>';
```

- `lease_viva = true` → **não rearme**. Outro worker está trabalhando; o job
  novo seria recusado pelo claim de qualquer forma, mas o ruído é evitável.
- `lease_viva = false` ou nula → o sweep de recovery rearma sozinho no próximo
  tick. Para forçar, use o replay de dead letter documentado em
  [`turn-state-machine.md`](turn-state-machine.md) §5 — ele gera nova tentativa
  e **descarta o token anterior**, de modo que um zumbi com o token velho não
  consegue fechar o turno.

Job retido no Redis (`completed`/`failed`) com o mesmo id **não** bloqueia o
rearmamento: `enqueueAgentTurn` remove a row retida antes do re-add. Um job
`waiting`/`active`/`delayed`, ao contrário, é preservado — removê-lo seria
cancelar um turno em andamento.

## 7. Rollback

Ordem, e a ordem importa:

1. `FEATURE_TURN_CLAIM=false` em todas as réplicas. O produtor volta a armar V1
   e o consumidor continua entendendo as duas versões — nenhum job em voo é
   perdido.
2. Aguarde `TURN_LEASE_TTL_MS` para que as leases vigentes expirem. Turnos
   presos em `claimed`/`running` voltam a ser elegíveis para o recovery de #503
   por `lease_expires_at <= now()`.
3. Só então, se for realmente necessário, `108_agent_turns_claim_lease_down.sql`.
   Rodar o `_down` com o runtime novo no ar derruba o ingresso (coluna
   inexistente) — o que é o comportamento fail-loud desejado, mas não durante
   um incidente.

O `_down` **não** apaga `claimed_by`/`claim_token`/`lease_expires_at`: essas
colunas são da 097 e sobrevivem. Nenhum turno é perdido em nenhum sentido.

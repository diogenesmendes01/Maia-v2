# Runbook — duplicatas de ownership de linha WhatsApp (migration 091)

A migration [`091_line_ownership.sql`](../../migrations/091_line_ownership.sql)
cria o índice único parcial global:

```sql
CREATE UNIQUE INDEX channels_active_line_uq
  ON channels (channel_type, external_id)
  WHERE active AND channel_type = 'whatsapp';
```

Isto é **fail-closed por design**: se DUAS rows ativas de `channel_type =
'whatsapp'` compartilharem o mesmo `external_id` (a mesma linha ativa em dois
workspaces), a criação do índice **falha** e a migração aborta — a migração
não escolhe sozinha qual lado perde a posse. Este runbook é o procedimento
operacional para diagnosticar, decidir e resolver ANTES de (re)aplicar a 091,
e para reverter se necessário.

Contexto de spec: roteamento multi-linha Draft v4 §2 — a posse de uma linha é
provada pelo pareamento (PairingSession, §2.5); após a 091 o conflito passa a
acontecer na **ativação** como erro `23505`, nunca como drop de tráfego em
runtime.

## 1. Preflight — detectar duplicatas e valores não-normalizáveis

Rode ANTES de aplicar a 091 (ou depois de uma falha na criação do índice).

### 1.1 Duplicatas ativas (bloqueiam o índice)

```sql
SELECT external_id,
       count(*)                                   AS actives,
       array_agg(id ORDER BY created_at)          AS channel_ids,
       array_agg(tenant_id || '/' || agent_id
                 ORDER BY created_at)             AS owners,
       array_agg(created_at ORDER BY created_at)  AS created
  FROM channels
 WHERE active
   AND channel_type = 'whatsapp'
 GROUP BY external_id
HAVING count(*) > 1;
```

Zero rows ⇒ o índice cria sem conflito; pule para a validação (§3).

### 1.2 `external_id` não-normalizável (reportado, não bloqueia)

A parte (2) da 091 normaliza dígitos-puros para `+dígitos`. Valores que não
casam nenhum dos dois formatos são deixados intactos e devem ser corrigidos
via re-pareamento:

```sql
SELECT id, tenant_id, agent_id, external_id, active
  FROM channels
 WHERE channel_type = 'whatsapp'
   AND external_id !~ '^\+[1-9][0-9]{6,14}$'   -- não é E.164 canônico
   AND external_id !~ '^[1-9][0-9]{6,14}$'     -- nem dígitos-puros (a 091 normalizaria)
   AND external_id <> 'default-channel';       -- catch-all semeado, intacto por design
```

Estas rows não impedem a migração, mas nunca casarão o exact-match do
resolver — trate cada uma pela seção 2.3.

## 2. Resolução

### 2.1 Decidir qual lado mantém a posse

Para cada `external_id` duplicado do §1.1, decida com o(s) operador(es) dos
workspaces envolvidos qual `(tenant_id, agent_id, channel_id)` é o dono
legítimo da linha. Evidências úteis:

```sql
-- Tráfego recente por canal (quem realmente usa a linha):
SELECT channel_id, count(*) AS msgs, max(created_at) AS last_msg
  FROM mensagens
 WHERE channel_id = ANY ($1::uuid[])   -- channel_ids do preflight
 GROUP BY channel_id;

-- Última transição de sessão auditada por canal:
SELECT metadata->>'channel_id' AS channel_id, acao, max(created_at) AS at
  FROM audit_logs
 WHERE acao IN ('line_session_transition', 'pairing_session_verified')
   AND metadata->>'channel_id' = ANY ($1::text[])
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;
```

Critério default quando não houver disputa real: mantém o canal com tráfego
inbound mais recente; os demais são quase sempre sobras de re-pareamento ou
seeds de teste.

### 2.2 Desativar o(s) lado(s) perdedor(es)

Nunca DELETE — desativar preserva o histórico (mensagens/conversas apontam
para o canal via FK composta):

```sql
UPDATE channels
   SET active = false
 WHERE id = ANY ($1::uuid[]);  -- somente os perdedores
```

Registre a decisão: quem autorizou, quando, e os `channel_ids` afetados (o
canal desativado pode ser re-pareado depois em outra linha pelo fluxo normal
da PairingSession — digitar um número nunca dá posse).

### 2.3 Corrigir valores não-normalizáveis (§1.2)

Para cada row reportada: se o valor é um número real com formatação errada
(espaços, hífens, `00` internacional), o caminho seguro é **desativar e
re-parear** — o pareamento grava o `external_id` E.164 canônico provado pela
sessão. Não edite `external_id` na mão em produção: um typo cria uma linha
"ativa" que nunca casa o exact-match e o tráfego dela cai no fluxo strict/
staging.

### 2.4 (Re)aplicar a migração

```bash
npm run db:migrate
```

## 3. Validação

1. O preflight §1.1 retorna **zero rows**.
2. O índice existe:

   ```sql
   SELECT indexdef FROM pg_indexes WHERE indexname = 'channels_active_line_uq';
   ```

3. Unicidade em runtime — tentar ativar uma segunda row com a mesma linha
   deve falhar com `23505` (é exatamente o erro que
   `channelsRepo.activateVerified` traduz para `line_owned_elsewhere` no
   fluxo de pareamento):

   ```sql
   -- em uma transação descartável (ROLLBACK ao final):
   BEGIN;
   UPDATE channels SET active = true WHERE id = '<canal inativo com linha já ativa>';
   -- espera-se: ERROR: duplicate key value violates unique constraint "channels_active_line_uq"
   ROLLBACK;
   ```

4. `npm run test:integration` verde (inclui
   [`tests/integration/routing-channel-scope.spec.ts`](../../tests/integration/routing-channel-scope.spec.ts),
   que aplica forward + down reais da 091/090 em um database descartável).

## 4. Rollback

O down da 091 ([`091_line_ownership_down.sql`](../../migrations/091_line_ownership_down.sql))
é **data-aware** (review PR #496 alto 7):

- `DROP INDEX channels_active_line_uq` — remove a unicidade global; a
  ativação deixa de conflitar (o runtime volta ao comportamento pré-091, em
  que a posse não é exclusiva).
- Restaura `external_id` **apenas** nas rows que o forward efetivamente
  normalizou (registradas em `channels_line_normalization_091_backup`) e
  dropa a tabela de backup. Rows que sempre foram E.164 ficam intactas.
- Ambientes que aplicaram uma versão pré-fix do forward (sem a tabela de
  backup) não têm dados tocados — fail-safe.

Procedimento (downs são manuais — ver [`migrations.md`](migrations.md)):

```bash
# 1. Backup lógico primeiro (sempre):
npm run backup

# 2. Aplicar o down:
psql "$DATABASE_URL" -f migrations/091_line_ownership_down.sql

# 3. Remover a row do ledger para permitir re-aplicação futura:
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE id = '091_line_ownership.sql'"
```

Atenção: canais desativados durante a resolução (§2.2) **não** são
reativados pelo rollback — reativá-los é decisão operacional explícita
(e, com o índice removido, deixa de haver guarda contra duplicata; só
reative um dos lados).

---

# Parte 2 — posse de SESSÃO entre réplicas (migration 115, issue #513)

A parte acima trata de **posse de linha entre workspaces**: duas rows de
`channels` ativas para o mesmo número. Esta parte trata de outra coisa, que
antes da 115 não tinha guarda nenhuma: **duas réplicas do runtime abrindo um
socket para a MESMA linha**.

São camadas independentes e ambas necessárias. A 091 impede que dois tenants
reivindiquem o mesmo número. A 115 impede que dois processos reivindiquem a
mesma linha do mesmo tenant.

## 5. O que a 115 acrescenta

A #518 já registrava `session_owner_instance` + `session_owner_lease_expires_at`
para **endereçar** comandos (`stop_line`, `repair`) à réplica que segura o
socket. Isso é roteamento, não exclusividade: a escrita era um upsert
last-writer-wins feito **depois** de o socket abrir, e o caminho de boot
(`startAdditionalLineSessions`) enumerava todas as linhas ativas e abria uma
sessão para cada, sem reivindicar nada.

A 115 acrescenta duas colunas e inverte a ordem:

| Coluna | Papel |
|---|---|
| `session_fencing_token` | contador **monotônico** por canal; incrementa a cada nova posse, nunca em renovação, nunca no release |
| `session_owner_acquired_at` | quando esta posse (este token) começou |

O socket agora só abre **depois** de `acquireSessionLease` conceder. A
expiração é sempre avaliada com `now()` do banco — containers com clock skew
não roubam nem cedem posse.

## 6. Diagnóstico

### 6.1 Quem segura cada linha, agora

```sql
SELECT c.external_id,
       s.state,
       s.session_owner_instance,
       s.session_fencing_token,
       s.session_owner_acquired_at,
       s.session_owner_lease_expires_at,
       s.session_owner_lease_expires_at > now() AS lease_viva
  FROM channel_line_state s
  JOIN channels c ON c.id = s.channel_id
 WHERE s.session_owner_instance IS NOT NULL
 ORDER BY s.session_owner_lease_expires_at;
```

`lease_viva = false` com dono preenchido = **réplica morta**. Não é incidente:
a próxima aquisição toma a linha e incrementa o token. Vira incidente se
persistir por mais de ~2 minutos com o `session-owner` no ar — aí o heartbeat
(`channel_pairing`, 5s) não está rodando, e a causa quase sempre é o papel:
confira `MAIA_PROCESS_ROLE` e a linha `worker.inventory` no boot.

### 6.2 Uma linha trocando de dono sem parar (flapping)

```sql
SELECT c.external_id, s.session_fencing_token, s.session_owner_acquired_at
  FROM channel_line_state s JOIN channels c ON c.id = s.channel_id
 WHERE s.session_owner_acquired_at > now() - interval '10 minutes'
 ORDER BY s.session_fencing_token DESC;
```

Token subindo depressa = takeover repetido. Causas, em ordem de frequência:

1. **Lease curta demais para a carga.** `OWNER_LEASE_MS` é 60s e o heartbeat
   roda a cada 5s; se o tick do `channel_pairing` está demorando >60s, o dono
   não renova a tempo. Veja `maia_worker_active_jobs{worker="channel_pairing"}`
   preso em 1 e `maia_worker_tick_skipped_total{reason="overlap"}` subindo.
2. **Réplica reiniciando em loop.** Cada boot toma a linha de volta.
3. **Postgres intermitente.** O CAS falha, o dono fecha o socket fail-closed, e
   outra réplica assume. Correto, mas visível — trate o Postgres.

### 6.3 Trilha de auditoria

```sql
SELECT criado_em, acao, metadata->>'channel_id' AS channel,
       metadata->>'owner_instance' AS owner,
       metadata->>'previous_owner' AS previous,
       metadata->>'fencing_token' AS token
  FROM audit_log
 WHERE acao LIKE 'line_session_ownership_%'
 ORDER BY criado_em DESC LIMIT 50;
```

- `_acquired` — posse de uma linha livre.
- `_taken_over` — a lease do dono anterior venceu e esta instância assumiu.
  `previous_owner` diz de quem.
- `_lost` — o CAS do heartbeat falhou; **o socket local já foi fechado** quando
  esta linha foi escrita.

Um `_lost` sem um `_taken_over` correspondente em outra instância significa que
a linha ficou órfã (nenhuma réplica a reassumiu) — verifique se sobrou algum
`session-owner` no ar.

## 7. Resolução

### 7.1 Duas réplicas parecem responder pela mesma linha

Não deveria acontecer depois da 115. Se acontecer, é bug — colete antes de
mexer:

```bash
# 1. Estado do banco (§6.1) e auditoria (§6.3), salvos em arquivo.
# 2. Qual papel cada container roda:
docker compose -f compose.roles.yml exec session-owner printenv MAIA_PROCESS_ROLE
# 3. A linha de inventário do boot de cada réplica:
docker compose -f compose.roles.yml logs session-owner | grep worker.inventory
```

Contenção imediata: **desabilite a linha pelo console**. O `stop_line` é
endereçado ao dono registrado e derruba o socket de verdade; com a lease do
alvo vencida, qualquer réplica conclui.

### 7.2 Linha presa sem dono (ninguém abre)

Sintoma: `session_owner_instance IS NULL` e a linha ativa não responde. Causas:

- **auth state ausente** — `line_session.auth_state_missing_pair_first` no log.
  A linha precisa ser re-pareada pelo console; não há posse a resolver.
- **aquisição falhando por banco** — `line_session.ownership_acquire_failed`.
  Fail-closed correto; trate o Postgres e a próxima varredura abre.

Nunca "force" a posse escrevendo `session_owner_instance` na mão: o token
ficaria dessincronizado do que a réplica tem em memória, e o CAS do heartbeat
passaria a falhar em loop.

## 8. Rollback da 115

Reverter volta ao contrato da 103: o endereçamento de `stop_line`/`repair`
continua funcionando, mas a **exclusividade some** — duas réplicas
`session-owner` voltam a poder abrir a mesma linha.

Por isso a ordem importa:

```bash
# 1. Reduza a UMA réplica de session-owner ANTES de reverter.
docker compose -f compose.roles.yml up -d --scale session-owner=1

# 2. Confirme posse única (§6.1): uma row por linha, um único owner_instance.

# 3. Backup lógico.
npm run backup

# 4. Down.
psql "$DATABASE_URL" -f migrations/115_channel_session_lease_fencing_down.sql
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE id = '115_channel_session_lease_fencing.sql'"
```

Ou volte a topologia inteira para `MAIA_PROCESS_ROLE=all` (`compose.prod.yml`),
que é o alvo de rollback documentado da #512 e não exige reverter migration
alguma — as colunas ficam e são ignoradas.

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

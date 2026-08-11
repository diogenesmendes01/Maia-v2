# Runbook — outbox `blocked_channel_unresolved`

**Quando acontece:** a migração 090 (fase 0 do roteamento multi-linha) exige
que toda row ENVIÁVEL do outbox (`pending`/`claimed`) **de kind `whatsapp%`**
tenha `channel_id` (kinds sem linha — `email_alert` — ficam `NULL` livremente).
No backfill, o canal só é derivado quando o agente tem **exatamente um** canal
ativo; rows whatsapp não-deriváveis (zero ou 2+ canais ativos) recebem
`status='blocked_channel_unresolved'` — o drain as ignora. Depois da
migração, um enqueue whatsapp sem canal derivável falha com
`TypedError('channel_ambiguous')` (fail-closed: o sistema nunca escolhe uma
linha sozinho — o chamador precisa passar `channel_id`).

## Diagnóstico

```sql
SELECT id, tenant_id, agent_id, kind, created_at, last_error
  FROM outbox_messages
 WHERE status = 'blocked_channel_unresolved'
 ORDER BY created_at;
```

Para cada (tenant, agent) afetado, liste os canais candidatos:

```sql
SELECT id, channel_type, external_id, display_name, active
  FROM channels
 WHERE tenant_id = $1 AND agent_id = $2;
```

## Resolução

1. Identifique a linha correta para a mensagem (contexto do `payload`).
2. Atribua o canal e reative:

```sql
UPDATE outbox_messages
   SET channel_id = '<uuid do canal>',
       status = 'pending',
       next_attempt_at = now()
 WHERE id = '<uuid da row>';
```

3. Se a mensagem não deve mais sair, finalize sem envio:

```sql
UPDATE outbox_messages SET status = 'dead' WHERE id = '<uuid da row>';
```

**Nunca** desative o CHECK `outbox_sendable_requires_channel` — ele é o
invariante que impede resposta pela linha errada (vazamento entre linhas).

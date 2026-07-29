# Runbook — backup, restore, chaves e privacidade

> Issue #520. Substitui a seção 6 de [`operational.md`](operational.md) como referência de backup/restore. Módulo: [`docs/architecture/modules/ops.md`](../architecture/modules/ops.md).

## 0. O que mudou (leia antes de operar)

"Backup concluído" **não significa mais** que o `pg_dump` terminou. Uma run só é `completed` quando existe cópia off-site **verificada no destino**. Sem isso ela é:

| Estado | O que significa | Ação |
|---|---|---|
| `completed` | Artefato íntegro, cifrado (se exigido) e conferido no destino | Nenhuma |
| `completed_degraded` | Artefato existe e foi verificado LOCALMENTE, mas não há cópia off-site verificada | Investigar; perder o host perde o artefato |
| `failed` | Nenhum artefato utilizável | Agir agora |

Em produção, `local-only` e `upload falhado` são **`failed`**, não degradado.

## 1. Rodar um backup manual

```bash
ssh maia 'cd /opt/maia && npm run backup'
```

Exit codes: `0` completed (ou já rodando, ou desabilitado) · `2` DEGRADED · `1` failed.

O CLI e o cron noturno chamam **o mesmo serviço** e disputam o **mesmo lock global**. Se o cron estiver rodando, o CLI imprime `another backup run holds the lock` e **não** dispara um segundo `pg_dump`.

## 2. Diagnóstico — qual é o estado real?

Toda a evidência está no banco. Nenhuma consulta abaixo devolve caminho, URL ou credencial.

```sql
-- Última run de cada desfecho
SELECT started_at, state, outcome, outcome_reason, artifact_ref,
       destination_kind, remote_verified, error_code
FROM backup_runs ORDER BY started_at DESC LIMIT 10;

-- Último backup RESTAURÁVEL off-site (a resposta ao RPO)
SELECT started_at, remote_verified_at, artifact_ref
FROM backup_runs
WHERE remote_verified ORDER BY remote_verified_at DESC LIMIT 1;

-- Último drill e sua duração (a resposta ao RTO)
SELECT started_at, status, duration_ms, source, probes
FROM restore_drills ORDER BY started_at DESC LIMIT 5;

-- O manifesto assinado de uma run
SELECT manifest_version, manifest_sha256, signature_key_version, manifest
FROM backup_manifests WHERE backup_run_id = '<id>';
```

`backup_runs.error_code` é um **código estável** (`dump_failed`, `catalog_unreadable`, `artifact_too_small`, `encryption_failed`, `promote_failed`, `upload_failed`, `remote_verification_failed`, `manifest_failed`). A stderr crua do `pg_dump` **nunca** é persistida: numa falha de conexão ela contém a `DATABASE_URL` com a senha.

### "O job não roda / não sai do lugar"

Existe no máximo **uma** run não-terminal (índice parcial `backup_runs_single_active_uq`).

**Isso se resolve sozinho.** Toda execução (cron ou CLI) faz um *reclaim* antes de pegar o lock: runs não-terminais mais velhas que **2× `BACKUP_DUMP_TIMEOUT_MS`** são terminalizadas como `abandoned` e auditadas. O corte é o que torna a operação segura — passado esse ponto nenhuma run viva poderia ainda estar em voo, porque o próprio dump é limitado.

Isso cobre SIGKILL, OOM, crash — e o caso do shutdown. `nightly_backup` e `backup_retention` são jobs de cron comuns, então o drain da #512 já os alcança: `runTick` recusa iniciar trabalho novo durante o drain, e o passo `cron_workers` espera o tick em voo. Mas o orçamento do drain é `SHUTDOWN_GRACE_MS` (25s) e um dump pode legitimamente levar até `BACKUP_DUMP_TIMEOUT_MS` (1h), então um backup pego pelo SIGTERM é reportado como `pending` e o processo sai com a row não-terminal. O reclaim da execução seguinte a fecha.

Só intervenha à mão se precisar destravar ANTES de 2× o timeout do dump — e só depois de confirmar que nenhum processo está de fato rodando:

```sql
UPDATE backup_runs
   SET state='failed', outcome='failed', outcome_reason='abandoned',
       error_code='abandoned', finished_at=now()
 WHERE state NOT IN ('completed','completed_degraded','failed','expired','deleted');
```

## 3. Restaurar de verdade (perda do banco)

> **Nunca libere tráfego antes do passo 6.** Um snapshot anterior a uma exclusão **ressuscita** dados que um titular mandou apagar.

1. **Pare o app**: `sudo systemctl stop maia`.
2. **Escolha o artefato** por evidência, não por `ls`:
   ```sql
   SELECT artifact_ref, sha256, encryption_key_id, tombstone_watermark
   FROM backup_runs WHERE remote_verified ORDER BY remote_verified_at DESC LIMIT 1;
   ```
3. **Baixe e verifique** — confira o SHA-256 contra `backup_runs.sha256` (que é o digest do CIPHERTEXT quando o artefato é cifrado) e valide a assinatura do manifesto antes de tocar em qualquer coisa.
4. **Decifre** (se `encryption_mode <> 'none'`): o artefato é um envelope `MBK1`; a chave é resolvida pelo `key_id` gravado no header, então uma chave rotacionada mas ainda presente no keyring funciona.
5. **Restaure**: `pg_restore --no-owner -d maia <arquivo>`; depois `npm run db:migrate` se o schema avançou desde o snapshot (compare `manifest.migration_head`).
6. **Reconcilie os tombstones** — obrigatório:
   - obtenha `tombstone_watermark` do manifesto;
   - liste os tombstones posteriores e reaplique cada exclusão/anonimização;
   - **se o ledger estiver ilegível, o watermark for nulo, ou qualquer linha falhar na verificação HMAC, PARE** — o runtime não pode voltar a produção (`planReconciliation` devolve `ok:false`).
7. **Reconcilie o que não está no dump**: mídia (`/app/media`), Redis/BullMQ e a sessão Baileys **não** vêm no `pg_dump`. Ver §5.
8. **Só então** inicie: `sudo systemctl start maia` e confira `/health/db`.

**Janela de perda**: até 24h (o dump é noturno). Um RPO menor exige PITR/WAL archiving — sub-escopo planejado, não prometido.

## 4. Drill de restore

```bash
ssh maia 'cd /opt/maia && npm run restore:test'
```

Restaura o artefato num banco efêmero, roda probes e derruba o banco em `finally`. O resultado alimenta `restore_drills` e o RTO medido. **Um drill falhado torna a readiness FAIL**: até um drill passar, nenhum artefato é sabidamente restaurável.

> Limitação conhecida nesta fatia: o drill ainda consome o artefato **local** e não faz o download do off-site. Ver "Não entregue" abaixo.

## 5. Dados fora do PostgreSQL

| O quê | Política | Recuperação |
|---|---|---|
| `/app/media` | Volume separado; **não** está no dump | **Decisão pendente** (ver [matriz](../architecture/concerns/data-retention-matrix.md)). Hoje um restore volta sem anexos |
| Sessão Baileys | Segredo operacional; nunca no dump nem em log | **Re-pair**: pare o app, remova o diretório de auth, reinicie e refaça o pareamento. Rotacione/revogue a sessão antiga |
| Redis/BullMQ | Reconstruível; a fonte de verdade é o Postgres | **Não restaure Redis antigo**: reexecutaria side effects já ocorridos. Suba vazio e deixe o outbox relayer reidratar |

## 6. Chaves de criptografia

> Todas as variáveis abaixo são declaradas no contrato de configuração (#515):
> `src/config/contract.ts`, grupo `backup`. Rode `npm run config:check` para
> validar um ambiente inteiro de uma vez — o boot já falha fechado por contrato.

- `BACKUP_ENCRYPTION_KEYRING` = JSON `{ key_id: base64(32 bytes) }`; `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` aponta a chave de cifra.
- **Rotação**: adicione a nova chave ao keyring, troque a ativa, **mantenha a antiga** enquanto existir artefato que a referencie. Retirar cedo demais torna o artefato indecifrável — `verifyDecryptable` reporta `backup_key_unavailable`.
- **Drill de decrypt**: `verifyDecryptable` streama pelo decipher e descarta a saída — prova que a chave existe e a tag confere, sem materializar dado pessoal.
- **Chave indisponível**: o backup **falha fechado**. Não existe fallback plaintext. Restaure o acesso à chave; não desligue a criptografia para "destravar" o job.
- A chave nunca aparece em log, manifesto, métrica ou mensagem de erro — só o `key_id`.

## 7. Retenção, legal hold e LGPD

**A retenção não apaga nada hoje.** `RETENTION_DRY_RUN=true` é o default e, sem uma `RETENTION_POLICY` aprovada pelo DPO, `resolveRetention` devolve `purgeable: false` para todas as classes. Ver a [matriz](../architecture/concerns/data-retention-matrix.md) para as perguntas em aberto e o procedimento de ativação.

### Retenção de artefatos (`backup_retention`, domingos 04:00)

Substituiu o `cloud_backup_rotation`, que selecionava por `LastModified`, engolia falha de chunk e auditava sucesso para passe parcial. O job atual:

- planeja **cada** exclusão a partir de `backup_runs` + `backup_manifests` — nunca por mtime;
- avalia **legal hold** sob o lock de retenção antes de tocar em qualquer coisa; hold ativo em QUALQUER tenant congela todos os artefatos, porque um dump é um contêiner dos dados de todos;
- **confirma** cada exclusão (delete que "deu certo" mas não apagou conta como falha);
- audita desfecho **conclusivo**: `retention_run_completed` só quando nada falhou, senão `retention_run_failed` + alerta.

```sql
-- Passes de retenção e o que cada um fez
SELECT started_at, data_class, dry_run, status, scanned, eligible,
       deleted, skipped_held, failed, error_code, cursor_watermark
FROM retention_runs ORDER BY started_at DESC LIMIT 10;
```

`skipped_held > 0` é o legal hold funcionando. `status='partial'` é retomável — o `cursor_watermark` diz onde recomeçar.

**Artefatos sem manifesto** (`unidentified` na auditoria) NÃO são apagados: sem manifesto não dá para provar o que o arquivo é, e apagar no chute é exatamente o defeito que o mtime causava. Artefatos anteriores à #520 caem aqui e precisam ser aposentados à mão, depois de conferidos.

O único lugar onde mtime sobrevive é a varredura de `.partial` órfão — que por construção não tem manifesto e não é backup, e sim resíduo de uma run que morreu.

**Legal hold** — criação e liberação exigem papel e são auditadas. Um hold ativo bloqueia o purge aplicável; a liberação **não** dispara exclusão, apenas permite reavaliação.

**Solicitação LGPD** — o pedido é persistido por tenant, a identidade é verificada **fora do LLM** (o banco recusa avançar sem o carimbo humano — `privacy_requests_identity_chk`), e um export só existe com prazo de expiração. O LLM nunca autoriza nem executa exclusão.

## 8. Rollback

- Desabilite os jobs novos (`BACKUP_ENABLED=false` fora de produção; em produção pause o worker) — **não** derrube as tabelas.
- **Preserve** `backup_manifests`, `data_tombstones` e `legal_holds`. Derrubar tombstones e depois restaurar um snapshot antigo é um incidente de privacidade, não um rollback.
- Não faça downgrade que perca a capacidade de decifrar artefatos existentes.
- Na dúvida sobre retenção: `RETENTION_DRY_RUN=true` e pare.

## 9. Não entregue nesta fatia

Registrado aqui para que ninguém opere com expectativa errada:

- O drill (`npm run restore:test`) ainda usa o dump **local** mais recente e não baixa/decifra o artefato off-site nem escreve em `restore_drills`.
- O executor de retenção existe para a classe `backup.artifact` (job `backup_retention`, §7). Para as DEMAIS classes de dado — mensagens, mídia, memória, traces — só existem o mecanismo de decisão e o schema; não há job que os varra.
- O workflow de execução das solicitações de privacidade ainda não existe — só o schema e os invariantes de banco.
- A reconciliação de tombstones pós-restore é **manual** (passo 3.6): o planejador e o gate estão implementados e testados, mas não há job que os execute automaticamente.
- Backup próprio de mídia e da sessão Baileys: política declarada, mecanismo não implementado.

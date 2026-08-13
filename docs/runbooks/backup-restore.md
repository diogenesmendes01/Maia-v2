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

E o drill de restore **roda sozinho e reprova quando envelhece** (issue #536): o job `restore_drill` acorda de hora em hora, dispara um drill quando a evidência em `restore_drills` está perto de vencer, e `/metrics` expõe o veredito continuamente em `maia_restore_drill_check_level`. `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` é a **idade máxima aceitável da evidência**, não um agendamento — §4.3.

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

-- Último drill e sua duração (a resposta ao RTO). `cleanup_status` é um eixo
-- SEPARADO do `status`: 'unsafe' significa cópia da produção deixada no host (§4.1)
SELECT started_at, status, cleanup_status, duration_ms, source, probes
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
   - Antecipe esse número: o último drill já mediu quantos tombstones este artefato deveria reaplicar (`restore_drills.tombstones_pending`, §4). Se o drill mais recente do mesmo artefato falhou com `reconciliation_blocked`, o restore vai parar aqui — resolva o ledger **antes** de derrubar o banco.
7. **Reconcilie o que não está no dump**: mídia (`/app/media`), Redis/BullMQ e a sessão Baileys **não** vêm no `pg_dump`. Ver §5.
8. **Só então** inicie: `sudo systemctl start maia` e confira `/health/db`.

**Janela de perda**: até 24h (o dump é noturno). Um RPO menor exige PITR/WAL archiving — sub-escopo planejado, não prometido.

## 4. Drill de restore

```bash
ssh maia 'cd /opt/maia && npm run restore:test'
```

Exit codes: `0` passou (ou já rodando, ou backups desabilitados) · `1` falhou — inclusive quando o restore provou e o **host ficou sujo** (§4.1).

O drill **não** pega "o dump mais novo do diretório". Ele escolhe por evidência e prova cada etapa (issue #536, [`src/ops/backup/drill.ts`](../../src/ops/backup/drill.ts)):

1. **seleciona** a run mais recente que tenha manifesto assinado E cópia verificada no destino (`selectDrillCandidate`, [`src/db/repositories/ops-repos.ts`](../../src/db/repositories/ops-repos.ts));
2. **verifica a versão e a assinatura do manifesto** — um manifesto v1 é recusado com `manifest_version_unsupported`, porque em v1 `remote_checksum_verified` podia ser verdade só porque o carimbo do próprio uploader voltou no `HEAD`;
3. **baixa o artefato off-site** e casa os bytes que chegaram com o digest do manifesto;
4. **decifra** e casa o PLAINTEXT com `manifest.sha256` — conferência que nenhuma outra parte do sistema faz;
5. **restaura** num banco efêmero isolado (`maia_drill_<stamp>_<id do drill>` — o discriminador existe pelo mesmo motivo que o do artefato na #520: dois drills no mesmo segundo colidiriam, e uma colisão aqui restauraria dentro de um banco velho e reportaria falso positivo);
6. roda a **suíte de probes** ([`drill-probes.ts`](../../src/ops/backup/drill-probes.ts)): tabelas críticas presentes, seed de tenant/agent, escopo de tenant válido, integridade `mensagens→conversas`, ledger de tombstones restaurado, `transacoes` e `audit_logs` legíveis; mais dois informativos (outbox despachável, divergência de migration head);
7. roda a **reconciliação de tombstones em dry-run** e avalia o gate `canReleaseTraffic` — é isso que transforma "o `pg_restore` saiu 0" em "este artefato poderia voltar à produção";
8. derruba o banco e apaga cada arquivo estagiado **em `finally`**, e **prova** que sumiram: consulta `pg_database` pelo nome do banco efêmero e o filesystem por cada arquivo, **depois** de remover;
9. grava tudo em `restore_drills` (inclusive a falha e qualquer resíduo) e audita.

**Fail-closed em cada passo.** Sem candidato, manifesto irrecuperável, checksum que não casa, probe obrigatório falhando, plano de reconciliação `ok:false` **ou teardown que não se provou** ⇒ drill `failed`. **Qualquer drill falhado torna a readiness FAIL** — inclusive o `cleanup_failed`, que não é "nada é restaurável" e sim "é restaurável, e sobrou uma cópia da produção no host" (§4.1). A readiness é deliberadamente conservadora aqui: ela lê só o `status`; quem diz qual dos dois aconteceu é a linha em `restore_drills`.

Se o perfil **exige** off-site (`BACKUP_OFFSITE_REQUIRED`), drillar a cópia local **não** conta: o drill falha com `no_offsite_candidate`. O artefato que importa depois de perder o host é o remoto, e só buscá-lo prova que ele é legível, decifrável e inteiro.

### 4.1 O vocabulário de status (leia antes de interpretar um drill)

`passed` significa **duas** coisas provadas, não uma: o artefato é restaurável **e** o host ficou limpo. São dois eixos independentes na mesma linha de `restore_drills`:

| `status` | `failure_code` | `cleanup_status` | O que aconteceu, e o que fazer |
|---|---|---|---|
| `passed` | `null` | `clean` | Certificado. Nada a fazer. |
| `failed` | `cleanup_failed` | `unsafe` | **Restore bem-sucedido com resíduo inseguro.** O artefato *é* restaurável — download, checksum, decifragem, `pg_restore`, probes e reconciliação passaram — mas o drill não conseguiu provar que removeu o que criou. Há (ou pode haver) uma cópia completa da produção neste host. **Vá removê-la** (§4.2). |
| `failed` | qualquer código de restore | `clean` | Nada é sabidamente restaurável. O host está limpo. Investigue o backup. |
| `failed` | qualquer código de restore | `unsafe` | Os dois problemas juntos, e nenhum esconde o outro: o `failure_code` é o diagnóstico do **restore**, o `cleanup_status` é o estado do **host**. Duas remediações diferentes. |
| `skipped` | `backups_disabled` | `clean` | O único não-veredito legítimo. A readiness ignora. |
| `running` | — | `unknown` | O processo morreu no meio. **Ninguém conferiu** — trate como resíduo possível (§4.2). |

Por que `cleanup_failed` não é "só mais um código de falha": um drill verde que deixa uma cópia da produção para trás é **pior** que um drill vermelho, porque ensina o operador a confiar num sinal nocivo. Até a PR #541 o teardown só logava, e o drill terminava `passed` com o banco efêmero de pé. Por isso, também, o resíduo é **auditado numa ação própria** (`restore_drill_unsafe_residue`) e dispara um **alerta próprio**, com assunto diferente do alerta de "nada é restaurável": as duas emergências pedem ações opostas.

### 4.2 Resíduo: como achar e remover

O drill nunca imprime o caminho nem o nome do banco (esses textos vão para log de operador e transcript de CI). Os `kind` do resíduo mapeiam assim:

| `kind` | Onde está | Como remover |
|---|---|---|
| `drill_database` | Um banco no mesmo cluster, nome `maia_drill_<stamp>_<12 hex do drill_id>` | `psql -d postgres -c 'DROP DATABASE "<nome>" WITH (FORCE)'` |
| `decrypted_plaintext` | `BACKUP_DIR/restore-drill/<backup_id>.plain` — **dados de todos os tenants em claro**. Também é este o `kind` do `.artifact` quando o perfil roda com `encryption.mode='none'`: aí a cópia "como armazenada" já é o dump em claro | `shred -u` (ou `rm`) o arquivo |
| `staged_artifact` | `BACKUP_DIR/restore-drill/<backup_id>.artifact` — cópia cifrada baixada do off-site | `rm` o arquivo |

`reason` diz o que se sabe: `removal_failed` (a remoção deu erro), `still_present` (a remoção **reportou sucesso** e o recurso continua lá) ou `unverified` (não foi possível provar a ausência). Os três exigem a mesma ação — alguém precisa ir olhar.

**Um download interrompido também deixa resíduo, e ele É inventariado.** O drill reivindica o caminho de staging **antes** de chamar o fetch, não depois que ele retorna (`src/ops/backup/drill.ts`, §"OWNERSHIP IS REGISTERED BEFORE THE FETCH"). Isso importa porque `downloadBackupObjectToFile` abre o destino com `wx` — o arquivo passa a existir no momento da abertura — e um stream que morre no meio deixa bytes lá. Até a review round-2 da PR #541 o registro acontecia só no retorno do fetch, então um `artifact_fetch_failed` varria um inventário vazio e o drill terminava `failed` + `cleanup_status='clean'`: uma certificação de host limpo com um dump parcial da produção no workspace, sem auditoria de resíduo e sem alerta. Hoje esse caso aparece como `staged_artifact` (ou `decrypted_plaintext`, se o perfil não cifra) com o `reason` correspondente.

```sql
-- Drills com resíduo (índice parcial restore_drills_unsafe_idx)
SELECT id, started_at, status, failure_code, probes->'cleanup' AS cleanup
FROM restore_drills WHERE cleanup_status = 'unsafe' ORDER BY started_at DESC;

-- Drills que morreram no meio: ninguém conferiu o teardown.
-- Este é o estado que BLOQUEIA o próximo drill (§4.3): `unknown` significa
-- "resíduo possível, ninguém conferiu", e o corte abaixo tem que casar com o
-- do código (2× (upload + restore), piso de 1h — 3h nos defaults).
SELECT id, started_at, status, cleanup_status FROM restore_drills
WHERE status NOT IN ('passed', 'failed', 'skipped')
ORDER BY started_at;
```

```bash
# Bancos efêmeros de drill que sobraram no cluster, de qualquer época
psql -d postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) \
  FROM pg_database WHERE datname LIKE 'maia\_drill\_%'"
# Arquivos estagiados que sobraram
ls -la "$BACKUP_DIR/restore-drill/"
```

Depois de limpar, rode o drill de novo: a linha antiga fica como evidência (é append-only), e o que a readiness lê é o drill mais recente.

```sql
-- O último drill, com o detalhe dos probes
SELECT started_at, source, status, duration_ms, failure_code, cleanup_status,
       tombstones_pending, probes
FROM restore_drills ORDER BY started_at DESC LIMIT 5;
```

`tombstones_pending > 0` num drill que passou é **normal e informativo**: é quanto um restore real ainda deveria reaplicar antes de liberar tráfego (§3.6). `probes->'reconciliation'->>'release_without_replay'` é o veredito do gate com nada reaplicado.

Códigos de falha (estáveis, seguros para log e métrica): `backups_disabled`, `no_drill_candidate`, `no_offsite_candidate`, `manifest_version_unsupported`, `manifest_unverifiable`, `artifact_fetch_failed`, `artifact_checksum_mismatch`, `decryption_failed`, `plaintext_checksum_mismatch`, `isolation_failed`, `restore_failed`, `probe_failed`, `reconciliation_blocked`, `cleanup_failed` (§4.1 — o único que significa "o artefato é restaurável, mas o host não está limpo"), `drill_not_recorded`, `unexpected`.

**Requisitos operacionais.** O drill precisa de (a) `pg_restore` no host, (b) permissão de `CREATE DATABASE`/`DROP DATABASE` no cluster, (c) espaço em `BACKUP_DIR/restore-drill` para o artefato baixado **e** o plaintext decifrado. Esse diretório contém, enquanto o drill roda, uma cópia **em claro** dos dados de todos os tenants — ele fica sob `BACKUP_DIR` de propósito (permissões e disco que o operador já trata como sensíveis), nunca em `/tmp`. Se faltar qualquer uma das três, o drill termina com `cleanup_status = 'unsafe'` e **não** certifica nada: os logs `restore_drill.database_not_dropped` / `restore_drill.staged_file_not_removed` carregam o `kind` e o `reason`, e §4.2 diz o que remover.

### 4.3 O agendamento e o gate (issue #536)

**O drill roda sozinho.** O job `restore_drill` ([`src/workers/index.ts`](../../src/workers/index.ts)) acorda **de hora em hora** (`40 * * * *`, phase 1) e chama `runScheduledRestoreDrill()` ([`src/workers/backup.ts`](../../src/workers/backup.ts)).

**A cadência do cron não é o intervalo, e isso é de propósito.** `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` é a **idade máxima aceitável da evidência**, não um agendamento. Derivar um cron dele seria uma segunda fonte da verdade e re-executaria um drill por relógio, mesmo com um drill recém-aprovado. Em vez disso o tick lê `restore_drills` e decide ([`src/ops/backup/drill-schedule.ts`](../../src/ops/backup/drill-schedule.ts)):

| Estado da evidência | O que o tick faz |
|---|---|
| Mais nova que **75%** do intervalo | **Nada.** Um drill custa um download de gigabytes, um banco efêmero e uma cópia em claro da produção no disco enquanto roda |
| Passou de 75% do intervalo | Dispara o drill. 75% é a **mesma fração** em que `rpo.ts` levanta o WARN: o drill começa quando a readiness fica âmbar e termina antes de ficar vermelha |
| Último drill **falhou**, e passou de **12,5%** do intervalo | Dispara de novo. Janela própria e mais curta: boa parte das falhas é transitória, e esperar 75% manteria a plataforma em FAIL por dias por causa de um soluço |
| **Nunca rodou** | Dispara — e a evidência já conta como **vencida**. Ausência de evidência não é evidência de backup restaurável |
| Existe drill **não-terminal** mais novo que o corte de abandono | **Nada** — há drill em curso (`drill_in_flight`). Não é alarme: o lock recusaria um segundo de qualquer jeito |
| Existe drill **não-terminal** mais velho que o corte de abandono | **Recusa** e loga `restore_drill.blocked_by_abandoned_drill` em nível error; a gate vai a **FAIL mesmo com evidência terminal fresca**. O processo morreu com uma cópia em claro da produção possivelmente no host, e ninguém conferiu (§4.4) |
| Último drill deixou **resíduo** (`cleanup_status='unsafe'`) | **Recusa** e loga `restore_drill.blocked_by_residue` em nível error. Outro drill faria uma **segunda** cópia em claro da produção em vez de provar coisa alguma. Limpe o host (§4.2) e o próximo tick volta a drillar |
| `BACKUP_ENABLED=false` | Nada. Não há o que drillar |

**Single-flight.** O tick chama `runRestoreDrillJob()`, que disputa o lock `maia_ops_restore_drill`. CLI (`npm run restore:test`), outra réplica e o tick da hora anterior nunca correm juntos — quem perde loga `restore_drill.tick_already_running` e não inicia nada.

**Envelhecer REPROVA — este é o gate.** Toda vez que o tick roda ele grada a evidência por `evaluateBackupReadiness` e loga o veredito no nível correspondente (`restore_drill.evidence_ok` / `.evidence_aging` / `.evidence_expired`). E, independente do worker, `/metrics` expõe o veredito continuamente:

| Série | Significado |
|---|---|
| `maia_restore_drill_check_level` | **O gate.** 0 = um drill recente provou um artefato restaurável; 1 = envelhecendo; 2 = **reprovado** (evidência vencida, último drill falhou, nunca rodou em production, ou a evidência não pôde ser lida) |
| `maia_restore_drill_age_seconds` | Idade do drill terminal mais recente. **`-1`** quando nunca houve um: `0` leria como "acabou de rodar", a mentira mais perigosa que uma série de idade pode contar, e idade negativa é impossível (logo, inerte a qualquer alerta `> limiar`) |
| `maia_backup_readiness_level` | O veredito agregado de backup (RPO local/off-site, falhas consecutivas, cifra, viabilidade do RPO) |

O coletor ([`src/observability/backup-readiness-collector.ts`](../../src/observability/backup-readiness-collector.ts)) lê a evidência **no scrape**, não de um valor que o worker publica: se o `restore_drill` parar de rodar, um gauge publicado por ele congelaria no último valor (verde) — que é exatamente a falha que o gate existe para pegar. Pelo mesmo motivo, uma leitura que **falha** derruba o snapshot em vez de reservir o último verde.

**Alertas** ([`monitoring/alerts/backup.rules.yml`](../../monitoring/alerts/backup.rules.yml)):

| Alerta | Dispara | O que o operador faz |
|---|---|---|
| `RestoreDrillEvidenceNotProvable` | `maia_restore_drill_check_level >= 2` por 30min | **Nada é sabidamente restaurável.** Descubra qual dos quatro casos é em `restore_drills` (`ORDER BY started_at DESC LIMIT 5`) — vencido, falhou, nunca rodou, ou evidência ilegível — e siga §4.1: `cleanup_failed` e os demais códigos pedem ações OPOSTAS |
| `RestoreDrillEvidenceAging` | `maia_restore_drill_check_level == 1` por 6h | O agendador deveria ter renovado a evidência aos 75% e não renovou. Confira se o job `restore_drill` está agendado (log `worker.scheduled`) e se o último drill deixou resíduo — resíduo BLOQUEIA o próximo drill de propósito (§4.2) |


### 4.4 O drill que morreu no meio (issue #536, review da #553)

Um drill que caiu entre `createDrill` e `finishDrill` deixa a linha em `status='running'`, `cleanup_status='unknown'` — que pelo contrato do §4.1 significa **"resíduo possível, ninguém conferiu"**. Três coisas o tornavam perigoso e as três estão fechadas:

1. **O restart NÃO protege.** O `maia_ops_restore_drill` é advisory lock de **sessão**: o processo morto levou o lock junto, e o worker reiniciado o pega sem contenção. Nada mais sobrevive ao crash para recusar o segundo drill.
2. **Os fatos enxergam a linha.** `readReadinessFacts` devolve `open_restore_drill_started_at` — o **mais antigo** drill não-terminal (com um vivo e um cadáver, o cadáver é o que importa). É campo **novo**: os quatro `last_restore_drill_*` continuam descrevendo o último drill TERMINAL, porque é deles que sai o RPO/RTO.
3. **O gate fica vermelho mesmo com evidência fresca.** `maia_restore_drill_check_level` vai a 2, então `RestoreDrillEvidenceNotProvable` dispara. Sem isso, um drill aprovado ontem pintava OK por dias com uma cópia da produção parada no host.

**O corte de abandono.** `2 × (BACKUP_UPLOAD_TIMEOUT_MS + BACKUP_RESTORE_TIMEOUT_MS)`, com piso de 1h — **3h nos defaults**. É a mesma regra de "duas vezes o orçamento" que o `reclaimAbandonedRuns` já aplica a `backup_runs`: passado esse ponto nenhuma execução legítima poderia ainda estar rodando. Os dois estágios somados são os que o profile realmente limita (o download do off-site não tem knob próprio). Abaixo do corte é `drill_in_flight`; acima é cadáver.

**Como destravar** (o bloqueio é intencionalmente indefinido até um humano agir — é uma cópia em claro dos dados de todos os tenants):

1. ache a linha com a consulta de §4.2 (`status NOT IN ('passed','failed','skipped')`);
2. procure o resíduo daquele drill — banco `maia_drill_%` e arquivos em `BACKUP_DIR/restore-drill/` — e remova o que achar (§4.2);
3. **feche a linha**, que é o que o scheduler lê:

```sql
UPDATE restore_drills
   SET status = 'failed', finished_at = now(), failure_code = 'unexpected',
       cleanup_status = 'clean'   -- só depois de VERIFICAR o host
 WHERE id = '<id>';
```

Fechar como `failed` é honesto: aquele drill não provou nada. A partir daí vale a janela de **retry** (12,5% do intervalo, ~21h no semanal), não a de refresh. Se você não conseguiu provar que o host está limpo, feche com `cleanup_status='unsafe'` — aí o bloqueio continua, pela outra regra, que é o que se quer.

**Por que isto não está no `/readyz`.** Um drill vencido não torna a réplica incapaz de atender uma requisição, e `/readyz` decide roteamento de tráfego. Reprovar lá derrubaria a plataforma por um problema de evidência de backup — um outage causado pelo monitor. A superfície certa para "nossa postura de recuperação não é demonstrável" é a readiness operacional: o gauge, o alerta e a linha de log por tick.

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

### 6.1 Chave de ASSINATURA do manifesto (HMAC) — outra chave, outra rotação

A chave que **cifra** o artefato (`BACKUP_ENCRYPTION_KEYRING`, acima) não é a que **assina o manifesto**. A assinatura usa o mesmo material HMAC da auditoria — `RUNTIME_TRACE_HMAC_MASTER_SECRET` + `RUNTIME_TRACE_HMAC_KEY_VERSION` — porque ele já vive **fora** do artefato, que é o requisito da issue §5. O envelope grava qual versão assinou, em `backup_manifests.signature_key_version`.

**Ao rotacionar (política de 90 dias), retenha o segredo anterior — pelo menos enquanto existir recovery point dentro da retenção.**

```bash
# Antes: RUNTIME_TRACE_HMAC_KEY_VERSION=1, MASTER_SECRET=<v1>
RUNTIME_TRACE_HMAC_KEY_VERSION=2
RUNTIME_TRACE_HMAC_MASTER_SECRET=<v2>
RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS='1=<v1>'   # formato versao=segredo;versao=segredo
```

A verificação resolve a chave **pela versão que o envelope declara** (`src/ops/backup/manifest-keyring.ts`, que reutiliza o keyring de `src/control-plane/runtime-trace/lib/hmac.ts` — um parser só, para os dois consumidores). Um backup assinado com a v1 continua verificável depois da rotação para a v2.

**Sintoma de ter retirado o segredo anterior cedo demais:** o drill falha com `manifest_unverifiable` em artefatos que estão intactos no disco e dentro da retenção. O que distingue esse caso de um manifesto adulterado é o log — mesmo `failure_code`, `reason` diferente (o código é deliberadamente único: um verificador não é oráculo para atacante):

```bash
# "esta instalação não tem mais a chave" → recoloque o segredo em PREV_MASTER_SECRETS
grep restore_drill.manifest_unverifiable <log> | grep key_version_unknown
# "a assinatura não bate com o conteúdo" → investigue adulteração, NÃO mexa em chave
grep restore_drill.manifest_unverifiable <log> | grep signature_mismatch
```

O log carrega o `signature_key_version` declarado (um inteiro, não-sensível), então dá para casar direto com a linha em `backup_manifests`:

```sql
SELECT r.id, r.finished_at, m.signature_key_version
  FROM backup_runs r JOIN backup_manifests m ON m.backup_run_id = r.id
 WHERE r.state IN ('completed','completed_degraded')
 ORDER BY r.finished_at DESC LIMIT 20;
```

Versão desconhecida **falha fechado**: nunca há fallback para "tenta com a chave atual". Um fallback esconderia o diagnóstico real e ainda aceitaria um envelope que renomeou a própria versão de chave.

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

- O executor de retenção existe para a classe `backup.artifact` (job `backup_retention`, §7). Para as DEMAIS classes de dado — mensagens, mídia, memória, traces — só existem o mecanismo de decisão e o schema; não há job que os varra.
- O workflow de execução das solicitações de privacidade ainda não existe — só o schema e os invariantes de banco. (Issue #536, eixo 2.)
- A **reaplicação** de tombstones pós-restore continua manual (passo 3.6). O drill agora executa `planReconciliation` e `canReleaseTraffic` em **dry-run** contra o snapshot restaurado, então a proteção deixou de depender de alguém lembrar de *avaliar* — mas não existe executor que *reaplique* as exclusões, porque reaplicar exige o mesmo mecanismo de exclusão por classe que o eixo 2 vai construir. (Issue #536, eixo 3.)
- Backup próprio de mídia e da sessão Baileys: política declarada, mecanismo não implementado. (Issue #536, eixo 4.)
- O drill **prova** o próprio teardown (§4.1), mas não varre resíduo de execuções **anteriores**: um banco `maia_drill_%` deixado por um drill que morreu antes de conferir continua lá até alguém rodar as consultas de §4.2. Não existe sweeper — e ele teria que distinguir "resíduo" de "drill em andamento", o que só o lock `maia_ops_restore_drill` responde com segurança.
- Os adapters reais (`pg_dump`, `pg_restore`, `link(2)`, `HeadObject`/`GetObject`) continuam cobertos apenas por fakes e pela suíte de integração; falta a passada em staging contra Postgres e S3 de verdade.

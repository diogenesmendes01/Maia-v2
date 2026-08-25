# Runbook — TTL do export de privacidade

> O pacote cifrado que um pedido de acesso entrega ao titular tem prazo, e o
> prazo é EXECUTADO. Este runbook cobre o varredor que o executa: como ele
> decide, o que fazer quando ele recusa, e como mudar o prazo.

| | |
|---|---|
| Issue | #536 (decisão do dono sobre o TTL) |
| Migration | `migrations/118_privacy_export_purge.sql` |
| Código | `src/ops/privacy/export-sweeper.ts` · `src/ops/privacy/export-locator.ts` · `src/ops/privacy/export-sweeper-adapters.ts` |
| Job | `privacy_export_sweep`, cron `50 * * * *` (`src/workers/index.ts`) |
| CLI | `npm run privacy:export -- sweep [--dry-run]` · `npm run privacy:export -- show --request=<uuid>` |
| Configuração | `PRIVACY_EXPORT_TTL_DAYS` (default `7`) · `PRIVACY_EXPORT_SWEEP_DRY_RUN` (default `false`) |
| Auditoria | `privacy_export_purged` · `privacy_export_purge_refused` · `retention_run_started/completed/failed` com `data_class='privacy.export'` |

## 1. O que mudou, e por quê

Antes desta entrega, `executePrivacyRequest` gravava `export_locator` e
`export_expires_at` e parava aí. **O prazo existia no banco; o `.enc` continuava
no disco para sempre.** Um pacote cifrado com o dado consolidado de um titular,
sem prazo real, é um vazamento com deadline infinito — e mais fácil de esquecer
que o comum, porque a coluna dá a impressão de que alguém já cuidou disso.

Agora:

- **sete dias** é a política inicial, em `PRIVACY_EXPORT_TTL_DAYS`;
- um **varredor idempotente** remove o `.enc` vencido, de hora em hora;
- cada remoção é **auditada** (`privacy_export_purged`);
- o **path/locator é validado antes de apagar**, e uma recusa é auditada
  (`privacy_export_purge_refused`), nunca silenciosa;
- **legal hold bloqueia** a varredura;
- o pedido passa a **indicar artefato expirado** na leitura.

## 2. Como o varredor decide

Por artefato, nesta ordem (a ordem é contrato — ver o cabeçalho de
`export-sweeper.ts`):

| Situação | Decisão | Contador |
|---|---|---|
| `export_purged_at` já preenchido | mantém — `already_purged` | — |
| legal hold ativo | mantém — `legal_hold` | `skipped_held` |
| `export_expires_at` nulo (viola o CHECK da 102) | mantém — `no_expiry_set` | — |
| ainda dentro do prazo | mantém — `not_expired` | — |
| vencido | **remove** | `eligible` → `purged` |

Hold vem **antes** do prazo de propósito: quem lê a evidência precisa ver
`legal_hold`, e não `not_expired`, num artefato congelado que por acaso ainda
está dentro da janela.

**Quais holds congelam o export.** O varredor avalia `privacy.export` *mais*
todas as classes de escopo de titular (`postgres.messages`, `postgres.people`,
…) e o curinga `*`. Um hold sobre as mensagens do titular alcança o pacote que
as empacotou: a cópia entregue é material responsivo tanto quanto a origem.

> **Consequência operacional a acompanhar.** Um hold indefinido sobre um titular
> mantém o `.enc` dele no disco indefinidamente. É a direção recuperável
> (destruir sob hold não tem conserto; conservar tem), mas significa que um hold
> aberto e esquecido vira um artefato eterno. A consulta do §5 lista esses casos.

## 3. Como o varredor não apaga a coisa errada

O alvo vem do **banco**, e uma linha de banco é entrada não confiável para uma
chamada de `rm`. Quatro camadas, em `export-locator.ts`, todas antes da remoção:

1. **forma** — o locator tem que ser o UUID que `sealExport` emite. Separador,
   `..`, caminho absoluto, letra de unidade e caractere de controle são recusas
   *estruturais*, e vêm antes da recusa de forma, para que o código auditado
   nomeie o pior fato verdadeiro sobre o alvo;
2. **contenção** — o caminho resolvido tem que ser filho **direto** da raiz de
   exports, provado por identidade e não por `startsWith`;
3. **inode** — `lstat` (nunca `stat`): não pode ser symlink, tem que ser arquivo
   regular, e não pode ter outro hard link. Depois, o `realpath` do alvo tem que
   cair dentro do `realpath` da raiz;
4. **binding** — releitura da linha no instante da remoção: o locator ainda é
   **deste** pedido, neste escopo? Entre planejar e apagar a linha pode ter
   mudado.

Qualquer uma que falhe é **recusa auditada**, e o arquivo **não é tocado**.

## 4. O varredor recusou. E agora?

**Você provavelmente chegou aqui por um alerta.** A regra
`privacy_export_locator_refused` (`src/workers/audit-watcher.ts`) dispara com
**uma única** ocorrência em 60 min, e não com três: a taxa normal desta ação é
**zero**, então agrupá-la por volume esconderia o primeiro evento — que é o único
que importa. A severidade é `urgent` e não `critical` porque **nada foi apagado**:
o guarda recusou antes da remoção. O que existe é uma linha de banco para
investigar antes que alguém a "conserte" no braço.

```sql
SELECT created_at, metadata->>'privacy_request_id' AS pedido,
       metadata->>'reason'                        AS motivo,
       metadata->>'export_locator_sample'         AS amostra
  FROM audit_log
 WHERE acao = 'privacy_export_purge_refused'
 ORDER BY created_at DESC
 LIMIT 50;
```

| `reason` | O que aconteceu | O que fazer |
|---|---|---|
| `path_separator`, `parent_traversal`, `absolute_path`, `drive_letter`, `control_character`, `not_an_export_locator` | `privacy_requests.export_locator` carrega algo que não é um locator desta plataforma. **Trate como incidente**: ou uma escrita defeituosa, ou uma linha plantada | Não conserte a linha "no braço" antes de entender a origem. Confira `audit_log` do pedido, e o `updated_at`/`created_at` da linha |
| `symlink`, `not_a_regular_file` | O caminho existe mas não é o arquivo que o banco diz que é | Inspecione o diretório de exports à mão. Alguém (ou algo) mexeu nele |
| `multiply_linked` | Existe **outro nome** para os mesmos bytes. Apagar o nosso destruiria o rastro e não o dado | Ache o outro link (`find <BACKUP_DIR> -samefile <arquivo>`), remova-o, e rode o varredor de novo |
| `locator_not_bound_to_request`, `request_vanished` | A linha mudou entre planejar e apagar | Normalmente benigno (uma corrida). Se repetir, procure quem está escrevendo em `privacy_requests` fora do fluxo |
| `root_unresolvable` | O diretório de exports não existe ou não é acessível | Confira `BACKUP_DIR` e o volume montado. **Fail-closed**: nada é apagado enquanto a raiz não é provável |
| `delete_unconfirmed` | A remoção disse que deu certo e o arquivo continua lá | Permissão, volume read-only, ou FS com problema. O pedido **não** foi marcado como varrido, de propósito |

Um passe com qualquer recusa termina `partial` ou `failed` — **nunca**
`completed`. A linha em `retention_runs` (`data_class='privacy.export'`) registra
isso.

## 5. Consultas de plantão

```sql
-- Artefatos vencidos ainda no disco (a fila do varredor).
SELECT id, tenant_id, export_expires_at
  FROM privacy_requests
 WHERE export_locator IS NOT NULL
   AND export_purged_at IS NULL
   AND export_expires_at <= now()
 ORDER BY export_expires_at ASC;

-- Passes que começaram e nunca terminaram (processo morto no meio).
-- O claim é gravado DEPOIS do guarda, então uma recusa NÃO aparece aqui — este
-- predicado é só sobre "estávamos prestes a remover e não voltamos".
-- A execução seguinte retoma sozinha; uma linha ANTIGA aqui é sinal de que o
-- varredor parou de rodar.
SELECT id, export_purge_started_at
  FROM privacy_requests
 WHERE export_purge_started_at IS NOT NULL
   AND export_purged_at IS NULL;

-- Últimos passes.
SELECT started_at, status, scanned, eligible, deleted, skipped_held, failed, error_code
  FROM retention_runs
 WHERE data_class = 'privacy.export'
 ORDER BY started_at DESC LIMIT 20;

-- Artefatos congelados por hold (a lista do aviso do §2).
SELECT r.id, r.export_expires_at, h.id AS hold_id, h.case_reference
  FROM privacy_requests r
  JOIN legal_holds h
    ON h.tenant_id = r.tenant_id AND h.agent_id = r.agent_id
   AND h.status = 'active'
   AND (h.subject_ref IS NULL OR h.subject_ref = r.subject_ref)
 WHERE r.export_locator IS NOT NULL
   AND r.export_purged_at IS NULL
   AND r.export_expires_at <= now();
```

## 6. Consultar um pedido

```bash
npm run privacy:export -- show --request=<uuid>
```

O estado do artefato vem de um vocabulário fechado:

| Estado | Significa | O locator é devolvido? |
|---|---|---|
| `none` | O pedido nunca emitiu export | — |
| `available` | Dentro do prazo | **sim** |
| `expired` | O prazo venceu; o varredor ainda pode não ter passado | **não** |
| `purged` | O `.enc` foi removido e a ausência foi provada | **não** |

`expired` retém o locator de propósito: entre o vencimento e a passagem do
varredor o arquivo **ainda existe**, e entregá-lo nessa janela furaria o próprio
TTL. Reemitir exige um **novo** pedido de acesso.

## 7. Rodar um passe à mão

```bash
npm run privacy:export -- sweep --dry-run   # só conta
npm run privacy:export -- sweep             # executa
```

O `--dry-run` é override **por chamada** — ele não mexe em
`PRIVACY_EXPORT_SWEEP_DRY_RUN` e portanto não muda o comportamento do cron.

O passe é single-flight (`maia_ops_privacy_export_sweep`). Perder a corrida
imprime `outro passe de varredura detém o lock` e **não é erro**: o outro passe
está fazendo o trabalho.

Teto de 500 artefatos por passe. Com a cadência horária isso escoa 12 mil por
dia; o restante sai nos passes seguintes, sempre do mais exposto para o menos.

## 8. Mudar o prazo (o DPO pediu outro número)

1. registre a decisão em
   [`docs/architecture/concerns/data-retention-matrix.md`](../architecture/concerns/data-retention-matrix.md);
2. mude `PRIVACY_EXPORT_TTL_DAYS` no `.env` do serviço e reinicie
   (`restartRequired: true`);
3. confira com `npm run config:check -- --profile production --env-file .env`.

**O prazo vale na EMISSÃO.** Ele é carimbado em `export_expires_at` no momento em
que o export é selado, e é esse carimbo que o varredor honra — nunca a
configuração atual. Um prazo aplicado retroativamente mudaria, debaixo do
titular, a janela que já lhe foi comunicada.

Consequência: **reduzir** o prazo não encurta os exports já emitidos. Se a
redução precisar valer para eles, é uma operação deliberada de dado:

```sql
-- Faça isto SÓ com decisão registrada do DPO. É irreversível na prática:
-- depois do próximo passe o artefato não existe mais.
UPDATE privacy_requests
   SET export_expires_at = LEAST(export_expires_at, created_at + interval '<N> days')
 WHERE export_locator IS NOT NULL AND export_purged_at IS NULL;
```

**Aumentar** o prazo para exports já emitidos não é oferecido: um artefato cujo
prazo já venceu pode já ter sido varrido, e ressuscitá-lo exigiria reemitir o
pacote — o que é um novo pedido de acesso, com nova verificação de identidade.

## 9. Desligar o varredor

`PRIVACY_EXPORT_SWEEP_DRY_RUN=true` faz o passe **contar sem apagar**. Use para
observar um ambiente novo antes de armar o executor.

Não use como estado permanente: com o dry-run ligado, todo `.enc` vencido fica
no disco indefinidamente, que é exatamente o estado que esta entrega existe para
consertar. Só `true` e `1` ligam o dry-run — um valor inesperado mantém o
varredor **ativo**, ao contrário de `RETENTION_DRY_RUN`, cuja direção segura é a
oposta (lá o inesperado mantém o dry-run, porque lá o dano é apagar).

## 10. O que este runbook NÃO cobre

- **Retenção de artefatos de backup** — [`backup-restore.md`](backup-restore.md) §7.
- **Execução de um pedido de privacidade** (exclusão/anonimização/export) —
  `npm run privacy:execute`, coberto pelo módulo
  [`ops`](../architecture/modules/ops.md).
- **Purga de `privacy.export` como parte de um pedido de EXCLUSÃO de titular** —
  continua em `UNSUPPORTED_CLASSES` (`src/ops/privacy/adapters.ts`). O TTL apaga
  o artefato **pelo prazo**; apagar o artefato **a pedido de outro titular** é
  uma pergunta diferente e ainda aberta.
- **Redação de `postgres.audit`** — bloqueada até decisão campo a campo do DPO.
  A trilha `privacy_export_purged` **não** é redigida por este mecanismo.

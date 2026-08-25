# Configuração da Maia

> **ARQUIVO GERADO — não edite à mão.**
> Fonte da verdade: [`src/config/contract.ts`](../src/config/contract.ts).
> Regenerar: `npm run config:generate`. Verificar drift: `npm run config:check:drift`.

Versão do contrato: `1.0.0`

## Profiles

`MAIA_ENV` seleciona o profile (`development` | `staging` | `production`). `NODE_ENV` continua controlando apenas as otimizações da plataforma Node — ele nem sequer consegue expressar `staging`. Quando `MAIA_ENV` está ausente, o profile é derivado de `NODE_ENV`; quando os dois se contradizem, a validação falha.

| Profile | Postura |
|---|---|
| `development` | Endpoints locais permitidos, alertas podem ser só `log`, backup remoto opcional, auth de desenvolvimento explicitamente permitida, placeholders tolerados. |
| `staging` | Equivalente a produção sempre que possível: secrets de teste obrigatórios, backup validado, nenhum placeholder. |
| `production` | Placeholders e auth de desenvolvimento recusados, dependências condicionais obrigatórias, thresholds validados, configuração mínima por serviço. |

**O boot falha fechado em TODOS os profiles.** Variável desconhecida, variável removida (tombstone) e contradição `NODE_ENV` × `MAIA_ENV` abortam o boot em `development` exatamente como em produção: um `.env` que sobe no laptop e morre em staging é o drift que este contrato existe para eliminar. O que muda por profile é o rigor sobre placeholders, endpoints locais e auth de desenvolvimento.

**Rollback de emergência, sem redeploy:** `MAIA_CONFIG_STRICT_BOOT=false` volta ao loader anterior (schema Zod + regras de boot legadas) e desliga a validação de contrato inteira. É uma alavanca para destravar um ambiente, não um estado estável — o boot degradado loga um aviso a cada start. Procedimento completo em [`docs/runbooks/config-contract.md`](runbooks/config-contract.md).

## Comandos

```bash
npm run config:generate                 # regenera .env.example, docs, manifest, fixtures
npm run config:check:drift              # falha se os artefatos gerados estiverem desatualizados
npm run config:check -- --profile production --env-file .env
npm run config:check -- --profile development --env-file .env.example --allow-placeholders
npm run config:init -- --profile production   # ponto de partida operacional
```

`config:check` reporta **todos** os problemas numa única execução (nunca só o primeiro), com variável, regra violada e remediação — e **nunca** o valor de um segredo. Aceita `--json` para automações.

`config:init` gera um **ponto de partida operacional**: todo valor que pertence ao operador vem marcado com `__SET_ME__`, e a validação estrita **falha de propósito** até que ele seja substituído. Ele NÃO é uma fixture.

### Fixtures sintéticas vs. configuração real

As fixtures em `src/config/generated/fixtures/` existem para o CI provar que o contrato é **satisfazível**: valores previsíveis (`sk-ant-fixture-…`) que não autenticam em nada. Um processo configurado com elas fica inoperante parecendo configurado, então `config:check` as **recusa** fora de development (regra `secret/synthetic-fixture`). Só o opt-in explícito `--allow-fixtures`, usado para validar esses próprios arquivos, as aceita:

```bash
npm run config:check -- --profile production \
  --env-file src/config/generated/fixtures/production.env --allow-fixtures
```

Os dois opt-ins são separados de propósito: `--allow-placeholders` (usado no `.env.example`) não concede permissão para valores de fixture, e vice-versa.

## Configuração mínima por serviço

| Serviço | Variáveis | Segredos |
|---|---:|---:|
| `runtime` | 180 | 19 |
| `admin-ui` | 27 | 6 |
| `migrator` | 15 | 2 |
| `backup` | 44 | 7 |
| `maintenance` | 63 | 13 |

O manifest completo (por serviço e por profile) é gerado em [`src/config/generated/service-env-manifest.json`](../src/config/generated/service-env-manifest.json).

## Variáveis

### Core / processo

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Modo da plataforma Node (otimizações do runtime). NÃO é o profile da Maia — use MAIA_ENV. |
| `MAIA_ENV` | `development` \| `staging` \| `production` | — | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Profile da Maia: development \| staging \| production. Decide quais regras de validação são obrigatórias. Quando ausente, é derivado de NODE_ENV. Obrigatória em: staging, production. |
| `MAIA_BUILD_COMMIT` | string | — | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Commit desta build, injetado pelo pipeline de deploy. Vira provenance do manifesto de backup (issue #520), respondendo "qual código este artefato representa". Ausente = null no manifesto. |
| `TZ` | string | `America/Sao_Paulo` | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Timezone IANA usada em toda formatação/agendamento. |
| `APP_PORT` | number | `3000` | não | `runtime` | sim | Porta HTTP do servidor Fastify. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Nível mínimo de log (pino). |
| `MAIA_CONFIG_STRICT_BOOT` | string | `true` | não | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | Validação de contrato no boot (fail-closed em TODOS os profiles). `false` é o ROLLBACK DE EMERGÊNCIA: volta ao loader anterior (schema + regras de boot) e desliga a detecção de variável desconhecida, tombstone e contradição de profile. Use só para destravar um ambiente, e abra issue — ver docs/runbooks/config-contract.md. |
| `MAIA_REJECT_DEFAULT_LITERAL` | string | `true` | não | `runtime`, `maintenance` | não | Fail-closed do literal 'default' em tenant_id/agent_id (issue #323). Default ON; `false` é o rollback de emergência sem redeploy. |

### Banco de dados

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | string | — | sim | `runtime`, `admin-ui`, `migrator`, `backup`, `maintenance` | sim | DSN completo do Postgres (inclui credenciais). Obrigatória em: development, staging, production. |
| `POSTGRES_USER` | string | — | não | `runtime`, `migrator`, `backup`, `maintenance` | sim | Usuário do Postgres (usado pelo compose e pelo pg_dump). Obrigatória em: development, staging, production. |
| `POSTGRES_PASSWORD` | string | — | sim | `runtime`, `migrator`, `backup`, `maintenance` | sim | Senha do Postgres (mínimo 8 caracteres). Obrigatória em: development, staging, production. |
| `POSTGRES_DB` | string | — | não | `runtime`, `migrator`, `backup`, `maintenance` | sim | Nome do banco. Obrigatória em: development, staging, production. |
| `POSTGRES_PORT` | number | `5432` | não | `runtime`, `migrator`, `backup`, `maintenance` | sim | Porta do Postgres. |
| `MIGRATION_LOCK_WAIT_MS` | number | `30000` | não | `migrator` | sim | Quanto um segundo migrator espera pelo advisory lock global antes de desistir com `lock_unavailable` (issue #516). Ele NUNCA aplica nada sem o lock — o teto decide só quanto tempo ele tenta. Subir ajuda quando a migration do vencedor é longa e o perdedor é um deploy paralelo; descer devolve o container mais rápido. |
| `MIGRATION_LOCK_POLL_MS` | number | `500` | não | `migrator` | sim | Intervalo entre tentativas de `pg_try_advisory_lock` enquanto o migrator espera (issue #516). O runner faz POLL em vez de bloquear dentro de `pg_advisory_lock` porque um backend bloqueado é invisível: com poll ele emite `migration.lock_wait`, respeita o prazo e é testável sem Postgres. Valores muito baixos viram round-trip à toa; muito altos atrasam a largada do perdedor depois que o vencedor termina. |
| `MIGRATION_LOCK_TIMEOUT_MS` | number | `10000` | não | `migrator` | sim | `SET lock_timeout` aplicado à sessão que roda cada migration (issue #516). Guarda o apagão clássico: o `ALTER TABLE` da migration entra na fila atrás de uma query longa e TODA query seguinte entra na fila atrás do pedido de lock dela. Falhar em 10s é recuperável; travar a tabela por minutos não é. `0` desliga (default do Postgres) e é fail-OPEN — use só com intenção. |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | number | `0` | não | `migrator` | sim | `SET statement_timeout` aplicado à sessão que roda cada migration (issue #516). Default `0` = SEM teto, e isso é deliberado: um backfill legítimo roda por minutos, e matar uma migration `-- maia:no-transaction` no meio FABRICA exatamente o dirty state que a #516 existe para evitar. Uma migration específica sobe o próprio teto com `-- maia:statement-timeout=<ms>`, onde o revisor vê; esta variável é o piso do ambiente. |

### Redis

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `REDIS_URL` | string | — | sim | `runtime`, `maintenance` | sim | URL do Redis (filas BullMQ, dedup, debounce, rate limit). Obrigatória em: development, staging, production. |
| `REDIS_PORT` | number | `6379` | não | `runtime`, `maintenance` | sim | Porta do Redis (usada pelo compose). |
| `REDIS_CONNECT_TIMEOUT_MS` | number | `10000` | não | `runtime` | sim | Quanto o boot espera pela conexão com o Redis antes de FALHAR FECHADO (issue #512). Redis é dependência obrigatória (BullMQ, dedup, debouncer, working memory, rate limit): `ensureRedisConnect()` não engole mais a falha — sem conexão o processo não anuncia readiness e sai com erro. |

### LLM provider

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openrouter` | `anthropic` | não | `runtime`, `maintenance` | sim | Provider do LLM principal: anthropic (direto) ou openrouter (gateway). |
| `ANTHROPIC_API_KEY` | string | — | sim | `runtime`, `maintenance` | sim | Chave da API Anthropic. Prefixo obrigatório `sk-ant-`. Obrigatória quando LLM_PROVIDER=anthropic. |
| `OPENROUTER_API_KEY` | string | — | sim | `runtime`, `maintenance` | sim | Chave da API OpenRouter. Prefixo obrigatório `sk-or-`. Obrigatória quando LLM_PROVIDER=openrouter. |
| `OPENROUTER_MODEL_MAIN` | string | `anthropic/claude-sonnet-4.6` | não | `runtime`, `maintenance` | não | Slug do modelo principal no OpenRouter (a versão usa ponto: 4.6). Exige tool-calling. |
| `OPENROUTER_MODEL_FAST` | string | `anthropic/claude-haiku-4.5` | não | `runtime`, `maintenance` | não | Slug do modelo rápido no OpenRouter (classificação, judge). |
| `CLAUDE_MODEL_MAIN` | string | `claude-sonnet-4-6` | não | `runtime`, `maintenance` | não | Modelo principal na API Anthropic direta. |
| `CLAUDE_MODEL_FAST` | string | `claude-haiku-4-5-20251001` | não | `runtime`, `maintenance` | não | Modelo rápido na API Anthropic direta. |
| `CLAUDE_MAX_RETRIES` | number | `3` | não | `runtime` | sim | Retries em chamada de LLM. |
| `CLAUDE_TIMEOUT_MS` | number | `30000` | não | `runtime` | sim | Timeout (ms) de chamada de LLM. |
| `LLM_TURN_DEADLINE_MS` | number | `120000` | não | `runtime` | sim | Orçamento wall-clock TOTAL (ms) de uma chamada de LLM quando o caller não declara um deadline: cobre todas as tentativas, backoff, fallback e parsing. Instante absoluto, nunca reiniciado a cada retry (issue #508). O caller pode passar um deadline mais curto; nunca um mais longo na prática, já que o gateway usa o menor tempo restante. |
| `LLM_DAILY_BUDGET_USD` | number | `0` | não | `runtime` | sim | Teto de gasto diário de LLM por tenant+agent, em USD. Imposto no LLM Gateway ANTES de qualquer requisição ao provider (issue #508); estouro rejeita a chamada com erro não retentável. 0 desliga a quota. |
| `LLM_CIRCUIT_MODE` | `off` \| `shadow` \| `enforce` | `shadow` | não | `runtime` | sim | Postura BASE do disjuntor de LLM (issue #534, decisão do owner na revisão): off \| shadow \| enforce. `shadow` (default) roda a máquina de estados inteira e mede o que faria, sem NUNCA recusar chamada; `enforce` recusa de fato; `off` desliga e não guarda estado. Promover para `enforce` só depois de uma passagem por staging com would_open/would_reject medidos. NÃO é o kill switch: mudar aqui exige restart. A alavanca de incidente, sem restart e sem deploy, é o override por Redis — ver docs/runbooks/operational.md §3.1. |
| `DECISION_ENGINE_BUDGET_MS` | number | `2500` | não | `runtime` | sim | Orçamento wall-clock total (ms) do Decision Engine. Abaixo de ~2000ms o hop Haiku estoura e cai no fallback ask_clarification. |

### Transcrição de áudio (Whisper)

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `OPENAI_API_KEY` | string | — | sim | `runtime`, `maintenance` | sim | Chave OpenAI (Whisper, TTS e embeddings openai). Prefixo `sk-`. Obrigatória quando EMBEDDING_PROVIDER=openai ou FEATURE_OUTBOUND_VOICE=true. |
| `WHISPER_PROVIDER` | `openai` | `openai` | não | `runtime` | sim | Provider de transcrição de áudio. |
| `WHISPER_MODEL` | string | `whisper-1` | não | `runtime` | sim | Modelo de transcrição. |

### Embeddings

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `EMBEDDING_PROVIDER` | `voyage` \| `openai` \| `cohere` | `voyage` | não | `runtime`, `maintenance` | sim | Provider de embeddings: voyage \| openai \| cohere. |
| `EMBEDDING_MODEL` | string | `voyage-3` | não | `runtime`, `maintenance` | sim | Modelo de embeddings. O prefixo deve casar com o provider (voyage-*, text-embedding-*, embed-*). |
| `EMBEDDING_DIMENSIONS` | number | `1024` | não | `runtime`, `maintenance` | sim | Dimensões do vetor. Precisa casar com o modelo E com a coluna pgvector já migrada. |
| `VOYAGE_API_KEY` | string | — | sim | `runtime`, `maintenance` | sim | Chave da Voyage AI. Obrigatória quando EMBEDDING_PROVIDER=voyage. |
| `COHERE_API_KEY` | string | — | sim | `runtime`, `maintenance` | sim | Chave da Cohere. Obrigatória quando EMBEDDING_PROVIDER=cohere. |

### WhatsApp / Baileys

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `BAILEYS_AUTH_DIR` | string | `./.baileys-auth` | não | `runtime` | sim | Raiz do estado de sessão do Baileys. Precisa conter um segmento "baileys"; raízes de sistema e o CWD são recusados (o recovery apaga diretórios sob esta raiz). |
| `WHATSAPP_NUMBER_MAIA` | string | — | não | `runtime` | sim | Número E.164 da linha da Maia. Obrigatória em: development, staging, production. |
| `MAIA_DISPLAY_NAME` | string | `Maia` | não | `runtime` | sim | Nome exibido do agente. |

### Owner

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `OWNER_TELEFONE_WHATSAPP` | string | — | não | `runtime` | sim | Número E.164 do owner. Precisa ser diferente de WHATSAPP_NUMBER_MAIA. Obrigatória em: development, staging, production. |
| `OWNER_NOME` | string | — | não | `runtime` | sim | Nome do owner. Obrigatória em: development, staging, production. |

### Governança (limites financeiros e TTLs)

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `VALOR_LIMITE_SEM_CONFIRMACAO` | number | `1000` | não | `runtime` | sim | Teto (BRL) para executar sem confirmação extra. Ordem obrigatória: SEM_CONFIRMACAO <= DUAL_APPROVAL <= LIMITE_DURO. |
| `VALOR_DUAL_APPROVAL` | number | `20000` | não | `runtime` | sim | Acima deste valor (BRL) a operação exige aprovação dupla (4-eyes). |
| `VALOR_LIMITE_DURO` | number | `50000` | não | `runtime` | sim | Teto absoluto (BRL). Acima disso a operação é negada. |
| `DUAL_APPROVAL_TIMEOUT_HOURS` | number | `6` | não | `runtime` | sim | Janela (h) para a segunda aprovação antes de expirar. |
| `AUDIT_MODE_TTL_HOURS` | number | `24` | não | `runtime` | sim | TTL (h) do modo auditoria. |
| `IDEMPOTENCY_BUCKET_MINUTES` | number | `5` | não | `runtime` | sim | Janela (min) do bucket de idempotência. |
| `PENDING_QUESTION_TTL_MINUTES` | number | `120` | não | `runtime` | sim | TTL (min) de pergunta pendente. |
| `PENDING_ACTION_TTL_HOURS` | number | `6` | não | `runtime` | sim | TTL (h) de ação pendente. |
| `RATE_LIMIT_MSGS_PER_HOUR` | number | `30` | não | `runtime` | sim | Teto de mensagens processadas por hora por remetente. |
| `WHATSAPP_RECONNECT_ALERT_MIN` | number | `5` | não | `runtime` | sim | Minutos desconectado antes de alertar. |

### Onboarding (saga e expirer)

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `ONBOARDING_EXPIRER_BATCH_LIMIT` | number | `100` | não | `runtime` | sim | Teto de runs de onboarding vencidas expiradas por tick do worker onboarding_expirer. É trabalho limitado por tick, não vazão contratada: o backlog restante fica visível em maia_onboarding_expiry_backlog e drena nos ticks seguintes. |

### Roteamento multi-linha

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `MAIA_MULTI_LINE` | string | `false` | não | `runtime` | sim | Liga o LineSessionManager como dono do transporte por canal (fase 3). Default off = paridade mono-linha. |
| `MAIA_CHANNEL_ROUTING_MODE` | `shadow` \| `exact_first` \| `strict` | `shadow` | não | `runtime` | sim | shadow (só loga divergência) \| exact_first (exact-match com fallback) \| strict (exige staging operante, falha tipado no miss). |
| `MAIA_STAGING_KEYRING` | string | — | sim | `runtime` | sim | Keyring JSON { key_id: base64(32B) } do staging cifrado de inbound não-roteado. Obrigatório no modo strict. Obrigatória quando MAIA_CHANNEL_ROUTING_MODE=strict. |
| `MAIA_STAGING_ACTIVE_KEY_ID` | string | — | não | `runtime` | sim | Id da chave ativa dentro de MAIA_STAGING_KEYRING. Obrigatória quando MAIA_CHANNEL_ROUTING_MODE=strict. |

### Observabilidade / alertas

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `ALERT_CHANNELS` | string | `email` | não | `runtime`, `backup`, `maintenance` | sim | Canais de alerta separados por vírgula: log, email, telegram. Cada canal exige suas credenciais/destino. |
| `SMTP_HOST` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Host SMTP do canal de e-mail. Obrigatória quando ALERT_CHANNELS contém email. |
| `SMTP_PORT` | number | — | não | `runtime`, `backup`, `maintenance` | sim | Porta SMTP. |
| `SMTP_USER` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Usuário SMTP. |
| `SMTP_PASS` | string | — | sim | `runtime`, `backup`, `maintenance` | sim | Senha SMTP. |
| `ALERT_EMAIL_TO` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Destinatário dos alertas por e-mail. Obrigatória quando ALERT_CHANNELS contém email. |
| `TELEGRAM_BOT_TOKEN` | string | — | sim | `runtime`, `backup`, `maintenance` | sim | Token do bot do Telegram. Obrigatória quando ALERT_CHANNELS contém telegram. |
| `TELEGRAM_CHAT_ID` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Chat de destino dos alertas no Telegram. Obrigatória quando ALERT_CHANNELS contém telegram. |
| `DLQ_ALERT_THRESHOLD` | number | `10` | não | `runtime`, `maintenance` | sim | Tamanho da DLQ que dispara alerta. |
| `MAIA_OTLP_TRACES_ENDPOINT` | string | — | não | `runtime` | sim | Endpoint OTLP/HTTP de traces (ex.: http://collector:4318/v1/traces). Vazio = exporter INERTE: nenhum span é amostrado, montado ou enviado, e o hot path fica idêntico ao anterior (#535). |
| `MAIA_OTLP_TRACES_HEADERS` | string | — | sim | `runtime` | sim | Headers extras do exporter OTLP no formato k=v,k=v (tipicamente autenticação do collector). Segredo — nunca aparece em log nem em /metrics. |
| `MAIA_OTLP_SAMPLE_RATIO` | number | `0.05` | não | `runtime` | sim | Fração de turnos amostrados para OTLP (0..1). A decisão é DERIVADA do trace_id, então gateway e worker chegam ao mesmo veredito sem propagar bit de amostragem — um turno amostrado é amostrado inteiro. |
| `MAIA_OTLP_SERVICE_NAME` | string | `maia-runtime` | não | `runtime` | sim | Valor de `service.name` no resource OTLP. |

### Backup / restore

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `BACKUP_DIR` | string | `./backups` | não | `runtime`, `backup`, `maintenance` | sim | Diretório local dos dumps. |
| `BACKUP_RETENTION_LOCAL_DAYS` | number | `7` | não | `runtime`, `backup`, `maintenance` | sim | Retenção local (dias). |
| `BACKUP_RETENTION_CLOUD_DAYS` | number | `30` | não | `runtime`, `backup`, `maintenance` | sim | Retenção remota (dias). |
| `BACKUP_S3_BUCKET` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Bucket de destino do backup remoto. Sem ele, o backup é só local. Obrigatória em: staging, production. |
| `BACKUP_S3_ENDPOINT` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Endpoint custom para provedores S3-compatíveis (Backblaze B2, Cloudflare R2, Wasabi). Vazio = AWS S3 nativo. |
| `BACKUP_S3_REGION` | string | `us-east-1` | não | `runtime`, `backup`, `maintenance` | sim | Região do bucket. |
| `BACKUP_S3_ACCESS_KEY` | string | — | sim | `backup`, `maintenance`, `runtime` | sim | Access key do bucket de backup. Obrigatória quando BACKUP_S3_BUCKET está definida. |
| `BACKUP_S3_SECRET_KEY` | string | — | sim | `backup`, `maintenance`, `runtime` | sim | Secret key do bucket de backup. Obrigatória quando BACKUP_S3_BUCKET está definida. |
| `BACKUP_S3_PREFIX` | string | `maia` | não | `runtime`, `backup`, `maintenance` | sim | Prefixo dentro do bucket (sem barra inicial nem final). |
| `BACKUP_ENABLED` | string | `true` | não | `runtime`, `backup`, `maintenance` | sim | Liga o backup. `false` é recusado no profile production — um deploy de produção sem backup não tem caminho de recuperação. |
| `BACKUP_OFFSITE_REQUIRED` | `true` \| `false` \| `1` \| `0` | — | não | `runtime`, `backup`, `maintenance` | sim | Exige cópia off-site VERIFICADA para uma run contar como sucesso. Ausente = o profile decide (production exige). `false` é recusado em production. |
| `BACKUP_ENCRYPTION_MODE` | `none` \| `envelope_aes256_gcm` | `none` | não | `runtime`, `backup`, `maintenance` | sim | Cifra do artefato: `none` ou `envelope_aes256_gcm` (client-side, antes de sair do host). `none` é recusado em production — o dump contém dados pessoais de todos os tenants. |
| `BACKUP_ENCRYPTION_KEYRING` | string | — | sim | `backup`, `maintenance`, `runtime` | sim | Keyring JSON { key_id: base64(32B) } da cifra de backup. A chave vive FORA do artefato; rotação é aditiva (mantenha a chave antiga enquanto houver artefato que a referencie). Obrigatória quando BACKUP_ENCRYPTION_MODE=envelope_aes256_gcm. |
| `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Id da chave ATIVA dentro de BACKUP_ENCRYPTION_KEYRING. É um identificador, não material de chave — é o único campo de cifra que aparece em manifesto e auditoria. Obrigatória quando BACKUP_ENCRYPTION_MODE=envelope_aes256_gcm. |
| `BACKUP_DUMP_TIMEOUT_MS` | number | `3600000` | não | `runtime`, `backup`, `maintenance` | sim | Orçamento do pg_dump. Estourado, o processo é morto e a run falha. |
| `BACKUP_UPLOAD_TIMEOUT_MS` | number | `1800000` | não | `runtime`, `backup`, `maintenance` | sim | Orçamento do upload off-site. |
| `BACKUP_RESTORE_TIMEOUT_MS` | number | `3600000` | não | `runtime`, `backup`, `maintenance` | sim | Orçamento do restore drill. |
| `BACKUP_MIN_ARTIFACT_BYTES` | number | `4096` | não | `runtime`, `backup`, `maintenance` | sim | Piso de tamanho do artefato. Abaixo disso é dump truncado, não backup — tamanho sozinho nunca é evidência, mas um piso pega o caso grosseiro. |
| `BACKUP_RPO_TARGET_HOURS` | number | `24` | não | `runtime`, `backup`, `maintenance` | sim | Objetivo de ponto de recuperação. Abaixo de 24h é recusado: dump lógico noturno não cumpre, e a plataforma não anuncia objetivo que a arquitetura não honra (exigiria PITR/WAL). |
| `BACKUP_RTO_TARGET_MINUTES` | number | `120` | não | `runtime`, `backup`, `maintenance` | sim | Objetivo de tempo de recuperação, comparado à duração medida do último drill. |
| `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` | number | `168` | não | `runtime`, `backup`, `maintenance` | sim | Intervalo máximo entre drills de restore aprovados. Vencido, a readiness degrada — até um drill passar, nenhum artefato é sabidamente restaurável. |
| `RETENTION_DRY_RUN` | string | `true` | não | `runtime`, `backup`, `maintenance` | sim | Executor de retenção só CONTA, não apaga. Default `true` de propósito: exclusão é irreversível, então desligar isso é uma decisão explícita por ambiente. Só `false`/`0` desligam. |
| `RETENTION_POLICY` | string | — | não | `runtime`, `backup`, `maintenance` | sim | Política de retenção APROVADA pelo jurídico/DPO, em JSON { version, approved_by, approved_at, classes: { <classe>: { retention_days } } }. Ausente ou malformada = nenhuma classe é purgável (o mecanismo conta, não apaga). Ver docs/architecture/concerns/data-retention-matrix.md. |
| `PRIVACY_EXPORT_TTL_DAYS` | number | `7` | não | `runtime`, `backup`, `maintenance` | sim | Vida útil do pacote cifrado de export de privacidade, em dias. Sete é a POLÍTICA INICIAL decidida pelo dono (issue #536); o DPO ajusta depois, e por isso o prazo é configuração e não constante no código. Vale no momento da EMISSÃO: o prazo fica carimbado em privacy_requests.export_expires_at e é ele que o varredor honra, para que um export já entregue não mude de prazo debaixo do titular. |
| `PRIVACY_EXPORT_SWEEP_DRY_RUN` | string | `false` | não | `runtime`, `backup`, `maintenance` | sim | Varredor do TTL do export só CONTA, não apaga. Default `false` — ao contrário de RETENTION_DRY_RUN, aqui a direção segura é EXECUTAR: o prazo de sete dias já é decisão tomada, e um varredor inerte deixa o pacote cifrado do titular no disco para sempre, que é o vazamento que o TTL fecha. Só `true`/`1` ligam o dry-run, então um valor inesperado mantém o varredor ativo. |

### Custo

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `DAILY_LLM_USD_THRESHOLD` | number | `5` | não | `runtime`, `maintenance` | sim | Teto diário (USD) do cost monitor. Acima dispara alerta. |

### Feature flags

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `FEATURE_MCP_TOOLS` | string | `false` | não | `runtime`, `admin-ui` | sim | MCP externo v1 (#478). Fail-closed: PROIBIDO em produção até o gate G4 (threat model + pentest). Ativa apenas em: development, staging. |
| `FEATURE_PROACTIVE_MESSAGES` | string | `false` | não | `runtime` | sim | Mensagens proativas do agente. |
| `FEATURE_OFX_IMPORT` | string | `false` | não | `runtime`, `maintenance` | sim | Importação de extratos OFX. |
| `FEATURE_DASHBOARD` | string | `false` | não | `runtime` | sim | Dashboard operacional embutido no runtime. |
| `FEATURE_PENDING_GATE` | string | `false` | não | `runtime` | sim | Gate de resolução de perguntas pendentes. |
| `FEATURE_PRESENCE` | string | `false` | não | `runtime` | sim | Sinais de presença (typing, read receipts). |
| `FEATURE_ONE_TAP` | string | `false` | não | `runtime` | sim | Respostas one-tap (enquete/reação como resposta). |
| `FEATURE_MESSAGE_UPDATE` | string | `false` | não | `runtime` | sim | Tratamento de edição/remoção de mensagem. |
| `FEATURE_PENDING_REMINDER` | string | `false` | não | `runtime` | sim | Lembretes de pendências. |
| `FEATURE_VIEW_ONCE_SENSITIVE` | string | `false` | não | `runtime` | sim | Respostas sensíveis (saldos, comparativos) enviadas com viewOnce, gatilhado por preferência da pessoa. |
| `FEATURE_PDF_REPORTS` | string | `false` | não | `runtime`, `admin-ui` | sim | Relatórios PDF (extrato/comparativo) enviados como documento. |
| `FEATURE_OUTBOUND_VOICE` | string | `false` | não | `runtime` | sim | Áudio de saída via OpenAI TTS (reutiliza OPENAI_API_KEY). |
| `FEATURE_OUTBOUND_DEDUP` | string | `false` | não | `runtime` | sim | Ledger de idempotência de saída (#227) em outbound_messages. |
| `FEATURE_MESSAGE_DEBOUNCE` | string | `false` | não | `runtime` | sim | Agrupa textos picotados do mesmo remetente numa única rodada. Mídia sempre passa direto. |
| `FEATURE_PROCEDURE_RUNTIME` | string | `true` | não | `runtime` | sim | Kill switch do runtime de procedimentos (selector + engine + avaliador). Default ON; a rodada ReAct base não depende dele. |
| `FEATURE_TURN_STATE_MACHINE` | string | `true` | não | `runtime` | sim | Máquina de estados durável do turno inbound (issue #503): dual-write de agent_turns. EXIGE as migrations 096 e 097 APLICADAS — subir o processo com esta flag ligada antes de `npm run db:migrate` derruba todo o ingresso. Default ON, e só ESCRITA: enquanto FEATURE_TURN_STATE_AUTHORITATIVE estiver false, `mensagens.processada_em` continua sendo a decisão de negócio e o comportamento observável não muda. Kill switch: false volta ao runtime anterior sem perder os turnos já gravados. Ver docs/runbooks/turn-state-machine.md. |
| `FEATURE_STRICT_TOOL_SCHEMAS` | string | `true` | não | `runtime` | sim | NÃO é uma flag inócua: muda o JSON Schema das tools ENTREGUE ao modelo e, portanto, como ele chama tools. ON (default, #509): schema estrito derivado do contrato Zod — campos, obrigatórios, enums, limites e descrições reais. OFF: volta o stub genérico {type:object, additionalProperties:true}. Só afeta o que o modelo é INFORMADO — a revalidação Zod no dispatcher e todos os gates de grant/permissão/limite/aprovação seguem ativos nas duas posições, então desligar nunca amplia o que uma tool pode fazer. Lever de rollback temporária; remover junto com o branch legado em src/tools/_registry.ts. |
| `FEATURE_TURN_CLAIM` | string | `false` | não | `runtime` | sim | Claim ATÔMICO do turno com lease e fencing (issue #504). OFF (default): o runtime usa o claim apenas de ESTADO de #503, que NÃO é exclusão mútua — duas réplicas podem processar o mesmo turno. ON: antes de executar, o worker exige um claim atômico no PostgreSQL, renova lease por heartbeat e TODA gravação da tentativa passa a exigir o claim_token vigente; perder a lease cancela a tentativa em vez de concluí-la. EXIGE a migration 114 aplicada e FEATURE_TURN_STATE_MACHINE ligada (sem a máquina de estados não há turno a reivindicar). Kill switch: false volta ao caminho de #503 sem perder claims já gravados. Ver docs/runbooks/turn-state-machine.md §6. |
| `FEATURE_TURN_JOB_V2` | string | `false` | não | `runtime` | sim | PRODUTOR do payload V2 do job de turno (issue #504 §Contrato do job). OFF (default): enqueueAgent arma o payload V1 legado ({mensagem_id, turn_id?, correlação}) — o consumidor já lê os DOIS formatos desde esta issue, então ligar aqui é o passo 5 do rollout e nunca o primeiro. ON: quando o produtor conhece o turno, o payload passa a ser exatamente {version: 2, turn_id} e mais nada; o worker redescobre tenant, agent e mensagem no PostgreSQL pelo resolvedor de escopo (src/runtime/turns/scope-resolver.ts). ORDEM OBRIGATÓRIA: só ligue depois que TODAS as réplicas de consumo estiverem no build que entende V2 — um worker antigo recebendo V2 não acha mensagem_id e falha o job. EXIGE FEATURE_TURN_STATE_MACHINE ligada (sem turno durável não há turn_id a transportar). CUSTO CONHECIDO: o payload V2 não carrega received_at_ms/enqueued_at_ms/trace_id; o consumidor os recompõe do banco, então maia_queue_wait_ms passa a medir agent_turns.queued_at em vez do carimbo do produtor. Kill switch: false volta a armar V1 no próximo enqueue. Ver docs/runbooks/turn-state-machine.md §7. |
| `FEATURE_TURN_STATE_AUTHORITATIVE` | string | `false` | não | `runtime` | sim | Flip da LEITURA da máquina de estados do turno (issue #503): o recovery elege candidatos por agent_turns.status em vez de processada_em IS NULL. Único modo em que um turno `retryable` (timeout de reasoner, falha pre-send do outbound) volta para a fila — logo, muda comportamento e custo. Exige FEATURE_TURN_STATE_MACHINE ligada, backfill concluído (`npm run backfill:turns`) e maia_turn_legacy_projection_mismatch_total estável. Ver docs/runbooks/turn-state-machine.md §2. |
| `FEATURE_TURN_CONTEXT_CACHE` | string | `false` | não | `runtime` | sim | Cache do contexto estático do turno (#511) — hoje só a seção `identity` (perfil operacional v2 renderizado). Default OFF: é a única parte da #511 que pode servir conteúdo velho, então sobe no escuro e é ligada por ambiente depois de observar a invalidação cross-replica. Desligar degrada para leitura direta pelo MESMO caminho, nunca para a waterfall legada — o kill switch custa latência, não correção. |

### Sonda sintética

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `MAIA_SYNTHETIC_PROBE` | string | `false` | não | `runtime` | sim | Sonda sintética ponta-a-ponta. Inerte enquanto false. Exige MAIA_CHANNEL_ROUTING_MODE em exact_first ou strict. |
| `MAIA_PROBE_LLM_JUDGE` | string | `false` | não | `runtime` | sim | Asserção secundária por LLM-as-judge na sonda (custo/ruído: off por default). |
| `MAIA_PROBE_CRON` | string | `*/10 * * * *` | não | `runtime` | sim | Cadência do tick da sonda (1 cenário por tick). |
| `MAIA_PROBE_SLO_MS` | number | `30000` | não | `runtime` | sim | Deadline (ms) do efeito colateral. Sem efeito no SLO ⇒ silent. |
| `MAIA_PROBE_SLO_WARN_MS` | number | `15000` | não | `runtime` | sim | Acima deste tempo (ms) mas dentro do SLO ⇒ slow. |
| `MAIA_PROBE_ALERT_AFTER_K` | number | `3` | não | `runtime` | sim | K falhas consecutivas para transicionar saudável→degradado e alertar. |
| `MAIA_PROBE_AUTOSILENCE_AFTER_N` | number | `10` | não | `runtime` | sim | N falhas consecutivas ativam o auto-silêncio (para de gastar LLM em loop). |
| `MAIA_PROBE_SILENCED_BACKOFF_MS` | number | `3600000` | não | `runtime` | sim | Intervalo (ms) de sondagem de recuperação durante o auto-silêncio. |
| `MAIA_PROBE_RUN_TTL_MS` | number | `300000` | não | `runtime` | sim | TTL (ms) do cleanup de rows de run órfãs. |
| `MAIA_PROBE_LEASE_MS` | number | `120000` | não | `runtime` | sim | Lease (ms) de single-flight da sonda. |
| `MAIA_PROBE_ALERT_MODE` | `log_only` \| `alert` | `log_only` | não | `runtime` | sim | log_only (default, staging-safe: log + métrica) ou alert (entrega por sendAlert com retry durável). |

### Runtime trace

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `FEATURE_RUNTIME_TRACE_V1` | string | `false` | não | `runtime` | sim | Liga o runtime trace durável no hot path (#514). Default OFF: com a flag desligada o caminho do turno é idêntico ao anterior e o HMAC master secret não é exigido. Ligar em canário — ver docs/runbooks/observability-slo.md. |
| `MAIA_STRICT_METRIC_LABELS` | string | `false` | não | `runtime` | sim | Promove violação da política de labels de métrica (PII / alta cardinalidade) a exceção em vez de descarte silencioso (#514). Para suíte de testes e diagnóstico; em produção o sanitizer já descarta sem lançar. |
| `RUNTIME_TRACE_HMAC_KEY_VERSION` | number | `1` | não | `runtime`, `admin-ui` | sim | Versão da chave HMAC em uso (rotação a cada 90d). |
| `RUNTIME_TRACE_HMAC_MASTER_SECRET` | string | — | sim | `runtime`, `admin-ui` | sim | Segredo mestre do HMAC de auditoria. OBRIGATÓRIO em produção — sem ele os HMACs de auditoria seriam forjáveis. Obrigatória em: staging, production. |
| `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS` | string | — | sim | `runtime`, `admin-ui` | sim | Segredos anteriores, formato `versao=segredo` separados por `;`, retidos pela janela de retenção de auditoria. |
| `RUNTIME_TRACE_DEBUG_S3_BUCKET` | string | — | não | `runtime` | sim | Bucket dos snapshots cifrados do modo debug (TTL 24h). |
| `RUNTIME_TRACE_DEBUG_AES_KEY` | string | — | sim | `runtime` | sim | Chave AES-GCM (base64) dos snapshots de debug. Obrigatória quando RUNTIME_TRACE_DEBUG_S3_BUCKET está definida. |
| `RUNTIME_TRACE_BODY_ORPHAN_SEC` | number | `300` | não | `runtime` | sim | Idade máxima (s) de um envelope pendente antes do alerta do recoverer. |
| `RUNTIME_TRACE_MATVIEW_REFRESH_SEC` | number | `300` | não | `runtime` | sim | Intervalo (s) de refresh da matview unified_trace_events. |

### Outbox / sweeper

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `OUTBOUND_SWEEPER_STALE_PENDING_SEC` | number | `300` | não | `runtime` | sim | Rows 'pending' mais antigas que isso são promovidas a 'unknown' (terminal). |
| `OUTBOUND_SWEEPER_RETENTION_DAYS` | number | `30` | não | `runtime` | sim | Retenção (dias) de rows terminais em outbound_messages. |
| `OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE` | number | `1000` | não | `runtime` | sim | Tamanho do chunk do DELETE de retenção (evita lock de tabela inteira). |
| `OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT` | number | `500` | não | `runtime` | sim | Teto de promoções stale-pending por tenant por passe (fairness). |
| `OUTBOX_RELAYER_BATCH_PER_TENANT` | number | `100` | não | `runtime` | sim | Efeitos pendentes despachados por (tenant, agent) por passe. |
| `OUTBOX_RELAYER_BASE_BACKOFF_SEC` | number | `30` | não | `runtime` | sim | Base (s) do backoff exponencial em falha transitória. |
| `OUTBOX_RELAYER_MAX_BACKOFF_SEC` | number | `3600` | não | `runtime` | sim | Teto (s) do backoff. |
| `OUTBOX_RELAYER_RETENTION_DAYS` | number | `30` | não | `runtime` | sim | Retenção (dias) de rows terminais do outbox de efeitos. |
| `OUTBOX_RELAYER_RETENTION_BATCH_SIZE` | number | `1000` | não | `runtime` | sim | Chunk do DELETE de retenção do relayer. |
| `OUTBOX_MAX_PER_SECOND` | number | `2` | não | `runtime` | sim | Backpressure de saída: envios por segundo por instância de agente. |
| `OUTBOX_MAX_PER_HOUR` | number | `120` | não | `runtime` | sim | Backpressure de saída: envios por hora por instância de agente. |
| `OCCURRENCE_LEASE_TTL_SECONDS` | number | `300` | não | `runtime` | sim | TTL (s) do lease de uma ocorrência antes de outro worker reclamar. |
| `OUTBOX_LEASE_TTL_SECONDS` | number | `60` | não | `runtime` | sim | TTL (s) do lease do outbox. |
| `OUTBOX_WORKER_CONCURRENCY` | number | `4` | não | `runtime` | sim | Concorrência do worker de outbox. |
| `OUTBOX_DRAIN_LOOP_PASSES` | number | `5` | não | `runtime` | sim | Passes de drain por tick. |
| `OUTBOX_DRAIN_LOOP_SLEEP_MS` | number | `200` | não | `runtime` | sim | Sleep (ms) entre ticks de drain. |
| `MESSAGE_DEBOUNCE_MS` | number | `5000` | não | `runtime` | sim | Janela (ms) do debounce de mensagens; cada texto novo reinicia o timer. |
| `MESSAGE_DEBOUNCE_MAX_MS` | number | `30000` | não | `runtime` | sim | Teto absoluto (ms) do debounce. |

### Procedures / reaper

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `PROCEDURE_SELECTOR_CONFIDENCE_THRESHOLD` | number | `0.6` | não | `runtime` | sim | Limiar (0,1] de confiança do selector de procedimentos. 0 auto-iniciaria em qualquer candidato. |
| `PROCEDURE_TTL_DAYS` | number | `7` | não | `runtime` | sim | Dias de inatividade após os quais o reaper marca a execução como 'abandoned'. |
| `REAPER_BATCH_SIZE` | number | `1000` | não | `runtime` | sim | Teto de leitura por tupla (tenant, agent) por tick do reaper. |
| `REAPER_GLOBAL_BUDGET` | number | `5000` | não | `runtime` | sim | Orçamento GLOBAL de execuções ceifadas por tick, somando todas as tuplas. |
| `CONTRADICTION_OVERLAY_TTL_HOURS` | number | `24` | não | `runtime` | sim | Janela (h) em que uma contradição resolvida ainda aparece no prompt. |

### Performance / caches

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `POLICY_RESOLVER_CACHE_TTL_MS` | number | `300000` | não | `runtime` | sim | TTL (ms) do PolicyResolverCache. |
| `POLICY_RESOLVER_CACHE_MAX_ENTRIES` | number | `10000` | não | `runtime` | sim | Teto LRU do PolicyResolverCache. |
| `TURN_LEASE_TTL_MS` | number | `60000` | não | `runtime` | sim | Validade (ms) da lease do claim do turno (#504). É o tempo MÁXIMO que um turno fica preso depois de o worker dono morrer sem aviso — mais curto recupera antes, e mais longo tolera melhor uma pausa de GC ou um provedor lento. Curto demais produz takeover FALSO, que é execução dupla; por isso deve ficar confortavelmente acima da duração p99 de um turno quando somado ao heartbeat. Relação com TURN_LEASE_HEARTBEAT_MS validada no boot. |
| `TURN_LEASE_HEARTBEAT_MS` | number | `15000` | não | `runtime` | sim | Intervalo (ms) entre renovações da lease do turno (#504). DEVE caber ao menos três vezes em TURN_LEASE_TTL_MS — com duas, uma única renovação perdida já deixa a lease vencer e o turno é tomado por outro worker enquanto o dono ainda está processando. A regra cross-field turn-lease/heartbeat-ratio recusa o boot quando a relação é insegura. |
| `TURN_CONTEXT_CACHE_TTL_MS` | number | `300000` | não | `runtime` | sim | TTL (ms) de uma entrada POSITIVA do cache de contexto do turno (#511). Limita o staleness quando o barramento de invalidação no Redis está inalcançável. |
| `TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS` | number | `30000` | não | `runtime` | sim | TTL (ms) de uma entrada NEGATIVA ("este agente não tem perfil operacional ativo") do cache de contexto do turno (#511). Deliberadamente menor que o TTL positivo: um miss costuma significar operador no meio do setup, e um perfil recém-ativado não pode esperar um TTL positivo inteiro para aparecer. |
| `TURN_CONTEXT_CACHE_MAX_ENTRIES` | number | `5000` | não | `runtime` | sim | Teto de entradas do cache de contexto do turno (#511). Existe para limitar memória se a contagem de tuplas (tenant, agent) explodir, não para otimizar hit rate — o working set é de uma entrada por tupla. |
| `SYNC_LATENCY_P95_BASELINE_MS` | number | — | não | `runtime` | sim | Baseline (ms) do p95 do caminho síncrono. Ausente ⇒ o gate é pulado. |
| `SYNC_LATENCY_P95_BUDGET_PERCENT` | number | `20` | não | `runtime` | sim | Percentual extra permitido sobre a baseline. |

### Lifecycle do processo (readiness e shutdown)

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `MAIA_PROCESS_ROLE` | `all` \| `api` \| `worker` \| `scheduler` \| `session-owner` | `all` | não | `runtime` | sim | Qual fatia da topologia ESTE processo executa: all \| api \| worker \| scheduler \| session-owner. O papel decide o que o boot INICIA e o que o /readyz EXIGE, então um processo worker nunca fica fora de rotação por causa do WhatsApp, e um api-only nunca anuncia readiness por conseguir falar com o Redis. `all` é o modo compatível de processo único que roda hoje; os demais existem para a separação de topologia (issue #513). Contrato em src/runtime/lifecycle/roles.ts. |
| `SHUTDOWN_GRACE_MS` | number | `25000` | não | `runtime` | sim | Orçamento TOTAL do drain depois do SIGTERM: ticks de cron em execução, jobs BullMQ ativos e tarefas de background rastreadas. Precisa ser MENOR que o timeout de kill do supervisor (systemd TimeoutStopSec / compose stop_grace_period, hoje 40s), senão o SIGKILL corta o drain no meio. |
| `SHUTDOWN_STEP_TIMEOUT_MS` | number | `10000` | não | `runtime` | sim | Teto por PASSO do shutdown, para que um componente travado (um socket que não fecha) não consuma o orçamento inteiro. Também limita a espera pela fase de boot em voo; se essa espera estoura, o drain é marcado incompleto e o processo sai forçado. |
| `SHUTDOWN_EXIT_TIMEOUT_MS` | number | `5000` | não | `runtime` | sim | Rede de segurança APÓS um drain limpo. O processo sai naturalmente quando o event loop esvazia; este timer (unref) só dispara se algum handle vazado mantiver o loop vivo. Não é um process.exit prematuro — a saída natural sempre vence a corrida. |
| `SHUTDOWN_FORCED_EXIT_CODE` | number | `1` | não | `runtime` | sim | Código de saída quando o drain termina INCOMPLETO (deadline estourado com trabalho em voo, segundo sinal, ou fase de boot que não cedeu). Distinto do 0 de um drain limpo, para o supervisor e o log distinguirem os dois casos. |
| `READINESS_CACHE_MS` | number | `2000` | não | `runtime` | sim | Janela de cache da avaliação de componentes do /readyz, para que um polling agressivo do load balancer não vire gerador de carga em DB/Redis. O ESTADO do lifecycle nunca é cacheado: o drain derruba o /readyz para 503 na requisição seguinte. |
| `READINESS_PROBE_TIMEOUT_MS` | number | `1500` | não | `runtime` | sim | Timeout por componente nas probes de readiness. Componente que não responde a tempo é reportado como `unknown` — o que é fail-closed para um componente obrigatório do papel. |
| `READINESS_SCHEMA_CHECK` | string | `true` | não | `runtime` | sim | Liga o veredito canônico de schema (getSchemaReadiness, #516) nos DOIS gates: no BOOT e na readiness. No boot (ADR 0004) dirty state, checksum divergente, migration ausente e schema incompatível ENCERRAM o processo com exit code 90-97, específico da invariante; num processo já no ar as mesmas condições derrubam o /readyz para 503, e um veredito `unknown` também (fail-closed). Nenhum dos dois aplica migration — quem aplica é o job de migration. INVÁLIDO no profile production: `false` recusa o boot. Fora de production, desligue apenas onde código e schema são publicados fora de banda de propósito (é o que mantém um `npm run dev` vivo contra um banco desalinhado); isso é política explícita, não fallback silencioso. |
| `READINESS_BACKLOG_MAX` | number | `0` | não | `runtime` | sim | Shedding de capacidade opcional: reporta NÃO-pronto quando a fila do agente tem mais de N jobs esperando. Default 0 = DESLIGADO, deliberadamente — um limiar mal escolhido drena a frota inteira durante um pico legítimo e transforma backlog em outage. Ligue por ambiente depois de conhecer o formato normal do backlog. |
| `READINESS_REQUIRE_WHATSAPP_LIVE` | string | `false` | não | `runtime` | sim | Readiness estrita de WhatsApp. Default false: uma sessão JÁ estabelecida que está reconectando reporta `degraded` e a instância PERMANECE em rotação, porque queda de socket Baileys é rotina e travar nisso faz a readiness flapar. Ligue onde capacidade de canal e capacidade de API precisam ser o mesmo sinal. Não afeta o cold start: antes do primeiro `open` a instância nunca fica pronta, com a flag ligada ou não. |

### Bootstrap / setup

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `SETUP_TOKEN_OVERRIDE` | string | — | sim | `runtime` | sim | Override do token de bootstrap. Desencorajado em produção (env vaza mais que arquivo 0600), mas não proibido — deploys scriptados legítimos usam. |

### Admin UI (container Next.js separado)

| Variável | Tipo | Default | Segredo | Serviços | Restart | Descrição |
|---|---|---|---|---|---|---|
| `ADMIN_UI_PORT` | number | `4000` | não | `admin-ui` | sim | Porta do container Next.js do Admin UI. |
| `NEXTAUTH_URL` | string | `http://localhost:4000` | não | `admin-ui` | sim | URL pública do Admin UI. Precisa ser https fora de development. |
| `NEXTAUTH_SECRET` | string | — | sim | `admin-ui` | sim | Segredo de assinatura do NextAuth (gere com `openssl rand -base64 48`). Placeholders são recusados fora de development. Obrigatória em: staging, production. |
| `AUTH_TRUST_HOST` | string | `false` | não | `admin-ui` | sim | Confia no Host vindo do proxy reverso (Coolify, nginx, ALB). Sem isso o NextAuth v5 recusa hosts que não batem com NEXTAUTH_URL. |
| `NEXT_PUBLIC_API_URL` | string | `http://localhost:3000` | não | `admin-ui` | sim | URL do runtime Fastify consumida pelo Admin UI. Precisa ser https fora de development. |
| `FEATURE_ADMIN_UI_V1` | string | `false` | não | `admin-ui` | sim | Gate mestre do Admin UI v1. |
| `FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS` | string | `false` | não | `admin-ui` | sim | Snapshots de debug no Admin UI. |
| `FEATURE_ADMIN_UI_BULK_REJECT` | string | `true` | não | `admin-ui` | sim | Rejeição em lote no inbox do Admin UI. |
| `FEATURE_ADMIN_UI_REDECIDE` | string | `false` | não | `admin-ui` | sim | Re-decisão manual a partir do Admin UI. |
| `ALLOW_DEV_AUTH` | string | `false` | não | `admin-ui` | sim | Habilita o provider de login de desenvolvimento. PROIBIDO fora de development — o boot recusa. Ativa apenas em: development. |
| `ADMIN_UI_DEV_LOGIN_TOKEN` | string | — | sim | `admin-ui` | sim | Token compartilhado do login de desenvolvimento (mínimo 16 caracteres). Obrigatória quando ALLOW_DEV_AUTH=true. Ativa apenas em: development. |
| `OIDC_ISSUER` | string | — | não | `admin-ui` | sim | Issuer do IdP. Precisa ser https em staging/production. Obrigatória em: staging, production. |
| `OIDC_CLIENT_ID` | string | — | não | `admin-ui` | sim | Client id registrado no IdP. Obrigatória em: staging, production. |
| `OIDC_CLIENT_SECRET` | string | — | sim | `admin-ui` | sim | Client secret do IdP. Obrigatória em: staging, production. |
| `OIDC_TENANT_SLUGS` | string | — | não | `admin-ui` | sim | Lista (vírgula) não vazia de app_users.tenant_id que o IdP pode autenticar. Nunca cai para o literal `default`. Obrigatória em: staging, production. |

## Variáveis removidas (tombstones)

Nenhuma remoção é silenciosa. Uma variável removida permanece listada aqui por pelo menos um ciclo de release, e configurá-la é recusado pela validação.

| Variável | Removida em | Substituta | Motivo |
|---|---|---|---|
| `FEATURE_MULTI_CHANNEL` | PR #411 | — | A resolução de canal passou a ter catch-all single-tenant; o toggle é always-on / inexistente. Mantê-lo no ambiente sugere um gate que não existe mais. |
| `FEATURE_COGNITIVE_GRAPH` | PR #412 | — | O grafo cognitivo roda incondicionalmente (paridade com o caminho imperativo comprovada). Os budgets SYNC_LATENCY_P95_* seguem existindo — eles limitam latência, não o grafo. |
| `FEATURE_CONTEXT_PACKET_V1` | PR #406 | — | O hot-path do context packet foi deletado (o loop do agente sempre usa buildPrompt). Configurar a flag é um no-op que induziria o operador a erro. |
| `FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH` | PR #406 | — | Kill switch da flag removida acima — sem caminho para desligar. |
| `APROVAR_MENSAGENS_PROATIVAS` | issue #515 | `FEATURE_PROACTIVE_MESSAGES` | Nunca pertenceu ao schema: aparecia no `.env.example` sem nenhum consumidor. O gate real de mensagens proativas é FEATURE_PROACTIVE_MESSAGES. |

## Runbook — adicionar, depreciar, remover

**Adicionar**

1. Declare a entrada em `src/config/contract.ts` (schema + `description` + `group` + `secret` + `services` + `example` + `fixture` + `restartRequired`).
2. Se a variável tem dependência de outra, escreva a regra em `src/config/rules.ts` (escopo `contract`) com mensagem e remediação.
3. `npm run config:generate` e commite os artefatos regenerados.
4. Consuma via o loader do serviço — nunca `process.env` direto (a regra ESLint `no-restricted-properties` bloqueia leituras novas fora da allowlist em `eslint.config.js`).

**Depreciar**

1. Preencha `deprecatedSince` (e `replacement`) na entrada. A validação passa a emitir aviso identificável (`contract/deprecated`).
2. Mantenha o comportamento funcionando por, no mínimo, um ciclo de release.

**Remover**

1. Remova a entrada de `ENV_CONTRACT` e adicione um `Tombstone` em `TOMBSTONES` com `removedIn`, `reason` e `failsOn`.
2. `npm run config:generate`. O tombstone aparece no `.env.example` e nesta página.
3. Nunca renomeie nem reutilize o nome de uma variável removida.

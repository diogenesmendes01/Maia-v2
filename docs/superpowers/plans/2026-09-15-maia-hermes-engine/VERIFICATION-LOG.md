# VERIFICATION-LOG — Integração Maia + Hermes (V1)

> Registro do que foi REALMENTE executado: comando, ambiente, resultado e onde
> estão os logs. Nada aqui é inferido. Teste pulado é reportado como pulado.
> Fuso: horários do relógio local da máquina (Windows, GMT no Postgres).

## Convenções

- `SCRATCH` = `C:\Users\Mendes\AppData\Local\Temp\claude\C--Users-Mendes-Documents-GitHub-Maia-v2--claude-worktrees-github-issue-498-cdbb4e\3dc19b93-0a05-4c08-909c-dd0b1a51554e\scratchpad`
- `WT` = worktree `C:\Users\Mendes\Documents\GitHub\Maia-v2\.claude\worktrees\github-issue-498-cdbb4e` (branch `claude/maia-hermes-integration-158579`)
- Logs de comandos ficam em `SCRATCH/logs/` e nas saídas de tarefas em `…/tasks/*.output` (efêmeros: o essencial é transcrito aqui).

## 2026-09-15 — Sessão 1

### V-001 · Conferência de baseline (leitura)

| Comando | Resultado |
|---|---|
| `git rev-parse HEAD`, `git status` no worktree | `2bbeefe9de1784a3c90c184ea80d8f0cc6119ad1`, árvore limpa — **igual** à baseline Maia da spec §0.1 |
| `git rev-parse HEAD` no checkout Hermes local | `5d59366010640c1d6b8f170d8a4ee109db2bbdef`, limpo — **igual** ao SHA pinado da spec |
| `sha256sum SPEC-IMPLEMENTACAO-MAIA-HERMES.md` | `84c4260773455393d1266283086468e81637e9d552158a8b623481d48cd756a4` — confere com `VALIDACAO-SPEC-MAIA-HERMES.md` e `evidencias/spec-validation.json` |
| `md5sum` das cópias (Downloads, zip, `maia-hermes-analysis`) | idênticas (`0d31fef347ff1eeb2d5a75bf9e5b5e1b`) — não há duas versões divergentes da spec |

Conclusão: números de linha citados na spec referem-se ao MESMO commit em que estamos; ainda assim cada referência é reconferida no momento de uso.

### V-002 · Ambiente de execução

| Verificação | Resultado |
|---|---|
| `node --version` (global) | `v24.16.0` — **incompatível**: `npm run typecheck/lint/test` abortam com `EBADDEVENGINES` (`devEngines.runtime >=22.13.0 <23`) |
| Node 22 portátil | baixado de `https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip`; `sha256sum -c` contra `SHASUMS256.txt` do mesmo diretório → `OK`; instalado em `SCRATCH/tools/node22`; `node --version` = `v22.23.2`, `npm` = `10.9.8` |
| `docker`, `wsl -l -v`, Postgres/Redis nativos | ausentes (WSL sem distribuições) — confirma memória do projeto de que integração real depende de infra local preparada |
| `HERMES_HOME` no ambiente do usuário | `C:\Users\Mendes\AppData\Local\hermes` (perfil do Hermes Desktop) — **risco de isolamento**: qualquer spawn precisa de env allowlisted (spec §6.6, T54). Nenhum arquivo desse perfil foi lido |
| `ANTHROPIC_BASE_URL` | presente no ambiente do usuário — idem, não deve ser herdada pelo filho |

### V-003 · Gates estáticos na baseline (Node 22)

| Comando | Resultado | Log |
|---|---|---|
| `npm run typecheck` | **exit 0** | `SCRATCH/logs/baseline-typecheck.log` |
| `npm run lint` | **exit 0** — `481 problems (0 errors, 481 warnings)` | `SCRATCH/logs/baseline-lint.log` |

Observação: a mesma dupla executada com o Node 24 global falha antes de compilar (`EBADDEVENGINES`) — não é falha do código.

### V-004 · Postgres descartável (em curso)

| Tentativa | Resultado |
|---|---|
| `pgserver` 0.1.4 (wheel `pgserver-0.1.4-cp312-cp312-win_amd64.whl`, sha256 `406e9355334e40754160a33d93f18a848720a38cd0b68da50be2ea272c89ed2d`) | traz PostgreSQL 16.2 + pgvector 0.6.2, mas **só** `plpgsql` e `vector`; faltam `pgcrypto`, `uuid-ossp`, `btree_gin`, `pg_trgm` exigidos por `migrations/001_initial.sql`/`002_specs_v1.sql` |
| `initdb` do pgserver dentro do scratchpad | falha: `extension "plpgsql" is not available` — o caminho do scratchpad excede MAX_PATH e `postgres.exe` não é long-path-aware. Remediação: usar diretório curto (`%TEMP%\mhx`) |
| Binários oficiais EDB `postgresql-16.2-1-windows-x64-binaries.zip` (sha256 local `c510b3058c161479bfbe0aeac878ca682b344fd9385c58a359690147a4ca1a6c`; EDB não publica checksum oficial para conferência — limitação registrada) | `initdb` + start OK (`postgres (PostgreSQL) 16.2`), contrib completo; **porém** `vector.dll` do pgserver não carrega nele: `could not load library … unknown error 127` (símbolo ausente — ABI de build diferente) |
| **Resolvido** | binários do pgserver (PostgreSQL 16.2, MinGW) em `%TEMP%\mhx\pgs` + DLLs contrib do EDB copiadas para dentro dele. Todas as cinco extensões **carregam e funcionam**: `vector=0.6.2`, `pgcrypto=1.3`, `uuid-ossp=1.1`, `btree_gin=1.3`, `pg_trgm=1.6`; `gen_random_uuid()`, `uuid_generate_v4()`, `digest()`, `similarity()` e `<=>` de vetor respondem |

Rig de banco **validado de ponta a ponta**: com `TEST_DB_URL` apontando para essa instância, o
`globalSetup` criou o banco da worktree (`maia_test_wt_…6d42df4a`) e aplicou **145 migrations**
(`outcome: applied · applied 145 · dirty 0`).

Procedência dos binários (registrada porque é mistura deliberada, só para rig local — **não** é
configuração de produção): PostgreSQL 16.2 compilado com MinGW, vindo do wheel `pgserver` 0.1.4
(sha256 `406e9355…89ed2d`), mais as DLLs de contrib do pacote oficial EDB
`postgresql-16.2-1-windows-x64-binaries.zip` (sha256 local `c510b305…ca1a6c`; a EDB não publica
checksum para conferência — limitação registrada). O caminho inverso (pgvector do pgserver dentro do
PostgreSQL do EDB) **não** funciona: `could not load library … unknown error 127`.

### V-005 · Redis — **BLOQUEADO** (infraestrutura)

Não há Redis real na máquina (sem Docker, sem distribuição WSL instalada, sem serviço nativo). A tentativa de usar `fakeredis` 2.38.0 (`TcpFakeServer`, `127.0.0.1:56379`) **falhou**: o `ioredis` manda `INFO` no handshake e o servidor responde `ERR unknown command 'info'`, derrubando a conexão (`connect FALHOU: Connection is closed`). Nem o `flushRedis` do `globalSetup` funciona — e ele falha fechado, por desenho.

Os únicos binários de Redis para Windows que localizei são builds de terceiros (projeto `redis-windows`, pacotes Cygwin/MSYS2 de Redis 8.10.1). **Não instalei**: baixar e executar binário de origem não oficial para servir de infraestrutura é decisão do dono, não minha.

Consequência registrada sem maquiagem: **toda spec que exija semântica real de Redis/BullMQ fica NÃO EXECUTADA** e nenhuma delas conta como verificada. Para as specs que dependem só de Postgres uso o procedimento local de dois passos de `SCRATCH/vitest.integracao-local.config.mts` (o primeiro passo deixa o `globalSetup` do projeto criar e migrar o banco; o segundo roda sem `globalSetup`). Isso **não** substitui a rodada do CI.

**O que destravaria:** um Redis 7 real acessível em `REDIS_URL` (contêiner, serviço gerenciado, ou binário aprovado pelo dono). Sem isso, `tests/integration/*real-redis*`, filas BullMQ, locks distribuídos e o kill switch do circuito de LLM permanecem fora de qualquer alegação de verificação.

### V-006 · Ambiente Python do Hermes pinado

| Passo | Resultado |
|---|---|
| Clone local (sem rede) do checkout pinado para `SCRATCH/hermes/hermes-upstream`, `git checkout --detach 5d593660…` | HEAD confere; árvore limpa; primeira tentativa falhou por caminho longo, resolvida com `core.longpaths=true` |
| `uv sync --frozen --no-dev` (uv 0.12.13 instalado num venv próprio; `UV_NO_CONFIG=1`, `UV_CACHE_DIR` no scratchpad, env sem `HERMES_HOME`/`ANTHROPIC_BASE_URL`) | sucesso; `.venv` com Python 3.12.10 |
| `python -c "import run_agent; inspect.signature(AIAgent.__init__)"` com `HERMES_HOME` apontando para diretório efêmero | **import real OK**; `AIAgent.__init__` com 81 parâmetros (contagem a detalhar no mapeamento do P00) |

Isto prova apenas que o pacote importa no ambiente pinado — não prova execução de loop, tools ou cancelamento (gates §6.12 e §11.3, ainda não executados).

### V-007a · ACHADO (fora do escopo desta entrega): migrations `no-transaction` quebram em checkout CRLF

Ao exercitar as migrations no banco descartável, `005_audit_mensagem_idx.sql` falhou com `42601` e foi
marcada `dirty`, bloqueando todas as seguintes. **Não é o ambiente: é um defeito reproduzível.**

`splitNoTxStatements` (`src/migrations/discover.ts:338-346`) remove comentários com
`line.replace(/--.*$/, '')` **sem a flag `m`**, depois de `sql.split('\n')`. Num arquivo com
finais de linha CRLF, cada “linha” termina em `\r`; em JavaScript `\r` é terminador de linha,
então `.` não o casa e `$` (sem `m`) só casa no fim absoluto — **a regex não casa e o comentário
não é removido**. O `split(';')` seguinte corta dentro do comentário (o texto do próprio 005 contém
“…inside a transaction block; without the marker…”), e o segundo “statement” começa em `without the`.

Evidência (script de diagnóstico em `SCRATCH/diag005.cjs`, cópia fiel do splitter):

```
n = 2
0 "-- maia:no-transaction\r\n-- ====…"          → executa como comentário, “OK”
1 "without the\r\n-- marker …\r\nCREATE INDEX…"  → ERRO 42601 syntax error at or near "without"
```

No CI (Linux, LF) o caminho é verde — por isso o defeito não aparece lá. Atinge qualquer
desenvolvedor em Windows com `core.autocrlf=true` e **qualquer** migration `-- maia:no-transaction`,
inclusive as que o P03/P04 desta integração vão acrescentar.

Tratamento nesta sessão: **não corrigi o runner** (fora do escopo autorizado). Registrei o achado,
abri tarefa separada e apliquei contorno LOCAL — `core.autocrlf=false` nesta worktree e conversão
dos `.sql` da árvore de trabalho para LF, sem alterar o índice nem o conteúdo versionado.

### V-007 · Suíte unitária de baseline (commit `2bbeefe9`, Node 22, `--maxWorkers=3`, sem `TEST_DB_URL`)

```
executados=10092  falharam=54  pulados=1027
```

Mais dois arquivos que **não carregaram** (hooks estourando 20s por falta de Redis):
`tests/integration/llm-circuit-kill-switch-redis.spec.ts` e `llm-circuit-reconnect-resync.spec.ts` —
nenhum caso deles chegou a rodar, e por isso não entram nos contadores acima.

Distribuição das 54 falhas por arquivo (todas **preexistentes**, em código que não toquei):
`ops/privacy-export-sweeper` 7 · `ops/privacy-export-locator` 7 · `observability/slo-rules` 5 ·
`reliability/self-tests/process-supervisor` 5 · `observability/runbook-promql` 2 · `media-guard` 2
(EPERM de symlink no Windows) · `reliability/self-tests/failpoint-transport` 2 ·
`integration/tool-request-guardrail-real-db` 2 · `integration/llm-settings-invalidation` 2 (Redis) ·
`tool-request-credencial` 1 · `setup-auth-dir` 1 (drive letter) · `helpers/worktree-scope-concorrencia` 1 ·
`config/preflight` 1 · `ci/admin-ui-e2e-gate` 1 · `reliability/self-tests/fake-channel-provider` 1.

**É este o baseline de comparação.** Qualquer falha futura só pode ser atribuída ao meu código depois
de confrontada com esta lista. (A memória do projeto registrava “3 falhas reais” em 2026-07-29; o
número cresceu no `main` desde então — o que vale é a medição de hoje, no commit base.)

### V-008 · P00.1 — contrato wire (commit `dfc98f50`)

| Gate | Resultado |
|---|---|
| `npm run typecheck` | 0 erros |
| `npx eslint src/integrations tests/unit/hermes-wire-contract.spec.ts` | 0 achados |
| `vitest run tests/unit/hermes-wire-contract.spec.ts` | `executados=62 falharam=0 pulados=0` |
| Verificação por mutação (5 mutações no módulo) | todas detectadas |

A primeira rodada de mutação **reprovou o meu próprio teste**: subir `max_frame_bytes` 100× não
quebrava nada (o caso usava a própria constante para gerar o payload) e remover a regra de `trim` do
`reply` também não (o caso usava string vazia, barrada antes pelo `min(1)`). Os dois casos foram
reescritos com valores absolutos e com texto só-de-espaços; depois disso, cada uma das cinco
mutações derruba pelo menos um caso.

Incidente de processo no mesmo commit: ao ligar `core.autocrlf=false` para contornar o defeito do
splitter (V-007a), o commit inicial levou `AGENTS.md` e `ARCHITECTURE.md` **inteiros reescritos em
CRLF** (760 e 411 linhas). Detectado na revisão do próprio diff, corrigido por `--amend`
reconstruindo os dois arquivos a partir dos bytes versionados e reaplicando só a linha alterada; a
árvore inteira foi normalizada em seguida (`git checkout -- .`). O commit final mostra
`AGENTS.md | 2 +-` e `ARCHITECTURE.md | 1 +`.

### V-009 · P00.3 — normalizador de contexto Maia→Hermes

| Gate | Resultado |
|---|---|
| `vitest run tests/unit/hermes-history-normalizer.spec.ts` | primeiro vermelho (módulo inexistente), depois `executados=19 falharam=0 pulados=0` |
| `npm run typecheck` | 0 erros |
| `npx eslint src/integrations/hermes/history.ts tests/unit/hermes-history-normalizer.spec.ts` | 0 achados |
| Verificação por mutação (8 mutações) | todas detectadas |

Mutações aplicadas e efeito: teto de mensagens (2 casos caem) · filtro de mensagem vazia (1) ·
remoção do envelope `<user_message>` (2) · recusa de bloco não textual no histórico (3) · exigência
de que a última mensagem seja do usuário (1) · recusa de bloco não textual no inbound (1). Duas
delas exigiram refazer o harness: o delimitador `|` do meu laço cortava a string que contém `||`, e
um template literal com backticks não casava — sintoma de harness, não do código, mas registrado
porque uma mutação “NÃO-APLICADA” lida às pressas parece uma mutação sobrevivente.

### V-010 · P03.1 — migrations 139/140 no Postgres descartável

| Passo | Resultado |
|---|---|
| Reserva de prefixo (`npm run migrate:reserve`) | 139 e 140 registrados em `migrations/RESERVATIONS.md` |
| Aplicação pelo **runner real** (via `globalSetup`, não por `psql -f`) | `outcome: applied · applied 2 · dirty 0` |
| Objetos criados | `conversation_controls`, `engine_turn_bindings`, `engine_runs`, `engine_tool_calls`, `engine_run_events`, `engine_projections`; triggers `engine_runs_immutable_trg`, `engine_tool_calls_immutable_trg`, `engine_run_events_append_only_trg`; unique parcial `engine_runs_one_open_turn_uq … WHERE (phase <> 'closed')`; `approval_requests_scope_id_uq` |
| Ciclo **up → down → up** (gate T69) | down de 140 e 139 executados sem erro; nenhuma tabela do journal restou; up reaplicado e as 6 tabelas voltaram |

Decisão de desenho registrada: a unique de `approval_requests` foi feita SEM `CONCURRENTLY`. A
alternativa (índice concorrente + `ADD CONSTRAINT … USING INDEX`) exigiria `-- maia:no-transaction`,
que custaria a atomicidade com a linha do ledger e cairia no divisor por `;` sem parser — o mesmo
caminho do defeito V-007a. A tabela nasceu na migration 095 e guarda aprovações humanas, não
tráfego: o bloqueio é de milissegundos.

Desvio consciente em relação ao capítulo 10 da spec, registrado como C11: o SCHEMA de
`conversation_controls` (capítulo 8 / P04) nasce junto do journal porque `engine_runs` tem FK
composta para ele e o §5.6.2 manda criar a tabela de controle ANTES dessa FK. O COMPORTAMENTO de
pausa/retomada continua no P04. As FKs compostas de `conversation_controls` para
`conversas`/`pessoas`/`channels` **não** entraram: essas tabelas só têm `PRIMARY KEY (id)` hoje
(conferido no banco), e criar os uniques compostos que faltam significa índice novo em tabela quente
(`conversas`), que é migration própria com `CONCURRENTLY` na fatia do P04.

### V-011 · Revisão do trabalho do agente P01 (caracterização) — feita por mim, não pelo relatório

O agente entregou `tests/unit/react-loop-characterization.spec.ts` (1397 linhas) e relatou “10
mutações, 10 detectadas”. **Relatório não é evidência**, então:

1. Li o arquivo inteiro (1397 linhas), não só o resumo.
2. Reexecutei a suíte por conta própria, na worktree dele: `executados=57 falharam=0 pulados=0`.
3. Apliquei **três mutações minhas**, escolhidas independentemente das dez dele, em
   `src/agent/react-loop.ts`, restaurando o arquivo a cada rodada:

   | Minha mutação | Efeito na suíte |
   |---|---|
   | `sideEffectsCommitted` deixa de ser marcado na invocação | 2 casos vermelhos |
   | pendência recém-criada deixa de ser revalidada (`if (true)`) | 3 casos vermelhos |
   | teto de iterações 5 → 8 | 6 casos vermelhos |

   Restaurado o arquivo, a suíte volta a 57/57. A rede morde.
4. Conferi que ela PINA o defeito conhecido (`toolSummaries` ausente no ctx de `safeDispatchOutput`)
   com asserção sobre o conjunto exato de chaves — é o que fará a correção da extração aparecer como
   diff deliberado, como §5.10.3 pede.
5. Integrado por `git merge --no-ff` (commit `7058b5fc`); suíte reexecutada na MINHA árvore após o
   merge: 57/57, typecheck limpo.

Observação de conformidade: o agente registrou na mensagem de commit que NÃO assina trailer de
coautoria de IA, citando `AGENTS.md` §8 e o gate `commit:trailers:check` — mesma decisão adotada
aqui (contradição C08 do estado da implementação).

### V-012 · P03.1 — journal contra Postgres real

`tests/integration/hermes-runs-real-db.spec.ts`, 12 casos, executados pelo procedimento local de
dois passos (V-005): escopo por FK composta, unique parcial de run aberto, unicidade de
`request_key`, imutabilidade de 9 colunas do run, atribuição única de `remote_run_id`, terminal não
substituível, monotonicidade de `effect_evidence`, append-only dos eventos, CHECKs de coerência,
unicidade de `(run, call_id)` e `(run, ordinal)`, e recusa de aprovação de outro tenant.

Dois defeitos **do meu próprio teste** apareceram e foram corrigidos — registrados porque cada um
teria virado uma conclusão errada sobre o schema:

1. o caso da aprovação cross-tenant usava colunas inexistentes (`requested_by`, `tool_name`): a
   falha era do INSERT, não da FK. Corrigido conferindo as colunas reais no banco;
2. o caso do `remote_run_id` usava o literal `'w-1'`, e a unique é
   `(tenant, agent, remote_instance_id, remote_run_id)` — passou na primeira rodada e colidiu na
   segunda. Corrigido com ids únicos por rodada, e a spec agora roda duas vezes seguidas verde.

### V-013 · P02.1 — `MaiaEngine` (motor local atrás da porta)

| Gate | Resultado |
|---|---|
| `vitest run tests/unit/maia-engine.spec.ts` | primeiro vermelho (módulo inexistente), depois `15 passed` |
| `npm run typecheck` | 0 erros |
| `npx eslint src/runtime/engines tests/unit/maia-engine.spec.ts` | 0 achados |
| Verificação por mutação (5 mutações) | todas detectadas |

Mutações e efeito: conflito de `request_key` deixando de ser detectado (`accepted` no lugar de
`rejected`) · `not_found` passando a alegar `definitely_not_accepted` (2 casos) · perda de posse
virando desfecho em vez de propagar (2 casos) · sinal entregue ao raciocínio deixando de ser o
derivado, o que torna `cancel` decorativo · `already_terminal` suprimido.

O caso que mais importa é o segundo: um adapter local que devolvesse
`definitely_not_accepted` para um run que ele simplesmente não tem em memória autorizaria o
supervisor a recomeçar um turno que pode ter executado ferramentas. Por isso o registro em memória
é explicitamente honesto — “não tenho registro” nunca é prova de não-execução (§5.3.1).

### V-014 · P02.2 — separação entre deliberar e entregar em `react-loop.ts`

A iteração deixou de despachar: ela registra o candidato (texto cru + texto com prefixo de role) e o
envio acontece depois do laço, numa fachada de saída. A ordem observável foi preservada de
propósito — `outboundText` continua atribuído antes de qualquer tentativa de envio, `not_sent`
continua encerrando sem marcar entrega, `sent_no_persist` continua marcando incerteza **e** entrega,
e a reflexão de lacuna continua acontecendo só quando algo chegou ao usuário.

| Gate | Resultado |
|---|---|
| `tests/unit/react-loop-characterization.spec.ts` (a rede da refatoração) | 57/57 |
| `maia-engine` + `hermes-wire-contract` + `hermes-history-normalizer` + `agent-engine-contract` | 131/131 |
| `npm run typecheck` | 0 erros (depois de corrigir o estreitamento de `candidato` para `never`) |
| `npx eslint src/agent/react-loop.ts` | 0 achados |

Dois percalços registrados porque distorceriam a leitura do diff:

1. o compilador estreitava `candidato` para `never` — ele não acompanha atribuições feitas dentro da
   closure da iteração. Resolvido com container mutável + captura numa `const` local;
2. **as ferramentas de edição desta máquina gravam CRLF, e o repositório é LF.** O diff apareceu como
   723+/695− (arquivo inteiro) quando a mudança real era 100+/68−. Pior: minha primeira "correção"
   converteu o arquivo para CRLF, e um script de normalização meu pegou a lista errada e alterou o
   fim de linha de **146 arquivos alheios** antes de abortar. Todos foram restaurados com
   `git checkout --` (a mudança neles era exclusivamente de EOL, confirmado com
   `--ignore-cr-at-eol`), e o `schema.ts` — que já tinha entrado com esse ruído no commit `6517579d`
   — foi devolvido a LF no commit `f0bb928a`. **Regra para o resto da sessão: conferir EOL de todo
   arquivo existente antes de commitar.**

### V-015 · Revisão do trabalho do agente P00.2 (worker Python) — feita por mim

O agente entregou `services/hermes_worker` (20 arquivos, 4869 linhas) e relatou 166 testes verdes.
O que eu fiz, além de ler o relatório:

1. Li `protocol.py` e `main.py`. Pontos que sustentam a integração: o comprimento de string é medido
   em unidade UTF-16 (é assim que o Zod mede, então um nome com emoji conta igual dos dois lados); a
   regex de instante ISO foi recomposta a partir do próprio Zod, em vez de "melhorada"; a ordem das
   checagens é tratada como parte do contrato, porque a fixture afirma o CÓDIGO de recusa; e o
   bootstrap **recusa** `HERMES_HOME` ausente, relativo ou apontando para o perfil pessoal do Hermes
   Desktop — que é exatamente o risco de isolamento que registrei em V-002.
2. Reexecutei a suíte em venv limpo, sem `HERMES_HOME` nem credenciais: **166 passed**.
3. Conferi que a fixture compartilhada é byte a byte a mesma dos dois lados (md5 `8931cc97…`).
4. Apliquei **cinco mutações minhas** em `protocol.py`: teto de frame, teto de payload de tool,
   profundidade de JSON, regra de inteiro decimal e regex de instante ISO.

**Quatro foram detectadas. A quinta sobreviveu** — afrouxar a regra de inteiro decimal
(`cost_microusd`) não derrubou nenhum teste. Investigando: o validador Python estava CORRETO; o que
faltava era caso de teste, e o mesmo buraco existia no meu lado, porque a fixture compartilhada não
tinha nenhum custo malformado. Acrescentei três casos (`25.5` recusado, `'0'` aceito como medição,
`'007'` recusado por dupla representação) e reapliquei a mutação:

| Lado | Antes dos casos novos | Depois |
|---|---|---|
| Python (`test_protocol_fixtures.py`) | mutação SOBREVIVE | 2 casos vermelhos |
| TypeScript (`hermes-wire-contract.spec.ts`) | mutação sobrevive | 2 casos vermelhos |

Ambos voltam verdes com o arquivo restaurado (Python 39, TS 65). É a demonstração de que a fixture
compartilhada funciona como guarda de divergência: um caso acrescentado fecha o buraco nas DUAS
implementações de uma vez.

UNKNOWNs que o autor deixou explícitos e que viram trabalho do supervisor (registrados, não
resolvidos): `tool_schema_digest` precisa ser calculado igual dos dois lados ou a readiness trava sem
erro óbvio; a janela de contexto está fixa em 64.000 porque o frame `start` não a carrega; e a
estratégia de descritores (duplicar o FD 1 e mandar stdout para stderr) **não foi validada contra um
spawn real do Node no Windows** — isso é parte do P00.4.

### V-016 · P00.4 — SPIKE com o `AIAgent` REAL (provider stub), gate G-ABI

`tests/reliability/hermes-worker-spike.spec.ts`, executado com o venv do checkout pinado:

```
MAIA_HERMES_WORKER_PYTHON=<upstream>/.venv/Scripts/python.exe
MAIA_HERMES_UPSTREAM=<upstream>
vitest run tests/reliability/hermes-worker-spike.spec.ts
→ Test Files 1 passed · Tests 6 passed (21.3 s)
```

O que rodou DE VERDADE: o worker Python como processo separado, importando o `AIAgent` do SHA
`5d59366…`, com o registry real, o loop real e o caminho real de cancelamento. Um turno inteiro
atravessou o protocolo: `start` → `ready` → `tool.request`/`tool.result` → `result` → `result_ack`.

| Caso | Evidência |
|---|---|
| **T53** superfície efetiva | `ready.effective_tool_names` é EXATAMENTE `[maia_fixture_echo]`, e as requisições capturadas no stub trazem exatamente a mesma lista em `tools` — igualdade, não subconjunto. Sem `tools.tool_search.enabled: "off"` a superfície viraria `tool_search/tool_describe/tool_call` |
| Ida e volta de ferramenta | `tool.request` com `call_seq: 0` e `args` intactos; resultado devolvido pelo pipe volta ao modelo; `observed_tool_call_seqs: [0]` |
| **T28** tool forjada | o modelo pediu `terminal_exec`; **zero** `tool.request` saíram e `observed_tool_call_seqs` ficou vazio |
| **T54** isolamento | `HERMES_HOME` apontando para o perfil pessoal do Hermes Desktop → exit code **2**, nenhum frame emitido, nada escrito lá |
| **T55** home efêmero | depois do turno o home tem `state.db` e `config.yaml`, e o inventário sai no stderr — `session_db=None` não é promessa de zero persistência |
| Cancelamento | `cancel` no meio do round-trip devolve `cancel_ack` e o desfecho NÃO é `reply` |
| Credencial | a chave curta de inferência chegou por **header** (redigido no registro do stub) e não aparece no corpo do request |

**O que este spike NÃO prova, e não pode ser reportado como se provasse:** qualidade de resposta,
custo, latência ou compatibilidade com um provedor real — o modelo é um **stub local roteirizado**
(§11.3.2 exige dizer isso explicitamente). O smoke com provider pago segue bloqueado por D02
(orçamento). Também não prova isolamento de sistema operacional: processo separado não é sandbox
(D01).

A spec pede a estratégia de descritores validada na plataforma de deploy (§6.4.2). Aqui ela foi
validada **no Windows, com spawn real do Node**: o worker duplica o FD 1 e manda stdout para stderr
antes de importar o Hermes, e nenhum `print` do motor corrompeu uma linha NDJSON em 6 execuções.
Em Linux (alvo de produção) continua não verificado.

### V-017 · P03.2 — `engine-repos.ts`, o caminho de START do journal

Unidade: `src/db/repositories/engine-repos.ts` (novo) + `tests/integration/hermes-engine-repos-real-db.spec.ts`
(novo, 10 casos). Cobre quatro das operações do §5.6.3: `pinEngineAndPrepareRun`, `markSubmitting`,
`recordStartObservation`, `recordTerminalProposal`.

**Gates estáticos** — o conjunto que o `AGENTS.md` exige antes de cada commit, não só os dois que eu
vinha rodando: `check:node` exit 0; `docs:ai:check` exit 0; `config:check:drift` exit 0 (confirma de
fora que C11 não deixou dívida de configuração: nenhum artefato gerado ficou desatualizado);
`typecheck` (projeto inteiro) exit 0; `lint` COMPLETO exit 0 com **481 warnings — o mesmo número da
baseline**, ou seja, esta unidade não acrescentou nenhum; `audit:exceptions:check` exit 0.
`prettier --check` **reprovou** nos dois arquivos novos; corrigido com `--write` restrito a eles (nunca
`npm run format`, que reescreveria `src/` inteiro). Depois da reformatação, typecheck, lint e os 10
casos foram re-executados, e a varredura de mutação foi refeita — prettier rewrapa linhas, e o harness
casa texto LITERAL, então a evidência anterior não valeria para os arquivos novos.

**Contra Postgres REAL** (rig local 16.2, procedimento de dois passos — ver V-005):

| Caso | O que prende |
|---|---|
| 1 | `prepared` sob posse viva fixa o pin, aloca geração 1 e escreve o evento `prepared` com `actor_kind='turn_owner'` |
| 2 | claim divergente, tentativa divergente e **lease vencida** recusam como `stale_claim`; turno fora de `running` recusa como `state_mismatch` — a prioridade do §5.6.4 (posse antes de estado) |
| 3 | segundo run aberto no mesmo turno é recusado pelo REPOSITÓRIO com motivo, não por violação de constraint |
| 4 | `markSubmitting` é CAS: versão obsoleta devolve `version_conflict` com a versão corrente |
| 5 | `remote_run_id` é atribuído UMA vez; o MESMO id redelivered é idempotente; id diferente vira `remote_id_conflict` **e leva o run a `blocked`** (invariante 3 do §5.6.2) |
| 6 | submit sem prova de aceite vira `submission_unknown`, preservando a MESMA `request_key` e mantendo `remote_run_id` NULL |
| 7 | terminal com chamada em voo é recusado (`calls_unsettled`); conciliada a chamada, o terminal entra e o run vai a `result_ready` |
| 8 | terminal que AFIRMA uma chamada inexistente no journal é `observed_calls_mismatch` (§5.3.4: o journal confronta a alegação do motor) |
| 9 | cross-tenant: o run de outro escopo é `not_found` — o escopo vem do ALS, nunca do argumento |
| 10 | CAS de versão com a fase ainda `prepared` (ver abaixo) |

**Verificação por mutação — e o defeito que ela encontrou em MIM.** Seis mutações, com `--retry=0`.
Na primeira rodada **M6 SOBREVIVEU**: trocar `row_version = <esperada>` por `row_version >= 0` no CAS
de `markSubmitting` não quebrava teste nenhum, porque o caso 4 era carregado inteiro pela guarda de
fase (depois do primeiro submit a fase já não é `prepared`). Ou seja: `expected_row_version` não
estava sendo exercido por ninguém. O caso 10 foi escrito exatamente para o cenário em que a guarda de
fase NÃO basta — uma reserva de poll move `row_version` sem mover a fase — e depois dele as seis
mutações morrem (M1 lease ignorada, M2 prioridade invertida, M3 id divergente como redelivery,
M4 terminal com chamada em voo, M5 segundo run aberto, M6 CAS sem versão). Arquivo restaurado
byte-a-byte ao fim da varredura.

> **CORREÇÃO (V-018): a frase acima superdeclara o que foi provado.** O que eu rotulei de "M2 —
> prioridade invertida" trocava apenas os DOIS LITERAIS `reason` um pelo outro. A inversão de verdade
> — subir o teste de `status !== 'running'` para ANTES do teste de posse — é um mutante bem mais forte,
> e eu confirmei pessoalmente que ele **SOBREVIVE 10/10**. Ou seja: a suíte prende o TEXTO do motivo,
> não a REGRA de prioridade do §5.6.4. "6/6 mortas" vale para as seis que rodei; não vale como prova
> da regra de prioridade. A lição é a mesma da segunda lição acima, um nível mais fundo: um mutante
> precisa ser conferido pelo que ele MUDA no comportamento, não pelo nome que eu dei a ele.

**Segunda lição, do mesmo harness.** Depois do `prettier --write` a varredura foi REFEITA, e o harness
acusou `ERRO-HARNESS` em M2: o prettier trocou aspas simples por duplas no fonte, e o par literal
`reason: 'stale_claim',` deixou de casar. Um harness que casa TEXTO é frágil a reformatação, e o modo
de falha é o pior que existe — silencioso, e do lado errado: a mutação simplesmente não é aplicada, o
teste passa, e a linha lida como se a mutação tivesse sobrevivido (ou passa despercebida, se ninguém
reler a saída). Reancorado em `reason: "stale_claim",` — literal que ocorre uma vez só, já que a união
de tipos escreve `"stale_claim" | "state_mismatch"` —, as seis voltam a morrer, com baseline 10/10 e
arquivo restaurado idêntico. Consequência de método, registrada para as próximas unidades: **a
varredura de mutação roda DEPOIS do formatador, nunca antes**, e a saída do harness precisa ser lida
linha a linha — "sem sobreviventes" só vale se as seis tiverem sido de fato APLICADAS
(`ocorrencias=1` em cada).

**Suíte unitária completa** (`npm test`, workers default): `10233 passed | 50 failed | 1055 skipped`
em 924 arquivos, 20 arquivos em falha. **Nenhuma das 50 é atribuível a esta unidade**, e a razão não é
opinião: `engine-repos.ts` não é importado por NADA em `src/` nem em `tests/` além do próprio spec
desta unidade (verificado por varredura), e um teste que nunca carrega o módulo não pode mudar de
comportamento por causa dele. Dezesseis dos 20 arquivos batem com o catálogo do V-007. Quatro **não**
batem — `runtime/outbound-trava-envio-direto` (2), `scripts/audit-exceptions` (6), `scripts/check-node`
(1) e `ops/privacy-export-sweeper` (8 contra 7) — e foram rodados isolados: falham por ambiente
Windows (o inventário do #634 compara caminhos POSIX com `src\agent\...` e por isso falha nos DOIS
sentidos ao mesmo tempo; symlink/hard link dá EPERM). **Correção de uma afirmação minha:** eu havia
escrito que `scripts/audit-exceptions` falha porque "`npm audit` não roda aqui" — isso está ERRADO. O
gate `npm run audit:exceptions:check` passa neste ambiente (2 lockfiles auditados, relatório válido,
0 advisories). A causa real das 6 falhas daquele spec **não foi determinada**, e enquanto não for ela
não é atribuída a ninguém. Ver risco aberto
abaixo. E aqui vale corrigir uma leitura apressada minha: **"fora do catálogo do V-007" não significa
"novo"**. O próprio V-007 declara 54 falhas mas itemiza só 15 arquivos, que somam 40 — ou seja, 14
falhas nunca foram itemizadas lá. Os quatro arquivos em questão somam exatamente 10 falhas, que cabem
dentro dessa lacuna. A hipótese mais provável, portanto, é catálogo incompleto na baseline, não
regressão. E como hipótese não é medição, a rodada foi REFEITA com as flags do V-007
(`npm test -- --maxWorkers=3`): resultado **byte a byte idêntico** ao da rodada com workers default —
`20 failed | 770 passed | 134 skipped` em arquivos, `50 | 10233 | 1055` em testes, com o MESMO conjunto
de arquivos. Duas contagens iguais sob concorrências diferentes significam que essas falhas são
**determinísticas**, e não inflação por paralelismo. Somando as três evidências — nada importa
`engine-repos.ts` fora do próprio spec, as falhas são determinísticas sob duas configurações, e as 10
falhas dos quatro arquivos cabem nas 14 que o V-007 nunca itemizou — a conclusão é que elas não vêm
desta branch. O que continua NÃO medido é a baseline no commit base com o catálogo completo; por isso
o V-007 passa a ser tratado como lista PARCIAL, e não como lista fechada.

**O que esta unidade NÃO prova:** nada sobre concorrência REAL (as corridas são exercidas por snapshot
obsoleto, não por duas transações simultâneas disputando o mesmo run — ver T17, marcado parcial);
nada sobre `admitToolCall`/`settleToolCall`/recovery/varredura, que não existem ainda; nada que dependa
de Redis/BullMQ; e nenhum CI rodou sobre este código.

**Revisão independente por subagente:** em curso no momento desta escrita, com acesso à spec, à DDL,
ao código e às evidências (não ao meu resumo). O resultado e as correções entram nesta entrada
**antes** do commit.

### V-018 · Revisão independente de P03.2 — **REPROVADA**, unidade em rework

Subagente adversarial com acesso à spec (§5.6.1–5.6.4, §5.7.1–5.7.3), à DDL da 140, ao código e às
evidências — **não** ao meu resumo. Trabalhou read-only, montando um harness de módulo-sombra no
scratchpad para rodar mutações sem tocar na árvore. Confirmou 10/10 contra Postgres real e os gates
estáticos; **derrubou** a alegação de mutação e achou dois BLOCKERs.

**O que eu verifiquei PESSOALMENTE antes de aceitar** (§7 — resumo de subagente não basta):

| Achado | Minha verificação |
|---|---|
| **BLOCKER 1** — `recordStartObservation` e `recordTerminalProposal` nunca se prendem ao `origin_claim_token` DO RUN | **Confirmado por leitura**: o predicado SQL existe numa linha só (`:644`, em `markSubmitting`). Nas outras duas o token só é passado para `lockTurnAndCheckFence`, que pergunta "você é o dono do TURNO?", nunca "você é a origem DESTE run". Depois de um re-claim (`turn-repos.ts` roda `claim_token = gen_random_uuid()` junto com `attempt_count + 1`), o **novo** dono passa no fence com o token dele e pode atribuir `remote_run_id` e gravar `terminal_json`/`result_ready` no run do dono ANTIGO — enquanto `origin_claim_token` continua, por trigger, apontando para o antigo. §5.7.1 permite ao novo dono consultar/cancelar/reconciliar, e proíbe exatamente isto: adotar o run em voo como nova autoridade |
| **BLOCKER 2** — gate de controle de conversa ausente em duas das quatro operações | **Confirmado por leitura**: `:429-435` e `:607-613` checam `mode !== 'bot'`; `:693-697` e `:886-890` checam só se a linha existe. Com o operador no controle (`mode='human'`, epoch++), um terminal ainda entra em `result_ready` — o estado que a adoção consome para produzir texto de saída. E `ControlConflict` está declarado no tipo de retorno das duas, sem nenhum caminho que o produza |
| **M2 era um mutante fraco** | **Confirmado por execução minha**: a inversão REAL de prioridade (estado antes de posse) **sobrevive 10/10**. Ver a correção inserida no V-017 |
| 14 de 15 mutações adicionais sobrevivem | Aceito como direção (o relatório traz linha e razão de cada uma); vou reproduzir as que virarem teste, uma a uma, em vez de confiar na tabela |

**Outros achados relevantes:** redelivery de terminal IDÊNTICO devolve `phase_conflict` em vez de ser
idempotente — e a guarda `AND terminal_hash IS NULL` é **código morto**, porque o gate de fase já
recusa toda fase em que `terminal_hash` poderia ser não-nulo (o padrão certo já existe neste mesmo
arquivo, no caminho de `remote_run_id`); `origin_turn_attempt` fencado em 1 de 4 operações, contra o
`t.attempt_count = r.origin_turn_attempt` normativo do §5.6.4; `classificarConflitoDeRun` devolve
`version_conflict` para falha de posse, que o §5.6.4 manda ser `stale_claim`; `dedupe_key` pode
estourar (`remote_run_id` aceita 512 chars, `dedupe_key` só 256) e transformar justo o
`remote_id_conflict` em exceção; `mode` é gravado e nunca lido (coerente com C12, mas registrado).

**Consequência:** `U-P03.2` **não é dada por concluída e nada foi commitado**. O rework vai em três
frentes — (A) fencing: ligar as duas operações ao `origin_claim_token` do run, fencar
`origin_turn_attempt`, aplicar mode+epoch, corrigir a classificação; (B) semântica do terminal:
redelivery idêntico idempotente e `dedupe_key` limitado; (C) testes que mordam, começando pelos
mutantes que sobreviveram (`handler_started` tratado como conciliado, terminal aceito de
`prepared`/`submitting`, isolamento por AGENTE dentro do mesmo tenant, e a inversão de prioridade).
Teste que falha primeiro, em cada um.

**O valor da revisão, registrado sem suavizar:** meus 10 casos passavam, todos os gates estáticos
passavam, a varredura de mutação dizia "sem sobreviventes" — e ainda assim duas operações aceitavam
escrita de quem não era dono do run. Suíte verde não é evidência de fence; só teste que constrói o
cenário do atacante é.

### V-019 · P03.2 — rework depois da reprovação, e a lição sobre teste de CENÁRIO

**Correções aplicadas** (cada uma com teste que falha ANTES):

| Achado | Correção | Caso que a prende |
|---|---|---|
| BLOCKER 1 — operação não se prende à origem do run | `checarFenceDoRun`, chamado nas duas operações sob a linha já travada por `FOR UPDATE`. Uma checagem cobre TODOS os ramos (aceite, unknown, bloqueio, terminal), em vez de espalhar predicado por UPDATE | 11, 12, 25, 26 |
| BLOCKER 2 — gate de controle ausente | mode + epoch no mesmo helper; `ControlConflict` deixou de ser tipo inalcançável | 13, 27, 28 |
| Redelivery de terminal idêntico | compara `terminal_hash` ANTES do gate de fase (tinha de ser antes: `result_ready` não está entre as fases que aceitam terminal) — igual = idempotente, diferente = `terminal_conflict`. A guarda `AND terminal_hash IS NULL` era código MORTO | 15 |
| `origin_turn_attempt` fencado em 1 de 4 | predicado normativo do §5.6.4 no CAS de `markSubmitting` + no helper | 26 |
| `classificarConflitoDeRun` devolvia `version_conflict` para perda de posse | posse primeiro, `stale_claim` | 14 |
| `dedupe_key` podia estourar 256 e virar exceção | digest de 32 chars em vez do id cru (512 permitidos) | 24 |

**A lição, que é sobre teste e não sobre código.** Escrevi 11, 12 e 13 como cenários REALISTAS: o
re-claim troca `claim_token` **e** `attempt_count` na mesma UPDATE; o takeover muda `mode` **e**
`control_epoch` juntos. Os três passavam. A varredura mostrou **NM1, NM2, NM3 e NM4 sobrevivendo**:
com dois predicados redundantes cobrindo o mesmo cenário, apagar qualquer um deixa o outro recusando,
e o teste não percebe. Um teste que muda duas variáveis ao mesmo tempo não consegue dizer qual delas
importou — e uma regra que nenhum teste isola apodrece no próximo refactor sem ninguém notar. Os
casos 25-28 mudam UMA variável cada (token sem tentativa, tentativa sem token, modo sem epoch, epoch
sem modo), e só então os quatro morrem. **Eu previ que NM1 e NM3 morreriam; erraram os dois.** Vale
registrar que o cenário realista continua no lugar: ele prova a garantia ponta a ponta, que o
cirúrgico não prova. Os dois tipos servem para coisas diferentes.

**Estado final:** 28 casos contra Postgres real, verdes. **13 mutantes, todos mortos** — M1-M6, o
M2-REAL (a inversão de prioridade que sobrevivia) e NM1-NM6. `typecheck` (projeto), `eslint` e
`prettier --check` limpos; EOL LF conferido por contagem de bytes.

**O que continua SEM cobertura, dito sem maquiagem:** concorrência real (duas TX simultâneas
disputando o mesmo run) — a suíte é sequencial, e por isso a distinção `clock_timestamp()` vs `now()`,
que o cabeçalho do arquivo justifica em quatro linhas, permanece **não verificada**; a metade
"ausência de outbound" do §5.6.3 (adiada e agora NOMEADA no cabeçalho do módulo); `mode` gravado e
nunca lido (C12); e ausência de teto de lock (C11). Nada disso foi fechado por esta unidade.

### V-020 · P03.3a — admissão de tool call

Unidade: `admitToolCall` em `engine-repos.ts` + `tests/integration/hermes-engine-tool-calls-real-db.spec.ts`
(novo, 10 casos). Arquivo de teste separado do journal de start porque a pergunta é outra: lá era "de
quem é este run", aqui é "esta chamada pode entrar, e o que se responde a quem já perguntou antes".

| Caso | O que prende |
|---|---|
| 1 | primeira chamada entra como `received`, ordinal 0 |
| 2 | **T26** — redelivery do mesmo `call_id`/`args_hash` com o vencedor em voo devolve `in_progress`, e **não** cria segunda linha |
| 3 | **T26** — redelivery de chamada já conciliada devolve o resultado PERSISTIDO (repetir o handler repetiria o efeito) |
| 4 | **T27** — mesmo id com args diferentes é `payload_conflict`, e o `args_hash` gravado não muda |
| 5 | `ordinal` fora de ordem é recusado — o UNIQUE da 140 impede duplicata, não desordem |
| 6 | piloto sequencial: com uma call pendente, outra NOVA é recusada |
| 7 | **callback adiantado**: em `submitting` a call entra como `received` e a resposta é `in_progress`, nunca execução |
| 8 | `result_ready` não libera chamada nova |
| 9 | re-claim: o novo dono não admite call no run do dono antigo, e nada é inserido |
| 10 | token rotacionado SEM avançar a tentativa (ver a lição abaixo) |

**`args_hash` é derivado, não transportado.** O wire não tem campo de hash (`grep -c hash` em
`protocol.ts` = 0), e nem a spec nem a DDL dizem como derivá-lo. Como o valor nunca atravessa a
fronteira, não há acordo entre linguagens a manter: Maia deriva com `canonicalDigest(args)`, que sai
em 64 hex puros e satisfaz o CHECK — enquanto o hash da casa (`computePayloadHash`) sai com prefixo
`v2:` e seria REPROVADO nessa coluna. Registrado como C13.

**A lição, de novo — e desta vez eu a previ.** Sete mutantes. Seis morreram de primeira; o do fence de
origem (AM7) **sobreviveu**, exatamente como eu tinha escrito antes de rodar. Causa idêntica à do
V-019: o caso 9 é o re-claim REALISTA, que troca token e tentativa na mesma UPDATE, então apagar o
predicado de token deixa o de tentativa recusando. Uma ressalva honesta sobre o que esse "sobreviveu"
significa: o literal é o mesmo do fence compartilhado, e ele **já morre** no spec do journal (caso 25).
A sobrevivência era, portanto, do escopo da varredura — que roda um arquivo só —, não uma regra
desprotegida. Mesmo assim o caso 10 entrou: a admissão não pode depender de um teste que mora em
outro arquivo, porque basta alguém lhe dar um fence próprio para a garantia sumir sem ninguém
reclamar. Com ele, os sete morrem.

**Gates:** `prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed |
10233 passed | 1083 skipped (11366)`, os MESMOS 20 arquivos em falha de antes, e nenhuma falha citando
`engine-repos` ou `tool-calls`. Pulados sobem 1073 → 1083 e arquivos 924 → 925: exatamente o spec novo
(`↓ 10 tests | 10 skipped`). Aritmética fechada de novo.

**O que esta unidade NÃO faz:** não executa nada (a admissão só decide se a chamada entra e o que se
responde); não cobre `freezeToolIdentity`, `markToolHandlerStarted` nem `settleToolCall` (P03.3b/c);
não traduz nada para `EngineToolReplyV1` — isso é gateway, P05; e não há teste de concorrência real.
Uma consequência registrada: seguir o item 3 à risca faz um redelivery com `iteration` diferente virar
`payload_conflict`. É mais estrito que tratar `iteration` como telemetria, e é o que o texto normativo
manda; está comentado no código para quem reavaliar.

### V-021 · P03.3b — `markToolDispatching` e `freezeToolIdentity`

Duas operações e duas decisões registradas antes de codar (C14 e C15), porque nenhuma das duas estava
resolvida no texto:

* **C14** — a tabela do §5.6.3 nunca nomeia a transição `received → dispatching`, mas o §5.6.4 a
  pressupõe: o UPDATE de `markToolHandlerStarted` exige `state='dispatching'` com `dispatch_token`
  IGUAL, e alguém tem de ter atribuído esse token. Virou operação própria em vez de ser embutida no
  freeze (outra responsabilidade) ou na admissão (que não pode classificar — a classificação vem do
  registry, fora do journal).
* **C15** — `normalized_args_json` não tinha significado definido em lugar nenhum, e a função da casa
  com esse nome (`normalizePayload`) devolve um HASH, não JSON, e ainda aplica transformações de
  domínio (`valor`→`valor_centavos` etc.) que distorceriam args arbitrários de engine. A coluna passou
  a guardar a forma canônica sobre a qual o `args_hash` é computado — e a operação **verifica** isso
  em vez de confiar no chamador: `normalized_args_mismatch` se redigerir não reproduzir o hash.

**Recusas que acontecem antes de o dispatcher existir na história** (§5.6.4): `effect_class` nulo
(§4.1: "null NUNCA autoriza handler") e prazo restante abaixo de `minimumBudgetMs(classe)` — 250ms
para `abort_safe`, 1750ms para as demais, reusando a função da casa em vez de um número inventado.
Começar algo `non_interruptible` com 300ms de prazo é fabricar efeito incerto.

**Mutação — 7 mutantes, e a previsão quase fechou.** Eu previ 4 mortes e 3 sobreviventes; o placar real
da primeira rodada foi 3 mortes e **4 sobreviventes**. O erro foi o BM3 (guarda de `state='received'`
no CAS da call), que eu disse que morreria pelo caso 14. Diagnóstico: o caso 14 chama a operação duas
vezes com a MESMA `expected_row_version`, então depois do primeiro sucesso a linha está em
`dispatching` **e** com `row_version` 1 — as duas guardas recusam a segunda chamada, e apagar qualquer
uma delas deixa a outra recusando. É o mesmo padrão dos casos 25-28 do spec do journal, um nível mais
fundo: eu tinha até desambiguado o literal contra o `markSubmitting`, mas não percebi a redundância
ENTRE os dois predicados do mesmo CAS. Os outros três sobreviventes (BM4, BM5, BM7) eram o que eu
esperava, e dois deles não eram redundância e sim **ausência de teste**: nada exercitava a invariante
do C15 nem o freeze a partir de um estado que não fosse `dispatching`.

Os casos 17-20 isolam um predicado cada — estado sem versão, versão sem estado, args que não batem
com o hash, freeze antes de `dispatching`. Com eles, **os sete morrem**.

**Estado final:** 20 casos no spec de tool calls (10 de P03.3a + 10 desta unidade), verdes.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1093 skipped (11376)`, os MESMOS 20 arquivos de sempre, nenhuma falha citando `engine-repos` ou
`tool-calls`, e os pulados subindo exatamente os 10 casos novos (`↓ 20 tests | 20 skipped`).

**O que NÃO está feito:** `markToolHandlerStarted` (P03.3c) e `settleToolCall` (P03.3d) — ou seja,
`reservation_token` e `approval_claim_token` ainda não são persistidos por ninguém, e `effect_evidence`
continua `none` em toda call. Também segue sem teste de concorrência real.

### V-022 · P03.3c — `markToolHandlerStarted`, o marcador de início

O UPDATE do §5.6.4 linha 1190, implementado como está escrito: CAS por `dispatch_token` com
`state='dispatching'`, `handler_started_at IS NULL`, identidade congelada e `row_version` esperada,
sob run `running`/não-revogado/prazo vivo e fence do turno atual. É o que separa "não começou" de
"pode ter começado" — depois deste COMMIT, nenhuma recuperação tem direito de afirmar ausência de
efeito para uma classe que carrega efeito.

`effect_evidence` sobe para `possible` **antes** de o handler rodar, e a decisão vem do contrato
(`classifyToolCancellation(...).outcome === 'effect_unknown'`), não de um `!== 'abort_safe'` escrito à
mão: classe nova no vocabulário herda o comportamento conservador sozinha, e valor fora do vocabulário
já cai no ramo conservador do próprio contrato. O caso 22 prende o outro lado — `abort_safe` **não**
eleva evidência, porque abortar uma leitura não deixa nada para reconciliar.

**Um defeito REAL achado pela varredura.** Com o marcador já carimbado, a operação caía em
`version_conflict` — com `current_row_version` IGUAL à versão pedida. Um motivo que não explica nada e
que sugere a reação errada: `version_conflict` convida a reler e tentar de novo, e "tentar de novo" é
exatamente o que não se pode fazer com um handler que já pode ter rodado. Virou razão própria,
`already_started`, com o caso 29 a prendendo (carimbo posto por fora, estado e versão intactos — o
único input que isola aquela guarda, já que o caso 23 move as três coisas de uma vez).

**Mutação: 7 mutantes, previsão 6/7.** Previ CM1-CM6 mortos e CM7 sobrevivente. CM7 sobreviveu como
esperado (redundância tripla no caso 23). O erro foi CM3: eu previ morte e ele sobreviveu — mas a
causa **não** era falta de teste, e sim do harness. Eu mutei só `idempotency_key IS NOT NULL`, e o
`identity_chk` da 140 garante que as duas colunas de identidade andam juntas, então
`idempotency_payload_hash IS NOT NULL` continuava recusando sozinho. Reancorado para mutar **as duas**,
CM3 morre pelo caso 25. Lição: mutar metade de um predicado PAREADO mede o harness, não o teste.

**Terceira vez que uma sequência de escape não sobrevive à camada de shell** — antes foram o `$'\r'`
do grep (que reportava CR invertido) e o caminho POSIX entregue ao Node (que virou `C:\c\Users\...`).
Desta vez o `\n` de um patch virou newline literal dentro de string JS e quebrou o harness na carga.
O arquivo foi **reescrito sem nenhum escape**: partes em aspas simples (que mantêm `${...}` literal)
unidas por `String.fromCharCode(10)`. Vale como regra para as próximas unidades. Confirmei também que
o script quebrado morreu na CARGA, sem tocar em `engine-repos.ts` — os quatro predicados reais seguiam
presentes uma vez cada e zero mutantes vazados.

**Estado final:** 29 casos no spec de tool calls, verdes; 7 mutantes, todos mortos.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1102 skipped (11385)`, os MESMOS 20 arquivos, nenhuma falha citando `engine-repos` ou `tool-calls`, e
os pulados subindo exatamente os 9 casos novos.

**O que NÃO está feito, e por que `settleToolCall` (P03.3d) virou decisão e não fiação:** o §5.6.3 pede
que o settle "ligue atomicamente o completion de idempotência ao receipt", mas (a)
`markCompletedWithEffect` abre a PRÓPRIA `withTx`, e como o `withTx` desta casa faz `pool.connect()` +
`BEGIN`, chamá-la de dentro da minha TX pegaria **outra conexão e outra transação** — "atômico" seria
afirmação falsa; o próprio §5.6.3 antecipa isso e manda "extrair helper SQL que aceite executor TX";
(b) varredura confirma que **nenhuma** fachada de `idempotency-repos.ts` aceita executor hoje, então
esse helper não existe e criá-lo mexe em módulo compartilhado; e (c) `PlannedEffect` é união de efeitos
de MENSAGEM (WhatsApp e afins), não de efeito arbitrário de ferramenta — ou seja, a variante com outbox
pode estar errada em ESPÉCIE, não só em forma de transação. Nada disso foi decidido ainda.

### V-023 · P03.3d — `settleToolCall`, e o fim da faixa de tool calls

Liquida a call sob duas regras que o `dispatch_token` sozinho não garante:

* **Fence do turno ATUAL** (§5.7.4 item 8). Quem perdeu a posse não liquida — o token da call não
  autoriza adotar resultado tardio. Um reconciliador autorizado usa operação separada, com o próprio
  claim/row_version; não esta. O caso 35 isola isso girando SÓ o token do turno.
* **`cancelled` só para `abort_safe`** (item 9). Nas demais classes, cancelar depois do handler seria
  afirmar ausência de efeito sobre algo que pode ter acontecido; a operação RECUSA
  (`cancellation_not_allowed`) e aponta `effect_unknown` como o desfecho honesto — que segue
  bloqueador mesmo que um HTTP 200 chegue depois.

A evidência de efeito respeita o gatilho monotônico da 140: `completed` em classe com efeito vira
`committed`, `effect_unknown` vira `unknown` (o `unknown_chk` da tabela exige essa coerência), e
`abort_safe` fica em `none`. Nada escreve `none` por cima de `possible`.

**Mutação: 8 mutantes, previsão exata pela primeira vez.** Previ DM1-DM6 mortos e DM7 sobrevivente, e
foi isso. E DM7 **não** era redundância: a validação do hash do receipt existia no código e nenhum
caso a exercitava — `invalid_receipt` era alcançável e indefeso. O caso 38 fecha. Vale registrar o que
ele mostra: sem a validação, o `receipt_chk` da 140 ainda barra, mas transformando uma recusa TIPADA
numa transação que estoura. O banco é a rede de segurança, não a primeira linha.

**O acoplamento que NÃO foi feito, de propósito (C16).** O §5.6.3 pede ligar o completion de
idempotência ao receipt. Não dá hoje sem reescrever módulo compartilhado:
`markCompletedWithEffect` abre a PRÓPRIA `withTx`, e como o `withTx` desta casa faz `pool.connect()` +
`BEGIN`, chamá-la de dentro do settle pegaria outra conexão — "atômico" seria afirmação falsa. O
próprio §5.7.4 item 8 contempla esse estado: "Até essa ligação existir, recovery pode ler cache
completo com chave/hash exatos, mas não inferir segurança quando a row já expirou". Entregue assim,
com a limitação nomeada, em vez de eu mexer em `idempotency-repos.ts` de passagem.

**Estado final:** 38 casos no spec de tool calls, verdes; 8 mutantes, todos mortos.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1111 skipped (11394)`, os MESMOS 20 arquivos, nenhuma falha citando `engine-repos` ou `tool-calls`, e
os pulados subindo exatamente os 9 casos novos (`↓ 38 tests | 38 skipped`).

**Defeito de checkpoint corrigido junto:** o `IMPLEMENTATION-STATE.md` tinha DOIS bullets reivindicando
`U-P03.3c` — o correto e um obsoleto, sobrevivente do resplit que o C14 provocou, ainda anunciando o
acoplamento que o C16 descartou. Removido. Um checkpoint que se contradiz é pior que um checkpoint
curto.

**O que falta em P03:** varredura/manutenção (`enumerateDueScopes`, `listDueRuns`,
`reserveMaintenanceObservation`/`recordMaintenanceObservation`), `revokeRunCapabilities`,
`adoptTerminalResult`, `closeRunAfterHandoff`, `markRunBlocked`/`resolveBlockedRun` e recovery. E
segue sem teste de concorrência real em todo o módulo.

### V-024 · P03.4 — `revokeRunCapabilities`, e dois mutantes que eu NÃO matei

Revogação monotônica (§5.6.3, §5.7.2), com três propriedades deliberadas: o carimbo original é
preservado em repetição (`already: true`), nenhum caminho desfaz a revogação, e o ator é
**assimétrico** — o dono prova posse pelo `origin_claim_token` DO RUN, `recovery`/`operator` não
provam. A assimetria não é frouxidão: o cenário que mais precisa de revogação é o do dono que sumiu, e
exigir o token dele ali deixaria capacidades vivas indefinidamente. A operação também **não** passa
pelo gate de controle da conversa, e isso está comentado no código e coberto pelo caso 33: revogar é
o que se quer quando um humano assume, e exigir `mode='bot'` tornaria o botão de parada inútil na
única situação em que ele importa.

**Um defeito MEU, do tipo que o §6 proíbe nominalmente.** O retorno de recusa preenchia
`current_status: "unknown"` e `current_state_version: 0` para caber no shape de `TurnFenceConflict` —
estado **inventado**, apresentado como se tivesse sido lido, num caminho que para `recovery`/`operator`
nem chega a ler o turno. Varredura confirmou que era o único sítio do módulo assim: os outros cinco
preenchem o shape a partir do turno REAL. Corrigido com razão própria, `not_run_origin`, que devolve o
`origin_claim_token` do run e não promete nada que não mediu.

**Dois mutantes registrados como NÃO-MATÁVEIS, com o motivo.** Previ 3 mortes e 2 sobreviventes;
o placar da primeira rodada foi 2 e 3 — errei em EM3, que eu disse que morreria. Causa: o caso 31
passa um token aleatório, então `lockTurnAndCheckFence` recusa ANTES de a checagem de origem do run
rodar; ela nunca era exercida. O caso 34 constrói o input que faltava (turno re-reivindicado, chamador
com o token NOVO: dono do turno, não origem do run) e mata EM3.

EM1 (guarda `IS NULL` no UPDATE) e EM2 (retorno antecipado de já-revogado) continuam vivos, e o caso 35
— escrito exatamente para matar EM2 — **não matou**. A razão importa mais que o placar: existe um
TERCEIRO caminho, o re-read do ramo `if (!linha)`, que devolve `{ok, already: true, revoked_at}`
idêntico. Os três se substituem mutuamente; qualquer um sozinho produz o contrato observável. Uma
suíte sequencial não consegue separá-los porque eles diferem em QUAL caminho responde, não no que o
chamador vê — e a guarda `IS NULL` existe para a corrida leitura→escrita, que este rig não alcança.
Fabricar um caso que os distinguisse seria testar o roteamento interno, não o contrato. Ficam
registrados como defesa em profundidade e lacuna conhecida, em vez de contados como cobertos.

**Outro defeito meu, no teste:** o caso 30 comparava dois `timestamptz` com `toBe` e falhava com
`expected X to be X`. O driver devolve `Date`, e dois `Date` do mesmo instante não são `Object.is`
iguais — a anotação `<{ ...: string }>` no genérico mentia para o compilador sem mudar o que vem do
banco. Resolvido com `::text` na query.

**Estado final:** 35 casos no spec de runs, verdes; 5 mutantes, 3 mortos e 2 documentados acima.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1118 skipped (11401)`, os MESMOS 20 arquivos, nenhuma falha citando `engine-repos` ou `tool-calls`, e
os pulados subindo exatamente os 7 casos novos (`↓ 35 tests | 35 skipped`).

**O que falta em P03:** `adoptTerminalResult`, `closeRunAfterHandoff`, `markRunBlocked`/
`resolveBlockedRun`, varredura/manutenção e recovery. E segue sem teste de concorrência real.

### V-025 · P03.5 — `markRunBlocked` e `resolveBlockedRun`, a porta operacional

Contrato normativo mínimo (C17): quatro fragmentos, nenhuma seção. A forma de "evidência" e "decisão"
foi definida aqui e registrada, em vez de inferida em silêncio.

**O que `blocked` faz que `closed` não faria:** preserva a trava. A unique parcial da 140 cobre
`phase <> 'closed'`, e bloqueado não é fechado — então o run continua ocupando a vaga do turno e
ninguém abre outra deliberação por baixo (§5.6.2 invariante 7), mesmo com o turno em dead letter. O
caso 37 prende isso pelo comportamento: tentar preparar outro run no mesmo turno devolve
`run_already_open`.

**"Nenhuma liberação automática por TTL" virou impossibilidade, não convenção.** Não existe parâmetro
de tempo na assinatura de `resolveBlockedRun`, e nenhum caminho fecha sem `operator_ref` não-vazio E
evidência não-vazia — as duas recusas acontecem ANTES de qualquer lock, porque não faz sentido travar
o controle para descobrir que ninguém assinou a decisão. Um runbook dizendo "confira antes" é
exatamente o tipo de garantia que falha às três da manhã; aqui a chamada não é escrevível.

**Interação deliberada com P03.4:** fechar exige `capabilities_revoked_at` (CHECK da 140 em toda linha
`closed`), e o `COALESCE(capabilities_revoked_at, clock_timestamp())` preenche sem sobrescrever o
carimbo monotônico de quem já havia revogado. O mutante FM6 prova a necessidade: sem o COALESCE, um
run nunca revogado estoura o CHECK DENTRO da transação.

**Mutação: 8 mutantes, previsão exata.** Previ FM2-FM6 mortos e FM1/FM7/FM8 sobreviventes, e foi isso.
Diferente das unidades anteriores, os três sobreviventes **não eram redundância** — eram caminho sem
teste nenhum: run já fechado (`already_closed` inalcançável), teto de evidência e o bump de
`row_version` ao bloquear. Os casos 43-45 fecham os três, e o 45 prende o bump pelo COMPORTAMENTO
(um CAS com a versão velha passa a perder) e não pela contagem.

**Ambiguidade de harness evitada ANTES de medir**, aplicando a lição que custou caro em P03.3b/c:
`SET phase = 'blocked'` aparece 2x no módulo (o `recordStartObservation` também bloqueia, em conflito
de `remote_run_id`), `AND phase <> 'closed'` 3x e `row_version = row_version + 1` 11x. Mutar qualquer
um desses literais soltos mediria outra operação. Todos foram ancorados em blocos multi-linha únicos —
o que distingue o `markRunBlocked` é a linha seguinte com `last_error_code` PARAMETRIZADO, contra o
literal `'remote_id_conflict'` do outro sítio.

**Defeito meu, corrigido:** o título do caso 43 saiu com um "не" cirílico no lugar de "não". Corrigido,
e uma varredura por qualquer caractere cirílico/grego nos dois specs e no módulo voltou **limpa** —
era caso isolado, não contaminação sistemática de digitação.

**Estado final:** 45 casos no spec de runs, verdes; 8 mutantes, **todos mortos**.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1128 skipped (11411)`, os MESMOS 20 arquivos, nenhuma falha citando `engine-repos` ou `tool-calls`, e
os pulados subindo exatamente os 10 casos novos (`↓ 45 tests | 45 skipped`).

**O que falta em P03:** `adoptTerminalResult`, `closeRunAfterHandoff` (os dois dependem de estado de
outbound/entrega e vão juntos), varredura/manutenção (`enumerateDueScopes`, `listDueRuns`,
`reserveMaintenanceObservation`/`recordMaintenanceObservation`) e recovery. E segue sem teste de
concorrência real em todo o módulo.

### V-026 · P03.6a — `adoptTerminalResult`, e a assimetria que só ela tem

**O fence aqui é do turno ATUAL, não da origem do run** — e é a primeira operação do módulo em que
isso é certo. Todo o resto exige `origin_claim_token` porque autoriza EFEITO: despachar tool, marcar
handler, liquidar. Adotar não autoriza efeito nenhum — pega um terminal já persistido e diz quem
assume a saída. O §5.8.2, na linha "terminal externo persistido, sem output", manda o NOVO owner
validar política/calls/contexto e adotar, em vez de pagar outra deliberação porque um worker foi
reenfileirado. `adopted_by_turn_attempt` existe para registrar QUAL tentativa assumiu, e o caso 47
prende exatamente isso: depois de um re-claim, quem adota é a tentativa nova, e o número gravado é o
dela.

O `engine_runs_adopted_chk` diz no próprio comentário o que está em jogo: entregar ou concluir sem
resposta exige terminal E dono que adotou, "é o que impede 'fechei o run' virar sinônimo de 'alguém
decidiu o desfecho'". Por isso adotar **não** fecha o run (fechar é 6b, com prova própria), **não**
reautoriza callbacks antigos (`capabilities_revoked_at` fica intacto) e **não** transiciona
`agent_turns` — o §5.7.2 lembra que `phase` não substitui `status`, e um run fechado convive com turno
`outbound_pending`.

**Mutação: 5 mutantes, previsão exata, todos mortos.** Ambiguidade tratada ANTES de medir, aplicando a
lição acumulada: `AND ${versaoEsperada}` já aparece 2x no módulo e `if (!fence.ok) {` aparece **12x**.
Literal solto mediria outra operação; as âncoras multi-linha usam a linha `AND phase = 'result_ready'`
e a linha `conta("adopt", ...)`, que são únicas.

**Um caso sem mutante, registrado em vez de inflado:** o caso 50 (adotar não reautoriza callbacks) não
tem alvo de mutação, porque o código simplesmente **não toca** em `capabilities_revoked_at` — não há
literal a mutar. Ele guarda uma regressão futura, não comportamento presente, e contá-lo como "coberto
pela varredura" seria inflar o placar. Fica como guarda declarada.

**Correção do C18, achada ao preparar o 6b.** O registro anterior dizia que `sent`/`unknown` eram a
prova de outbound. **Errado para o caminho durável:** o marcador de convergência desta casa é
`status='completed'` (`outbound-recovery-repo.ts:289`), e `delivered` é intermediário que um CAS
promove (`:817-824`). Fechar `handed_to_outbox` por `sent` teria declarado handoff sobre linhas que a
casa ainda considera em voo. O predicado de RESOLVIDO é `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES`
(exportado, `['completed','failed_terminal','cancelled','dead_letter']`), deliberadamente mais estrito
que `MULTIPART_RESOLVED_STATUSES` porque `delivered` libera a próxima parte mas "não prova
convergência". Reusar o exportado, não recriar o conjunto.

**Estado final:** 52 casos no spec de runs, verdes; 5 mutantes, todos mortos.
`prettier --check`, `typecheck` (projeto) e `eslint` em 0. **Regressão:** `50 failed | 10233 passed |
1135 skipped (11418)`, os MESMOS 20 arquivos, nenhuma falha citando `engine-repos` ou `tool-calls`, e
os pulados subindo exatamente os 7 casos novos (`↓ 52 tests | 52 skipped`).

**Para o 6b, já levantado:** semear outbound em teste exige a linha durável COMPLETA — o
`outbound_messages_durable_row_complete_check` exige `sequence_in_turn`, `payload_version`,
`payload_type`, `payload_json`, `payload_hash`, `logical_dedupe_key`, `provider_idempotency_key` e
`next_attempt_at` assim que `turn_id` existe. A fixture deve DERIVAR as chaves com
`deriveLogicalDedupeKey`/`deriveProviderIdempotencyKey`/`computePayloadHash` do contrato, não inventar
literais. E `safe_to_retry` exige ausência de outbound **e** de efeito não reconciliado (invariante 7),
então também consulta `effect_evidence`/estados não conciliados de `engine_tool_calls`.

### V-027 · P03.6b — `closeRunAfterHandoff`, a única operação com prova EXTERNA

Todas as operações anteriores do módulo decidem olhando só para `engine_runs`/`engine_tool_calls`.
Esta não pode: o §5.7.2 admite `handed_to_outbox` apenas com "commit outbound comprovado" e o
invariante 7 admite `safe_to_retry` apenas com "ausência de outbound e de efeitos não reconciliados".

**O C18 tem DOIS níveis, e separá-los foi o trabalho conceitual da unidade.** RESOLVIDO é
`OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (reusada, não redigitada — `sql.join` sobre a constante
exportada); SUCESSO é `completed`. Os dois não coincidem: um artefato `cancelled` está RESOLVIDO e não
é entrega. O caso 61 existe só para prender essa diferença — sem ele, um predicado único de "resolvido"
passaria por prova de handoff e o run fecharia `handed_to_outbox` sobre uma saída que nunca houve.

**Adiado e NOMEADO, não omitido:** (a) `closeRunAfterHandoff` não cria `engine_projections`, embora a
tabela de operações do §5.6.3 diga "motivo, evento, projeções" — projeções são a costura do aprendizado
governado (G1–G4, P08/P09), e criá-las agora produziria linhas `pending` que nenhum consumidor
processa, trabalho invisível parado numa tabela; (b) `discarded` não é fechável por esta porta, porque
o §5.7.2 só o cita como "conforme política" e a política é justamente o que a spec não define —
implementá-lo seria inventá-la; (c) a metade outbound do `pinEngineAndPrepareRun` continua pendente,
agora com a consulta de prova já escrita e reusável.

**Decisões de desenho registradas:** o fence do turno é exigido do `turn_owner` e NÃO do `recovery` —
mesma assimetria de P03.4 e pela mesma razão, já que o §5.7.3 item 5 manda o scanner fechar órfãos com
`actor_kind=recovery` e o órfão é exatamente o run cujo dono sumiu (caso 72). `outbound_messages` é
lido **sem `FOR UPDATE`**: travar linha do delivery criaria aresta de lock fora da ordem do §5.6.3, e
ler sem travar é seguro porque o erro possível é FECHADO (linha ainda não convergida faz o fechamento
ser recusado agora e aceito depois, nunca o contrário). A idempotência vem ANTES da porteira de fase,
porque quem repete após crash não está numa fase errada — a ordem inversa devolveria `phase_conflict`
para o caminho FELIZ da retomada, o mesmo defeito que a redelivery do terminal expôs em P03.2.

**Varredura de mutação: 13 mutantes, e um SOBREVIVEU na primeira rodada.** EM9 desliga o predicado de
ESTADO do invariante 7 e sobreviveu com 74/74 verdes. A causa era defeito MEU de teste: o caso 65 movia
duas variáveis de uma vez (`handler_started` **e** `effect_evidence='possible'`), então com o estado
desligado a evidência recusava sozinha e o caso continuava verde — provava a garantia sem provar QUAL
predicado a sustenta. É a mesma lição de M2/NM1/AM7/BM3-BM4/CM7/EM3, desta vez cometida por mim depois
de eu ter escrito que estava isolando. Corrigido usando `effect_evidence='none'` (legal: o
`engine_tool_calls_unknown_chk` só amarra evidência a `effect_unknown`, verificado no banco, e uma tool
`abort_safe` fica mesmo `handler_started` sem evidência). Segunda rodada: **13/13 mortos, zero
sobreviventes, zero erros de harness, arquivo restaurado idêntico**.

O harness desta unidade passou a **ABORTAR** em âncora com `ocorrências != 1`, em vez de só reportar.
Quatro âncoras de uma linha eram AMBÍGUAS (`COALESCE(capabilities_revoked_at, …)` e
`run.origin_claim_token !== …` com n=2, `effect_evidence <> 'none'` com n=2, `actor_kind:
input.actor.kind` com n=3) e teriam mutado `resolveBlockedRun`/`revokeRunCapabilities` junto; todas
viraram blocos multi-linha. Também corrigi um defeito do próprio harness antes de rodá-lo: EM9 trocava
a lista por um identificador inexistente, o que mataria o mutante por `ReferenceError` de carga em vez
de por detecção — o artefato CM3 de P03.3b repetido.

**Dois casos escritos ANTES da varredura, prevendo o mutante:** 73/74 fecham e recusam a partir de
`submitting` com a mesma fase e decisões diferentes, prendendo que cada decisão consulta o SEU conjunto
de fases. Sem eles, EM13 sobreviveria.

**Estado final:** 74 casos no spec de runs, verdes. `typecheck`, `lint` (481 warnings, idêntico à
baseline), `check:node`, `docs:ai:check`, `config:check:drift` e `audit:exceptions:check` todos em
**exit 0**. `prettier --check` nos dois arquivos tocados: limpo.

**Regressão:** `50 failed | 10233 passed | 1157 skipped (11440)` contra `50 | 10233 | 1135 (11418)` do
V-026. Passados e falhos INALTERADOS, os mesmos 20 arquivos, nenhuma falha citando `engine-repos`,
`hermes-engine` ou `tool-calls`; pulados e total sobem exatamente +22, que é o spec crescendo de 52
para 74 casos. Aritmética fechada.

**`npm run test:leak` — executado, e NÃO verde.** O AGENTS.md o marca "critical, run before any
tenant-related change", e esta unidade adiciona consulta escopada por tenant/agent numa tabela que o
módulo nunca tocava, então pulá-lo seria escolher a opção fácil. Resultado pelo procedimento local:
`8 failed | 120 passed | 23 skipped (151)`, 6 arquivos em falha. Classificação honesta:

* **`tests/integration/outbound-leak.spec.ts` — a spec mais próxima desta mudança — PASSOU** (10 casos).
* **Cinco** (`constitutional`, `cross-entity`, `turn-context-statement-count`,
  `tool-request-aggregation-real-db`, `tool-request-triagem-console-real-db`) morrem em
  `loadConfig` (`src/config/env.ts:112`, "Invalid configuration … profile development") na CARGA do
  módulo — as duas últimas nem chegam a rodar caso algum (9 e 14 pulados). É o custo do config local de
  duas etapas, que pula o `globalSetup` de propósito. **Controle executado:** as três unitárias rodadas
  sob o config do PROJETO, no MEU código, passam — `51 passed (51)`, exit 0. Mesmo código, resultado
  oposto ⇒ configuração, não mudança.
* **Uma** (`turn-context-batch-repos.spec.ts`, teste `resolveScope no longer resolves a foreign profile
  into a grant`) é falha de asserção real, determinística, e falha também SOZINHA (`1 failed | 13
  passed`), logo não é interação com o meu spec no lote. **Não é atribuível a esta branch por
  construção:** nada em `src/`/`tests/`/`scripts/` importa `engine-repos` além dos meus dois specs, ele
  não está no barril, e o teste opera só sobre `profiles`/`pessoas`/`permissoes`/`entidades`, que as
  minhas fixtures nunca escrevem — o vitest sequer carrega o módulo alterado nessa rodada. **Mas não
  afirmo que seja preexistente: não há controle em HEAD para ela.** Fica como item aberto.

### V-028 · P03.7a — a varredura, e as duas metades OPOSTAS do escopo

`enumerateDueScopes` e `listDueRuns` existem para se contradizer, e é isso que as torna corretas juntas.

A primeira roda **CROSS-TENANT, sem ALS** — a única operação do módulo que não chama `scope()`, e não
pode chamar: `getCurrentTenant()` LANÇA fora de contexto, e a pergunta "quem tem trabalho vencido?"
não tem tenant para ser feita dentro. Não inventei o padrão: é o mesmo de
`objectivesRepo.reclaimExpiredTaskLeases` e da varredura de lease vencida da 114 (`db.execute` cru,
sem `scope()`), e o consumidor entra em `runWithTenantContext` por par depois, como `briefings.ts`
já faz. O preço de abrir mão do escopo é NÃO DEVOLVER CONTEÚDO: o retorno é o par e o cursor. O caso 2
prende isso pelas CHAVES EXATAS do objeto — um `turn_id` ou um `due_at` que vazasse ali seria dado de
um tenant atravessando uma leitura que nenhum tenant autorizou.

A segunda roda **sob ALS** e garante o isolamento de que a primeira abre mão (caso 9), lançando fora
de contexto (caso 8). `maintenance_only` é derivado do COMPLEMENTO de `RECOVERABLE_TURN_STATUSES`, e
não de um literal: a constante já existe no contrato de turnos e já deixa `outbound_pending` FORA com
a razão escrita ("a resposta já foi comprometida e quem finaliza é o delivery worker, nunca uma nova
execução do reasoner") — que é exatamente a primeira frase do §5.8.4. Reusá-la faz a classificação
acompanhar sozinha um estado novo do contrato; os casos 10/11/12 prendem os três lados.

**C19 registrado antes de implementar:** a spec exige "pares escopados **e cursor**" e "próxima
**janela finita** de observação" sem definir nenhum dos dois, e a casa não tem precedente
(`listTenantAgentPairsWithActiveOwner` não tem limite nem cursor). Decidi cursor KEYSET na ordem do
índice parcial REAL (conferido no banco, não só na migration) e a janela como PARÂMETRO — escolher o
número aqui seria política minha disfarçada de leitura, o mesmo erro que o C18 teve de corrigir.
Offset está descartado por um motivo concreto: o conjunto muda entre páginas por construção, porque a
própria manutenção reescreve `next_poll_at`.

**Teste num mundo POLUÍDO, medido e não suposto:** o banco local já tinha 4 escopos e 6447 runs
vencidos de rodadas anteriores, e `tests/setup.ts` não trunca nada. Asserção de igualdade de conjunto
ali passaria ou falharia conforme o lixo do dia, então as asserções cross-tenant são de INCLUSÃO e de
invariante de paginação (sem lacuna, sem duplicata), e `listDueRuns` usa um tenant dedicado por caso.

**Varredura: 12 mutantes, 12 mortos na PRIMEIRA passada**, zero sobreviventes, zero erros de harness,
arquivo restaurado idêntico. FM9 (a guarda de vencimento de `listDueRuns`) morreu com exatamente 1
falha — o caso 15, que escrevi ANTES de varrer por tê-lo previsto: as duas operações têm predicados de
vencimento SEPARADOS e nada obriga os dois a concordarem, então o caso 4 sozinho não o cobriria. Três
âncoras eram ambíguas (`rows.length === input.limit` nos dois métodos; o predicado de isolamento de
tenant, que colide com `lockControl` na linha 227) e viraram blocos multi-linha antes de medir.

**Correção de um defeito meu, herdado do P03.6b:** eu havia reescrito à mão um helper que a casa já
tinha. `statusList` (`turn-fence-sql.ts:61`) é literalmente o `sql.join` que dupliquei, e o docstring
dele explica por que existe — interpolar array JS num template do Drizzle vira RECORD e o Postgres
recusa em tempo de EXECUÇÃO. Substituído; P03.6b revalidado em 74/74, e a evidência de mutação segue
aplicável porque os call sites usam o NOME do constante, que não mudou.

**Estado final:** 15 casos no spec de varredura, verdes. `typecheck`, `lint` (481 warnings, idêntico à
baseline), `check:node`, `docs:ai:check`, `config:check:drift` e `audit:exceptions:check` todos em
**exit 0** — desta vez com o nome CERTO do último gate, depois de eu o ter invocado como
`audit:exceptions` e recebido "Missing script", que não é verde nem vermelho, é gate não executado.

**Regressão:** `50 failed | 10233 passed | 1172 skipped (11455)` contra `50 | 10233 | 1157 (11440)` do
V-027. Passados e falhos INALTERADOS, os mesmos 20 arquivos; pulados e total sobem exatamente +15, que
é o spec novo. Nenhuma falha cita meus módulos por nome exato — e registro o quase-erro: meu primeiro
grep de atribuição incluía a palavra `sweep` e casou com `privacy-export-sweeper`, que é falha de
ambiente Windows já listada 3× neste log. Conferido por nome exato antes de afirmar.

**`test:leak` reexecutado** (esta unidade adiciona a leitura cross-tenant, o caso mais tenant-sensível
do módulo): perfil **IDÊNTICO** ao do V-027 — `8 failed | 120 passed | 23 skipped (151)`, os MESMOS 6
arquivos, e `outbound-leak` passando com 10 casos. Acrescentar uma varredura sem escopo não moveu nada
na suíte de vazamento. As seis falhas continuam classificadas como em V-027, incluindo
`turn-context-batch-repos` como item aberto sem controle em HEAD.

### V-029 · P03.7b — manutenção, e quatro sobreviventes que precisaram de prova

`reserveMaintenanceObservation` e `recordMaintenanceObservation` são o OPOSTO do caminho do dono.
Nenhuma das duas chama `lockTurnAndCheckFence`, e não podem chamar: o §5.8.4 existe exatamente para
quando o turno já não é reivindicável, então exigir fence de turno tornaria a operação impossível no
único cenário em que ela serve. O fence é a `row_version` devolvida — que a spec qualifica em letras:
"não é claim token de turno".

**A reserva não precisou de coluna nova**, e isso é desenho, não economia: empurrar `next_poll_at` para
a frente É o mecanismo de exclusão, e quem chegar dentro da janela recebe `not_due` (caso 18). Uma
coluna de "dono da reserva" seria um segundo lease para manter vivo, com o mesmo problema de expiração
do primeiro. `owner_alive` tem DUAS condições que não são a mesma pergunta — lease viva ("o processo
ainda está lá?") e `RECOVERABLE_TURN_STATUSES` ("o turno ainda é dele?") — e os casos 20/21/22 as
separam: um turno `outbound_pending` com lease VIVA continua manutenível, porque ali quem manda é o
delivery worker, não o reasoner.

**C20 registrado antes de implementar:** o vocabulário FECHADO de `engine_run_events.event_type` não
tem termo para manutenção, e nenhuma migration posterior à 140 o estende (conferido em
`pg_constraint`, não no arquivo). O evento sai como `reconcile_decision`, com `dedupe_key` própria.
Isso é decisão minha; a alternativa seria migration, que é mudança de schema e não cabe numa unidade
de repositório.

**Varredura: 13 mutantes, 9 mortos e 4 SOBREVIVENTES.** Não reporto "13/13". Os quatro são
`!run.vencido` e a guarda de janela do UPDATE, mais os dois predicados de escopo de tenant. Em vez de
declará-los redundantes por dedução, medi com mutação COMBINADA:

* **CB1 (ambas as guardas de janela) MORREU.** O par é carga real; cada membro sobrevive sozinho só
  porque o outro recusa. Sob `FOR UPDATE` os dois veem o mesmo estado, então nenhum teste
  single-threaded consegue atribuir a garantia a um deles — é a mesma situação dos dois mutantes
  documentados de P03.4, agora comprovada em vez de suposta.
* **CB2 (escopo do `lockControl` sozinho) SOBREVIVEU — e isso REFUTOU minha hipótese**, que eu havia
  enunciado ANTES de medir: eu disse que `lockControl` era o verdadeiro enforcer do isolamento e que
  os `WHERE` internos eram decorativos. Está errado. Tirar o escopo do `lockControl` deixa os 30
  casos verdes.
* **CB3 e CB4 (`lockControl` + o `WHERE` interno de cada operação) MORRERAM.** Conclusão correta: o
  isolamento de tenant tem **dois enforcers independentes, cada um suficiente sozinho**. Não há
  buraco — há defesa em profundidade que o teste prova como conjunto e não sabe atribuir. Registrar
  isso importa mais que o placar: um leitor que visse "sobreviveu" numa mutação de isolamento sem a
  evidência combinada concluiria, com razão, que havia vazamento.

**Um defeito MEU de teste, encontrado pelo guard de baseline do harness.** A primeira tentativa de
varredura abortou com `1 failed | 29 passed`, na mesma suíte que passara 30/30 minutos antes. Causa:
o spec VAZAVA ~20 escopos vencidos por rodada, e como `enumerateDueScopes` é cross-tenant, o conjunto
que o caso 5 pagina crescia monotonicamente; ao passar de 254 escopos o teto de páginas estourou.
Sem o guard, 13 vereditos teriam saído contaminados.

A primeira correção que escrevi estava ERRADA e o banco a recusou: `DELETE` em `engine_run_events`
esbarra no trigger append-only ("spec 5.6.2", `BEFORE DELETE OR UPDATE`), e a FK RESTRICT dos eventos
prende `engine_runs` junto — a transação inteira reverteu, sem apagar nada. Desativar o gatilho para
limpar seria contornar a invariante que o próprio P03.1 verificou. A correção certa distingue o que é
imutável do que não é: **o journal é imutável, o AGENDAMENTO não**. O `afterAll` passou a APOSENTAR o
que cria (empurra `next_poll_at`), deixando o journal inteiro e auditável. Provado por duas execuções
consecutivas verdes com a contagem de escopos vencidos ESTÁVEL em 4 nas três medições — não por
afirmação. O passivo de 366 runs acumulados foi estancado do mesmo modo, sem remover linha alguma.

**Estado final:** 30 casos no spec de varredura/manutenção, verdes, e estáveis em execução repetida.
`typecheck`, `lint` (481 warnings, idêntico à baseline), `check:node`, `docs:ai:check`,
`config:check:drift` e `audit:exceptions:check` todos em **exit 0**.

**Regressão:** `50 failed | 10233 passed | 1187 skipped (11470)` contra `50 | 10233 | 1172 (11455)` do
V-028. Passados e falhos INALTERADOS, os mesmos 20 arquivos, nenhuma falha citando meus módulos por
nome exato; pulados e total sobem exatamente +15, que são os casos novos.

**`test:leak` reexecutado:** perfil IDÊNTICO pela terceira unidade seguida — `8 failed | 120 passed |
23 skipped (151)`, os mesmos 6 arquivos, `outbound-leak` verde. Classificação inalterada em relação ao
V-027, incluindo `turn-context-batch-repos` como item aberto sem controle em HEAD.

### V-030 · P03.8a — a lacuna que só apareceu quando li o capítulo 10 na FONTE

Eu vinha derivando as unidades do P03 da tabela de operações do §5.6.3. Ao abrir o capítulo 10 — que é
onde o §3 manda buscar rastreabilidade — a etapa P03 declara **três** entregáveis: `engine-repos.ts`,
schema + migrations reservadas, e `src/runtime/engines/recovery.ts`. O terceiro nem começou, e o
capítulo lista ainda "projeções" como escopo. Foi isso que me fez conferir `engine_projections`, e o
`grep` em `tests/` devolveu **ZERO**: a tabela nasceu na 140 junto das três irmãs do journal, as três
ganharam caracterização no P03.1, e ela ficou sem uma única asserção. Ninguém teria notado — não há
consumidor de produção, então nada quebraria até alguém depender de um CHECK que talvez não existisse
como se imaginava.

**Não confundir com o adiamento do P03.6b, que continua de pé.** Aquele é sobre PROCESSAR projeções
(criá-las no fechamento, executá-las), que é a costura de P08/P09. O que faltava aqui eram os
INVARIANTES DE SCHEMA, que já existem hoje.

**São testes de CARACTERIZAÇÃO**, e por isso passaram de primeira — o §4 é explícito em que
caracterização registra a linha de base sem falha artificial, e forçar um vermelho teatral aqui seria
encenação. A proteção contra caso vazio é dupla: `expectPgError` LANÇA se a operação passar, e cada
caso afirma um **SQLSTATE** específico em vez de "deu erro" — um typo no INSERT também dá erro, e
passaria num teste frouxo.

**Três pares complementares**, pela lição que me custou dois ciclos hoje (provar a garantia sem provar
qual predicado a sustenta): o caso 5 (`started` SEM `finished_at` é válido) é o que impede os casos 3/4
de passarem sob um CHECK que exigisse `finished_at` SEMPRE; o caso 7 faz o mesmo pelo 6; o caso 9 faz
o mesmo pela PK do caso 8. Sem os complementos, os três predicados seriam indistinguíveis de versões
mais grosseiras deles.

**A assimetria registrada como decisão:** `engine_projections` é a única das quatro tabelas do journal
**sem trigger** — as outras têm `engine_runs_immutable_trg`,
`engine_tool_calls_immutable_trg` e `engine_run_events_append_only_trg`. A ausência é correta, porque
uma projeção CAMINHA (`pending → started → completed`), e o caso 13 a fixa: quem "consertar" a
assimetria acrescentando um trigger quebra no teste, não em produção. O mesmo caso registra que
`row_version` NÃO é incrementado pelo banco — quem versiona é a aplicação.

**Achado de repositório, registrado e não contornado em silêncio:** não existe configuração de prettier
(sem `.prettierrc*`, sem chave em `package.json`, sem `.prettierignore`) e o gate da casa é
`npm run format` = `prettier --write **src**`, que não cobre `tests/`. Medido: o próprio
`hermes-runs-real-db.spec.ts` REPROVA em `prettier --check`. Acrescentar casos lá e formatar
reescreveria 461 linhas preexistentes e o commit deixaria de conter apenas as alterações desta tarefa
(§2), então a caracterização foi para arquivo próprio. Normalizar `tests/` é decisão do dono e está na
seção de riscos.

**Poluição PRE-EMPTADA, não remediada depois.** `mkRun` insere em `phase='running'` sem tocar
`next_poll_at`, que assume o default `now()` — ou seja, toda linha nasce VENCIDA e alimentaria o mesmo
envenenamento cross-tenant que quebrou o baseline da varredura em P03.7b. Desta vez o `afterAll`
aposenta os runs ANTES de o estrago existir. Provado: escopos vencidos **4 antes e 4 depois**, e o spec
de varredura segue **30/30** — sem contaminação cruzada.

**Estado final:** 13 casos, verdes. `typecheck`, `lint` (481 warnings, idêntico à baseline),
`check:node`, `docs:ai:check`, `config:check:drift` e `audit:exceptions:check` todos em **exit 0**;
`prettier --check` limpo no arquivo tocado.

**Regressão:** `50 failed | 10233 passed | 1200 skipped (11483)` contra `50 | 10233 | 1187 (11470)` do
V-029. Passados, falhos e os 20 arquivos INALTERADOS; pulados e total sobem exatamente +13.

**`test:leak` NÃO foi executado nesta unidade, deliberadamente.** Rodei nas três anteriores porque
mexiam em código de produção com escopo de tenant; aqui o diff é um spec novo mais documentação, e
**nenhuma linha de produção mudou**. Rodá-lo produziria uma marca de verificação sem significado — e
`npm test` já cobre a lane unitária.

### V-031 · P03.8b — a varredura achou um defeito de DESENHO, não de teste

`src/runtime/engines/recovery.ts` é o terceiro entregável que o capítulo 10 nomeia para o P03, e com
ele a etapa entrega os três. É a tabela de dezessete linhas do §5.8.2 como função TOTAL num módulo
PURO — sem acesso a dados, contexto de execução, configuração de processo ou métricas —, no mesmo
gênero de `poison-policy.ts`. Isso é o que torna a pergunta "o que é seguro fazer com este run depois
de uma queda?" respondível sem Postgres, sem Redis e sem boot.

Nove disposições, cada uma citando a linha do §5.8.2/§5.8.4 que a origina: vocabulário sem procedência
é vocabulário inventado, que é o erro que o C18 e o C20 já me obrigaram a registrar. Duas garantias
são estruturais e não dependem de disciplina de quem chama: a EVIDÊNCIA DE EFEITO domina a fase (mesma
régua com que `unsafe_to_retry` domina o código de erro em `poison-policy`), de modo que um
`result_ready` íntegro não autoriza adoção por cima de efeito não conciliado; e o vocabulário fechado
**não consegue expressar** "retomar a sequência de ferramentas" — a ausência é o mecanismo do INV-09,
exatamente como a ausência de `resend_blind` em `RECONCILIATION_DISPOSITIONS`.

**Sete casos escritos ANTES da varredura, por previsão.** Ao mapear as mutações percebi que seis ramos
sobreviveriam sem caso próprio (o `dead_letter`, o `cancelling`, o ramo `adopted` do `result_ready`, os
três ramos de `running` e a metade "turno terminal" do helper). Um caso de TOTALIDADE prova que a
função responde; não prova QUAL ramo respondeu. Também apertei o caso 11: ele aceitava uma lista de
três disposições, e nessa forma desligar a regra do `inconclusive` devolveria `query_same_request_key`
— que estava na lista — e o caso seguiria verde. Um teste que aceita três respostas não distingue a
regra certa da ausência dela.

**E ainda assim a primeira rodada teve um sobrevivente, que era defeito MEU de desenho.** RM2 (a regra
`blocked → block`) sobreviveu com 22/22 verdes. Causa: o fundo do poço devolvia `block`, então
desligar a regra 2 fazia um `blocked` cair até lá e produzir a MESMA resposta. O caso 9 não conseguia
distinguir a regra da ausência dela — mascaramento por par redundante, o mesmo padrão de GM5/GM6.

A saída não foi remendar o teste. Um instantâneo que a tabela não previu **não é um estado seguro
conhecido**: é defeito de programação, e devolver uma disposição ali faz uma OMISSÃO parecer uma
DECISÃO. Troquei o fundo por um guard de exaustividade com `never` — idioma que a própria casa já usa
em `deriveProviderIdempotencyKey`. Agora o COMPILADOR prova que a linha é inalcançável (o `typecheck`
só passa porque as onze regras cobrem os nove membros de `EngineRunPhaseV1`), um membro novo na união
quebra a build exatamente ali, e a regra 2 voltou a ser observável.

**Segunda rodada: 13 de 14 mortos**, zero erros de harness, arquivo restaurado idêntico. RM2, que
sobrevivera, agora morre com 2 falhas — a prova de que a correção foi de desenho. O único sobrevivente
é RM14, a mutação do próprio guard, e sua sobrevivência é **provada pelo compilador**, não afirmada
por mim: mutar uma linha que o `never` demonstra inalcançável não pode ser observado. É uma posição
melhor que a dos dois mutantes "não-matáveis por construção" do P03.4, que tive de aceitar na palavra.

**Defeito de harness, registrado:** a âncora do fundo montava o cedilha com os BYTES UTF-8 (195,167)
em vez da code unit (231), produzindo `poÃ§o` e `n=0`. O guard de `n !== 1` pegou — é a quarta falha
da mesma família de escapes nesta sessão, e a razão de o harness abortar em vez de reportar.

**Estado final:** 22 casos unitários, verdes. `typecheck`, `lint` (481 warnings, idêntico à baseline),
`check:node`, `docs:ai:check`, `config:check:drift` e `audit:exceptions:check` em **exit 0**;
`prettier --check` limpo nos dois arquivos.

**Regressão — e desta vez a aritmética é DIFERENTE de todas as anteriores.** Como o módulo é puro, os
testes rodam na lane UNITÁRIA: `50 failed | 10255 passed | 1200 skipped (11505)` contra
`50 | 10233 | 1200 (11483)` do V-030. O `passed` sobe exatamente +22 e o `skipped` fica INALTERADO —
o oposto do padrão de toda unidade anterior, cujos testes só engrossavam os pulados. Previsto antes de
medir, e o spec aparece verde na saída (`✓ engine-recovery-policy.spec.ts (22 tests)`).

**Fora de escopo, e NOMEADO:** a fiação de `routeExistingEngineRun` em `core.ts:750-753` é estrutura
PROPOSTA (`grep` no código = 0) e altera o pipeline vivo de turno. Fica para unidade própria — o §3
pede unidades pequenas, e essa tem o maior raio de explosão de tudo que esta épica tocou até aqui.

### V-032 · P04.1 — a tabela de comandos, e duas ferramentas que me morderam

Primeira unidade do P04. `conversation_controls` (140) guarda o ESTADO; faltava onde guardar o
COMANDO e o seu resultado. Sem isso, a regra do §8.2.1 — "retry da mesma chave devolve o mesmo
comando, sem novo incremento de epoch" — seria promessa que o código não consegue cumprir, porque ele
não saberia que já viu aquela chave. `request_hash` é o que separa REDELIVERY de CONFLITO: guardar só
a chave transformaria "mesma chave, payload diferente" em última-escrita-vence, que o §8.2.4 proíbe.

`barrier_committed` e `drain_status` são colunas SEPARADAS, e o caso 14 existe só para prender isso: o
§8.2.3 diz em letras que `barrierCommitted=true` não significa `drainStatus='complete'`. Colapsá-las
num campo faria a UI afirmar que nenhuma mensagem chega depois do clique — exatamente o que a spec
proíbe prometer.

**Duas falhas de ferramenta, ambas minhas, registradas porque custaram tempo real:**

1. `npm run migrate:reserve "<propósito longo>"` slugificou um parágrafo de ~600 caracteres INTEIRO
   como nome de arquivo. O script documenta `--filename`, e eu não usei.
2. Na segunda tentativa usei `--filename` — e o npm **não repassou a flag**, porque falta o separador
   `--`. O script tratou tudo como propósito e slugificou de novo, agora com o nome colado no fim.

Resolvido pelo caminho que o próprio ledger documenta ("**or** add the line by hand at the bottom").
Restaurei as duas linhas — ambas NÃO COMMITADAS, só na minha worktree — e anexei a correta à mão.
Registro o raciocínio porque a regra do ledger é "append-only, nunca edite": ela protege entradas
COMMITADAS, para que reservas concorrentes colidam no git. Desfazer erro próprio antes de virar
histórico não é o que ela proíbe, e deixar a linha ruim quebraria o guard, que exige que toda reserva
aponte para arquivo existente. Guard final: **148 reservas cobrem 148 migrations**, e os dois specs de
unicidade/reserva verdes (31 casos).

**O `_down` foi verificado nos DOIS caminhos, e o primeiro resultado foi enganoso.** Rodado de
verdade, ele RECUSOU: "221 conversa(s) fora de bot". Investigado em vez de assumido — as 221 são todas
de `hermes-repos-tenant`, isto é, fixtures dos meus próprios casos de fence do P03 (`control_not_bot`),
que viram `mode` para `human` e não limpam. Ou seja, o guard estava certo e minha verificação estava
pela METADE: eu provara a recusa, não a remoção. Fechei provando o caminho de DROP dentro de uma
transação que normaliza os modos, executa o down inline e faz `ROLLBACK` — `DROP INDEX`, `DROP TABLE`,
tabela em 0 lá dentro, e depois tudo de volta (tabela presente, 221 modos intactos). Efeito permanente
zero.

**Achado de repositório:** o espelho drizzle de `schema.ts` é CONVENÇÃO, não gate — não há spec de
paridade entre `schema.ts` e as migrations. Quase fechei a unidade sem o espelho, e o que me salvou foi
refazer o grep: o primeiro padrão (de uma linha só) deu FALSO NEGATIVO dizendo que nenhuma das seis
tabelas da 140 estava espelhada, quando todas estão — o arquivo põe o nome na linha seguinte ao
`pgTable(`. Espelho acrescentado; o índice PARCIAL fica declarado só na migration, com o motivo no
código: uma cópia sem o `WHERE` sugeriria paridade que não existe.

**Estado final:** 17 casos de caracterização contra Postgres real, verdes, afirmando por SQLSTATE, com
quatro pares complementares (idempotência escopada ↔ mesma chave em outro escopo; `accepted` sem/com
`result_epoch`; recusa sem motivo ↔ aceite com motivo; claim parcial ↔ claim completo). `typecheck`,
`lint` (481 warnings, idêntico à baseline), `check:node`, `docs:ai:check`, `config:check:drift` e
`audit:exceptions:check` em **exit 0**. Migration aplicada no banco local (checksum `2d4ded232851`,
`transaction_mode: self`) e registrada em `schema_migrations`.

**Regressão:** `50 failed | 10255 passed | 1217 skipped (11522)` contra `50 | 10255 | 1200 (11505)` do
V-031. Passados e falhos INALTERADOS, os mesmos 20 arquivos; pulados e total sobem exatamente +17.

**O que esta unidade NÃO faz, e é o resto do P04:** `pauseConversationTx`, o serviço puro de
transporte, as ações de auditoria que o §8.2.3 passo 4 exige e que ainda não existem no vocabulário
(C22), e os fences nas dez fronteiras de egresso do §8.2.4. Aqui só o schema — nenhum caminho vivo foi
tocado.

### V-033 · P04.2 — o vocabulário que eu inventei, e a spec que já o nomeava

**A unidade.** Cinco ações acrescentadas a `AUDIT_ACTIONS`, sem as quais o §8.2.3 passo 4 ("comando e
auditoria durável na MESMA transação", via `auditTx`) é inexequível: `auditTx` recebe
`acao: AuditAction`, união FECHADA, e não havia termo para tomada/retomada humana. Resolve o C22.

**O defeito, e por que nenhum sinal interno podia pegá-lo.** A primeira versão INVENTOU quatro nomes
(`conversation_paused`, `conversation_pause_drained`, `conversation_resumed`,
`conversation_control_command_conflicted`). Ela passou em `eslint`, `typecheck`, no spec de contrato
5/5 e em seis mutações, cinco delas mortas. Todos esses sinais medem **coerência interna**; o defeito
era de **procedência**. A spec já nomeava dez eventos na linha **2480** (§8.6.1, "NOVOS eventos de
audit tipados") — verificado como o ÚNICO ponto da especificação inteira que nomeia evento de
auditoria, sem vocabulário concorrente, e nenhum dos dez existia no `AUDIT_ACTIONS`.

**O erro de fundo não era lexical.** A spec separa `conversation_resume_requested` de
`conversation_automation_resumed`; eu colapsei os dois DEPOIS de argumentar, para a pausa, que pedido
e efeito são fatos distintos. O §8.3.2 exige que o resume "recuse enquanto houver efeitos/entregas não
conciliados" — logo o estado "o operador pediu e a automação ainda NÃO voltou" existe, e colapsá-lo o
tornava invisível. Apliquei uma régua de um lado e a apaguei do outro, e nenhum teste meu percebia.

**Correção:** os cinco nomes normativos (`conversation_pause_requested`,
`conversation_control_acquired`, `conversation_resume_requested`, `conversation_automation_resumed`,
`conversation_control_conflict`). As outras cinco do mesmo §8.6.1 (`engine_cancel_requested`,
`engine_cancel_reconciled`, `engine_result_fenced`, `engine_quota_denied`, `operator_reply_committed`)
ficam **nomeadas como pendentes** de P05/P06/P07 e do composer do §8.3.4 — acrescentá-las agora seria
vocabulário sem emissor, defeito que o próprio arquivo já registra em `llm_circuit_opened/closed`.

**Primeira rodada de mutação — dois achados sobre os TESTES, não sobre o código.** (a) M5 (apagar a
citação de §8.2.1) **sobreviveu**: não era buraco de cobertura, era redundância de ocorrência — o
comentário cita a seção em vários pontos e o `toContain` seguia achando. Atribuído por mutação
COMBINADA, no padrão do P03.7b. (b) O caso 5 era **VACUOSO**: iterava os literais escritos no próprio
spec contra um regex, então nenhuma mudança de código conseguia derrubá-lo — provado por M6, que
renomeou a ação no fonte, matou os casos 1 e 3 e deixou o 5 passando. Corrigido o TESTE (passou a
varrer `AUDIT_ACTIONS` de verdade, com piso de contagem para não voltar a ser vacuoso), nunca a
asserção enfraquecida.

**Segunda rodada: 9 mutações, 9 MORTAS.** M1–M5 removem cada ação. As que provam os consertos:
**M4** (apagar `conversation_automation_resumed`) mata o caso da simetria — a separação do resume
passou a ser exigida pelo teste, não só afirmada por mim; **M6** (colapsar de volta no nome inventado)
mata a guarda de reintrodução; **M7** mata o caso 5, que na rodada anterior sobrevivia; **M8/M9**
(combinadas, apagando as 2 e 3 ocorrências de §8.6.1 e §8.2.1) matam o caso de procedência.

**Correção de número, minha.** Eu havia afirmado "303 membros" no C22 e no docstring — nunca medido.
A contagem real, em runtime e com zero duplicados, é **300 antes e 305 depois**. Uma contagem minha
por regex chegou a dizer 337 porque o arquivo tem um SEGUNDO array, `ACTION_KEYS`, com 32 entradas:
305 + 32 = 337, conta fechada e nada sem atribuição.

**Gates.** `typecheck` 0, `lint` 0, `check:node` 0, `docs:ai:check` 0, `config:check:drift` 0,
`audit:exceptions:check` 0 (desta vez EXECUTADO — em sessão anterior eu o registrei como não
executado por errar o nome do script) e `migrate:reservations:check` 0 (148 reservas / 148 migrations).
⚠️ `commit:trailers:check` saiu com exit 0 mas **PULADO** ("GITHUB_EVENT_PATH não está definido"): só
roda dentro do GitHub Actions. Pela régua da casa, pulado NÃO é passou — fica como **não executado**.
⚠️ `lint` acusa 483 warnings contra 481 da baseline do V-032; os meus dois arquivos produzem **0**
warnings cada, então o delta **não é atribuível a esta unidade** e permanece sem explicação.
`prettier` continua NÃO sendo gate: não existe configuração no repositório em nenhum formato
(`--find-config-path` erra), e **705 arquivos de `src/` reprovam** — rodar `--write` no meu arquivo
converteria 900 linhas alheias de aspas simples para duplas (medido: 367/332).

**Regressão:** `50 failed | 10261 passed | 1217 skipped (11528)` contra `50 | 10255 | 1217 (11522)` do
V-032. Falhos, pulados e os mesmos 20 arquivos INALTERADOS; passados e total sobem **exatamente +6**,
que são os seis casos do spec, puro e portanto na lane unitária. Nenhuma falha cita meus módulos.
Regressão dirigida dos consumidores do vocabulário: 103 passados, 0 falhos, 10 pulados.
`test:leak` **NÃO executado**, deliberadamente: nenhum caminho de produção mudou — a unidade só
acrescenta membros a uma união de tipos — e rodá-lo produziria marca de verificação sem significado,
como no P03.8a.

**Achado de processo, e o mais importante daqui.** Mutação prova que o teste morde o **código**; não
prova que o código corresponde à **especificação**. Antes de fechar uma unidade é preciso varrer a
spec INTEIRA pelos identificadores que ela introduz, não só o capítulo em que se está trabalhando —
aqui o capítulo do vocabulário (§8.6) é outro que não o do comportamento (§8.2), e o achado só
apareceu porque li o capítulo 8 completo para preparar a unidade seguinte. Registrado como C24.

**Contradição de processo encontrada nesta unidade, e NÃO resolvida por mim.** O `AGENTS.md` (seção
Coautoria) diz em letras que a regra do `Co-Authored-By:` de IA foi removida e que "isto é **gate, não
convenção**" — `scripts/check-commit-trailers.ts` roda no job bloqueante e reprova a PR inteira se
qualquer commit trouxer o trailer. Meu próprio C08 já registrava que `AGENTS.md` prevalece. Ainda
assim, **6 dos 26 commits desta branch levam o trailer**. Deste commit em diante ele não é mais
escrito; os 6 anteriores **ficam como estão**, porque corrigi-los exige reescrever histórico, que é
operação destrutiva fora da minha autorização (§2) e decisão do dono.

**O que esta unidade NÃO faz, e é o resto do P04:** `pauseConversationTx`, o serviço puro de
transporte (placement em C23), os fences nas dez fronteiras de egresso do §8.2.4,
`resumePolicy='future_only'` (§8.2.5) e a tabela `conversation_handoff_requests`. Aqui só o
vocabulário — nenhum caminho vivo foi tocado, e nenhuma ação tem produtor ainda.

### V-034 · P07 (agente paralelo) — validação PESSOAL do trabalho, não aceite por resumo

**Contexto.** Primeira vez nesta épica que uso o paralelismo que o §7 autoriza: três frentes
independentes (P05 broker, P06 gateway/custo, P07 supervisor), cada uma em worktree e branch próprios,
com propriedade de arquivos declarada. O P07 foi o primeiro a terminar. O §7 exige que eu valide diff e
evidência pessoalmente — "um resumo dizendo 'concluído' não basta" —, e é isso que este registro é.

**Entrega:** `claude/mh-p07-supervisor`, commits `a1c3de3a` (módulo + 60 casos) e `5627eda0`
(relatório), base `7993e563`. `src/integrations/hermes/supervisor-policy.ts`, 561 linhas: os três verbos
do §5.3.1 como funções TOTAIS sobre instantâneos explícitos, a escada `min(deadline, lease)` do §5.8.1
e o gate de rollback do §6.11.

**O que EU conferi, e como.**
- **Propriedade de arquivos:** `git diff --name-only` contra a lista proibida → nenhum acerto. Três
  arquivos, todos novos.
- **Pureza:** o único import do módulo é `import type { CancelFrame }`, apagado na compilação. Meu
  `grep` por `child_process|spawn|setTimeout|fetch|db\.|sql\`` acusou três linhas, todas COMENTÁRIO ou
  o campo `spawned` — verificadas uma a uma, nenhuma chamada real.
- **Gates reexecutados por mim** (exit relatado por quem implementa não é evidência): `tsc --noEmit` 0,
  `eslint` 0, `vitest` 0 com `executados=60 falharam=0 pulados=0`.
- **Trailer:** `git log --format=%B | grep -c Co-Authored-By` = 0. Obedeceu ao `AGENTS.md`, e chegou
  ao mesmo conflito que o C08 de forma independente.
- **Árvore limpa** antes e depois da minha varredura.

**Varredura de mutação INDEPENDENTE minha.** Gerada por OPERADOR (`&&`↔`||`, `>=`→`>`, `<=`→`<`,
`===`→`!==`), sem eu escolher o texto, com controle antes (fonte intacto passa) e depois (restauração
byte a byte + 60/60). Resultado: **6 aplicadas, 6 MORTAS, zero sobreviventes.**
⚠️ **O que isto prova e o que não prova:** corrobora, não replica. O agente aplicou 33 mutações
escolhidas à mão; o meu gerador é por operador e encontrou 6 alvos. Seis de seis mortos é sinal forte
e independente, mas **não é verificação das 33 dele** — essas continuam sendo afirmação dele.
⚠️ **Duas tentativas anteriores minhas de rodar esta varredura falharam por defeito do MEU harness**
(variáveis exportadas depois do primeiro `node -e`; laço rodou zero vezes e devolveu "0 mortos, 0
sobreviventes", que eu quase li como resultado). Resolvido movendo o laço inteiro para um único
processo node com `execSync`, em vez de trocar estado entre `bash` e `node`. Fica registrado porque um
resultado nulo com cara de resultado é a forma mais fácil de fabricar evidência sem querer.

**Dois achados do agente que eu VERIFIQUEI e adotei como meus.**
1. **A1 → C25:** o journal não distingue "admitido sem spawn" de "spawn com ACK perdido". Conferi no
   schema real: `engine_runs` não tem coluna de spawn/pid/processo, `remote_run_id` é nullable e só é
   atribuído no aceite, e a DDL da 140 não tem nada do gênero. É **lacuna do meu P03**, e o mapeamento
   conservador `spawned = (phase !== 'prepared')` é sustentado pelo JSDoc que eu mesmo escrevi em
   `markSubmitting` — mas é inferência, não fato durável.
2. **tsconfig → C26:** `npm run typecheck` nunca cobriu teste algum. Provado empiricamente: plantei
   `const x: number = "isto e uma string"` em `tests/unit/`, e `tsc --noEmit` saiu **exit 0 com zero
   menções**. Vale para as seis specs que eu escrevi nesta épica; todo `typecheck 0` dos registros
   anteriores é verdadeiro para `src/` e silencioso sobre `tests/`.

**Correção de método minha, encontrada no caminho:** meus `grep` por
`export async function markSubmitting|recordStartObservation` voltavam vazios e eu quase concluí que a
citação do agente era falsa. O padrão é que estava errado — são métodos de `export const
engineRunsRepo` (`engine-repos.ts:946`). O código estava certo; a minha busca é que não estava.

**O que NÃO foi integrado.** O código do P07 permanece na branch dele, **fora** desta. Por isso as
linhas T09–T16 e T65/T66 da matriz seguem como estavam: o agente marcou todas PARCIAIS e nenhuma
COBERTO, e declarou **G-LIFE NÃO CUMPRIDO** — o gate exige ledger (banco) e crash (processo), e a fatia
não toca nenhum dos dois. Reivindicar cobertura que esta branch não tem seria overclaim.

### V-035 · P05 e P06 — validação pessoal, e DOIS defeitos reais que a varredura independente achou

Fecha a primeira rodada de paralelismo. As três frentes entregaram; o V-034 cobriu o P07, este cobre
P05 e P06. Nenhuma foi integrada a esta branch.

**O que confirmei nas duas, com as minhas mãos e não pelo resumo:** propriedade de arquivos respeitada
(`git diff --name-only` contra a lista proibida = vazio nas duas), diffs puramente aditivos, zero
trailers de IA, árvores limpas, e gates reexecutados por mim — P05: `tsc` 0, `eslint` 0, **88/88 com
zero pulados**; P06: `tsc` 0, `eslint` 0, **91/91 com zero pulados**. Os módulos do P06 são
verificadamente puros: `cost-accounting.ts` e `cost-reservation.ts` não têm NENHUM import.

**Erro meu, registrado porque quase virou evidência falsa:** na primeira tentativa de verificar o P05
eu CHUTEI os nomes dos specs (`hermes-manifest.spec.ts` etc.); os reais são
`hermes-manifest-contract.spec.ts` e `hermes-tool-broker-policy.spec.ts`. O vitest casou **um só**
arquivo e devolveu 21 casos — eu estava a um passo de registrar "verificado" tendo visto 21 de 88.
Refeito com os nomes certos: 88/88.

**Varredura de mutação independente, por OPERADOR.** O ponto não é o placar, é que ela cobre o que o
autor não pensou em olhar — mutante escolhido à mão cobre o que ele já suspeita.

| Frente | Alegado pelo agente | Minha varredura | Sobreviventes |
|---|---|---|---|
| P07 | 33 de 33 | 6 de 6 | 0 |
| P06 | 41 de 41 | 27 de 31 | **4** |
| P05 | 52 de 52 | 41 de 51 | **10** |

⚠️ Minhas varreduras **corroboram, não replicam** as deles: o gerador é por operador e encontra outro
conjunto de alvos. Nenhuma das três contagens deles foi reproduzida por mim.

**Dos 14 sobreviventes, 11 se absolvem e 3 eram defeito real.** Classifiquei todos antes de acusar:
rótulo de erro (`|| 'body'`, `|| 'manifest'`, `|| 'binding'`) não é garantia — provado por mutação
COMBINADA, que sobreviveu junto, como deve; e guardas de forma redundantes com o zod logo abaixo.

**DEFEITO 1 — P06, `expirou()` (`inference-gateway.ts:446-451`).** Removi a guarda
`if (Number.isNaN(agora) || Number.isNaN(fim)) return true;` INTEIRA e a suíte continuou passando;
cada metade isolada também sobreviveu, apesar de 6 casos tocarem `expires_at`. Sem ela,
`agora > fim` com `NaN` devolve `false`: **um grant com instante corrompido seria tratado como
válido** — recusa autenticada virando aceite, o oposto exato do T18. Devolvido ao agente.
**Remediação verificada por mim:** commits `5736e296` (só o spec, 33/0) e `56fdff48` (só o relatório);
`git diff --numstat -- src/` entre o relatório e o HEAD veio **vazio**, provando que foi cobertura pura
e o código nunca esteve errado. Reexecutei as minhas três mutações: **as três morrem** (exit=1),
fonte restaurado byte a byte, controle passando antes e depois. Gates por mim: `tsc` 0, **94/94 zero
pulados**. O agente obteve o vermelho pondo o defeito vivo (guarda removida) em vez de forjar um teste
que falhasse contra código correto — é a forma certa quando o defeito é de cobertura.

**DEFEITO 2 — P05, teto de profundidade fail-OPEN.** Quatro sobreviventes caíam no termo
`profundidade > MAX_*_DEPTH` de dois varredores recursivos. Não classifiquei por leitura: escrevi uma
sonda que chama as funções REAIS.

```
screenToolArgs(['dados'], <tenant_id aninhado a N niveis>)
  N=2,10,14,15 -> reject reserved_argument
  N=16,17,20,40 -> {"kind":"ok"}          <-- PASSA
collectResourceRefs(<conversa_id aninhado a N niveis>)
  N=15 -> [{kind:'conversa', id:'c-de-outro'}]
  N=16,17,30 -> []                        <-- INVISIVEL
```

Estourar o teto devolve "nada encontrado" em vez de "fundo demais para afirmar". Como `screenToolArgs`
só compara chaves de **TOPO** contra as declaradas, uma chave declarada carregando o reservado no fundo
atravessa as duas peneiras. Atinge **T20/INV-02** ("modelo envia `tenant_id`/`approved` fora do
schema → rejeição") e **T24/INV-01** (a ACL não pode recusar o id que não enxerga). Devolvido ao
agente com a exigência de fail-closed — recusar por "fundo demais", **sem subir o teto**, porque 1000
níveis teria o mesmo defeito mais fundo: o que muda é a postura no limite, não o número.

**Alegações dos agentes que eu verifiquei em vez de transcrever.** C-P05-7 confirmado
(`_dispatcher.ts:389` é `if (!entity_id) return { error: 'no_entity_in_scope' };` e a varredura por
`authorization_target|current_subject|current_turn` em `src/tools/` e `src/runtime/` volta vazia — o
campo é decorativo hoje). C-P05-3 **procede, com o caminho corrigido por mim**: o agente citou
`src/governance/grant-math.ts`; o arquivo é `src/tools/grant-math.ts`, e `remember_safe_fact` está
mesmo na linha 114 e em `packs.ts:120`. C-P05-1 procede e **localizei o ponto exato** — ver C27.

**O que continua NÃO cumprido, e os relatórios dizem isso sozinhos:** **G-AUTH** (falta a metade de
banco), **G-COST** (o §6.12 item 11 exige gateway fake cobrindo chamada principal, SDK retry e
auxiliares, mais teste com provider real — D02, sem orçamento; nada disso existe), **G-LIFE** (ledger é
banco, crash é processo). Nenhum dos oito módulos das três frentes tem call site de produção: compilam,
são testados e estão inertes.

### V-036 · P04.3a — o trancamento do controle extraído, e uma asserção MINHA que não mordia

**A unidade.** `src/db/repositories/conversation-control-sql.ts`: os dois construtores do SQL que tranca
`conversation_controls` (`lockControlByIdSql`, `lockControlByRunSql`), extraídos de uma função privada
de `engine-repos.ts` com 16 call sites.

**Por que é pré-requisito e não refatoração cosmética.** O `pauseConversationTx` do §8.2.3 precisa
trancar a MESMA linha, e o passo 3 daquela seção proíbe em letras "introduzir dois ordenamentos
incompatíveis". As alternativas eram copiar o SELECT — duas cópias divergem, e divergência de ordem de
lock só aparece sob concorrência, em produção, como deadlock — ou o repositório de controle importar do
journal, o que inverteria a dependência, já que controle é o degrau ANTERIOR. A terceira saída é a que
a casa já usou duas vezes pelo mesmo motivo (`turn-fence-sql.ts` #504, `stream-head-sql.ts` #626):
`engine-repos.ts` importa `../client.js`, que constrói o `pg.Pool` no import, então enquanto o SQL
morasse lá a única prova possível do lock era um teste de integração — e teste de integração que não
roda não prova nada.

**A garantia substantiva do arquivo é o `FOR UPDATE OF c`.** Num join, um `FOR UPDATE` pelado tranca
TODAS as tabelas da consulta: o controle *e* `engine_runs`. Isso poria uma aresta de lock sobre o run
ANTES do controle, invertendo a ordem que o §5.6.3 fixou. O caso 5 prende exatamente isso.

**Vermelho legítimo, e FRACO — registrado como tal.** `Cannot find package
'@/db/repositories/conversation-control-sql.js'`, exit 1, `Tests no tests`: zero casos executados. Não
é asserção falhando, é módulo inexistente, e a distinção importa.

**Defeito MEU, achado pela varredura.** Primeira rodada: 5 mortos, **2 sobreviventes** — e os dois eram
de isolamento de tenant, justamente o que eu vinha cobrando dos agentes. Meu caso 4 fazia
`toMatch(/tenant_id[\s\S]*agent_id/)`, uma checagem de PRESENÇA e não de estrutura: sobrevivia tanto a
tirar `agent_id` do `WHERE` quanto a reduzir o join a `ON r.control_id = c.id`, porque nos dois casos as
palavras continuavam no SQL noutro ponto. É o mesmo defeito do caso vacuoso que o U-P04.2 me obrigou a
corrigir, cometido de novo **uma unidade depois**. Corrigi o TESTE: passou a afirmar sobre PARÂMETRO
(só o que é interpolado vira parâmetro, então tirar o escopo do `WHERE` some com o valor) e sobre
CONTAGEM de ocorrências por eixo (o escopo tem de aparecer duas vezes — no `ON` e no `WHERE`).
Segunda rodada: **7 de 7 mortos, zero sobreviventes.**

**Preservação de comportamento: 184/184 contra Postgres REAL**, os seis specs real-db, pelo
procedimento local de dois passos do V-005. Numa extração, isto é a evidência que vale — `tsc` prova
que compila, não que a semântica é a mesma. **O alvo do banco foi PROVADO, não presumido:** a primeira
tentativa (via `npm run test:integration`) morreu na guarda da #571 com `executados=0`, porque o
fakeredis não sustenta o `FLUSHDB` do db lógico; refeita pelo passo 2 (sem `globalSetup`), e depois
confirmei por consulta direta que o banco genérico `maia_test` tem **zero** das tabelas do journal
enquanto o escopado por worktree tem **167 runs criados nos últimos 10 minutos**.

**Gates:** `tsc` 0, `eslint` 0, `lint` 0 (483 warnings, idêntico ao V-033 — a mudança não acrescentou
nenhum), `check:node` 0, `docs:ai:check` 0, `config:check:drift` 0, `audit:exceptions:check` 0,
`migrate:reservations:check` 0. Diff de `engine-repos.ts`: **28/15**, proporcional à mudança, sem
import órfão.

**Regressão:** `50 failed | 10268 passed | 1217 skipped (11535)` contra `50 | 10261 | 1217 (11528)` do
V-033. Falhos, pulados e os mesmos 20 arquivos INALTERADOS; passados e total sobem **exatamente +7**,
que são os sete casos desta unidade, puros e portanto na lane unitária.

**O que esta unidade NÃO faz:** o `pauseConversationTx` em si (P04.3b). Aqui só o degrau de lock ficou
com um dono único — nenhum caminho novo foi aberto.

### V-037 · P05 — o fail-open de profundidade, corrigido e reverificado por mim

**O defeito** está no V-035 e no C39. **A correção** veio nos commits `989355eb` (código e testes) e
`8a309b3d` (relatório), na branch `claude/mh-p05-broker`.

**A raiz, melhor formulada pelo agente do que por mim:** `encontraChaveReservada` devolvia
`string | null`, e `null` significava ao mesmo tempo "varri tudo e está limpo" e "desisti por
profundidade". O chamador lia os dois como "conferido". A correção é de POSTURA e de TIPO — três
estados (`clean | found | too_deep`), de modo que o tipo não consegue mais confundir os dois fatos e
quem consome é obrigado a decidir. O teto continua 16: subi-lo teria o mesmo defeito mais fundo.

Duas decisões de desenho que valem registro: `collectResourceRefs` passou a devolver
`{refs, truncated}` e a autorização recusa `scan_truncated` ANTES de qualquer pertencimento — a
varredura e a decisão viajam juntas de propósito, senão o fail-closed dependeria de cada call site
lembrar de conferir o truncamento, e um que esquecesse reproduziria o defeito. E a guarda de
profundidade ficou DEPOIS da checagem de tipo: um escalar fundo não esconde nada abaixo de si, então o
que dispara a recusa é estrutura **não varrida**.

**Um achado dele que eu não tinha visto:** o teto do broker (16) é mais estrito que o `max_json_depth`
do wire (32), então entre **17 e 32** o frame passava no P00 e a varredura desistia calada. A faixa
explorável era maior do que a que eu reportei.

**Reverificado por MIM, com a mesma sonda de antes:** profundidades 2 e 15 → `reserved_argument`;
**16, 17, 20, 32 e 40 → `too_deep`**. O fail-open fechou em toda a faixa, inclusive na que ele
identificou. Gates por mim: `tsc` 0, **94/94 com zero pulados**. Nenhum arquivo proibido — confirmei
especificamente que **a fixture compartilhada do P00 não foi tocada** —, zero trailers, árvore limpa.

**Ele corrigiu dois vereditos próprios sem eu pedir:** T20 e T24 estavam marcados COBERTO
prematuramente, e "morre em qualquer profundidade" era literalmente falso acima do teto. Também
registrou que a varredura por operador não é dele. Rodei a minha na correção: **61 mortos, 8
sobreviventes**, e classifiquei os oito lendo os sítios em vez de supor por semelhança — que é o que
me fez achar o bypass da vez anterior:

| Sítio | Mutação | Classificação |
|---|---|---|
| `run-binding.ts:116`, `run-binding.ts:233` | `\|\|` → `&&` | **Rótulo, não garantia.** `issue?.path.join('.') \|\| 'binding'` e `caminho \|\| '$'` são o nome do campo no erro e o caminho na raiz. Mutar rótulo não prova nada — mesma família de `\|\| 'body'`, já absolvida por mutação combinada |
| `tool-broker.ts:309` (×2) | `&&` → `\|\|` | **Guarda positivo de três termos**, redundante: é o mesmo sítio que eu já havia absolvido ANTES da correção, deslocado pelas linhas novas |
| `tool-broker.ts:433` (×2) | `\|\|` → `&&` | **Checagem defensiva de forma** sobre `input_schema.properties`, redundante com a validação do manifest que já rodou |
| `tool-broker.ts:264`, `run-binding.ts:228` | `\|\|` → `&&` | **Guarda de tipo** (`valor === null \|\| typeof valor !== 'object'`). Muda o comportamento só para escalar em profundidade, e escalar não esconde nada abaixo de si — que é, aliás, exatamente por que o agente moveu a guarda de profundidade para DEPOIS desta. Ramo não exercitado, sem consequência de segurança |

**O que importa nessa lista é o que NÃO está nela:** as guardas de profundidade. As mutações `>` → `>=`
nos dois tetos **morrem**, então o fail-closed novo está preso por teste, não apenas escrito. Nenhum
dos oito sobreviventes toca uma garantia — e essa conclusão veio de ler os sete sítios um a um, não de
presumir que se pareciam com os já absolvidos.

### V-038 · P04.3b — `pauseConversationTx`, e o eixo que os meus testes não olhavam

**A unidade.** `src/db/repositories/conversation-control-repo.ts` (singular, por C21) com
`pauseConversationTx`: a transação de pausa do §8.2.3, e o **primeiro escritor de
`conversation_controls` em código de produção**. Levantei antes de escrever — não havia nenhum
INSERT/UPDATE sobre a tabela em `src/`, e os únicos incrementos de `control_epoch` viviam em fixtures
dos meus próprios specs. O mecanismo estava declarado na 140 desde o P03.1 e nunca tinha andado fora
de teste.

**Decisões apoiadas em evidência, não em conveniência.** (a) **Auditoria dentro do repositório**: o
cabeçalho do `engine-repos.ts` diz que auditoria não acontece ali, e eu quase li isso como regra da
casa — mas `ops-repos.ts`, `outbound-delivery-repo.ts` e `outbound-outbox-repo.ts` chamam `auditTx` de
dentro da TX exatamente quando a garantia exige atomicidade, que é o caso do §8.2.3 passo 4. O
`auditTx` é deliberadamente SEM try/catch, para a falha da trilha desfazer a escrita que a originou.
(b) **Epoch conferido ANTES do modo**, na ordem do passo 3: o epoch é o marcador de autoridade, e
"você está desatualizado" é fato diferente de "a transição não se aplica aqui". (c) `conversa_id`
NULO na trilha, porque a coluna tem FK para `conversas` e o §8.2.1 admite controle sem conversa
resolvida; os ids viajam no `metadata`, que é o vínculo do §8.6.1.

**Vermelho legítimo e FRACO**, registrado como tal: módulo inexistente, exit 1, `Tests no tests`.

**Mutação: 13 aplicadas, 12 MORTAS.** Os alvos são as cláusulas, não o texto — epoch que não
incrementa, gate de epoch e de modo desligados, `request_hash` ignorado, idempotência sem `agent_id`,
barreira mentindo sobre drenagem, transição pulando `pausing`, `UPDATE` sem dono (que o
`_owner_chk` da 140 recusa), comando criado sem controle, fallback errado do desfecho persistido.

**O único sobrevivente é o M13 — e foi DECLARADO POR ESCRITO ANTES DE RODAR:** remover o `FOR UPDATE`
da busca de idempotência não tem como morrer, porque esta suíte não tem concorrência real. É a mesma
lacuna que carrego desde o P03 ("nenhum teste de concorrência real no módulo"), agora com um mutante
que a demonstra em vez de uma frase que a alega.

**DOIS DEFEITOS MEUS, achados aqui.**
1. Um ramo devolvia `payload_conflict` quando o payload BATIA — o que havia era um comando guardado
   não aceito. Tipo satisfeito, semântica errada, zero testes. Corrigido para devolver o desfecho
   PERSISTIDO (que o `_outcome_chk` da 141 garante existir), com caso próprio. "Inalcançável hoje" não
   justifica resposta errada — é a régua que recusei no C39.
2. **A mutação "idempotência sem `agent_id`" SOBREVIVEU à primeira varredura.** O caso de isolamento
   variava o TENANT, e o helper usava o MESMO agente nos dois — o eixo do agente nunca era exercitado.
   Acrescentei o caso com dois agentes no mesmo tenant e M5 passou a morrer. **É a terceira vez na
   mesma sessão que escrevo uma asserção de isolamento que não morde um dos dois eixos**, e por isso
   virou o registro **C41**, com a regra que adoto daqui em diante.

**Poluição PRE-EMPTADA, não remediada.** `conversation_control_commands_outbox_idx` é PARCIAL e
CROSS-TENANT (coluna líder `lease_expires_at`, mesma forma dos varredores das migrations 114/131/140),
e cada rodada deste spec deixaria ~9 comandos aceitos e não drenados. O `afterAll` **aposenta**
(`drain_status='complete'`) em vez de deletar — a FK é `ON DELETE RESTRICT` — e a fila ficou em **8**,
idêntica à baseline, em todas as rodadas, inclusive nas 13 da varredura.

**Gates:** `tsc` 0, `eslint` 0, `lint` 0 (483 warnings, inalterado), `check:node` 0, `docs:ai:check` 0,
`config:check:drift` 0, `audit:exceptions:check` 0, `migrate:reservations:check` 0.

**Regressão, com aritmética INVERSA à da unidade anterior e prevista antes de medir:**
`50 failed | 10268 passed | 1229 skipped (11547)` contra `50 | 10268 | 1217 (11535)` do V-036.
Passados INALTERADOS e pulados +12 — o spec é de INTEGRAÇÃO e pula na lane unitária, ao contrário do
módulo puro do P04.3a, que somava aos passados. **Real-db: 196/196** em 7 arquivos (184 da baseline
mais os 12 novos), provando que o repositório novo não perturbou nenhum spec do journal.

**O que esta unidade NÃO faz:** a reconciliação `pausing → human`, o `resume`, o serviço puro de
transporte e o router tRPC (C23), os fences das dez fronteiras de egresso do §8.2.4 e a tabela
`conversation_handoff_requests`. A barreira é local: `barrier_committed=true` com
`drain_status='pending'` é o retorno honesto do §8.2.3 — "barreira estabelecida, drenagem pendente",
que a spec proíbe confundir com drenagem concluída.

### V-039 · P04.4 — a reconciliação, e dois mutantes que eu quase contei como mortos

**A unidade.** `reconcilePauseTx` — a transição `pausing → human` do §8.2.1, decidida pelo
reconciliador Maia e não por operador. Por isso ela **não** cria linha em
`conversation_control_commands` (o `kind` daquela tabela só admite `pause` e `resume`): a idempotência
vem do ESTADO, e um controle já em `human` devolve `idempotent: true` sem reauditar.

**Duas garantias estruturais.** O epoch **não** incrementa — "não incrementa epoch novamente só por
confirmar a mesma tomada" —, porque incrementar aqui invalidaria claims que a própria pausa já
fenceou. E a drenagem não é fingida: run aberto, chamada não liquidada, evidência desconhecida ou
artefato não resolvido mantêm o modo em `pausing` com `reconciliation_required`.

**A evidência é COMPOSTA, e declarada como tal (C42).** O "journal de efeitos/admissão" do §8.2.3 não
existe; a prova sai de três fontes que existem: fase de run aberto (a definição do próprio banco, via
`engine_runs_one_open_turn_uq`), os quatro estados do índice parcial
`engine_tool_calls_unsettled_idx` — reusados, não reinventados — e o conjunto "resolvido" do C18.
`approval_required` fica de fora por decisão registrada (C44). E o retorno **declara o próprio limite**
em `drain_scope: 'engine_originated_only'`, porque `outbound_messages` não alcança o controle (C43).

**Vermelho FORTE, e o mais forte da épica:** 11 casos EXECUTARAM e falharam com
`TypeError: reconcilePauseTx is not a function`, com **zero** erros de fixture. Chegar a esse vermelho
custou três correções de fixture minhas — `representative_message_id` tem FK para `mensagens`,
`protocol_version` é NOT NULL com CHECK `= 1`, e `engine_runs_closed_chk` exige `closed_at`,
`closed_reason` e `capabilities_revoked_at` juntos. Um vermelho por fixture quebrada não mede o que o
teste afirma medir.

**Mutação, em três rodadas: 14 MORTOS, 3 sobreviventes, 0 sem explicação.**

⚠️ **Dois mutantes foram PULADOS por âncora ambígua, e isso é o achado de método da unidade (C47).**
`M01` (o gate de epoch) e `CB4` (o escopo do lock) casavam DUAS vezes no arquivo, porque `pauseInTx` e
`reconcileInTx` moram no mesmo módulo e compartilham vocabulário. A guarda do harness os recusou e
imprimiu `PULADO` — mas pulado é **indistinguível de morto para quem lê só o placar**. Remedidos com
âncora única, **os dois morreram** (`M01b`, `CB4b`). Se eu os tivesse somado, teria registrado "15 de
15" com duas das garantias centrais jamais exercitadas.

**Os 3 sobreviventes foram ATRIBUÍDOS por mutação combinada, não explicados por hipótese.** Tirar
`tenant_id` e `agent_id` das contagens (CB1, CB2) e do `UPDATE` de modo (CB3) não muda nada — e
`CB4b`, que tira o escopo do **lock**, MATA. Conclusão medida: o isolamento é enforçado no lock, e os
predicados nas contagens são defesa em profundidade sobre uma topologia que já escopa (`control_id` +
FK composto + PK uuid).

**Dois defeitos meus, achados pela varredura e corrigidos com caso próprio.** `epoch_mismatch` estava
declarado no tipo de retorno e **nunca era produzido** — vocabulário sem emissor, o mesmo defeito que
o C24 registra contra mim; liguei a conferência (§8.2.3 passo 3) e o caso 12 passou a exigi-la. E a
contagem de entregas desconhecidas **dobrava** com múltiplas gerações de run no mesmo turno, porque
`outbound_messages` junta por turno e `one_open_turn_uq` só restringe as ABERTAS; o caso 13 prende o
`count(DISTINCT o.id)`. Nenhum dos dois era visível no verde de 11 casos.

**Gates:** `tsc` 0, `eslint` 0, `lint` 0 (483 warnings, inalterado), `check:node` 0, `docs:ai:check` 0,
`config:check:drift` 0, `audit:exceptions:check` 0, `migrate:reservations:check` 0.
**Real-db: 209/209 em 8 arquivos** (196 da baseline + 13 novos) — nada do journal foi perturbado.

**⚠️ REGRESSÃO: a aritmética NÃO fechou sozinha, e isto fica registrado em vez de arredondado.**
`51 failed | 10267 passed | 1242 skipped (11560)` contra `50 | 10268 | 1229 (11547)` do V-036.
Pulados e total sobem exatamente +13 (o spec é de integração e pula na lane unitária), mas **falhas
+1, passados −1 e arquivos em falha 20 → 21**. Atribuído por medição, não por conveniência:
- o 21º arquivo é `tests/unit/scripts/check-commit-trailers.spec.ts`, **flake sob paralelismo total**
  — isolado dá **13/13 em 11s, duas vezes**, e na suíte cheia levou 51s e falhou um caso. O fonte
  prova que ele cria um repositório git PRÓPRIO em temp dir, então não depende da minha branch nem da
  minha decisão sobre o trailer. Minha primeira hipótese era que fosse meu, e a evidência a desmentiu;
- `setup-auth-dir` e `tool-request-credencial` falham deterministicamente, mas são **baseline
  documentada**: constam nominalmente do catálogo do V-007 (linha 128, "`tool-request-credencial` 1 ·
  `setup-auth-dir` 1 (drive letter)"), e as mensagens confirmam causa de Windows — letra de unidade e
  separador de caminho. Nenhuma das duas alcança módulo meu.

**Poluição PRE-EMPTADA e um vazamento ANTIGO estancado (C46).** A guarda de aposentadoria manteve a
fila de outbox em ZERO durante as três rodadas de mutação. E a atribuição por tenant revelou que as 10
linhas que eu vinha lendo como "baseline 8" eram vazamento do spec **commitado** do P04.1, crescendo 2
por rodada; a mesma guarda foi aplicada lá e a fila passou a ZERADA.

**O que esta unidade NÃO faz:** o `resume` com `resumePolicy='future_only'`, o serviço puro de
transporte e o router tRPC (C23), os fences das dez fronteiras de egresso do §8.2.4 e a tabela
`conversation_handoff_requests`.

### V-040 · P04.5a — a retomada, e um sobrevivente cuja análise mudou a minha conclusão

**A unidade.** `resumeConversationTx` — `human → bot` do §8.2.1, com `resumePolicy='future_only'`
obrigatório na V1 (§8.2.5).

**O contraste que importa: aqui o epoch INCREMENTA.** Na reconciliação ele não incrementa ("não
incrementa epoch novamente só por confirmar a mesma tomada"); aqui sim, porque o §8.2.2 manda
incrementar nos DOIS extremos para derrotar o ABA — "um run iniciado no epoch antigo não recupera
autoridade só porque o modo voltou a `bot`". Dois casos prendem os dois lados.

**O par de auditoria.** `conversation_resume_requested` e `conversation_automation_resumed` são ações
separadas porque o §8.3.2 manda o resume recusar enquanto houver pendência — existe um estado real em
que o operador pediu e a automação não voltou. Colapsá-las apagaria essa distância, que é exatamente o
erro registrado no C24.

**O watermark, e a fixture que o torna mensurável (C48).** Neste banco há 10.611 turnos e ZERO com
`first_ingress_seq`, porque todas as fixtures da épica criam turno por INSERT cru sem stream. Um teste
montado sobre esse corpus compararia nulo com nulo. A fixture desta unidade semeia
`agent_stream_sequences` com números ESCOLHIDOS e insere turnos satisfazendo o trio do
`agent_turns_stream_shadow_chk`.

**Vermelho FORTE:** 14 casos EXECUTARAM e falharam por `resumeConversationTx is not a function`, com
**zero** erros de fixture — e esta era a fixture mais delicada da épica.

**Mutação em duas rodadas: 16 medidas, 13 mortas, 1 sobrevivente atribuído, ZERO puladas.** A
contagem de âncoras passou a ser impressa ANTES de rodar — precaução direta do C47, e necessária:
o predicado de epoch existe agora em TRÊS funções deste módulo, e uma âncora do vocabulário comum
casaria três vezes e seria pulada em silêncio. Todas as 16 vieram `n=1`.

**O sobrevivente que mudou a minha conclusão.** A mutação que remove o termo "maior turno retido" do
watermark sobreviveu, e eu ia registrá-la como lacuna de fixture. A análise correta é outra: o
contador **é** o alocador, então em produção `contador >= maior ingresso de turno` sempre vale e os
dois lados do `GREATEST` empatam — a fixture não estava errada, o caso decisivo é outro. O termo do
turno existe para quando a **linha do contador não existe** (purgada, ou turno vindo de migração), e é
esse o caso que distingue os lados. Escrevi o caso 14 (turnos presentes, contador DELETADO) e o
mutante passou a morrer. Sem ele, o watermark cairia a 0 e `future_only` reabriria todo o backlog.

**O sobrevivente remanescente está ATRIBUÍDO, não explicado.** Remover `AND mode = 'human'` do `WHERE`
do `UPDATE` sobrevive. Mutação combinada mostra por quê: desligar a conferência ANTERIOR mata (o
`UPDATE` passaria a recusar por `control_not_found` em vez de `mode_not_allowed`, e o caso 5 cobra o
motivo certo), e remover o escopo do LOCK mata. Ou seja — a conferência anterior carrega o MOTIVO, o
lock carrega o ISOLAMENTO, e o fence no `UPDATE` é redundante com o lock, mesma classe dos CB1–CB3 da
reconciliação. Mantido como defesa em profundidade, com a redundância medida em vez de suposta.

**Tolerância do C50 prendida por teste:** turnos criados pelo caminho de compatibilidade
(`ensureTurnForMessage`, que não aloca sequência) têm ingresso NULO e ficam fora da ordenação por
construção; a captura do watermark não pode falhar por isso, e o caso 13 garante.

**Gates:** `tsc` 0, `eslint` 0, `lint` 0 (483 warnings, inalterado), `check:node` 0, `docs:ai:check` 0,
`config:check:drift` 0, `audit:exceptions:check` 0, `migrate:reservations:check` 0.
**Real-db: 223/223 em 9 arquivos** (209 + 14).

**Regressão, fechando EXATA desta vez:** `51 failed | 10267 passed | 1256 skipped (11574)` contra
`51 | 10267 | 1242 (11560)` do V-039. Falhas e passados INALTERADOS, pulados e total **+14**, os
mesmos 21 arquivos em falha (o 21º é o flake de `check-commit-trailers` já atribuído no V-039), e
nenhuma falha citando meus módulos.

**O que esta unidade NÃO faz:** o cancelamento administrativo do backlog (**U-P04.5b**), que exige
acrescentar `queued → ignored` e `retryable → ignored` a `MANUAL_TRANSITIONS` — contrato COMPARTILHADO
que governa todo turno do sistema (C49) —, e que não pode usar o watermark como critério único, porque
turnos sem sequência não são ordenáveis por ele (C50). Também fora: o serviço puro de transporte e o
router tRPC (C23), os fences das dez fronteiras do §8.2.4 e `conversation_handoff_requests`.

### V-041 · P04.6 — o hold de admissão/claim, e uma regressão que eu causei e só achei por medição pareada

**Por que esta unidade existe, e por que ela PRECEDE o U-P04.5b.** Eu ia implementar o cancelamento
administrativo do backlog. Ao inspecionar o código em vez de presumir, encontrei que **nada retinha o
backlog**: `claimWithinStreamExclusion` filtrava por escopo, head-of-line e `agent_stream_blocks`;
`findRecoverableTurns`, por head-of-line e poison. Nenhum dos dois consultava `conversation_controls`.
A única barreira de controle no código vivia em `engine-repos.ts` (`c.mode = 'bot'` + epoch) e guarda o
RUN DO MOTOR, não o turno — ou seja, **sob controle humano o caminho baseline continuava podendo
reivindicar e executar um turno**. Escrever a limpeza de um backlog "retido" antes de existir retenção
seria construir sobre premissa falsa. Não é expansão de escopo: o capítulo 10 põe "hold de inbound" na
linha do **P04**, e o §8.2.4 nomeia a fronteira e até o motivo fechado (`conversation_human_control`).

**Vermelho, nas duas camadas.** Unitário: 12 casos, 11 falhando cada um pelo seu motivo. A primeira
versão foi FRACA — compilava o SQL no escopo de módulo, o arquivo não carregava e zero casos rodavam;
corrigi adiando a compilação para dentro de cada caso, porque um vermelho que só diz "o import falhou"
não prova comportamento. Integração: **8 recusas vermelhas contra 5 concessões verdes**, de 13 — e a
assimetria é a evidência: o caso 12 viu `promoted_at` CARIMBADO no sucessor de uma conversa em `human`,
pela porta de produção, antes de existir implementação.

**Mutação: 18 medidas, 15 mortas, 1 sobrevivente ATRIBUÍDO, ZERO puladas**, em duas rodadas, com a
contagem de âncoras impressa antes de cada uma (todas n=1, precaução do C47).

⚠️ **Um sobrevivente mudou a minha conclusão.** M07 (remover o filtro de modo da SONDA) sobreviveu na
rodada 1 e eu ia registrá-lo como redundante — "a sonda só roda depois de o claim falhar". Errado: ela
é alcançável com a conversa em `bot`, bastando o claim falhar por FILA, que é o motivo mais comum de
todos. Sem o filtro, a recusa devolveria "controle humano" para uma conversa que ninguém assumiu — o
colapso de diagnóstico que o meu próprio comentário de vocabulário promete não existir. Era LACUNA DE
COBERTURA, não redundância; o caso 14 a fecha e M07 passou a morrer. O remanescente (M08, a guarda
`alvo.stream_key IS NOT NULL`) está atribuído por mutação COMBINADA: isolada sobrevive, mas derrubando
junto a igualdade do JOIN o caso 16 mata — a redundância está com o JOIN, medida e não suposta.

⚠️ **A REGRESSÃO QUE EU CAUSEI, e como ela apareceu.** A suíte deu **124 falhas** contra 51 registradas.
Tentei atribuir a ambiente; para ter direito a isso, medi a baseline **no HEAD, nesta máquina, com a
MESMA invocação**: `50 | 10268 | 1256 (11574)`. A comparação era válida e a culpa era minha — os 8
arquivos a mais somavam `14+7+43+1+9 = 74`, exatamente `124 − 50`. **Causa:**
`conversation-control-sql.ts` avaliava `const COLUNAS = sql\`…\`` no escopo de MÓDULO desde o P04.3a;
enquanto só `engine-repos.ts` o alcançava, ninguém notou, mas o P04.6 o pôs no grafo de `turn-repos.ts`
e oito specs com `vi.mock('drizzle-orm')` PARCIAL passaram a estourar na carga. A casa já tem a regra
escrita em `stream-metrics.ts` ("um módulo importado por um repositório não pode ter efeito no
import") e `stream-head-sql.ts` a obedece. Corrigido na RAIZ (`COLUNAS` virou função, SQL idêntico), e
não nas oito specs alheias: os 8 arquivos voltaram a **103/103**. Nada disso foi pego por teste meu —
os 7 importadores diretos estavam verdes, `tsc` 0, `eslint` 0, real-db 16/16. Quem pegou foi a
aritmética não fechar.

**Guarda de cardinalidade endurecida, não afrouxada.** `stream-fairness-metrics` proibia
`/stream_key|…|conversa|…/` em qualquer lugar do blob de labels, e meu valor de vocabulário FECHADO
`conversation_human_control` trombava pelo pedaço "convers-a-tion". Renomeá-lo criaria dois nomes para
o mesmo fato (o que a #626 centralizou para impedir), então ancorei o padrão na posição de NOME de
label — `(^|,)(…)\w*=` —, o que passa a pegar também `conversa_id=`, `tenant_id=` e `agent_id=`.
**Provado por mutação:** injetei um label `stream_key` na semeadura e o caso REPROVOU; restaurado, 9/9.

**Gates:** `tsc` 0, `eslint` 0. **Real-db 16/16.** Guardas de vocabulário (4 delas escritas por outros):
123/123.

**Regressão, com a aritmética fechando e o resíduo atribuído:** `51 failed | 10279 passed |
1272 skipped (11602)` contra a baseline MEDIDA no HEAD `50 | 10268 | 1256 (11574)`. Total **+28** e
pulados **+16** — exatamente os 12 casos unitários e os 16 de DB real, que pulam na lane unitária.
Passados +11 e falhas +1: o desvio é `check-commit-trailers`, que não estava nos 20 arquivos da
baseline e rodou 79,5s aqui. **Reprovado por medição NOVA, não herdado do V-039:** isolado deu 13/13
duas vezes (7,54s e 7,73s), e nem a spec nem o script citam qualquer módulo desta branch. Logo
`10268 + 12 − 1 = 10279` e `50 + 1 = 51`. Os outros 20 arquivos e os 2 que não carregam são idênticos
à baseline.

**O que esta unidade NÃO faz:** o cancelamento do backlog (U-P04.5b) segue pendente, agora com a
retenção existindo debaixo dele. Também fora: o serviço puro de transporte e o router tRPC (C23), as
outras nove fronteiras de egresso do §8.2.4 e `conversation_handoff_requests`.

### V-042 · P04.5b.1 — as duas arestas manuais no contrato compartilhado

**O recorte, e por que ele existe.** O C49 já registrava que o descarte administrativo de backlog
(§8.2.5) exige acrescentar `queued → ignored` e `retryable → ignored` a `MANUAL_TRANSITIONS` —
contrato COMPARTILHADO que governa todo turno do sistema. Separei a mudança de contrato da transação
de cancelamento pelo mesmo critério que separou P04.3a de P04.3b: uma alteração de raio global não
deve viajar dentro de um commit de repositório, onde ninguém a procuraria.

**Duas arestas, e só duas.** `received → ignored` e `running → ignored` já existiam na tabela
AUTOMÁTICA desde o #503; a spec cita três estados de origem e faltavam exatamente estes dois. Entram
pela porta MANUAL porque a cláusula é literal — "sem liberar `queued → ignored` para callers
automáticos". **Sem migration:** o par `ignored` + `operator_cancelled` já está em `TERMINAL_OUTCOMES`
e já é aceito pelo CHECK `agent_turns_status_outcome_chk` (migrations 097 e 115), verificado antes de
escrever.

**Vermelho forte — e ele pegou um defeito MEU antes de existir código.** 4 casos novos falhando, cada
um com motivo legível, e os **49 preexistentes intactos**. Eu previra que um dos quatro passaria de
saída; ele falhou, por asserção FALSA minha: afirmei que `queued → superseded` seria recusado na porta
manual, quando `superseded` é aresta AUTOMÁTICA de `queued` desde o #503 — é como o debounce absorve um
irmão. O conserto tentador era o perigoso: "ajustar" o contrato para satisfazer o teste teria removido
uma transição viva. Corrigi a asserção e deixei a armadilha escrita no próprio caso.

**A armadilha que o contrato agora documenta:** `sourceStatusesFor('ignored', { manual: true })`
devolve `running` JUNTO, por causa da aresta automática que já existia. Um caller que passe esse
conjunto direto ao `UPDATE` cancelaria administrativamente um turno EM EXECUÇÃO — o oposto do "sem
execução/efeito pendente" que a spec exige. Um caso próprio prende isso, para a fatia seguinte não
redescobrir em produção.

**Mutação: 6 medidas, 6 MORTAS, zero sobreviventes, zero puladas**, âncoras todas em n=1. A que mais
importa é a **M5**, e ela não remove nada: acrescenta `ignored` à tabela AUTOMÁTICA de `queued`,
deixando a manual no lugar. Se sobrevivesse, os testes estariam afirmando que a aresta EXISTE sem
afirmar por qual PORTA ela se abre — e a cláusula da spec é sobre a porta. Morreu.

**Gates:** `tsc` 0, `eslint` 0. **Raio medido: 212/212 em 13 specs de turno** (contrato, fence, claim,
lifecycle, gauges, promoção, exclusão, head-of-line, poison, absorção, retry, lease e o contrato do
hold do P04.6). **DB real:** `agent-turns-real-db` 21/21.

⚠️ **`turn-poison-dlq-real-db` não carrega, e a atribuição foi MEDIDA.** Ela morre em `loadConfig`
(`env.ts:112`) a partir de `lifecycle.ts:25` — que importa o contrato que acabei de mexer, então "tem
cara de config" não bastava. Rodei os DOIS eixos na mesma invocação, variando só o meu código: sem a
mudança e com ela, a falha é **idêntica** (14 pulados, mesmo stack). É a família do C54, não esta
fatia. Restauração conferida: aresta de volta, diff de novo em 38/2.

**Regressão fechando exata:** `50 failed | 10284 passed | 1272 skipped (11606)` contra
`51 | 10279 | 1272 (11602)` do V-041, mesma invocação. Total **+4** e pulados **inalterados** — os
quatro casos são puros e rodam na lane unitária. Passados +5 e falhas −1 são a MESMA linha:
`check-commit-trailers` saiu da lista de arquivos em falha. É o flake que o V-041 atribuiu por medição
(13/13 isolado, duas vezes), e vê-lo falhar numa rodada e passar na seguinte **com o mesmo código** é
evidência adicional de que é flake, não regressão. Logo `10279 + 4 + 1 = 10284` e `51 − 1 = 50`. Os
outros 20 arquivos em falha e os 2 que não carregam são idênticos à base.

**O que esta unidade NÃO faz:** o cancelamento em si (**U-P04.5b.2**) — seleção do backlog retido sob
o lock do controle, filtro de "sem execução/efeito pendente", descarte em `ignored`/`operator_cancelled`
e trilha por turno. O terreno já está levantado com evidência: a transação existe
(`resumeConversationTx`, encaixe entre a captura do watermark e o INSERT do comando, sob o MESMO lock);
o precedente de lote é `recoverExpiredStreamClaims` (CTE `MATERIALIZED`, `ORDER BY t.id`,
`FOR UPDATE OF t` — a "ordem determinística de turnos" do §8.2.3 passo 3); a transição deve passar pelo
CONTRATO e não por `UPDATE` cru, seguindo `completeRecoveredOutboundTurnInTx` ("conflito aqui é
rollback obrigatório"); a "referência ao comando" **não** pede coluna nova — `agent_turns` não tem
nenhuma serventia (li a tabela inteira) e o padrão da casa é a trilha (`auditTx` aceita `alvo_id`),
enquanto as colunas `control_id`/`control_epoch`/`origin` que o §8.2.4 manda acrescentar pertencem à
fatia dos fences de egresso; e a prova de drenagem existente é escopada por CONVERSA, precisando de
variante por TURNO — há precedente da forma em `engine-repos.ts:1010`.

### V-043 · P04.5b.2a — os construtores puros do descarte, e duas coisas que a medição me desmentiu

**O recorte.** O cancelamento do §8.2.5 tem três peças com riscos diferentes: os construtores de SQL,
a primitiva de transição por turno e a fiação na transação do resume. Esta fatia entrega só a
primeira, pelo critério do P04.3a — o que pode ser provado sem Postgres deve ser, porque um teste de
integração que não roda (e o banco pode estar fora justamente quando alguém mexe no predicado) não
prova nada.

**Por que um predicado de efeito NOVO, por TURNO.** A `reconcilePauseTx` já compõe evidência, mas
escopada pelo CONTROLE: responde "esta CONVERSA tem algo em voo?". A pergunta do §8.2.5 é "este TURNO
tem efeito pendente?", e conflatá-las erraria nos DOIS sentidos — um único run aberto em qualquer
turno impediria o descarte de todo o backlog, e um backlog sem efeito nenhum ficaria preservado por
causa de um turno alheio. O caso 14 prende a distinção; a mutação que reancora no controle morre nele.
O que o predicado **não** prova está escrito no código: efeito de origem não-engine é invisível a ele
(C43), e a cobertura disso é a unidade dos fences do §8.2.4.

**Vermelho forte:** `executados=15 falharam=8 pulados=0` — oito casos novos executando e falhando por
função ausente, sete preexistentes intactos, arquivo CARREGANDO (compilação adiada para dentro de cada
caso, precaução adotada depois do vermelho fraco do P04.6).

**Mutação em duas rodadas — 14 hipóteses distintas, 14 MORTAS, zero sobreviventes, zero sem
explicação.** A rodada 1 teve 13 tentativas e DUAS não produziram resultado, ambas por defeito meu:
- **M07 foi PULADA por âncora ambígua (n=2)** — `AND c.id = ${input.control_id}` também existe em
  `lockControlByIdSql`. É o C47 de novo; somá-la como morta teria registrado "12 de 13" com o escopo
  do comando JAMAIS exercitado. Reancorada na linha do `WHERE` que só existe na seleção: morta.
- **M10 sobreviveu por defeito da MUTAÇÃO, não por lacuna do teste** — ela ACRESCENTAVA
  `SELECT 1 WHERE FALSE` antes do `FROM`, então o texto compilado continuava contendo tudo o que as
  asserções cobram. Mutação que não remove nada não prova nada. Refeita removendo o bloco inteiro:
  morta. Acrescentei a M14 para checar se a asserção sobre `engine_runs` também não era vácua: morta.

⚠️ **O `EXPLAIN` fechou uma lacuna estrutural — e me desmentiu.** `sqlToQuery` compila sem validar:
sintaxe inválida ou `FOR UPDATE OF` mal colocado passariam pelos 15 casos. Rodei `EXPLAIN` contra o
Postgres real (sem ler nem escrever linha): a seleção produz `LockRows` no topo — o `FOR UPDATE OF t`
é de fato aplicado — e os dois `NOT EXISTS` viram `Nested Loop Anti Join`. **Mas** eu havia escrito no
código que os literais servem "para o planejador escolher o índice parcial", copiando a justificativa
de `stream-head-sql.ts`. O plano medido usa `engine_tool_calls_ordinal_uq` com `Filter`;
`engine_tool_calls_unsettled_idx` NÃO entra — e a causa não é o `OR`, é que aquele índice é chaveado
por `run_id` e esta consulta filtra por `turn_id`. Corrigi o COMENTÁRIO em vez de torcer o código para
salvar a frase. Ressalva de método: o corpus local tem ≈11k turnos, então a ESCOLHA de plano não é
conclusiva para produção; conclusivo é a VALIDADE do SQL e o fato estrutural do índice não cobrir
`turn_id`.

⚠️ **E uma medição descartou o `LIMIT` que eu ia acrescentar.** A lente de locks levanta o custo de
segurar N locks de linha dentro da transação do resume, e a convenção da casa para lote é 200
(`findRecoverableTurns`, `listDueDebounceStreams`). Medi duas coisas antes de decidir: **não existe
teto configurado** para backlog por conversa, e o corpus local não serve para estimá-lo (máx. 3
turnos não-terminais por stream — dado de fixture). O que decidiu foi outro fato: `grep` mostra que
**`resume_after_ingress_seq` não tem LEITOR** — é escrito pelo resume e lido só pelo próprio caminho
idempotente dele; nem o claim, nem o recovery, nem o dispatcher, nem a promoção o consultam. Logo o
watermark segue INERTE como imposição, e `future_only` é imposto **somente pelo cancelamento**. Um
`LIMIT` deixaria o resto do backlog reivindicável assim que o modo voltasse a `bot`: seria buraco de
CORREÇÃO, não troca de desempenho. Fica registrado que a atomicidade (conflito ⇒ rollback de tudo,
inclusive do resume) é consequência disso, não preferência.

**Terceira cópia de uma lista, medida antes de aceita.** `ESTADOS_DE_CALL_EM_VOO` é a terceira cópia
da lista de call não-liquidada (`conversation-control-repo.ts`, `engine-repos.ts`). Conferi: **as três
são idênticas hoje** e batem com o predicado do índice parcial da 140 (linha 395). Não há divergência
viva; o risco é PROSPECTIVO. A unificação ganha vermelho próprio na fiação, amarrando a lista ao TEXTO
da migration e não à outra cópia.

**Gates:** `tsc` 0, `eslint` 0. Guarda contra o C51 (as oito specs que o grafo de imports deste MESMO
arquivo derrubou horas antes): **103/103** — acrescentar `engine_tool_calls` não reintroduziu
avaliação no escopo de módulo.

**Regressão fechando exata:** `51 failed | 10291 passed | 1272 skipped (11614)` contra
`50 | 10284 | 1272 (11606)` do V-042. Total **+8** e pulados inalterados — os oito casos são puros.
Passados +7 e falhas +1 são a mesma linha: `check-commit-trailers` voltou, em 98,7s. Ele já oscilou em
TRÊS rodadas consecutivas com o mesmo código (presente, ausente, presente) — evidência de flake mais
forte que a atribuição por isolamento do V-041. `10284 + 8 − 1 = 10291` e `50 + 1 = 51`.

⚠️ **Os dois construtores estão INERTES: nenhum call site de produção.** Registro porque é a mesma
crítica que fiz às branches P05/P06. A diferença é que a fiação é a fatia imediatamente seguinte e
está desenhada com evidência, não prometida.


### V-044 · P04.6b — o hold no caminho do DEBOUNCE, e o flake finalmente NOMEADO pelo reporter

**De onde veio a fatia.** Não de leitura minha do plano: da revisão adversarial, que apontou que o
hold do P04.6 cobria admissão/claim mas **não** o fechamento de janela de debounce. Confirmei lendo o
código e, em seguida, com um vermelho executável — que é o único grau de confirmação que conta aqui.

**Vermelho:** `2 failed | 17 passed (19)`. O caso 17 falhou com `expected true to be false`, isto é,
`closed === true`: o fechador **fechava** a janela de uma conversa sob controle humano. O caso 19
mostrou o enumerador listando a stream retida. O defeito era real e estava em produção.

**Quatro edições, e a divisão de trabalho entre elas está no código.** `listDueDebounceStreams` ganhou
o predicado na forma cross-tenant; `closeDueDebounceBatchTx` ganhou uma sonda `humanControlProbe` que
retorna cedo com o motivo honesto, **e** o predicado no `WHERE` do CAS. A sonda dá o MOTIVO; o
predicado no CAS dá a ATOMICIDADE — esta transação segura o mutex da STREAM, não o lock do CONTROLE,
então entre ler a sonda e escrever o `UPDATE` uma pausa pode comitar. `DebounceCloseResult` ganhou
`'conversation_human_control'` na união de recusa.

**Mutação: 4 hipóteses, 3 mortas, 1 sobrevivente ATRIBUÍDA — e a atribuição foi medida, não alegada.**
Âncoras contadas e impressas antes de rodar (C47): `n=[1]`, `n=[1]`, `n=[1]`, `n=[1,1]`, zero pulados.

| mutante | desfecho | assertiva |
|---|---|---|
| M1 · enumeração perde o hold | MORTA (caso 19) | o varredor volta a listar a stream retida |
| M2 · CAS perde o hold | **SOBREVIVEU** | previsto por escrito ANTES de medir |
| M3 · sonda some | MORTA (caso 17) | `expected 'lost_race' to be 'conversation_human_control'` |
| CB · sonda + CAS juntos | MORTA (caso 17) | `expected true to be false` |

A sobrevivência da M2 **não** é lacuna: M3 e CB morrem no mesmo caso por assertivas DIFERENTES, e é
essa diferença que fecha a atribuição. Sem a sonda, o CAS ainda recusa e o resultado vira `lost_race`
— janela preservada, motivo errado ao operador. Sem os dois, a janela **fecha**. Logo o predicado do
CAS é carga real quando é a única coisa de pé; ele sobrevive à M2 apenas por redundância com a sonda,
numa corrida (pausa comitando entre sonda e `UPDATE`) que o teste não consegue encenar. Se eu tivesse
rodado só M1/M2/M3, teria registrado "1 sobrevivente sem explicação" ou, pior, removido o predicado.

**Gates:** `tsc exit=0`, `eslint exit=0`, contrato 40/40 (contagem de consumidores agora 6), hold
19/19.

⚠️ **`turn-stream-debounce-real-db` não pôde ser usada como evidência, e isso foi ATRIBUÍDO por eixo
pareado:** sem a mudança (4 chamadas) e com ela (6), a saída é idêntica — `17 skipped | 1 file failed`
com `Invalid configuration: 1 problema(s) no profile development` em `src/config/env.ts:112`. É a
família do C54 (a config local pula o `globalSetup`), não esta fatia.

**Regressão — e aqui o método importa mais que o placar.** `54 failed | 10288 passed | 1275 skipped
(11617)`. O baseline que eu tinha REGISTRADO era `51 | 10291 | 1272 (11614)`, o que daria "+3 falhas"
e cheiro de regressão. Em vez de aceitar ou descartar, **remedi o HEAD nesta máquina, com a mesma
invocação**, escrevendo os blobs do HEAD por cima (sem tocar no índice) e restaurando depois com
conferência de SHA: `53 | 10289 | 1272 (11614)`. **O mesmo commit oscilou 51 → 53 sozinho.** Logo o
placar isolado não decide nada; o que decide é o diff dos CONJUNTOS:

- total **+3** e pulados **+3** = os três casos novos da spec de DB real, que pulam na lane unitária;
- falhas **+1** / passados **−1** = **uma** linha, `check-commit-trailers`;
- conjunto de arquivos em falha: **um a mais, zero a menos**, e nenhuma área desta branch aparece.

**E o flake enfim tem MECANISMO, não só histórico.** O V-043 registrou "oscilou em três rodadas".
Agora o reporter do próprio repositório o nomeia: na rodada do HEAD ele aparece em `PRAZOS ESTOURADOS`
como `46983ms · tentativas=2 · PASSOU MESMO ASSIM` e `35180ms · tentativas=2 · PASSOU MESMO ASSIM`,
sob `RECUPERADOS PELA SEGUNDA TENTATIVA (retry): 2`, com `[tentativa 1] Test timed out in 20000ms`. Na
minha rodada, o mesmo teste deu `48086ms · tentativas=2 · FAILED` — as DUAS tentativas estouraram.
Isolado na minha árvore: 13/13 em **8,37s**, esse caso em **1897ms**, 25× abaixo do limite. É uma
moeda jogada contra um prazo de 20s sob paralelismo total, num teste que cria repositório git próprio
em temp e não importa nada desta branch. Fica atribuído por mecanismo, não por reincidência.

🔧 **Nota operacional (não é achado de produto).** `git status` reportava 5 arquivos modificados
enquanto `git diff --numstat` reportava 3. Medido: `porcelain=v2` mostra OIDs IDÊNTICOS dos dois lados
e `git diff HEAD` vazio nos dois extras — eles estão apenas *stat-dirty*, mexidos no mtime pelas
varreduras que escrevem e restauram arquivos. A causa é que `git update-index --refresh` responde
`needs update` e sai **1**: não consegue gravar o índice (worktrees compartilham estado e há sessões
concorrentes). Consequência adotada: **estagiar sempre por caminho explícito, nunca `git commit -a`**,
para que a decisão do que entra no commit não dependa de um `status` que está lendo cache velho.

### V-045 · P04.5b.2b — a primitiva do descarte, e um VERMELHO que passava de graça

**O recorte.** Só a primitiva `cancelHeldBacklogTurnInTx` e o emissor adiado
`recordBacklogCancellationCommitted`. A fiação dentro do `resumeConversationTx` é a fatia seguinte, e
fica dito aqui em vez de subentendido: **os dois nascem INERTES, sem call site de produção.**

**O vermelho inicial era fraco e eu quase o aceitei: `6 failed | 4 passed`.** Os quatro que passavam
eram os casos 4, 5, 8 e 9 — todos escritos como `rejects.toThrow()`. Um `TypeError: … is not a
function` satisfaz `toThrow()`, então eles passavam contra implementação NENHUMA. Endurecidos para
cobrar o conflito específico (`state_mismatch` para status/versão, `not_found` para fora de escopo, os
dois medidos na classificação de `runTransitionOnExecutor`), o vermelho virou **10/10**.

**Duas vacuidades a mais, e uma delas foi o LINT que apontou.** As advertências de `inA2` e `inB` não
usados não eram estilo: os casos de isolamento provavam "A não alcança" sem nunca provar que o turno
era cancelável — se a fixture produzisse um turno que ninguém consegue cancelar, os dois passariam por
engano. Fechada a outra metade (o dono alcança, e o turno vai a `ignored`), as advertências somem
porque o teste passou a prender algo. A terceira: `claim_token` nascia nulo, então a asserção sobre
`clearClaim` não mordia — o caso 6 passou a SEMEAR a posse. E a guarda `cancelados <= 0` não tinha
caso: virou o caso 11, porque `incCounter(nome, labels, 0)` CRIA a chave e publicaria uma série
permanente em zero.

**Mutação, primeira rodada: 9 medidas, 8 mortas, 1 SOBREVIVENTE QUE EU NÃO PREVIA.** Eu havia escrito,
antes de rodar, que não esperava sobrevivente — justamente porque tinha eliminado os dois previsíveis
endurecendo o spec. Sobreviveu a **M8: emitir o contador DENTRO da transação**.

A causa não era o código, era a asserção. O caso 10 procurava a agulha
`to="ignored",outcome="operator_cancelled"`, e `key()` em `src/lib/metrics.ts:41-47` **ordena os
rótulos alfabeticamente** (`.sort(([a],[b]) => a.localeCompare(b))`), de modo que o render real é
`from="any",outcome="operator_cancelled",to="ignored"`. A agulha procurada NUNCA é produzida: a
asserção não podia falhar. O teste afirmava provar "a métrica não é emitida dentro da transação" e não
prendia nada — a mesma família do **C41**, agora pela quinta vez, e desta vez quem pegou foi a
varredura, não a leitura. Corrigido usando a MESMA agulha nas duas metades (ausente antes do commit,
presente depois), o que torna o par verificável em vez de simétrico só na aparência.

**Segunda rodada: 9 medidas, 9 MORTAS, 0 sobreviventes, 0 puladas.** A M8 agora morre no caso 10.

⚠️ **A guarda de âncora trabalhou de novo (C47):** M3, M4 e M5 vinham com `n=[5]`, `n=[5]` e `n=[3]` —
as linhas de `patch:` e `expected_version:` se repetem em outras transições do arquivo. Reancoradas no
comentário único da função (e, para o CAS, colando a linha em `sources:`, que é `n=1`). Sem isso eu
teria registrado três mutantes PULADOS como se fossem mortos.

**Gates:** `tsc` 0, `eslint` 0 (as duas advertências desapareceram pelo conserto acima, não por
supressão). Família real-db inteira: **337 casos, 13 arquivos, 0 falhas**, com os 253 de DB real em 11
arquivos.

**Regressão fechando EXATA, e é a mais limpa da sessão:** `54 failed | 10288 passed | 1286 skipped
(11628)` contra `54 | 10288 | 1275 (11617)` do V-044. Falhas e passados **INALTERADOS**; pulados
**+11** e total **+11**, exatamente os onze casos, que pulam na lane unitária por serem de DB real. O
conjunto de arquivos em falha é **idêntico** — nenhum entrou, nenhum saiu.

🔧 **Correção de um defeito que eu havia acabado de commitar.** O cabeçalho do import de
`conversation-control-sql.js` em `turn-repos.ts` dizia "os QUATRO consumidores" e os enumerava,
enquanto o P04.6b levara a seis — e a própria spec de contrato afirma 6 e passa. Comentário mentindo
sobre o código que ele descreve, encontrado ao abrir o arquivo para outra coisa. Corrigido aqui.

### V-046 · P04.5b.2c — a FIAÇÃO, e duas mutações que corrigiram a minha leitura

**O que muda de estado na épica.** Até aqui `future_only` era promessa: o watermark era gravado e
ninguém o lia (C53), os construtores do P04.5b.2a estavam inertes e a primitiva do P04.5b.2b também.
Esta fatia liga os três dentro do `resumeInTx`, e com isso o §8.2.5 passa de declarado a **executado**.
`ResumeConversationResult` ganha `backlog_cancelled`, a auditoria de `conversation_automation_resumed`
passa a dizer quantas mensagens do cliente foram fechadas por decisão do operador, e a métrica sai —
como no precedente — **depois** do commit e só na variante de transação própria.

**Por que o laço é sequencial e não um `UPDATE ... WHERE id = ANY(...)`.** Cada turno passa pelo
CONTRATO: `assertTurnTransition` mais o CAS por linha. Um update em massa pularia exatamente as duas
guardas que impedem descartar um turno que andou entre a seleção e a escrita. O conjunto é o backlog
de UMA conversa, não uma varredura global, então o custo é conhecido.

**Vermelho: 6 de 7 falhando por si** (`expected undefined to be 2` — o campo ainda não existia). Dois
achados no próprio vermelho, registrados em vez de contornados:
- **o caso 17 tinha defeito de FIXTURE meu**, não do código: `engine_runs_binding_fk` exige um
  `engine_turn_bindings` antes do run. Sem perceber, eu teria lido "vermelho" como prova;
- **o caso 19 PASSAVA no vermelho.** Sem implementação nada descarta, então "resume recusado não
  descarta" valia trivialmente. Está escrito no próprio caso que a prova dele é a MUTAÇÃO.

**Mutação: 7 medidas, 6 mortas, 1 sobrevivente — e a primeira rodada me desmentiu DUAS vezes.**

| mutante | desfecho | o que mostrou |
|---|---|---|
| W1 · captura+descarte antes do epoch | MORTA (19) | nenhum descarte sem AUTORIDADE verificada |
| W2 · métrica com contagem zerada | MORTA (20) | |
| W3 · `...InTx` passa a emitir | MORTA (20) | a assimetria é real, não estilo |
| W4 · replay redescarta | MORTA (10) | idempotente ≠ repetido |
| W5 · filtro do watermark some | **SOBREVIVEU** | previsto por escrito; ver abaixo |
| W6 · predicado de efeito pendente some | MORTA (17) | |
| W7 · escopo da stream some | MORTA (18) | |

⚠️ **A W1 original SOBREVIVEU, e a correção foi na minha leitura, não no código.** Eu a escrevi
movendo o descarte para antes do guarda `if (!atualizado)`, prevendo que o caso 19 a mataria. Não
matou — porque esse guarda é **inalcançável**: `control_not_found`, `epoch_mismatch` e
`mode_not_allowed` retornam todos ANTES, sob o lock, e com o lock na mão a linha não muda debaixo de
nós. Aquilo era **mutante equivalente**, não lacuna de teste, e somá-lo como sobrevivente sem
investigar teria deixado no registro uma dúvida falsa sobre a atomicidade. Refeita para hastear a
captura do watermark JUNTO com o descarte acima da checagem de epoch — junto porque separado o bloco
referenciaria `wm` antes de existir e morreria por `ReferenceError`, isto é, pelo motivo errado —, ela
morre no caso 19. Só então o caso 19 virou prova.

⚠️ **A W5 sobrevive por um motivo estrutural, e ela CONFIRMA o C53 por um ângulo novo.** O filtro
`t.last_ingress_seq <= watermark` não consegue excluir ninguém no instante da captura, porque o
watermark é `GREATEST(contador da stream, max(seq dos turnos da MESMA stream))` — um máximo sobre o
próprio conjunto que ele filtra. Ele é defesa para um futuro em que o watermark venha de outra fonte
(um ponto escolhido por operador), não guarda ativa hoje. Eu havia previsto essa sobrevivência por
escrito antes de medir, e dito que, se ela morresse, era a minha leitura que mudaria.

⚠️ **Defeito meu no DRIVER, não no código:** a busca do fim do bloco do watermark casava
`const command_id = crypto.randomUUID();` da função de PAUSA, que vem antes, e devolvia um índice
anterior ao início. Abortou com mensagem explícita em vez de produzir uma mutação silenciosamente
errada — que é o comportamento que eu quero de um harness.

**Gates:** `tsc` 0, `eslint` 0. Família real-db: **344 casos / 13 arquivos / 0 falhas** (eram 337).

**Regressão EXATA pela segunda vez seguida:** `54 | 10288 | 1293 (11635)` contra `54 | 10288 | 1286
(11628)`. Falhas e passados **INALTERADOS**, pulados **+7** e total **+7** — os sete casos novos, que
pulam na lane unitária. Conjunto de arquivos em falha **idêntico**.

### V-047 · C57 — reconstrução LOCAL do histórico e integração de P05, P06 e P07

**Autorização e limite.** Dono, 17/09: integração LOCAL em branch/worktree nova; sem push, sem
merge em branch compartilhada, sem reescrever `main`, remotas ou as branches originais dos
agentes. **Nada aqui foi publicado.** Mapeamento completo e método em
`C57-RECONSTRUCAO-E-INTEGRACAO.md`.

**Antes de escrever qualquer coisa:**
- Grafo real: épica `main..8003ee05` com 40 commits e 2 merges (P01, P00.2), ambos ABAIXO do
  primeiro commit rejeitado; P05/P06/P07 com 6/9/2 commits próprios, sem merges e sem trailer,
  todos sobre `7993e563`; merge-base entre agentes = `7993e563`; nenhuma dependência de código
  entre eles; nenhuma migration, `package.json` ou config nas três.
- Nenhuma branch remota nem PR (`git ls-remote --heads origin`; `gh pr list --state all`).
- Agentes parados: worktrees de P05 e P06 limpas inclusive não rastreados, últimos commits de
  16/09, nenhum processo com a worktree na linha de comando, nenhuma sessão par no repositório.
- Backups `backup/c57-20260917/*` para os sete tips envolvidos, conferidos iguais.
- Evento registrado (C61): a worktree do P07 foi removida às 11:37:52 por agente não
  identificado; estava limpa às 11:36; sem perda.

**Gate de trailers — critério lido e depois EXECUTADO.** O script lê `origin/<base.ref>..head`
com `--no-merges` e testa CADA linha da mensagem contra
`^\s*co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$`. Evento JSON UTF-8 sem BOM, `base.sha = 2bbeefe9`,
`base.ref = main`, Node v22.23.2, script intocado:

| head | exit | saída |
|---|---|---|
| `8003ee05` (controle negativo) | 1 | rejeita exatamente `7993e563`, `f2f4b4f9`, `277f14e9`, `60682783`, `4b9daed3`, `378999e1` |
| `3b7fe541` (integração, antes do C27) | 0 | `passou: 55 de 60 commit(s)` |
| sem `GITHUB_EVENT_PATH` | 0 | `pulado` — **não conta como aprovação** |

O C57 dizia 7: `e3d6993b` só cita o trailer em prosa. Registro corrigido.

**Reconstrução.** `commit-tree` com a árvore original, pai novo e identidades/datas copiadas.
Conferência independente, com git puro, nos 37 pares: árvore, autor/committer/datas e
`patch-id --stable` iguais; mensagem igual em 31 e com exatamente a linha do trailer mais a linha
em branco anterior a menos em 6. Nenhum dos 6 rejeitados é ancestral de nenhuma tip nova. Três
merges P05 → P06 → P07 sem conflito; **árvore integrada = `8f4d7d1e`**, a mesma que
`git merge-tree --write-tree` previu antes de qualquer escrita.

**Verificação da árvore integrada** (worktree nova, `node_modules` por junction — lockfile
idêntico conferido sem CR):

| Gate | Resultado |
|---|---|
| typecheck (`tsc --noEmit`) | exit 0 |
| lint (`eslint src tests scripts`) | exit 0 — 0 erros, 481 avisos (mesma contagem da épica) |
| build (`tsc && tsc-alias`) | exit 0, `dist/index.js` presente |
| `docs:ai:check` · `migrate:reservations:check` · `config:check:drift` | passam (148/148 reservas) |
| unitária, config do projeto | `47 \| 10549 \| 1293 (11889)` |
| DB real (banco NOVO, 148 migrations do zero, `applied · dirty 0`) | `hermes-*`: 598 passados, 6 pulados (o spike) |
| `test:leak` | 151 / 8 falhas / 23 pulados, 6 arquivos — perfil idêntico ao V-027 |
| pytest `services/hermes_worker` | 169 passed |
| spike (`AIAgent` real, provider stub) | 6/6 |

⚠️ **A suíte unitária exigiu linha de base NA MESMA worktree, e ela mudou a leitura.** Contra a
rodada da worktree antiga (`54 | 10288 | 1293 (11635)`), a integrada parecia ter 5 arquivos a
menos em falha. Medida a épica reconstruída (`155d0902`, árvore idêntica a `8003ee05`) na
worktree NOVA: `47 | 10295 | 1293 (11635)`, com o MESMO conjunto de arquivos em falha da
integrada. As "melhoras" são ambiente — a worktree antiga tem arquivos com CRLF em disco. O efeito
real da integração é exato: total +254 = os casos de P05 (94), P06 (100) e P07 (60), todos
passando; falhas e pulados inalterados.

**Por que a integração não alcança o perfil do leak:** nenhum arquivo fora dos próprios módulos
dos agentes e de seus specs os importa (grep em `src`, `tests`, `scripts`; os três hits de
`./manifest.js` são do módulo de backup, outro `manifest`).

**Não executado, com motivo:** specs que exigem Redis real, `docker compose`, gitleaks, promtool,
e2e do console e `probe:drizzle-kit`. O job `fault injection (#510)` reprovaria no CI por
motivo anterior à integração (C58).

### V-048 · C27 — nome da tool de fixture conforme K-19

**Leitura normativa.** K-19 (REQUIREMENTS-MATRIX) é o §4.2 da spec, linha 323: "não permitir
`maia_*`, `mcp:*`, `all`". O registro C27 citava o §7.10 e contava seis posições; são **sete** na
fixture (inclusive a linha crua `proto-poluicao`), e não existe espelho Python — os dois lados
leem o mesmo `frames.json`.

**Vermelho primeiro.** `hermes-fixture-k19.spec.ts` usa `classifyReservedToolName` e
`INITIAL_TOOL_DENY` reais. Antes da correção: `2 failed | 1 passed (3)`, com o caso 2 listando as
sete posições e `k19: maia_prefix` em todas; o caso anti-vacuidade passa de propósito.

**Correção.** `maia_fixture_{echo,ECHO,outro}` → `fixture_{echo,ECHO,outro}` em 15 arquivos,
diff linha a linha igual à contagem de ocorrências. Os negativos do P05 mantêm o nome reservado.
Digest de `frame_tool_request` REGERADO pelo encoder TS; **controle:** o mesmo script reproduziu
`4e3c230c…` com o nome antigo antes de produzir `e0b51a32…`. A própria guarda pegou um defeito
meu no caminho: o comentário novo do digest citava o nome antigo.

**Mutação: 7 medidas, 7 mortas, 0 sobreviventes, 0 puladas** — manifest do start e linha crua
voltando ao nome reservado (caso 2), teste Python voltando (caso 3), guarda sem extração de
manifest ou de `effective_tool_names` (caso 1), guarda sem lista de exceções (caso 3 — prova que
a varredura acha os negativos do P05) e negativo do P05 sem o nome reservado (a recusa `maia_*`
deixa de acontecer — prova que a exceção é necessária).

**Verificação.** Guarda + specs afetados 189/189 (os dois negativos do P05, 31 e 40, verdes);
pytest 169 (`test_canonical_json` 36/36); DB real nas três specs que usam o nome 124/124; spike
6/6 — o registry real do Hermes aceitou `fixture_echo` pelo pipe; eslint 0. Suíte unitária
completa na árvore com C27: `44 | 10555 | 1293 (11892)` — total +3 (a guarda), **nenhum teste
novo em falha**. As 3 falhas a menos que a rodada anterior são sensíveis à invocação (Git Bash ×
PowerShell): `audit-exceptions` executa o npm real no Windows e dois casos de `check-node`
dependem de qual node/shell resolve. O C27 não toca nada que esses specs leem.

⚠️ **Defeito meu registrado:** uma rodada intermediária deu `53 failed` porque, para passar pelo
guard de isolamento da worktree, montei um PATH sem o diretório do git; os 6 casos de
`check-commit-trailers` morreram em `spawnSync git ENOENT`. Refeita com o PATH do sistema.

**K-19 não foi alterado.** O que a implementação não cobre (caixa, `mcp__`, wire) está no C59,
para decisão.
## Testes executados / falhos / pulados (acumulado)

| Suíte | Executados | Falharam | Pulados | Observação |
|---|---|---|---|---|
| `npm run typecheck` | — | 0 | — | exit 0, projeto inteiro |
| `npm run lint` | — | 0 (481 warnings) | — | exit 0 |
| unit (`npm test`, workers default) | 10555 | 44 | 1293 | **C57 + C27 (linha integrada `claude/mh-integracao-c57`, worktree NOVA):** `44 | 10555 | 1293 (11892)` na árvore com C27. ⚠️ Mudou a worktree, então a linha de base foi REMEDIDA nela: épica reconstruída `155d0902` = `47 | 10295 | 1293 (11635)`; integrada antes do C27 = `47 | 10549 | 1293 (11889)`, MESMO conjunto de arquivos em falha (+254 = P05 94 + P06 100 + P07 60, todos passando); com C27 +3 (a guarda) e nenhum teste novo em falha. As diferenças contra a worktree antiga (`54` falhas) são ambiente — CRLF em disco na antiga e Git Bash × PowerShell na invocação —, atribuídas teste a teste no V-047/V-048. Ver V-047. Histórico de P04.5b.2c: **P04.5b.2c (a fiação):** exata pela segunda vez seguida — falhas (54) e passados (10288) **INALTERADOS**, pulados 1286 → **1293** e total 11628 → **11635**, `+7` = os sete casos novos da spec de resume, que pulam nesta lane. Conjunto de arquivos em falha **idêntico**. Ver V-046. Histórico de P04.5b.2b: **P04.5b.2b (primitiva do descarte):** a aritmética mais limpa da sessão — falhas (54) e passados (10288) **INALTERADOS**, pulados 1275 → **1286** e total 11617 → **11628**, `+11` = exatamente os onze casos, que pulam nesta lane por serem de DB real. Conjunto de arquivos em falha **idêntico**: nenhum entrou, nenhum saiu. Ver V-045. Histórico de P04.6b: **P04.6b (hold no debounce):** total 11614 → **11617** e pulados 1272 → **1275** — os três casos novos são de DB real e pulam nesta lane. O resíduo `+1 falha / −1 passado` é UMA linha, `check-commit-trailers`. Desta vez o baseline foi **remedido no HEAD nesta máquina** (`53 | 10289 | 1272`) em vez de citado do registro anterior (`51 | 10291 | 1272`): **o mesmo commit oscilou sozinho**, então o placar não decide e a comparação válida é o diff dos CONJUNTOS — um arquivo a mais em falha, **zero a menos**, nenhuma área desta branch. O mecanismo agora é nomeado pelo reporter do repositório: no HEAD o teste consta em `PRAZOS ESTOURADOS` como `tentativas=2 · PASSOU MESMO ASSIM` depois de `[tentativa 1] Test timed out in 20000ms`; na minha rodada as DUAS tentativas estouraram (`48086ms · FAILED`). Isolado: 13/13 em 8,37s, o caso em 1897ms. Ver V-044. Histórico de P04.5b.2a: **P04.5b.2a (construtores puros):** total 11606 → **11614** e pulados INALTERADOS em 1272 — os oito casos novos são puros. Passados +7 e falhas +1 são a MESMA linha: `check-commit-trailers` VOLTOU à lista (98,7s). Ele agora oscilou em TRÊS rodadas consecutivas com o mesmo código — presente no V-041, ausente no V-042, presente aqui. Essa oscilação é evidência de flake mais forte do que a atribuição por isolamento que o V-041 registrou, e fica anotada assim em vez de reatribuída do zero a cada rodada. `10284 + 8 − 1 = 10291` e `50 + 1 = 51`; os outros 20 arquivos em falha e os 2 que não carregam são idênticos. Histórico de P04.5b.1: **P04.5b.1 (contrato compartilhado):** total 11602 → **11606** e pulados **INALTERADOS** em 1272 — os quatro casos novos são PUROS e rodam na lane unitária, então não engrossam os pulados como as fatias de DB real fazem. Passados +5 e falhas −1 são a MESMA linha: `check-commit-trailers` saiu da lista de arquivos em falha. É o flake que o V-041 atribuiu por medição (13/13 isolado, duas vezes), e vê-lo falhar numa rodada e passar na seguinte **com o mesmo código** é evidência adicional de que é flake, não regressão — registrado assim em vez de aproveitado em silêncio como "melhorou". Logo `10279 + 4 + 1 = 10284` e `51 − 1 = 50`; os outros 20 arquivos em falha e os 2 que não carregam são idênticos. Histórico de P04.6: **P04.6 — e esta é a primeira vez na épica em que a linha de base foi MEDIDA em vez de citada.** A rodada com a mudança deu `124 falhas`; em vez de chamar de ambiente, rodei o HEAD anterior nesta máquina com a MESMA invocação e obtive `50 | 10268 | 1256 (11574)`. A comparação era válida e a culpa era minha (ver C51): a diferença dos 8 arquivos a mais somava exatamente 74 = `124 − 50`. Corrigida a causa, o resultado final é `51 | 10279 | 1272 (11602)` — total **+28** e pulados **+16**, exatamente os 12 casos do contrato (rodam) e os 16 do DB real (pulam na lane unitária). O resíduo de +1 falha / −1 passado é `check-commit-trailers`, ausente dos 20 arquivos da baseline e rodando 79,5s aqui: **reprovado por medição nova**, 13/13 isolado duas vezes (7,54s e 7,73s), sem citar módulo nenhum desta branch. Logo `10268 + 12 − 1 = 10279`. Histórico de P04.5a: falhas (51) e passados (10267) INALTERADOS, pulados 1242 → **1256** e total 11560 → **11574**, **+14 = exatamente os catorze casos** do spec de retomada, que pula na lane unitária por ser de integração. Os mesmos 21 arquivos em falha, e o 21º segue sendo o flake já atribuído no V-039. Aritmética fechada. Histórico de P04.4: pulados 1229 → **1242** e total 11547 → **11560**, +13 = os treze casos do spec de reconciliação, que pula na lane unitária por ser de integração. ⚠️ **Falhas 50 → 51 e passados 10268 → 10267**, com os arquivos em falha indo de 20 a 21 — atribuído e NÃO arredondado: o entrante é `scripts/check-commit-trailers`, flake sob paralelismo (isolado: 13/13 em 11s, duas vezes; na suíte cheia: 51s e uma falha), e o fonte prova que ele cria repositório git próprio em temp dir, logo não depende desta branch. Ver V-039. Histórico de P04.3b: passados **INALTERADOS** em 10268, pulados 1217 → **1229** e total 11535 → **11547**, **+12 = exatamente os doze casos** do spec de pausa, que pula na lane unitária por ser de INTEGRAÇÃO — aritmética inversa à do P04.3a, e prevista antes de medir. Falhos (50) e os mesmos 20 arquivos INALTERADOS. Histórico de P04.3a: passados 10261 → **10268** e total 11528 → **11535**, **+7 = exatamente os sete casos** do spec do módulo de SQL puro; falhos (50), pulados (1217) e os mesmos 20 arquivos INALTERADOS. Histórico de P04.2: passados 10255 → **10261** e total 11522 → **11528**, **+6 = exatamente os seis casos** do spec de vocabulário, que rodam na lane unitária por ser puro; falhos (50), pulados (1217) e os **mesmos 20 arquivos** INALTERADOS, e nenhuma falha cita `audit-actions` nem `conversation-control`. Histórico de P04.1: pulados 1200 → 1217 e total 11505 → 11522, +17 = a caracterização de `conversation_control_commands`, que pula na lane unitária por ser de integração; passados, falhos e os 20 arquivos INALTERADOS. Histórico de P03.8b, e a aritmética é DIFERENTE das anteriores: `recovery.ts` é módulo PURO, então seus 22 casos rodam na lane unitária — `passed` sobe 10233 → 10255 e o total 11483 → 11505, com `skipped` INALTERADO em 1200. Todas as unidades anteriores só engrossavam os pulados. Histórico de P03.8a: pulados 1187 → 1200 e total 11470 → 11483, +13 = os casos de caracterização de `engine_projections`; passados, falhos e os 20 arquivos INALTERADOS. Histórico de P03.7b: pulados 1172 → 1187 e total 11455 → 11470, +15 = os casos de manutenção; passados, falhos e os 20 arquivos INALTERADOS. Histórico de P03.7a: pulados 1157 → 1172 e total 11440 → 11455, +15 = os 15 casos do spec de varredura; passados, falhos e os 20 arquivos INALTERADOS. Histórico de P03.6b: 20 arquivos em falha, **o mesmo conjunto e a mesma contagem (50)** de antes, e passados inalterados em 10233. Pulados sobem 1135 → 1157 e o total 11418 → 11440: +22 é exatamente o meu spec crescendo de 52 para 74 casos, que pulam na lane unitária por falta de `TEST_DB_URL`. Aritmética fechada é a evidência de que nada mais se moveu. 16 dos 20 batem com o catálogo do V-007 — que é **parcial**: declara 54 falhas e itemiza 40. Os outros 4 não vêm desta branch: com `--maxWorkers=3` o resultado é idêntico (falhas determinísticas) e suas 10 falhas cabem nas 14 que o V-007 não itemizou |
| integração real-db (procedimento local de 2 passos) | 260 | 0 | — | **C57:** reexecutada na árvore INTEGRADA contra banco NOVO (`maia_test_wt_…_10fe483e`, 148 migrations aplicadas do zero, `dirty 0`): família `hermes-*` com 598 passados e 6 pulados (o spike, que roda à parte), incluindo os 260 de DB real. **C27:** as três specs que usam o nome da tool, 124/124. Detalhe anterior: | Agora com `hermes-resume-conversation-real-db` em **21** casos (14 de P04.5a + 7 de P04.5b.2c: o descarte do backlog visto pela porta do resume) — família inteira em **344 casos / 13 arquivos / 0 falhas**. Detalhe anterior: | Agora com `hermes-cancel-backlog-real-db` (11 de P04.5b.2b), em **11 arquivos** — rodada da família inteira: 13 arquivos, **337 casos, 0 falhas**, incluindo os 2 unitários do Hermes. Detalhe anterior: | Agora com `hermes-claim-hold-real-db` em **19** casos (16 de P04.6 + 3 de P04.6b: o fechador de janela e o enumerador sob controle humano), em **10 arquivos**; os 223 anteriores seguem verdes, o que importa aqui porque esta unidade mexeu no `WHERE` do claim, no filtro do recovery e na eleição da promoção — caminhos que TODA spec de turno atravessa. ⚠️ Nota de medição: filtrar por `real-db` no CLI casa 78 arquivos (toda spec com esse sufixo no repositório), e 45 deles falham por infra que esta máquina não tem. Esses nunca fizeram parte dos 223 e **não** são regressão; a família contabilizada aqui é a `hermes-*-real-db`, enumerada arquivo a arquivo. Detalhe anterior: | Agora com `hermes-resume-conversation-real-db` (14 de P04.5a), em **9 arquivos**; os 209 anteriores seguem verdes. Detalhe anterior: | Agora com `hermes-reconcile-pause-real-db` (13 de P04.4), em **8 arquivos**; os 196 anteriores seguem verdes. Detalhe anterior: | Agora com `hermes-pause-conversation-real-db` (12 de P04.3b), em 7 arquivos; os 184 anteriores seguem verdes, o que prova que o primeiro escritor de `conversation_controls` não perturbou o journal. Detalhe anterior: | Agora com `hermes-control-commands-real-db` (17 de P04.1). Detalhe anterior: | Agora com `hermes-projections-real-db` (13 de P03.8a), em arquivo próprio pelo motivo registrado no V-030. Detalhe anterior: | Agora com `hermes-engine-sweep-real-db` em **30** casos (15 de P03.7a + 15 de P03.7b). Detalhe anterior: | `hermes-runs-real-db` (12) + `hermes-engine-repos-real-db` (74: 28 do caminho de start + 7 de P03.4 + 10 de P03.5 + 7 de P03.6a + 22 de P03.6b) + `hermes-engine-tool-calls-real-db` (38: 10 de P03.3a + 10 de P03.3b + 9 de P03.3c + 9 de P03.3d) + `hermes-engine-sweep-real-db` (15 de P03.7a). As demais specs de integração seguem **não executadas** (Redis) |
| `npm run test:leak` (procedimento local de 2 passos) | 151 | 8 | 23 | **C57:** reexecutado na árvore INTEGRADA, perfil IDÊNTICO (151/8/23, 6 arquivos): cinco em `loadConfig` (família do C54) e a asserção real de `turn-context-batch-repos`, ainda sem controle; `outbound-leak` 10/10. Nenhum código fora dos módulos dos agentes os importa. Detalhe anterior: | **Reexecutado em P03.7a e P03.7b, com perfil IDÊNTICO nas três vezes** (mesmos contadores, mesmos 6 arquivos, `outbound-leak` verde) — a leitura cross-tenant nova não moveu nada. Da primeira execução, em P03.6b, e ainda NÃO verde — 6 arquivos em falha de 20. `outbound-leak` (a mais próxima desta mudança) PASSOU com 10 casos. Cinco falham em `loadConfig` na carga, por o config local pular o `globalSetup`; controle: as três unitárias sob o config do projeto passam (51/51, exit 0). A sexta (`turn-context-batch-repos`) é asserção real, determinística, falha sozinha, e não é atribuível a esta branch por construção (nada importa `engine-repos`; tabelas disjuntas) — **sem controle em HEAD, fica como item aberto**. Ver V-027 |
| reliability (`hermes-worker-spike`) | 6 | 0 | — | `AIAgent` real do SHA pinado (`5d59366`) contra provider **stub** (V-016). **Reexecutado na árvore integrada e depois do C27:** 6/6 nas duas — o registry real aceitou `fixture_echo`. ⚠️ No CI esta spec PULA e reprova a lane `fault injection (#510)` (C58) |
| pytest (`services/hermes_worker`) | 169 | 0 | — | V-015 registrou 166; hoje são **169** — a diferença bate com os três casos de custo acrescentados à fixture em `609cc189`, mas isso é INFERÊNCIA (não recoletei a suíte naquele commit). Reexecutado na árvore integrada e depois do C27: 169/169 |

## Revisões e correções

- V-011 — revisão do trabalho do agente P01 (caracterização), feita por mim, linha a linha.
- V-015 — revisão do agente P00.2 (worker Python): cinco mutações minhas, **uma sobreviveu** e virou
  correção de cobertura (regra decimal-uint sem caso que a exercitasse, dos DOIS lados do contrato).
- V-017 — P03.2: a varredura de mutação encontrou um defeito MEU (`expected_row_version` não exercido
  por teste nenhum); corrigido com o caso 10 antes de qualquer commit.

## Riscos remanescentes

- Redis fake: cobertura de filas/locks não verificável localmente.
- Nenhum CI executado sobre este código (sem push, por decisão do dono).
- Smoke com provider real e benchmark permanecem bloqueados (D02/D03).
- **Quatro arquivos em falha fora do catálogo do V-007** (`runtime/outbound-trava-envio-direto`,
  `scripts/audit-exceptions`, `scripts/check-node`, `ops/privacy-export-sweeper` com uma falha a mais).
  Isolados, falham por ambiente Windows e nenhum importa código desta branch. Duas ressalvas de
  método: (a) o catálogo do V-007 é INCOMPLETO — declara 54 falhas e itemiza 15 arquivos que somam 40,
  deixando 14 sem itemizar, e os quatro arquivos aqui somam 10, que cabem nessa lacuna; (b) o V-007
  mediu com `--maxWorkers=3` e a rodada atual usou workers default. **Remedição feita:** com
  `--maxWorkers=3` o resultado é idêntico ao de workers default (mesmo conjunto de arquivos, mesmos
  contadores), o que mostra falhas determinísticas e não inflação por paralelismo. Os quatro não são
  atribuídos a esta branch; o catálogo do V-007 passa a ser tratado como PARCIAL. Continua não medido:
  a baseline no commit base com catálogo completo — só isso encerraria o assunto em definitivo.
- `engineRunsRepo` ainda **não** é reexportado pelo barril `src/db/repositories.ts`. Não quebra nada
  hoje (nada o consome fora dos testes), mas P07 vai precisar disso quando o supervisor o usar — e a
  adição não é a linha trivial que parecia: o barril usa `export * from './repositories/<arquivo>.js'`,
  então reexportar `engine-repos` jogaria nomes GENÉRICOS (`NotFound`, `TurnFenceConflict`,
  `ControlConflict`, `ToolClassification`) numa superfície importada por meio repositório. Antes de
  adicionar, conferir colisão e, se houver, ou renomear os tipos ou reexportar só os nomes
  necessários. Registrado agora para quem fizer P07 não descobrir isso no meio de outra coisa.

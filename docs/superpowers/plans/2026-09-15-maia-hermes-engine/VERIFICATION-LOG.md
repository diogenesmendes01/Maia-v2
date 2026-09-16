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

## Testes executados / falhos / pulados (acumulado)

| Suíte | Executados | Falharam | Pulados | Observação |
|---|---|---|---|---|
| `npm run typecheck` | — | 0 | — | exit 0, projeto inteiro |
| `npm run lint` | — | 0 (481 warnings) | — | exit 0 |
| unit (`npm test`, workers default) | 10233 | 50 | 1073 | Medido de novo DEPOIS do rework: 20 arquivos em falha, **o mesmo conjunto e a mesma contagem (50)** de antes. Pulados sobem 1055 → 1073 e o total 11338 → 11356: +18 é exatamente o meu spec crescendo de 10 para 28 casos, que pulam na lane unitária por falta de `TEST_DB_URL`. Aritmética fechada é a evidência de que nada mais se moveu. 16 dos 20 batem com o catálogo do V-007 — que é **parcial**: declara 54 falhas e itemiza 40. Os outros 4 não vêm desta branch: com `--maxWorkers=3` o resultado é idêntico (falhas determinísticas) e suas 10 falhas cabem nas 14 que o V-007 não itemizou |
| integração real-db (procedimento local de 2 passos) | 40 | 0 | — | `hermes-runs-real-db` (12) + `hermes-engine-repos-real-db` (28, após o rework do V-019). As demais specs de integração seguem **não executadas** (Redis) |
| reliability (`hermes-worker-spike`) | 6 | 0 | — | `AIAgent` real do SHA pinado contra provider **stub** (V-016) |
| pytest (`services/hermes_worker`) | 166 | 0 | — | V-015 |

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
  hoje (nada o consome fora do teste), mas P07 vai precisar disso quando o supervisor o usar.

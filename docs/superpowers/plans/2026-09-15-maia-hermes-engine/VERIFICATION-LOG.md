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

## Testes executados / falhos / pulados (acumulado)

| Suíte | Executados | Falharam | Pulados | Observação |
|---|---|---|---|---|
| `npm run typecheck` | — | 0 | — | exit 0 |
| `npm run lint` | — | 0 (481 warnings) | — | exit 0 |
| unit (`vitest run`) | em curso | — | — | baseline |
| integração / leak / e2e | 0 | 0 | — | **bloqueados** até haver Postgres com as 5 extensões |
| pytest (`services/hermes_worker`) | 0 | 0 | — | pacote ainda não existe |

## Revisões e correções

(nenhuma ainda)

## Riscos remanescentes

- Redis fake: cobertura de filas/locks não verificável localmente.
- Nenhum CI executado sobre este código (sem push, por decisão do dono).
- Smoke com provider real e benchmark permanecem bloqueados (D02/D03).

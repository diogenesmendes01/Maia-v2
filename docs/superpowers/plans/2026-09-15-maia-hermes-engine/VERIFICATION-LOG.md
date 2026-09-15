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

### V-005 · Redis

Não há Redis real disponível na máquina. Foi levantado `fakeredis` 2.38.0 (`TcpFakeServer`) em `127.0.0.1:56379` **apenas** para satisfazer o `flushRedis` do `tests/globalSetup.ts`. Isso é um **fake explícito**: nenhum gate que dependa de semântica real de Redis/BullMQ (filas, locks, `turn-job-*-real-redis`) pode ser declarado verificado com ele.

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

### V-007 · Suíte unitária de baseline

Em execução (`node node_modules/vitest/vitest.mjs run --maxWorkers=3`, sem `TEST_DB_URL`, Node 22). Resultado e contagem executados/falharam/pulados serão registrados aqui; a comparação de qualquer falha futura será feita contra ESTE baseline.

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

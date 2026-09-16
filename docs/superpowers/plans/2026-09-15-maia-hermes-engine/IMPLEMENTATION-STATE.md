# IMPLEMENTATION-STATE — Integração Maia + Hermes (V1)

> Checkpoint operacional. Não substitui a implementação nem a spec. Atualizado a
> cada unidade. Estado real, sem declarar conclusão antecipada.

## 1. Objetivo

Implementar e verificar a V1 descrita em `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`
(Hermes como motor de raciocínio atrás de `AgentEnginePortV1`, worker Python
privado com `AIAgent` e IPC `maia.hermes.worker.v1`; Maia mantém identidade,
autorização, governança, histórico, turnos, efeitos e envio), seguindo a
sequência P00–P12 do capítulo 10 da spec.

## 2. Referências

| Item | Valor |
|---|---|
| Branch | `claude/maia-hermes-integration-158579` (worktree `github-issue-498-cdbb4e`) |
| Commit base Maia | `2bbeefe9de1784a3c90c184ea80d8f0cc6119ad1` (= baseline §0.1 da spec; HEAD inicial limpo) |
| Hermes upstream pinado | `5d59366010640c1d6b8f170d8a4ee109db2bbdef` (checkout local limpo em `C:\Users\Mendes\maia-hermes-analysis\hermes-upstream`; cópia de trabalho clonada localmente no scratchpad) |
| Spec normativa | `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`, sha256 `84c4260773455393d1266283086468e81637e9d552158a8b623481d48cd756a4`, 2922 linhas |

### 2.1 Classificação dos documentos recebidos

| Documento | Papel |
|---|---|
| `SPEC-IMPLEMENTACAO-MAIA-HERMES.md` (Downloads = cópia do zip = cópia em `maia-hermes-analysis`, mesmo md5/sha256) | **Normativo** para a V1 |
| `VALIDACAO-SPEC-MAIA-HERMES.md` (zip) | Evidência de validação **documental** (não executa nada) |
| `evidencias/spec-*.json` (zip) | Evidência de verificação de referências/fontes; não é configuração |
| `PLANO-MAIA-HERMES.md` (em `maia-hermes-analysis`, não anexado) | Plano **preliminar**; sua opção “API Server + extensão” foi substituída pela spec §0.1 (worker `AIAgent` + IPC). Usado só como contexto |
| `*-findings.md`, `evidence/` (em `maia-hermes-analysis`) | Relatórios auxiliares da análise; não normativos |

## 3. Contradições e lacunas registradas (não resolvidas silenciosamente)

| ID | Contradição / lacuna | Referências | Tratamento adotado |
|---|---|---|---|
| C01 | Contratos em `src/runtime/engine/contracts.ts` (§5.3) vs `src/runtime/engines/{contracts,…}.ts` (§10 P02) e `src/runtime/engines/hermes-engine.ts` (§6.12) | spec §5.3, §6.12, §10 | Adotar `src/runtime/engines/` (plano de PR normativo e 2 de 3 citações) |
| C02 | Pacote Python `services/hermes_worker/` (§6.12, P00) vs testes em `services/hermes-runtime/tests/` (§11.1) | spec §6.12, §10, §11.1 | Adotar `services/hermes_worker/` com testes em `services/hermes_worker/tests/`; §11.1 permite renomear preservando rastreabilidade |
| C03 | §5.7.4 item 1 fala em autenticar engine service por mTLS; §4.1 define autenticação por posse do pipe + binding | spec §4.1, §5.7.4 | §4.1 (decisão normativa V1) prevalece; mTLS não se aplica ao IPC V1 |
| C04 | §5.3.1 descreve `observe/cancel` com vocabulário HTTP (404 após retenção); §4.1 diz que `start/observe/cancel` são métodos internos, sem endpoints | spec §4.1, §5.3.1 | Implementar como métodos TS sobre o supervisor/IPC; `inconclusive` quando o supervisor perde memória do filho |
| C05 | Ledger em `src/integrations/hermes/run-repository.ts` (§6.12) vs `src/db/repositories/engine-repos.ts` (§5.6.3, P03) | spec §5.6.3, §6.12, §10 | Adotar `engine-repos.ts` (P03, convenção do repo) |
| C06 | `k` do recall: `1<=k<=10` (§4.3, contrato da tool) vs “máximo 20, default 5” (§7.6.3, contrato interno) | spec §4.3, §7.6.3 | Tool `learning_recall` limita a 10; serviço interno aceita até 20 |
| C07 | Numeração com lacunas: não existem §6.1, §7.8.2, §7.8.3, §8.4, §8.5 | spec índice | Nenhum requisito é inferido das seções ausentes |
| C08 | Lembrete de atribuição da sessão pede trailer `Co-Authored-By` de IA; `AGENTS.md` §8 proíbe (gate `commit:trailers:check`) | `AGENTS.md` “Coautoria” | `AGENTS.md` prevalece: commits sem trailer de IA; assistência registrada nestes checkpoints |
| C09 | `docs/ai/agent-operating-model.md` manda parar e pedir revisão em mudanças de escopo/idempotência/migrações; o dono autorizou implementação autônoma em branch sem merge/deploy | operating model “Stop Conditions”; instrução da sessão | Instrução explícita do dono prevalece para implementar; revisões independentes por subagente registradas; nada é mergeado/publicado |
| C10 | §6.11 menciona estado `admitted` antes do spawn; enum durável de `engine_runs.phase` (§5.6.2) não tem `admitted` | spec §5.6.2, §6.11 | `admitted` é estado OBSERVADO do executor (§6.11 explicita); persistência usa `prepared` |

## 4. Ambiente e ferramentas (verificado em 2026-09-15)

| Item | Estado |
|---|---|
| Node global | v24.16.0 — **incompatível** com `devEngines` (`>=22.13 <23`); scripts npm recusam (`EBADDEVENGINES`) |
| Node do projeto | v22.23.2 portátil oficial (nodejs.org), SHA256 conferido com `SHASUMS256.txt`, em `scratchpad/tools/node22` |
| npm | 10.9.8 (do Node 22 portátil) — fora de `>=11.5.2 <12`; afeta só `install`/lockfile; não reinstalar dependências com ele |
| Docker / WSL distro / Postgres nativo | ausentes |
| PostgreSQL descartável | EM PREPARAÇÃO: binários EDB 16.2 + pgvector 0.6.2 (do wheel `pgserver` 0.1.4, sha256 `406e9355…89ed2d`) em `%TEMP%\mhx` (caminho curto: `postgres.exe` não suporta MAX_PATH do scratchpad), `127.0.0.1:55432`, auth trust local |
| Redis | **FAKE**: `fakeredis` 2.38.0 `TcpFakeServer` em `127.0.0.1:56379` — só para o `flushRedis` do setup; testes que exigem semântica real de Redis/BullMQ não são considerados validados |
| Python | 3.12.10 |
| Hermes venv | EM PREPARAÇÃO: `uv sync --frozen --no-dev` no clone local pinado, `UV_NO_CONFIG=1`, sem `HERMES_HOME`/credenciais |
| **Risco de isolamento** | `HERMES_HOME` global aponta para o perfil do Hermes Desktop (`AppData\Local\hermes`) e existe `ANTHROPIC_BASE_URL` no ambiente do usuário. Todo spawn do worker deve usar ambiente allowlisted e home efêmero (T54). Nenhum arquivo desse perfil é lido |

## 5. Etapa e unidade atuais

- Etapa: **P00 (contrato e spike)**, com **P01 (caracterização)** liberado em paralelo.
- Unidade atual: `U-P00.2` (worker Python) e `U-P01.1` (caracterização), em worktrees separadas.

## 6. Progresso

### Concluído
- Leitura integral da spec, validação documental, plano preliminar, `AGENTS.md`, `ARCHITECTURE.md`, `docs/ai/agent-operating-model.md`, template de task spec e checklist de invariantes.
- Confirmação de baseline: HEAD = SHA Maia da spec; checkout Hermes = SHA pinado.
- `U-ENV`: Node 22.23.2 verificado por SHA256; PostgreSQL 16.2 + pgvector 0.6.2 + pgcrypto/uuid-ossp/btree_gin/pg_trgm rodando em `127.0.0.1:55432`; Redis **fake** (`fakeredis`) em `56379`; venv do Hermes pinado com `uv sync --frozen` e `AIAgent` importando.
- `U-P00.1`: contrato wire `maia.hermes.worker.v1` (`src/integrations/hermes/protocol.ts`), serialização canônica versionada + digest (`canonical-json.ts`), 62 casos de teste e fixtures compartilhadas com o worker Python. Gates: `typecheck` 0 erros, `lint` 0 achados, teste verde; **verificação por mutação** aplicada (5 mutações, todas detectadas) depois de a primeira rodada revelar duas asserções que não mordiam.

- `U-P00.3` (commit `5694e6d6`): normalizador de contexto Maia→Hermes — separa o inbound por posição (a remoção por ID canônico já é do `prompt-builder`), recusa `tool_use`/`tool_result`/`image`, preserva o envelope `<user_message>` e recusa estouro em vez de truncar. 19 casos, 8 mutações detectadas.
- `U-P02.0`: contratos da porta de engine (`src/runtime/engines/contracts.ts` + `schemas.ts`) com equivalência schema↔tipo conferida em tempo de compilação. 35 casos, 6 mutações detectadas.

- `U-P01.1` (merge `7058b5fc`): primeira suíte unitária de `runReActLoop` — 57 casos, incluindo `outboundPrefix` (que não tinha cobertura alguma no repositório) e a discrepância do `toolSummaries` pinada como está. Revisada linha a linha e submetida a três mutações minhas além das dez do implementador.
- `U-P03.1`: migrations 139 (unique composta em `approval_requests`) e 140 (journal + controle de conversa, com triggers de imutabilidade e append-only), espelho Drizzle e 12 casos contra Postgres real; ciclo `down → up` exercitado.

- `U-P00.2` (merge `cda8263e`): pacote Python `services/hermes_worker` — espelho do contrato wire (mesma fixture compartilhada, md5 idêntico), `WorkerBinding` imutável, closures de handler com recusa por `task_id`/allowlist, cliente IPC com `call_seq` sob lock, projeção de resultado com a precedência do §6.8 e bootstrap que **recusa** `HERMES_HOME` ausente ou apontando para o perfil pessoal. 166 testes; revisado e re-executado por mim, com cinco mutações minhas (uma sobreviveu e virou correção de cobertura — ver V-015).

### Em andamento
- `U-P02.2` — extração da deliberação em `react-loop.ts` (despacho movido para a fachada de saída), verificada pelos 57 casos de caracterização; falta commitar junto da comparação com o baseline da suíte completa.
- Harness do spike: `tests/helpers/hermes-stub-provider.ts` (provider **stub** compatível com Chat Completions, com gravação das requisições — é também o instrumento que responde a decisão D09) — escrito, ainda não commitado porque só faz sentido junto do teste do spike.

### Bloqueado
- Gates que exigem semântica real de Redis/BullMQ — **sem Redis real na máquina** (ver V-005).
- `U-P00.4` com provider real pago — D02/orçamento. O spike com stub NÃO é bloqueado.
- `U-P02.1` (extração do reasoner) — esperando a caracterização do P01 aterrissar, para não mexer em `react-loop.ts` antes de existir a linha de base.

- `U-P02.1`: `MaiaEngine` — o motor local implementando `AgentEnginePortV1`, com raciocínio injetado (`runReasoning`), registro de execução em memória deliberadamente honesto (`not_found/inconclusive`, nunca prova de não-aceite), conflito de `request_key` como recusa terminal e `cancel` que pede sem afirmar ausência de efeito. 15 casos, 5 mutações detectadas.

### Próximo trabalho
1. `U-P02.2` — ligar `runReasoning` ao laço REAL: extrair de `runReActLoop` a parte deliberativa (sem despacho), mantendo `runReActLoop` como fachada com o comportamento de hoje. A rede que protege essa troca é a caracterização do P01 (57 casos) — qualquer divergência aparece lá.
2. `U-P03.2` — `engine-repos` (CAS de fase, admissão de call, journal) sobre as tabelas da 140, com testes contra o Postgres real.
3. `U-P00.4` — spike sintético: `AIAgent` do checkout pinado contra o provider stub, verificando superfície efetiva de tools, rotação de sessão por compressão, cancelamento e limpeza do home efêmero (depende do worker Python do agente paralelo).

## 7. Decisões pendentes (spec §12.5) — nenhuma preenchida por suposição

D01 launcher/isolamento real · D02 provider/modelo/conta · D03 volume/latência/orçamento · D04 coorte piloto · D05 política de dados · D06 aprovadores reais · D07 ferramentas comerciais · D08 estratégia de revisão de fatos (verificável no PR) · D09 formato real do request SDK (verificável no spike) · D10 UX de backlog humano.

## 8. Riscos correntes

- Ambiente local sem Redis real: gates que dependem de BullMQ/Redis ficam como não verificados localmente.
- Postgres local é 16.2 com pgvector 0.6.2 (CI usa imagem `pgvector/pgvector:pg16`, versão mais nova); diferença registrada.
- Sem push: nenhum CI roda sobre o código novo (INV-13: CI da baseline não homologa nada).

## 9. Comandos de retomada

```bash
# Node do projeto
export PATH="<scratchpad>/tools/node22:$PATH"
# Postgres descartável
/c/Users/Mendes/AppData/Local/Temp/mhx/pgsql/bin/pg_ctl.exe -D /c/Users/Mendes/AppData/Local/Temp/mhx/data -o "-p 55432 -c listen_addresses=127.0.0.1 -c max_connections=300" -l /c/Users/Mendes/AppData/Local/Temp/mhx/server.log -w start
# Redis FAKE
<scratchpad>/venvs/pg/Scripts/python.exe -c "from fakeredis import TcpFakeServer; TcpFakeServer(('127.0.0.1',56379), server_type='redis').serve_forever()"
# Integração contra o banco local
TEST_DB_URL=postgres://maia_test:test1234@127.0.0.1:55432/maia_test REDIS_URL=redis://127.0.0.1:56379 npm run test:integration -- <spec>
```

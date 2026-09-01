#!/usr/bin/env bash
# E2E do Admin UI contra o ARTEFATO STANDALONE — o mesmo que o Coolify executa.
#
# Roda igual no CI e na máquina de quem desenvolve, e é o único lugar que sabe
# montar, subir e derrubar o servidor. `playwright.config.ts` NÃO usa
# `webServer` de propósito: aqui cada pré-requisito ausente vira uma mensagem
# própria e um código de saída != 0, em vez de um timeout genérico do
# Playwright.
#
# ─────────────────────────────────────────────────────────────────────────
# Por que STANDALONE e não `next start` (decisão do dono, issue #472)
# ─────────────────────────────────────────────────────────────────────────
# `next start` serve o `.next` da árvore de trabalho, com o `node_modules`
# completo do repositório ao alcance. O que vai para produção é OUTRA coisa:
# `src/admin-ui/Dockerfile` copia `.next/standalone` para `/app`, copia
# `.next/static` para dentro dele e roda `node src/admin-ui/server.js` — um
# bundle com um SUBCONJUNTO traçado do `node_modules` (`outputFileTracingRoot`
# aponta para a raiz do repo, ver `next.config.mjs`).
#
# As duas classes de defeito que só o standalone enxerga:
#   - módulo que o tracer (nft) não seguiu -> o container morre no boot com
#     `Cannot find module`, e `next start` NUNCA reproduz isso;
#   - `.next/static` fora da posição esperada -> o HTML renderiza, os chunks
#     dão 404 e o console fica preso na tela de carregamento. MEDIDO nesta
#     árvore: sem o `cp` de `.next/static`, 2 dos 5 testes do `smoke`
#     reprovam (hidratação e o canário de jornada pública).
#
# A montagem abaixo é a tradução 1:1 dos dois `COPY --from=build` do
# Dockerfile, e `tests/unit/ci/admin-ui-e2e-gate.spec.ts` trava a equivalência
# (entrypoint e destino do estático saem do PRÓPRIO Dockerfile, lido do disco).
#
# Contrato de falha (tudo FECHA, nada pula):
#   - sem build em src/admin-ui/.next        -> falha
#   - sem artefato standalone / sem estático -> falha
#   - sem DATABASE_URL / REDIS_URL           -> falha
#   - sem MAIA_STAGING_KEYRING               -> falha
#   - fixtures das jornadas não semeiam      -> falha
#   - runtime não fica pronto no prazo       -> falha, com o log do runtime
#   - servidor não responde no prazo         -> falha, com o log do servidor
#   - Playwright reprova                     -> falha
#   - Playwright executou 0 teste ou pulou   -> falha (check-playwright-run.ts)
#
# Uso:
#   npm run test:admin-ui:e2e:ci
#
# O env do console vem de QUEM CHAMA (o job do CI define o bloco no passo, não
# no job — uma variável no `env:` de um job alcança todo processo dele, e
# `src/config/validate.ts` reprova chave desconhecida sob prefixo da Maia).
#
# ─────────────────────────────────────────────────────────────────────────
# DOIS processos, e por quê (issue #623)
# ─────────────────────────────────────────────────────────────────────────
# O console não gera QR nem código de pareamento: `channelLines.startPairing`
# grava um COMANDO em `channel_line_state` e devolve. Quem abre a sessão,
# produz o material e o CIFRA é o worker `channel_pairing`, que vive no
# RUNTIME. Com um processo só, quatro casos da jornada de pareamento ficavam
# fora do gate — era a última quarentena da #623.
#
# Este script sobe os DOIS, compartilhando `DATABASE_URL`, `REDIS_URL` e
# `MAIA_STAGING_KEYRING` (é a partilha do keyring que faz o envelope selado
# pelo runtime ABRIR no console). O runtime entra no papel `scheduler` com o
# grupo de jobs `channel`: nada de HTTP, nada de fila BullMQ, nada de socket
# primário — só os crons de canal, que é o que o pareamento precisa.
#
# O adapter de canal é FALSO, e não por configuração: o entrypoint
# `tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts` o injeta na
# CONSTRUÇÃO do LineSessionManager. Ver o cabeçalho daquele arquivo e
# `tests/unit/gateway/pairing-adapter-seam.spec.ts` — "pareamento provado por
# socket falso" alcançável por env var seria fail-open no ponto exato em que
# provar posse AUTORIZA uma linha a rotear.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Prefixo `TEST_` e NÃO `ADMIN_UI_`: `ADMIN_UI_` é um dos namespaces
# reservados em `src/config/metadata.ts` (MAIA_KEY_PREFIXES), e uma chave
# desconhecida sob ele REPROVA o boot de qualquer processo Maia que herde o
# ambiente — inclusive o servidor standalone que este script sobe. `TEST_` é
# neutro (mesmo prefixo de TEST_DB_URL e TEST_REQUIRE_COMPOSE_DIFFERENTIAL).
PORTA="${TEST_ADMIN_UI_PORT:-4000}"
ESPERA_S="${TEST_ADMIN_UI_BOOT_TIMEOUT_S:-120}"
# Mínimo de testes que a rodada precisa ter EXECUTADO. Ver
# scripts/check-playwright-run.ts: o Playwright sai 0 quando não acha teste
# nenhum, então "verde" sem este piso não quer dizer nada.
MINIMO="${TEST_ADMIN_UI_MIN_TESTS:-1}"
RELATORIO=".playwright-report/admin-ui.json"
LOG_SERVIDOR="$(mktemp -t admin-ui-e2e-XXXXXX.log)"
LOG_RUNTIME="$(mktemp -t admin-ui-e2e-runtime-XXXXXX.log)"
ESPERA_RUNTIME_S="${TEST_ADMIN_UI_RUNTIME_TIMEOUT_S:-180}"
# O entrypoint do SEGUNDO processo. Fica sob `tests/` de propósito: o
# Dockerfile copia dist/, migrations/, scripts/ e src/ — `tests/` não entra,
# então o adapter de canal falso não existe na imagem de produção.
RUNTIME_ENTRYPOINT="tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts"

# Raiz do artefato standalone: é o `/app` do container (o Dockerfile faz
# `COPY --from=build /app/src/admin-ui/.next/standalone ./`).
STANDALONE="src/admin-ui/.next/standalone"
# Entrypoint RELATIVO a essa raiz — o mesmo caminho do `CMD` do Dockerfile.
# `outputFileTracingRoot` = raiz do repo faz o Next preservar o formato de
# diretórios original, então o `server.js` nasce em `src/admin-ui/`, não na
# raiz do bundle.
SERVIDOR_REL="src/admin-ui/server.js"
# Onde o estático precisa aterrissar dentro do artefato — o destino do segundo
# `COPY` do Dockerfile.
ESTATICO_DESTINO="$STANDALONE/src/admin-ui/.next/static"

# ─── pré-requisitos ────────────────────────────────────────────────────────
if [ ! -f "src/admin-ui/.next/BUILD_ID" ]; then
  echo "::error::sem build do console em src/admin-ui/.next — rode 'npm run admin:build' antes." >&2
  exit 1
fi
if [ ! -f "$STANDALONE/$SERVIDOR_REL" ]; then
  echo "::error::sem artefato standalone em $STANDALONE/$SERVIDOR_REL. É o que o Dockerfile executa em produção; sem ele o E2E mediria outro servidor. Confira 'output: standalone' e 'outputFileTracingRoot' em src/admin-ui/next.config.mjs e refaça 'npm run admin:build'." >&2
  exit 1
fi
if [ ! -d "src/admin-ui/.next/static" ]; then
  echo "::error::sem src/admin-ui/.next/static — o build não emitiu os assets de cliente." >&2
  exit 1
fi
for var in DATABASE_URL REDIS_URL NEXTAUTH_SECRET; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var não está definida. O E2E roda contra o console REAL; sem isso ele não sobe." >&2
    exit 1
  fi
done
# O keyring é PRÉ-REQUISITO, não opcional: sem ele `isPairingMaterialConfigured()`
# devolve false, o console DESABILITA o CTA e as quatro jornadas de pareamento
# reprovariam em "botão desabilitado" — a mensagem errada para a causa certa.
# Ele nunca é literal no workflow (o gitleaks varre a HISTÓRIA do repositório,
# e material de chave commitado não sai mais de lá): quem o gera é o passo do
# job, com `openssl rand`, e exporta para os dois processos.
for var in MAIA_STAGING_KEYRING MAIA_STAGING_ACTIVE_KEY_ID; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var não está definida. O QR e o código de pareamento só trafegam CIFRADOS: o runtime sela o envelope e o console o abre com a MESMA chave. Gere um keyring EFÊMERO antes de chamar este script (openssl rand -base64 32) e exporte as duas variáveis." >&2
    exit 1
  fi
done
if [ ! -f "$RUNTIME_ENTRYPOINT" ]; then
  echo "::error::sem $RUNTIME_ENTRYPOINT — é o entrypoint do runtime com adapter de canal falso; sem ele ninguém produz QR nem código e as jornadas de pareamento mediriam uma tela vazia." >&2
  exit 1
fi

# ─── montagem do artefato (os dois COPY do Dockerfile) ─────────────────────
# O `next build` NÃO põe o estático dentro do standalone: quem faz isso é a
# imagem. Aqui é o mesmo movimento, para que o servidor abaixo sirva
# exatamente o que o container serve.
echo "▸ montando o artefato standalone (.next/static -> $ESTATICO_DESTINO)"
rm -rf "$ESTATICO_DESTINO"
mkdir -p "$(dirname "$ESTATICO_DESTINO")"
cp -R "src/admin-ui/.next/static" "$ESTATICO_DESTINO"

# ─── fixtures das jornadas ─────────────────────────────────────────────────
# Antes do servidor de propósito: se a semeadura falhar, o job reprova aqui —
# com a mensagem do seed — em vez de reprovar dez jornadas com "elemento não
# encontrado" e deixar a causa para quem lê o log.
#
# É a semeadura que torna as jornadas DETERMINÍSTICAS: ela apaga e regrava as
# próprias linhas (por id), então toda execução começa do mesmo estado. As
# jornadas que MUTAM restauram a sua fixture de novo antes de cada caso
# (`tests/admin-ui/e2e/_apoio/fixtures.ts`) — sem isso a segunda TENTATIVA do
# Playwright herdaria a mutação da primeira.
echo "▸ semeando as fixtures das jornadas (#623)"
npx tsx scripts/seed-admin-ui-e2e-fixtures.ts

# ─── runtime (segundo processo) ────────────────────────────────────────────
# Papel `scheduler` + grupo `channel`: o inventário exato de que o pareamento
# precisa. Os outros dois jobs do grupo (`mcp_sync`, `synthetic_probe`) são
# no-op na primeira linha — as flags deles nascem OFF.
#
# As duas `MAIA_*` são exportadas DENTRO do subshell, e não no ambiente do
# script: `MAIA_PROCESS_ROLE`/`MAIA_SCHEDULER_GROUPS` descrevem ESTE processo,
# e vazá-las para o console faria o artefato standalone bootar com um papel
# que ele não tem.
#
# `node --import tsx` e NÃO `npx tsx`: o wrapper `npx tsx` é um processo que
# SPAWNA outro (`node --require .../preflight.cjs --import .../loader.mjs`), e
# o `kill` do trap alcança só o pai. MEDIDO nesta árvore: com `npx tsx`, cada
# execução deixava um runtime ÓRFÃO vivo, e o órfão continuava reivindicando
# comandos de `channel_line_state` — com o keyring da execução ANTERIOR. O
# material selado por ele não abria no console da execução nova, e a jornada do
# código de 8 dígitos reprovava com `material: null` e um countdown correndo na
# tela. Um processo só, e o trap o encerra de verdade.
echo "▸ subindo o runtime (papel scheduler, grupo channel, adapter de canal FALSO) — log: ${LOG_RUNTIME}"
(
  export MAIA_PROCESS_ROLE=scheduler
  export MAIA_SCHEDULER_GROUPS=channel
  exec node --import tsx "$RUNTIME_ENTRYPOINT"
) >"$LOG_RUNTIME" 2>&1 &
PID_RUNTIME=$!

encerrar_runtime() {
  if kill -0 "$PID_RUNTIME" 2>/dev/null; then
    # SIGTERM e não SIGKILL: o runtime tem sequência de drain própria
    # (`installSignalHandlers`), e matá-lo à força deixaria a lease de posse
    # das linhas viva no Postgres até vencer — a próxima execução veria um
    # canal "ocupado" por uma instância que já morreu.
    kill "$PID_RUNTIME" 2>/dev/null || true
    wait "$PID_RUNTIME" 2>/dev/null || true
  fi
}
trap encerrar_runtime EXIT INT TERM

runtime_pronto=0
for _ in $(seq 1 "$ESPERA_RUNTIME_S"); do
  if ! kill -0 "$PID_RUNTIME" 2>/dev/null; then
    echo "::error::o runtime morreu durante o boot. Log:" >&2
    cat "$LOG_RUNTIME" >&2
    exit 1
  fi
  # `maia.ready` é a transição de lifecycle que só acontece DEPOIS de config,
  # banco, schema, Redis e o agendador de crons estarem prontos
  # (`src/index.ts`, passo 10). Esperar por ela — e não por um `sleep` — é o
  # que impede a suíte de medir uma janela em que o worker `channel_pairing`
  # ainda não existe: o operador clicaria "Iniciar pareamento" e o comando
  # ficaria na fila até o timeout de 15s do teste.
  if grep -q '"msg":"maia.ready"' "$LOG_RUNTIME" 2>/dev/null; then
    runtime_pronto=1
    break
  fi
  sleep 1
done

if [ "$runtime_pronto" -ne 1 ]; then
  echo "::error::o runtime não ficou pronto em ${ESPERA_RUNTIME_S}s. Log:" >&2
  cat "$LOG_RUNTIME" >&2
  exit 1
fi
echo "▸ runtime pronto"

# ─── servidor ──────────────────────────────────────────────────────────────
echo "▸ subindo o artefato standalone em http://localhost:${PORTA} (log: ${LOG_SERVIDOR})"
(
  cd "$STANDALONE"
  # `PORT`/`HOSTNAME` são a ÚNICA interface do server.js gerado (não há flag de
  # linha de comando: ele lê `process.env.PORT` e `process.env.HOSTNAME`). Os
  # dois valores vêm do estágio `runtime` do Dockerfile — e `HOSTNAME` precisa
  # ser explícito porque em muitos ambientes a variável já existe com o NOME DA
  # MÁQUINA, e o servidor tentaria bindar nele.
  export PORT="$PORTA"
  export HOSTNAME=0.0.0.0
  exec node "$SERVIDOR_REL"
) >"$LOG_SERVIDOR" 2>&1 &
PID_SERVIDOR=$!

# UM trap para os DOIS processos: `trap` SUBSTITUI o handler anterior, então
# registrar um por processo deixaria o runtime órfão a cada saída.
encerrar() {
  if kill -0 "$PID_SERVIDOR" 2>/dev/null; then
    kill "$PID_SERVIDOR" 2>/dev/null || true
    wait "$PID_SERVIDOR" 2>/dev/null || true
  fi
  encerrar_runtime
}
trap encerrar EXIT INT TERM

pronto=0
for _ in $(seq 1 "$ESPERA_S"); do
  if ! kill -0 "$PID_SERVIDOR" 2>/dev/null; then
    echo "::error::o console morreu durante o boot. Log:" >&2
    cat "$LOG_SERVIDOR" >&2
    exit 1
  fi
  # Sonda em /auth/signin (rota PÚBLICA, 200) e não em /: a raiz responde 307
  # para /auth/signin, e um `curl -f` leria o redirect como falha — o wait
  # ficaria preso até o timeout com o servidor no ar.
  if curl -fsS -o /dev/null -w '' --max-time 5 "http://localhost:${PORTA}/auth/signin" 2>/dev/null; then
    pronto=1
    break
  fi
  sleep 1
done

if [ "$pronto" -ne 1 ]; then
  echo "::error::o console não respondeu em ${ESPERA_S}s. Log do servidor:" >&2
  cat "$LOG_SERVIDOR" >&2
  exit 1
fi
echo "▸ console no ar"

# ─── suíte ─────────────────────────────────────────────────────────────────
rm -f "$RELATORIO"
status=0
# `localhost` e NÃO `127.0.0.1`: o Auth.js v5 recusa host que não bate com
# `NEXTAUTH_URL` (`UntrustedHost`) e devolve 500 em /api/auth/*. Medido: com
# baseURL em 127.0.0.1 e NEXTAUTH_URL em localhost, a spec de boot reprovou com
# três respostas 500 — o gate funcionando, mas medindo a URL do teste em vez do
# console.
PLAYWRIGHT_BASE_URL="http://localhost:${PORTA}" \
  npx playwright test --project=smoke || status=$?

echo "▸ log do console durante a suíte:"
cat "$LOG_SERVIDOR"
echo "▸ log do runtime durante a suíte:"
cat "$LOG_RUNTIME"

# O guard de volume roda MESMO com o Playwright reprovando: "0 executados" e
# "3 reprovados" são diagnósticos diferentes e os dois precisam aparecer.
node scripts/check-playwright-run.ts "$RELATORIO" --min "$MINIMO" || status=1

if [ "$status" -ne 0 ]; then
  echo "::error::E2E do Admin UI reprovou (código ${status})." >&2
  exit "$status"
fi

echo "✓ E2E do Admin UI verde"

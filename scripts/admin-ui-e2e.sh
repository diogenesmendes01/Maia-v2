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
#   - fixtures das jornadas não semeiam      -> falha
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

encerrar() {
  if kill -0 "$PID_SERVIDOR" 2>/dev/null; then
    kill "$PID_SERVIDOR" 2>/dev/null || true
    wait "$PID_SERVIDOR" 2>/dev/null || true
  fi
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

# O guard de volume roda MESMO com o Playwright reprovando: "0 executados" e
# "3 reprovados" são diagnósticos diferentes e os dois precisam aparecer.
node scripts/check-playwright-run.ts "$RELATORIO" --min "$MINIMO" || status=1

if [ "$status" -ne 0 ]; then
  echo "::error::E2E do Admin UI reprovou (código ${status})." >&2
  exit "$status"
fi

echo "✓ E2E do Admin UI verde"

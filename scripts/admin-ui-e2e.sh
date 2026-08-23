#!/usr/bin/env bash
# E2E do Admin UI contra o console CONSTRUÍDO (não o dev server).
#
# Roda igual no CI e na máquina de quem desenvolve, e é o único lugar que sabe
# subir e derrubar o servidor. `playwright.config.ts` NÃO usa `webServer` de
# propósito: aqui cada pré-requisito ausente vira uma mensagem própria e um
# código de saída != 0, em vez de um timeout genérico do Playwright.
#
# Contrato de falha (tudo FECHA, nada pula):
#   - sem build em src/admin-ui/.next        -> falha
#   - sem DATABASE_URL / REDIS_URL           -> falha
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
# ambiente — inclusive o `next start` que este script sobe. `TEST_` é neutro
# (mesmo prefixo de TEST_DB_URL e TEST_REQUIRE_COMPOSE_DIFFERENTIAL).
PORTA="${TEST_ADMIN_UI_PORT:-4000}"
ESPERA_S="${TEST_ADMIN_UI_BOOT_TIMEOUT_S:-120}"
# Mínimo de testes que a rodada precisa ter EXECUTADO. Ver
# scripts/check-playwright-run.ts: o Playwright sai 0 quando não acha teste
# nenhum, então "verde" sem este piso não quer dizer nada.
MINIMO="${TEST_ADMIN_UI_MIN_TESTS:-1}"
RELATORIO=".playwright-report/admin-ui.json"
LOG_SERVIDOR="$(mktemp -t admin-ui-e2e-XXXXXX.log)"

# ─── pré-requisitos ────────────────────────────────────────────────────────
if [ ! -f "src/admin-ui/.next/BUILD_ID" ]; then
  echo "::error::sem build do console em src/admin-ui/.next — rode 'npm run admin:build' antes." >&2
  exit 1
fi
for var in DATABASE_URL REDIS_URL NEXTAUTH_SECRET; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var não está definida. O E2E roda contra o console REAL; sem isso ele não sobe." >&2
    exit 1
  fi
done
if [ ! -x "src/admin-ui/node_modules/.bin/next" ]; then
  echo "::error::next não instalado em src/admin-ui/node_modules — rode 'npm ci' em src/admin-ui." >&2
  exit 1
fi

# ─── servidor ──────────────────────────────────────────────────────────────
echo "▸ subindo o console construído em http://localhost:${PORTA} (log: ${LOG_SERVIDOR})"
(
  cd src/admin-ui
  exec ./node_modules/.bin/next start --port "$PORTA"
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
